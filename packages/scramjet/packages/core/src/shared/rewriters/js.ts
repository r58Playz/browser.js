import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
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
	// Deeper stacks for the rewriter's own failures, for the duration of ONE
	// rewrite.
	//
	// This used to be a module-level `Error.stackTraceLimit = 50`, which runs
	// once in every realm the client loads into and never comes back. V8's
	// default is 10, so two things leaked: `Error.stackTraceLimit` is a plain
	// property any page can read and it read 50, and every stack the guest
	// captured afterwards was as much as five times deeper. Measured inside
	// Cloudflare's payload on rateyourmusic -- the challenge collects stack
	// traces, and the same error serialised ten frames in a browser against
	// twenty-one under the proxy, 1479 bytes more of plaintext.
	//
	// A rewrite is synchronous and nothing of the guest's runs during one, so
	// raising it here is not observable. Restored to what was read rather than
	// to a constant, so a page that set its own limit keeps it.
	// eslint-disable-next-line scramjet-core/no-globals
	const guestStackLimit = Error.stackTraceLimit;
	// eslint-disable-next-line scramjet-core/no-globals
	Error.stackTraceLimit = 50;
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

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
): string | Uint8Array {
	try {
		const res = rewriteJsInner(js, url, context, meta, isModule);
		let newjs = res.js;

		if (flagEnabled("sourcemaps", context, meta.base)) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(Array_from(res.map), res.tag);
			} else {
				// TODO: how do we check instanceof here?
				if (typeof newjs !== "string") {
					newjs = TextDecoder_decode(newjs);
				}
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}([${res.map.join(",")}], "${res.tag}");`;

				// don't put the sourcemap call before "use strict"
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(newjs)) {
					newjs = newjs.replace(strictMode, `$&\n${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}\n${newjs}`;
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
