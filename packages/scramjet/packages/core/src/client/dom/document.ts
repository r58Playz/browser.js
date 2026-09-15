import { IncrementalHtmlRewriter, rewriteHtml } from "@rewriters/html";
import { ScramjetClient } from "@client/index";
import { SCRAMJETCLIENT } from "@/symbols";
import {
	Array_join,
	String,
	String_endsWith,
	String_startsWith,
	String_toLowerCase,
	_URL,
} from "@/shared/snapshot";
import { createReferrerString } from "@/fetch/util";
import { unrewriteUrl } from "@rewriters/url";
import { openWindowSteps } from "@client/helpers";
import { Arguments, Returns, Type } from "@client/webidl";

export default function (client: ScramjetClient, self: Self) {
	const nativeGlobal = new client.native.window(self);

	function resetDocumentWriter(document: Document) {
		client.box.writeRewriters.delete(document);
	}

	function getDocumentWriter(document: Document) {
		let writer = client.box.writeRewriters.get(document);
		if (!writer) {
			writer = new IncrementalHtmlRewriter(client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "Document.prototype.write",
			});
			client.box.writeRewriters.set(document, writer);
		}

		return writer;
	}

	// https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html
	client.Intercept(class extends Document {
		@Arguments("optional USVString", "optional DOMString", "optional DOMString")
		@Returns("Document")
		open(...args: any[]): any {
			// a 3 argument document.open is not the same thing as document.open at all, it instead dispatches to the open window steps
			if (args.length >= 3) {
				// the steps below never touch the receiver, so brand check now
				void super.URL;

				return openWindowSteps(
					client,
					nativeGlobal.open,
					args[0],
					args[1],
					args[2]
				) as unknown as Document;
			}

			resetDocumentWriter(this);

			return super.open(args[0], args[1]);
		}

		@Arguments("(TrustedHTML or DOMString)...")
		@Returns("undefined")
		write(...text: string[]): void {
			super.write(getDocumentWriter(this).write(Array_join(text, "")));
		}

		@Arguments("(TrustedHTML or DOMString)...")
		@Returns("undefined")
		writeln(...text: string[]): void {
			super.write(getDocumentWriter(this).write(Array_join(text, "") + "\n"));
		}

		@Arguments()
		@Returns("undefined")
		close(): void {
			const writer = client.box.writeRewriters.get(this);

			if (!writer) return super.close();

			try {
				const remaining = writer.end();
				if (remaining) super.write(remaining);
			} finally {
				resetDocumentWriter(this);
			}

			return super.close();
		}

		@Arguments("(TrustedHTML or DOMString)")
		@Returns("Document")
		static parseHTMLUnsafe(html: string): Document {
			return super.parseHTMLUnsafe(
				rewriteHtml(String(html), client.context, client.meta, {
					loadScripts: false,
					inline: true,
					source: client.url.href,
					apisource: "Document.parseHTMLUnsafe",
				})
			);
		}
	});

	/**
	 * A document's URL as the site should see it. Only a URL that is actually
	 * the proxy's gets replaced - anything else the native reports (about:blank
	 * for a document with no browsing context) is already correct.
	 */
	const siteUrlFor = (url: string) =>
		String_startsWith(url, client.context.prefix.href) ? client.url.href : url;

	client.Intercept(class extends Document {
		@Type("USVString")
		get domain(): string {
			void super.domain;

			return client.scopeUrl.hostname;
		}

		@Type("USVString")
		set domain(value: string) {
			void super.domain;

			// https://html.spec.whatwg.org/multipage/browsers.html#relaxing-the-same-origin-restriction
			// step 6, checked against the site's host rather than the proxy's
			const host = String_toLowerCase(client.scopeUrl.hostname);
			const domain = String_toLowerCase(value);
			if (domain !== host && !String_endsWith(host, `.${domain}`)) {
				throw client.errors.domException("SecurityError", {
					set: "domain",
					on: "Document",
					detail: `'${value}' is not a suffix of '${client.scopeUrl.hostname}'.`,
				});
			}

			// a suffix match is accepted and then dropped on the floor.
			// actually relaxing the document's origin would relax the
			// *proxy's*, which is shared by every site being proxied - one
			// site could then reach into another's documents.
			// TODO: the check above is a plain suffix test, so it accepts a
			// public suffix ("com" for "example.com") that a browser rejects.
			// only observable in whether this throws, since nothing is
			// relaxed either way
		}

		@Type("USVString")
		get documentURI(): string {
			return siteUrlFor(super.documentURI);
		}

		@Type("USVString")
		get URL(): string {
			return siteUrlFor(super.URL);
		}

		@Type("USVString")
		get referrer(): string {
			// a document with no browsing context has no referrer, whatever the
			// live one's history says
			if (!super.defaultView) return "";

			// A document that never navigated reports its CREATOR's url -- and
			// when the creator never navigated either, that url is literally
			// "about:blank".
			//
			// `client.url` is the SCOPE url such a frame inherits so its fetches
			// resolve against the right site. It is not what the creating
			// document reports as its own url, and a referrer is the latter. The
			// parent branch at the bottom hands the scope url to
			// `createReferrerString`, and every branch before it answers "" for
			// a frame with no history of its own -- which is what this realm got.
			//
			// Measured in the realm Cloudflare's jsd census walks, a hidden
			// iframe opened from the about:blank frame jsd itself runs in:
			//
			//     oracle   d.referrer = "about:blank"
			//     sandbox  d.referrer = ""
			//
			// The census files properties by VALUE, so an empty one is dropped
			// from the payload altogether rather than reported as empty -- which
			// is why this read as a missing property rather than a wrong one.
			if (super.URL === "about:blank") {
				try {
					const creator = client.global.parent;
					if (creator && creator !== client.global) {
						const creatorUrl = creator.document.URL;
						if (creatorUrl === "about:blank") return creatorUrl;
					}
				} catch {
					// A parent that cannot be read is a cross-origin one, and
					// the platform reports no referrer for that either.
				}
			}

			// The browser supplies the referrer URL; scramjet applies the policy.
			//
			// Each half is wrong alone. `client.history` records document FETCHES,
			// so it cannot see a document whose URL the History API changed --
			// and Cloudflare's interstitial moves itself to
			// `/?__cf_chl_tk=<token>` before navigating, which is why the token
			// was being dropped (145 characters in a browser against 26 here).
			// The browser knows that URL, because it sent it as `Referer`.
			//
			// But the browser applied the policy to the PROXIED origins, where
			// everything is localhost:4500 and therefore same-origin. For the
			// Turnstile widget -- genuinely cross-origin to the page it is in --
			// that turns a `same-origin` policy's "" into the embedder's URL.
			// Measured: oracle "", sandbox "https://rateyourmusic.com/".
			//
			// So take the URL from the browser and judge it against the REAL
			// origins, which is what `createReferrerString` is for.
			const current = client.history?.[client.history.length - 1];
			if (current && current.referrer) {
				const real = (() => {
					try {
						return new _URL(unrewriteUrl(current.referrer, client.context));
					} catch {
						return null;
					}
				})();
				// A referrer that does not unrewrite to a guest url is the
				// harness's own, and handing that to the guest is a T0 -- the
				// gate caught exactly that, twice, as `chrome-origin-leak`.
				// Falling through is right: the proxy cannot vouch for it.
				let chromeOrigin = "";
				try {
					chromeOrigin = client.global.location.origin;
				} catch {
					// opaque origin; the prefix test below still applies
				}
				const ours =
					!!real &&
					!(chromeOrigin && real.href.startsWith(chromeOrigin)) &&
					!real.pathname.startsWith(client.context.prefix.pathname);
				if (ours) {
					return createReferrerString(
						real,
						client.url,
						current.refererPolicy ?? client.meta.referrerPolicy ?? null
					);
				}
			}

			if (client.history && client.history.length >= 2) {
				const lastState = client.history[client.history.length - 2];
				const referrerURL = new _URL(lastState.url);

				return createReferrerString(
					referrerURL,
					client.url,
					lastState.refererPolicy
				);
			}

			// A subframe's referrer is the document that CREATED it, not a
			// previous navigation inside it -- and a frame usually has none,
			// which is why the history path above answers "" for every iframe.
			// Cloudflare's Turnstile widget reads `document.referrer` from
			// inside its own frame and got "" where a browser gives it the
			// embedding page.
			try {
				const parentWindow = client.global.parent;
				if (parentWindow && parentWindow !== client.global) {
					const parentClient = parentWindow[SCRAMJETCLIENT];
					if (parentClient) {
						return createReferrerString(
							parentClient.url,
							client.url,
							client.meta.referrerPolicy ?? null
						);
					}
				}
			} catch {
				// A parent we cannot reach is a cross-origin parent, and the
				// platform reports no referrer for one either.
			}

			return "";
		}
	});

	// A selector has to see what the page WROTE.
	//
	// Scramjet rewrites `src` and `href` in the markup and serves the original
	// back through `getAttribute`, but a selector does not go through
	// `getAttribute` -- it matches the real attribute. So `[src="/a.png"]` found
	// nothing while the page could plainly read "/a.png" off the element: the
	// two disagreed about the same attribute.
	//
	// That is a functional break before it is a tell. Code that finds elements
	// by their URL is how a script cleans up after itself, and Cloudflare's
	// challenge platform does exactly that. Measured on rateyourmusic: the
	// recorded markup carries 23 `<script>` tags, the oracle's document ends up
	// with 20, and the sandbox's keeps all 23 because the selector that would
	// have removed them matched nothing.
	//
	// The original selector is KEPT alongside the rewritten one rather than
	// replaced. An attribute scramjet did not rewrite has no alias to match, and
	// a selector list matches the union -- an element that satisfies both
	// branches is still returned once.
	const aliasedAttributes =
		"src|href|data|action|formaction|nonce|integrity|csp|credentialless|srcdoc|poster|imagesrcset";
	// The name has to end where the selector's operator begins, or `[data-x]`
	// would be read as the `data` attribute with a stray suffix.
	const attributeSelector = new RegExp(
		`\\[\\s*(${aliasedAttributes})\\s*(?=[~^$*|]?=|\\])`,
		"g"
	);
	const withAliases = (selector: string): string => {
		const aliased = selector.replace(attributeSelector, "[scramjet-attr-$1");

		return aliased === selector ? selector : `${selector}, ${aliased}`;
	};

	/**
	 * Is the browser window focused?
	 *
	 * `document.hasFocus()` is true for the document the focused element is in
	 * AND for every document above it, so a top-level page returns true
	 * whenever its tab is in front. Under the proxy the guest is not top-level
	 * -- it is an iframe inside the embedder's page -- and until something
	 * inside the guest is actually focused, its document is not on that chain
	 * and it answers false.
	 *
	 * Measured against the oracle on rateyourmusic: `true` there, `false` here,
	 * in the page's own realm. An unfocused window is one of the oldest signals
	 * in bot detection, and this hands it over on a page a real person is
	 * looking at.
	 *
	 * Only corrected for the guest's OUTERMOST frame, which is the one standing
	 * in for the tab. A guest iframe that genuinely does not hold focus returns
	 * false in an unmodified browser too, and forcing it true would trade this
	 * leak for the opposite one.
	 */
	client.Proxy("Document.prototype.hasFocus", {
		apply(ctx) {
			// Already true: on the focus chain, and there is nothing to correct.
			if (ctx.call()) return;
			try {
				let win = client.global as unknown as Window;
				let embedder: Window | null = null;
				// Bounded: a hang costs the whole run and the bound costs nothing.
				for (let depth = 0; depth < 32; depth++) {
					const parent = win.parent;
					if (!parent || parent === win) break;
					if (!client.box.globals.get(parent as never)) {
						// The first window with no client of its own is the
						// embedder's page -- outside the sandbox, and the
						// document that stands in for the tab.
						embedder = parent;
						break;
					}
					win = parent;
				}
				// No embedder above us means this frame is not the guest's
				// outermost, or there is nothing wrapping it at all.
				if (!embedder || win !== (client.global as unknown as Window)) {
					return;
				}
				ctx.return(embedder.document.hasFocus());
			} catch {
				// A parent that will not be read is one this cannot answer for;
				// the native value stands.
			}
		},
	});

	client.Proxy(
		[
			"Document.prototype.querySelector",
			"Document.prototype.querySelectorAll",
			"Element.prototype.querySelector",
			"Element.prototype.querySelectorAll",
			"DocumentFragment.prototype.querySelector",
			"DocumentFragment.prototype.querySelectorAll",
			"Element.prototype.matches",
			"Element.prototype.closest",
		],
		{
			apply(ctx) {
				// No selector at all is the native's to reject. Writing
				// `args[0]` here would hand it the string "undefined" and a
				// length of 1, so `document.querySelector()` returned null
				// where a browser throws
				//
				//   Failed to execute 'querySelector' on 'Document':
				//   1 argument required, but only 0 present.
				if (ctx.args.length === 0) return;
				ctx.args[0] = withAliases(String(ctx.args[0]));
			},
		}
	);
}
