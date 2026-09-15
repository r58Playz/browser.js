import { ElementType, Parser } from "htmlparser2";
import { ChildNode, DomHandler, Element, Comment } from "domhandler";
import render from "dom-serializer";
import { URLMeta, rewriteUrl } from "@rewriters/url";
import { rewriteCss } from "@rewriters/css";
import { rewriteJs } from "@rewriters/js";
import {
	ANCHOR_PLACEHOLDER,
	ANCHOR_WIDTH,
	anchorDigits,
	type InlineBase,
} from "@/shared/sourcemapsize";
import { ScramjetContext } from "@/shared";
import { htmlRules } from "@/shared/htmlRules";
import { parseDeclarativeRefresh } from "@/shared/refresh";
import { bytesToBase64 } from "@/shared/util";
import { Tap } from "@/Tap";
import { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { TrackedHistoryState } from "@/fetch";
import {
	Performance_now,
	atob,
	Object_entries,
	JSON_parse,
	JSON_stringify,
	TextEncoder_encode,
	Array_from,
	String_fromCodePoint,
	btoa,
	_URL,
} from "@/shared/snapshot";
import { flagEnabled } from "..";
import {
	getScriptBlockTypeString,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";

export type ForeignContext = "svg" | "math" | "html";

export type HtmlContext = {
	// should we inject scramjet scripts at the top of the document?
	loadScripts: boolean;
	// did the document come from the service worker, or from document.write/innerHTML?
	inline: boolean;
	// for worker originating documents, the source URL, otherwise the url of the page that triggered the rewrite
	source: string;
	// for api originating documents, the name of the api that triggered the rewrite
	apisource?: string;
	// response headers for worker originating documents
	headers?: RawHeaders;
	/**
	 * Byte length of the document BEFORE rewriting, for worker originating
	 * documents.
	 *
	 * `PerformanceResourceTiming` reports what the browser received, and for a
	 * rewritten document that is the proxy's size: measured on rateyourmusic,
	 * Cloudflare's widget read `decodedBodySize` 967946 for a page the site
	 * served as 256046 bytes. A script can recover its original size from the
	 * rewriter's sourcemap, but a DOCUMENT has no sourcemap and no
	 * `currentScript` to key one by, so the number has to travel with it.
	 */
	sourceLength?: number;
	foreignContext?: ForeignContext;
	history?: TrackedHistoryState[];
};

const renderOptions = {
	encodeEntities: "utf8" as const,
	decodeEntities: false,
};
function serializeHtmlNode(node: ChildNode) {
	return render(node, renderOptions);
}

/**
 * Offsets of each line start in `src`, so an index can be turned into a
 * line/column pair. Built once per document and used for every inline script.
 */
function lineTable(src: string): number[] {
	const starts = [0];
	for (let i = 0; i < src.length; i++) {
		if (src.charCodeAt(i) === 10) starts.push(i + 1);
	}

	return starts;
}

/** 1-based line and column of `index`, against a `lineTable`. */
function positionAt(starts: number[], index: number): [number, number] {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= index) lo = mid;
		else hi = mid - 1;
	}

	return [lo + 1, index - starts[lo] + 1];
}

/**
 * Write each inline script's position in the FINISHED document into its own
 * sourcemap call.
 *
 * The call already carries where the script was in the site's document; this
 * fills in where it ended up in the proxy's, which is the other half of what a
 * stack frame's column needs and is not known until everything before it has
 * been rewritten and serialised.
 *
 * Both anchors are fixed-width fields of digits, so overwriting them cannot
 * move anything -- which is what makes it sound to measure every position
 * first and then write them all back.
 *
 * Measured on rateyourmusic's Turnstile challenge, whose code is an inline
 * script starting at line 245 column 19222. Cloudflare captures a stack and
 * posts it, and without this the frames read
 *
 *     oracle    at bj.bs (....../normal?lang=auto:245:62668)
 *     sandbox   at bj.bs (....../normal?lang=auto:245:661220)
 *
 * for a script Cloudflare serves and therefore knows the length of -- 661220
 * is past the end of a line that is 256015 characters long, so it is not
 * merely a different number but an impossible one.
 */
function anchorInlineScripts(
	out: string,
	fnName: string,
	regions: InlineBase[]
): string {
	const starts = lineTable(out);
	const needle = `${fnName}([`;
	for (const base of regions) {
		if (!base.tag || base.prelude === undefined) continue;
		// The scramtag is unique to this rewrite, so it finds this call and no
		// other; the call itself starts at the nearest function name before it.
		const tagAt = out.indexOf(`"${base.tag}"`);
		if (tagAt < 0) continue;
		const callAt = out.lastIndexOf(needle, tagAt);
		if (callAt < 0) continue;

		const [line, column] = positionAt(starts, callAt - (base.offset ?? 0));
		// `..., <anchor>, <anchor>);` -- counted back from the end of the call,
		// which is where the two fields are by construction.
		const end = callAt + base.prelude;
		const second = end - 2 - ANCHOR_WIDTH;
		const first = second - 2 - ANCHOR_WIDTH;
		if (
			out.substr(first, ANCHOR_WIDTH) !== ANCHOR_PLACEHOLDER ||
			out.substr(second, ANCHOR_WIDTH) !== ANCHOR_PLACEHOLDER
		) {
			// Not where it was expected: leave every anchor alone rather than
			// write a position into the middle of the script.
			continue;
		}
		out =
			out.slice(0, first) +
			anchorDigits(line) +
			out.slice(first + ANCHOR_WIDTH, second) +
			anchorDigits(column) +
			out.slice(second + ANCHOR_WIDTH);
	}

	return out;
}

function isElementNode(node: ChildNode): node is Element {
	return (
		node.type === ElementType.Tag ||
		node.type === ElementType.Script ||
		node.type === ElementType.Style
	);
}

export class IncrementalHtmlRewriter {
	private readonly handler: DomHandler;
	private readonly parser: Parser;
	private readonly completedElements = new WeakSet<Element>();
	private readonly emittedLengths = new WeakMap<ChildNode, number>();
	private readonly rewrittenNodes = new WeakMap<ChildNode, string>();
	private ended = false;

	constructor(
		private readonly context: ScramjetContext,
		private readonly meta: URLMeta,
		private readonly htmlcontext: HtmlContext
	) {
		this.handler = new DomHandler(undefined, undefined, (element) => {
			this.completedElements.add(element);
		});
		this.parser = new Parser(this.handler, {
			startingForeignContext: htmlcontext.foreignContext,
		});
	}

	write(html: string) {
		if (this.ended) {
			throw new Error("IncrementalHtmlRewriter stream already ended");
		}

		this.parser.write(html);

		return this.flush();
	}

	end(html = "") {
		if (this.ended) {
			return "";
		}

		if (html) {
			this.parser.write(html);
		}

		this.parser.end();
		this.ended = true;

		return this.flush();
	}

	private flush() {
		let output = "";

		for (const node of this.handler.root.childNodes) {
			const rewritten = this.getAvailableOutput(node);
			if (rewritten === null) {
				break;
			}

			const emittedLength = this.emittedLengths.get(node) ?? 0;
			if (rewritten.length > emittedLength) {
				output += rewritten.slice(emittedLength);
				this.emittedLengths.set(node, rewritten.length);
			}
		}

		return output;
	}

	private getAvailableOutput(node: ChildNode) {
		if (!isElementNode(node)) {
			return serializeHtmlNode(node);
		}

		if (!this.completedElements.has(node)) {
			return null;
		}

		let rewritten = this.rewrittenNodes.get(node);
		if (rewritten === undefined) {
			rewritten = rewriteHtmlInner(
				node,
				this.context,
				this.meta,
				this.htmlcontext
			);
			this.rewrittenNodes.set(node, rewritten);
		}

		return rewritten;
	}
}

function rewriteHtmlInner(
	html: string | ChildNode,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	if (typeof html !== "string") {
		html = serializeHtmlNode(html);
	}

	// `withStartIndices` is what makes an inline script's ORIGINAL position
	// recoverable: the parser knows where every node began in the source, and
	// without asking for it that offset is discarded and there is nothing left
	// to un-rewrite a stack frame's column against.
	const handler = new DomHandler((err, dom) => dom, {
		withStartIndices: true,
	});
	const parser = new Parser(handler, {
		startingForeignContext: htmlcontext.foreignContext,
	});

	parser.write(html);
	parser.end();
	const inlineScripts: InlineBase[] = [];
	const sourceLines = lineTable(html);
	Tap.dispatch(
		context.hooks!.rewriter.html.pre,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		undefined
	);
	traverseParsedHtml(handler.root, context, meta, hidesNonces(htmlcontext), {
		sourceLines,
		inlineScripts,
	});

	let htmlRoot: Element | undefined;
	let headElement: Element | undefined;
	let bodyElement: Element | undefined;

	function detectQuirks() {
		for (const child of handler.root.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "html") {
				htmlRoot = child as Element;
			} else {
				// there's a child of the root that isn't an html element or a doctype/comment/text
				return true;
			}
		}

		if (!htmlRoot) return true; // no html tag or it's somewhere else other than first child

		for (const child of htmlRoot.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "head") {
				if (bodyElement) {
					// head comes after body
					return true;
				}
				headElement = child as Element;
			} else if (child.type === ElementType.Tag && child.name === "body") {
				bodyElement = child as Element;
			} else {
				// there's a child of html that isn't head or body
				// fine if head already exists, bad if it doesn't
				if (!headElement) {
					return true;
				}
			}

			return false;
		}
	}

	const isQuirky = detectQuirks();

	if (htmlcontext.loadScripts) {
		const script = (src: string) =>
			new Element("script", { src, "scramjet-injected": "true" });
		const injectScripts = context.interface.getInjectScripts(
			meta,
			handler,
			htmlcontext,
			script
		);

		if (isQuirky) {
			dbg.warn(
				`detected quirky document structure parsing @ ${meta.origin.href}!`
			);
			// there's weird stuff going on with the document that could result in
			// page scripts being loaded before our inject scripts, so inject them
			// as early as possible -- but AFTER the doctype.
			//
			// "Position 0" put them in front of it, and a `<script>` before the
			// DOCTYPE is exactly what makes a browser ignore it: the document
			// then parses in quirks mode. This function is named for the thing it
			// was causing. Measured on rateyourmusic, whose document takes this
			// path: `document.compatMode` was "BackCompat" where unmodified
			// Chromium says "CSS1Compat", which moved
			// `documentElement.clientHeight` from 813 to 15364 and took
			// `scrollHeight`, `HTMLCollection.length` and
			// `IntersectionObserverEntry.isIntersecting` with it -- every one of
			// them a value an anti-bot payload records.
			//
			// A comment before the DOCTYPE is legal and does not trigger quirks,
			// so those are skipped too; the scripts land at the first position
			// where they are still ahead of anything the page can run.
			let at = 0;
			while (at < handler.root.children.length) {
				const node = handler.root.children[at];
				if (
					node.type === ElementType.Directive ||
					node.type === ElementType.Comment
				) {
					at++;
					continue;
				}
				break;
			}
			handler.root.children.splice(at, 0, ...injectScripts);
		} else {
			if (!headElement) {
				headElement = new Element("head", {}, []);
				htmlRoot.children.unshift(headElement);
			}

			headElement.children.unshift(...injectScripts);
		}
	}

	const props: typeof context.hooks.rewriter.html.post.props = {};
	Tap.dispatch(
		context.hooks!.rewriter.html.post,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		props
	);

	if (props.setRawHtml !== undefined) {
		return props.setRawHtml;
	}

	return anchorInlineScripts(
		render(handler.root, renderOptions),
		context.config.globals.pushsourcemapfn,
		inlineScripts
	);
}

export function rewriteHtml(
	html: string,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	const before = Performance_now();
	const ret = rewriteHtmlInner(html, context, meta, htmlcontext);
	if (flagEnabled("rewriterLogs", context, meta.base)) {
		dbg.time(meta, before, "html rewrite");
	}

	return ret;
}

// type ParseState = {
// 	base: string;
// 	origin?: URL;
// };

export function unrewriteHtml(html: string, foreignContext?: ForeignContext) {
	const handler = new DomHandler((err, dom) => dom);
	const parser = new Parser(handler, {
		startingForeignContext: foreignContext,
	});

	parser.write(html);
	parser.end();

	function traverse(node: ChildNode) {
		if ("attribs" in node) {
			for (const key in node.attribs) {
				if (key == "scramjet-attr-script-source-src") {
					if (node.children[0] && "data" in node.children[0])
						node.children[0].data = atob(node.attribs[key]);
					// ...and then it goes, like every other alias. It used to
					// `continue` straight past the delete, so the proxy's own
					// name survived into the serialised output while every
					// other one was cleaned up. Cloudflare's element-tree
					// fingerprint is the tag plus the first letters of each
					// attribute, and it read `scr_no_sc_sr` where a browser
					// gives `scr_no_sr`.
					delete node.attribs[key];
					continue;
				}

				// The marker on a script the rewriter added. It is not an
				// alias, so the prefix branch never saw it: it does not start
				// with `scramjet-attr-`. Nothing outside scramjet has any
				// business reading it and no browser has an attribute by that
				// name.
				if (key === "scramjet-injected") {
					delete node.attribs[key];
					continue;
				}

				if (key.startsWith("scramjet-attr-")) {
					const original = key.slice("scramjet-attr-".length);
					// A nonce comes back EMPTY, because that is what a browser
					// serializes.
					//
					// HTML says that when an element carrying a `nonce` content
					// attribute is inserted, the value moves to an internal slot
					// and the content attribute is set to the empty string -- so
					// the page's own `outerHTML` reads `nonce=""` while
					// `script.nonce` still returns the value. Restoring the real
					// one here handed the page a secret the browser had already
					// taken off the element.
					//
					// Measured against a direct load of rateyourmusic's
					// challenge: the oracle serialized `<script nonce="">` and
					// the sandbox `<script nonce="GbvEY3BPB0Sc46QpXYkXkO">`.
					// The challenge reads its own page.
					node.attribs[original] =
						original === "nonce" ? "" : node.attribs[key];
					delete node.attribs[key];
				}
			}
		}

		if ("childNodes" in node) {
			for (const child of node.childNodes) {
				traverse(child);
			}
		}
	}

	traverse(handler.root);

	return render(handler.root, {
		...renderOptions,
	});
}

// i need to add the attributes in during rewriting

/**
 * Whether this document's nonces are hidden, the way the browser hides them.
 *
 * `Element::HideNonce` blanks the `nonce` content attribute of a connected
 * element -- keeping the value in an internal slot, so `element.nonce` still
 * answers with it -- and it does so only when the policy arrived in a HEADER.
 * A policy from a `<meta>` does not trigger it, which is why this asks the
 * response headers and not the document.
 *
 * The point of the blanking is that a nonce must not be reachable through a
 * CSS attribute selector. Scramjet strips the policy, so the browser has
 * nothing to hide the nonce for and does not, and the value stayed readable
 * through `getAttribute` -- measured on rateyourmusic's challenge, whose inline
 * script reads the nonce off itself and copies it onto the scripts it creates:
 * the oracle read "" and made `<script src>`, the sandbox read
 * "GbvEY3BPB0Sc46QpXYkXkO" and made `<script nonce src>`.
 */
function hidesNonces(htmlcontext: HtmlContext): boolean {
	if (!htmlcontext.headers) return false;

	for (const [name] of htmlcontext.headers) {
		if (name.toLowerCase() === "content-security-policy") return true;
	}

	return false;
}

/**
 * What an inline script needs to report its own position, threaded down the
 * tree. Absent when the caller is rewriting a FRAGMENT rather than a document
 * -- `innerHTML` and friends -- where an offset into the fragment is not a
 * position in any document and would map a frame to the wrong place.
 */
type InlineTracking = {
	/** Line starts of the ORIGINAL document, for `node.startIndex`. */
	sourceLines: number[];
	/** Filled in as scripts are rewritten; anchored after serialisation. */
	inlineScripts: InlineBase[];
};

function traverseParsedHtml(
	node: any,
	context: ScramjetContext,
	meta: URLMeta,
	hideNonce: boolean,
	inline?: InlineTracking
) {
	if (node.name === "base" && node.attribs.href !== undefined) {
		meta.base = new _URL(node.attribs.href, meta.origin);
	}

	if (node.attribs) {
		for (const rule of htmlRules) {
			for (const attr in rule) {
				const sel = rule[attr.toLowerCase()];
				if (typeof sel === "function") continue;

				if (sel === "*" || sel.includes(node.name)) {
					if (node.attribs[attr] !== undefined) {
						const value = node.attribs[attr];
						const v = rule.fn(
							value,
							context,
							meta,
							(name) => node.attribs[name] || null
						);

						if (v === null) delete node.attribs[attr];
						else {
							node.attribs[attr] = v;
						}
						// A hidden nonce is BLANKED, not removed: the attribute
						// is still on the element and still enumerates, it just
						// has nothing in it. Writing the empty one back is also
						// what keeps `getAttribute("nonce")` off the alias --
						// the client answers from a real attribute when there is
						// one, and from the alias only when there is not.
						if (attr === "nonce" && hideNonce && value) {
							node.attribs[attr] = "";
						}
						node.attribs[`scramjet-attr-${attr}`] = value;
					}
				}
			}
		}
		for (const [attr, value] of Object_entries(node.attribs)) {
			if (eventAttributes.includes(attr)) {
				node.attribs[`scramjet-attr-${attr}`] = value;
				node.attribs[attr] = rewriteJs(
					value as string,
					`(inline ${attr} on element)`,
					context,
					meta
				);
			}
		}
	}

	if (node.name === "style" && node.children[0] !== undefined)
		node.children[0].data = rewriteCss(node.children[0].data, context, meta);

	if (
		node.name === "script" &&
		node.attribs.type?.toLowerCase() === "importmap" &&
		node.children[0] !== undefined
	) {
		const json = node.children[0].data;
		try {
			const map = JSON_parse(json);
			if (map.imports) {
				for (const key in map.imports) {
					let url = map.imports[key];
					if (typeof url === "string") {
						url = rewriteUrl(url, context, meta, { isModule: true });
						map.imports[key] = url;
					}
				}
			}

			node.children[0].data = JSON_stringify(map);
		} catch (e) {
			dbg.error("Failed to parse importmap JSON:", e);
		}
	}
	if (
		node.name === "script" &&
		node.attribs &&
		node.children[0] !== undefined
	) {
		const scriptBlockType = getScriptBlockTypeString(
			"type" in node.attribs ? node.attribs.type : undefined,
			"language" in node.attribs ? node.attribs.language : undefined,
			"type" in node.attribs,
			"language" in node.attribs
		);
		if (isScriptType(scriptBlockType)) {
			let js = node.children[0].data;
			const module = isModuleScriptType(scriptBlockType);
			node.attribs["scramjet-attr-script-source-src"] = bytesToBase64(
				TextEncoder_encode(js)
			);
			const htmlcomment = /<!--[\s\S]*?-->/g;
			js = js.replace(htmlcomment, "");
			// Where the site put this script. A frame from an inline script
			// counts its column from the start of the LINE, which it shares
			// with whatever HTML precedes it, so the rewrite map cannot be
			// applied to it without knowing where the script began.
			//
			// The comment strip above does not move the start, only the
			// content after it, and a comment-only shift inside the script is
			// already part of what the map describes.
			let base: InlineBase | undefined;
			const startIndex = node.children[0].startIndex;
			if (inline && typeof startIndex === "number") {
				const [line, column] = positionAt(inline.sourceLines, startIndex);
				base = { line, column };
				inline.inlineScripts.push(base);
			}
			node.children[0].data = rewriteJs(
				js,
				"(inline script element)",
				context,
				meta,
				module,
				base
			);
		}
	}

	if (node.name === "meta" && node.attribs["http-equiv"] !== undefined) {
		if (
			node.attribs["http-equiv"].toLowerCase() === "content-security-policy"
		) {
			// Neutralise the policy without removing the ELEMENT.
			//
			// This used to become a Comment, and the page could see that: an
			// element turning into a comment changes `nodeType` from 1 to 8, and
			// anything walking the DOM finds a node of the wrong kind exactly
			// where the meta should be. Measured on rateyourmusic, in the
			// Turnstile widget's realm -- `Node.nodeType.get` read
			// [1,1,1,1,1,1,1,1,1] in the oracle and [1,8,1,1,1,1,1,1,1] in the
			// sandbox, same count, second position. The comment also carried the
			// original policy as its data, so the text was still there to read,
			// just in a node of the wrong type.
			//
			// `content` is what travels, and `http-equiv` is left alone.
			//
			// Renaming `http-equiv` also stops the browser applying the policy,
			// and it was what this did -- but an attribute SELECTOR reads the
			// real attribute, not the alias, so `meta[http-equiv="..."]` matched
			// nothing. Measured on rateyourmusic's challenge:
			// `document.querySelector('meta[http-equiv="content-security-policy"
			// i]')` found the element in the oracle and null in the sandbox, on
			// a page that plainly has one.
			//
			// Taking `content` away instead is the one edit the browser ignores
			// outright: `HTMLMetaElement::ProcessHttpEquiv` returns before
			// parsing anything when the content attribute is null. An EMPTY one
			// does not do -- that parses to a policy with no directives, which
			// forbids nothing but is still a policy the window is given.
			//
			// The value rides in the alias `getAttribute` already un-aliases, so
			// the element stays an element, still answers to a CSP selector, and
			// still reads its own policy back.
			if (node.attribs["content"] !== undefined) {
				node.attribs[`scramjet-attr-content`] = node.attribs["content"];
				delete node.attribs["content"];
			}
		} else if (node.attribs["http-equiv"].toLowerCase() === "refresh") {
			const refresh = parseDeclarativeRefresh(node.attribs.content || "");
			if (refresh && refresh.url !== null && refresh.url.length > 0) {
				const rewritten = rewriteUrl(refresh.url.trim(), context, meta);
				node.attribs.content =
					node.attribs.content.slice(0, refresh.urlStart) +
					rewritten +
					node.attribs.content.slice(refresh.urlEnd);
			}
		}
	}

	if (node.childNodes) {
		for (const childNode in node.childNodes) {
			node.childNodes[childNode] = traverseParsedHtml(
				node.childNodes[childNode],
				context,
				meta,
				hideNonce,
				inline
			);
		}
	}

	return node;
}

export function rewriteSrcset(
	srcset: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	const sources = srcset.split(/ .*,/).map((src) => src.trim());
	const rewrittenSources = sources.map((source) => {
		// Split into URLs and descriptors (if any)
		// e.g. url0, url1 1.5x, url2 2x
		const [url, ...descriptors] = source.split(/\s+/);

		// Rewrite the URLs and keep the descriptors (if any)
		const rewrittenUrl = rewriteUrl(url.trim(), context, meta);

		return descriptors.length > 0
			? `${rewrittenUrl} ${descriptors.join(" ")}`
			: rewrittenUrl;
	});

	return rewrittenSources.join(", ");
}

// function base64ToBytes(base64) {
// 	const binString = atob(base64);

// 	return Uint8Array.from(binString, (m) => m.codePointAt(0));
// }

const eventAttributes = [
	"onbeforexrselect",
	"onabort",
	"onbeforeinput",
	"onbeforematch",
	"onbeforetoggle",
	"onblur",
	"oncancel",
	"oncanplay",
	"oncanplaythrough",
	"onchange",
	"onclick",
	"onclose",
	"oncontentvisibilityautostatechange",
	"oncontextlost",
	"oncontextmenu",
	"oncontextrestored",
	"oncuechange",
	"ondblclick",
	"ondrag",
	"ondragend",
	"ondragenter",
	"ondragleave",
	"ondragover",
	"ondragstart",
	"ondrop",
	"ondurationchange",
	"onemptied",
	"onended",
	"onerror",
	"onfocus",
	"onformdata",
	"oninput",
	"oninvalid",
	"onkeydown",
	"onkeypress",
	"onkeyup",
	"onload",
	"onloadeddata",
	"onloadedmetadata",
	"onloadstart",
	"onmousedown",
	"onmouseenter",
	"onmouseleave",
	"onmousemove",
	"onmouseout",
	"onmouseover",
	"onmouseup",
	"onmousewheel",
	"onpause",
	"onplay",
	"onplaying",
	"onprogress",
	"onratechange",
	"onreset",
	"onresize",
	"onscroll",
	"onsecuritypolicyviolation",
	"onseeked",
	"onseeking",
	"onselect",
	"onslotchange",
	"onstalled",
	"onsubmit",
	"onsuspend",
	"ontimeupdate",
	"ontoggle",
	"onvolumechange",
	"onwaiting",
	"onwebkitanimationend",
	"onwebkitanimationiteration",
	"onwebkitanimationstart",
	"onwebkittransitionend",
	"onwheel",
	"onauxclick",
	"ongotpointercapture",
	"onlostpointercapture",
	"onpointerdown",
	"onpointermove",
	"onpointerrawupdate",
	"onpointerup",
	"onpointercancel",
	"onpointerover",
	"onpointerout",
	"onpointerenter",
	"onpointerleave",
	"onselectstart",
	"onselectionchange",
	"onanimationend",
	"onanimationiteration",
	"onanimationstart",
	"ontransitionrun",
	"ontransitionstart",
	"ontransitionend",
	"ontransitioncancel",
	"oncopy",
	"oncut",
	"onpaste",
	"onscrollend",
	"onscrollsnapchange",
	"onscrollsnapchanging",
];
