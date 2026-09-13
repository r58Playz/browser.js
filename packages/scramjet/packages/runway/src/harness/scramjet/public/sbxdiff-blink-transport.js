/**
 * A scramjet ProxyTransport that fetches upstream with BLINK, from the page.
 *
 * `SbxdiffLiveTransport` hands the URL to Node and Node does the DNS, the TLS
 * and the HTTP. That is fine for "does scramjet load this site", and useless
 * for "does this site's anti-bot accept the sandbox": Node's TLS handshake and
 * HTTP/2 settings are not Chromium's, so the server is answering a different
 * client than the one the oracle presents. Measured against rateyourmusic, the
 * whole of `brunhild.challenges.cloudflare.com` failed with
 * `TypeError: fetch failed` on every attempt, which unmodified Chromium fetches
 * without complaint.
 *
 * So: the same seam, the same bytes, but the request goes out through the
 * browser that is being measured. Both sides then present one network stack.
 *
 * Needs `--disable-web-security`, because reading a cross-origin response is
 * the entire point and CORS exists to forbid exactly that. That switch is
 * guest-observable and this transport is a diagnostic, never a differ input --
 * the same standing rule the Node one carries.
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
		const out = await fetch(remote.href, {
			method,
			headers: stripForbidden(headers),
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

window.SbxdiffBlinkTransport = SbxdiffBlinkTransport;
