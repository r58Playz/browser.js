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

	// The name the PAGE wrote, not the name the rewriter wrote.
	//
	// Guest code saying `w.eval` is rewritten to `w.$scramjet__eval`
	// (`config.globals.wrappropertybase`), so a denial built from the property
	// actually read reports
	//
	//     Failed to read the '$scramjet__eval' property from 'Window'
	//
	// where a browser says `'eval'`. Measured inside Cloudflare's Turnstile,
	// which surfaces it through its own handler as "[Cloudflare Turnstile]
	// Unhandled error" -- so the shim's identity reaches guest code in a string
	// the page is holding, which is the leak class the differ calls T0
	// (FINDINGS.md #253). The denial itself is correct and a browser throws it
	// too; only the name was wrong.
	const base = client.config.globals.wrappropertybase;
	const denied = (prop: string) =>
		client.errors.domException("SecurityError", {
			read: base && prop.startsWith(base) ? prop.slice(base.length) : prop,
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
			// Recursive, so walking up from a denied frame stays denied -- and
			// under the experiment, through `guestWindow`, so what comes back is
			// the same object every other surface hands back. Returning the raw
			// window here is a third way for the set to be inconsistent from
			// inside the thing meant to enforce it.
			if (name === "parent" || name === "top" || name === "opener") {
				const next = (win as any)[name];
				if (next === win) return receiver;

				return gatingWindowIdentity() ? guestWindow(client, next) : next;
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

/**
 * EXPERIMENT, default OFF. See FINDINGS.md #251.
 *
 * Gating `contentWindow` the way `parent` is gated closes the window-identity
 * set that RULES #191 asks for -- and hangs the sandbox: the widget realm never
 * came into existence and the viewport sat on one image for 533 seconds. The
 * comment in `dom/element.ts` predicted exactly that and named the missing
 * prerequisite: a way to tell the proxy's OWN reads of this accessor from the
 * guest's.
 *
 * Two mechanisms are readable in the code and this switch exists to tell them
 * apart by measurement rather than by argument:
 *
 *   1. The proxy returns `bind(value, win)` for function members, so
 *      `contentWindow.postMessage` becomes a BOUND NATIVE and never reaches
 *      `client.Proxy("window.postMessage")` -- the shim that stamps
 *      `$scramjet$origin` onto every message. Without that envelope the
 *      receiver's `origin` accessor falls through to `client.url.origin`.
 *   2. `controller/src/index.ts` reads `contentWindow.history` and
 *      `.location.reload`, neither of which the cross-origin allow-list has.
 *
 * Turned on by a probe rather than a config flag because it is not a feature:
 * `harness/scramjet/public/sbxdiff-gatecw.js` sets the symbol, and nothing sets
 * it in an ordinary build.
 */
const GATE_CONTENT_WINDOW = Symbol.for("sbxdiff.gate-contentwindow");

export function gatingWindowIdentity(): boolean {
	try {
		return !!(globalThis as unknown as Record<symbol, unknown>)[
			GATE_CONTENT_WINDOW
		];
	} catch {
		return false;
	}
}

/**
 * The object the GUEST should see for `win`, from `client`'s realm.
 *
 * Same-origin windows come back unchanged; a cross-origin one comes back as the
 * cached proxy, so every surface that uses this agrees on identity.
 */
export function guestWindow<T>(client: ScramjetClient, win: T): T {
	if (!win) return win;
	try {
		return crossOrigin(client, win as unknown as Window)
			? (crossOriginWindow(client, win as unknown as Window) as T)
			: win;
	} catch {
		return win;
	}
}
