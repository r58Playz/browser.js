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
	headed?: boolean;
	timeoutMs?: number;
};

/**
 * The flags every run shares.
 *
 * `--disable-site-isolation-trials` is deliberately absent: it breaks Cloudflare
 * Turnstile on real sites. The `--disable-features` set below is what makes a
 * cross-origin iframe share the page's renderer, and it does not.
 */
function baseArgs(o: RunOptions, userDataDir: string): string[] {
	const args = [
		...(o.headed ? [] : ["--headless=new"]),
		"--no-sandbox",
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--use-mock-keychain",
		"--enable-unsafe-swiftshader",
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
	if (o.netRecord) args.push(`--sbxdiff-net-record=${o.netRecord}`);
	if (o.netReplay) args.push(`--sbxdiff-net-replay=${o.netReplay}`);
	args.push(o.url);
	return args;
}

export async function runChromium(o: RunOptions): Promise<{ stderr: string }> {
	const userDataDir = await mkdtemp(path.join(tmpdir(), "sbxdiff-"));
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
		await rm(userDataDir, { recursive: true, force: true });
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
	const records = [];
	for (const t of traces) {
		for (const [k, v] of t.realms) realms.set(k, v);
		records.push(...t.records);
	}
	records.sort((a, b) => a.seq - b.seq);
	return {
		file: traces.map((t) => path.basename(t.file)).join(","),
		version: traces[0]?.version ?? 0,
		pid: traces[0]?.pid ?? 0,
		runKey: traces[0]?.runKey ?? 0,
		realms,
		records,
		truncatedBytes: traces.reduce((n, t) => n + t.truncatedBytes, 0),
	};
}
