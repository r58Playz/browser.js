import { ScramjetClient } from "@client/index";
import {
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	Object_getPrototypeOf,
	Object_keys,
	Reflect_get,
	Reflect_ownKeys,
} from "@/shared/snapshot";

/**
 * Swap a global's value WITHOUT moving it in the property order.
 *
 * `delete` then assign is the obvious way and it is observable: the delete
 * gives up the property's place and the assignment appends the replacement at
 * the END of the object's ordering. Cloudflare's `/jsd/` payload enumerates
 * `window` and posts the list, and the two sides read
 *
 *   oracle  ..."crypto","indexedDB","localStorage","sessionStorage","chrome"...
 *   sandbox ..."crypto","indexedDB","chrome"..."speechSynthesis",
 *              "localStorage","sessionStorage","globalThis"...
 *
 * -- the two names moved to the end of the enumeration, in a payload the
 * server grades.
 *
 * `defineProperty` on a property that is still there keeps its place, and that
 * holds even when it turns an accessor into a data property. Redefined where
 * the property actually LIVES -- own if it is own, otherwise on the prototype
 * that declares it -- because defining an own property to shadow a prototype
 * one moves it just as much.
 *
 * Returns false when the property cannot be redefined, so the caller can fall
 * back to the old behaviour rather than silently not installing the shim.
 */
function replaceInPlace(target: object, key: string, value: unknown): boolean {
	let owner: object | null = target;
	let desc: PropertyDescriptor | undefined;
	while (owner) {
		desc = Object_getOwnPropertyDescriptor(owner, key);
		if (desc) break;
		owner = Object_getPrototypeOf(owner);
	}
	if (!owner || !desc || !desc.configurable) return false;

	if (desc.get || desc.set) {
		Object_defineProperty(owner, key, {
			get: () => value,
			set: desc.set,
			enumerable: desc.enumerable,
			configurable: desc.configurable,
		});
	} else {
		Object_defineProperty(owner, key, {
			value,
			writable: desc.writable,
			enumerable: desc.enumerable,
			configurable: desc.configurable,
		});
	}

	return true;
}

export default function (client: ScramjetClient, self: Self) {
	// `scopeUrl.host` rather than `url.host`: an about:blank frame's storage area is
	// its creator's, and its own URL has no host to key on - so every one of
	// them on every site would otherwise share the single "" namespace, which is
	// a cross-site read and write of both storage areas.
	//
	// TODO: this is a host, so `http://x` and `https://x` still share an area
	// where a browser gives them one each. Keying on the whole origin is the
	// fix and it invalidates everything already stored, so it wants doing
	// deliberately rather than as a side effect of this.
	const handler: ProxyHandler<Storage> = {
		get(target, prop) {
			switch (prop) {
				case "getItem":
					return (key: string) => {
						return target.getItem(client.scopeUrl.host + "@" + key);
					};

				case "setItem":
					return (key: string, value: string) => {
						return target.setItem(client.scopeUrl.host + "@" + key, value);
					};

				case "removeItem":
					return (key: string) => {
						return target.removeItem(client.scopeUrl.host + "@" + key);
					};

				case "clear":
					return () => {
						for (const key in Object_keys(target)) {
							if (key.startsWith(client.scopeUrl.host)) {
								target.removeItem(key);
							}
						}
					};

				case "key":
					return (index: number) => {
						const keys = Object_keys(target).filter((key) =>
							key.startsWith(client.scopeUrl.host)
						);

						return target.getItem(keys[index]);
					};

				case "length":
					return Object_keys(target).filter((key) =>
						key.startsWith(client.scopeUrl.host)
					).length;

				default:
					if (prop in Object.prototype || typeof prop === "symbol") {
						return Reflect_get(target, prop);
					}

					return target.getItem(client.scopeUrl.host + "@" + (prop as string));
			}
		},

		set(target, prop, value) {
			target.setItem(client.scopeUrl.host + "@" + (prop as string), value);

			return true;
		},

		has(target, prop) {
			return (
				target.getItem(client.scopeUrl.host + "@" + (prop as string)) !== null
			);
		},

		ownKeys(target) {
			return Reflect_ownKeys(target)
				.filter(
					(f) => typeof f === "string" && f.startsWith(client.scopeUrl.host)
				)
				.map((f) =>
					typeof f === "string"
						? f.substring(client.scopeUrl.host.length + 1)
						: f
				);
		},

		getOwnPropertyDescriptor(target, property) {
			// TODO: probably not right
			if (
				target.getItem(client.scopeUrl.host + "@" + (property as string)) ===
				null
			) {
				return undefined;
			}

			return {
				value: target.getItem(
					client.scopeUrl.host + "@" + (property as string)
				),
				enumerable: true,
				configurable: true,
				writable: true,
			};
		},

		defineProperty(target, property, attributes) {
			target.setItem(
				client.scopeUrl.host + "@" + (property as string),
				attributes.value
			);

			return true;
		},
	};

	const localStorageProxy = new Proxy(self.localStorage, handler);
	const sessionStorageProxy = new Proxy(self.sessionStorage, handler);

	if (!replaceInPlace(self, "localStorage", localStorageProxy)) {
		delete self.localStorage;
		self.localStorage = localStorageProxy;
	}
	if (!replaceInPlace(self, "sessionStorage", sessionStorageProxy)) {
		delete self.sessionStorage;
		self.sessionStorage = sessionStorageProxy;
	}
}
