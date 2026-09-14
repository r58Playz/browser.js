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
 * The bytes of the sourcemap call `rewriteJs` prepends to a rewritten script.
 *
 * This string is built AFTER the map is computed, so it appears in the script
 * and in no rewrite -- it has to be subtracted separately or it looks like
 * original source. Rebuilt here exactly as `js.ts` builds it rather than
 * estimated, which means NO trailing newline: the call runs into the first line
 * of the script so that every line keeps the number the site gave it.
 */
export function preludeBytes(
	fnName: string,
	buf: ArrayLike<number>,
	tag: string
): number {
	const call = `${fnName}([${Array.prototype.join.call(buf, ",")}], "${tag}");`;

	return new TextEncoder().encode(call).length;
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
