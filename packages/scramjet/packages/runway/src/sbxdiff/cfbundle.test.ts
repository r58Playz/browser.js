/**
 * The bundle router and the payload extractor.
 *
 * The router is the part worth testing: `bundle.json` matches on patterns
 * rather than exact URLs, and a pattern that is too loose serves a document to
 * a payload POST -- which looks like the challenge misbehaving, not like a
 * routing bug.
 *
 *   node --experimental-strip-types --no-warnings --test src/sbxdiff/cfbundle.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	extractPayloads,
	matchRoute,
	runDirFiles,
	type Bundle,
} from "./cfbundle.ts";

const bundle: Bundle = {
	cZone: "cfschl.peet.ws",
	seed: 42,
	lifted: false,
	innerTurnstileUrl: "https://challenges.cloudflare.com/x",
	widgetId: "0xAAA",
	served: [
		{
			match: {
				method: "GET",
				host: "cfschl.peet.ws",
				path: "/__cf_inner_host",
			},
			file: "host-shell.html",
			type: "text/html",
		},
		{
			match: {
				method: "GET",
				host: "challenges.cloudflare.com",
				pathPrefix: "/cdn-cgi/challenge-platform/h/b/turnstile/",
			},
			file: "inner.html",
			type: "text/html",
		},
		{
			match: {
				method: "GET",
				host: "cfschl.peet.ws",
				pathContains: "/orchestrate/",
			},
			file: "outer-orchestrate.js",
			type: "application/javascript",
		},
		{
			match: {
				method: "POST",
				host: "challenges.cloudflare.com",
				pathContains: "/flow/ov1/",
			},
			file: "flow/inner-1.body",
		},
	],
};

test("an exact path matches only itself", () => {
	assert.equal(
		matchRoute(bundle, "GET", new URL("https://cfschl.peet.ws/__cf_inner_host"))
			?.file,
		"host-shell.html"
	);
	assert.equal(
		matchRoute(
			bundle,
			"GET",
			new URL("https://cfschl.peet.ws/__cf_inner_hostx")
		),
		undefined
	);
});

test("the host is part of the match", () => {
	// Two rows share `pathContains` shapes; without the host test a request to
	// the wrong origin would be answered with the other origin's file.
	assert.equal(
		matchRoute(bundle, "GET", new URL("https://evil.test/__cf_inner_host")),
		undefined
	);
});

test("method is part of the match, and defaults to GET", () => {
	// The bundle omits `method` nowhere today, but a GET row answering a POST
	// would hand a document to a payload submission -- which reads as the
	// challenge misbehaving rather than as a routing bug.
	assert.equal(
		matchRoute(
			bundle,
			"POST",
			new URL("https://cfschl.peet.ws/__cf_inner_host")
		),
		undefined
	);
	assert.equal(
		matchRoute(
			bundle,
			"POST",
			new URL("https://challenges.cloudflare.com/cdn-cgi/x/flow/ov1/abc")
		)?.file,
		"flow/inner-1.body"
	);
});

test("pathPrefix anchors at the start, pathContains does not", () => {
	assert.equal(
		matchRoute(
			bundle,
			"GET",
			new URL(
				"https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0"
			)
		)?.file,
		"inner.html"
	);
	assert.equal(
		matchRoute(
			bundle,
			"GET",
			new URL(
				"https://challenges.cloudflare.com/x/cdn-cgi/challenge-platform/h/b/turnstile/"
			)
		),
		undefined
	);
	assert.equal(
		matchRoute(
			bundle,
			"GET",
			new URL("https://cfschl.peet.ws/h/g/orchestrate/chl/v1")
		)?.file,
		"outer-orchestrate.js"
	);
});

test("payloads come out of the console sentinel, in order", () => {
	const enc = (o: unknown) =>
		Buffer.from(JSON.stringify(o), "utf8")
			.toString("base64")
			.replace(/=+$/, "")
			.replace(/\+/g, "-")
			.replace(/\//g, "_");
	const log = [
		"[1:2:INFO:CONSOLE(1)] noise",
		`__CF_PAYLOAD_PLAINTEXT__${enc({ a: 1 })}`,
		"more noise",
		`__CF_PAYLOAD_PLAINTEXT__${enc({ b: [2, 3] })}`,
	].join("\n");
	assert.deepEqual(extractPayloads(log), [{ a: 1 }, { b: [2, 3] }]);
});

test("a truncated sentinel does not lose the payloads before it", () => {
	// A run killed at its grace deadline ends mid-line, and losing the whole
	// capture to that would be the harness discarding its own result.
	const enc = Buffer.from(JSON.stringify({ ok: true }), "utf8")
		.toString("base64")
		.replace(/=+$/, "");
	const log = `__CF_PAYLOAD_PLAINTEXT__${enc}\n__CF_PAYLOAD_PLAINTEXT__eyJ0cnVuY2F0`;
	assert.deepEqual(extractPayloads(log), [{ ok: true }]);
});

test("the run directory carries what the differ asserts identity on", () => {
	const files = runDirFiles(bundle, "/tmp/b", [{ x: 1 }]);
	const meta = JSON.parse(files["meta.json"]);
	assert.equal(meta.seed, 42);
	assert.equal(meta.lifted, false);
	assert.equal(meta.cZone, "cfschl.peet.ws");
	assert.equal(meta.bundleDir, "/tmp/b");
	// The differ refuses to compare when payloadCount disagrees with the array,
	// so these two must be written from the same value.
	assert.equal(meta.payloadCount, JSON.parse(files["payloads.json"]).length);
});

test("an ordered route answers in turn and then stops", async () => {
	// The inner /flow/ov POST is answered differently the second time. Serving
	// the first body twice would replay a journey the capture never took, and
	// serving it a third time would hide that the run went off the recording.
	const express = (await import("express")).default;
	const { mountBundleEndpoint } = await import("./cfbundle.ts");
	const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
	const os = await import("node:os");
	const p = await import("node:path");

	const dir = mkdtempSync(p.join(os.tmpdir(), "cfbundle-"));
	mkdirSync(p.join(dir, "flow"), { recursive: true });
	writeFileSync(p.join(dir, "flow/a"), "FIRST");
	writeFileSync(p.join(dir, "flow/b"), "SECOND");
	const ordered: Bundle = {
		...bundle,
		served: [
			{
				match: { method: "POST", host: "h.test", pathContains: "/flow/ov" },
				ordered: ["flow/a", "flow/b"],
			},
		],
	};
	const app = express();
	const misses: string[] = [];
	mountBundleEndpoint(app, ordered, dir, misses);
	const server = app.listen(0);
	await new Promise((r) => server.once("listening", r));
	const port = (server.address() as { port: number }).port;
	const hit = async () => {
		const res = await fetch(`http://127.0.0.1:${port}/__sbxdiff/cfbundle`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				url: "https://h.test/x/flow/ov1/z",
				method: "POST",
			}),
		});
		if (!res.ok) return null;
		const j = (await res.json()) as { body: string };
		return Buffer.from(j.body, "base64").toString();
	};
	assert.equal(await hit(), "FIRST");
	assert.equal(await hit(), "SECOND");
	assert.equal(await hit(), null);
	server.close();
	assert.equal(misses.length, 1);
	assert.match(misses[0]!, /ordered exhausted/);
});
