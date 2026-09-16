/**
 * @fileoverview
 * Deterministic, reversible, keyed mangling of DOM identifiers.
 *
 * Filtering software fingerprints proxied pages by scanning the *real* DOM for
 * site-specific structural markers (`yt-icon`, `ytd-searchbox`, `data-ytd-*`,
 * `.ytd-thumbnail`). Those scanners typically run as extension content scripts in an
 * isolated world, so they call native DOM APIs and none of Scramjet's client traps
 * are in their path. The only way to defeat them is for the identifiers in the
 * document to genuinely differ, with the client traps lying in the other direction so
 * page JS still observes the originals.
 *
 * The transform is a *keyed encoding*, not a hash, so no name table has to be
 * synchronised between the fetch handler and every page realm: both derive everything
 * from `config.mangleSalt`.
 *
 *     mangle(kind, s) = PFX ["-" if tag] base32( tweak24 ++ (utf8(s) ^ keystream) )
 *
 * `tweak24` is a 24 bit FNV-1a of the salt, the kind and the plaintext. It seeds the
 * keystream, which is why two names sharing a prefix do not share a mangled prefix,
 * and it doubles as the checksum that stops us from "unmangling" a site-authored name
 * that happens to begin with `PFX`.
 *
 * This is obfuscation, not cryptography. A same-world adversary can read the salt out
 * of the injected script and undo it; the point is to defeat blind signature lists.
 */

import {
	Math_imul,
	Object_keys,
	String,
	TextDecoder_decode,
	TextEncoder_encode,
	_Map,
	_Set,
	_Uint8Array,
} from "@/shared/snapshot";
import type { ScramjetConfig } from "@/types";

/**
 * Which namespace an identifier lives in. Folded into the key, so a mangled tag name
 * will not decode as a class name and vice versa.
 */
export type MangleKind = "tag" | "attr" | "class" | "id";

const KINDSEED: Record<MangleKind, number> = {
	tag: 0x1a2b3c4d,
	attr: 0x5e6f7a8b,
	class: 0x9cadbeef,
	id: 0xfeedface,
};

// lowercase base32: every character is legal in a CSS ident, an HTML attribute name
// and a custom element name, so the output never needs escaping
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const B32REV: number[] = [];
for (let i = 0; i < B32.length; i++) B32REV[B32.charCodeAt(i)] = i;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

// entries are tiny; this only exists to stop an unbounded leak on pathological pages
const MAXCACHE = 32768;

function hashBytes(seed: number, bytes: Uint8Array): number {
	let h = seed >>> 0;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math_imul(h, 0x01000193) >>> 0;
	}

	return h >>> 0;
}

function hashString(seed: number, str: string): number {
	let h = seed >>> 0;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		h ^= c & 0xff;
		h = Math_imul(h, 0x01000193) >>> 0;
		h ^= (c >>> 8) & 0xff;
		h = Math_imul(h, 0x01000193) >>> 0;
	}

	return h >>> 0;
}

/** xorshift32 keystream. Deterministic, fast, and good enough to destroy structure. */
function keystream(seed: number): () => number {
	let x = seed >>> 0 || 0x9e3779b9;

	return () => {
		x ^= (x << 13) >>> 0;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= (x << 5) >>> 0;
		x >>>= 0;

		return x & 0xff;
	};
}

function b32encode(bytes: Uint8Array): string {
	let out = "";
	let acc = 0;
	let bits = 0;
	for (let i = 0; i < bytes.length; i++) {
		acc = ((acc << 8) | bytes[i]) >>> 0;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += B32[(acc >>> bits) & 31];
		}
	}
	if (bits > 0) out += B32[(acc << (5 - bits)) & 31];

	return out;
}

function b32decode(str: string): Uint8Array | null {
	const out = new _Uint8Array(((str.length * 5) / 8) | 0);
	let len = 0;
	let acc = 0;
	let bits = 0;
	for (let i = 0; i < str.length; i++) {
		const v = B32REV[str.charCodeAt(i)];
		if (v === undefined) return null;
		acc = ((acc << 5) | v) >>> 0;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out[len++] = (acc >>> bits) & 0xff;
		}
	}
	// a well formed encoding pads with zero bits; anything else is not ours
	if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;

	return out.subarray(0, len);
}

export class Mangler {
	/** Salt derived, so the marker prefix is not itself a constant signature. */
	readonly prefix: string;
	private readonly salthash: number;
	private readonly mcache = new _Map<string, string>();
	private readonly ucache = new _Map<string, string>();

	constructor(readonly salt: string) {
		this.salthash = hashString(0x811c9dc5, salt);

		let h = hashString(0x01234567, salt);
		let prefix = "";
		for (let i = 0; i < 3; i++) {
			prefix += LETTERS[h % 26];
			h = (h / 26) >>> 0;
		}
		this.prefix = prefix;
	}

	private seed(kind: MangleKind): number {
		return (this.salthash ^ KINDSEED[kind]) >>> 0;
	}

	private remember(key: string, plain: string, mangled: string) {
		if (this.mcache.size > MAXCACHE) this.mcache.clear();
		if (this.ucache.size > MAXCACHE) this.ucache.clear();
		this.mcache.set(key + plain, mangled);
		this.ucache.set(key + mangled, plain);
	}

	/** Length of the marker that precedes the base32 body for this kind. */
	private marker(kind: MangleKind): number {
		return this.prefix.length + (kind === "tag" ? 1 : 0);
	}

	private looksMangled(kind: MangleKind, name: string): boolean {
		const marker = this.marker(kind);
		if (name.length <= marker) return false;
		for (let i = 0; i < this.prefix.length; i++) {
			if (name[i] !== this.prefix[i]) return false;
		}

		return kind !== "tag" || name[this.prefix.length] === "-";
	}

	mangle(kind: MangleKind, name: string): string {
		name = String(name);
		const key = kind + "\0";
		const cached = this.mcache.get(key + name);
		if (cached !== undefined) return cached;
		// idempotent: never mangle our own output twice
		if (this.looksMangled(kind, name) && this.decode(kind, name) !== null) {
			return name;
		}

		const seed = this.seed(kind);
		const bytes = TextEncoder_encode(name);
		const tweak = hashBytes(seed, bytes) & 0xffffff;
		const next = keystream((tweak ^ seed) >>> 0);

		const body = new _Uint8Array(3 + bytes.length);
		body[0] = tweak & 0xff;
		body[1] = (tweak >>> 8) & 0xff;
		body[2] = (tweak >>> 16) & 0xff;
		for (let i = 0; i < bytes.length; i++) body[3 + i] = bytes[i] ^ next();

		const out =
			this.prefix + (kind === "tag" ? "-" : "") + b32encode(body);
		this.remember(key, name, out);

		return out;
	}

	private decode(kind: MangleKind, name: string): string | null {
		const body = b32decode(name.slice(this.marker(kind)));
		if (!body || body.length < 3) return null;

		const tweak = body[0] | (body[1] << 8) | (body[2] << 16);
		const seed = this.seed(kind);
		const next = keystream((tweak ^ seed) >>> 0);

		const plain = new _Uint8Array(body.length - 3);
		for (let i = 0; i < plain.length; i++) plain[i] = body[3 + i] ^ next();
		if ((hashBytes(seed, plain) & 0xffffff) !== tweak) return null;

		return TextDecoder_decode(plain);
	}

	unmangle(kind: MangleKind, name: string): string {
		name = String(name);
		if (!this.looksMangled(kind, name)) return name;
		const key = kind + "\0";
		const cached = this.ucache.get(key + name);
		if (cached !== undefined) return cached;

		const plain = this.decode(kind, name);
		if (plain === null) return name;
		this.remember(key, plain, name);

		return plain;
	}
}

const manglers = new _Map<string, Mangler>();

/**
 * Manglers are pure functions of the salt, so one instance per salt per realm is
 * enough and the caches are shared by every call site.
 */
export function getMangler(salt: string): Mangler | null {
	if (!salt) return null;
	let mangler = manglers.get(salt);
	if (!mangler) {
		mangler = new Mangler(salt);
		manglers.set(salt, mangler);
	}

	return mangler;
}

// --- policy -----------------------------------------------------------------

/**
 * Hyphenated names that are *not* custom elements. `annotation-xml` and friends are
 * spec'd SVG/MathML elements and are explicitly forbidden as custom element names, so
 * renaming them would change parsing rather than hide a fingerprint.
 */
const RESERVEDTAGS = new _Set([
	"annotation-xml",
	"color-profile",
	"font-face",
	"font-face-format",
	"font-face-name",
	"font-face-src",
	"font-face-uri",
	"missing-glyph",
]);

/**
 * Only hyphenated names are manglable at all: renaming `div` would change layout and
 * semantics, and a custom element name is required by spec to contain a hyphen, so
 * the mangled form stays a legal custom element name.
 */
export function shouldMangleTag(name: string): boolean {
	return (
		name.indexOf("-") > 0 && !RESERVEDTAGS.has(name) && !name.includes(":")
	);
}

/**
 * Attributes whose *value* is an element id, and which therefore have to be mangled in
 * step with `id` so the references keep resolving.
 */
export const IDREF_ATTRS = new _Set([
	"aria-activedescendant",
	"aria-controls",
	"aria-describedby",
	"aria-details",
	"aria-errormessage",
	"aria-flowto",
	"aria-labelledby",
	"aria-owns",
	"commandfor",
	"for",
	"form",
	"headers",
	"itemref",
	"list",
	"popovertarget",
]);

/**
 * Standard HTML attribute names. Anything on an HTML element that is not in here, not
 * `aria-*`, not `on*` and not an XML/Scramjet name is treated as site-authored and is
 * therefore safe to rename. Being generous here is the safe direction: a missed entry
 * means we mangle something the browser understands and change behaviour.
 */
const STANDARDATTRS = new _Set([
	"abbr", "accept", "accept-charset", "accesskey", "action", "align", "allow",
	"allowfullscreen", "alpha", "alt", "as", "async", "autocapitalize",
	"autocomplete", "autocorrect", "autofocus", "autoplay", "background",
	"bgcolor", "blocking", "border", "capture", "charset", "checked", "cite",
	"class", "color", "colorspace", "cols", "colspan", "command", "commandfor",
	"content", "contenteditable", "controls", "controlslist", "coords",
	"crossorigin", "data", "datetime", "decoding", "default", "defer", "dir",
	"dirname", "disabled", "disablepictureinpicture", "disableremoteplayback",
	"download", "draggable", "enctype", "enterkeyhint", "elementtiming",
	"exportparts", "fetchpriority", "for", "form", "formaction", "formenctype",
	"formmethod", "formnovalidate", "formtarget", "headers", "height", "hidden",
	"high", "href", "hreflang", "http-equiv", "id", "imagesizes", "imagesrcset",
	"inert", "inputmode", "integrity", "is", "ismap", "itemid", "itemprop",
	"itemref", "itemscope", "itemtype", "kind", "label", "lang", "list",
	"loading", "longdesc", "loop", "low", "max", "maxlength", "media", "method",
	"min", "minlength", "multiple", "muted", "name", "nomodule", "nonce",
	"novalidate", "open", "optimum", "part", "pattern", "ping", "placeholder",
	"playsinline", "popover", "popovertarget", "popovertargetaction", "poster",
	"preload", "readonly", "referrerpolicy", "rel", "required", "reversed",
	"rows", "rowspan", "sandbox", "scope", "scrolling", "selected",
	"shadowrootclonable", "shadowrootdelegatesfocus", "shadowrootmode",
	"shadowrootserializable", "shape", "size", "sizes", "slot", "span",
	"spellcheck", "src", "srcdoc", "srclang", "srcset", "start", "step",
	"style", "summary", "tabindex", "target", "title", "translate", "type",
	"usemap", "value", "width", "wrap", "writingsuggestions",
	// legacy but still honoured by parsers
	"accesskey", "axis", "cellpadding", "cellspacing", "char", "charoff",
	"classid", "clear", "codebase", "codetype", "compact", "declare", "face",
	"frame", "frameborder", "hspace", "language", "link", "marginheight",
	"marginwidth", "noresize", "noshade", "nowrap", "profile", "rules",
	"scheme", "scrollamount", "standby", "text", "valign", "valuetype",
	"version", "vlink", "vspace",
]);

/**
 * Attribute *names* are only mangled for `data-*` and unrecognised names, and never
 * inside SVG/MathML, whose attribute vocabulary is large, case sensitive and
 * presentation bearing.
 */
export function shouldMangleAttr(name: string, foreign: boolean): boolean {
	if (foreign) return false;
	if (name.startsWith("data-")) return true;
	if (STANDARDATTRS.has(name)) return false;
	if (name.startsWith("aria-")) return false;
	if (name.startsWith("on")) return false;
	if (name.startsWith("xml") || name.startsWith("xlink:")) return false;
	if (name.includes(":")) return false;

	return true;
}

// --- salt derived naming ----------------------------------------------------

function ident(salt: string, key: string): string {
	const a = hashString(0x811c9dc5, salt + "\0" + key);
	const b = hashString(a, key + "\0" + salt);
	const bytes = new _Uint8Array([
		a & 0xff,
		(a >>> 8) & 0xff,
		(a >>> 16) & 0xff,
		(a >>> 24) & 0xff,
		b & 0xff,
		(b >>> 8) & 0xff,
		(b >>> 16) & 0xff,
	]);

	return b32encode(bytes);
}

/**
 * Replace every constant Scramjet marker with a salt derived one.
 *
 * `scramjet-attr-*` in the real DOM and `$scramjet$*` in rewritten JS are *proxy*
 * signatures rather than site signatures: they are present on every proxied page, so
 * `[scramjet-attr-href]` is far stronger evidence for a detector than any single
 * site's custom elements. They cost almost nothing to randomise because
 * `config.globals` was already parameterised.
 *
 * Returns a new config; the input is not modified.
 */
export function applyMangleSalt(
	config: ScramjetConfig,
	salt: string
): ScramjetConfig {
	if (!salt) return config;
	const g = (key: string) => "_" + ident(salt, key);

	return {
		...config,
		mangleSalt: salt,
		globals: {
			wrapfn: g("wrapfn"),
			wrappropertybase: g("wrappropertybase"),
			wrappropertyfn: g("wrappropertyfn"),
			cleanrestfn: g("cleanrestfn"),
			importfn: g("importfn"),
			rewritefn: g("rewritefn"),
			metafn: g("metafn"),
			wrappostmessagefn: g("wrappostmessagefn"),
			pushsourcemapfn: g("pushsourcemapfn"),
			trysetfn: g("trysetfn"),
			setrealmfn: g("setrealmfn"),
			templocid: g("templocid"),
			tempunusedid: g("tempunusedid"),
			attrprefix: ident(salt, "attrprefix") + "-",
			injectedattr: ident(salt, "injectedattr"),
		},
	};
}

/** Set of manglers for one document, resolved once instead of per node. */
export type ManglerSet = {
	tag: Mangler | null;
	attr: Mangler | null;
	classid: Mangler | null;
	/** True when at least one tier applies, so callers can skip the walk entirely. */
	enabled: boolean;
};

export type MangleDirection = "rewrite" | "unrewrite";

/**
 * Rewrite each whitespace separated token, preserving the original spacing.
 *
 * Used for `class` and for the IDREF attributes; an id may not contain whitespace, so
 * a single reference is simply a list of one.
 */
export function mangleTokenList(
	value: string,
	xf: (token: string) => string
): string {
	let out = "";
	let token = "";
	for (let i = 0; i <= value.length; i++) {
		const c = i < value.length ? value[i] : "";
		if (c === "" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
			if (token) {
				out += xf(token);
				token = "";
			}
			out += c;
		} else {
			token += c;
		}
	}

	return out;
}

/**
 * Mangle or unmangle every identifier carried by one parsed element.
 *
 * Both directions live here on purpose: the rewrite path and the `unrewriteHtml` path
 * have to agree exactly on which names and which attribute values are in scope, and
 * splitting them into two functions is how that agreement rots.
 *
 * `skipAttr` excludes Scramjet's own bookkeeping attributes, whose names must stay
 * verbatim because the client traps look them up by name.
 */
export function transformElementIdents(
	node: { name?: string; attribs?: Record<string, string> },
	manglers: ManglerSet,
	direction: MangleDirection,
	foreign: boolean,
	skipAttr: (name: string) => boolean
): void {
	const rewriting = direction === "rewrite";
	const map = (m: Mangler, kind: MangleKind, value: string) =>
		rewriting ? m.mangle(kind, value) : m.unmangle(kind, value);

	const attribs = node.attribs;
	if (attribs) {
		if (manglers.classid) {
			const m = manglers.classid;
			if (typeof attribs.class === "string") {
				attribs.class = mangleTokenList(attribs.class, (t) =>
					map(m, "class", t)
				);
			}
			if (typeof attribs.id === "string") {
				attribs.id = map(m, "id", attribs.id);
			}
			for (const attr of IDREF_ATTRS) {
				if (typeof attribs[attr] === "string") {
					attribs[attr] = mangleTokenList(attribs[attr], (t) =>
						map(m, "id", t)
					);
				}
			}
		}

		// a customised built-in names a custom element, so it lives in the tag namespace
		if (manglers.tag && typeof attribs.is === "string") {
			if (!rewriting || shouldMangleTag(attribs.is)) {
				attribs.is = map(manglers.tag, "tag", attribs.is);
			}
		}

		if (manglers.attr && !foreign) {
			const m = manglers.attr;
			// rebuilt rather than renamed in place: deleting and re-adding a key moves
			// it to the end, and a document whose attributes are all reordered the same
			// way is itself something to match on
			const names = Object_keys(attribs);
			const renamed: Record<string, string> = {};
			let changed = false;
			for (const name of names) {
				const skip =
					skipAttr(name) || (rewriting && !shouldMangleAttr(name, foreign));
				const next = skip ? name : map(m, "attr", name);
				if (next !== name) changed = true;
				renamed[next] = attribs[name];
			}
			if (changed) {
				for (const name of names) delete attribs[name];
				for (const name of Object_keys(renamed)) attribs[name] = renamed[name];
			}
		}
	}

	if (manglers.tag && typeof node.name === "string") {
		if (!rewriting || shouldMangleTag(node.name)) {
			node.name = map(manglers.tag, "tag", node.name);
		}
	}
}
