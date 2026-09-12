/**
 * `POST /__sbxdiff/live` — the same shape as the store endpoint, but it fetches
 * the URL for real, from Node.
 *
 * Why: the sandbox's normal egress is WebSocket frames to a wisp server, with
 * TLS done inside the page by libcurl-wasm. That is a lot of machinery to have
 * in the picture when the question is "does scramjet load this site". This
 * endpoint takes it out — Node does the DNS, the TLS and the HTTP, and scramjet
 * gets plain bytes through exactly the same `ProxyTransport` seam the store
 * replay uses. If a page works here and not over wisp, the transport is the
 * problem; if it fails both ways, it is not.
 *
 * NOT hermetic, by construction: this touches the live internet. It is a
 * diagnostic, never a differ input.
 */
import express from "express";

/** Hop-by-hop and framing headers Node's fetch owns, not the page. */
const DROP_REQUEST = new Set([
	"host",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"content-length",
	"accept-encoding",
]);

// The body Node hands back is already decoded, so the recorded framing headers
// no longer describe it -- the same reason the store transport drops them.
const DROP_RESPONSE = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
]);

export function mountLiveEndpoint(
	app: express.Express,
	log: (line: string) => void = () => {}
) {
	app.options("/__sbxdiff/live", (_req, res) => {
		res.set("Access-Control-Allow-Origin", "*");
		res.set("Access-Control-Allow-Headers", "content-type");
		res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
		res.status(204).end();
	});

	app.post(
		"/__sbxdiff/live",
		express.json({ limit: "64mb" }),
		async (req, res) => {
			res.set("Access-Control-Allow-Origin", "*");
			const {
				url,
				method = "GET",
				headers = [],
				body,
			} = req.body as {
				url: string;
				method?: string;
				headers?: [string, string][];
				body?: string;
			};

			const outHeaders = new Headers();
			let cookieNames = "";
			for (const [k, v] of headers) {
				if (DROP_REQUEST.has(k.toLowerCase())) continue;
				// Names only, never values: a clearance cookie is a credential,
				// and what matters here is whether it is being SENT at all.
				if (k.toLowerCase() === "cookie") {
					cookieNames = v
						.split(";")
						.map((c) => c.trim().split("=")[0])
						.filter(Boolean)
						.join(",");
				}
				outHeaders.append(k, v);
			}

			try {
				const upstream = await fetch(url, {
					method,
					headers: outHeaders,
					body: body ? Buffer.from(body, "base64") : undefined,
					// scramjet follows redirects itself, the same way the store
					// replay hands it a 3xx with its Location.
					redirect: "manual",
				});
				const buf = Buffer.from(await upstream.arrayBuffer());
				const back: [string, string][] = [];
				upstream.headers.forEach((v, k) => {
					// set-cookie is handled below: `forEach` comma-joins repeated
					// headers, and a comma-joined pair of cookies is one broken
					// cookie. A challenge that cannot set its clearance cookie
					// retries forever, which looks exactly like a sandbox bug.
					if (k.toLowerCase() === "set-cookie") return;
					if (!DROP_RESPONSE.has(k.toLowerCase())) back.push([k, v]);
				});
				for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
					back.push(["set-cookie", cookie]);
				}
				const setCookies = upstream.headers.getSetCookie?.().length ?? 0;
				log(
					`LIVE ${upstream.status} ${method} ${buf.length}b` +
						`${setCookies ? ` +${setCookies}ck` : ""}` +
						`${cookieNames ? ` sent[${cookieNames}]` : " sent[-]"}` +
						` ${url.slice(0, 100)}`
				);
				res.json({
					mime: upstream.headers.get("content-type") ?? "",
					status: upstream.status,
					statusText: upstream.statusText,
					headers: back,
					body: buf.toString("base64"),
				});
			} catch (e) {
				log(`LIVE ERR ${method} ${url.slice(0, 120)} -- ${String(e)}`);
				// 502 rather than a thrown error: the page should see a failed
				// load, which is what this is, not a transport bug.
				res.json({
					mime: "text/plain",
					status: 502,
					statusText: "sbxdiff live fetch failed",
					headers: [["content-type", "text/plain"]],
					body: Buffer.from(String(e)).toString("base64"),
				});
			}
		}
	);
}
