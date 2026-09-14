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
import { createWriteStream } from "node:fs";
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
// --blink fetches upstream for real, through BLINK's own network stack. It
// needs --disable-web-security, because reading a cross-origin response is the
// point and CORS is there to forbid it. A diagnostic, never a differ input.
//
// There was a --live that fetched from NODE instead. It answered "does scramjet
// load this site" and could not answer "does this site's anti-bot accept the
// sandbox": measured on rateyourmusic, the sandbox solved the challenge, was
// issued a `cf_clearance` cookie, and then got 403 on every request presenting
// it -- a clearance bound to the handshake of the client that earned it, which
// was Node. Removed rather than left as a trap.
const blink = args.includes("--blink");
// --wisp uses neither the store nor Blink: scramjet's own egress, epoxy over a
// WebSocket to the wisp server, with TLS done inside the page. That is the
// transport production uses, and the only one whose handshake is ours to
// shape -- see sbxdiff-epoxy-transport.js. ?sbxdiffLibcurl swaps epoxy for
// libcurl on the same path.
//
// Unlike --blink it needs nothing relaxed in the browser: the request never
// touches Chromium's network stack, so there are no forbidden headers to carry
// and no CORS to disable.
const wisp = args.includes("--wisp");
// Same shape as the driver's, so a manual session can reproduce the automated
// one without a human hand on the mouse.
// --trace <dir> turns the tracer on for a manual session, so a live run can be
// compared against a replayed one with the same tooling the differ uses.
const trace = flag("--trace");
const click = flag("--click");
const clickFrame = flag("--click-frame");

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
// SBXDIFF_LOG_REQ_HEADERS on the wisp path turns on the live logger's header
// dump. It is the same variable the Blink path reads in the browser, because it
// answers the same question -- what did this side actually send -- and there is
// no reason to remember two names for it.
//
// SBXDIFF_LIVE_TRANSPORT=libcurl swaps epoxy for libcurl on that same path.
// Both do TLS in the page, so the comparison is between two handshakes and
// nothing else.
const liveParams = new URLSearchParams();
if (process.env.SBXDIFF_LOG_REQ_HEADERS) liveParams.set("sbxdiffHdr", "1");
if (process.env.SBXDIFF_LIVE_TRANSPORT === "libcurl") {
	liveParams.set("sbxdiffLibcurl", "1");
}
const liveQuery = liveParams.size ? `?${liveParams}` : "";
const sandboxUrl = wisp
	? `http://localhost:${PORT}/${liveQuery}#b64:${encoded}`
	: blink
		? `http://localhost:${PORT}/?sbxdiffBlink=1#b64:${encoded}`
		: `http://localhost:${PORT}/?sbxdiffStore=${SITE_PORT}#b64:${encoded}`;
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
		// The sandbox reads cross-origin responses itself under --blink, which
		// is what CORS exists to prevent. Only on that path, and only for the
		// sandbox: the oracle navigates to the target directly and needs
		// nothing relaxed.
		...(blink && side === "sandbox" ? ["--disable-web-security"] : []),
		"--js-flags=--random-seed=1337 --hash-seed=1337 --no-turbo-fast-api-calls",
		`--sbxdiff-run-key=${RUN_KEY}`,
		...(trace ? [`--sbxdiff-trace-out=${path.resolve(trace)}`] : []),
		// NO --sbxdiff-initial-time. That switch is what ENABLES virtual time
		// (page.cc), and on its own it takes the default policy and the default
		// 2000 ms budget -- so two seconds of virtual time in, the clock stops
		// and every timer freezes. Manually that looks like a blank iframe: the
		// harness navigates, the guest frame never loads, and nothing is logged
		// because nothing throws. The driver only passes it inside its
		// virtual-time branch, which is why the automated run is unaffected.
		//
		// A manual session wants a real clock anyway: virtual time either races
		// ahead while you are looking at the page (kAdvance) or freezes when the
		// budget runs out (kDeterministicLoading).
		// The oracle reads the store in the browser process; the sandbox reads
		// it in the page, through the transport, so it must NOT also have the
		// interceptor -- that would block the harness's own assets.
		// --sbxdiff-click needs the in-binary runner, and the runner only
		// attaches when --sbxdiff-run is set -- which also means the browser
		// quits after that grace. Ten minutes by default, so a "manual" session
		// with an automated click is still long enough to watch.
		...(click
			? [
					`--sbxdiff-click=${click}`,
					`--sbxdiff-run=${flag("--grace") ?? 600000}`,
					...(clickFrame ? [`--sbxdiff-click-frame=${clickFrame}`] : []),
				]
			: []),
		...(side === "oracle" && !blink && !wisp
			? [`--sbxdiff-net-replay=${storeDir}`]
			: []),
		side === "oracle" ? target : sandboxUrl,
	];
}

const total = [...store.values()].reduce((a, v) => a + v.length, 0);
console.log(`\n  store  : ${total} response(s) across ${store.size} URL(s)`);
console.log(`           ${storeDir}`);
// A manual run is on the REAL clock (see chromeArgs), so a store recorded long
// ago replays under a device time its own tokens disagree with. Cloudflare says
// so out loud; most things just fail quietly.
const skewMs =
	timeBase === undefined ? undefined : Math.abs(Date.now() - timeBase);
console.log(
	`  clock  : real (a manual run does not pin it)${
		timeBase === undefined
			? ` -- no ${TIME_BASE_FILE} in the store`
			: `, store recorded ${Math.round((skewMs ?? 0) / 60000)} min ago`
	}`
);
if (skewMs === undefined || skewMs > 60 * 60 * 1000) {
	console.log(
		`           WARNING: a challenge checks its tokens against the device clock.\n` +
			`           Re-record the store if the page rejects itself.`
	);
}
console.log(`  target : ${target}`);
console.log(
	`  mode   : ${
		wisp
			? "WISP -- scramjet's own transport, live, the store is ignored"
			: blink
				? "BLINK -- fetched by the browser itself, the store is ignored"
				: "replay"
	}\n`
);
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
	// Chromium's stderr goes to a file, not the terminal: a manual session is
	// exactly when something goes wrong with no trace to read afterwards, and
	// console messages from the page are in here. SBXDIFF_VERBOSE adds
	// Chromium's own logging on top.
	const logPath = path.join(HERE, ".traces", `serve-${open}.log`);
	const log = createWriteStream(logPath);
	await new Promise((r) => log.once("open", r));
	console.log(`  launching ${open}...`);
	console.log(`  log: ${logPath}\n`);
	const extra = process.env.SBXDIFF_VERBOSE
		? ["--enable-logging=stderr", "--v=1"]
		: ["--enable-logging=stderr"];
	const argv = chromeArgs(dir, open);
	const child = spawn(CHROME, [...extra, ...argv], {
		stdio: ["ignore", "ignore", log],
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
