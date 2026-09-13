/**
 * sbxdiff driver: run one page in bare Chromium and in scramjet, diff them.
 *
 *   pnpm runway sbxdiff                      # run the probe, print the report
 *   pnpm runway sbxdiff --baseline           # record the current buckets as expected
 *   pnpm runway sbxdiff --page other.html
 *
 * Both runs use the *same* patched binary and the *same* run key; the only
 * difference is which harness loads the page. That is what makes a divergence
 * attributable to the sandbox rather than to the browser.
 */

import express from "express";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startHarness, PORT as SJ_PORT } from "../harness/scramjet/index.ts";
import { startBareHarness, BARE_PORT } from "../harness/bare/index.ts";
import {
	bucketize,
	classifyScripts,
	diff,
	formatReport,
	selectGuestRealm,
	DEFAULT_SHIM_IDENTIFIERS,
	type Divergence,
	type LeakMarkers,
	type Side,
} from "./diff.ts";
import { loadTraces, mergeTraces, runChromium } from "./run.ts";
import { loadStore, mountStoreEndpoint, reqBodyKey } from "./store.ts";

const HERE = import.meta.dirname;
/** Where the probe pages are served from. The "site under test". */
const SITE_PORT = 4510;

// Known-and-accepted buckets, and buckets the oracle cannot reproduce against
// ITSELF -- both per target host.
//
// Per host because a bucket key is `tier|kind|api|class` with no page in it. A
// baseline recorded on rateyourmusic silently suppressed 28 probe-page buckets
// the first time the two shared one file, which is exactly the failure mode a
// baseline is supposed to prevent.
// host plus path, so two probe pages on the same origin do not share one file
// either -- `--page csp.html --baseline` would otherwise overwrite probe.html's.
function targetKey(target: string) {
	const u = new URL(target);
	const rest = u.pathname.replace(/^\/+/, "").replace(/[^a-zA-Z0-9.]+/g, "-");

	return rest ? `${u.hostname}.${rest}` : u.hostname;
}

function baselineFile(target: string) {
	return path.join(HERE, `baseline.${targetKey(target)}.json`);
}

// Buckets the oracle cannot reproduce against ITSELF, from --self-check
// --baseline. Kept apart from baseline.json on purpose: a baselined bucket is
// "known and accepted", whereas one in here is "the oracle has nothing to say",
// and conflating the two would let a real sandbox bug hide behind oracle noise
// without that ever being visible in the output.
function noiseFile(target: string) {
	return path.join(HERE, `noise.${targetKey(target)}.json`);
}

/**
 * Wall-clock epoch ms the virtual clock starts at when there is no store to
 * take it from. Arbitrary, and fine for a local probe page.
 */
const DEFAULT_TIME_BASE = 1700000000000;

/**
 * A store records WHEN it was captured, and a replay adopts that time.
 *
 * Recorded responses are not timeless. A Cloudflare challenge embeds tokens
 * minted at capture time and its script compares them against the device
 * clock; replaying those bytes under a clock pinned to some unrelated constant
 * makes the page reject its own challenge for having the wrong device time.
 * The same applies to anything else with an expiry -- cookies, JWTs, cache
 * validators.
 */
const TIME_BASE_FILE = "sbxdiff-time-base.json";

async function readTimeBase(dir: string): Promise<number | undefined> {
	try {
		const raw = JSON.parse(
			await readFile(path.join(dir, TIME_BASE_FILE), "utf8")
		);
		return typeof raw.initialTimeMs === "number"
			? raw.initialTimeMs
			: undefined;
	} catch {
		return undefined;
	}
}
/** Where the oracle run records responses for the sandbox to replay. */
const STORE = path.join(HERE, ".traces", "store");
/** Filled by the store endpoint; a nonzero count means the runs saw different bytes. */
const storeMisses: string[] = [];
// Served from a recording whose URL differs in exactly one path segment. Real
// divergences -- a client-minted random id the two sides cannot agree on --
// reported apart from hits so they never pass as clean.
const storeNears: string[] = [];
// Served the LAST recording because the page asked more times than the
// recording did. The store's most dangerous leniency: for a site whose last
// recorded response is the destination, a page stuck in a retry loop is handed
// that destination and looks like it arrived.
const storePastEnds: string[] = [];
// The sandbox posted something other than what the recording posted, and was
// handed the recorded response anyway. The store cannot grade a request, so
// this is the only thing that separates "produced the same answer" from "was
// told what it wanted to hear".
const storeBodyMismatches: string[] = [];
// url#ordinal -> FNV-1a of the body the SANDBOX posted there, for every
// body-carrying request. Paired against the oracle's own hashes, which come
// out of its stderr. See `reqBodyKey`.
const sandboxReqBodies = new Map<string, string>();

async function startSite(store: Awaited<ReturnType<typeof loadStore>>) {
	const app = express();
	mountStoreEndpoint(
		app,
		store,
		storeMisses,
		storeNears,
		storePastEnds,
		storeBodyMismatches,
		sandboxReqBodies
	);
	// A 302 to a real script, so `blankframe.html` can test the shape
	// Cloudflare's JS detections actually have: the URL a page injects is a
	// redirect, and a delegated load has to follow it the way the browser's own
	// would. Declared before the static mount so it wins over any file.
	app.get("/redir-marker.js", (_req, res) => {
		res.redirect(302, "/marker2.js");
	});
	app.use(express.static(path.join(HERE, "pages")));
	// A 1x1 PNG, so `img.src` resolves against something real.
	app.get("/asset.png", (_req, res) => {
		res
			.type("png")
			.send(
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
					"base64"
				)
			);
	});
	await new Promise<void>((r) => app.listen(SITE_PORT, r));
	console.log(`    Site under test on port ${SITE_PORT}`);
}

type RunSpec = {
	label: string;
	/** null = navigate straight to the target, with no harness frame. */
	harnessUrl: string | null;
	/** Recognizes the realm the guest page owns in this run. */
	guest: (url: string) => boolean;
	/** Only the oracle records; the sandbox replays through its transport. */
	netRecord?: string;
	virtualTime?: boolean;
	/** Epoch ms the virtual clock starts at. See TIME_BASE_FILE. */
	initialTimeMs?: number;
	profileDir?: string;
	vtFence?: boolean;
	softMiss?: boolean;
	/** Real-time grace after the page stops loading, before the browser quits. */
	graceMs?: number;
	vtPolicy?: "deterministic" | "advance" | "pause";
	vtBudget?: number;
	/** URL substring of this run's guest realm; virtual time starts there. */
	vtAfter?: string;
	headed?: boolean;
	click?: string;
	clickFrame?: string;
	netReplay?: string;
};

async function capture(spec: RunSpec, target: string, runKey: string) {
	const dir = path.join(HERE, ".traces", spec.label);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });

	// base64, so the target does not appear literally in the harness page's own
	// URL -- --sbxdiff-virtual-time-after matches on a URL substring and an
	// embedded copy made the harness match as the guest realm.
	const url = spec.harnessUrl
		? `${spec.harnessUrl}#b64:${Buffer.from(target).toString("base64")}`
		: target;
	const t0 = Date.now();
	const { stderr } = await runChromium({
		url,
		traceDir: dir,
		runKey,
		graceMs: spec.graceMs ?? 3000,
		netRecord: spec.netRecord,
		netReplay: spec.netReplay,
		headed: spec.headed,
		profileDir: spec.profileDir,
		softMiss: spec.softMiss,
		click: spec.click,
		clickFrame: spec.clickFrame,
		// Virtual time needs the `advance` policy here. The default,
		// kDeterministicLoading, pauses the clock while a load is outstanding,
		// which deadlocks any load served by a worker that needs timers to make
		// progress. Both sides get identical settings either way -- asymmetric
		// clocks would diverge on every timing-derived value.
		...(spec.virtualTime
			? {
					initialTimeMs: spec.initialTimeMs ?? DEFAULT_TIME_BASE,
					virtualTimeBudgetMs: spec.vtBudget ?? 30000,
					virtualTimePolicy: spec.vtPolicy ?? "advance",
					virtualTimeAfter: spec.vtAfter,
					virtualTimeFence: spec.vtFence,
				}
			: {}),
		timeoutMs: 90000,
	});

	if (process.env.SBXDIFF_VERBOSE) {
		await writeFile(path.join(dir, "stderr.log"), stderr);
	}
	// The oracle's request bodies never touch the store server -- it replays
	// inside the network service -- so its hashes come back the only way they
	// can, printed to stderr. Parsed unconditionally: this is the reference the
	// sandbox is scored against, not a debugging aid to switch on later.
	const reqBodies = new Map<string, string>();
	for (const line of stderr.split("\n")) {
		const m = /sbxdiff: replay REQBODY #(\d+) (\S+) (\S+)$/.exec(line.trim());
		if (m) reqBodies.set(reqBodyKey(m[3], Number(m[1])), m[2]);
	}
	const traces = await loadTraces(dir);
	const merged = mergeTraces(traces);
	const found = selectGuestRealm(merged, spec.guest);
	console.log(
		`    ${spec.label}: ${traces.length} file(s), ${merged.records.length} records, ${Date.now() - t0}ms`
	);
	if (!found) {
		console.log(`      realms seen: ${[...merged.realms.values()].join(", ")}`);
		throw new Error(`${spec.label}: no guest realm matched`);
	}
	console.log(`      guest realm r${found.realm} -> ${found.url}`);
	return {
		trace: merged,
		realm: found.realm,
		url: found.url,
		reqBodies,
	} satisfies Side;
}

async function main() {
	const args = process.argv.slice(2);
	const recordBaseline = args.includes("--baseline");
	// On by default: a pinned clock is the point of the oracle, and it now
	// produces the same diff as a real-clock run (1191/1/1 either way) with
	// Date.now() reproducible to ~1 ms. --no-virtual-time opts out.
	// --no-virtual-time [oracle|sandbox|both], default both, same shape as
	// --vt-fence.
	//
	// Per side because the two sides need opposite things on a page like
	// rateyourmusic. The ORACLE needs virtual time: it is what makes the clock
	// reproducible, and with it the challenge passes. The SANDBOX cannot have
	// it: under `kDeterministicLoading` the Turnstile widget's frame never
	// starts its blocking `<script src>` at all -- measured, the frame sits at
	// `readyState: "loading"` with one script and 83 bytes of DOM for the whole
	// run. Without it the widget runs, its blob workers spin up, and the realm
	// goes from 268 records to 41756.
	const vtArg = args.indexOf("--no-virtual-time");
	const vtOffSide =
		vtArg >= 0 && ["oracle", "sandbox", "both"].includes(args[vtArg + 1] ?? "")
			? args[vtArg + 1]
			: "both";
	const vtOff = vtArg >= 0;
	const useVirtualTimeOracle = !(vtOff && vtOffSide !== "sandbox");
	const useVirtualTimeSandbox = !(vtOff && vtOffSide !== "oracle");
	const useVirtualTime = !vtOff;
	const vtPolicyArg = args.indexOf("--vt-policy");
	// deterministic, not advance: advance turns every idle moment into a
	// nondeterministic clock jump (measured 54/60/54/80 s of drift, and it even
	// slipped an exact 250 ms timer to 249).
	const vtPolicy = (
		vtPolicyArg >= 0 ? args[vtPolicyArg + 1] : "deterministic"
	) as "deterministic" | "advance" | "pause";
	const vtBudgetArg = args.indexOf("--vt-budget");
	const vtBudgetRaw = vtBudgetArg >= 0 ? Number(args[vtBudgetArg + 1]) : 30000;
	// A NaN here becomes `--sbxdiff-virtual-time-budget=NaN`, which Chromium
	// rejects and which failed the run with an unrelated-looking "no guest
	// realm matched".
	if (!Number.isFinite(vtBudgetRaw)) {
		console.error(
			`  --vt-budget must be a number, got ${args[vtBudgetArg + 1]}`
		);
		process.exit(2);
	}
	const vtBudget = vtBudgetRaw;
	const pageArg = args.indexOf("--page");
	const page = pageArg >= 0 ? args[pageArg + 1] : "probe.html";
	// --url points both runs at a real site instead of a probe page. The
	// sandbox reaches it only through the store, never the live network.
	const urlArg = args.indexOf("--url");
	const target =
		urlArg >= 0 ? args[urlArg + 1] : `http://localhost:${SITE_PORT}/${page}`;
	const headed = args.includes("--headed");
	// Persistent profile, so a challenge passed once stays passed.
	// Chromium's default fencing. Off by default because it deadlocks a
	// service-worker sandbox; on, a page cannot observe JS running while the
	// clock is frozen.
	// --vt-fence [oracle|sandbox|both], default both.
	//
	// Per side because the two sides serve loads from different places, and
	// fencing is only safe for one of them (RULES.md #40). The oracle NEEDS the
	// fence -- without it rateyourmusic's challenge takes different branches and
	// stalls at 5510 records. The sandbox's loads are served by a service worker
	// that delegates back to the client page, so fencing the page stops the work
	// that would release the pause.
	const vtFenceArg = args.indexOf("--vt-fence");
	const vtFenceSide =
		vtFenceArg >= 0 &&
		["oracle", "sandbox", "both"].includes(args[vtFenceArg + 1] ?? "")
			? args[vtFenceArg + 1]
			: "both";
	const vtFence = vtFenceArg >= 0;
	const vtFenceOracle = vtFence && vtFenceSide !== "sandbox";
	const vtFenceSandbox = vtFence && vtFenceSide !== "oracle";
	const softMiss = args.includes("--soft-miss");
	const profileArg = args.indexOf("--profile");
	const profileDir =
		profileArg >= 0 ? path.resolve(args[profileArg + 1]) : undefined;
	// Real-time grace after the page stops loading. The default 3 s is plenty
	// for a probe page; a challenge that has to run on a real clock (see
	// --no-virtual-time above) needs the browser kept alive for its own
	// timers, which are seconds long.
	const graceArg = args.indexOf("--grace");
	const graceMs = graceArg >= 0 ? Number(args[graceArg + 1]) : 3000;
	if (!Number.isFinite(graceMs)) {
		console.error(`  --grace must be a number, got ${args[graceArg + 1]}`);
		process.exit(2);
	}
	const clickArg = args.indexOf("--click");
	const click = clickArg >= 0 ? args[clickArg + 1] : undefined;
	const clickFrameArg = args.indexOf("--click-frame");
	const clickFrame = clickFrameArg >= 0 ? args[clickFrameArg + 1] : undefined;
	// Reuse an existing store instead of recording one. The rym recipe records
	// it once from a direct headed run that passes Turnstile, then replays that
	// into both sides.
	const storeOutArg = args.indexOf("--store-out");
	const storeArg = args.indexOf("--store");
	const storeDir =
		storeOutArg >= 0
			? path.resolve(args[storeOutArg + 1])
			: storeArg >= 0
				? path.resolve(args[storeArg + 1])
				: STORE;
	const reuseStore = storeArg >= 0;
	// Record only: do the oracle run, keep the store, skip the sandbox. The
	// expensive headed challenge-passing run happens once.
	const recordOnly = storeOutArg >= 0;
	// Everything that has to recognise "the page under test" derives from this,
	// so --url works without three separate hardcoded origins going stale.
	// Captured BEFORE the recording run so it brackets everything the store
	// contains, and reused verbatim on replay.
	const timeBase = reuseStore ? await readTimeBase(storeDir) : Date.now();
	if (reuseStore && timeBase === undefined) {
		console.log(
			`  (store has no ${TIME_BASE_FILE}; falling back to the default clock —\n` +
				`   anything in it with an expiry, a Cloudflare challenge especially,\n` +
				`   will see the wrong device time and reject itself)`
		);
	}
	const targetOrigin = new URL(target).origin;
	const targetHostPort = new URL(target).host;
	const runKey = "sbxdiff-scramjet";

	// The oracle records into the store, so it has to be empty first -- a stale
	// store would let the sandbox replay bytes from a previous page.
	if (!reuseStore) {
		await rm(storeDir, { recursive: true, force: true });
	}
	await mkdir(storeDir, { recursive: true });
	// Loaded after the oracle run; the endpoint reads through this map.
	const store = new Map();
	await startSite(store);
	await startHarness();
	await startBareHarness();
	// The scramjet harness needs its service worker registered and its
	// controller ready before it can navigate; both servers are up now.
	await new Promise((r) => setTimeout(r, 500));

	console.log(`\n  target: ${target}\n`);

	// --framed-oracle puts the oracle's page in the bare harness's iframe.
	//
	// Off by default, and the default is the interesting bit: scramjet presents
	// the guest as a TOP-LEVEL document, so framing the oracle makes the two
	// sides disagree about facts the sandbox is deliberately (and correctly)
	// hiding -- top===self, parent===self, document.referrer. Those showed up as
	// three guest-observable divergences that were entirely artifacts of the
	// harness. Loading the oracle top-level matches what the sandbox claims, and
	// is also what a real visitor sees.
	const framedOracle = args.includes("--framed-oracle");
	// --self-check replaces the sandbox with a SECOND oracle run.
	//
	// An oracle that is not reproducible cannot convict the sandbox of
	// anything: every bucket it reports might be its own noise. This measures
	// that directly, with the same differ, on the same page -- so "rym has 40
	// unstable buckets" is a number rather than a hunch.
	const selfCheck = args.includes("--self-check");
	const oracleSpec = {
		label: "oracle",
		harnessUrl: framedOracle ? `http://localhost:${BARE_PORT}/` : null,
		// The TARGET page, not merely its origin. `selectGuestRealm` falls back
		// to "the realm with the most records", and a probe page with an iframe
		// has two realms on the origin: the moment the frame got busier than
		// the page, the two sides compared DIFFERENT documents and every
		// observation on both showed up as missing or extra.
		guest: (u) => u.startsWith(target),
		// Record unless a prepared store was supplied, in which case the
		// oracle replays it too so both sides see identical bytes.
		initialTimeMs: timeBase ?? DEFAULT_TIME_BASE,
		profileDir,
		netRecord: reuseStore ? undefined : storeDir,
		netReplay: reuseStore ? storeDir : undefined,
		headed,
		click,
		clickFrame,
		virtualTime: useVirtualTimeOracle,
		vtPolicy,
		vtBudget,
		vtFence: vtFenceOracle,
		graceMs,
		softMiss,
		// The oracle's guest realm is the site's own origin.
		vtAfter: targetHostPort,
	} as const;
	const oracle = await capture(oracleSpec, target, runKey);

	if (recordOnly) {
		// Deliberately on ONE line: the C++ store index skips any file with no
		// newline in it, so the metadata cannot be mistaken for a recording
		// without teaching the C++ side about it.
		await writeFile(
			path.join(storeDir, TIME_BASE_FILE),
			JSON.stringify({ initialTimeMs: timeBase })
		);
		const recorded = await loadStore(storeDir);
		const n = [...recorded.values()].reduce((a, v) => a + v.length, 0);
		const repeats = [...recorded.values()].filter((v) => v.length > 1).length;
		console.log(
			`\n  Recorded ${n} response(s) across ${recorded.size} URL(s) -> ${storeDir}`
		);
		if (repeats) {
			// Worth surfacing: these are the URLs whose body changed between
			// requests, which is the case a URL-only key used to lose.
			console.log(`  ${repeats} URL(s) returned more than one response:`);
			for (const [url, v] of recorded) {
				if (v.length > 1) console.log(`      ×${v.length}  ${url}`);
			}
		}
		console.log("  Now: pnpm sbxdiff --url <same> --store <that dir>");
		process.exit(n > 0 ? 0 : 1);
	}

	// Hand the oracle's recording to the endpoint the sandbox's transport
	// fetches from, so the sandbox sees exactly the bytes the oracle saw.
	for (const [k, v] of await loadStore(storeDir)) store.set(k, v);
	const total = [...store.values()].reduce((a, v) => a + v.length, 0);
	console.log(
		`    store: ${total} recorded response(s) across ${store.size} URL(s)`
	);

	const sandbox = selfCheck
		? await capture({ ...oracleSpec, label: "oracle#2" }, target, runKey)
		: await capture(
				{
					label: "sandbox",
					// ?sbxdiffStore swaps the wisp transport for the store-backed one.
					harnessUrl: `http://localhost:${SJ_PORT}/?sbxdiffStore=${SITE_PORT}`,
					// The proxied form of the TARGET page specifically -- the
					// prefix alone also matches its iframes. See the oracle's
					// `guest` above.
					guest: (u) =>
						u.includes("/~/sj/") && u.includes(encodeURIComponent(target)),
					initialTimeMs: timeBase ?? DEFAULT_TIME_BASE,
					headed,
					click,
					clickFrame,
					virtualTime: useVirtualTimeSandbox,
					vtPolicy,
					vtBudget,
					vtFence: vtFenceSandbox,
					graceMs,
					softMiss,
					// The sandbox's guest realm is the proxied page. Setup -- service
					// worker registration, controller handshake -- happens before this
					// and therefore on the real clock, which is the whole point.
					//
					// Matched on the ENCODED target origin, not just the proxy prefix:
					// scramjet serves its own assets under that prefix too
					// (`/~/sj/<ctx>/scramjet.wasm.js`), and each match re-arms the
					// virtual time budget. Matching the prefix alone re-armed it for
					// every shim asset, letting the clock drift ~90-110s by the time
					// guest script ran, differently on each run.
					vtAfter: encodeURIComponent(targetOrigin),
				},
				target,
				runKey
			);

	// Oracle against sandbox, which is the comparison that means something.
	//
	// A request body is guest-observable output in the strongest sense: it is
	// what the page TELLS the server about itself. Cloudflare's is a fingerprint
	// of the whole environment, so it catches divergences no API-call trace
	// reaches -- but only when scored against a run that is actually comparable.
	// Against the RECORDING it is scored against noise: the recording came from
	// a different run with a different wall clock, and unmodified Chromium
	// disagrees with it on all five of these endpoints too.
	//
	// The sandbox's hashes come from its transport, the oracle's from its
	// stderr; both are FNV-1a in the format `<length>:<base36>`, computed by
	// three separate implementations that have to agree (store.ts,
	// sbxdiff-transport.js, sbxdiff_net_replay.cc).
	//
	// Both sources, merged, because the far side is not always a sandbox. Under
	// --self-check it is a second ORACLE run, which replays in Chromium and so
	// reports through stderr like the first one; only a real sandbox run goes
	// through the in-page transport and the store server. Reading just the store
	// map made --self-check report no bodies at all -- and --self-check is
	// exactly where the noise floor for this measurement comes from.
	const sandboxBodies = new Map([...sandbox.reqBodies, ...sandboxReqBodies]);
	const bodyKeys = [
		...new Set([...oracle.reqBodies.keys(), ...sandboxBodies.keys()]),
	].sort();
	const bodyDivergences = bodyKeys
		.map((key) => ({
			key,
			o: oracle.reqBodies.get(key),
			s: sandboxBodies.get(key),
		}))
		.filter(({ o, s }) => o !== s);
	// An empty side is an instrument failure, not a run in which the page sent
	// nothing. Report it as one, rather than listing every request the other
	// side made as a divergence.
	if (sandboxBodies.size && !oracle.reqBodies.size) {
		console.log(
			`\n  request bodies: the oracle reported none and the sandbox reported ` +
				`${sandboxBodies.size}. That is the instrument, not the page -- the ` +
				`oracle's hashes come from its stderr, so check that Chromium logging ` +
				`is on.`
		);
	} else if (bodyDivergences.length) {
		console.log(
			`\n  ${bodyDivergences.length} request-body divergence(s) -- the two runs told the server different things about themselves:`
		);
		for (const { key, o, s } of bodyDivergences.slice(0, 10)) {
			const [url, ord] = key.split(/#(\d+)$/);
			console.log(`      #${ord} oracle ${o ?? "(none sent)"}`);
			console.log(`          sandbox ${s ?? "(none sent)"}`);
			console.log(`          ${url}`);
		}
	} else if (bodyKeys.length) {
		console.log(
			`\n  ${bodyKeys.length} request body(ies), all byte-identical across the two runs.`
		);
	}
	if (storeBodyMismatches.length) {
		// Informational, and NOT a failure. Both sides disagree with the
		// recording here; see above for why that is expected rather than a bug.
		console.log(
			`\n  (${storeBodyMismatches.length} of those also differ from the recording, as the oracle's do -- see RULES.md #61)`
		);
	}
	if (storePastEnds.length) {
		console.log(
			`\n  ${storePastEnds.length} past-the-end hit(s) -- asked more times than recorded, served the last:`
		);
		for (const m of [...new Set(storePastEnds)].slice(0, 10)) {
			console.log(`      ${m}`);
		}
	}
	if (storeNears.length) {
		console.log(
			`\n  ${storeNears.length} near match(es) -- one path segment differed, served anyway:`
		);
		for (const m of [...new Set(storeNears)].slice(0, 10)) {
			console.log(`      ${m}`);
		}
	}
	if (storeMisses.length) {
		console.log(
			`\n  ${storeMisses.length} store miss(es) -- the sandbox asked for bytes the oracle never fetched:`
		);
		for (const m of [...new Set(storeMisses)].slice(0, 10)) {
			console.log(`      ${m}`);
		}
	}

	const markers: LeakMarkers = {
		chromeOrigin: `localhost:${SJ_PORT}`,
		proxyPrefix: "/~/sj/",
		shimIdentifiers: DEFAULT_SHIM_IDENTIFIERS,
	};

	// Guest scripts: in the oracle they come from the site's own origin; in the
	// sandbox they are the rewritten copies served under the proxy prefix.
	// Everything else on the chrome origin -- scramjet.js, the controller, the
	// transport, the harness page itself -- is the shim.
	const divergences = diff(oracle, sandbox, {
		markers,
		oracleAttribution: {
			classes: classifyScripts(oracle.trace, (u) => u.startsWith(targetOrigin)),
		},
		sandboxAttribution: {
			// Under the proxy prefix AND carrying an encoded absolute URL. The
			// prefix alone is not enough: scramjet serves some of its OWN
			// assets through it (`/~/sj/<ctx>/scramjet.wasm.js`), and counting
			// those as guest would attribute shim work to the page.
			//
			// Under --self-check the "sandbox" is a second oracle, so it is
			// classified the same way the first one is.
			classes: classifyScripts(
				sandbox.trace,
				selfCheck
					? (u) => u.startsWith(targetOrigin)
					: (u) => u.includes("/~/sj/") && u.includes("http%3A%2F%2F")
			),
		},
	});

	const shimScripts = [...sandbox.trace.scripts.entries()].filter(
		([, u]) => u && !u.includes("/~/sj/")
	).length;
	console.log(
		`    attribution: ${sandbox.trace.scripts.size} script(s) in the sandbox, ${shimScripts} shim`
	);
	const report = bucketize(divergences);

	if (recordBaseline) {
		// --self-check --baseline writes the NOISE floor instead: what came out
		// of diffing the oracle against itself is, by construction, not a
		// property of the sandbox.
		const out = selfCheck ? noiseFile(target) : baselineFile(target);
		let keys = [...report.buckets.keys()].filter((k) => !k.startsWith("T0|"));
		const fresh = keys.length;
		if (selfCheck) {
			// Union with what is already there. One run samples the noise; a
			// bucket that happened to be stable this time is still unstable,
			// and leaving it out would charge it to the sandbox next run.
			try {
				const prev: string[] = JSON.parse(await readFile(out, "utf8")).buckets;
				keys = [...new Set([...prev, ...keys])];
			} catch {
				// First recording.
			}
		}
		await writeFile(out, JSON.stringify({ buckets: keys.sort() }, null, "\t"));
		console.log(
			`\n  Recorded ${keys.length} ${selfCheck ? "noise" : "baseline"} bucket(s)` +
				(selfCheck ? ` (${fresh} this run)` : "") +
				` -> ${path.relative(process.cwd(), out)}`
		);
		console.log("  T0 leaks are never baselined; they always fail.");
		printSummary(report.divergences, null, null);
		process.exit(0);
	}

	let baseline: Set<string> | undefined;
	try {
		baseline = new Set(
			JSON.parse(await readFile(baselineFile(target), "utf8")).buckets
		);
	} catch {
		console.log("  (no baseline; every bucket is reported as new)");
	}
	// Not loaded under --self-check: subtracting the noise floor from the run
	// that measures it would always report zero.
	let noise: Set<string> | undefined;
	if (!selfCheck) {
		try {
			const f = noiseFile(target);
			noise = new Set(JSON.parse(await readFile(f, "utf8")).buckets);
		} catch {
			// Optional. Without it every bucket is attributed to the sandbox,
			// which is the conservative direction.
		}
	}

	console.log(formatReport(report, baseline));
	printSummary(report.divergences, baseline ?? null, noise ?? null);

	// A T0 leak always fails, even if the oracle is unstable in that bucket: a
	// guest-observable leak is not something a flaky oracle can invent, because
	// both sides of it come from the SANDBOX trace.
	const newBuckets = [...report.buckets.keys()].filter(
		(k) => k.startsWith("T0|") || (!baseline?.has(k) && !noise?.has(k))
	);
	// A request-body divergence fails the run on its own. It is not a bucket --
	// nothing in the API trace produced it -- but it is the strongest evidence
	// the tool collects that the two runs are distinguishable: the page itself
	// described its environment to the server, twice, and gave two answers.
	process.exit(newBuckets.length || bodyDivergences.length ? 1 : 0);
}

function printSummary(
	divergences: Divergence[],
	baseline: Set<string> | null,
	noise: Set<string> | null
) {
	const t0 = divergences.filter((d) => d.tier === "T0").length;
	const fresh = new Set(
		divergences.filter((d) => !baseline?.has(d.bucket)).map((d) => d.bucket)
	);
	const unstable = [...fresh].filter((b) => noise?.has(b)).length;
	console.log(
		`\n  ${divergences.length} divergence(s), ${fresh.size - unstable} bucket(s) not in the baseline` +
			(unstable
				? `, ${unstable} within the oracle's own noise (--self-check)`
				: "") +
			`, ${t0} T0 leak(s).`
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
