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
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, meta.base);
	}

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

		return {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
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
