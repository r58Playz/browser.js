import { ScramjetClient } from "@client/index";
import { Tap } from "@/Tap";
import { iswindow } from "@client/entry";
import {
	Reflect_apply,
	Object_setPrototypeOf,
	_URL,
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
} from "@/shared/snapshot";

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
	// location's own names sees its absence. Exposed only when the browser's
	// own list is EMPTY, which is the case scramjet can answer honestly: the
	// guest is presented as a top-level document, so an empty list is the right
	// answer AND the native object is already it. A non-empty one belongs to
	// the harness's frames and would name the proxy's origin, which is worse
	// than the property being missing -- so that case keeps the old behaviour.
	const ancestors = iswindow
		? (self.location as unknown as Location).ancestorOrigins
		: undefined;
	if (ancestors && ancestors.length === 0)
		unforgeable("ancestorOrigins", ancestors);

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
