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
				ctx.args[0] = withAliases(String(ctx.args[0]));
			},
		}
	);
}
