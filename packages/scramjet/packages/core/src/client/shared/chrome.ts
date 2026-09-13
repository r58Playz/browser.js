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

	// Navigation API. Not Chrome-only, and not cosmetic either: a navigation
	// driven through it is not interceptable, so a guest using it would leave
	// the proxy. Deleting it is detectable -- see the note at the top -- and
	// the fix is to implement it.
	del("navigation");
	del("NavigateEvent");
	del("NavigationActivation");
	del("NavigationCurrentEntryChangeEvent");
	del("NavigationDestination");
	del("NavigationHistoryEntry");
	del("NavigationTransition");
}
