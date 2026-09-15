import { htmlRules } from "@/shared/htmlRules";
import {
	Object_create,
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	Object_keys,
	Reflect_get,
	String,
	String_startsWith,
	String_toLowerCase,
	TextEncoder_encode,
	atob,
} from "@/shared/snapshot";
import { bytesToBase64 } from "@/shared/util";
import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { rewriteHtml, unrewriteHtml } from "@rewriters/html";
import { rewriteJs } from "@rewriters/js";
import { gatingContentWindow, guestWindow } from "@client/crossorigin";
import { unrewriteUrl } from "@rewriters/url";
import { controlledAncestor, isUncontrolledDocument } from "@client/helpers";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { recordGuestOps } from "@client/guestop";
import {
	getScriptBlockTypeString,
	isHtmlMimeType,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";
import { ForeignContext } from "@/shared/rewriters/html";
import { Arguments, Returns, Type } from "@client/webidl";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

export function foreignContextForElement(
	client: ScramjetClient,
	element: Element
): ForeignContext {
	if (client.box.instanceof(element, "SVGElement")) return "svg";
	if (client.box.instanceof(element, "MathMLElement")) return "math";
	return "html";
}

// NOTE: NOT INCLUSIVE OF THE CURRENT ELEMENT
export function insideForeignContext(
	client: ScramjetClient,
	element: Element | null
): ForeignContext {
	let current: Element | null = element.parentElement;

	while (current) {
		const context = foreignContextForElement(client, current);
		if (context !== "html") return context;
		// EXPLICITLY an html context, don't go up further
		if (client.box.instanceof(current, "SVGForeignObjectElement"))
			return "html";
		current = current.parentElement;
	}

	return "html";
}

function scriptBlockTypeForElement(
	client: ScramjetClient,
	element: Element
): string {
	const nElement = new client.native.Element(element);
	const hasType = nElement.hasAttribute("type") as boolean;
	const hasLanguage = nElement.hasAttribute("language") as boolean;
	const type = hasType
		? (nElement.getAttribute("type") as string | null)
		: null;
	const language = hasLanguage
		? (nElement.getAttribute("language") as string | null)
		: null;
	return getScriptBlockTypeString(type, language, hasType, hasLanguage);
}

export default function (client: ScramjetClient, self: typeof window) {
	const attrObject = {
		nonce: [self.HTMLElement],
		integrity: [self.HTMLScriptElement, self.HTMLLinkElement],
		csp: [self.HTMLIFrameElement],
		credentialless: [self.HTMLIFrameElement],
		src: [
			self.HTMLImageElement,
			self.HTMLMediaElement,
			self.HTMLIFrameElement,
			self.HTMLFrameElement,
			self.HTMLEmbedElement,
			self.HTMLScriptElement,
			self.HTMLSourceElement,
		],
		href: [self.HTMLAnchorElement, self.HTMLLinkElement],
		data: [self.HTMLObjectElement],
		action: [self.HTMLFormElement],
		formaction: [self.HTMLButtonElement, self.HTMLInputElement],
		srcdoc: [self.HTMLIFrameElement],
		poster: [self.HTMLVideoElement],
		imagesrcset: [self.HTMLLinkElement],
	};

	const urlinterfaces = [
		self.HTMLAnchorElement.prototype,
		self.HTMLAreaElement.prototype,
	];
	const originalhrefs = [
		Object_getOwnPropertyDescriptor(self.HTMLAnchorElement.prototype, "href"),
		Object_getOwnPropertyDescriptor(self.HTMLAreaElement.prototype, "href"),
	];

	/**
	 * Load a script for a document whose own loads would escape, by asking a
	 * controlled ancestor to fetch it and running the result inline.
	 *
	 * The ancestor's `fetch` is scramjet's own, given the ABSOLUTE upstream
	 * URL: both frames share one scramjet context, so it rewrites to the same
	 * proxy URL this document would have used, and issues it from a document
	 * the worker controls. What comes back has already been rewritten by the
	 * worker, which is why it is installed as text rather than as a src.
	 *
	 * A fresh element, because the original has already been inserted and
	 * "already started" by the time the fetch resolves -- assigning to it then
	 * does nothing. The original stays in the DOM as the empty inline script it
	 * became, and answers `.src` with what the page set, through the
	 * `scramjet-attr-src` alias every other attribute already uses.
	 */
	const loadScriptThroughAncestor = (element: Element, value: string): void => {
		const nElement = new client.native.Element(element);
		nElement.setAttribute("scramjet-attr-src", value);

		const ancestor = controlledAncestor(client) as
			| (Window & { fetch: typeof fetch })
			| null;
		if (!ancestor) return;

		let absolute: string;
		try {
			absolute = new URL(value, client.baseUrl).href;
		} catch {
			// not a URL this document can resolve; a browser would fail the
			// load too, so failing it here is the same answer
			return;
		}

		void (async () => {
			// One try around the WHOLE thing. With it around the fetch alone, a
			// failure anywhere after it became an unhandled rejection and the
			// script simply never ran, which is indistinguishable from the bug
			// this function exists to fix.
			// One try around the WHOLE thing. With it around the fetch alone, a
			// failure anywhere after it became an unhandled rejection and the
			// script simply never ran -- indistinguishable from the bug this
			// exists to fix.
			try {
				const response = await ancestor.fetch(absolute);
				if (!response.ok) return;
				const text = await response.text();

				const doc = nElement.ownerDocument;
				if (!doc) return;
				const nDoc = new client.native.Document(doc);
				const runner = nDoc.createElement("script");
				// The element that actually runs answers `.src` with what the
				// page asked for, so `document.currentScript.src` is the URL a
				// browser would have reported rather than "".
				new client.native.Element(runner).setAttribute(
					"scramjet-attr-src",
					value
				);
				new client.native.Node(runner).textContent = text;
				const parent = nElement.parentNode ?? nDoc.head ?? nDoc.documentElement;
				if (!parent) return;
				const nParent = new client.native.Node(parent);
				nParent.appendChild(runner);
				// And straight back out. A classic script runs on insertion, so
				// by the time this returns it has done its work -- and leaving it
				// there would mean the document has one more `<script>` element
				// than a browser would have put in it, which is a thing pages
				// count. The element the page created stays where the page put
				// it; this one was never the page's.
				nParent.removeChild(runner);
			} catch {
				// a load that fails is a load that fails, and a browser reports
				// that with an error event on the element rather than a throw
			}
		})();
	};

	/**
	 * `[[CryptographicNonce]]`, which is not an attribute.
	 *
	 * `element.nonce = value` does NOT write a `nonce` content attribute.
	 * Chromium's `Element::setNonce` stores the value in the element's rare data
	 * and stops there, so the assignment is invisible to `getAttribute`, to
	 * `attributes`, and to serialization -- the point being that a nonce must not
	 * be reachable through a CSS attribute selector, which is how one used to be
	 * exfiltrated.
	 *
	 * Routing the setter through `setAttribute` like every other renamed
	 * attribute put one there. Measured on rateyourmusic's challenge, whose
	 * inline script copies the nonce onto the two scripts it creates: the oracle
	 * walked `script[src]` and `script[src async defer crossorigin]`, the sandbox
	 * `script[nonce src]` and `script[nonce async defer crossorigin]`. The
	 * challenge enumerates the attributes of every element it serializes, so the
	 * extra name travelled in the payload.
	 *
	 * A WeakMap rather than a property on the element, because a slot the page
	 * can find is not a slot.
	 */
	const nonceSlot = new WeakMap<Element, string>();

	const attrs = Object_keys(attrObject);

	for (const attr of attrs) {
		for (const element of attrObject[attr]) {
			const descriptor = Object_getOwnPropertyDescriptor(
				element.prototype,
				attr
			);
			const attrDescriptor: PropertyDescriptor = {
				get() {
					if (["src", "data", "href", "action", "formaction"].includes(attr)) {
						const native = descriptor.get.call(this);

						// A delegated load has no native `src` -- the source was
						// installed as text, because the document's own loads would
						// escape the sandbox (see `loadScriptThroughAncestor`). The
						// page still set one, so reading it back has to answer, and
						// `document.currentScript.src` is not a detail: a script
						// that bootstraps from its own URL gets "" instead, and
						// Cloudflare's JS detections stop a few operations in.
						//
						// Resolved against the document's base, because this is the
						// IDL attribute rather than `getAttribute` -- the alias
						// holds what the page wrote, which may be relative.
						if (!native) {
							const alias = new client.native.Element(this).getAttribute(
								`scramjet-attr-${attr}`
							);
							if (alias) {
								try {
									return new URL(alias, client.baseUrl).href;
								} catch {
									return alias;
								}
							}
						}

						return unrewriteUrl(native, client.context);
					}

					// A nonce the page assigned lives in the slot and nowhere
					// else, so that is where it is read back from.
					if (attr === "nonce" && nonceSlot.has(this)) {
						return nonceSlot.get(this);
					}

					// The attribute was renamed out of the way -- `nonce` becomes
					// `scramjet-attr-nonce` -- so the native IDL getter reads an
					// attribute that is no longer there and answers "". `getAttribute`
					// already looks under the alias; the property has to as well, or
					// the two disagree about the same attribute. Cloudflare's Turnstile
					// reads `script.nonce`.
					const nElement = new client.native.Element(this);
					if (nElement.hasAttribute(`scramjet-attr-${attr}`)) {
						return nElement.getAttribute(`scramjet-attr-${attr}`) ?? "";
					}

					return descriptor.get.call(this);
				},

				set(value) {
					// if (
					// 	this.tagName === "IFRAME" &&
					// 	attr === "src" &&
					// 	value === "about:blank"
					// ) {
					// 	this.setAttribute("srcdoc", "");
					// 	return;
					// }

					// A script in a document the worker does not control would
					// fetch from the proxy's own origin, so route it through one
					// the worker does control. See `isUncontrolledDocument`.
					if (
						attr === "src" &&
						client.box.instanceof(this, "HTMLScriptElement") &&
						isUncontrolledDocument(client)
					) {
						loadScriptThroughAncestor(this, String(value));

						return;
					}

					// The slot, and NOT a content attribute: see `nonceSlot`.
					if (attr === "nonce") {
						nonceSlot.set(this, String(value));

						return;
					}

					return this.setAttribute(attr, value);
				},
			};
			// The sixth interception seam, and the only one that defines onto a
			// prototype directly rather than through `installNative` -- so the
			// one hook there does not reach it, and every URL-carrying attribute
			// the page reads was unrecorded. Measured on rateyourmusic:
			// `HTMLAnchorElement.href` 15 guest reads against nothing,
			// `HTMLScriptElement.src` 8, and those are the values a leak would
			// be IN.
			//
			// Named from the interface rather than left to the owner fallback,
			// because the loop already knows which interface it is on: the same
			// `src` is trapped on seven of them and they are seven APIs to the
			// oracle.
			recordGuestOps(
				{ debugname: `${element.name}.${attr}`, key: attr },
				attrDescriptor
			);
			Object_defineProperty(element.prototype, attr, attrDescriptor);
		}
	}

	client.Trap("HTMLImageElement.prototype.currentSrc", {
		get(ctx) {
			const currentSrc = ctx.get() as string;
			if (!currentSrc) return currentSrc;
			return unrewriteUrl(currentSrc, client.context);
		},
	});

	// note that href is not here
	const urlprops = [
		"protocol",
		"hash",
		"host",
		"hostname",
		"origin",
		"pathname",
		"port",
		"search",
	];
	for (const prop of urlprops) {
		for (const i in urlinterfaces) {
			const target = urlinterfaces[i];
			const desc = originalhrefs[i];
			client.RawTrap(target, prop, {
				get(ctx) {
					const href = desc.get.call(ctx.this);
					if (!href) return href;

					const url = new URL(unrewriteUrl(href, client.context));

					return url[prop];
				},
			});
		}
	}

	client.Trap("Node.prototype.baseURI", {
		get(ctx) {
			const node = ctx.this as Node;
			const doc = client.box.instanceof(node, "Document")
				? (node as Document)
				: node.ownerDocument;
			// Through the NATIVE handle. `doc.querySelector` is a function the
			// page can replace, and a proxy that calls it is making a DOM query
			// the page never asked for, on the page's own function. Cloudflare
			// records the selectors it sees: measured in the payload, the
			// sandbox's collected-value pool held "base[href]" and the
			// oracle's did not.
			const base = new client.native.Document(doc as Document).querySelector(
				"base[href]"
			) as HTMLBaseElement | null;

			// `client.baseUrl`, not `client.url.href`: an about:blank or
			// about:srcdoc document inherits its CREATOR's base URL, which is
			// what makes a relative reference written into a blank iframe by its
			// parent resolve against the site. Reporting "about:blank" here is a
			// divergence a page reads straight off `document.baseURI`, and it is
			// how Cloudflare's JS detections start.
			const baseUrl = client.baseUrl;
			if (base) {
				// Native for the same reason: `getAttribute` is replaceable and
				// the `href` IDL getter resolves against the document, so both
				// are the page's to observe.
				const nBase = new client.native.Element(base);
				const href = nBase.getAttribute("href") || base.href;
				if (href) return new URL(href, baseUrl).href;
			}

			return baseUrl;
		},
		set() {
			return false;
		},
	});

	client.Proxy("Element.prototype.getAttribute", {
		apply(ctx) {
			const [name] = ctx.args;

			if (name.startsWith("scramjet-attr") || proxyOnly(name)) {
				return ctx.return(null);
			}

			// A blanked `nonce` outranks its alias, and is the one attribute
			// that does.
			//
			// Everywhere else the alias IS the attribute and the real one holds
			// scramjet's rewritten value, so the alias has to win -- `src` keeps
			// the proxied URL and the page asked for the original. A nonce the
			// browser has hidden is the opposite case: the rewriter left the
			// empty attribute the browser would have left, and that empty string
			// is the answer the page is owed. The value is still on the element,
			// in the alias, for `element.nonce` to read.
			if (
				String(name).toLowerCase() === "nonce" &&
				new client.native.Element(ctx.this).hasAttribute("nonce")
			) {
				return;
			}

			if (
				new client.native.Element(ctx.this).hasAttribute(
					`scramjet-attr-${name}`
				)
			) {
				const attrib = ctx.fn.call(ctx.this, `scramjet-attr-${name}`);
				if (attrib === null) return ctx.return("");

				return ctx.return(attrib);
			}
		},
	});

	/**
	 * `scramjet-attr-<name>` is where `<name>` LIVES, not a second copy of it.
	 *
	 * The rewriter renames an attribute out of the way when the browser would
	 * otherwise act on it -- `nonce` is the clear case, CSP consumes it -- and
	 * `getAttribute` and the IDL property both answer from the alias. Every
	 * enumeration just dropped the alias, so the attribute vanished: a script
	 * the page wrote with `nonce` reported `attributes.length` 1 against 2,
	 * `getAttributeNames()` without it, and `hasAttribute("nonce")` false,
	 * while `getAttribute("nonce")` returned the value.
	 *
	 * Cloudflare walks the map. Its element-tree fingerprint is the tag plus
	 * the first letters of each attribute, and on rateyourmusic the two sides
	 * read `...scr_no` against `...scr_sc_sc` -- a script with a nonce, and a
	 * script with no nonce and two attributes nobody else has.
	 *
	 * So the alias is RENAMED back rather than hidden, unless the real
	 * attribute is also present -- `src` keeps its rewritten value alongside
	 * the alias, and surfacing both would report `src` twice.
	 */
	const ALIAS = "scramjet-attr-";
	/**
	 * Attributes that are the PROXY's, not a renamed one of the page's.
	 *
	 * `scramjet-attr-<name>` is where `<name>` lives, so it is renamed back --
	 * but two names are scramjet's own inventions and stand for nothing the
	 * page wrote. `scramjet-attr-script-source-src` carries the original script
	 * body, and `scramjet-injected` marks a script the rewriter added. Neither
	 * is an attribute a browser has, so neither is surfaced under any name.
	 *
	 * `scramjet-injected` does not even start with the alias prefix, so every
	 * filter keyed on that prefix missed it: it was visible to
	 * `getAttributeNames`, and Cloudflare's enumeration saw
	 * `["src","scramjet-injected"]` on scramjet's own script tags.
	 */
	const proxyOnly = (name: string): boolean =>
		name === "scramjet-injected" ||
		name === `${ALIAS}script-source-src` ||
		name === "script-source-src";

	const aliasTarget = (element: Element, name: string): string | null => {
		if (!name.startsWith(ALIAS)) return null;
		if (proxyOnly(name)) return null;
		const real = name.slice(ALIAS.length);

		return new client.native.Element(element).hasAttribute(real) ? null : real;
	};

	client.Proxy("Element.prototype.getAttributeNames", {
		apply(ctx) {
			const attrNames = ctx.call() as string[];
			const out: string[] = [];
			for (const attr of attrNames) {
				if (proxyOnly(attr)) continue;
				if (!attr.startsWith(ALIAS)) {
					out.push(attr);
					continue;
				}
				const real = aliasTarget(ctx.this as Element, attr);
				if (real !== null) out.push(real);
			}

			ctx.return(out);
		},
	});

	client.Proxy("Element.prototype.getAttributeNode", {
		apply(ctx) {
			if (String(ctx.args[0]).startsWith("scramjet-attr"))
				return ctx.return(null);
		},
	});

	client.Proxy("Element.prototype.hasAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr") || proxyOnly(name))
				return ctx.return(false);
			// The alias is the attribute. `getAttribute` already answers from
			// it, so this has to agree or the two disagree about the same name.
			if (new client.native.Element(ctx.this).hasAttribute(`${ALIAS}${name}`)) {
				return ctx.return(true);
			}
		},
	});

	client.Proxy("Element.prototype.setAttribute", {
		apply(ctx) {
			let [name, value] = ctx.args;
			const tagName = ctx.this.tagName.toLowerCase();

			if (value != null) value = String(value);
			ctx.args[1] = value;

			// Writing the content attribute updates the slot, so the two cannot
			// drift apart -- `OnNonceAttrChanged` in Chromium, which takes the
			// new value unless it is empty. Empty is how the browser HIDES a
			// nonce, and hiding must not destroy the value it just stashed.
			if (String(name).toLowerCase() === "nonce" && value) {
				nonceSlot.set(ctx.this as Element, value);
			}

			const ruleList = htmlRules.find((rule) => {
				const r = rule[name.toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(tagName);
			});

			if (ruleList) {
				const ret = ruleList.fn(value, client.context, client.meta, (attr) =>
					ctx.this.getAttribute(attr)
				);
				if (ret == null) {
					new client.native.Element(ctx.this).removeAttribute(name);
					ctx.fn.call(ctx.this, `scramjet-attr-${name}`, value);
					ctx.return(undefined);

					return;
				}
				ctx.args[1] = ret;
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`, value);
			}
		},
	});

	// i actually need to do something with this
	client.Proxy("Element.prototype.setAttributeNode", {
		apply(_ctx) {},
	});

	client.Proxy("Element.prototype.setAttributeNS", {
		apply(ctx) {
			// TODO: this could leak by like calling stringify twice or some dumb shit lol
			const name = String(ctx.args[1]);
			const value = String(ctx.args[2]);

			const ruleList = htmlRules.find((rule) => {
				const r = rule[String(name).toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(ctx.this.tagName.toLowerCase());
			});

			if (ruleList) {
				ctx.args[2] = ruleList.fn(value, client.context, client.meta, (attr) =>
					ctx.this.getAttribute(attr)
				);
				new client.native.Element(ctx.this).setAttribute(
					`scramjet-attr-${ctx.args[1]}`,
					value
				);
			}
		},
	});

	// this is separate from the regular href handlers because it returns an SVGAnimatedString
	client.Trap("SVGAnimatedString.prototype.baseVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		set(ctx, val: string) {
			ctx.set(client.rewriteUrl(val));
		},
	});
	client.Trap("SVGAnimatedString.prototype.animVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		// it has no setter
	});
	const isInternal = (name: string) => {
		return String_startsWith(name, "scramjet-attr-");
	};
	/**
	 * Step 2 of https://dom.spec.whatwg.org/#dom-element-toggleattribute — the
	 * lowercasing is conditional. An SVG or MathML element keeps `viewBox` as
	 * `viewBox`, and folding it writes a different, meaningless attribute.
	 */
	const qualifiedAttributeName = (element: Element, name: string) => {
		const nElement = new client.native.Element(element);

		return nElement.namespaceURI === HTML_NAMESPACE &&
			client.box.instanceof(nElement.ownerDocument, "HTMLDocument")
			? String_toLowerCase(name)
			: name;
	};

	client.Intercept(class extends Element {
		@Arguments("DOMString")
		@Returns("undefined")
		removeAttribute(qualifiedName: string): void {
			if (isInternal(qualifiedName)) return;
			if (!super.hasAttribute(qualifiedName)) return;
			super.removeAttribute(`scramjet-attr-${qualifiedName}`);
			super.removeAttribute(qualifiedName);
		}

		// `force` is `optional boolean`, not a nullable required one. declaring
		// it required made every one-argument call fail validation and fall
		// through to the native, which toggled the real attribute and left the
		// `scramjet-attr-` mirror behind to answer getAttribute() forever
		@Arguments("DOMString", "optional boolean")
		@Returns("boolean")
		toggleAttribute(qualifiedName: string, force?: boolean): boolean {
			if (isInternal(qualifiedName)) return false;
			// 1. If qualifiedName is not a valid attribute local name, then throw an "InvalidCharacterError" DOMException.
			// no op here?
			// 2. If this is in the HTML namespace and its node document is an HTML document, then set qualifiedName to qualifiedName in ASCII lowercase.
			qualifiedName = qualifiedAttributeName(this, qualifiedName);
			// 3. Let attribute be the first attribute in this’s attribute list whose qualified name is qualifiedName, and null otherwise.
			const hasAttribute = super.hasAttribute(qualifiedName);
			// 4. If attribute is null:
			if (hasAttribute === false) {
				if (force === false) return false;
				// If force is not given or true
				super.toggleAttribute(`scramjet-attr-${qualifiedName}`, true);
				super.toggleAttribute(qualifiedName, true);
				return true;
			}
			if (force === true) return true;
			// If force is not given or false
			super.toggleAttribute(`scramjet-attr-${qualifiedName}`, false);
			super.toggleAttribute(qualifiedName, false);
			return false;
		}

		@Type("(TrustedHTML or [LegacyNullToEmptyString] DOMString)")
		set innerHTML(value: string) {
			// the IDL union hands a TrustedHTML through as the object it is -
			// that is what the brand check is for - and on an engine with no
			// TrustedHTML at all the whole union degrades to a passthrough. the
			// rewriters take a string either way
			value = String(value);
			let newval;
			const scriptBlockType = client.box.instanceof(this, "HTMLScriptElement")
				? scriptBlockTypeForElement(client, this)
				: null;
			if (
				client.box.instanceof(this, "HTMLScriptElement") &&
				isScriptType(scriptBlockType)
			) {
				newval = rewriteJs(
					value,
					"(anonymous script element)",
					client.context,
					client.meta,
					isModuleScriptType(scriptBlockType)
				);
				new client.native.Element(this).setAttribute(
					"scramjet-attr-script-source-src",
					bytesToBase64(TextEncoder_encode(newval))
				);
			} else if (client.box.instanceof(this, "HTMLStyleElement")) {
				newval = rewriteCss(value, client.context, client.meta);
			} else {
				try {
					newval = rewriteHtml(value, client.context, client.meta, {
						loadScripts: false,
						inline: true,
						source: client.url.href,
						apisource: "set Element.prototype.innerHTML",
						foreignContext: foreignContextForElement(client, this),
					});
				} catch {
					newval = value;
				}
			}

			super.innerHTML = newval;
		}

		get innerHTML(): string {
			if (client.box.instanceof(this, "HTMLScriptElement")) {
				const scriptSource = super.getAttribute(
					"scramjet-attr-script-source-src"
				);

				if (scriptSource) {
					return atob(scriptSource);
				}

				return super.innerHTML;
			}
			if (client.box.instanceof(this, "HTMLStyleElement")) {
				return super.innerHTML;
			}

			return unrewriteHtml(
				super.innerHTML,
				foreignContextForElement(client, this)
			);
		}
	});
	const rewriteTextForElement = (element: Element, value: string) => {
		const scriptBlockType = client.box.instanceof(element, "HTMLScriptElement")
			? scriptBlockTypeForElement(client, element)
			: null;

		if (
			client.box.instanceof(element, "HTMLScriptElement") &&
			isScriptType(scriptBlockType)
		) {
			const newval: string = rewriteJs(
				value,
				"(anonymous script element)",
				client.context,
				client.meta,
				isModuleScriptType(scriptBlockType)
			) as string;
			new client.native.Element(element).setAttribute(
				"scramjet-attr-script-source-src",
				bytesToBase64(TextEncoder_encode(value))
			);

			return newval;
		} else if (client.box.instanceof(element, "HTMLStyleElement")) {
			return rewriteCss(value, client.context, client.meta);
		} else {
			return value;
		}
	};
	const getTextForElement = (element: Element, text: string) => {
		if (client.box.instanceof(element, "HTMLScriptElement")) {
			const scriptSource = new client.native.Element(element).getAttribute(
				"scramjet-attr-script-source-src"
			);
			if (scriptSource) return atob(scriptSource);
			return text;
		}
		if (client.box.instanceof(element, "HTMLStyleElement")) {
			return unrewriteCss(text, client.context);
		}
		return text;
	};

	client.Trap(
		["Node.prototype.textContent", "HTMLScriptElement.prototype.textContent"],
		{
			set(ctx, value) {
				const text = String(value);
				return ctx.set(rewriteTextForElement(ctx.this, text));
			},
			get(ctx) {
				return getTextForElement(ctx.this, ctx.get());
			},
		}
	);
	client.Trap(
		[
			"HTMLElement.prototype.innerText",
			"HTMLScriptElement.prototype.innerText",
		],
		{
			set(ctx, value: string) {
				const text = String(value);
				return ctx.set(rewriteTextForElement(ctx.this, text));
			},
			get(ctx) {
				return getTextForElement(ctx.this, ctx.get());
			},
		}
	);

	client.Trap("Element.prototype.outerHTML", {
		set(ctx, value: string) {
			const html = String(value);
			ctx.set(
				rewriteHtml(html, client.context, client.meta, {
					loadScripts: false,
					inline: true,
					source: client.url.href,
					apisource: "set Element.prototype.outerHTML",
					foreignContext: insideForeignContext(client, ctx.this),
				})
			);
		},
		get(ctx) {
			return unrewriteHtml(ctx.get(), insideForeignContext(client, ctx.this));
		},
	});

	client.Proxy("Element.prototype.setHTMLUnsafe", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "set Element.prototype.setHTMLUnsafe",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	client.Proxy("Element.prototype.getHTML", {
		apply(ctx) {
			ctx.return(unrewriteHtml(ctx.call()));
		},
	});

	client.Proxy("Element.prototype.insertAdjacentHTML", {
		apply(ctx) {
			const html = String(ctx.args[1]);
			ctx.args[1] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "set Element.prototype.insertAdjacentHTML",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	// TODO: this needs to be done for all insert methods
	// client.Proxy(["Element.prototype.appendChild", "Element.prototype.append"], {
	// 	apply(ctx) {
	// 		if (ctx.this instanceof self.HTMLStyleElement) {
	// 			for (const node of ctx.args) {
	// 				if (node instanceof self.Text) {
	// 					node.data = rewriteCss(
	// 						ctx.args[0].data,
	// 						client.context,
	// 						client.meta
	// 					);
	// 				}
	// 			}
	// 		} else if (ctx.this instanceof self.HTMLScriptElement) {
	// 			for (const node of ctx.args) {
	// 				if (node instanceof self.Text) {
	// 					const newval: string = rewriteJs(
	// 						node.data,
	// 						"(anonymous script element)",
	// 						client.context,
	// 						client.meta
	// 					) as string;
	// 					new client.native.Element(ctx.this).setAttribute(
	// 						"scramjet-attr-script-source-src",
	// 						bytesToBase64(encoder.encode(newval))
	// 					);
	// 					node.data = newval;
	// 				}
	// 			}
	// 		}
	// 	},
	// });

	client.Proxy("Audio", {
		construct(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});

	client.Intercept(class extends Text {
		get wholeText(): string {
			return getTextForElement(super.parentElement, super.wholeText);
		}
	});
	client.Intercept(class extends CharacterData {
		appendData(data: string): void {
			super.appendData(rewriteTextForElement(super.parentElement, data));
		}
		// TODO: this is completely broken if done partially
		insertData(offset: number, data: string): void {
			super.insertData(
				offset,
				rewriteTextForElement(super.parentElement, data)
			);
		}
		replaceData(offset: number, count: number, data: string): void {
			super.replaceData(
				offset,
				count,
				rewriteTextForElement(super.parentElement, data)
			);
		}
	});

	client.Proxy("HTMLAnchorElement.prototype.toString", {
		apply(ctx) {
			const href = ctx.call();
			if (!href) return href;
			return ctx.return(unrewriteUrl(href, client.context));
		},
	});

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentWindow",
			"HTMLFrameElement.prototype.contentWindow",
			"HTMLObjectElement.prototype.contentWindow",
			"HTMLEmbedElement.prototype.contentWindow",
		],
		{
			get(ctx) {
				const realwin = ctx.get() as Window;
				if (!realwin) return realwin;

				try {
					if (!(SCRAMJETCLIENT in realwin)) {
						// hook the iframe before the client can start to steal globals out of it
						client.init.hookSubcontext(realwin, ctx.this);
					}
				} catch {
					// cross-origin iframe, can't do anything here
					return realwin;
				}

				// NOT gated, and that is a known hole: a cross-origin
				// `contentWindow` still answers `document`, `location.href`,
				// `name` and `origin` where a browser throws. Gating it the way
				// `contentDocument` is gated below hangs the sandbox -- the
				// harness and the controller drive guest frames through this
				// accessor, and a locked-down window denies them the members
				// they need. It wants a way to tell the proxy's own reads from
				// the page's before it can be closed.
				//
				// `sbxdiff-gatecw.js` turns the gating on for an experiment that
				// measures HOW it breaks rather than restating that it does.
				// Off in every ordinary build (FINDINGS #251).
				if (gatingContentWindow()) return guestWindow(client, realwin);

				return realwin;
			},
		}
	);

	/**
	 * The guest origin of a frame, or null when it cannot be established.
	 *
	 * Every guest is served from the SAME real origin -- the proxy's -- so the
	 * browser's own same-origin check is satisfied for any two frames and stops
	 * protecting anything. What separates them is the origin each one is
	 * PRETENDING to be, which is the origin its own client was built with.
	 */
	const guestOrigin = (win: Window): string | null => {
		try {
			const sub = win[SCRAMJETCLIENT] as ScramjetClient | undefined;

			return sub ? sub.url.origin : null;
		} catch {
			return null;
		}
	};

	/**
	 * Would a browser have refused this frame to its embedder?
	 *
	 * Null means "no client yet, or not one of ours", and that answers NO --
	 * an about:blank or srcdoc frame inherits its creator's origin and a frame
	 * that has not navigated has nothing to hide. Inventing a boundary where
	 * the browser has none is its own divergence.
	 */
	const deniedToEmbedder = (win: Window): boolean => {
		const theirs = guestOrigin(win);

		return theirs !== null && theirs !== client.url.origin;
	};

	// registered one interface at a time so the native lookup is keyed on the
	// interface the trap was installed for. reading it off `this.constructor
	// .name` instead takes the name from the page - a shadowed `constructor`, or
	// just a subclass, names an interface the native store has never heard of,
	// and `client.native[...]` throws that straight out of the getter
	for (const iface of [
		"HTMLIFrameElement",
		"HTMLFrameElement",
		"HTMLObjectElement",
		"HTMLEmbedElement",
	]) {
		client.Trap(`${iface}.prototype.contentDocument`, {
			get(ctx) {
				const realwin = new client.native[iface](ctx.this).contentWindow;
				if (!realwin) return realwin;

				if (!(SCRAMJETCLIENT in realwin)) {
					client.init.hookSubcontext(realwin, ctx.this);
				}

				// A cross-origin frame's document is null, and that is the
				// whole of what a browser gives up here.
				//
				// Measured with `pages/crossorigin.html`, framing example.com:
				// the oracle reads null and the sandbox read "Example Domain",
				// the frame's actual title. Turnstile runs cross-origin to the
				// page that embeds it BY DESIGN, so "can I read my embedder,
				// or it me" is a question it is in a position to ask and a
				// browser always answers the same way.
				if (deniedToEmbedder(realwin)) return null;

				return realwin.document;
			},
		});
	}

	client.Proxy(
		[
			"HTMLIFrameElement.prototype.getSVGDocument",
			"HTMLObjectElement.prototype.getSVGDocument",
			"HTMLEmbedElement.prototype.getSVGDocument",
		],
		{
			apply(ctx) {
				const doc = ctx.call();
				if (doc) {
					// we trap the contentDocument, this is really the scramjet version
					return ctx.return(ctx.this.contentDocument);
				}
			},
		}
	);

	client.Proxy("DOMParser.prototype.parseFromString", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			const mime = String(ctx.args[1]);
			// TODO: what do we do if it's xml/svg?
			if (!isHtmlMimeType(mime)) return;
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "DOMParser.prototype.parseFromString",
			});
		},
	});
}
