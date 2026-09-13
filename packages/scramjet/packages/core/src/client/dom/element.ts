import { htmlRules } from "@/shared/htmlRules";
import {
	String,
	TextEncoder_encode,
	Object_keys,
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	atob,
	String_startsWith,
	String_toLowerCase,
} from "@/shared/snapshot";
import { bytesToBase64 } from "@/shared/util";
import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { rewriteHtml, unrewriteHtml } from "@rewriters/html";
import { rewriteJs } from "@rewriters/js";
import { unrewriteUrl } from "@rewriters/url";
import { controlledAncestor, isUncontrolledDocument } from "@client/helpers";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
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
				new client.native.Node(parent).appendChild(runner);
			} catch {
				// a load that fails is a load that fails, and a browser reports
				// that with an error event on the element rather than a throw
			}
		})();
	};

	const attrs = Object_keys(attrObject);

	for (const attr of attrs) {
		for (const element of attrObject[attr]) {
			const descriptor = Object_getOwnPropertyDescriptor(
				element.prototype,
				attr
			);
			Object_defineProperty(element.prototype, attr, {
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

					return this.setAttribute(attr, value);
				},
			});
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
			const base = doc?.querySelector("base[href]") as HTMLBaseElement | null;

			// `client.baseUrl`, not `client.url.href`: an about:blank or
			// about:srcdoc document inherits its CREATOR's base URL, which is
			// what makes a relative reference written into a blank iframe by its
			// parent resolve against the site. Reporting "about:blank" here is a
			// divergence a page reads straight off `document.baseURI`, and it is
			// how Cloudflare's JS detections start.
			const baseUrl = client.baseUrl;
			if (base) {
				const href = base.getAttribute("href") || base.href;
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

			if (name.startsWith("scramjet-attr")) {
				return ctx.return(null);
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

	client.Proxy("Element.prototype.getAttributeNames", {
		apply(ctx) {
			const attrNames = ctx.call() as string[];
			const cleaned = attrNames.filter(
				(attr) => !attr.startsWith("scramjet-attr")
			);

			ctx.return(cleaned);
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
			if (String(ctx.args[0]).startsWith("scramjet-attr"))
				return ctx.return(false);
		},
	});

	client.Proxy("Element.prototype.setAttribute", {
		apply(ctx) {
			let [name, value] = ctx.args;
			const tagName = ctx.this.tagName.toLowerCase();

			if (value != null) value = String(value);
			ctx.args[1] = value;

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

				return realwin;
			},
		}
	);

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
