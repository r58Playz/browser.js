/**
 * @fileoverview
 * The page-facing half of the identifier mangler.
 *
 * The rewrite path renames custom element tags, site-authored attribute names and
 * class/id values on their way into the document. Everything in here exists to make
 * that invisible to the page's own JavaScript: names go in mangled and come back out
 * original, so `el.tagName === "YT-ICON"` and `document.querySelector("yt-icon")`
 * keep working against a DOM that no longer contains the string `yt-icon`.
 *
 * The HTML- and CSS-string boundaries (`innerHTML`, `insertAdjacentHTML`, `DOMParser`,
 * `insertRule`, `cssText`, ...) are not listed here: they already route through
 * `rewriteHtml`/`unrewriteHtml` and `rewriteCss`/`unrewriteCss`, so they inherit
 * mangling from those.
 */

import { ScramjetClient } from "@client/index";
import {
	mangleTokenList,
	Mangler,
	manglersFor,
	ManglerSet,
	shouldMangleAttr,
	shouldMangleTag,
} from "@/shared";
import { selectorTransform } from "@rewriters/css";
import { transformSelector } from "@rewriters/selectors";
import { IdentTransform } from "@rewriters/selectors";
import {
	Array_from,
	Array_isArray,
	Object_defineProperty,
	Reflect_apply,
	Reflect_get,
	String,
	_WeakMap,
} from "@/shared/snapshot";

const Symbol_iterator = globalThis.Symbol.iterator;

/**
 * Resolved once per realm rather than per call. That is not only cheaper: switching
 * mangling on or off partway through a document's life would leave the already
 * rewritten markup disagreeing with the traps, so the decision has to be fixed for as
 * long as the realm lives.
 */
export function enabled(client: ScramjetClient): boolean {
	return manglersFor(client.context, client.url).enabled;
}

const HTMLNS = "http://www.w3.org/1999/xhtml";
const DIGITS = /^\d+$/;

/** Tag names surface uppercase on `tagName`/`nodeName` but mangle lowercase. */
function unmangleTagName(manglers: ManglerSet, name: string): string {
	if (!manglers.tag) return name;
	const lower = name.toLowerCase();
	const plain = manglers.tag.unmangle("tag", lower);
	if (plain === lower) return name;

	return name === lower ? plain : plain.toUpperCase();
}

function mangleTagName(manglers: ManglerSet, name: string): string {
	if (!manglers.tag) return name;
	const lower = name.toLowerCase();
	if (!shouldMangleTag(lower)) return name;

	return manglers.tag.mangle("tag", lower);
}

export default function (client: ScramjetClient) {
	const manglers = manglersFor(client.context, client.url);
	const toPage = selectorTransform(
		"unrewrite",
		client.context,
		client.url
	) as IdentTransform;
	const toDom = selectorTransform(
		"rewrite",
		client.context,
		client.url
	) as IdentTransform;

	const mangleSelector = (selector: string) =>
		transformSelector(String(selector), toDom);

	const mangleClass = (token: string) =>
		manglers.classid ? manglers.classid.mangle("class", token) : token;
	const unmangleClass = (token: string) =>
		manglers.classid ? manglers.classid.unmangle("class", token) : token;
	const mangleId = (value: string) =>
		manglers.classid ? manglers.classid.mangle("id", value) : value;
	const unmangleId = (value: string) =>
		manglers.classid ? manglers.classid.unmangle("id", value) : value;

	// --- tag names ----------------------------------------------------------

	if (manglers.tag) {
		client.Trap(
			["Element.prototype.tagName", "Node.prototype.nodeName"],
			{
				get(ctx) {
					return unmangleTagName(manglers, ctx.get() as unknown as string);
				},
			}
		);

		client.Trap("Element.prototype.localName", {
			get(ctx) {
				return unmangleTagName(manglers, ctx.get() as unknown as string);
			},
		});

		client.Proxy("Document.prototype.createElement", {
			apply(ctx) {
				ctx.args[0] = mangleTagName(manglers, String(ctx.args[0]));
				const opts = ctx.args[1];
				if (opts && typeof opts === "object" && "is" in opts) {
					opts.is = mangleTagName(manglers, String(opts.is));
				}
			},
		});

		client.Proxy("Document.prototype.createElementNS", {
			apply(ctx) {
				// custom elements only exist in the HTML namespace
				if (ctx.args[0] !== HTMLNS && ctx.args[0] !== null) return;
				ctx.args[1] = mangleTagName(manglers, String(ctx.args[1]));
				const opts = ctx.args[2];
				if (opts && typeof opts === "object" && "is" in opts) {
					opts.is = mangleTagName(manglers, String(opts.is));
				}
			},
		});

		client.Proxy(
			[
				"Document.prototype.getElementsByTagName",
				"Element.prototype.getElementsByTagName",
			],
			{
				apply(ctx) {
					ctx.args[0] = mangleTagName(manglers, String(ctx.args[0]));
				},
			}
		);

		client.Proxy(
			[
				"Document.prototype.getElementsByTagNameNS",
				"Element.prototype.getElementsByTagNameNS",
			],
			{
				apply(ctx) {
					if (ctx.args[0] !== HTMLNS && ctx.args[0] !== null) return;
					ctx.args[1] = mangleTagName(manglers, String(ctx.args[1]));
				},
			}
		);

		// --- custom element registry ------------------------------------------

		client.Proxy("CustomElementRegistry.prototype.define", {
			apply(ctx) {
				ctx.args[0] = mangleTagName(manglers, String(ctx.args[0]));
				// `extends` names a built-in, which is never mangled
				if (manglers.attr) adaptObservedAttributes(manglers.attr, ctx.args[1]);
			},
		});

		client.Proxy(
			[
				"CustomElementRegistry.prototype.get",
				"CustomElementRegistry.prototype.whenDefined",
			],
			{
				apply(ctx) {
					ctx.args[0] = mangleTagName(manglers, String(ctx.args[0]));
				},
			}
		);

		client.Proxy("CustomElementRegistry.prototype.getName", {
			apply(ctx) {
				const name = ctx.call();
				if (typeof name !== "string") return;
				ctx.return(unmangleTagName(manglers, name) as any);
			},
		});
	}

	// --- selectors ------------------------------------------------------------

	client.Proxy(
		[
			// Document is separately proxied in dom/document.ts for an unrelated
			// `[src=//...]` fixup; the two chain
			"Document.prototype.querySelector",
			"Document.prototype.querySelectorAll",
			"Element.prototype.querySelector",
			"Element.prototype.querySelectorAll",
			// ShadowRoot inherits these from DocumentFragment
			"DocumentFragment.prototype.querySelector",
			"DocumentFragment.prototype.querySelectorAll",
			"Element.prototype.matches",
			"Element.prototype.closest",
			"Element.prototype.webkitMatchesSelector",
		],
		{
			apply(ctx) {
				ctx.args[0] = mangleSelector(ctx.args[0] as any) as any;
			},
		}
	);

	// --- class and id ---------------------------------------------------------

	if (manglers.classid) {
		client.Trap("Element.prototype.id", {
			get(ctx) {
				return unmangleId(ctx.get() as unknown as string);
			},
			set(ctx, value) {
				ctx.set(mangleId(String(value)) as any);
			},
		});

		client.Trap("Element.prototype.className", {
			get(ctx) {
				const value = ctx.get() as unknown as string;
				if (typeof value !== "string") return value;

				return mangleTokenList(value, unmangleClass) as any;
			},
			set(ctx, value) {
				ctx.set(mangleTokenList(String(value), mangleClass) as any);
			},
		});

		client.Proxy(
			[
				"Document.prototype.getElementById",
				"NonElementParentNode.prototype.getElementById",
			],
			{
				apply(ctx) {
					ctx.args[0] = mangleId(String(ctx.args[0]));
				},
			}
		);

		client.Proxy(
			[
				"Document.prototype.getElementsByClassName",
				"Element.prototype.getElementsByClassName",
			],
			{
				apply(ctx) {
					ctx.args[0] = mangleTokenList(String(ctx.args[0]), mangleClass);
				},
			}
		);

		// `for` reflects an id, so the property has to lie the same way the attribute
		// does. (`HTMLOutputElement.htmlFor` is a DOMTokenList rather than a string
		// and is not covered.)
		client.Trap("HTMLLabelElement.prototype.htmlFor", {
			get(ctx) {
				return unmangleId(String(ctx.get())) as any;
			},
			set(ctx, value) {
				ctx.set(mangleId(String(value)) as any);
			},
		});

		installClassList(client, mangleClass, unmangleClass);
	}

	// --- attribute name plumbing ----------------------------------------------

	if (manglers.attr) {
		const mangleAttr = (name: string) => {
			const lower = String(name).toLowerCase();

			return shouldMangleAttr(lower, false)
				? manglers.attr!.mangle("attr", lower)
				: name;
		};

		client.Proxy("Document.prototype.createAttribute", {
			apply(ctx) {
				ctx.args[0] = mangleAttr(String(ctx.args[0]));
			},
		});

		// a record's `attributeName` is the mangled one; the page expects its own
		client.Trap("MutationRecord.prototype.attributeName", {
			get(ctx) {
				const name = ctx.get() as unknown as string | null;

				return (
					name === null ? null : manglers.attr!.unmangle("attr", name)
				) as any;
			},
		});

		client.Proxy("MutationObserver.prototype.observe", {
			apply(ctx) {
				const init = ctx.args[1] as MutationObserverInit | undefined;
				if (init && init.attributeFilter) {
					ctx.args[1] = {
						...init,
						attributeFilter: Array_from(init.attributeFilter, (n: string) =>
							mangleAttr(n)
						),
					};
				}
			},
		});

		installDataset(client);
	}

	// --- CSSOM ----------------------------------------------------------------

	client.Trap("CSSStyleRule.prototype.selectorText", {
		get(ctx) {
			return transformSelector(
				String(ctx.get()),
				toPage
			) as unknown as string;
		},
		set(ctx, value) {
			ctx.set(mangleSelector(String(value)) as any);
		},
	});
}

/**
 * `classList` is a live object the page may compare by identity, so we hand back one
 * stable Proxy per list rather than a fresh wrapper each access. The Proxy is needed
 * (rather than trapping `DOMTokenList.prototype`) for two reasons: indexed access is
 * an own property and cannot be trapped on the prototype, and the same prototype
 * backs `rel`, `sandbox` and `part`, whose tokens must not be touched.
 */
function installClassList(
	client: ScramjetClient,
	mangleClass: (token: string) => string,
	unmangleClass: (token: string) => string
) {
	const wrappers = new _WeakMap<object, object>([]);

	client.Trap("Element.prototype.classList", {
		get(ctx) {
			const list = ctx.get() as unknown as DOMTokenList;
			if (!list || typeof list !== "object") return list as any;
			const cached = wrappers.get(list);
			if (cached) return cached as any;

			const tokens = (): string[] => {
				const len = Reflect_get(list, "length") as number;
				const out: string[] = [];
				for (let i = 0; i < len; i++) {
					out.push(unmangleClass(String(Reflect_get(list, String(i)))));
				}

				return out;
			};

			const proxy: DOMTokenList = new Proxy(list, {
				get(target, prop) {
					if (prop === "value") {
						return mangleTokenList(
							String(Reflect_get(target, "value")),
							unmangleClass
						);
					}
					if (typeof prop === "string" && DIGITS.test(prop)) {
						const token = Reflect_get(target, prop);

						return typeof token === "string" ? unmangleClass(token) : token;
					}

					const value = Reflect_get(target, prop);
					if (typeof value !== "function") return value;

					if (prop === Symbol_iterator || prop === "values") {
						return function* () {
							yield* tokens();
						};
					}
					if (prop === "entries") {
						return function* () {
							const list = tokens();
							for (let i = 0; i < list.length; i++) yield [i, list[i]];
						};
					}
					if (prop === "forEach") {
						return function (
							cb: (token: string, index: number, parent: DOMTokenList) => void,
							thisArg?: unknown
						) {
							const list = tokens();
							for (let i = 0; i < list.length; i++) {
								Reflect_apply(cb, thisArg, [list[i], i, proxy]);
							}
						};
					}

					return new Proxy(value, {
						apply(fn, that, args) {
							// methods invoked through the wrapper must run on the real list
							const on = that === proxy ? target : that;
							switch (prop) {
								case "add":
								case "remove":
								case "supports":
									args = args.map((a) => mangleClass(String(a)));
									break;
								case "contains":
									args = [mangleClass(String(args[0]))];
									break;
								case "toggle":
									args = [mangleClass(String(args[0])), ...args.slice(1)];
									break;
								case "replace":
									args = [
										mangleClass(String(args[0])),
										mangleClass(String(args[1])),
									];
									break;
								case "item": {
									const token = Reflect_apply(fn, on, args);

									return typeof token === "string"
										? unmangleClass(token)
										: token;
								}
								case "toString":
									return mangleTokenList(
										String(Reflect_apply(fn, on, args)),
										unmangleClass
									);
							}

							return Reflect_apply(fn, on, args);
						},
					});
				},
				set(target, prop, value) {
					if (prop === "value") {
						(target as any).value = mangleTokenList(String(value), mangleClass);

						return true;
					}
					(target as any)[prop] = value;

					return true;
				},
			}) as unknown as DOMTokenList;

			wrappers.set(list, proxy);

			return proxy as any;
		},
	});
}

const DATA_PREFIX = "data-";

function camelToData(prop: string): string | null {
	let out = DATA_PREFIX;
	for (let i = 0; i < prop.length; i++) {
		const c = prop[i];
		if (c >= "A" && c <= "Z") out += "-" + c.toLowerCase();
		else if (c === "-") return null; // `-` is not allowed in a dataset key
		else out += c;
	}

	return out;
}

function dataToCamel(attr: string): string {
	let out = "";
	let upper = false;
	for (let i = DATA_PREFIX.length; i < attr.length; i++) {
		const c = attr[i];
		if (c === "-") {
			upper = true;
			continue;
		}
		out += upper ? c.toUpperCase() : c;
		upper = false;
	}

	return out;
}

/**
 * `dataset` reads and writes `data-*` attributes, whose names are mangled in the
 * document. Rather than mangling here, the proxy goes through `getAttribute` and
 * friends, which already translate names — so there is one place that decides how a
 * `data-*` name maps, not two.
 */
function installDataset(client: ScramjetClient) {
	const wrappers = new _WeakMap<object, object>([]);

	client.Trap("HTMLElement.prototype.dataset", {
		get(ctx) {
			const element = ctx.this as Element;
			const real = ctx.get() as unknown as object;
			if (!real || typeof real !== "object") return real as any;
			const cached = wrappers.get(real);
			if (cached) return cached as any;

			const proxy = new Proxy(real, {
				get(_target, prop) {
					if (typeof prop !== "string") return Reflect_get(_target, prop);
					const attr = camelToData(prop);
					if (attr === null) return undefined;
					const value = element.getAttribute(attr);

					return value === null ? undefined : value;
				},
				set(_target, prop, value) {
					if (typeof prop !== "string") return false;
					const attr = camelToData(prop);
					if (attr === null) return false;
					element.setAttribute(attr, String(value));

					return true;
				},
				has(_target, prop) {
					if (typeof prop !== "string") return false;
					const attr = camelToData(prop);

					return attr !== null && element.hasAttribute(attr);
				},
				deleteProperty(_target, prop) {
					if (typeof prop !== "string") return false;
					const attr = camelToData(prop);
					if (attr !== null) element.removeAttribute(attr);

					return true;
				},
				ownKeys() {
					// `getAttributeNames` is trapped, so these are already source names
					return element
						.getAttributeNames()
						.filter((n) => n.startsWith(DATA_PREFIX))
						.map(dataToCamel);
				},
				getOwnPropertyDescriptor(_target, prop) {
					if (typeof prop !== "string") return undefined;
					const attr = camelToData(prop);
					if (attr === null || !element.hasAttribute(attr)) return undefined;

					return {
						value: element.getAttribute(attr),
						writable: true,
						enumerable: true,
						configurable: true,
					};
				},
			});

			wrappers.set(real, proxy);

			return proxy as any;
		},
	});
}

/**
 * `observedAttributes` is read by the engine at define time and matched against the
 * names actually present on the element, which are mangled. Left alone, the list
 * would name attributes that no longer exist and `attributeChangedCallback` would
 * never fire, so the list is translated on the way in and the callback's `name`
 * argument translated back on the way out.
 */
function adaptObservedAttributes(mangler: Mangler, ctor: unknown) {
	if (typeof ctor !== "function") return;

	let observed: unknown;
	try {
		observed = (ctor as { observedAttributes?: unknown }).observedAttributes;
	} catch {
		return;
	}
	if (!Array_isArray(observed)) return;

	const mangleAttr = (name: string) => {
		const lower = String(name).toLowerCase();

		return shouldMangleAttr(lower, false) ? mangler.mangle("attr", lower) : name;
	};

	const mangled = Array_from(observed as unknown[], (name) =>
		mangleAttr(String(name))
	);
	Object_defineProperty(ctor, "observedAttributes", {
		get: () => mangled,
		configurable: true,
	});

	const proto = (ctor as { prototype?: Record<string, unknown> }).prototype;
	const callback = proto?.attributeChangedCallback;
	if (typeof callback !== "function") return;
	Object_defineProperty(proto, "attributeChangedCallback", {
		value: function (
			this: unknown,
			name: string,
			oldValue: string | null,
			newValue: string | null,
			namespace?: string | null
		) {
			return Reflect_apply(callback, this, [
				mangler.unmangle("attr", String(name)),
				oldValue,
				newValue,
				namespace,
			]);
		},
		writable: true,
		configurable: true,
	});
}
