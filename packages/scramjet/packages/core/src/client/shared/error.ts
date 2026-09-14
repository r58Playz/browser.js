import { unrewriteUrl } from "@rewriters/url";
import { ScramjetClient } from "@client/index";
import { SCRAMJET_SCRIPT_URL } from "@client/nativeerror";
import {
	Error_prototype_toString,
	Object_defineProperty,
	String,
	String_endsWith,
	String_split,
} from "@/shared/snapshot";

export const enabled = (client: ScramjetClient) =>
	client.flagEnabled("cleanErrors");

export default function (client: ScramjetClient, self: Self) {
	// v8 only. all we need to do is clean the scramjet urls from stack traces
	const isOwnScript = (url: string): boolean => {
		// the client bundle, identified by a frame from inside it rather than by
		// name, so this holds however the embedder chose to serve it
		if (url === SCRAMJET_SCRIPT_URL) return true;

		const masked = client.config.maskedfiles;
		if (!masked) return false;

		for (let i = 0; i < masked.length; i++) {
			if (String_endsWith(url, masked[i])) return true;
		}

		return false;
	};

	/**
	 * The column the SITE's script would have reported for a rewritten one.
	 *
	 * A frame is `url:line:column`, and under the proxy the column counts into
	 * the REWRITTEN text -- every expansion the rewriter made earlier on that
	 * line pushes it right. Measured on rateyourmusic, where Cloudflare's
	 * challenge captures a stack at `turnstile.render` and posts it: the oracle
	 * read `at yo (.../api.js:2:20674)` and the sandbox `:2:25157`, for a script
	 * Cloudflare serves and therefore knows the offsets of.
	 *
	 * The rewrite map already says what was replaced and by how much, but only
	 * in flat offsets; the line table says where each line begins, which is what
	 * turns a column into one. Both are in the rewriter's coordinates -- the
	 * script WITHOUT the prelude -- so line 1 has the prelude's bytes subtracted
	 * and no other line does, the prelude having no newline of its own.
	 *
	 * The LINE needs no correction: nothing the rewriter inserts contains a
	 * newline, which is also why the line table can be summed from deltas.
	 */
	const originalColumn = (
		url: string,
		line: number,
		column: number
	): number | null => {
		// Both spellings of the URL, the way `servedSize` looks them up.
		//
		// `registerRewrites` keys by `document.currentScript.src`, which reads
		// through the shim and so is the url the PAGE sees; a stack frame's
		// filename is the one the browser fetched, which is the proxy's. Only
		// trying the frame's own spelling found nothing, and a lookup that never
		// hits looks exactly like a script that was never rewritten.
		let visible = url;
		try {
			visible = unrewriteUrl(url, client.context);
		} catch {
			// not one of ours; the frame's own spelling is all there is
		}
		const rewrites = (client.box.sourcemapSizes[url] ??
			client.box.sourcemapSizes[visible]) as
			| {
					type: number;
					start: number;
					end?: number;
					size?: number;
					oldLen?: number;
			  }[]
			| undefined;
		const starts =
			client.box.sourcemapLines[url] ?? client.box.sourcemapLines[visible];
		const prelude =
			client.box.sourcemapPrelude[url] ?? client.box.sourcemapPrelude[visible];
		// No table means the rewriter declined to measure this script -- it was
		// not all-ASCII, and a byte map must not be applied to a UTF-16 column.
		if (!rewrites || !starts || prelude === undefined) return null;

		const lineStart = line <= 1 ? 0 : starts[line - 2];
		if (typeof lineStart !== "number") return null;
		const offset = line <= 1 ? column - 1 - prelude : lineStart + column - 1;
		if (offset < 0) return null;

		const back = (at: number): number => {
			let delta = 0;
			for (let i = 0; i < rewrites.length; i++) {
				const r = rewrites[i];
				const end = r.end !== undefined ? r.end : r.start + (r.size ?? 0);
				// Ordered by position, so the first rewrite reaching past the
				// point being mapped ends it -- and a point INSIDE a rewrite is
				// text the site never had, so it maps to where the rewrite began.
				if (end > at) break;
				delta +=
					r.oldLen !== undefined ? end - r.start - r.oldLen : (r.size ?? 0);
			}

			return at - delta;
		};

		return back(offset) - back(lineStart) + 1;
	};

	const closure = (error: any, frames: any[]) => {
		// V8 calls this *to produce* `error.stack`, so reading `error.stack` here
		// is re-entrant - it comes back already formatted by the default
		// formatter, which is how this used to work and why the CallSite list was
		// only ever mined for filenames. Build the string the way the default
		// formatter does instead: `Error.prototype.toString` for the header,
		// which is what V8 uses for a DOMException as much as for an Error, then
		// one "\n    at <frame>" per surviving frame.
		let stack: string = Error_prototype_toString.call(error);

		for (let i = 0; i < frames.length; i++) {
			let url: string | null = null;
			try {
				url = frames[i].getFileName();
			} catch {
				// a frame with no file - eval, or native code - is kept as-is
			}

			// strip stack frames including scramjet handlers from the trace
			if (url && isOwnScript(url)) continue;

			let frame = String(frames[i]);
			if (url) {
				try {
					// splitting on the url rather than replaceAll, which a page can
					// replace on String.prototype
					frame = String_split(frame, url).join(
						unrewriteUrl(url, client.context)
					);
				} catch {
					// not one of ours; leave the frame alone
				}
				try {
					const line = frames[i].getLineNumber();
					const column = frames[i].getColumnNumber();
					if (typeof line === "number" && typeof column === "number") {
						const fixed = originalColumn(url, line, column);
						if (fixed !== null && fixed > 0 && fixed !== column) {
							frame = String_split(frame, `:${line}:${column}`).join(
								`:${line}:${fixed}`
							);
						}
					}
				} catch {
					// a frame that will not say where it is keeps its numbers
				}
			}

			stack += "\n    at " + frame;
		}

		return stack;
	};

	// `Error.prototype.stack` is not where the stack lives. Measured against
	// unmodified Chromium: `Object.getOwnPropertyDescriptor(Error.prototype,
	// "stack")` is ABSENT, and the descriptor is an own accessor on each error
	// INSTANCE -- so there is nothing to trap ahead of time. `prepareStackTrace`
	// is the only general hook V8 offers.
	//
	// It does not exist until something sets it, and `resolveNative` refuses to
	// invent a member the engine does not have, so `Trap` silently skipped it
	// and this module has been dead code -- every frame handing the page its
	// proxy URL. Defining the property directly is the fix, and it is a
	// deliberate trade: `typeof Error.prepareStackTrace` becomes "function"
	// where stock V8 says "undefined". A boolean tell for a leak that names the
	// proxy AND the real URL in every frame of every stack an anti-bot script
	// reads. `sbxdiff/pages/fp.html` records both so the trade stays visible.
	Object_defineProperty(self.Error, "prepareStackTrace", {
		get() {
			// v8 quirk: the getter runs every time something is typed in console
			return closure;
		},
		set() {
			// a page setting its own is ignored; there is nothing useful to do
		},
		configurable: true,
	});
}
