/**
 * A scramjet ProxyTransport that fetches upstream with BLINK, from the page.
 *
 * There used to be a second one that handed the URL to NODE, and Node did the
 * DNS, the TLS and the HTTP. It could answer "does scramjet load this site" and
 * never "does this site's anti-bot accept the sandbox", because Node's TLS
 * handshake and HTTP/2 settings are not Chromium's -- the server answers a
 * different client than the one the oracle presents.
 *
 * Measured on rateyourmusic, which is what settled it: over the Node path the
 * sandbox solved the challenge and was ISSUED a `cf_clearance` cookie, then got
 * 403 on every request that presented it. That is what a clearance bound to the
 * handshake of the client that earned it does. It also failed the whole of
 * `brunhild.challenges.cloudflare.com` with `TypeError: fetch failed`.
 *
 * So: the same seam, the same bytes, but the request goes out through the
 * browser that is being measured. Both sides then present one network stack,
 * and the Node path is gone rather than left as a trap.
 *
 * Needs `--disable-web-security`, because reading a cross-origin response is
 * the entire point and CORS exists to forbid exactly that. That switch is
 * guest-observable, so this transport is a diagnostic, never a differ input.
 */
class SbxdiffBlinkTransport {
	constructor() {
		this.ready = false;
	}

	async init() {
		console.info("sbxdiff-blink: upstream fetches go out through Blink");
		this.ready = true;
	}

	/**
	 * @param {URL} remote
	 * @param {string} method
	 * @param {BodyInit | null} body
	 * @param {[string, string][]} headers
	 * @param {AbortSignal | undefined} signal
	 */
	async request(remote, method, body, headers, signal) {
		// Scramjet keeps its own cookie jar and puts the cookies in `headers`.
		// `credentials: "omit"` so Blink does not ALSO attach its own for the
		// target origin: two jars on one request is a state the site never sees
		// from a real browser, and the duplicate `Cookie` header is the kind of
		// thing an anti-bot notices.
		//
		// The forbidden ones go under a prefix. `fetch()` drops a forbidden
		// header SILENTLY, so `Cookie` -- the one scramjet's whole jar exists to
		// send -- never reached the wire, and every request after a challenge
		// set one arrived as a fresh visitor. Production egress is scramjet's
		// own transport, which sends what scramjet computed; prefixing here and
		// restoring in the browser makes this path send the same bytes.
		//
		// Needs SBXDIFF_PROXY_HEADERS on the browser, which is what puts them
		// back. Without it the prefixed names go out as-is, which is visibly
		// wrong rather than silently wrong.
		const out = await fetch(remote.href, {
			method,
			headers: prefixForbidden(headers),
			body: body ?? undefined,
			credentials: "omit",
			// Scramjet follows redirects itself, off the Location header, so it
			// has to see the 3xx rather than the thing at the end of it.
			redirect: "manual",
			signal,
			// A request with a body needs this to stream rather than buffer, and
			// Chromium requires it whenever `body` is a ReadableStream.
			...(body && typeof body === "object" && "getReader" in body
				? { duplex: "half" }
				: {}),
		});

		return {
			body: await out.arrayBuffer(),
			headers: [...out.headers.entries()],
			status: out.status,
			statusText: out.statusText,
		};
	}

	connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
		// A real WebSocket, for once: Blink can open one straight to the target,
		// which is the one thing the Node transport cannot do at all.
		try {
			const ws = new WebSocket(url.href, protocols);
			ws.binaryType = "arraybuffer";
			ws.onopen = () => onopen(ws.protocol, "");
			ws.onmessage = (e) => onmessage(e.data);
			ws.onclose = (e) => onclose(e.code, e.reason, e.wasClean);
			ws.onerror = () => onerror(`sbxdiff-blink: WebSocket error ${url.href}`);

			return [
				(data) => ws.send(data),
				(code, reason) => ws.close(code, reason),
			];
		} catch (e) {
			queueMicrotask(() => onerror(`sbxdiff-blink: ${e}`));

			return [() => {}, () => {}];
		}
	}
}

/**
 * Headers the fetch spec forbids a page from setting.
 *
 * Blink drops them silently rather than throwing, so leaving them in would
 * quietly send a request missing whatever scramjet meant to put there. Dropped
 * here so the difference is at least visible in one place.
 *
 * `Cookie` is NOT in this list: Blink refuses it, but scramjet's jar is the
 * only jar in play and losing it would fail every authenticated request. It is
 * sent as-is and Blink's own handling decides -- which is itself something the
 * live run measures.
 */
const FORBIDDEN = new Set([
	"accept-encoding",
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"via",
]);

function stripForbidden(headers) {
	return (headers ?? []).filter(
		([k]) => !FORBIDDEN.has(String(k).toLowerCase())
	);
}

/**
 * Headers a page may not set, carried under a private prefix.
 *
 * `x-sbxdiff-h-<name>` is an ordinary custom header on the way out, so nothing
 * about `fetch()` or `Headers` has to change for it -- the rename happens in
 * the browser, after the request has left JavaScript. Widening Blink's
 * forbidden-header check instead would make `Cookie` settable on any `Headers`
 * object, which is a difference a page can read.
 *
 * The transport-level ones stay dropped: `host`, `connection`,
 * `content-length` and friends belong to whoever is actually speaking HTTP,
 * and scramjet's values for them would be wrong on this path.
 */
const PREFIXED = new Set(["cookie", "referer", "origin", "user-agent"]);

function prefixForbidden(headers) {
	const out = [];
	for (const [k, v] of headers ?? []) {
		const name = String(k).toLowerCase();
		if (PREFIXED.has(name)) {
			out.push([`x-sbxdiff-h-${name}`, v]);
			continue;
		}
		if (FORBIDDEN.has(name)) continue;
		out.push([k, v]);
	}

	return out;
}

window.SbxdiffBlinkTransport = SbxdiffBlinkTransport;
