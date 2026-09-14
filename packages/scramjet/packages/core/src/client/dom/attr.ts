import { ScramjetClient } from "@client/index";
import {
	Number,
	Object_keys,
	Reflect_apply,
	Reflect_get,
	Reflect_has,
	Reflect_ownKeys,
} from "@/shared/snapshot";

/**
 * Where a renamed attribute lives. Must match `element.ts`.
 *
 * The rewriter moves an attribute the browser would otherwise act on -- `nonce`
 * above all, CSP consumes it -- to `scramjet-attr-<name>`, and the shims answer
 * from there. The map used to drop the alias and leave nothing behind, so the
 * attribute was gone from `attributes`, from its `length`, and from every index
 * walk, while `getAttribute` still returned its value.
 */
const ALIAS = "scramjet-attr-";

/**
 * Attributes that are the PROXY's own, surfaced under no name at all.
 *
 * `scramjet-injected` does not start with the alias prefix, so filters keyed on
 * that prefix never hid it -- Cloudflare's enumeration read
 * `["src","scramjet-injected"]` straight off scramjet's script tags. Must match
 * `proxyOnly` in `element.ts`.
 */
const proxyOnly = (name: string): boolean =>
	name === "scramjet-injected" ||
	name === `${ALIAS}script-source-src` ||
	name === "script-source-src";

export default function (client: ScramjetClient) {
	client.Trap("Element.prototype.attributes", {
		get(ctx) {
			const map = ctx.get() as NamedNodeMap;

			/**
			 * The native index keys that survive, in native order.
			 *
			 * Computed from the target rather than through `Object.keys` of the
			 * proxy, because the proxy reports CONTIGUOUS indices to the page --
			 * a map with a renamed attribute at native index 1 must still look
			 * like 0,1,2 from outside, or `Object.keys(el.attributes)` reads
			 * "0,2" where a browser says "0,1".
			 */
			const visible = (): string[] => {
				const out: string[] = [];
				const length = Number(Reflect_get(map, "length"));
				for (let i = 0; i < length; i++) {
					const name = map[i]?.name;
					if (typeof name !== "string") continue;
					if (proxyOnly(name)) continue;
					if (!name.startsWith(ALIAS)) {
						out.push(String(i));
						continue;
					}
					// An alias stands in for its attribute unless the real one
					// is there too, in which case it is a second copy and the
					// page should not see it.
					if (!Reflect_has(map, name.slice(ALIAS.length))) out.push(String(i));
				}

				return out;
			};

			const proxy = new Proxy(map, {
				get(target, prop, _receiver) {
					const value = Reflect_get(target, prop);

					if (prop === "length") {
						return visible().length;
					}

					if (prop === "getNamedItem") {
						return (name: string) => proxy[name] ?? null;
					}
					if (prop === "getNamedItemNS") {
						return (namespace: string, name: string) =>
							proxy[`${namespace}:${name}`] ?? null;
					}
					// `item` is the same lookup as `[i]` and has to remap the
					// same way; passing it through handed back the attribute at
					// the NATIVE index, alias and all.
					if (prop === "item") {
						return (index: number) => {
							const position = visible()[index];

							return position === undefined ? null : map[position];
						};
					}

					if (prop in NamedNodeMap.prototype && typeof value === "function") {
						return new Proxy(value, {
							apply(target, that, args) {
								if (that === proxy) {
									return Reflect_apply(target, map, args);
								}

								return Reflect_apply(target, that, args);
							},
						});
					}

					if (
						(typeof prop === "string" || typeof prop === "number") &&
						!isNaN(Number(prop))
					) {
						const position = visible()[prop];

						return position === undefined ? undefined : map[position];
					}

					// A renamed attribute answers to its real name.
					if (typeof prop === "string" && !this.has(target, prop)) {
						return undefined;
					}
					if (
						typeof prop === "string" &&
						!Reflect_has(target, prop) &&
						Reflect_has(target, `${ALIAS}${prop}`)
					) {
						return map[`${ALIAS}${prop}`];
					}

					return value;
				},
				ownKeys(_target) {
					// Contiguous, because that is what the page sees of any
					// other element's map.
					const keys: string[] = [];
					const count = visible().length;
					for (let i = 0; i < count; i++) keys.push(String(i));

					return keys;
				},
				getOwnPropertyDescriptor(target, prop) {
					if (typeof prop === "string" && !isNaN(Number(prop))) {
						const position = visible()[prop];
						if (position === undefined) return undefined;

						return {
							value: map[position],
							writable: false,
							enumerable: true,
							configurable: true,
						};
					}

					return Reflect.getOwnPropertyDescriptor(target, prop);
				},
				has(target, prop) {
					if (typeof prop === "symbol") return Reflect_has(target, prop);
					if (prop.startsWith(ALIAS) || proxyOnly(prop)) return false;
					// An alias whose real attribute is absent IS that attribute,
					// so the map has to answer to the real name. Hiding the
					// alias and having nothing under the real name is how a
					// `nonce` the page wrote disappeared from `attributes`
					// entirely while `getAttribute` still returned it.
					if (Reflect_has(target, `${ALIAS}${prop}`)) return true;
					const named = map[prop]?.name;
					if (named?.startsWith(ALIAS)) {
						return !Reflect_has(target, named.slice(ALIAS.length));
					}

					return Reflect_has(target, prop);
				},
			});

			return proxy;
		},
	});

	client.Trap(["Attr.prototype.name", "Attr.prototype.localName"], {
		get(ctx) {
			const name = ctx.get() as string;
			if (typeof name !== "string" || !name.startsWith(ALIAS)) return name;
			const real = name.slice(ALIAS.length);
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const owner = ctx.this?.ownerElement;
			if (owner && new client.native.Element(owner).hasAttribute(real)) {
				return name;
			}

			return real;
		},
	});

	client.Trap(["Attr.prototype.value", "Attr.prototype.nodeValue"], {
		get(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (ctx.this?.ownerElement) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return ctx.this.ownerElement.getAttribute(ctx.this.name);
			}

			return ctx.get();
		},
		set(ctx, value) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (ctx.this?.ownerElement) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return ctx.this.ownerElement.setAttribute(ctx.this.name, value);
			}

			return ctx.set(value);
		},
	});
}
