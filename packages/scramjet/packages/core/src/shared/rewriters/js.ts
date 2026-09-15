import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import { preludeCall, type InlineBase } from "@/shared/sourcemapsize";
import {
	Array_from,
	TextDecoder_decode,
	_RegExp,
	_Uint8Array,
	Object_keys,
	Performance_now,
} from "../snapshot";

/**
 * Rewritten output, keyed by what the rewrite is a function of.
 *
 * Cloudflare's challenge runs on `eval` and the Function constructor, and every
 * string it evaluates goes through the whole wasm rewriter. Measured on the rym
 * replay: 229 rewrites of 32 MB, of which 12 MB -- 38% -- were the SAME source
 * with the same hash rewritten again. `(indirect eval proxy)` alone repeated 44
 * times.
 *
 * That is not inherent proxy cost, it is the same work done twice, and it is
 * part of why the sandbox reaches the challenge's payload collection 2.1
 * seconds after the oracle does (RULES.md #157, #160).
 *
 * A rewrite is a pure function of the text, the base URL it resolves against,
 * whether it is a module, and the flags -- so the key is all four. Not the
 * source LABEL: `(direct eval proxy)` is the same label for every eval on the
 * page and names nothing.
 *
 * Bounded, because a page can evaluate unbounded distinct source: oldest out
 * first, on entry count and on total bytes held.
 */
const REWRITE_CACHE_ENTRIES = 128;
const REWRITE_CACHE_BYTES = 16 * 1024 * 1024;
const rewriteCache = new Map<string, RewriterResult>();
let rewriteCacheBytes = 0;

function resultBytes(r: RewriterResult): number {
	const js = typeof r.js === "string" ? r.js.length : r.js.byteLength;

	return js + (r.map ? r.map.byteLength : 0);
}

function cacheRemember(key: string, value: RewriterResult): void {
	rewriteCache.set(key, value);
	rewriteCacheBytes += resultBytes(value);
	while (
		rewriteCache.size > REWRITE_CACHE_ENTRIES ||
		rewriteCacheBytes > REWRITE_CACHE_BYTES
	) {
		const oldest = rewriteCache.keys().next();
		if (oldest.done) break;
		const dropped = rewriteCache.get(oldest.value);
		rewriteCache.delete(oldest.value);
		if (dropped) rewriteCacheBytes -= resultBytes(dropped);
	}
}

type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
};
function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): RewriterResult {
	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, meta.base);
	}

	// FNV-1a over the source. Hashing a megabyte costs a fraction of rewriting
	// it, and a collision would have to also match the length, the base, the
	// module flag and every rewriter flag to be reached.
	let hash = 2166136261;
	const hashed = typeof input === "string" ? input : null;
	if (hashed !== null) {
		for (let i = 0; i < hashed.length; i++) {
			hash ^= hashed.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
	}
	const cacheKey =
		hashed === null
			? null
			: `${hash >>> 0}:${hashed.length}:${isModule ? 1 : 0}:${meta.base.href}:${JSON.stringify(flagsobj)}`;
	if (cacheKey !== null) {
		const hit = rewriteCache.get(cacheKey);
		if (hit) {
			// Freshen: this is an LRU and a hit is a use.
			rewriteCache.delete(cacheKey);
			rewriteCache.set(cacheKey, hit);

			return hit;
		}
	}

	// Deeper stacks for the rewriter's own failures, for the duration of ONE
	// rewrite. A rewrite is synchronous and nothing of the guest's runs during
	// one, so raising it is not observable -- PROVIDED it always comes back.
	// Restored to what was read rather than to a constant, so a page that set
	// its own limit keeps it.
	//
	// `Error.stackTraceLimit` is a plain property any page can read, and the
	// guest's captured stacks get as deep as it allows. It has leaked twice:
	// first as a module-level `Error.stackTraceLimit = 50` that ran once per
	// realm and never came back, and then -- after that was fixed -- from being
	// raised at the top of this function, ABOVE the cache check.
	//
	// Raised HERE, after the cache check, and not before it.
	//
	// It used to be raised at the top of the function, and the cache hit above
	// `return`s before the `try` whose `finally` puts it back -- so the FIRST
	// rewrite of a given source restored it and every cache HIT leaked 50.
	// rateyourmusic's challenge is rewritten 234 times, 159 of them `eval`, so
	// it stuck at 50 for the rest of the run.
	//
	// Measured with `probes/stacklimit.js`, reading the property from inside the
	// widget's own realm:
	//
	//     oracle    enter 10, microtask 10, t1..t6 10
	//     sandbox   enter 10, microtask 10, t1..t6 50
	//
	// which the challenge then collects: the stack it serialises into its
	// payload has 10 frames in a browser and 17 under the proxy.
	//
	// The cache path does no rewriting and needs no deeper stack, so this is
	// also where it belongs on its own terms.
	// eslint-disable-next-line scramjet-core/no-globals
	const guestStackLimit = Error.stackTraceLimit;
	// eslint-disable-next-line scramjet-core/no-globals
	Error.stackTraceLimit = 50;

	const [rewriter, ret] = getRewriter(context, meta);

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		// try {
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		}
		// } catch (err) {
		// 	const err1 = err as Error;
		// 	console.warn(
		// 		"failed rewriting js for",
		// 		source,
		// 		err1.message,
		// 		input instanceof Uint8Array ? textDecoder.decode(input) : input
		// 	);

		// 	return { js: input, tag: "", map: null };
		// }
		if (flagEnabled("rewriterLogs", context, meta.base)) {
			dbg.time(meta, before, `oxc rewrite for "${source || "(unknown)"}"`);
		}

		const { js, map, scramtag, errors } = out;

		const result: RewriterResult = {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
		// Only a clean rewrite is remembered. A failed one may depend on state
		// this key does not capture, and serving it again would make one bad
		// rewrite permanent for the life of the realm.
		if (cacheKey !== null && (!errors || errors.length === 0)) {
			cacheRemember(cacheKey, result);
		}

		return result;
	} finally {
		ret();
		// eslint-disable-next-line scramjet-core/no-globals
		Error.stackTraceLimit = guestStackLimit;
	}
}

export function rewriteJsInner(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
) {
	return rewriteJsWasm(js, url, context, meta, isModule);
}

/**
 * Where each line of the rewritten script starts, delta-encoded.
 *
 * This is what a stack frame's COLUMN needs to be corrected. The rewrite map
 * says what was replaced and by how much, but only in flat offsets, and V8
 * reports a frame as line:column -- so without knowing where the lines begin,
 * a column cannot be turned into an offset and the map cannot be applied to it.
 *
 * Deltas rather than absolute offsets: consecutive line starts differ by a line
 * length, which is two or three digits, where the absolutes grow to six. The
 * first entry is the first line's start, which is always 0, so it is the run of
 * line LENGTHS.
 *
 * Empty when the script is not all-ASCII, and that is a correctness guard
 * rather than an optimisation: the rewrite map counts BYTES and V8 counts
 * UTF-16 code units, and the two agree only below U+0080. Applying a byte map
 * to a UTF-16 column would trade a column that is merely shifted for one that
 * is wrong, so a script with any non-ASCII character keeps its uncorrected
 * columns instead.
 */
function lineStarts(js: string | Uint8Array): number[] {
	const out: number[] = [];
	const text = typeof js === "string" ? js : null;
	let prev = 0;
	for (let i = 0; i < js.length; i++) {
		// Bytes and UTF-16 code units index the same positions below U+0080,
		// which the ASCII bail-out guarantees -- so the two arms agree and the
		// caller does not have to decode first.
		const c = text !== null ? text.charCodeAt(i) : (js as Uint8Array)[i];
		if (c > 0x7f) return [];
		if (c === 10) {
			out.push(i + 1 - prev);
			prev = i + 1;
		}
	}

	return out;
}

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false,
	/**
	 * Where this script sits in the document, for an INLINE one.
	 *
	 * Mutated on the way out: the caller needs the scramtag to find this
	 * script again in the serialised document, and the rewriter is the only
	 * thing that knows it. Absent for an external script or a worker, which
	 * are their own resource and start at line 1 column 1.
	 */
	base?: InlineBase
): string | Uint8Array {
	try {
		const res = rewriteJsInner(js, url, context, meta, isModule);
		let newjs = res.js;

		if (flagEnabled("sourcemaps", context, meta.base)) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(Array_from(res.map), res.tag, lineStarts(newjs));
			} else {
				// TODO: how do we check instanceof here?
				if (typeof newjs !== "string") {
					newjs = TextDecoder_decode(newjs);
				}
				const sourcemapfn = preludeCall(
					context.config.globals.pushsourcemapfn,
					res.map,
					res.tag,
					lineStarts(newjs),
					base
				);
				if (base) {
					base.tag = res.tag;
					base.prelude = sourcemapfn.length;
				}

				// No newline after it, so the script keeps its LINE NUMBERS.
				//
				// A prepended `fn(...);\n` pushes every line of the script down
				// by one, and a line number is something a page reads: an error
				// thrown in a rewritten script reports a line that is one more
				// than the one the site served. Measured on rateyourmusic --
				// Cloudflare captures a stack at `turnstile.render` and puts it
				// in the payload it POSTs, and the frames read
				//
				//     oracle    at yo (.../api.js:2:20674)
				//     sandbox   at yo (.../api.js:3:25157)
				//
				// for a script CLOUDFLARE serves and therefore knows the offsets
				// of. The call ends in `;`, so it needs no separator; running it
				// into the first line costs that line's columns, which were
				// already wrong, and buys every other line's number, which was
				// right until this newline.
				//
				// The "use strict" placement inserts the same single newline and
				// so shifts the same way. `preludeBytes` rebuilds this string to
				// subtract it from the reported size and has to agree about the
				// newline, which is why it is gone from both.
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(newjs)) {
					newjs = newjs.replace(strictMode, `$&${sourcemapfn}`);
					// How far into the script the call ended up. The anchor has
					// to name where the SCRIPT starts, not where the call does,
					// and a hoisted `"use strict"` puts those in different
					// places -- the prologue has to stay first to keep working.
					if (base) base.offset = newjs.indexOf(sourcemapfn);
				} else {
					newjs = `${sourcemapfn}${newjs}`;
					if (base) base.offset = 0;
				}
			}
		}

		if (flagEnabled("rewriterLogs", context, meta.base)) {
			for (const error of res.errors) {
				dbg.error("oxc parse error", error);
			}
		}

		return newjs;
	} catch (err) {
		dbg.warn(
			"failed rewriting js for",
			url || "(unknown)",
			err.message,
			typeof js !== "string" ? TextDecoder_decode(js) : js
		);
		if (flagEnabled("allowInvalidJs", context, meta.base)) {
			return js;
		} else {
			throw err;
		}
	}
}
