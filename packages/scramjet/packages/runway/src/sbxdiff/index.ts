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
import { loadStore, mountStoreEndpoint } from "./store.ts";

const HERE = import.meta.dirname;
/** Where the probe pages are served from. The "site under test". */
const SITE_PORT = 4510;

const BASELINE = path.join(HERE, "baseline.json");
/** Where the oracle run records responses for the sandbox to replay. */
const STORE = path.join(HERE, ".traces", "store");
/** Filled by the store endpoint; a nonzero count means the runs saw different bytes. */
const storeMisses: string[] = [];

async function startSite(store: Awaited<ReturnType<typeof loadStore>>) {
	const app = express();
	mountStoreEndpoint(app, store, storeMisses);
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
	label: "oracle" | "sandbox";
	harnessUrl: string;
	/** Recognizes the realm the guest page owns in this run. */
	guest: (url: string) => boolean;
	/** Only the oracle records; the sandbox replays through its transport. */
	netRecord?: string;
	virtualTime?: boolean;
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
	const url = `${spec.harnessUrl}#b64:${Buffer.from(target).toString("base64")}`;
	const t0 = Date.now();
	await runChromium({
		url,
		traceDir: dir,
		runKey,
		graceMs: 3000,
		netRecord: spec.netRecord,
		netReplay: spec.netReplay,
		headed: spec.headed,
		click: spec.click,
		clickFrame: spec.clickFrame,
		// Virtual time needs the `advance` policy here. The default,
		// kDeterministicLoading, pauses the clock while a load is outstanding,
		// which deadlocks any load served by a worker that needs timers to make
		// progress. Both sides get identical settings either way -- asymmetric
		// clocks would diverge on every timing-derived value.
		...(spec.virtualTime
			? {
					initialTimeMs: 1700000000000,
					virtualTimeBudgetMs: spec.vtBudget ?? 30000,
					virtualTimePolicy: spec.vtPolicy ?? "advance",
					virtualTimeAfter: spec.vtAfter,
				}
			: {}),
		timeoutMs: 90000,
	});

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
	return { trace: merged, realm: found.realm, url: found.url } satisfies Side;
}

async function main() {
	const args = process.argv.slice(2);
	const recordBaseline = args.includes("--baseline");
	// Off by default until the policy fix is proven on more than the probe page.
	const useVirtualTime = args.includes("--virtual-time");
	const vtPolicyArg = args.indexOf("--vt-policy");
	const vtPolicy = (vtPolicyArg >= 0 ? args[vtPolicyArg + 1] : "advance") as
		| "deterministic"
		| "advance"
		| "pause";
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

	const oracle = await capture(
		{
			label: "oracle",
			harnessUrl: `http://localhost:${BARE_PORT}/`,
			guest: (u) => u.startsWith(targetOrigin),
			// Record unless a prepared store was supplied, in which case the
			// oracle replays it too so both sides see identical bytes.
			netRecord: reuseStore ? undefined : storeDir,
			netReplay: reuseStore ? storeDir : undefined,
			headed,
			click,
			clickFrame,
			virtualTime: useVirtualTime,
			vtPolicy,
			vtBudget,
			// The oracle's guest realm is the site's own origin.
			vtAfter: targetHostPort,
		},
		target,
		runKey
	);

	if (recordOnly) {
		const n = (await loadStore(storeDir)).size;
		console.log(`\n  Recorded ${n} response(s) -> ${storeDir}`);
		console.log("  Now: pnpm sbxdiff --url <same> --store <that dir>");
		process.exit(n > 0 ? 0 : 1);
	}

	// Hand the oracle's recording to the endpoint the sandbox's transport
	// fetches from, so the sandbox sees exactly the bytes the oracle saw.
	for (const [k, v] of await loadStore(storeDir)) store.set(k, v);
	console.log(`    store: ${store.size} recorded response(s)`);

	const sandbox = await capture(
		{
			label: "sandbox",
			// ?sbxdiffStore swaps the wisp transport for the store-backed one.
			harnessUrl: `http://localhost:${SJ_PORT}/?sbxdiffStore=${SITE_PORT}`,
			// The sandbox serves the page from a proxied URL on the chrome origin.
			guest: (u) => u.includes("/~/sj/"),
			headed,
			click,
			clickFrame,
			virtualTime: useVirtualTime,
			vtPolicy,
			vtBudget,
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
			classes: classifyScripts(
				sandbox.trace,
				(u) => u.includes("/~/sj/") && u.includes("http%3A%2F%2F")
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
		const keys = [...report.buckets.keys()].filter((k) => !k.startsWith("T0|"));
		await writeFile(
			BASELINE,
			JSON.stringify({ buckets: keys.sort() }, null, "\t")
		);
		console.log(
			`\n  Recorded ${keys.length} baseline bucket(s) -> ${path.relative(process.cwd(), BASELINE)}`
		);
		console.log("  T0 leaks are never baselined; they always fail.");
		printSummary(report.divergences, null);
		process.exit(0);
	}

	let baseline: Set<string> | undefined;
	try {
		baseline = new Set(JSON.parse(await readFile(BASELINE, "utf8")).buckets);
	} catch {
		console.log("  (no baseline; every bucket is reported as new)");
	}

	console.log(formatReport(report, baseline));
	printSummary(report.divergences, baseline ?? null);

	const newBuckets = [...report.buckets.keys()].filter(
		(k) => k.startsWith("T0|") || !baseline?.has(k)
	);
	process.exit(newBuckets.length ? 1 : 0);
}

function printSummary(divergences: Divergence[], baseline: Set<string> | null) {
	const t0 = divergences.filter((d) => d.tier === "T0").length;
	const nw = new Set(
		divergences.filter((d) => !baseline?.has(d.bucket)).map((d) => d.bucket)
	).size;
	console.log(
		`\n  ${divergences.length} divergence(s), ${nw} bucket(s) not in the baseline, ${t0} T0 leak(s).`
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
