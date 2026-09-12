/**
 * Manual replay: starts the servers, prints the URLs, and optionally launches
 * the patched Chromium on one of them.
 *
 *     pnpm serve --store <dir> --url https://rateyourmusic.com/ --open sandbox
 *     pnpm serve --page probe.html
 *
 * The point is to drive a recorded store by hand -- click the Turnstile widget
 * yourself, scroll the real page, open devtools -- rather than through the
 * differ. Nothing is traced and nothing is compared; this is for looking.
 *
 * Two sides, same store:
 *
 *   sandbox  the target through scramjet, its transport reading the store over
 *            `/__sbxdiff/fetch`. This is the proxied page a user would see.
 *   oracle   the target directly, with Chromium itself replaying the store
 *            (`--sbxdiff-net-replay`). This is the page as it was recorded.
 *
 * Neither passes `--sbxdiff-run`, so the browser stays open until you close it.
 */
import express from "express";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHarness, PORT } from "../harness/scramjet/index.ts";
import { startBareHarness, BARE_PORT } from "../harness/bare/index.ts";
import { loadStore, mountStoreEndpoint } from "./store.ts";
import { CHROME } from "./run.ts";

const HERE = import.meta.dirname;
const SITE_PORT = 4510;
const TIME_BASE_FILE = "sbxdiff-time-base.json";
const DEFAULT_TIME_BASE = 1700000000000;
// Same key the driver uses. It seeds the deterministic PRNG, and a store whose
// recording depended on a drawn value -- Turnstile's widget id is in a URL --
// only replays under the key it was recorded with.
const RUN_KEY = "sbxdiff-scramjet";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);

	return i >= 0 ? args[i + 1] : undefined;
};

const storeDir = path.resolve(
	flag("--store") ??
		process.env.SBXDIFF_STORE ??
		path.join(HERE, ".traces", "store")
);
const page = flag("--page") ?? "probe.html";
const target = flag("--url") ?? `http://localhost:${SITE_PORT}/${page}`;
const open = flag("--open");

const timeBase = await readFile(path.join(storeDir, TIME_BASE_FILE), "utf8")
	.then((raw) => Number(JSON.parse(raw).initialTimeMs))
	.catch(() => undefined);

const app = express();
// The same endpoint the driver mounts. Without it a manual run fails with a
// CORS error from a 404, which looks like a transport bug rather than a
// missing route.
const store = await loadStore(storeDir);
const misses: string[] = [];
mountStoreEndpoint(app, store, misses);
app.use(express.static(path.join(HERE, "pages")));
app.get("/asset.png", (_q, r) =>
	r
		.type("png")
		.send(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64"
			)
		)
);
await new Promise<void>((r) => app.listen(SITE_PORT, r));
await startHarness();
await startBareHarness();

const encoded = Buffer.from(target).toString("base64");
// ?sbxdiffStore is what swaps the wisp transport for the store-backed one; the
// hash is base64 so the target does not appear literally in the harness URL.
const sandboxUrl = `http://localhost:${PORT}/?sbxdiffStore=${SITE_PORT}#b64:${encoded}`;
const bareUrl = `http://localhost:${BARE_PORT}/#b64:${encoded}`;

/** Everything a manual run needs, minus --sbxdiff-run so it stays open. */
function chromeArgs(userDataDir: string, side: "sandbox" | "oracle") {
	return [
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
		`--sbxdiff-run-key=${RUN_KEY}`,
		`--sbxdiff-initial-time=${timeBase ?? DEFAULT_TIME_BASE}`,
		// The oracle reads the store in the browser process; the sandbox reads
		// it in the page, through the transport, so it must NOT also have the
		// interceptor -- that would block the harness's own assets.
		...(side === "oracle" ? [`--sbxdiff-net-replay=${storeDir}`] : []),
		side === "oracle" ? target : sandboxUrl,
	];
}

const total = [...store.values()].reduce((a, v) => a + v.length, 0);
console.log(`\n  store  : ${total} response(s) across ${store.size} URL(s)`);
console.log(`           ${storeDir}`);
console.log(
	`  clock  : ${timeBase ? `${timeBase} (from ${TIME_BASE_FILE})` : `${DEFAULT_TIME_BASE} (no ${TIME_BASE_FILE} -- anything with an expiry will reject itself)`}`
);
console.log(`  target : ${target}\n`);
console.log(`  sandbox: ${sandboxUrl}`);
console.log(`  bare   : ${bareUrl}\n`);

for (const side of ["sandbox", "oracle"] as const) {
	const quoted = chromeArgs("/tmp/sbxdiff-manual-" + side, side)
		.map((a) => (/[ "&]/.test(a) ? `'${a}'` : a))
		.join(" \\\n    ");
	console.log(`  ${side}, by hand:\n    ${CHROME} \\\n    ${quoted}\n`);
}

if (open === "sandbox" || open === "oracle") {
	const dir = await mkdtemp(path.join(tmpdir(), "sbxdiff-manual-"));
	console.log(`  launching ${open}...\n`);
	const child = spawn(CHROME, chromeArgs(dir, open), {
		stdio: ["ignore", "ignore", "inherit"],
		env: { ...process.env, TZ: "America/Los_Angeles" },
	});
	child.on("exit", () => {
		if (misses.length) {
			console.log(`\n  ${misses.length} store miss(es):`);
			for (const m of [...new Set(misses)].slice(0, 20))
				console.log(`      ${m}`);
		}
		process.exit(0);
	});
}

await new Promise(() => {});
