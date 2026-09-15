/**
 * Rewritten source for a script scramjet has already rewritten, per client.
 *
 * Cloudflare's Turnstile widget builds its 1.3 MB challenge script once per
 * 550 ms poll round and does that ~208 times before its own deadline ends the
 * attempt (FINDINGS.md #235, #240, #242). Every round, scramjet parsed and
 * rewrote the same bytes again: measured at 880 traced calls per round against
 * the oracle's 9, of which ~870 are the rewriter and the URL rewriter inside it
 * -- 357 `URL.href` reads and 47 `querySelector("base")` lookups per round.
 *
 * The oracle does not pay this and cannot be made to: V8 compiles the source
 * directly and keeps a compilation cache.
 *
 * Two call sites reach here, and finding the second cost a run (#241): the
 * widget uses `new Function(src)`, not `eval(src)`. `Function.constructor` and
 * `Function.prototype.toString` are ECMAScript members with no Web IDL behind
 * them, so the binding tracer cannot record either -- they are visible only in
 * the guest-op stream, where they read 288 and 2150 in the widget's realm.
 *
 * Safe because the rewrite is a pure function of (source, context, url) on
 * these paths, and because the one side effect `rewriteJs` has -- registering a
 * sourcemap under `res.tag` -- is already done: the cached string carries the
 * same scramtag the first rewrite registered. Neither caller passes an
 * `InlineBase`, which is the other thing `rewriteJs` mutates.
 */

import { rewriteJs } from "@rewriters/js";
import type { ScramjetClient } from "@client/index";
import { _Map, _WeakMap } from "@/shared/snapshot";

/**
 * Below this, rewriting is cheap and the entries are many.
 *
 * The pathology is repeated evaluation of a BIG script; a cache over every
 * `eval("1+1")` a page makes would retain far more than it saves.
 */
const MIN_CACHED = 32 * 1024;
/**
 * Source bytes kept per client, counting keys and values.
 *
 * An entry retains its source string as the key, which is the only way to be
 * certain two sources are the same one -- a hash would be smaller and would
 * mean a collision runs the wrong code -- so the bound has to be real.
 *
 * Counted in BYTES rather than entries, because entries was the wrong unit and
 * the diagnostic said so: every miss on rateyourmusic reported `entries=4`,
 * meaning the cache was permanently full and evicting on every call. A cap of
 * four is either far too much (four 1.3 MB scripts is 10 MB) or far too little
 * (five small ones thrash), depending on a size the cap does not look at.
 */
const MAX_BYTES = 8 * 1024 * 1024;

type Cache = { url: string; bytes: number; entries: _Map<string, string> };
const caches: _WeakMap<ScramjetClient, Cache> = new _WeakMap([]);

/**
 * `rewriteJs`, memoized on the source for this client's current URL.
 *
 * Keyed on the URL as well as the source because the rewrite embeds the base a
 * relative URL resolves against, so the same source under a different document
 * URL is a different answer. A navigation empties the cache rather than growing
 * it a second set of entries.
 */
export function rewriteCached(
	client: ScramjetClient,
	js: string,
	why: string
): string {
	if (js.length < MIN_CACHED) {
		return rewriteJs(js, why, client.context, client.meta) as string;
	}
	const url = client.url.href;
	let cache = caches.get(client);
	if (!cache || cache.url !== url) {
		cache = { url, bytes: 0, entries: new _Map([]) };
		caches.set(client, cache);
	}
	const hit = cache.entries.get(js);
	if (hit !== undefined) {
		// Least-recently-used, not first-in-first-out. A `Map` iterates in
		// insertion order, so re-inserting on a hit moves the entry to the end
		// and makes eviction take the genuinely coldest one. Without it, one
		// script read in a loop can evict itself.
		cache.entries.delete(js);
		cache.entries.set(js, hit);

		return hit;
	}

	const rewritten = rewriteJs(js, why, client.context, client.meta) as string;
	cache.entries.set(js, rewritten);
	cache.bytes += js.length + rewritten.length;
	// Coldest out, until the cache is inside its budget. `keys()` is in
	// insertion order and a hit re-inserts, so the first key is the coldest.
	while (cache.bytes > MAX_BYTES && cache.entries.size > 1) {
		for (const k of cache.entries.keys()) {
			cache.bytes -= k.length + (cache.entries.get(k)?.length ?? 0);
			cache.entries.delete(k);
			break;
		}
	}

	return rewritten;
}
