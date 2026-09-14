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
			// Blink must not contribute a Referer of its own.
			//
			// `Referer` is forbidden, so scramjet's value travels as
			// `x-sbxdiff-h-referer` and is restored below the renderer. Blink
			// was then ALSO adding one for this fetch -- the harness page's own
			// URL -- and when scramjet had no referer to send (the initiator
			// was not under the proxy prefix, so `applyFetchMetadataHeaders`
			// sets none) that was the only one left. Measured at the wire, five
			// URLs carried `referer: http://localhost:4500/` straight to
			// Cloudflare.
			//
			// `no-referrer` leaves the field to the carrier: scramjet's value
			// when it has one, and nothing when it does not -- which is what a
			// browser with no referrer sends.
			referrerPolicy: "no-referrer",
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
			headers: restoreSetCookie([...out.headers.entries()]),
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
const PREFIXED = new Set([
	"cookie",
	"referer",
	"origin",
	"user-agent",
	// Scramjet computes these against the SITE's URL space --
	// `applyFetchMetadataHeaders` deletes the browser's and recomputes them --
	// and `fetch()` drops them because the family is forbidden. Blink then
	// substitutes what the fetch literally is, so every upstream request said
	// `dest: empty`, `mode: cors`, `site: cross-site`.
	//
	// Restored in the NETWORK SERVICE, not the renderer: it refuses
	// Sec-Fetch-* from a renderer, and restoring them there made every
	// upstream fetch fail outright.
	"sec-fetch-site",
	"sec-fetch-mode",
	"sec-fetch-dest",
	"sec-fetch-user",
	"sec-fetch-storage-access",
]);

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

/**
 * Put `Set-Cookie` back into the response headers.
 *
 * It is a forbidden RESPONSE header: `fetch()` hides it, so
 * `out.headers.entries()` can never contain one and scramjet's jar -- which is
 * filled from exactly these headers -- stayed empty for the life of the run.
 * Every request then went out without cookies, and a cookie-based challenge
 * loops forever.
 *
 * The browser exposes each one as `x-sbxdiff-h-set-cookie-<n>` under
 * SBXDIFF_PROXY_HEADERS. Indexed rather than joined, because `Headers.get()`
 * joins repeats with ", " and a cookie's `Expires` contains a comma.
 *
 * Without the flag there is nothing to restore and this is a no-op, which is
 * the honest failure: no cookies rather than silently wrong ones.
 */
function restoreSetCookie(entries) {
	const out = [];
	for (const [k, v] of entries) {
		if (/^x-sbxdiff-h-set-cookie-\d+$/i.test(String(k))) {
			out.push(["set-cookie", v]);
			continue;
		}
		out.push([k, v]);
	}

	return out;
}

window.SbxdiffBlinkTransport = SbxdiffBlinkTransport;
