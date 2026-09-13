/**
 * Launches the patched Chromium and collects the traces a run produces.
 *
 * Deliberately no Playwright and no CDP. A DevTools session is itself
 * page-observable (`navigator.webdriver`, `Runtime.enable` eagerly serializing
 * console arguments through page getters) and it injects a `chrome://headless/`
 * realm into every trace. The patched binary drives itself with
 * `--sbxdiff-run`, and the harness pages take their target from `location.hash`.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decode, type Trace } from "./trace.ts";

export const CHROME =
	process.env.SBXDIFF_CHROME ??
	path.resolve(
		import.meta.dirname,
		"../../../../../../../src/out/sbx/Chromium.app/Contents/MacOS/Chromium"
	);

export type RunOptions = {
	url: string;
	traceDir: string;
	runKey: string;
	/** Real-time grace after the page stops loading, ms. */
	graceMs?: number;
	initialTimeMs?: number;
	virtualTimeBudgetMs?: number;
	netRecord?: string;
	netReplay?: string;
	/** "deterministic" (default), "advance", or "pause". */
	virtualTimePolicy?: "deterministic" | "advance" | "pause";
	/** Defer enabling virtual time until a realm whose URL contains this. */
	virtualTimeAfter?: string;
	/** Restore Chromium's default of fencing task queues while paused. */
	virtualTimeFence?: boolean;
	/** Serve an empty 200 for a replay miss instead of blocking. */
	softMiss?: boolean;
	headed?: boolean;
	/** Persistent user-data-dir; keeps cookies (and challenge clearance). */
	profileDir?: string;
	timeoutMs?: number;
	/** Trusted click, for challenge widgets: "x,y[,delay[,repeat[,interval]]]". */
	click?: string;
	/** Send the click to the frame whose URL contains this substring. */
	clickFrame?: string;
};

/**
 * The flags every run shares.
 *
 * `--disable-site-isolation-trials` is deliberately absent: it breaks Cloudflare
 * Turnstile on real sites. The `--disable-features` set below is what makes a
 * cross-origin iframe share the page's renderer, and it does not.
 */
export function baseArgs(o: RunOptions, userDataDir: string): string[] {
	const args = [
		...(o.headed ? [] : ["--headless=new"]),
		"--no-sandbox",
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--use-mock-keychain",
		"--enable-unsafe-swiftshader",
		// No infobar. Chromium warns about `--no-sandbox` with one, and it slides
		// in about a second after startup -- shrinking the content area by 56px
		// UNDER the running page. The oracle's guest reads `innerHeight` before
		// that lands and the sandbox's cannot: service worker registration and
		// scramjet boot sit in front of the guest's first line. Measured on
		// `pointer.html`, the oracle said 813 and then 757, the sandbox said 757
		// twice, and the sandbox got blamed for a viewport the browser moved.
		"--test-type",
		"--window-size=1280,900",
		"--num-raster-threads=1",
		"--force-color-profile=srgb",
		"--lang=en-US",
		"--disable-features=site-per-process,IsolateOrigins,IsolateSandboxedIframes,BackgroundResourceFetch",
		"--js-flags=--random-seed=1337 --hash-seed=1337 --no-turbo-fast-api-calls",
		`--sbxdiff-run-key=${o.runKey}`,
		`--sbxdiff-trace-out=${o.traceDir}`,
		`--sbxdiff-run=${o.graceMs ?? 2500}`,
	];
	if (o.initialTimeMs !== undefined)
		args.push(`--sbxdiff-initial-time=${o.initialTimeMs}`);
	if (o.virtualTimeBudgetMs !== undefined)
		args.push(`--sbxdiff-virtual-time-budget=${o.virtualTimeBudgetMs}`);
	if (o.virtualTimePolicy)
		args.push(`--sbxdiff-virtual-time-policy=${o.virtualTimePolicy}`);
	if (o.virtualTimeAfter)
		args.push(`--sbxdiff-virtual-time-after=${o.virtualTimeAfter}`);
	if (o.virtualTimeFence) args.push("--sbxdiff-virtual-time-fence");
	if (o.softMiss) args.push("--sbxdiff-net-replay-soft-miss");
	if (o.click) args.push(`--sbxdiff-click=${o.click}`);
	if (o.clickFrame) args.push(`--sbxdiff-click-frame=${o.clickFrame}`);
	if (o.netRecord) args.push(`--sbxdiff-net-record=${o.netRecord}`);
	if (o.netReplay) args.push(`--sbxdiff-net-replay=${o.netReplay}`);
	// Logging to stderr is ALWAYS on, because the run reads results out of it.
	// The oracle's request-body hashes are `LOG(WARNING)` lines from the replay
	// loader and the sandbox's per-request log is `console.info`; neither
	// reaches stderr without this. It used to be behind SBXDIFF_VERBOSE, which
	// meant a run without that variable saw no oracle bodies at all and
	// reported every one of them as "(none sent)" -- an instrument that
	// manufactures the divergence it is supposed to measure.
	//
	// `--v=1` stays behind the variable. That is the VERBOSE1 firehose (every
	// URLRequest, every virtual-time pauser), which is for reading by hand.
	args.push("--enable-logging=stderr");
	if (process.env.SBXDIFF_VERBOSE) args.push("--v=1");
	args.push(o.url);
	return args;
}

export async function runChromium(o: RunOptions): Promise<{ stderr: string }> {
	// A persistent profile keeps cookies between runs. That is what lets a
	// Cloudflare challenge be passed ONCE, interactively, and then stay passed:
	// the clearance cookie is the only part of a challenge that outlives it.
	// A challenge itself cannot be replayed -- it is a challenge-response
	// protocol with server-minted, request-bound tokens, so recorded answers
	// never match a fresh attempt (measured: 109 retry iterations, zero missing
	// bytes).
	const userDataDir =
		o.profileDir ?? (await mkdtemp(path.join(tmpdir(), "sbxdiff-")));
	const args = baseArgs(o, userDataDir);
	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(CHROME, args, {
				env: { ...process.env, TZ: "America/Los_Angeles" },
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += d;
			});
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(
					new Error(`chromium did not exit within ${o.timeoutMs ?? 60000}ms`)
				);
			}, o.timeoutMs ?? 60000);
			child.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
			child.on("exit", () => {
				clearTimeout(timer);
				resolve({ stderr });
			});
		});
	} finally {
		if (!o.profileDir) {
			await rm(userDataDir, { recursive: true, force: true });
		}
	}
}

/**
 * A run produces one file per thread that recorded, not one per run -- a
 * dedicated worker gets its own, because the tracer is thread-local. Never
 * select one by size; load them all and scope by realm.
 */
export async function loadTraces(dir: string): Promise<Trace[]> {
	const out: Trace[] = [];
	for (const name of await readdir(dir)) {
		if (!name.endsWith(".sbxd")) continue;
		const file = path.join(dir, name);
		out.push(decode(file, await readFile(file)));
	}
	return out;
}

/** Merges every thread's records into one logical trace, ordered by seq. */
export function mergeTraces(traces: Trace[]): Trace {
	if (traces.length === 1) return traces[0];
	const realms = new Map<number, string>();
	// Script ids are per-ISOLATE, so every trace file numbers them from 1 and
	// they collide on merge. "First mapping wins" is not good enough: it
	// silently attributed the page's script 4 to the browser UI process's
	// script 4, which made every guest record in the sandbox look like it was
	// entered by `chrome://resources/lit/v3_0/lit.rollup.js`.
	//
	// Namespace by file index and rewrite the records to match.
	const scripts = new Map<number, string>();
	const records: Trace["records"] = [];
	const SPACE = 1 << 20;
	traces.forEach((t, i) => {
		const base = i * SPACE;
		for (const [k, v] of t.realms) realms.set(k, v);
		for (const [k, v] of t.scripts) scripts.set(base + k, v);
		for (const r of t.records) {
			if ("topScript" in r) {
				// 0 means "no JS on the stack" and must stay 0, not become a
				// valid id in this file's namespace.
				records.push({
					...r,
					topScript: r.topScript === 0 ? 0 : base + r.topScript,
					entryScript: r.entryScript === 0 ? 0 : base + r.entryScript,
				});
			} else {
				records.push(r);
			}
		}
	});
	records.sort((a, b) => a.seq - b.seq);
	return {
		file: traces.map((t) => path.basename(t.file)).join(","),
		version: traces[0]?.version ?? 0,
		pid: traces[0]?.pid ?? 0,
		runKey: traces[0]?.runKey ?? 0,
		realms,
		scripts,
		records,
		truncatedBytes: traces.reduce((n, t) => n + t.truncatedBytes, 0),
	};
}
