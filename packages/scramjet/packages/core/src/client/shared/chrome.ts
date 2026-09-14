// Delete the APIs a proxy cannot let the guest reach.
//
// This used to remove every Chrome-specific API, on the reasoning that they are
// "not worth emulating and typically cause issues". The oracle disagrees: the
// user agent still says Chrome 155, and an interface a real Chrome has and this
// one does not is exactly what an anti-bot payload enumerates. Measured with
// `globals.html`, the guest's global had 1207 own properties against unmodified
// Chromium's 1236, and all 29 of the missing names came from this file --
// Bluetooth*, HID*, Presentation*, IdleDetector, BarcodeDetector,
// WindowControlsOverlay*. "Claims Chrome, missing Chrome's APIs" is a cheaper
// tell than anything those APIs could have leaked by being present.
//
// What stays deleted is what the proxy cannot survive:
//
//   Navigator.prototype.serviceWorker  the guest could unregister the worker
//                                      the sandbox is built on
//   the Navigation API                 navigations through it are not
//                                      interceptable, so the guest would leave
//                                      the proxy
//
// Both are still detectable, and deliberately so: they are load-bearing, and
// the honest fix for the Navigation API is to implement it rather than to
// delete it.

import { iswindow } from "@client/entry";
import { ScramjetClient } from "@client/index";
import {
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
} from "@/shared/snapshot";

// type self as any here, most of these are not defined in the types
export default function (client: ScramjetClient, self: any) {
	const del = (name: string) => {
		const split = name.split(".");
		const prop = split.pop();
		const target = split.reduce((a, b) => a?.[b], self);
		if (!target) return;
		if (prop && prop in target) {
			delete target[prop];
		} else {
		}
	};

	// obviously
	// del("chrome");

	// Background synchronisation. Gated on a permission that never resolves
	// under a proxy, so leaving it present would hang a page that waits on it.
	if (iswindow) {
		del("ServiceWorkerRegistration.prototype.sync");
	}

	if (!iswindow) return;
	// DOM specific ones below here

	// The worker the sandbox is built on. The guest must not be able to reach,
	// replace or unregister it -- but it must still SEE that `serviceWorker`
	// exists, because deleting it is a tell and a measured one.
	//
	// Cloudflare's challenge enumerates navigator. Captured live off the
	// passing side, its payload carries the property names it found, bucketed:
	//
	//   {"payload":{"0":["length","innerWidth",...,"n.maxTouchPoints"],...}}
	//
	// `n.` is navigator, and `Object.getOwnPropertyNames(Navigator.prototype)`
	// read 71 on unmodified Chromium against 70 here -- the one missing name
	// being this. A browser on a secure context always has it.
	//
	// So it is present and it does nothing: `controller` is null and
	// `getRegistration` finds nothing, which is exactly what a page with no
	// registration of its own sees, and `register` is refused. The real
	// container is still reachable through the proxy's own captured reference
	// (`ScramjetClient.serviceWorker`, taken in the constructor before this
	// runs) and through `inject.ts`, which already falls back to the worker it
	// captured rather than trusting `controller`.
	//
	// A Proxy rather than a hand-built object, so the prototype, the brand
	// checks and every member not named here stay the browser's own.
	const nativeDescriptor = Object_getOwnPropertyDescriptor(
		Navigator.prototype,
		"serviceWorker"
	);
	const real = nativeDescriptor?.get?.call(self.navigator);
	Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
	if (nativeDescriptor?.get && real) {
		// Never settles, which is what `ready` does when nothing is registered.
		const ready = new Promise(() => {});
		const container = new Proxy(real, {
			get(target, prop) {
				if (prop === "controller") return null;
				if (prop === "ready") return ready;
				if (prop === "register") {
					return () =>
						Promise.reject(
							new self.DOMException(
								"Failed to register a ServiceWorker: the operation is not supported.",
								"NotSupportedError"
							)
						);
				}
				if (prop === "getRegistration") return () => Promise.resolve(undefined);
				if (prop === "getRegistrations") return () => Promise.resolve([]);
				const value = Reflect.get(target, prop);

				// Bound, because a method taken off a Proxy and called with the
				// Proxy as `this` fails the brand check.
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		Object_defineProperty(Navigator.prototype, "serviceWorker", {
			get: () => container,
			set: undefined,
			enumerable: nativeDescriptor.enumerable,
			configurable: nativeDescriptor.configurable,
		});
	}
}
