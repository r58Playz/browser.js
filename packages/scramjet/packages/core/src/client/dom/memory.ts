import { ScramjetClient } from "@client/index";

/**
 * `performance.memory`, with the proxy's own heap taken back out.
 *
 * The numbers are per-ISOLATE, and under scramjet the shim shares the guest's
 * isolate: the client bundle, the rewriter's wasm and every rewritten source
 * are all on the same heap the page is asking about. Measured on
 * rateyourmusic, in Cloudflare's Turnstile realm, which reads them six times:
 *
 *     totalJSHeapSize    53558272  direct  vs  180295469  proxied
 *     usedJSHeapSize     31237624  direct  vs  137809077  proxied
 *
 * That is 4x, and it is in the payload the widget posts.
 *
 * The correction is a measurement rather than a constant: the client reads the
 * heap ONCE at init -- after its own bundle is in memory and before a line of
 * guest code has run -- and reports the growth since. What the page then sees
 * is its own allocation, which is the number it would have on a direct load.
 *
 * It is not exact. The shim keeps allocating after init (it rewrites every
 * script the page loads, on this same thread), so some of its cost is still
 * counted as the page's. A fixed value would be worse in both directions: it
 * cannot move as the page allocates, which is the one thing these numbers are
 * for, and every page on the proxy would report the same heap.
 *
 * `jsHeapSizeLimit` is left alone -- it is a property of the isolate, the same
 * on both sides, and subtracting anything from it would be inventing a limit.
 */
export default function (client: ScramjetClient) {
	const perf = client.global.performance as Performance & {
		memory?: {
			totalJSHeapSize: number;
			usedJSHeapSize: number;
		};
	};
	const memory = perf?.memory;
	// Chromium-only. Nothing to correct where it does not exist.
	if (!memory) return;

	const proto = Object.getPrototypeOf(memory);
	if (!proto) return;

	// Read through the natives, before anything traps them.
	const baseTotal = memory.totalJSHeapSize;
	const baseUsed = memory.usedJSHeapSize;

	// A page's heap is never zero, and a reading below the baseline means the
	// collector ran rather than that the page freed the shim's memory. One
	// megabyte is the floor, so the numbers stay plausible instead of
	// impossible.
	const FLOOR = 1024 * 1024;
	const without = (reported: number, base: number): number => {
		if (typeof reported !== "number" || reported <= 0) return reported;
		const own = reported - base;

		return own > FLOOR ? own : Math.min(FLOOR, reported);
	};

	client.RawTrap(proto, "totalJSHeapSize", {
		get(ctx) {
			return without(ctx.get() as number, baseTotal);
		},
	});
	client.RawTrap(proto, "usedJSHeapSize", {
		get(ctx) {
			return without(ctx.get() as number, baseUsed);
		},
	});
}
