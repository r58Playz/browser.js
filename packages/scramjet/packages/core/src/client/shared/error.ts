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
