/**
 * Serve an `internal-cf` scramjet bundle, and collect the payload plaintext
 * both sides emit.
 *
 * The bundle is the producer side of a contract `internal-cf` already defines
 * (`sandbox/build-scramjet-bundle.mjs`): a static directory holding a
 * DEOBFUSCATED Cloudflare challenge, plus `bundle.json` mapping requests to the
 * files that answer them. The point of it is that the challenge's payload is
 * emitted BEFORE encryption -- the lifted VM calls `__cfTrace`, which prints
 * `__CF_PAYLOAD_PLAINTEXT__<base64url>` to the console -- so the two sides can
 * be compared field by field instead of as ciphertext.
 *
 * That is the thing sbxdiff could not do on its own. Every payload rym's widget
 * builds through `JSON.stringify` is byte-identical and its `/fo/` body still
 * differs by 117 bytes (RULES.md #124), because the rest is assembled inside a
 * VM whose intermediate values never touch a traced API. This reads them out.
 *
 * `bundle.json.served` matches on method, host, and one of path / pathPrefix /
 * pathContains -- patterns, not exact URLs, because the challenge mints its own
 * URLs at runtime. That is the one thing the sbxdiff store cannot do, and the
 * only reason this is a separate module rather than another store.
 */
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";

/** One row of `bundle.json.served`. */
export type BundleRoute = {
	match: {
		method?: string;
		host?: string;
		path?: string;
		pathPrefix?: string;
		pathContains?: string;
	};
	/** A single response, for a request that only happens once. */
	file?: string;
	/**
	 * Successive responses, for one that does not.
	 *
	 * The inner `/flow/ov` POST is answered differently the second time, and
	 * collapsing the two would replay a journey the capture never took -- the
	 * same rule the sbxdiff store follows for a URL with several recordings.
	 */
	ordered?: string[];
	type?: string;
};

export type Bundle = {
	cZone: string;
	seed: number;
	lifted: boolean;
	innerTurnstileUrl: string;
	widgetId: string;
	served: BundleRoute[];
};

export function loadBundle(dir: string): Bundle {
	return JSON.parse(readFileSync(path.join(dir, "bundle.json"), "utf8"));
}

/**
 * The route that answers a request, or undefined.
 *
 * Every stated condition has to hold; an absent one is not a wildcard by
 * accident. `method` defaults to GET because that is what the bundle omits it
 * for, and getting that backwards would serve a document to a payload POST.
 */
export function matchRoute(
	bundle: Bundle,
	method: string,
	url: URL
): BundleRoute | undefined {
	for (const route of bundle.served) {
		const m = route.match;
		if ((m.method ?? "GET").toUpperCase() !== method.toUpperCase()) continue;
		if (m.host && m.host !== url.host) continue;
		if (m.path && m.path !== url.pathname) continue;
		if (m.pathPrefix && !url.pathname.startsWith(m.pathPrefix)) continue;
		if (m.pathContains && !url.pathname.includes(m.pathContains)) continue;

		return route;
	}

	return undefined;
}

/**
 * Mounts the bundle behind the same wire shape `SbxdiffTransport` already
 * speaks, so the sandbox needs no new client: POST `{url, method}` and get
 * `{status, headers, body}` with a base64 body.
 *
 * `misses` is filled rather than thrown, for the same reason the store's are:
 * a request the bundle cannot answer is a fact about the run, and a 500 here
 * would look like a transport bug.
 */
export function mountBundleEndpoint(
	app: express.Express,
	bundle: Bundle,
	dir: string,
	misses: string[] = []
): void {
	// How many times each ordered route has answered. Per mount, so two runs in
	// one process do not inherit each other's position.
	const served = new Map<BundleRoute, number>();
	app.options("/__sbxdiff/cfbundle", (_req, res) => {
		res.set("Access-Control-Allow-Origin", "*");
		res.set("Access-Control-Allow-Headers", "content-type");
		res.sendStatus(204);
	});
	app.post(
		"/__sbxdiff/cfbundle",
		express.json({ limit: "64mb" }),
		(req, res) => {
			res.set("Access-Control-Allow-Origin", "*");
			const { url, method } = req.body ?? {};
			let parsed: URL;
			try {
				parsed = new URL(String(url));
			} catch {
				res.status(400).json({ error: "bad url" });

				return;
			}
			const route = matchRoute(bundle, String(method ?? "GET"), parsed);
			if (!route) {
				misses.push(`${method} ${url}`);
				res.status(404).json({ error: "no route", url: String(url) });

				return;
			}
			const file = fileFor(route, served);
			if (!file) {
				misses.push(`${method} ${url} (ordered exhausted)`);
				res.status(404).json({ error: "ordered exhausted", url: String(url) });

				return;
			}
			const body = readFileSync(path.join(dir, file));
			res.json({
				status: 200,
				statusText: "OK",
				headers: [["content-type", route.type ?? "application/octet-stream"]],
				body: body.toString("base64"),
			});
		}
	);
}

/**
 * Serve the bundle as an ordinary web server, on the hostnames it names.
 *
 * The POST endpoint above suits the sandbox, whose transport asks for bytes by
 * URL. The ORACLE has no transport -- it is a browser loading a page -- so the
 * bundle has to answer real requests to `cfschl.peet.ws` and
 * `challenges.cloudflare.com`. Chromium's `--host-resolver-rules` points both
 * names at this server and `--ignore-certificate-errors` accepts its
 * self-signed certificate.
 *
 * Both sides then fetch the same URLs from the same server, which is the point:
 * the bundle contract's "ONE variable (scramjet on/off), the SAME static
 * content under both modes".
 */
export function mountBundleRoutes(
	app: express.Express,
	bundle: Bundle,
	dir: string,
	misses: string[] = []
): void {
	const served = new Map<BundleRoute, number>();
	app.use((req, res, next) => {
		let url: URL;
		try {
			url = new URL(req.originalUrl, `https://${req.headers.host}`);
		} catch {
			next();

			return;
		}
		const route = matchRoute(bundle, req.method, url);
		if (!route) {
			misses.push(`${req.method} ${url.href}`);
			next();

			return;
		}
		const file = fileFor(route, served);
		if (!file) {
			misses.push(`${req.method} ${url.href} (ordered exhausted)`);
			res.sendStatus(404);

			return;
		}
		// The challenge reads its own responses cross-origin, and the capture's
		// CORS headers are not replayed, so allow it here rather than have the
		// run fail as a security error that says nothing about the proxy.
		res.set("Access-Control-Allow-Origin", "*");
		res.set("Access-Control-Allow-Headers", "*");
		res.type(route.type ?? "application/octet-stream");
		res.send(readFileSync(path.join(dir, file)));
	});
}

/**
 * The file this hit of a route answers with.
 *
 * An `ordered` route hands out its files in turn and then stops: running off
 * the end is a miss, not a repeat of the last one, because a challenge that
 * asks a third time is not in the journey the capture recorded and answering
 * anyway would hide that.
 */
function fileFor(
	route: BundleRoute,
	served: Map<BundleRoute, number>
): string | undefined {
	if (!route.ordered) {
		return route.file;
	}
	const n = served.get(route) ?? 0;
	served.set(route, n + 1);

	return route.ordered[n];
}

/**
 * The payload plaintext a run printed, in order.
 *
 * Chromium writes console output to stderr, which every sbxdiff run already
 * keeps, so this needs no new channel: find the sentinel, decode the
 * base64url, parse. Lines that do not decode are skipped rather than fatal --
 * a truncated last line at the end of a killed run is not a reason to lose the
 * ones before it.
 */
export function extractPayloads(log: string): unknown[] {
	const out: unknown[] = [];
	for (const m of log.matchAll(/__CF_PAYLOAD_PLAINTEXT__([A-Za-z0-9_-]+)/g)) {
		try {
			const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
			out.push(JSON.parse(Buffer.from(b64, "base64").toString("utf8")));
		} catch {
			// A partial line; the ones already collected still stand.
		}
	}

	return out;
}

/**
 * The run directory `internal-cf/sandbox/scramjet-payload-diff.mjs` consumes.
 *
 * It asserts identity on seed, lifted, cZone and bundleDir before it will
 * compare anything, which is the right instinct: two runs of different bundles
 * are not a diff, they are two facts.
 */
export function runDirFiles(
	bundle: Bundle,
	bundleDir: string,
	payloads: unknown[]
): { "meta.json": string; "payloads.json": string } {
	return {
		"meta.json": JSON.stringify(
			{
				seed: bundle.seed,
				lifted: bundle.lifted,
				cZone: bundle.cZone,
				bundleDir,
				payloadCount: payloads.length,
			},
			null,
			2
		),
		"payloads.json": JSON.stringify(payloads, null, 2),
	};
}
