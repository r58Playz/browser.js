/**
 * Direct tests for the identifier mangler.
 *
 * These cover the rewrite side only — codec, selectors, stylesheets and markup.
 * The client traps that make the mangling invisible to page JS are exercised by the
 * browser test in `adversarial/mangle-dom.ts`.
 */
import {
	applyMangleSalt,
	defaultConfig,
	getMangler,
	rewriteCss,
	rewriteHtml,
	shouldMangleAttr,
	shouldMangleTag,
	Tap,
	unrewriteCss,
	unrewriteHtml,
	type ScramjetConfig,
} from "@mercuryworkshop/scramjet/bundled";
import { directTest } from "../testcommon.ts";

const SALT = "runway-fixed-salt-0123456789abcdef";

function createContext(flags: Partial<ScramjetConfig["flags"]> = {}) {
	const base: ScramjetConfig = {
		...defaultConfig,
		flags: { ...defaultConfig.flags, ...flags },
	};
	const config = applyMangleSalt(base, SALT);

	const context = {
		config,
		prefix: new URL("https://proxy.test/service/"),
		interface: {
			codecEncode: encodeURIComponent,
			codecDecode: decodeURIComponent,
			getInjectScripts: () => [],
		},
		cookieJar: {},
		hooks: { rewriter: { html: Tap.create() } },
	} as any;

	const meta = {
		origin: new URL("https://example.com"),
		base: new URL("https://example.com/page"),
	} as any;

	return { context, meta, config };
}

const ALL_ON = {
	mangleTags: true,
	mangleAttrs: true,
	mangleClassIds: true,
};

function html(input: string, flags = ALL_ON) {
	const { context, meta } = createContext(flags);

	return rewriteHtml(input, context, meta, {
		loadScripts: false,
		inline: true,
		source: "https://example.com/page",
		apisource: "runway",
	});
}

function htmlRoundTrip(input: string, flags = ALL_ON) {
	const { context, meta } = createContext(flags);
	const rewritten = rewriteHtml(input, context, meta, {
		loadScripts: false,
		inline: true,
		source: "https://example.com/page",
		apisource: "runway",
	});

	return { rewritten, restored: unrewriteHtml(rewritten, context, meta) };
}

export default [
	// --- codec --------------------------------------------------------------
	directTest({
		name: "mangle-codec-roundtrip",
		fn: ({ assert, assertEqual }) => {
			const m = getMangler(SALT)!;
			const names = [
				"yt-icon",
				"ytd-searchbox",
				"ytd-rich-grid-renderer",
				"a",
				"data-ytd-thumbnail",
				"style-scope",
				"élément",
			];
			for (const kind of ["tag", "attr", "class", "id"] as const) {
				for (const name of names) {
					const mangled = m.mangle(kind, name);
					assertEqual(
						m.unmangle(kind, mangled),
						name,
						`${kind} ${name} must round trip`
					);
					assertEqual(
						m.mangle(kind, mangled),
						mangled,
						`${kind} ${name} mangling must be idempotent`
					);
					assert(
						mangled !== name,
						`${kind} ${name} must actually change`
					);
				}
			}
			// a tag must stay a legal custom element name
			assert(
				/^[a-z][a-z0-9]*-[a-z0-9]+$/.test(m.mangle("tag", "yt-icon")),
				"mangled tag names must remain valid custom element names"
			);
		},
	}),
	directTest({
		name: "mangle-codec-kinds-are-separate",
		fn: ({ assertEqual }) => {
			const m = getMangler(SALT)!;
			const tag = m.mangle("tag", "yt-icon");
			assertEqual(
				m.unmangle("class", tag),
				tag,
				"a mangled tag must not decode as a class"
			);
		},
	}),
	directTest({
		name: "mangle-codec-rejects-foreign-names",
		fn: ({ assertEqual }) => {
			const m = getMangler(SALT)!;
			// site authored names that happen to start with our prefix must survive
			let corrupted = 0;
			for (let i = 0; i < 20000; i++) {
				const name = m.prefix + i.toString(36);
				if (m.unmangle("class", name) !== name) corrupted++;
			}
			assertEqual(corrupted, 0, "checksum must reject non-mangled names");
		},
	}),
	directTest({
		name: "mangle-codec-salt-dependent",
		fn: ({ assert }) => {
			const a = getMangler(SALT)!;
			const b = getMangler(SALT + "x")!;
			assert(
				a.mangle("tag", "yt-icon") !== b.mangle("tag", "yt-icon"),
				"different salts must produce different names"
			);
		},
	}),
	directTest({
		name: "mangle-policy",
		fn: ({ assert }) => {
			assert(shouldMangleTag("yt-icon"), "custom elements are manglable");
			assert(!shouldMangleTag("div"), "built-in tags are not");
			assert(
				!shouldMangleTag("annotation-xml"),
				"reserved hyphenated names are not"
			);
			assert(shouldMangleAttr("data-x", false), "data-* is manglable");
			assert(!shouldMangleAttr("class", false), "class is not");
			assert(!shouldMangleAttr("aria-label", false), "aria-* is not");
			assert(!shouldMangleAttr("onclick", false), "handlers are not");
			assert(
				!shouldMangleAttr("data-x", true),
				"foreign content is left alone"
			);
		},
	}),

	// --- markup ---------------------------------------------------------------
	directTest({
		name: "mangle-html-tag-names",
		fn: ({ assert, assertEqual }) => {
			const { rewritten, restored } = htmlRoundTrip(
				"<div><yt-icon></yt-icon><ytd-searchbox></ytd-searchbox></div>"
			);
			assert(
				!rewritten.includes("yt-icon"),
				`the fingerprint must be gone: ${rewritten}`
			);
			assert(
				!rewritten.includes("ytd-searchbox"),
				`the fingerprint must be gone: ${rewritten}`
			);
			assert(rewritten.includes("<div>"), "built-in tags are untouched");
			assertEqual(
				restored,
				"<div><yt-icon></yt-icon><ytd-searchbox></ytd-searchbox></div>"
			);
		},
	}),
	directTest({
		name: "mangle-html-attributes-and-values",
		fn: ({ assert, assertEqual }) => {
			const input =
				'<div id="main" class="a b" data-ytd="x" aria-label="hi"></div>';
			const { rewritten, restored } = htmlRoundTrip(input);
			assert(!rewritten.includes("data-ytd"), `got ${rewritten}`);
			assert(!rewritten.includes('id="main"'), `got ${rewritten}`);
			assert(!rewritten.includes('class="a b"'), `got ${rewritten}`);
			assert(
				rewritten.includes('aria-label="hi"'),
				`aria attributes must be untouched: ${rewritten}`
			);
			assertEqual(restored, input);
		},
	}),
	directTest({
		name: "mangle-html-idrefs-track-ids",
		fn: ({ assert }) => {
			const rewritten = html(
				'<label for="x"></label><input id="x">'
			);
			const forValue = /for="([^"]+)"/.exec(rewritten)?.[1];
			const idValue = /id="([^"]+)"/.exec(rewritten)?.[1];
			assert(!!forValue && !!idValue, `got ${rewritten}`);
			assert(
				forValue === idValue,
				`for= and id= must stay in step, got ${forValue} vs ${idValue}`
			);
		},
	}),
	directTest({
		name: "mangle-html-svg-attributes-untouched",
		fn: ({ assert }) => {
			const rewritten = html('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
			assert(
				rewritten.includes('viewBox="0 0 1 1"') || rewritten.includes('viewbox='),
				`SVG attributes must survive: ${rewritten}`
			);
			assert(rewritten.includes('d="M0 0"'), `got ${rewritten}`);
		},
	}),
	directTest({
		name: "mangle-html-inline-style-selectors",
		fn: ({ assert }) => {
			const rewritten = html("<style>yt-icon{color:red}.a{color:blue}</style>");
			assert(!rewritten.includes("yt-icon{"), `got ${rewritten}`);
			assert(!rewritten.includes(".a{"), `got ${rewritten}`);
			assert(rewritten.includes("color:red"), `got ${rewritten}`);
		},
	}),
	directTest({
		name: "mangle-html-disabled-is-byte-identical",
		fn: ({ assertEqual }) => {
			const input = '<yt-icon id="main" class="a" data-x="1"></yt-icon>';
			assertEqual(
				html(input, {
					mangleTags: false,
					mangleAttrs: false,
					mangleClassIds: false,
				}),
				input,
				"with every tier off the rewriter must not touch identifiers"
			);
		},
	}),

	// --- stylesheets ----------------------------------------------------------
	directTest({
		name: "mangle-css-selectors-roundtrip",
		fn: ({ assert, assertEqual }) => {
			const { context, meta } = createContext(ALL_ON);
			const sheets = [
				"yt-icon{color:red}",
				"ytd-app, .foo > #bar{--x:1}",
				"@media (min-width:100px){yt-icon{display:none}}",
				"@keyframes yt-icon{from{opacity:0}to{opacity:1}}",
				".a{color:red;&:hover{color:blue}yt-icon{color:green}}",
				'.a{content:"} yt-icon {"}',
				"/* yt-icon {} */.b{}",
				"li:nth-child(2n of .imp){}",
				':is(yt-icon, ytd-app) .foo{}',
				"[data-ytd]{}",
				'[class~="thumb"]{}',
			];
			for (const sheet of sheets) {
				const out = rewriteCss(sheet, context, meta);
				assertEqual(
					unrewriteCss(out, context, meta),
					sheet,
					`stylesheet must round trip: ${sheet}`
				);
			}
			assert(
				!rewriteCss("yt-icon{color:red}", context, meta).includes("yt-icon"),
				"type selectors must be mangled"
			);
			assert(
				rewriteCss(
					"@keyframes slide{from{left:0}}",
					context,
					meta
				).includes("@keyframes slide"),
				"keyframe names are not selectors"
			);
		},
	}),
	directTest({
		name: "mangle-css-matches-markup",
		fn: ({ assert }) => {
			const { context, meta } = createContext(ALL_ON);
			// the tag in the markup and the type selector in the sheet must agree,
			// otherwise the page renders unstyled
			const markup = html("<yt-icon></yt-icon>");
			const tag = /<([a-z0-9-]+)>/.exec(markup)?.[1];
			const sheet = rewriteCss("yt-icon{color:red}", context, meta);
			assert(!!tag, `no tag found in ${markup}`);
			assert(
				sheet.startsWith(tag + "{"),
				`selector ${sheet} must match tag ${tag}`
			);
		},
	}),
	directTest({
		name: "mangle-css-disabled-is-byte-identical",
		fn: ({ assertEqual }) => {
			const { context, meta } = createContext({
				mangleTags: false,
				mangleAttrs: false,
				mangleClassIds: false,
			});
			const sheet = "yt-icon{color:red}.a{color:blue}";
			assertEqual(rewriteCss(sheet, context, meta), sheet);
		},
	}),

	// --- scramjet's own markers -----------------------------------------------
	directTest({
		name: "mangle-randomises-scramjet-markers",
		fn: ({ assert, assertEqual }) => {
			const config = applyMangleSalt(defaultConfig, SALT);
			assert(
				!config.globals.attrprefix.startsWith("scramjet"),
				`shadow attribute prefix must not be constant: ${config.globals.attrprefix}`
			);
			assert(
				!config.globals.injectedattr.startsWith("scramjet"),
				`injected marker must not be constant: ${config.globals.injectedattr}`
			);
			assert(
				!config.globals.wrapfn.startsWith("$scramjet"),
				`wrap function must not be constant: ${config.globals.wrapfn}`
			);
			assert(
				!config.globals.setrealmfn.startsWith("$scramjet"),
				`the realm helper on Object.prototype must not be constant: ${config.globals.setrealmfn}`
			);
			assertEqual(
				applyMangleSalt(defaultConfig, SALT).globals.wrapfn,
				config.globals.wrapfn,
				"the same salt must produce the same names"
			);
		},
	}),
	directTest({
		name: "mangle-no-scramjet-attr-literal-in-output",
		fn: ({ assert }) => {
			const rewritten = html('<a href="/x">y</a>');
			assert(
				!rewritten.includes("scramjet-attr"),
				`the constant shadow prefix must not appear: ${rewritten}`
			);
			assert(
				rewritten.includes("href="),
				`sanity: the link should still be rewritten: ${rewritten}`
			);
		},
	}),
];
