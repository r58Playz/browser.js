/**
 * How big was the file the SITE served?
 *
 * `PerformanceResourceTiming` reports the size of what the renderer actually
 * received, which under the proxy is the REWRITTEN script -- bigger than the
 * original by every expansion the rewriter made. A page that checks its own
 * bundle size (Cloudflare's challenge does) sees the proxy in that number.
 *
 * The rewriter already ships the information needed to undo it: the sourcemap
 * it pushes alongside each script records every insertion and every
 * replacement, so the original size is the reported size minus what was added.
 * That is arithmetic on the map, no unrewriting required.
 *
 * Kept free of client imports so it can be unit-tested on its own; see
 * `runway/src/sbxdiff/sourcemapsize.test.ts`.
 */

/** A rewrite that only added bytes; `size` is how many. */
export const INSERT = 0;
/** A rewrite that swapped `oldLen` bytes for the `start`..`end` span. */
export const REPLACE = 1;

export type SizedRewrite =
	| { type: typeof INSERT; size: number }
	| { type: typeof REPLACE; start: number; end: number; oldLen: number };

/**
 * Bytes the rewriter ADDED, which may be negative if it shortened the file.
 */
export function rewriteOverhead(rewrites: SizedRewrite[]): number {
	let added = 0;
	for (const r of rewrites) {
		if (r.type === INSERT) added += r.size;
		// The map stores the ORIGINAL text and where the new text sits, so the
		// growth is the new span minus the old string's length in bytes.
		else added += r.end - r.start - r.oldLen;
	}

	return added;
}

/**
 * Where a rewritten inline script SITS in the document.
 *
 * An external script is its own resource, so a frame's column counts from the
 * start of the script and the rewrite map applies to it directly. An inline
 * one shares its line with the HTML around it: the challenge script on
 * rateyourmusic's Turnstile page starts at line 245 COLUMN 19222, after 19 kB
 * of `<meta>` tags on the same line. A column can only be turned into an offset
 * into the script by subtracting where the script began -- and it has to be
 * subtracted in both coordinate systems, because the rewriter moved it:
 *
 * - `line`/`column` are where the script began in the SITE's document, which is
 *   what a frame has to be reported in.
 * - `rewrittenLine`/`rewrittenColumn` are where it begins in the document the
 *   browser actually parsed, which is what a frame arrives in.
 *
 * The first pair is known while rewriting -- the parser records each node's
 * offset in the source. The second is not: it depends on every expansion the
 * rewriter made EARLIER in the document, which is only settled once the tree is
 * serialised. So the call is emitted with the second pair as a fixed-width run
 * of digits and `anchorInlineScripts` overwrites it in the finished string.
 * Fixed width is the whole trick: writing the real numbers back cannot move
 * anything, so the offsets measured to produce them stay correct.
 */
export type InlineBase = {
	line: number;
	column: number;
	/** Filled in by `rewriteJs`, so the caller can find this script again. */
	tag?: string;
	/** Bytes of the call, also filled in by `rewriteJs`. */
	prelude?: number;
	/**
	 * Characters before the call within the rewritten script, which is nonzero
	 * only when a `"use strict"` prologue had to stay first.
	 */
	offset?: number;
};

/** Characters reserved for each anchor. 10 covers a 10 GB document. */
export const ANCHOR_WIDTH = 10;

/** What the anchors hold until the document has been serialised. */
export const ANCHOR_PLACEHOLDER = " ".repeat(ANCHOR_WIDTH - 1) + "0";

/**
 * A number in an anchor's fixed field, so writing it moves nothing.
 *
 * Padded with SPACES rather than zeros, which is not cosmetic. `0000000245` is
 * a legacy octal literal, and octal 245 is 165 -- so a zero-padded line number
 * arrived at the other end silently divided. It was only visible at all
 * because the column beside it happened to contain an 8: a literal with an 8
 * or a 9 in it is not valid octal and falls back to decimal, so the column
 * came through intact while the line did not.
 *
 * Spaces have neither problem. They keep the field exactly as wide, they
 * cannot change how the digits are read, and a legacy octal literal is a
 * SyntaxError under `"use strict"` where this would otherwise have broken the
 * script outright rather than merely mis-reading it.
 */
export function anchorDigits(n: number): string {
	// Floored and clamped without `Math` or `String`: this file is deliberately
	// free of client imports so it can be unit-tested on its own, and the
	// no-globals rule is right that reaching for the runtime's own is not a
	// substitute for one.
	const whole = n > 0 ? n - (n % 1) : 0;
	const s = `${whole}`;

	// Truncation here would silently corrupt a position rather than drop it, so
	// an over-long value gives up on the anchor instead -- a script the mapping
	// skips keeps its uncorrected columns, which is the behaviour without any
	// of this.
	return s.length > ANCHOR_WIDTH
		? ANCHOR_PLACEHOLDER
		: s.padStart(ANCHOR_WIDTH, " ");
}

/**
 * The sourcemap call `rewriteJs` prepends to a rewritten script.
 *
 * Built HERE rather than at each site that needs it, because there are two and
 * they have to agree to the byte: `js.ts` puts this string in the script, and
 * `preludeBytes` subtracts it back out of the script's size. The string is in
 * the script and in no rewrite -- the map is computed before it exists -- so a
 * disagreement between the two would look exactly like original source.
 *
 * NO trailing newline: the call runs into the first line of the script so that
 * every line keeps the number the site gave it.
 */
export function preludeCall(
	fnName: string,
	buf: ArrayLike<number>,
	tag: string,
	lines: ArrayLike<number> = [],
	base?: InlineBase
): string {
	const head = `${fnName}([${Array.prototype.join.call(buf, ",")}], "${tag}", [${Array.prototype.join.call(lines, ",")}]`;
	if (!base) return `${head});`;

	return `${head}, ${base.line}, ${base.column}, ${ANCHOR_PLACEHOLDER}, ${ANCHOR_PLACEHOLDER});`;
}

/** The bytes of that call, to subtract from a rewritten script's size. */
export function preludeBytes(
	fnName: string,
	buf: ArrayLike<number>,
	tag: string,
	lines: ArrayLike<number> = [],
	base?: InlineBase
): number {
	return new TextEncoder().encode(preludeCall(fnName, buf, tag, lines, base))
		.length;
}

/**
 * The original size of a resource that was rewritten to `rewritten` bytes.
 *
 * Falls back to the reported size if the arithmetic lands somewhere
 * impossible: a wrong number here is a divergence of its own, and the
 * uncorrected value is at least the one every other proxy would report.
 */
export function originalSize(
	rewrites: SizedRewrite[],
	rewritten: number,
	prelude = 0
): number {
	const original = rewritten - rewriteOverhead(rewrites) - prelude;

	return original > 0 && original <= rewritten ? original : rewritten;
}
