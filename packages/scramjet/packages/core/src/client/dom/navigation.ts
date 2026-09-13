import { ScramjetClient } from "@client/index";
import { Tap } from "@/Tap";
import { Arguments, Returns, Type } from "@client/webidl";
import { unrewriteUrl } from "@rewriters/url";
import { _URL } from "@/shared/snapshot";

/**
 * The Navigation API, which used to be deleted outright.
 *
 * Deleting it cost a name in `Object.keys(window)` -- Cloudflare's challenge
 * enumerates the global and puts the list in its payload, so the guest's window
 * being one name short of a real Chrome's is a thing a site reads (RULES.md
 * #145, #147). The six interface objects beside it came back first because they
 * are inert; this is the entry point, and it needed an actual shim.
 *
 * The surface is smaller than the interface looks. Of everything on
 * `Navigation`, exactly one method takes a URL -- `navigate()` -- and exactly
 * two properties report one: an entry's `url` and a destination's. `reload`,
 * `traverseTo`, `back`, `forward` and `updateCurrentEntry` address history by
 * key or offset and never see a URL at all, so they are left alone.
 *
 * `navigate()` is the reason the API was a problem: a guest calling it with a
 * site URL would navigate the frame straight off the proxy. Rewritten, it is
 * the same navigation `location.href =` performs and the service worker
 * intercepts it the same way.
 */
export const enabled = (_client: ScramjetClient, self: Self) =>
	"Navigation" in self;

export default function (client: ScramjetClient, _self: Self) {
	/**
	 * `USVString?` -- an entry for a document the API will not expose a URL for
	 * reports null, and unrewriting null would invent the proxy's own URL.
	 */
	const siteUrl = (url: string | null): string | null =>
		url === null ? null : unrewriteUrl(url, client.context);

	/** A URL with no fragment, for deciding whether one is all that changed. */
	const document = (url: URL): string => {
		const bare = new _URL(url.href);
		bare.hash = "";

		return bare.href;
	};

	/**
	 * What to hand the native `navigate()`.
	 *
	 * A fragment navigation has to stay one. The rewriter puts the site's URL
	 * in the PATH, so rewriting `#x` in full produces a URL that differs from
	 * the document's in more than its fragment -- the query carries referrer
	 * policy and sec-fetch state that the current document URL does not have --
	 * and the browser reads that as a different document. It commits as a load
	 * rather than a fragment navigation: `destination.sameDocument` came back
	 * false against the oracle's true, and `finished` never resolved.
	 *
	 * The rewritten URL's own fragment is the correctly encoded one, so a
	 * same-document navigation hands over just that and lets it resolve against
	 * the document. `dom/location.ts` does the same thing for `location.hash`.
	 */
	const target = (resolved: URL): string => {
		const rewritten = new _URL(client.rewriteUrl(resolved.href));
		if (document(resolved) !== document(client.url)) return rewritten.href;

		// "" is a real fragment navigation -- to the top of the document --
		// and an empty string here would be "navigate to the current URL".
		return rewritten.hash || "#";
	};

	client.Intercept(class extends Navigation {
		@Arguments("USVString", "optional NavigationNavigateOptions = {}")
		@Returns("NavigationResult")
		navigate(url: string, options?: NavigationNavigateOptions) {
			// Resolved against the SITE's URL before rewriting, the same order
			// `history.pushState` uses: a relative URL resolved against the
			// proxy's document URL is a different URL.
			const resolved = new _URL(url, client.url.href);
			const result = super.navigate(target(resolved), options);
			Tap.dispatch(
				client.hooks.lifecycle.navigate,
				{ type: "navigation" },
				{ url: resolved.href }
			);

			return result;
		}
	});

	client.Intercept(class extends NavigationHistoryEntry {
		@Type("USVString?")
		get url(): string | null {
			return siteUrl(super.url);
		}
	});

	client.Intercept(class extends NavigationDestination {
		@Type("USVString")
		get url(): string {
			return siteUrl(super.url)!;
		}
	});
}
