/**
 * The guest-op seam: one hook, at the one place every interception installs.
 *
 * `ScramjetClient.installNative` is the single point `Proxy`, `Trap` and
 * `Intercept` all put a patched member back through -- it exists so a page
 * cannot tell from the shape of a member which of the three touched it. That
 * makes it the one place that can wrap ALL of them, and the reason this is
 * eight lines of scramjet rather than three separate edits to three funnels
 * that would each have to be kept in step.
 *
 * What it buys: the differ can compare an intercepted API at all. Without it
 * the guest's call reaches a trap, the trap calls the native, and the native's
 * trace record has scramjet's script on top -- so a differ that pairs guest
 * calls against guest calls sees zero of them on the sandbox side. On
 * rateyourmusic that was 43 APIs and 1344 calls in the page realm alone,
 * reported as `missing-call` and baselined into silence.
 *
 * Inert unless the harness installed a recorder: one symbol lookup, once, at
 * install time. Nothing is added to the hot path of a normal build -- the
 * wrapper functions below are never created when the symbol is absent.
 *
 * The recorder itself is NOT here. It lives in the runway harness
 * (`sbxdiff-guestop.js`), because it is measurement apparatus and scramjet
 * should not ship it. This file is only the seam.
 */

const GUESTOP = Symbol.for("sbxdiff.guestop");

type Recorder = {
	/** Runs `fn`, records it if this is the OUTERMOST interception. */
	around<T>(member: string, op: string, args: unknown[], fn: () => T): T;
	note(member: string, kind: string): void;
};

/**
 * Resolved once, lazily, rather than captured at module load.
 *
 * The harness's probe runs with scramjet's bootstrap, and module evaluation
 * order between the two is not something to depend on. Reading it on the first
 * `installNative` is after the probe and before any guest code.
 */
let resolved: Recorder | null | undefined;

function recorder(): Recorder | null {
	if (resolved === undefined) {
		resolved =
			(globalThis as unknown as Record<symbol, Recorder | undefined>)[
				GUESTOP
			] ?? null;
	}

	return resolved;
}

/**
 * Record one guest op directly, for a seam that is not a descriptor install.
 *
 * The rewriter's `$scramjet$location`, `$scramjet$parent` and `$scramjet$top`
 * accessors are the other half of the interception surface: guest code that
 * writes `location` is REWRITTEN to read one of them, so no interceptor is
 * involved and `installNative` never sees it. They are also where the largest
 * remaining hole was -- 67 `window.location` reads on rateyourmusic with no
 * sandbox counterpart -- and where the cross-origin boundary is decided.
 *
 * Takes the member name per call rather than per install, because one accessor
 * answers for two APIs: `$scramjet$location` on the window is
 * `Window.location.get` and on the document is `HTMLDocument.location.get`,
 * and the oracle records those separately.
 *
 * Inert, and free, when no recorder is installed.
 */
export function guestOpAround<T>(
	member: string,
	op: string,
	args: unknown[],
	fn: () => T
): T {
	const rec = recorder();

	return rec ? rec.around(member, op, args, fn) : fn();
}

/**
 * Wrap a descriptor about to be installed so every guest entry through it is
 * recorded.
 *
 * Mutates in place: the caller is `installNative`, which owns this descriptor
 * and has not defined it yet.
 *
 * `get`/`set`/`value` and nothing else. A data property whose value is not
 * callable is left alone -- there is no call to record -- and so is a
 * descriptor with neither half, which `installNative` refuses anyway.
 */
export function recordGuestOps(
	native: { debugname: string; key: string | symbol; owner?: unknown },
	next: PropertyDescriptor
): void {
	const rec = recorder();
	if (!rec) return;
	const member = memberName(native);

	if (typeof next.get === "function") {
		const inner = next.get;
		rec.note(member, "get");
		next.get = function (this: unknown) {
			return rec.around(member, "get", [], () => inner.call(this));
		};
	}
	if (typeof next.set === "function") {
		const inner = next.set;
		rec.note(member, "set");
		next.set = function (this: unknown, v: unknown) {
			return rec.around(member, "set", [v], () => inner.call(this, v));
		};
	}
	if (typeof next.value === "function") {
		const inner = next.value as (...a: unknown[]) => unknown;
		rec.note(member, "call");
		// A plain function, not a Proxy: the value here is ALREADY a Proxy over
		// the native (that is what `RawProxy` and `Intercept` install), and
		// wrapping a Proxy in another Proxy doubles every trap the page can
		// observe. A function forwards `new.target` badly, so a constructor
		// member keeps its Proxy untouched -- `construct` is recorded by the
		// funnel itself, not here.
		//
		// `Function.prototype.toString` on this would render the wrapper, so
		// the unproxy table scramjet keeps for `shared/sourcemaps.ts` is what
		// answers instead, and it maps the Proxy, which is unchanged.
		if (!isConstructorish(inner)) {
			next.value = function (this: unknown, ...args: unknown[]) {
				return rec.around(member, "call", args, () => inner.apply(this, args));
			};
			// Carry the identity a page can read off a function. Without these
			// the wrapper reports `length 0` and the wrong `name`, which is a
			// difference a fingerprinter reads directly.
			try {
				Object.defineProperty(next.value, "name", {
					value: inner.name,
					configurable: true,
				});
				Object.defineProperty(next.value, "length", {
					value: inner.length,
					configurable: true,
				});
			} catch {
				/* frozen in some engine; the name is a nicety, not the point */
			}
		}
	}
}

/**
 * The name to record this member under.
 *
 * Most call sites pass a dotted `debugname` and it is used as-is. Some do not:
 * `element.ts` traps `host`, `pathname` and the rest of the URL properties in a
 * loop over several interfaces, `event.ts` traps every `on*` handler the same
 * way, and `memory.ts` traps `performance.memory`. Those arrive as a bare
 * property name, which maps to `Window.host` -- a member no browser has, and a
 * name the oracle's trace can never match, so the op would read as "the
 * sandbox never did this".
 *
 * The owner knows. `resolveNative` has already walked to the object that really
 * owns the member, which is the interface prototype, and reading its
 * `constructor.name` happens once at install time -- before any guest code
 * exists to have replaced it.
 */
function memberName(native: {
	debugname: string;
	key: string | symbol;
	owner?: unknown;
}): string {
	const key = String(native.key);
	if (native.debugname && native.debugname.includes("."))
		return native.debugname;
	const owner = native.owner as { constructor?: { name?: string } } | undefined;
	let iface: string | undefined;
	try {
		iface = owner?.constructor?.name;
	} catch {
		/* a getter that throws; fall through to the bare name */
	}

	return iface ? `${iface}.${key}` : native.debugname || key;
}

/**
 * Does this look like something the page will `new`?
 *
 * A wrapper built from a plain function cannot stand in for a constructor --
 * `new` through it throws or loses `new.target` -- so constructors are left
 * with their own Proxy, which handles `construct` correctly. The test is the
 * presence of a non-writable `prototype`, which is what a class and a native
 * constructor have and an ordinary method does not.
 */
function isConstructorish(fn: (...a: unknown[]) => unknown): boolean {
	const d = Object.getOwnPropertyDescriptor(fn, "prototype");

	return !!d && d.writable === false;
}
