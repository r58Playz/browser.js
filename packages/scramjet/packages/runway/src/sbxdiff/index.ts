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
	diff,
	formatReport,
	selectGuestRealm,
	DEFAULT_SHIM_IDENTIFIERS,
	type Divergence,
	type LeakMarkers,
	type Side,
} from "./diff.ts";
import { loadTraces, mergeTraces, runChromium } from "./run.ts";

const HERE = import.meta.dirname;
/** Where the probe pages are served from. The "site under test". */
const SITE_PORT = 4510;

const BASELINE = path.join(HERE, "baseline.json");

async function startSite() {
	const app = express();
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
};

async function capture(spec: RunSpec, target: string, runKey: string) {
	const dir = path.join(HERE, ".traces", spec.label);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });

	const url = `${spec.harnessUrl}#${encodeURIComponent(target)}`;
	const t0 = Date.now();
	await runChromium({
		url,
		traceDir: dir,
		runKey,
		graceMs: 3000,
		// Deliberately NO --sbxdiff-initial-time / --sbxdiff-virtual-time-budget.
		//
		// Virtual time stops scramjet from ever initialising: with it on, the
		// harness never navigates the testframe and no guest realm is created
		// at all. Measured at budgets 4000 and 30000 and with no budget -- this
		// is not a budget-size problem, it is that enabling virtual time breaks
		// service-worker startup, which the sandbox depends on and the bare
		// harness does not.
		//
		// Both sides therefore run on the real clock. That keeps the two runs
		// SYMMETRIC, which matters more here than pinning the clock: a run with
		// virtual time diffed against a run without it would diverge on every
		// timing-derived value. `--sbxdiff-run-key` still pins randomness.
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
	const pageArg = args.indexOf("--page");
	const page = pageArg >= 0 ? args[pageArg + 1] : "probe.html";
	const target = `http://localhost:${SITE_PORT}/${page}`;
	const runKey = "sbxdiff-scramjet";

	await startSite();
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
			guest: (u) => u.startsWith(target.replace(/\/[^/]*$/, "")),
		},
		target,
		runKey
	);

	const sandbox = await capture(
		{
			label: "sandbox",
			harnessUrl: `http://localhost:${SJ_PORT}/`,
			// The sandbox serves the page from a proxied URL on the chrome origin.
			guest: (u) => u.includes("/~/sj/"),
		},
		target,
		runKey
	);

	const markers: LeakMarkers = {
		chromeOrigin: `localhost:${SJ_PORT}`,
		proxyPrefix: "/~/sj/",
		shimIdentifiers: DEFAULT_SHIM_IDENTIFIERS,
	};

	const divergences = diff(oracle, sandbox, { markers });
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
