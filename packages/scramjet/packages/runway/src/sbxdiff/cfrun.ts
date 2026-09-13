/**
 * Drive an `internal-cf` scramjet bundle through both sides and collect the
 * payload plaintext.
 *
 *     node --experimental-strip-types --no-warnings src/sbxdiff/cfrun.ts \
 *       --bundle <dir> --cert <cert.pem> --key <key.pem> [--grace 60000]
 *
 * Then:
 *
 *     node internal-cf/sandbox/scramjet-payload-diff.mjs \
 *       --bare=<out>/bare --scramjet=<out>/scramjet
 *
 * The bundle holds a DEOBFUSCATED challenge whose lifted VM prints its payload
 * before encryption. sbxdiff can compare anything a page does through a traced
 * API; it cannot see values assembled inside that VM, which is why rym's widget
 * payload still differed by 117 bytes with every JSON.stringify result
 * byte-identical (RULES.md #124). This reads them directly.
 *
 * Both sides fetch the same URLs from one HTTPS server, reached by
 * `--host-resolver-rules`. The sandbox goes through scramjet with the Blink
 * transport, so its upstream fetches are Chromium's own -- the same reason the
 * live comparison needed it (RULES.md #122).
 */
import express from "express";
import https from "node:https";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startHarness, PORT } from "../harness/scramjet/index.ts";
import {
	extractPayloads,
	loadBundle,
	mountBundleRoutes,
	runDirFiles,
} from "./cfbundle.ts";
import { runChromium } from "./run.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);

	return i >= 0 ? args[i + 1] : undefined;
};

const bundleDir = path.resolve(flag("--bundle") ?? "");
const certPath = flag("--cert");
const keyPath = flag("--key");
const graceMs = Number(flag("--grace") ?? 60000);
const outDir = path.resolve(
	flag("--out") ?? path.join(bundleDir, "..", "cfrun")
);
if (!bundleDir || !certPath || !keyPath) {
	console.error(
		"usage: cfrun.ts --bundle <dir> --cert <pem> --key <pem> [--out <dir>] [--grace <ms>]"
	);
	process.exit(2);
}

const bundle = loadBundle(bundleDir);
const misses: string[] = [];
const app = express();
mountBundleRoutes(app, bundle, bundleDir, misses);
const server = https.createServer(
	{ cert: readFileSync(certPath), key: readFileSync(keyPath) },
	app
);
await new Promise<void>((r) => server.listen(0, r));
const bundlePort = (server.address() as { port: number }).port;
await startHarness();

// Every host the bundle answers for, pointed at the one server. A name the
// bundle does not serve is left alone, so a request that escapes the bundle
// fails loudly instead of being quietly answered by the wrong file.
const hosts = [
	...new Set(bundle.served.map((r) => r.match.host).filter(Boolean)),
];
const resolverRules = hosts
	.map((h) => `MAP ${h} 127.0.0.1:${bundlePort}`)
	.join(",");
const target = `https://${bundle.cZone}/__cf_inner_host`;

console.log(`  bundle : ${bundleDir}`);
console.log(
	`  serving: https://127.0.0.1:${bundlePort} for ${hosts.join(", ")}`
);
console.log(`  target : ${target}\n`);

mkdirSync(outDir, { recursive: true });
for (const side of ["bare", "scramjet"] as const) {
	const traceDir = path.join(outDir, side, "trace");
	mkdirSync(traceDir, { recursive: true });
	const url =
		side === "bare"
			? target
			: `http://localhost:${PORT}/?sbxdiffBlink=1#b64:${Buffer.from(target).toString("base64")}`;
	// A run that does not exit is still a run that emitted payloads.
	//
	// The bundle's widget is interactive, so without a click it sits at
	// `interactiveTimeout` and the grace never starts -- and the first version
	// of this threw there, losing the eight payloads the side had already
	// printed AND never starting the other side. runChromium writes the stderr
	// it collected to the trace directory either way, so read it from there.
	let stderr = "";
	try {
		({ stderr } = await runChromium({
			url,
			traceDir,
			runKey: "cfbundle",
			graceMs,
			// The default timeout is 60 s, which is under the grace for any run
			// long enough to reach a payload: the browser was still working when
			// the harness killed it.
			timeoutMs: graceMs + 120000,
			headed: true,
			extraArgs: [
				`--host-resolver-rules=${resolverRules}`,
				"--ignore-certificate-errors",
				...(side === "scramjet" ? ["--disable-web-security"] : []),
			],
		}));
	} catch (e) {
		console.log(
			`  ${side}: ${e instanceof Error ? e.message : e} -- reading what it printed`
		);
	}
	if (!stderr) {
		try {
			stderr = readFileSync(path.join(traceDir, "chromium.stderr.log"), "utf8");
		} catch {
			// Nothing was captured; the payload count below will say zero.
		}
	}
	const payloads = extractPayloads(stderr);
	const files = runDirFiles(bundle, bundleDir, payloads);
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(path.join(outDir, side, name), body);
	}
	console.log(
		`  ${side}: ${payloads.length} payload(s) -> ${path.join(outDir, side)}`
	);
}

if (misses.length) {
	// A request the bundle could not answer is a fact about the run: the two
	// sides did not see the same content, so a diff of what they posted is
	// comparing two different journeys.
	console.log(`\n  ${misses.length} request(s) the bundle did not serve:`);
	for (const m of [...new Set(misses)].slice(0, 12)) console.log(`      ${m}`);
}
server.close();
console.log(
	`\n  next: node internal-cf/sandbox/scramjet-payload-diff.mjs --bare=${path.join(outDir, "bare")} --scramjet=${path.join(outDir, "scramjet")}`
);
process.exit(0);
