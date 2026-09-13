import { ScramjetClient } from "@client/index";
import { SCRAMJET_SCRIPT_URL } from "@client/nativeerror";
import {
	_URL,
	String,
	String_endsWith,
	String_startsWith,
} from "@/shared/snapshot";
import { Arguments, Returns, Type } from "@client/webidl";

export default function (client: ScramjetClient) {
	const visibleName = (name: string): string =>
		String_startsWith(name, client.context.prefix.href)
			? client.unrewriteUrl(name)
			: name;

	const nativeName = (entry: PerformanceEntry): string =>
		String(new client.native.PerformanceEntry(entry).name);

	/**
	 * `toJSON` builds its object from the entry's internal fields rather than
	 * from the `name` getter, so the URL in it is the rewritten one and has to
	 * be corrected separately.
	 */
	const withVisibleName = <T>(json: T): T => {
		const named = json as { name?: unknown };
		if (typeof named.name === "string") named.name = visibleName(named.name);

		return json;
	};

	/**
	 * Scramjet's own script files are hidden from resource timing.
	 *
	 * From *resource* timing only. The filter used to apply to every entry type,
	 * so a page that called `performance.mark("inject.js")` could never see its
	 * own mark - the name matched a masked filename and the entry vanished.
	 */
	const isMasked = (entry: PerformanceEntry): boolean => {
		if (!client.box.instanceof(entry, "PerformanceResourceTiming")) {
			return false;
		}

		const raw = nativeName(entry);

		// The client bundle, identified by a frame from inside it rather than by
		// name, so this holds however the embedder chose to serve it -- the same
		// way `shared/error.ts` keeps it out of stack traces.
		//
		// `maskedfiles` alone was not enough, because it DEFAULTS TO EMPTY. With
		// the default config this whole filter masked nothing at all, and
		// `performance.getEntriesByType("resource")[0].name` handed the page
		// "http://localhost:4500/scramjet/scramjet.js" -- the proxy's origin and
		// the shim's filename, as the first entry in the list, readable by any
		// page that asks. `toJSON` gave the same. Covered by
		// `sbxdiff/pages/perf.html`.
		if (raw === SCRAMJET_SCRIPT_URL) return true;

		// Everything else the proxy loads for itself.
		//
		// The bundle is not alone in the list: the controller's inject script,
		// the wasm shim and the `data:` stubs are all fetched from the proxy's
		// own origin, and a page reading resource timing sees every one of
		// them. That is a leak by name, and it is also a SIZE divergence --
		// measured on rateyourmusic, Cloudflare's Turnstile walks the entry
		// list and records nine fields per entry including the URL, and the
		// sandbox's widget had some fifteen entries the oracle's did not.
		//
		// Two shapes, both meaning "this is the proxy, not the page":
		//
		//   - on the proxy's origin but OUTSIDE the prefix. Nothing the guest
		//     asks for lands there; the prefix is what makes a URL the guest's.
		//   - inside the prefix but standing for something scramjet minted
		//     rather than an upstream URL, which is exactly the case where
		//     unrewriting does not give back an absolute URL.
		try {
			const url = new _URL(raw);
			if (
				url.origin === client.context.prefix.origin &&
				!String_startsWith(url.pathname, client.context.prefix.pathname)
			) {
				return true;
			}
		} catch {
			// not a parseable URL, so not one of the proxy's fetches
		}
		if (String_startsWith(raw, client.context.prefix.href)) {
			let target: URL | null = null;
			try {
				target = new _URL(client.unrewriteUrl(raw));
			} catch {
				// unrewriting did not give back a URL, so the entry stands for
				// something scramjet minted rather than anything the guest asked
				// for -- `scramjet.wasm.js` and friends
				return true;
			}

			// An entry the proxy INVENTED.
			//
			// A browser does not make a network fetch for a `blob:` or `data:`
			// subresource, so there is no resource entry for one. Proxying turns
			// both into an HTTP fetch through the worker, which manufactures an
			// entry the page would never otherwise see. Measured on
			// rateyourmusic: the oracle's Turnstile frame had three resource
			// entries and the sandbox's had seven, the extra four being two blob
			// worker scripts, a `data:` stub and the wasm -- and Cloudflare walks
			// that list recording nine fields per entry, so it is a size
			// divergence in the payload as well as a leak.
			if (target.protocol === "blob:" || target.protocol === "data:") {
				return true;
			}
		}

		const name = visibleName(raw);
		const masked = client.config.maskedfiles;
		for (let i = 0; i < masked.length; i++) {
			if (String_endsWith(name, masked[i])) return true;
		}

		return false;
	};

	const visible = (entries: PerformanceEntry[]): PerformanceEntry[] => {
		const out: PerformanceEntry[] = [];
		for (let i = 0; i < entries.length; i++) {
			if (!isMasked(entries[i])) out[out.length] = entries[i];
		}

		return out;
	};

	/**
	 * Entries are keyed by the *rewritten* URL, so a real URL from the page
	 * never matched and this returned nothing. Filtering on the name the page
	 * would see is exact for both a URL and a user mark - rewriting the
	 * argument instead would be wrong for the latter.
	 */
	const byName = (
		candidates: PerformanceEntry[],
		name: string
	): PerformanceEntry[] => {
		const out: PerformanceEntry[] = [];
		for (let i = 0; i < candidates.length; i++) {
			const entry = candidates[i];
			if (isMasked(entry)) continue;
			if (visibleName(nativeName(entry)) === name) out[out.length] = entry;
		}

		return out;
	};

	// https://w3c.github.io/performance-timeline/#the-performanceentry-interface
	client.Intercept(class extends PerformanceEntry {
		@Type("DOMString")
		get name(): string {
			return visibleName(String(super.name));
		}

		@Arguments()
		@Returns("object")
		toJSON(): object {
			return withVisibleName(super.toJSON());
		}
	});

	// both override PerformanceEntry's toJSON with their own, so patching the
	// base is not enough
	client.Intercept(class extends PerformanceResourceTiming {
		@Arguments()
		@Returns("object")
		toJSON(): object {
			return withVisibleName(super.toJSON());
		}
	});

	client.Intercept(class extends PerformanceNavigationTiming {
		@Arguments()
		@Returns("object")
		toJSON(): object {
			return withVisibleName(super.toJSON());
		}
	});

	// https://w3c.github.io/performance-timeline/#extensions-to-the-performance-interface
	client.Intercept(class extends Performance {
		@Arguments()
		@Returns("sequence<PerformanceEntry>")
		getEntries(): PerformanceEntry[] {
			return visible(super.getEntries());
		}

		@Arguments("DOMString")
		@Returns("sequence<PerformanceEntry>")
		getEntriesByType(type: string): PerformanceEntry[] {
			return visible(super.getEntriesByType(type));
		}

		@Arguments("DOMString", "optional DOMString?")
		@Returns("sequence<PerformanceEntry>")
		getEntriesByName(name: string, type?: string | null): PerformanceEntry[] {
			return byName(
				type === undefined || type === null
					? super.getEntries()
					: super.getEntriesByType(type),
				name
			);
		}
	});

	client.Intercept(class extends PerformanceObserverEntryList {
		@Arguments()
		@Returns("sequence<PerformanceEntry>")
		getEntries(): PerformanceEntry[] {
			return visible(super.getEntries());
		}

		@Arguments("DOMString")
		@Returns("sequence<PerformanceEntry>")
		getEntriesByType(type: string): PerformanceEntry[] {
			return visible(super.getEntriesByType(type));
		}

		@Arguments("DOMString", "optional DOMString")
		@Returns("sequence<PerformanceEntry>")
		getEntriesByName(name: string, type?: string): PerformanceEntry[] {
			return byName(
				type === undefined ? super.getEntries() : super.getEntriesByType(type),
				name
			);
		}
	});
}
