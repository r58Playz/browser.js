import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
// import { argdbg } from "@client/shared/err";
import {
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	Object_getOwnPropertyNames,
	Object_keys,
	String_startsWith,
} from "@/shared/snapshot";

export function createWrapFn(client: ScramjetClient, self: GlobalThis) {
	let wrappedParent: GlobalThis | null = null;
	let wrappedTop: GlobalThis | null = null;
	if (iswindow) {
		try {
			if (SCRAMJETCLIENT in self.parent) {
				// ... then we're in a subframe, and the parent frame is also in a proxy context, so we should return its proxy
				wrappedParent = self.parent;
			} else {
				// ... then we should pretend we aren't nested and return the current window
				wrappedParent = self;
			}
		} catch {
			// accessing self.parent can throw if it's cross-origin, in which case we should also pretend we aren't nested
			wrappedParent = self;
		}
		// instead of returning top, we need to return the uppermost parent that's inside a scramjet context
		let current = self;
		for (;;) {
			const test = current.parent.self;
			if (test === current) break; // there is no parent, actual or emulated.

			try {
				// ... then `test` represents a window outside of the proxy context, and therefore `current` is the topmost window in the proxy context
				if (!(SCRAMJETCLIENT in test)) break;
			} catch {
				// accessing test can throw if it's cross-origin, in which case we should also break
				break;
			}
			// test is also insde a proxy, so we should continue up the chain
			current = test;
		}
		wrappedTop = current;
	}

	return function (identifier: any) {
		if (identifier === self.location) return client.locationProxy;
		if (identifier === self.eval) {
			return client.indirectEval;
		}
		if (iswindow) {
			if (identifier === self.parent) {
				return wrappedParent;
			} else if (identifier === self.top) {
				return wrappedTop;
			}
		}
		return identifier;
	};
}

export const order = 4;
export default function (client: ScramjetClient, self: GlobalThis) {
	Object_defineProperty(self, client.config.globals.wrapfn, {
		value: client.wrapfn,
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.wrappropertyfn, {
		value: function (str) {
			if (
				str === "location" ||
				str === "parent" ||
				str === "top" ||
				str === "eval"
			)
				return client.config.globals.wrappropertybase + str;

			return str;
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.cleanrestfn, {
		value: function (obj) {
			// TODO
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});

	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "location",
		{
			get: function () {
				// if (this.location.constructor.toString().includes("Location")) {

				if (this === self || this === self.document) {
					return client.locationProxy;
				}

				return this.location;
			},
			set(value: any) {
				if (this === self || this === self.document) {
					client.url = value;

					return;
				}
				this.location = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "parent",
		{
			get: function () {
				return client.wrapfn(this.parent);
			},
			set(value: any) {
				// i guess??
				this.parent = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "top",
		{
			get: function () {
				return client.wrapfn(this.top);
			},
			set(value: any) {
				this.top = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "eval",
		{
			get: function () {
				return client.wrapfn(this.eval);
			},
			set(value: any) {
				this.eval = value;
			},
			configurable: false,
			enumerable: false,
		}
	);

	self.$scramitize = function (v) {
		const t = typeof v;
		if (t === "object" && v !== null) {
			if (v === location) debugger;
			if (iswindow) {
				// if (v === self.parent) debugger;
				if (v === self.top) debugger;
			}
		} else if (t === "string") {
			if (v.includes("scramjet")) debugger;
			if (v.includes("~/sj")) debugger;
			if (v.includes(location.origin)) debugger;
		}

		return v;
	};

	// location = "..." can't be rewritten as wrapfn(location) = ..., so instead it will actually be rewritten as
	// ((t)=>$scramjet$tryset(location,"+=",t)||location+=t)(...);
	// it has to be a discrete function because there's always the possibility that "location" is a local variable
	// we have to use an IIFE to avoid duplicating side-effects in the getter
	Object_defineProperty(self, client.config.globals.trysetfn, {
		value: function (lhs: any, op: string, rhs: any) {
			if (client.box.locations.has(lhs)) {
				lhs.href = rhs;
				return true;
			}

			return false;
		},
		writable: false,
		configurable: false,
	});

	// Hide the shim's own globals from key enumeration.
	//
	// MOST are defined non-enumerable, so `Object.keys` and `for-in` miss them
	// -- but not all, and the ones that are not were the ones that leaked. The
	// bundler assigns `$scramjet` and `$scramjetController` as ordinary
	// properties (rspack `library.name`), so they are enumerable and a plain
	// `for (const k in window)` hands them straight back. Measured against
	// unmodified Chromium with `globals.html`: the oracle's for-in found
	// nothing and the sandbox's found `$scramjet,$scramjetController`, reported
	// as a T0 shim-identity leak.
	//
	// Trapping for-in is not possible, so the fix is to make the claim true --
	// sweep the global once and turn any enumerable `$scram*` into a
	// non-enumerable one, which for-in and Object.keys then skip for the same
	// reason the others are already skipped.
	//
	// `getOwnPropertyNames` and `Reflect.ownKeys` see
	// non-enumerable properties, and walking the global is the first thing any
	// fingerprinter does. Measured against unmodified Chromium, a page reading
	// `Object.getOwnPropertyNames(window)` got back `$scramjet`,
	// `$scramjetController`, `$scramjet$rewrite` and the rest by name, and
	// `Object.prototype` handed over `$scramjet__location` and its siblings.
	//
	// `$scram` is the prefix for every one of them -- `$scramjet*`, but also
	// `$scramitize`, `$scramerr` and `$scramdbg`, which a `$scramjet` test
	// missed and which showed up on the global by name. A page that has its own
	// is already broken under a proxy that claims the name.
	const isShimName = (k: unknown) =>
		typeof k === "string" && String_startsWith(k, "$scram");

	// The NATIVE getOwnPropertyNames deliberately: the proxied one below filters
	// these out, so asking through it would find nothing to fix.
	//
	// Run more than once, because not every one of these exists yet. A single
	// sweep at wrap time caught `$scramjet` and missed `$scramjetController`,
	// which is assigned later -- measured, for-in went from
	// `$scramjet,$scramjetController` to `$scramjetController`. So it also runs
	// on a microtask, and again whenever anything asks for the global's keys,
	// which is both where a fingerprinter looks and a point where the cost is
	// already being paid.
	const hideShimGlobals = () => {
		for (const key of Object_getOwnPropertyNames(client.global)) {
			if (!isShimName(key)) continue;
			const desc = Object_getOwnPropertyDescriptor(client.global, key);
			if (!desc || !desc.enumerable || !desc.configurable) continue;
			Object_defineProperty(client.global, key, {
				...desc,
				enumerable: false,
			});
		}
	};
	hideShimGlobals();
	queueMicrotask(hideShimGlobals);

	client.Proxy(["Object.getOwnPropertyNames", "Reflect.ownKeys"], {
		apply(ctx) {
			// Anything assigned since the last sweep, before it is handed back.
			hideShimGlobals();
			const keys = ctx.call() as (string | symbol)[];

			return ctx.return(keys.filter((k) => !isShimName(k)));
		},
	});

	client.Proxy("Object.getOwnPropertyDescriptors", {
		apply(ctx) {
			const descs = ctx.call() as Record<string, unknown>;
			for (const k of Object_keys(descs)) {
				if (isShimName(k)) delete descs[k];
			}

			return ctx.return(descs);
		},
	});
}
