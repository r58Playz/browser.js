/**
 * @fileoverview
 * A CSS selector walker used by both halves of the identifier mangler.
 *
 * Renaming `yt-icon` in the markup is only half the job: `yt-icon { display: block }`
 * has to be renamed with it or the page loses its styling. The same walker backs the
 * `querySelector`/`matches`/`closest` traps, so a selector the page hands us is
 * translated with exactly the rules the stylesheet was translated with.
 *
 * This is deliberately a scanner rather than a parser. It only needs to find the
 * identifiers that sit in four syntactic positions (type, class, id, attribute name)
 * and hand them to a transform; everything else is copied through untouched.
 */

import { MangleKind } from "@/shared/mangle";
import {
	Number_parseInt,
	String_fromCodePoint,
	String,
	_Set,
} from "@/shared/snapshot";

/** Returns the replacement for an identifier, or the identifier itself to leave it. */
export type IdentTransform = (kind: MangleKind, name: string) => string;

/**
 * Functional pseudo-classes whose argument is itself a selector list, so their
 * contents have to be walked recursively.
 */
const SELECTOR_PSEUDOS = new _Set<string>([
	"is",
	"where",
	"not",
	"has",
	"matches",
	"-webkit-any",
	"-moz-any",
	"host",
	"host-context",
	"slotted",
]);

/** `:nth-child(An+B of <selector>)` — only the part after `of` is a selector. */
const NTH_PSEUDOS = new _Set<string>(["nth-child", "nth-last-child"]);

/**
 * Attribute selectors we can translate. Substring operators cannot survive mangling
 * (mangled names share no substrings with the original) so they are left alone; see
 * the known limits in the feature docs.
 */
const EXACT_OPS = new _Set<string>(["=", "~="]);

function isIdentChar(c: string): boolean {
	return (
		(c >= "a" && c <= "z") ||
		(c >= "A" && c <= "Z") ||
		(c >= "0" && c <= "9") ||
		c === "-" ||
		c === "_" ||
		c.charCodeAt(0) >= 0x80
	);
}

function isHex(c: string): boolean {
	return (
		(c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")
	);
}

function isSpace(c: string): boolean {
	return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

/**
 * A compound selector may only begin here: at the start, after a combinator, after a
 * comma, or inside a functional pseudo. Anywhere else an identifier belongs to
 * whatever token introduced it (`.foo`, `#foo`, `:foo`, `[foo]`) and is consumed by
 * that branch instead.
 */
function isCompoundStart(prev: string): boolean {
	return (
		prev === "" ||
		isSpace(prev) ||
		prev === ">" ||
		prev === "+" ||
		prev === "~" ||
		prev === "," ||
		prev === "(" ||
		prev === "|" ||
		prev === "&"
	);
}

/** Decode CSS escapes so the transform sees the identifier the DOM would report. */
function unescapeIdent(raw: string): string {
	if (raw.indexOf("\\") === -1) return raw;

	let out = "";
	let i = 0;
	while (i < raw.length) {
		if (raw[i] !== "\\") {
			out += raw[i++];
			continue;
		}
		i++;
		if (i >= raw.length) break;
		if (!isHex(raw[i])) {
			out += raw[i++];
			continue;
		}
		let hex = "";
		while (i < raw.length && hex.length < 6 && isHex(raw[i])) hex += raw[i++];
		// a single trailing whitespace terminates the escape and is not literal
		if (i < raw.length && isSpace(raw[i])) i++;
		const code = Number_parseInt(hex, 16);
		out += code === 0 ? "�" : String.fromCodePoint(code);
	}

	return out;
}

/**
 * Re-escape an identifier for use in a selector. Mangled output is pure `[a-z2-7]`
 * and never needs this, but unmangling can hand back arbitrary original names.
 */
function escapeIdent(name: string): string {
	let out = "";
	for (let i = 0; i < name.length; i++) {
		const c = name[i];
		const first = i === 0;
		if (isIdentChar(c) && !(first && c >= "0" && c <= "9")) {
			out += c;
			continue;
		}
		out += "\\" + name.codePointAt(i)!.toString(16) + " ";
		// codePointAt may have consumed a surrogate pair
		if (name.codePointAt(i)! > 0xffff) i++;
	}

	return out;
}

/** Read an identifier (escapes included) starting at `i`; returns the raw source. */
function readIdent(s: string, i: number): string {
	let out = "";
	while (i < s.length) {
		const c = s[i];
		if (c === "\\") {
			out += c;
			i++;
			if (i < s.length) {
				out += s[i++];
				// consume the rest of a hex escape so it is not split
				if (isHex(out[out.length - 1])) {
					let n = 1;
					while (i < s.length && n < 6 && isHex(s[i])) {
						out += s[i++];
						n++;
					}
					if (i < s.length && isSpace(s[i])) out += s[i++];
				}
			}
			continue;
		}
		if (!isIdentChar(c)) break;
		out += c;
		i++;
	}

	return out;
}

/** Read a quoted string starting at the opening quote; returns the raw source. */
function readString(s: string, i: number): string {
	const quote = s[i];
	let out = quote;
	i++;
	while (i < s.length) {
		const c = s[i];
		out += c;
		i++;
		if (c === "\\" && i < s.length) {
			out += s[i++];
			continue;
		}
		if (c === quote) break;
	}

	return out;
}

function apply(xf: IdentTransform, kind: MangleKind, raw: string): string {
	const plain = unescapeIdent(raw);
	const next = xf(kind, plain);

	return next === plain ? raw : escapeIdent(next);
}

/**
 * Walk one selector list and rewrite the identifiers in it.
 *
 * Unrecognised syntax is copied verbatim, so a selector we do not fully understand
 * degrades to "unchanged" rather than "corrupted".
 */
export function transformSelector(
	selector: string,
	xf: IdentTransform
): string {
	const s = String(selector);
	let out = "";
	let i = 0;
	let prev = "";

	while (i < s.length) {
		const c = s[i];

		if (c === "\"" || c === "'") {
			const str = readString(s, i);
			out += str;
			i += str.length;
			prev = c;
			continue;
		}

		if (c === "/" && s[i + 1] === "*") {
			const end = s.indexOf("*/", i + 2);
			const stop = end === -1 ? s.length : end + 2;
			out += s.slice(i, stop);
			i = stop;
			continue;
		}

		if (c === "." || c === "#") {
			const raw = readIdent(s, i + 1);
			if (!raw) {
				out += c;
				i++;
				prev = c;
				continue;
			}
			out += c + apply(xf, c === "." ? "class" : "id", raw);
			i += 1 + raw.length;
			prev = "ident";
			continue;
		}

		if (c === "[") {
			const res = transformAttrSelector(s, i, xf);
			out += res.text;
			i = res.next;
			prev = "]";
			continue;
		}

		if (c === ":") {
			const res = transformPseudo(s, i, xf);
			out += res.text;
			i = res.next;
			prev = ")";
			continue;
		}

		if ((isIdentChar(c) || c === "\\") && isCompoundStart(prev)) {
			const raw = readIdent(s, i);
			if (raw) {
				// `ns|tag` — the namespace prefix is not a type selector
				if (s[i + raw.length] === "|" && s[i + raw.length + 1] !== "=") {
					out += raw + "|";
					i += raw.length + 1;
					prev = "|";
					continue;
				}
				out += apply(xf, "tag", raw);
				i += raw.length;
				prev = "ident";
				continue;
			}
		}

		out += c;
		i++;
		prev = c;
	}

	return out;
}

function transformAttrSelector(
	s: string,
	start: number,
	xf: IdentTransform
): { text: string; next: number } {
	let i = start + 1;
	let out = "[";

	while (i < s.length && isSpace(s[i])) out += s[i++];

	let raw = readIdent(s, i);
	// `[ns|attr]`
	if (raw && s[i + raw.length] === "|" && s[i + raw.length + 1] !== "=") {
		out += raw + "|";
		i += raw.length + 1;
		raw = readIdent(s, i);
	}
	if (!raw) return { text: "[", next: start + 1 };

	const name = unescapeIdent(raw);
	out += apply(xf, "attr", raw);
	i += raw.length;

	while (i < s.length && isSpace(s[i])) out += s[i++];

	let op = "";
	if (s[i] === "=") op = "=";
	else if ("~|^$*".indexOf(s[i]) !== -1 && s[i + 1] === "=") op = s[i] + "=";
	if (!op) {
		// bare `[attr]`, copy the rest of the bracket through
		const end = s.indexOf("]", i);
		const stop = end === -1 ? s.length : end + 1;
		out += s.slice(i, stop);

		return { text: out, next: stop };
	}
	out += op;
	i += op.length;

	while (i < s.length && isSpace(s[i])) out += s[i++];

	// `[class~="foo"]` and `[id="foo"]` address the same namespaces as `.foo`/`#foo`
	const valueKind: MangleKind | null =
		!EXACT_OPS.has(op)
			? null
			: name === "class"
				? "class"
				: name === "id"
					? "id"
					: null;

	if (s[i] === "\"" || s[i] === "'") {
		const quote = s[i];
		const str = readString(s, i);
		i += str.length;
		const inner = str.slice(1, str.endsWith(quote) && str.length > 1 ? -1 : undefined);
		out +=
			valueKind === null
				? str
				: quote + transformStringValue(inner, valueKind, xf) + quote;
	} else {
		const raw2 = readIdent(s, i);
		i += raw2.length;
		out += valueKind === null ? raw2 : apply(xf, valueKind, raw2);
	}

	const end = s.indexOf("]", i);
	const stop = end === -1 ? s.length : end + 1;
	out += s.slice(i, stop);

	return { text: out, next: stop };
}

/** Attribute values are plain strings, not idents, so they need no escape handling. */
function transformStringValue(
	value: string,
	kind: MangleKind,
	xf: IdentTransform
): string {
	return xf(kind, value);
}

function transformPseudo(
	s: string,
	start: number,
	xf: IdentTransform
): { text: string; next: number } {
	let i = start + 1;
	let out = ":";
	if (s[i] === ":") {
		out += ":";
		i++;
	}

	const raw = readIdent(s, i);
	if (!raw) return { text: out, next: i };
	out += raw;
	i += raw.length;

	if (s[i] !== "(") return { text: out, next: i };

	// find the matching paren, honouring nested parens and strings
	let depth = 0;
	let j = i;
	for (; j < s.length; j++) {
		const c = s[j];
		if (c === "\"" || c === "'") {
			j += readString(s, j).length - 1;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) break;
		}
	}
	const close = j < s.length ? j : s.length;
	const inner = s.slice(i + 1, close);
	const name = unescapeIdent(raw).toLowerCase();

	let rewritten: string;
	if (SELECTOR_PSEUDOS.has(name)) {
		rewritten = transformSelector(inner, xf);
	} else if (NTH_PSEUDOS.has(name)) {
		const of = /\bof\b/i.exec(inner);
		rewritten = of
			? inner.slice(0, of.index + of[0].length) +
				transformSelector(inner.slice(of.index + of[0].length), xf)
			: inner;
	} else {
		rewritten = inner;
	}

	out += "(" + rewritten + (close < s.length ? ")" : "");

	return { text: out, next: close + 1 };
}
