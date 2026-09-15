import { ScramjetClient } from "@client/index";
import { Tap } from "@/Tap";
import { recordGuestOps } from "@client/guestop";
import { iswindow } from "@client/entry";
import {
	Reflect_apply,
	Reflect_get,
	Reflect_has,
	Object_setPrototypeOf,
	_URL,
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
} from "@/shared/snapshot";

/**
 * A `DOMStringList` that answers with `origins` instead of its own contents.
 *
 * A Proxy over the REAL list rather than a plain object, because the brand is
 * readable: `Object.prototype.toString.call(location.ancestorOrigins)` says
 * `[object DOMStringList]` and `instanceof DOMStringList` holds, and a
 * stand-in built from `{}` fails both. The proxy forwards everything it does
 * not answer, so it keeps the prototype chain it was minted with.
 *
 * `length`, `item()`, `contains()` and the indices, which is the whole
 * interface.
 */
function makeAncestorOrigins(
	native: DOMStringList,
	origins: string[]
): DOMStringList {
	return new Proxy(native, {
		get(target, prop, receiver) {
			if (prop === "length") return origins.length;
			if (prop === "item") {
				return function item(i: number) {
					// The spec returns null past the end, not undefined.
					return origins[i] ?? null;
				};
			}
			if (prop === "contains") {
				return function contains(s: string) {
					return origins.indexOf(String(s)) !== -1;
				};
			}
			if (typeof prop === "string" && /^\d+$/.test(prop)) {
				return origins[Number(prop)];
			}

			return Reflect_get(target, prop, receiver);
		},
		has(target, prop) {
			if (typeof prop === "string" && /^\d+$/.test(prop)) {
				return Number(prop) < origins.length;
			}

			return Reflect_has(target, prop);
		},
		ownKeys() {
			return [...origins.map((_, i) => String(i)), "length"];
		},
		getOwnPropertyDescriptor(_target, prop) {
			if (prop === "length") {
				return {
					value: origins.length,
					writable: false,
					enumerable: false,
					configurable: true,
				};
			}
			if (typeof prop === "string" && /^\d+$/.test(prop)) {
				const i = Number(prop);
				if (i >= origins.length) return undefined;

				return {
					value: origins[i],
					writable: false,
					enumerable: true,
					configurable: true,
				};
			}

			return undefined;
		},
	});
}

export function createLocationProxy(client: ScramjetClient, self: GlobalThis) {
	const Location = iswindow ? self.Location : self.WorkerLocation;
	// location cannot be Proxy()d
	const fakeLocation: any = {};
	Object_setPrototypeOf(fakeLocation, Location.prototype);
	// `constructor` is NOT one of location's own properties -- it is reached
	// through the prototype, which the line above already set. Assigning it
	// here put an own `constructor` on the object that
	// `Object.getOwnPropertyNames(location)` reported and no browser has.

	// for some reason it's on the object for Location and on the prototype for WorkerLocation??
	const descriptorSource = iswindow ? self.location : Location.prototype;
	const urlprops = [
		"protocol",
		"hash",
		"host",
		"hostname",
		"href",
		"origin",
		"pathname",
		"port",
		"search",
	];
	for (const prop of urlprops) {
		const native = Object_getOwnPropertyDescriptor(descriptorSource, prop);
		if (!native) continue;

		const desc: Partial<PropertyDescriptor> = {
			configurable: false,
			enumerable: true,
		};
		if (native.get) {
			desc.get = new Proxy(native.get, {
				apply() {
					return client.url[prop];
				},
			});
		}
		if (native.set) {
			desc.set = new Proxy(native.set, {
				apply(target, that, args) {
					if (prop === "href") {
						// special case
						client.url = args[0];

						return;
					}
					if (prop === "hash") {
						self.location.hash = args[0];
						Tap.dispatch(
							client.hooks.lifecycle.navigate,
							{
								type: "hashchange",
							},
							{
								url: client.url.href,
							}
						);

						return;
					}
					const url = new _URL(client.url.href);
					url[prop] = args[0];
					client.url = url;
				},
			});
		}
		// The guest-op recorder, if the harness installed one.
		//
		// `location` does not go through `installNative` -- it cannot be
		// Proxy()d, so scramjet builds a stand-in object and defines onto that
		// directly -- so the one hook in `installNative` does not reach it.
		// It is also the API where the gap matters most: scramjet answers
		// `hostname`, `search` and `referrer` out of the URL string it already
		// holds, touching no native at all, so there is no binding record on
		// either side to compare. Measured on rateyourmusic:
		// `Location.hostname.get` 35 calls on the oracle against 0 anywhere in
		// the sandbox.
		recordGuestOps({ debugname: `Location.${prop}`, key: prop }, desc);
		Object_defineProperty(fakeLocation, prop, desc);
	}

	/**
	 * Every member of `Location` is unforgeable, methods included.
	 *
	 * `location.idl` marks the whole interface `[LegacyUnforgeable]`, which
	 * makes each member an OWN property of the location object that is not
	 * writable and not configurable -- a page cannot replace `location.reload`,
	 * and cannot redefine it either. The URL accessors below already say
	 * `configurable: false`; the methods were plain assignments, so they came
	 * out writable and configurable.
	 *
	 * That is one `Object.defineProperty` away from being read:
	 *
	 *     try { Object.defineProperty(location, "reload", { value: f }); }
	 *     catch (e) { /* a real browser lands here *\/ }
	 *
	 * Measured while hooking `location.reload` to trace a Cloudflare challenge:
	 * the oracle threw `TypeError: Cannot redefine property: reload` and the
	 * sandbox accepted the redefinition. The probe was trying to instrument the
	 * page and instead found the proxy.
	 */
	const unforgeable = (name: string, value: unknown, enumerable = true) => {
		Object_defineProperty(fakeLocation, name, {
			value,
			writable: false,
			enumerable,
			configurable: false,
		});
	};

	// functions
	unforgeable(
		"toString",
		new Proxy(self.location.toString, {
			apply() {
				return client.url.href;
			},
		})
	);

	// `valueOf` IS one of location's own properties, and the one member that is
	// not enumerable. It is nowhere in `location.idl` -- V8 puts it there as
	// part of the same hardening that makes the rest unforgeable, so it has to
	// be read off the browser rather than derived from the interface.
	// Removing it on the grounds that Object.prototype would answer the same
	// way was wrong, and `Object.getOwnPropertyNames(location)` said so.
	if (self.location.valueOf)
		unforgeable(
			"valueOf",
			new Proxy(self.location.valueOf, {
				apply() {
					return fakeLocation;
				},
			}),
			false
		);

	// `ancestorOrigins` is unforgeable too, and a page that enumerates
	// location's own names sees its absence.
	//
	// The native list names the HARNESS's frames, so it cannot be handed over.
	// It used to be exposed only when it was empty and left undefined
	// otherwise -- which is the case of an embedded guest, and therefore the
	// case that matters. Measured inside Cloudflare's Turnstile widget, which
	// is embedded cross-origin by the page it guards (FINDINGS.md #246):
	//
	//     oracle    ancestorOrigins  https://rateyourmusic.com
	//     sandbox   ancestorOrigins  undefined
	//
	// A widget whose sitekey is bound to the embedding domain has every reason
	// to read that, and `location.ancestorOrigins[0]` THROWS where a browser
	// answers -- which is worse than a wrong string.
	//
	// The honest answer is the guest chain: walk the real frame tree and take
	// each ancestor's GUEST origin, stopping at the first frame that is not a
	// guest, which is the harness. So a guest nested in a guest reports what a
	// browser would report, and the proxy's own origin never appears.
	const ancestors = iswindow
		? (self.location as unknown as Location).ancestorOrigins
		: undefined;
	if (ancestors) {
		const origins: string[] = [];
		try {
			// `self` is typed as the guest global; the map is keyed on the same
			// objects, so this is a spelling difference rather than a cast away
			// from anything real.
			let win = self as unknown as Self;
			// Bounded rather than `while`: a frame tree is not deep, and a
			// cycle here would hang the page rather than report one.
			for (let depth = 0; depth < 64; depth++) {
				// The NATIVE parent. `self.parent` is scramjet's own shim by
				// this point, and asking it would walk the guest's idea of the
				// tree rather than the one the origins have to come from.
				const parent: Self = new client.native.window(win).parent;
				if (!parent || parent === win) break;
				const owner = client.box.globals.get(parent);
				// Not a guest: the harness frame the proxy runs in. Everything
				// above it belongs to the proxy and none of it is the page's
				// business.
				if (!owner) break;
				origins.push(owner.url.origin);
				win = parent;
			}
		} catch {
			// A frame the walk is not allowed to touch. An empty list is then
			// the only answer that is certainly not a lie.
		}
		unforgeable("ancestorOrigins", makeAncestorOrigins(ancestors, origins));
	}

	if (self.location.assign)
		unforgeable(
			"assign",
			new Proxy(self.location.assign, {
				apply(target, that, args) {
					args[0] = client.rewriteUrl(args[0]);
					Reflect_apply(target, self.location, args);
					Tap.dispatch(
						client.hooks.lifecycle.navigate,
						{
							type: "location",
						},
						{
							url: client.url.href,
						}
					);
				},
			})
		);
	if (self.location.reload)
		unforgeable(
			"reload",
			new Proxy(self.location.reload, {
				apply(target, that, args) {
					Reflect_apply(target, self.location, args);
				},
			})
		);
	if (self.location.replace)
		unforgeable(
			"replace",
			new Proxy(self.location.replace, {
				apply(target, that, args) {
					args[0] = client.rewriteUrl(args[0]);
					Reflect_apply(target, self.location, args);

					Tap.dispatch(
						client.hooks.lifecycle.navigate,
						{
							type: "location",
						},
						{
							url: client.url.href,
						}
					);
				},
			})
		);

	// TODO: ancestorOrigins

	return fakeLocation;
}
