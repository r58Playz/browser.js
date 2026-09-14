import { SCRAMJETCLIENT } from "@/symbols";
import type { ScramjetClient } from "@client/index";
import { Function_prototype_bind, Object_create } from "@/shared/snapshot";

/**
 * The origin a window is PRETENDING to be.
 *
 * Every guest is served from the same real origin -- the proxy's -- so the
 * browser's own same-origin check is satisfied between any two guest frames and
 * stops protecting anything. What separates them is the origin each one's
 * client was built with.
 *
 * Null means "no client, or not one of ours": an about:blank or srcdoc frame
 * inherits its creator's origin, and a frame that has not navigated has nothing
 * to hide. Inventing a boundary where the browser has none is its own
 * divergence, so null always answers "allowed".
 */
export function guestOrigin(win: Window): string | null {
	try {
		const sub = win[SCRAMJETCLIENT] as ScramjetClient | undefined;

		return sub ? sub.url.origin : null;
	} catch {
		return null;
	}
}

/** Would a browser have refused `win` to code running in `client`'s realm? */
export function crossOrigin(client: ScramjetClient, win: Window): boolean {
	const theirs = guestOrigin(win);

	return theirs !== null && theirs !== client.url.origin;
}

/**
 * The only properties a browser lets you touch on a cross-origin Window.
 *
 * https://html.spec.whatwg.org/#crossoriginproperties-(-o-) -- everything else
 * is a SecurityError, including `document`, which is the one that matters here:
 * measured live on rateyourmusic, the Turnstile widget
 * (challenges.cloudflare.com) could read `parent.document.title` and get
 * "Just a moment..." off the interstitial (rateyourmusic.com). No browser
 * permits that, and a challenge that tries it learns it is not in one.
 */
const ALLOWED = [
	"window",
	"self",
	"location",
	"close",
	"closed",
	"focus",
	"blur",
	"frames",
	"length",
	"top",
	"opener",
	"parent",
	"postMessage",
];

/** `location` cross-origin: a write-only door, per the same spec section. */
const LOCATION_ALLOWED = ["href", "replace"];

const windowCache = new WeakMap<Window, WeakMap<object, any>>();

/**
 * A Window as a cross-origin realm sees it.
 *
 * Cached per (target, client) pair rather than built per access. Two reads of
 * `parent` in a browser give the same object, and handing back a fresh Proxy
 * each time makes `a.parent === a.parent` false -- which is its own tell, and a
 * subtler one than the hole it was covering.
 */
export function crossOriginWindow(client: ScramjetClient, win: Window): any {
	let byClient = windowCache.get(win);
	if (!byClient) {
		byClient = new WeakMap();
		windowCache.set(win, byClient);
	}
	const hit = byClient.get(client);
	if (hit) return hit;

	const denied = (prop: string) =>
		client.errors.domException("SecurityError", {
			read: prop,
			on: "Window",
			detail:
				"Blocked a frame with a different origin from accessing a cross-origin frame.",
		});

	// The Location stand-in. `href` reads throw where writes are allowed, which
	// is the asymmetry the spec actually specifies and the reason this cannot
	// just be the real object with a filter on top.
	const location = new Proxy(Object_create(null), {
		get(_t, prop) {
			if (prop === "replace") {
				return function (url: string) {
					(win as any).location.replace(url);
				};
			}
			if (prop === "href") throw denied("location.href");
			if (typeof prop === "symbol") return undefined;
			throw denied(`location.${String(prop)}`);
		},
		set(_t, prop, value) {
			if (prop !== "href") throw denied(`location.${String(prop)}`);
			(win as any).location.href = value;

			return true;
		},
		has: (_t, prop) => LOCATION_ALLOWED.indexOf(String(prop)) !== -1,
		ownKeys: () => [],
		getOwnPropertyDescriptor: () => undefined,
	});

	const proxy = new Proxy(Object_create(null), {
		get(_t, prop, receiver) {
			// `then` has to be absent rather than throw, or awaiting anything
			// that reaches this object rejects instead of resolving.
			if (prop === "then") return undefined;
			if (typeof prop === "symbol") return undefined;
			const name = String(prop);
			if (ALLOWED.indexOf(name) === -1) throw denied(name);

			if (name === "location") return location;
			if (name === "window" || name === "self") return receiver;
			// Recursive, so walking up from a denied frame stays denied.
			if (name === "parent" || name === "top" || name === "opener") {
				const next = (win as any)[name];

				return next === win ? receiver : next;
			}
			const value = (win as any)[name];

			// Bound, because calling a Window method with this Proxy as the
			// receiver is an Illegal invocation -- the same mistake that made an
			// earlier attempt at this look like a hang.
			return typeof value === "function"
				? Function_prototype_bind.call(value, win)
				: value;
		},
		set(_t, prop) {
			throw denied(String(prop));
		},
		has: (_t, prop) => ALLOWED.indexOf(String(prop)) !== -1,
		// A browser reports no own keys and no descriptors across the boundary,
		// so enumeration finds nothing rather than throwing.
		ownKeys: () => [],
		getOwnPropertyDescriptor: () => undefined,
		getPrototypeOf: () => null,
	});

	byClient.set(client, proxy);

	return proxy;
}
