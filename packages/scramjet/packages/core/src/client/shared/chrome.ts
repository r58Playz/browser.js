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
	// replace or unregister it.
	Reflect.deleteProperty(Navigator.prototype, "serviceWorker");

	// The Navigation API's ENTRY POINT, and only that.
	//
	// A navigation driven through `navigation` is not interceptable, so a guest
	// using it would leave the proxy. That is load-bearing and it stays gone;
	// the honest fix is to implement it, which is still true.
	//
	// The six interface objects beside it are not load-bearing. They are event
	// constructors and dictionary interfaces: `NavigateEvent` cannot navigate
	// anything without a `navigation` to dispatch it, and the other five are
	// not even constructible. Deleting them bought nothing and cost the exact
	// thing the note at the top of this file is about -- measured against
	// unmodified Chromium with `globals.html`, the guest's global was seven
	// names and 139 bytes short, and six of the seven were these. Cloudflare
	// enumerates `window` and puts the list in its payload.
	//
	// So: one missing name instead of seven, and the one that remains is the
	// one with a reason.
	del("navigation");
}
