/**
 * The differ: two traces in, tiered and bucketed divergences out.
 *
 * Two things it is deliberately NOT:
 *
 * - It never normalizes before comparing. Comparison is literal; `diffClass`
 *   runs strictly *after* a comparison has already failed and only chooses a
 *   bucket name. That is enforced by types here -- `classify` takes a
 *   `Divergence`, never two `Value`s (RULES.md #5, #6).
 * - It never compares whole trace files. A run contains realms the page does
 *   not own (browser UI, extensions) which are nondeterministic by nature;
 *   only the guest realm is comparable. See `selectGuestRealm`.
 */

import { Kind, Tag, type Record_, type Trace, type Value } from "./trace.ts";

export type Tier = "T0" | "T1" | "T2" | "T3" | "T4";

export type DiffKind =
	| "leak"
	| "value-divergence"
	| "type-change"
	| "threw-divergence"
	| "novelty-divergence"
	| "identity-divergence"
	| "missing-call"
	| "extra-call"
	| "exception-divergence"
	| "net-divergence";

export type DiffClass =
	| "proxy-url-leak"
	| "chrome-origin-leak"
	| "shim-identity-leak"
	| "absolute-vs-relative"
	| "empty-vs-value"
	| "numeric-delta"
	| "type-change"
	| "identity"
	| "novelty"
	| "count"
	| "other";

export type Divergence = {
	tier: Tier;
	kind: DiffKind;
	/** Interned API name, e.g. `Document.title.get`. */
	api: string;
	/** Ordinal of this call within its API's sequence. */
	at: number;
	oracle?: string;
	sandbox?: string;
	detail?: string;
	class: DiffClass;
	/** `(tier, kind, api, class)` -- what a baseline suppresses on. */
	bucket: string;
};

/**
 * Strings that must never be visible to guest code. A hit is T0: the sandbox
 * has leaked its own existence, which is a failure of the sandbox's entire
 * purpose and is not a difference of opinion about an API's value.
 */
export type LeakMarkers = {
	/** Origin the sandbox itself is served from, e.g. `http://localhost:4500`. */
	chromeOrigin: string;
	/** Proxy path prefix, e.g. `/~/sj/`. */
	proxyPrefix: string;
	/** Identifiers that only exist inside the shim. */
	shimIdentifiers: string[];
};

export const DEFAULT_SHIM_IDENTIFIERS = [
	"$scramjet",
	"ScramjetClient",
	"scramjet client global",
	"__scramjet",
	"$scramjetController",
];

function fmt(v: Value): string {
	switch (v.t) {
		case Tag.Undefined:
			return "undefined";
		case Tag.Null:
			return "null";
		case Tag.Bool:
			return String(v.v);
		case Tag.Number:
			return Object.is(v.v, -0) ? "-0" : String(v.v);
		case Tag.String:
			return `string(${v.len})${JSON.stringify(v.s)}${v.truncated ? "…" : ""}`;
		case Tag.BigInt:
			return "bigint";
		case Tag.Symbol:
			return "symbol";
		case Tag.Object:
			return `object#${v.id}`;
		case Tag.DomWrapper:
			return `${v.iface}#${v.id}`;
		case Tag.Function:
			return `function#${v.id}`;
		case Tag.Proxy:
			return `proxy#${v.id}`;
		case Tag.Opaque:
			return "opaque";
	}
}

/** Strings a value carries, for leak scanning. Never enumerates contents. */
function stringOf(v: Value): string | null {
	return v.t === Tag.String ? v.s : null;
}

/**
 * Pick the realm the guest page owns.
 *
 * The URL differs between runs by construction -- the sandbox serves the page
 * from a proxied URL -- so this matches on the caller's hint and falls back to
 * "the realm with the most records", which is the page rather than an
 * `about:blank` shell in every run measured.
 */
export function selectGuestRealm(
	trace: Trace,
	hint: (url: string) => boolean
): { realm: number; url: string } | null {
	const counts = new Map<number, number>();
	for (const r of trace.records) {
		if (r.kind === Kind.BindingCall || r.kind === Kind.Interceptor)
			counts.set(r.realm, (counts.get(r.realm) ?? 0) + 1);
	}
	let best: { realm: number; url: string; n: number } | null = null;
	for (const [realm, url] of trace.realms) {
		if (!hint(url)) continue;
		const n = counts.get(realm) ?? 0;
		if (!best || n > best.n) best = { realm, url, n };
	}
	return best ? { realm: best.realm, url: best.url } : null;
}

export type Side = {
	trace: Trace;
	realm: number;
	url: string;
	/**
	 * `reqBodyKey(url, ordinal)` -> FNV-1a of the body this side posted there.
	 *
	 * A request body is guest-observable output in the strongest sense: it is
	 * what the page TELLS the server about itself. Two runs that agree on every
	 * API call but post different bytes have diverged somewhere the API trace
	 * did not reach.
	 */
	reqBodies: Map<string, string>;
};

type Call = {
	seq: number;
	recv: Value;
	result: Value;
	args: Value[];
	threw: boolean;
	/** True when the guest itself made this call, with no shim frame on top. */
	guestDirect: boolean;
};

/** Ordered per-API call sequences for one realm. */
function apiSequences(
	side: Side,
	attribution?: Attribution
): Map<string, Call[]> {
	const out = new Map<string, Call[]>();
	for (const r of side.trace.records) {
		if (r.kind !== Kind.BindingCall) continue;
		if (r.realm !== side.realm) continue;
		let list = out.get(r.name);
		if (!list) out.set(r.name, (list = []));
		list.push({
			seq: r.seq,
			recv: r.recv,
			result: r.result,
			args: r.args,
			threw: r.threw,
			guestDirect: isGuestDirect(r, attribution),
		});
	}
	return out;
}

function objectId(v: Value): number | null {
	switch (v.t) {
		case Tag.Object:
		case Tag.DomWrapper:
		case Tag.Function:
		case Tag.Proxy:
			// 0 means "unidentified" (non-wrapper), not "object zero".
			return v.id === 0 ? null : v.id;
		default:
			return null;
	}
}

/**
 * Cross-run object bijection with a novelty bit.
 *
 * Ids are run-local and assigned in first-sighting order, so they can only be
 * paired positionally as the streams align. A bijection alone cannot see "the
 * sandbox minted a fresh object where the oracle returned a cached one" when
 * the fresh object is never seen again -- hence `novel`, which is the highest
 * yield addition to it.
 */
class Bijection {
	private readonly fwd = new Map<number, number>();
	private readonly inv = new Map<number, number>();
	private readonly seenO = new Set<number>();
	private readonly seenS = new Set<number>();
	/** Where a binding was first established, for provenance in the report. */
	private readonly witness = new Map<number, string>();

	/** Returns a divergence kind, or null if consistent. */
	relate(
		o: Value,
		s: Value,
		where: string
	): {
		kind: "identity-divergence" | "novelty-divergence";
		detail: string;
	} | null {
		const oi = objectId(o);
		const si = objectId(s);
		if (oi === null || si === null) return null;

		const oNovel = !this.seenO.has(oi);
		const sNovel = !this.seenS.has(si);
		this.seenO.add(oi);
		this.seenS.add(si);

		if (oNovel !== sNovel) {
			return {
				kind: "novelty-divergence",
				detail: oNovel
					? "oracle returned a fresh object where the sandbox reused one"
					: "sandbox minted a fresh object where the oracle reused one",
			};
		}

		const bound = this.fwd.get(oi);
		if (bound === undefined) {
			const takenBy = this.inv.get(si);
			if (takenBy !== undefined && takenBy !== oi) {
				return {
					kind: "identity-divergence",
					detail: `sandbox #${si} is already bound to oracle #${takenBy} (at ${this.witness.get(takenBy)}); used here where oracle #${oi} is expected`,
				};
			}
			this.fwd.set(oi, si);
			this.inv.set(si, oi);
			this.witness.set(oi, where);
			return null;
		}
		if (bound !== si) {
			return {
				kind: "identity-divergence",
				detail: `oracle #${oi} was bound to sandbox #${bound} (at ${this.witness.get(oi)}); here it is sandbox #${si}`,
			};
		}
		return null;
	}
}

/** Literal comparison. Returns null when equal; never normalizes. */
function compare(o: Value, s: Value): DiffKind | null {
	if (o.t !== s.t) return "type-change";
	switch (o.t) {
		case Tag.Bool:
			return o.v === (s as typeof o).v ? null : "value-divergence";
		case Tag.Number: {
			const b = (s as typeof o).v;
			return Object.is(o.v, b) ? null : "value-divergence";
		}
		case Tag.String: {
			const b = s as typeof o;
			return o.s === b.s && o.len === b.len ? null : "value-divergence";
		}
		// Identity is handled by the bijection, not here; two object values of
		// the same tag are "equal" at this layer by construction.
		default:
			return null;
	}
}

function classify(d: {
	kind: DiffKind;
	oracle?: string;
	sandbox?: string;
	markers: LeakMarkers;
}): DiffClass {
	const s = d.sandbox ?? "";
	const o = d.oracle ?? "";
	if (s.includes(d.markers.proxyPrefix)) return "proxy-url-leak";
	if (d.markers.chromeOrigin && s.includes(d.markers.chromeOrigin))
		return "chrome-origin-leak";
	if (d.markers.shimIdentifiers.some((i) => s.includes(i)))
		return "shim-identity-leak";
	switch (d.kind) {
		case "type-change":
			return "type-change";
		case "identity-divergence":
			return "identity";
		case "novelty-divergence":
			return "novelty";
		case "missing-call":
		case "extra-call":
			return "count";
	}
	const oEmpty = o === "undefined" || o === "null" || /^string\(0\)/.test(o);
	const sEmpty = s === "undefined" || s === "null" || /^string\(0\)/.test(s);
	if (oEmpty !== sEmpty) return "empty-vs-value";
	if (/^string/.test(o) && /^string/.test(s)) {
		const oAbs = /"https?:\/\//.test(o);
		const sAbs = /"https?:\/\//.test(s);
		if (oAbs !== sAbs) return "absolute-vs-relative";
	}
	if (/^-?[\d.]+$/.test(o) && /^-?[\d.]+$/.test(s)) return "numeric-delta";
	return "other";
}

function bucketOf(d: Omit<Divergence, "bucket">): string {
	return `${d.tier}|${d.kind}|${d.api}|${d.class}`;
}

/**
 * Leak scan: absolute, not differential.
 *
 * This needs only the sandbox trace. A guest-observable string containing the
 * chrome origin, the proxy prefix or a shim identifier is a failure on its own
 * terms -- there is no "but the oracle does it too" defence -- so it is checked
 * before any alignment and can never be suppressed by a baseline.
 */
export function scanLeaks(side: Side, markers: LeakMarkers): Divergence[] {
	const out: Divergence[] = [];
	const seen = new Set<string>();

	const check = (api: string, what: string, v: Value) => {
		const s = stringOf(v);
		if (!s) return;
		let cls: DiffClass | null = null;
		if (s.includes(markers.proxyPrefix)) cls = "proxy-url-leak";
		else if (markers.chromeOrigin && s.includes(markers.chromeOrigin))
			cls = "chrome-origin-leak";
		else if (markers.shimIdentifiers.some((i) => s.includes(i)))
			cls = "shim-identity-leak";
		if (!cls) return;
		const bucket = `T0|leak|${api}|${cls}`;
		if (seen.has(bucket + s)) return;
		seen.add(bucket + s);
		out.push({
			tier: "T0",
			kind: "leak",
			api,
			at: 0,
			sandbox: `${what}=${JSON.stringify(s.slice(0, 200))}`,
			class: cls,
			detail: "guest-observable string reveals the sandbox",
			bucket,
		});
	};

	for (const r of side.trace.records) {
		if (r.kind === Kind.BindingCall) {
			if (r.realm !== side.realm) continue;
			check(r.name, "result", r.result);
			r.args.forEach((a, i) => check(r.name, `arg${i}`, a));
		} else if (r.kind === Kind.Interceptor) {
			if (r.realm !== side.realm) continue;
			if (r.written) check(r.name, "written", r.written);
		}
	}
	return out;
}

/**
 * The guest-observation layer.
 *
 * This is the distinction that makes the sandbox comparable at all. In the
 * sandbox the shim and the guest share one realm and one binding stream, so a
 * *binding-layer* value is not a guest-observable value: scramjet's traps
 * return a rewritten answer to the guest while the native underneath
 * legitimately reports the proxied URL. Treating the binding layer as
 * guest-observable reports every one of those as a leak, which is wrong.
 *
 * So the probe pages funnel each fact they observe through a sink -- by default
 * `document.title = "<key>=<value>"`. Whatever reaches the sink is by
 * construction what the *guest* computed, whatever the shim did underneath.
 * Those are compared by key, not by position, so an extra or missing
 * observation cannot shift everything after it.
 *
 * Attributing raw binding calls to guest vs. shim needs guest-op brackets from
 * the shim (plan P6); until that exists the binding layer is reported, but at a
 * lower tier and never as T0.
 */
export const GUEST_SINK = "Document.title.set";

export type Observation = { key: string; value: string };

export function guestObservations(
	side: Side,
	sink = GUEST_SINK
): Observation[] {
	const out: Observation[] = [];
	for (const r of side.trace.records) {
		if (r.kind !== Kind.BindingCall || r.realm !== side.realm) continue;
		if (r.name !== sink) continue;
		const a = r.args[0];
		if (!a || a.t !== Tag.String) continue;
		// Split on the FIRST separator: values routinely contain "=" (query
		// strings, base64), keys never may. A page that writes a key
		// containing "=" gets a wrong split, so keys are checked by the
		// probe pages, not sanitized here.
		const eq = a.s.indexOf("=");
		if (eq < 0) continue;
		out.push({ key: a.s.slice(0, eq), value: a.s.slice(eq + 1) });
	}
	return out;
}

function leakClassOf(s: string, markers: LeakMarkers): DiffClass | null {
	if (s.includes(markers.proxyPrefix)) return "proxy-url-leak";
	if (markers.chromeOrigin && s.includes(markers.chromeOrigin))
		return "chrome-origin-leak";
	if (markers.shimIdentifiers.some((i) => s.includes(i)))
		return "shim-identity-leak";
	return null;
}

/**
 * Compare what the guest actually observed. Keyed, so order is not load-bearing
 * and a missing observation is reported as itself rather than as a cascade.
 */
export function diffObservations(
	oracle: Observation[],
	sandbox: Observation[],
	markers: LeakMarkers
): Divergence[] {
	const out: Divergence[] = [];
	const push = (d: Omit<Divergence, "bucket">) =>
		out.push({ ...d, bucket: bucketOf(d) });
	const sMap = new Map(sandbox.map((o) => [o.key, o.value]));
	const oMap = new Map(oracle.map((o) => [o.key, o.value]));

	for (const { key, value: ov } of oracle) {
		const sv = sMap.get(key);
		if (sv === undefined) {
			push({
				tier: "T1",
				kind: "missing-call",
				api: `guest:${key}`,
				at: 0,
				oracle: ov,
				sandbox: "(never observed)",
				class: "count",
			});
			continue;
		}
		if (sv === ov) continue;
		// A leak in a value the guest itself read is T0 -- the sandbox has
		// revealed its own existence to the code it is supposed to contain.
		const leak = leakClassOf(sv, markers);
		push({
			tier: leak ? "T0" : "T1",
			kind: leak ? "leak" : "value-divergence",
			api: `guest:${key}`,
			at: 0,
			oracle: ov,
			sandbox: sv,
			class:
				leak ??
				classify({
					kind: "value-divergence",
					oracle: ov,
					sandbox: sv,
					markers,
				}),
			detail: leak ? "the guest itself observed this string" : undefined,
		});
	}
	for (const { key, value: sv } of sandbox) {
		if (oMap.has(key)) continue;
		push({
			tier: "T1",
			kind: "extra-call",
			api: `guest:${key}`,
			at: 0,
			oracle: "(never observed)",
			sandbox: sv,
			class: "count",
		});
	}
	return out;
}

/**
 * Script attribution: whose code is this?
 *
 * In a sandbox the shim and the guest share a realm, so "which realm" answers
 * nothing. "Which script" does. Every compared record carries two ids: the
 * script on top of the stack, and the script that entered the task.
 *
 * The pair is what matters, not either alone:
 *
 * | entry | top   | meaning                                              |
 * |-------|-------|------------------------------------------------------|
 * | guest | guest | the guest called a native directly -- **comparable**  |
 * | guest | shim  | the shim acting for the guest (a trap) -- the guest's |
 * |       |       | answer is the trap's return, not this native's        |
 * | shim  | shim  | the shim's own work (its startup platform snapshot)   |
 *
 * Only the first row is guest-observable at the binding layer, and that is the
 * row this promotes. It is what lets a real page be compared without the
 * cooperating `document.title` sink the probe pages use.
 */
export type ScriptClass = "guest" | "shim" | "unknown";

export function classifyScripts(
	trace: Trace,
	isGuestUrl: (url: string) => boolean
): Map<number, ScriptClass> {
	const out = new Map<number, ScriptClass>();
	for (const [id, url] of trace.scripts) {
		// An empty script URL is an inline or eval'd script with no sourceURL.
		// It is deliberately "unknown" rather than guessed: in the sandbox
		// scramjet rewrites guest inline scripts, so guessing by realm would
		// attribute shim-rewritten code to the guest.
		out.set(id, url === "" ? "unknown" : isGuestUrl(url) ? "guest" : "shim");
	}
	return out;
}

export type Attribution = {
	/** script id -> who owns it. */
	classes: Map<number, ScriptClass>;
};

function classOf(a: Attribution | undefined, id: number): ScriptClass {
	if (!a) return "unknown";
	// 0 means no JS was on the stack: the binding was reached from C++
	// (parser-driven work, a platform callback). Not the shim's doing and not
	// the guest's either.
	if (id === 0) return "unknown";
	return a.classes.get(id) ?? "unknown";
}

/**
 * True when the guest called this native itself, with no shim frame on top.
 *
 * Only `top` is tested, and that is deliberate. `entry_script` was designed to
 * mean "whose work is this task", but measurement showed it does not: in the
 * sandbox scramjet's controller enters essentially every task, so `entry` is
 * shim for guest code too. Requiring `entry == guest` classified *zero* sandbox
 * records as guest.
 *
 * `top == guest` is the criterion that actually carries the meaning. At a
 * native call the topmost JS frame is guest code, which means no shim trap
 * intervened -- if scramjet had trapped this API, its trap would be the frame
 * making the native call. Shim frames *below* the guest are fine and expected;
 * they are the shim having invoked guest code (an event handler, a timer).
 *
 * `entry_script` is still recorded: it is free (captured once per task) and it
 * is what tells you which side started a task.
 */
export function isGuestDirect(
	rec: { topScript: number; entryScript: number },
	a: Attribution | undefined
): boolean {
	return classOf(a, rec.topScript) === "guest";
}

export type DiffOptions = {
	markers: LeakMarkers;
	/** API carrying guest observations; see GUEST_SINK. */
	sink?: string;
	/** Per-side script attribution. Without it everything stays at T2. */
	oracleAttribution?: Attribution;
	sandboxAttribution?: Attribution;
	/**
	 * APIs whose sandbox-side sequence is longer by construction (the shim does
	 * extra work through the same native). Extra calls on these are T4.
	 */
	shimBusyApis?: Set<string>;
};

export function diff(
	oracle: Side,
	sandbox: Side,
	opts: DiffOptions
): Divergence[] {
	const out: Divergence[] = [];
	const push = (d: Omit<Divergence, "bucket">) =>
		out.push({ ...d, bucket: bucketOf(d) });

	// The layer that decides pass/fail: what the guest itself observed.
	out.push(
		...diffObservations(
			guestObservations(oracle, opts.sink),
			guestObservations(sandbox, opts.sink),
			opts.markers
		)
	);

	const oSeq = apiSequences(oracle, opts.oracleAttribution);
	const sSeq = apiSequences(sandbox, opts.sandboxAttribution);
	const attributed = !!(opts.oracleAttribution && opts.sandboxAttribution);
	const bij = new Bijection();
	const apis = [...new Set([...oSeq.keys(), ...sSeq.keys()])].sort();

	for (const api of apis) {
		const o = oSeq.get(api) ?? [];
		const s = sSeq.get(api) ?? [];
		const n = Math.min(o.length, s.length);

		for (let i = 0; i < n; i++) {
			const oc = o[i];
			const sc = s[i];

			if (oc.threw !== sc.threw) {
				push({
					tier: "T2",
					kind: "threw-divergence",
					api,
					at: i,
					oracle: oc.threw ? "threw" : "returned",
					sandbox: sc.threw ? "threw" : "returned",
					class: "other",
				});
			}

			const vk = compare(oc.result, sc.result);
			if (vk) {
				const oracleS = fmt(oc.result);
				const sandboxS = fmt(sc.result);
				const cls = classify({
					kind: vk,
					oracle: oracleS,
					sandbox: sandboxS,
					markers: opts.markers,
				});
				// With attribution, a call BOTH sides made directly from guest
				// code is guest-observable: there is no trap in between whose
				// return could differ from the native's. Those get judged.
				// Everything else stays T2 -- a binding-layer difference under a
				// shim frame is expected and says nothing on its own.
				const guestObservable = attributed && oc.guestDirect && sc.guestDirect;
				const leak =
					guestObservable &&
					(cls === "proxy-url-leak" ||
						cls === "chrome-origin-leak" ||
						cls === "shim-identity-leak");
				push({
					tier: leak ? "T0" : guestObservable ? "T1" : "T2",
					kind: leak ? "leak" : vk,
					api,
					at: i,
					oracle: oracleS,
					sandbox: sandboxS,
					class: cls,
					detail: leak
						? "guest code read this native directly; no trap in between"
						: undefined,
				});
			}

			const argN = Math.min(oc.args.length, sc.args.length);
			for (let a = 0; a < argN; a++) {
				const ak = compare(oc.args[a], sc.args[a]);
				if (!ak) continue;
				const oracleS = fmt(oc.args[a]);
				const sandboxS = fmt(sc.args[a]);
				push({
					tier: "T2",
					kind: ak,
					api: `${api}#arg${a}`,
					at: i,
					oracle: oracleS,
					sandbox: sandboxS,
					class: classify({
						kind: ak,
						oracle: oracleS,
						sandbox: sandboxS,
						markers: opts.markers,
					}),
				});
			}

			const idk = bij.relate(oc.result, sc.result, `${api}[${i}]`);
			if (idk) {
				push({
					tier: "T2",
					kind: idk.kind,
					api,
					at: i,
					oracle: fmt(oc.result),
					sandbox: fmt(sc.result),
					detail: idk.detail,
					class: idk.kind === "identity-divergence" ? "identity" : "novelty",
				});
			}
		}

		if (o.length !== s.length) {
			const missing = s.length < o.length;
			// scramjet snapshots the whole platform surface at startup
			// (`nativeStore`), which reads a few hundred `Window.<Interface>`
			// constructor getters the oracle never touches. That is one
			// phenomenon, not 1169 findings, so it gets one bucket.
			const snapshot =
				(!missing && o.length === 0 && /^Window\.[A-Z]/.test(api)) ||
				// With attribution, extra calls none of which the guest made
				// directly are shim work by definition.
				(attributed && !missing && s.every((c) => !c.guestDirect));
			push({
				tier: snapshot ? "T4" : "T2",
				kind: missing ? "missing-call" : "extra-call",
				api: snapshot ? "Window.<interface> (platform snapshot)" : api,
				at: n,
				oracle: `${o.length} calls`,
				sandbox: `${s.length} calls`,
				class: "count",
				detail: snapshot
					? "shim reads the platform surface at startup; expected"
					: undefined,
			});
		}
	}

	return out;
}

export type Report = {
	divergences: Divergence[];
	buckets: Map<string, { tier: Tier; count: number; sample: Divergence }>;
};

export function bucketize(divergences: Divergence[]): Report {
	const buckets = new Map<
		string,
		{ tier: Tier; count: number; sample: Divergence }
	>();
	for (const d of divergences) {
		const b = buckets.get(d.bucket);
		if (b) b.count++;
		else buckets.set(d.bucket, { tier: d.tier, count: 1, sample: d });
	}
	return { divergences, buckets };
}

const TIER_ORDER: Tier[] = ["T0", "T1", "T2", "T3", "T4"];

export function formatReport(report: Report, baseline?: Set<string>): string {
	const lines: string[] = [];
	const shown = [...report.buckets.entries()].filter(
		([k, v]) => v.tier === "T0" || !baseline?.has(k)
	);
	const suppressed = report.buckets.size - shown.length;

	shown.sort(
		(a, b) =>
			TIER_ORDER.indexOf(a[1].tier) - TIER_ORDER.indexOf(b[1].tier) ||
			b[1].count - a[1].count
	);

	for (const tier of TIER_ORDER) {
		const inTier = shown.filter(([, v]) => v.tier === tier);
		if (!inTier.length) continue;
		lines.push(`\n${tier}  (${inTier.length} buckets)`);
		for (const [key, v] of inTier) {
			const d = v.sample;
			lines.push(`  ${d.kind}  ${d.api}  [${d.class}]  x${v.count}`);
			if (d.oracle !== undefined) lines.push(`      oracle : ${d.oracle}`);
			if (d.sandbox !== undefined) lines.push(`      sandbox: ${d.sandbox}`);
			if (d.detail) lines.push(`      ${d.detail}`);
			lines.push(`      bucket: ${key}`);
		}
	}
	if (suppressed)
		lines.push(
			`\n${suppressed} bucket(s) matched the baseline and were suppressed.`
		);
	if (!shown.length) lines.push("\nNo divergences outside the baseline.");
	return lines.join("\n");
}
