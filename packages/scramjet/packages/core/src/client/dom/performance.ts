import { ScramjetClient } from "@client/index";
import { originalSize } from "@client/shared/sourcemaps";
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
	 * The size the SITE served, recovered from the rewriter's own sourcemap.
	 *
	 * A rewritten script is bigger than the original, and
	 * `PerformanceResourceTiming` reports what the browser received -- so the
	 * page sees the proxy's size, not the site's. The rewriter already records
	 * every insert and replacement it made, so the original is arithmetic
	 * rather than bookkeeping: no side channel, and nothing to remember.
	 *
	 * Looked up under BOTH spellings, because the two ends disagree about which
	 * they hold. An entry's `name` is the PROXIED url; the map is keyed by
	 * `script.src`, which scramjet unrewrites, so it is the REAL one. Keying on
	 * either alone matches nothing, and a lookup that never hits looks exactly
	 * like a resource that was never rewritten.
	 *
	 * Falls back to the reported size when there is no map -- a module script,
	 * a worker, or a resource that was never rewritten at all.
	 */
	const servedSize = (name: unknown, reported: number): number => {
		if (typeof name !== "string" || reported <= 0) return reported;
		const rewrites =
			client.box.sourcemapSizes[name] ??
			client.box.sourcemapSizes[visibleName(name)];

		if (!rewrites) return reported;
		const prelude =
			client.box.sourcemapPrelude[name] ??
			client.box.sourcemapPrelude[visibleName(name)] ??
			0;

		return originalSize(rewrites, reported, prelude);
	};

	/**
	 * The same correction for the fields that describe HOW a resource arrived.
	 *
	 * It has to happen here and not only in the getters, for the reason the
	 * comment above gives about `name`: `toJSON` builds from the entry's
	 * internal fields, so overriding a getter does not change what it emits.
	 * Measured -- Cloudflare reads neither `deliveryType` nor `transferSize`
	 * directly in a whole rateyourmusic run; it serialises the entry and reads
	 * both out of the object.
	 */
	/**
	 * The document's own entry, whose size has no sourcemap to undo.
	 *
	 * A script's rewrites are recoverable from the map it carries; a document
	 * carries none, and has no `currentScript` for one to be keyed by. So the
	 * size the site served travels with the injected payload instead
	 * (`HtmlContext.sourceLength`) and lands here.
	 *
	 * Measured on rateyourmusic: Cloudflare's Turnstile widget read
	 * `decodedBodySize` 968058 for its own frame, which the site served as
	 * 256046. Most of that difference is scramjet's own injected bundle.
	 *
	 * 0 means unknown -- a document scramjet minted rather than fetched -- and
	 * then the browser's number stands rather than a guess.
	 */
	const documentSize = (reported: number): number =>
		client.sourceLength > 0 ? client.sourceLength : reported;

	/**
	 * The served size of whatever entry this is: a document's carried length,
	 * or a subresource's, from its sourcemap.
	 */
	const sizeFor = (entry: PerformanceEntry, reported: number): number =>
		client.box.instanceof(entry, "PerformanceNavigationTiming")
			? documentSize(reported)
			: servedSize(nativeName(entry), reported);

	const withProxyCorrections = <T>(json: T, entry?: PerformanceEntry): T => {
		const o = json as { deliveryType?: unknown; transferSize?: unknown };
		const sizes = json as {
			name?: unknown;
			encodedBodySize?: unknown;
			decodedBodySize?: unknown;
		};
		// The entry, when the caller has it, because a document's size is not
		// recoverable from its name -- `sizeFor` needs to know which kind of
		// entry this is.
		const size = (reported: number): number =>
			entry ? sizeFor(entry, reported) : servedSize(sizes.name, reported);
		// Sizes first: transferSize is derived from the encoded body, so it has
		// to be corrected after that one and not before.
		if (typeof sizes.encodedBodySize === "number") {
			sizes.encodedBodySize = size(sizes.encodedBodySize);
		}
		if (typeof sizes.decodedBodySize === "number") {
			sizes.decodedBodySize = size(sizes.decodedBodySize);
		}
		// "" is what a network fetch reports. The resource DID come over the
		// network upstream; "cache" describes the service worker that relayed
		// it, which is the proxy talking about itself.
		if (typeof o.deliveryType === "string") o.deliveryType = "";
		// A service-worker response reports 0, which says "a proxy served me"
		// on its own. The spec's value is the encoded body plus 300 bytes of
		// headers, and the encoded body survives proxying.
		if (typeof o.transferSize === "number") {
			const encoded = sizes.encodedBodySize;
			o.transferSize =
				typeof encoded === "number" && encoded > 0 ? encoded + 300 : 0;
		}

		return withVisibleName(json);
	};

	/**
	 * Scramjet's own script files are hidden from resource timing.
	 *
	 * From *resource* timing only. The filter used to apply to every entry type,
	 * so a page that called `performance.mark("inject.js")` could never see its
	 * own mark - the name matched a masked filename and the entry vanished.
	 */
	const isMasked = (entry: PerformanceEntry): boolean => {
		if (client.box.instanceof(entry, "PerformanceLongAnimationFrameTiming")) {
			return isProxyFrame(entry);
		}
		if (!client.box.instanceof(entry, "PerformanceResourceTiming")) {
			return false;
		}

		return isProxyUrl(nativeName(entry));
	};

	/** Is this URL one the PROXY fetched for itself? */
	const isProxyUrl = (raw: string): boolean => {
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

	/**
	 * A long frame that was entirely the PROXY's doing.
	 *
	 * `long-animation-frame` entries exist when a frame took over 50ms, and the
	 * shim rewrites every script the page loads on this same thread -- so
	 * proxying manufactures long frames a direct load never has. Measured on
	 * rateyourmusic: the sandbox's Turnstile realm had one the oracle's did
	 * not, in a list Cloudflare walks and posts.
	 *
	 * Masked only when every script in the frame is the proxy's, and never when
	 * there are none to judge by. A frame the PAGE blocked is the page's, and
	 * hiding that would be its own divergence -- a site that deliberately
	 * blocks for 200ms and sees no entry has learned something too.
	 */
	const isProxyFrame = (entry: PerformanceEntry): boolean => {
		const scripts = (
			entry as PerformanceEntry & {
				scripts?: { sourceURL?: unknown }[];
			}
		).scripts;
		if (!scripts || !scripts.length) return false;
		for (let i = 0; i < scripts.length; i++) {
			const src = scripts[i]?.sourceURL;
			if (typeof src !== "string" || !src) return false;
			if (!isProxyUrl(src)) return false;
		}

		return true;
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
	/**
	 * Fields that describe HOW a resource arrived, which a proxy changes by
	 * existing -- and which it has to answer for itself, because a page does
	 * not care that a service worker was involved and an anti-bot very much
	 * does.
	 *
	 * Both of these are what the browser reports for a service-worker response
	 * rather than anything about the resource. Measured inside a payload
	 * Cloudflare posts from rateyourmusic:
	 *
	 *     deliveryType   ""     direct   vs  "cache"  proxied
	 *     transferSize   86903  direct   vs  0        proxied
	 *
	 * Fixed HERE rather than in the oracle's browser, because the sandbox has
	 * to hold up on an unmodified Chromium: a patch in the harness closes the
	 * gap only in the harness (RULES.md #128).
	 */
	client.Intercept(class extends PerformanceResourceTiming {
		@Arguments()
		@Returns("object")
		toJSON(): object {
			return withProxyCorrections(super.toJSON(), this);
		}

		@Returns("DOMString")
		get deliveryType(): string {
			// "" is what a network fetch reports. A proxied resource DID come
			// over the network -- upstream, before the worker handed it on --
			// so "cache" describes the proxy, not the resource.
			return "";
		}

		@Returns("unsigned long long")
		get transferSize(): number {
			// A service-worker response reports 0, which says "a worker
			// answered this" on its own. The spec's value for a resource whose
			// timing is visible is its encoded body plus 300 bytes of headers,
			// and the encoded body is the one number here that survives
			// proxying.
			const encoded = sizeFor(this, super.encodedBodySize);

			return encoded > 0 ? encoded + 300 : 0;
		}

		// The sizes, as getters as well as in `toJSON`.
		//
		// `toJSON` alone was not enough: Cloudflare's page-level payload
		// serialises the entry, but its Turnstile widget reads the getters, and
		// a correction that only covered the first left the widget reading
		// `decodedBodySize` 968058 for a document the site served as 256046.
		// Both paths, because a page picks whichever it likes.
		//
		// Here rather than on `PerformanceNavigationTiming`, even for a
		// document: these members are OWNED by this prototype and merely
		// inherited by that one, and intercepting a member a prototype does not
		// own installs nothing at all. Measured with `pages/ressize.html` --
		// the navigation entry's `toJSON` was corrected (that one it does own)
		// while its getters still read 9819 against the oracle's 2505.
		@Returns("unsigned long long")
		get encodedBodySize(): number {
			return sizeFor(this, super.encodedBodySize);
		}

		@Returns("unsigned long long")
		get decodedBodySize(): number {
			return sizeFor(this, super.decodedBodySize);
		}
	});

	// A navigation entry owns its own `toJSON` and inherits everything else,
	// so this is the only member worth intercepting here -- the sizes are
	// corrected on `PerformanceResourceTiming`, which owns them.
	client.Intercept(class extends PerformanceNavigationTiming {
		@Arguments()
		@Returns("object")
		toJSON(): object {
			return withProxyCorrections(super.toJSON(), this);
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
