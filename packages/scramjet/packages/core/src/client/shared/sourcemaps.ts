import {
	Object_defineProperty,
	Number_isSafeInteger,
	Error,
} from "@/shared/snapshot";
import { SCRAMJETCLIENT, SCRAMJETCLIENTNAME } from "@/symbols";
import { INSERT, REPLACE, preludeBytes } from "@/shared/sourcemapsize";
import { ProxyCtx, ScramjetClient } from "@client/index";

// The wire format's two kinds, shared with the size arithmetic so a `Rewrite`
// is assignable to a `SizedRewrite` instead of being a parallel enum that
// happens to agree.
const RewriteType = { Insert: INSERT, Replace: REPLACE } as const;

type Rewrite = {
	start: number;
} & (
	| {
			type: typeof INSERT;
			size: number;
	  }
	| {
			type: typeof REPLACE;
			end: number;
			str: string;
			/**
			 * `str`'s length in BYTES, which the wire format sends and the
			 * parser used to discard.
			 *
			 * `str.length` counts UTF-16 code units, and a resource's size is
			 * bytes. For an ASCII rewrite they agree and for anything else they
			 * do not, so a size computed from `.length` is right until the page
			 * has a non-ASCII identifier in it.
			 */
			oldLen: number;
	  }
);

export type SourceMaps = Record<string, Rewrite[]>;

/**
 * How big the script was BEFORE rewriting, given its rewrites and its size now.
 *
 * Every `Insert` added `size` bytes; every `Replace` swapped `oldLen` bytes for
 * `end - start`. Summing the deltas recovers the original exactly -- the
 * rewriter already says what it did, so a proxy does not have to remember the
 * size separately or ship it over a side channel.
 *
 * Why it matters: `PerformanceResourceTiming` reports the size the browser
 * actually received, which for a rewritten script is the proxy's size, not the
 * site's. Measured in a payload Cloudflare posts from rateyourmusic, 113793
 * against the real 86603.
 *
 * The arithmetic itself lives in `@/shared/sourcemapsize`, which this file
 * re-exports so the consumers keep one import.
 */
export { originalSize, preludeBytes } from "@/shared/sourcemapsize";

function getEnd(rewrite: Rewrite): number {
	if (rewrite.type === RewriteType.Insert) {
		return rewrite.start + rewrite.size;
	} else if (rewrite.type === RewriteType.Replace) {
		return rewrite.end;
	}
	throw "unreachable";
}

function registerRewrites(
	client: ScramjetClient,
	buf: Array<number>,
	tag: string
) {
	const sourcemap = Uint8Array.from(buf);
	const view = new DataView(sourcemap.buffer);
	const decoder = new TextDecoder("utf-8");

	const rewrites: Rewrite[] = [];

	const rewritelen = view.getUint32(0, true);
	let cursor = 4;
	for (let i = 0; i < rewritelen; i++) {
		const start = view.getUint32(cursor, true);
		cursor += 4;
		const size = view.getUint32(cursor, true);
		cursor += 4;

		const type = view.getUint8(cursor) as typeof INSERT | typeof REPLACE;
		cursor += 1;

		if (type == RewriteType.Insert) {
			rewrites.push({ type, start, size });
		} else if (type == RewriteType.Replace) {
			const end = start + size;

			const oldLen = view.getUint32(cursor, true);
			cursor += 4;

			const oldStr = decoder.decode(
				sourcemap.subarray(cursor, cursor + oldLen)
			);

			rewrites.push({ type, start, end, str: oldStr, oldLen });
			cursor += oldLen;
		}
	}

	client.box.sourcemaps[tag] = rewrites;

	// And which resource it came from.
	//
	// The push is emitted INLINE at the top of the rewritten script, so while
	// it runs `document.currentScript` is that script's own element and its
	// `src` is the URL `PerformanceResourceTiming` will report. Nothing else
	// links a scramtag to a URL, and this costs one property read.
	//
	// Null for a module or a worker, which have no `currentScript`; those keep
	// the proxy's size, which is the behaviour without this.
	try {
		const el = client.global.document
			?.currentScript as HTMLScriptElement | null;
		const src = el && el.src;
		// First push wins. A script's own map is pushed by the prelude at its
		// very top, before anything in it can run -- so any later push while
		// the same element is `currentScript` is an `eval` INSIDE that script,
		// whose rewrites are not part of the resource's size.
		if (src && !(src in client.box.sourcemapSizes)) {
			client.box.sourcemapSizes[src] = rewrites;
			// The prelude is NOT in the map it carries.
			//
			// `js.ts` computes the map, then prepends
			// `pushsourcemapfn([<map>], "<tag>");\n` to the source -- so those
			// bytes are in the script and in no rewrite. On a 113793-byte
			// script the map accounted for 11800 bytes and left 15390
			// unexplained, which is this string.
			//
			// Rebuilt exactly rather than estimated: the client has the buffer,
			// the tag and the function name, which is everything the rewriter
			// used to build it.
			client.box.sourcemapPrelude[src] = preludeBytes(
				client.config.globals.pushsourcemapfn,
				buf,
				tag
			);
		}
	} catch {
		// A realm without a document. Nothing to key by.
	}
}

const SCRAMTAG = "/*scramtag ";

function extractTag(fn: string): [string, number, number] | null {
	// every function rewritten will have a scramtag comment
	// it will look like this:
	// function name()[possible whitespace]/*scramtag [index] [tag]*/[possible whitespace]{ ... }

	const start = fn.indexOf(SCRAMTAG);
	// no scramtag, probably native function or stolen from scramjet
	if (start === -1) return null;

	const end = fn.indexOf("*/", start);
	if (end === -1) {
		dbg.error("unreachable", fn, start, end);
		throw new Error("unreachable");
	}

	const tag = fn.substring(start + 2, end).split(" ");

	if (
		tag.length !== 3 ||
		tag[0] !== "scramtag" ||
		!Number_isSafeInteger(+tag[1])
	) {
		dbg.error("invalid tag", fn, start, end, tag);
		throw new Error("invalid tag");
	}

	return [tag[2], start, +tag[1]];
}

function doUnrewrite(
	client: ScramjetClient,
	ctx: ProxyCtx<"Function.prototype.toString", "apply">
) {
	const stringified: string = ctx.fn.call(ctx.this);

	const extracted = extractTag(stringified);
	if (!extracted) return ctx.return(stringified);
	const [tag, tagOffset, tagStart] = extracted;

	const fnStart = tagStart - tagOffset;
	const fnEnd = fnStart + stringified.length;
	const rewrites = client.box.sourcemaps[tag];

	if (!rewrites) {
		dbg.warn("failed to get rewrites for tag", tag);

		return ctx.return(stringified);
	}

	let i = 0;
	// skip all rewrites in the file before the fn
	while (i < rewrites.length) {
		if (rewrites[i].start < fnStart) i++;
		else break;
	}

	let end = i;
	while (end < rewrites.length) {
		// `<=`: `fnEnd` is exclusive, so a rewrite whose inserted text ends
		// exactly at the function's last character is INSIDE it. Excluding it
		// left the insert in place -- an arrow function wrapped as
		// `$scramjet$wrap((x) => x * 2)` un-rewrote to `(x) => x * 2)`, with the
		// opening paren removed and the closing one still there, because only
		// the trailing insert landed on the boundary.
		if (getEnd(rewrites[end]) <= fnEnd) end++;
		else break;
	}
	const fnrewrites = rewrites.slice(i, end);

	let newString = "";
	let lastpos = 0;

	for (const rewrite of fnrewrites) {
		newString += stringified.slice(lastpos, rewrite.start - fnStart);

		if (rewrite.type === RewriteType.Insert) {
			lastpos = rewrite.start + rewrite.size - fnStart;
		} else if (rewrite.type === RewriteType.Replace) {
			newString += rewrite.str;
			lastpos = rewrite.end - fnStart;
		} else {
			throw "unreachable";
		}
	}

	newString += stringified.slice(lastpos);
	newString = newString.replace(`${SCRAMTAG}${tagStart} ${tag}*/`, "");

	return ctx.return(newString);
}

export const enabled = (client: ScramjetClient) =>
	client.flagEnabled("sourcemaps");

export default function (client: ScramjetClient, self: Self) {
	// every script will push a sourcemap
	Object_defineProperty(self, client.config.globals.pushsourcemapfn, {
		value: (buf: Array<number>, tag: string) => {
			// const before = performance.now();
			registerRewrites(client, buf, tag);
			// if (client.flagEnabled("rewriterLogs")) {
			// 	dbg.time(client.meta, before, `scramtag parse for ${tag}`);
			// }
		},
		enumerable: false,
		writable: false,
		configurable: false,
	});

	// when we rewrite javascript it will make function.toString leak internals
	// this can lead to double rewrites which is bad
	client.Proxy("Function.prototype.toString", {
		apply(ctx) {
			if (client.box.unproxy.has(ctx.this)) {
				// toString is being called on a proxy of a native function
				// `this` will then be the proxy, which has the wrong [[SourceText]]
				// unproxy so it passes through
				ctx.this = client.box.unproxy.get(ctx.this)!;
				// since we know it's a native function, no need to unrewrite
				return;
			}
			// const before = performance.now();
			doUnrewrite(client, ctx);
			// dbg.time(client.meta, before, `scramtag unrewrite for ${ctx.fn.name}`);
		},
	});
}
