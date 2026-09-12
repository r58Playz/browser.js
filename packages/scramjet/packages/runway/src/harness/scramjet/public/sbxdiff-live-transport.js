/**
 * A scramjet ProxyTransport that fetches for real, through a Node endpoint.
 *
 * The sandbox's normal egress is WebSocket frames to a wisp server with TLS
 * done inside the page by libcurl-wasm. That is a lot of machinery to have in
 * the picture when the question is "does scramjet load this site at all". This
 * takes it out: Node does the DNS, the TLS and the HTTP, and scramjet gets
 * plain bytes through exactly the same seam `SbxdiffTransport` uses to replay a
 * store. A page that works here and not over wisp indicts the transport; one
 * that fails both ways does not.
 *
 * NOT hermetic and not a differ input. This is for answering one question.
 */
class SbxdiffLiveTransport {
	/** @param {{ endpoint?: string }} [opts] */
	constructor(opts = {}) {
		this.endpoint = opts.endpoint ?? "/__sbxdiff/live";
		this.ready = false;
	}

	async init() {
		console.info(`sbxdiff-live: ${this.endpoint}`);
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
		let encoded;
		if (body) {
			// Whatever scramjet hands us -- a stream, a buffer, a string --
			// becomes base64, because the envelope to Node is JSON.
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			let bin = "";
			for (let i = 0; i < bytes.length; i++)
				bin += String.fromCharCode(bytes[i]);
			encoded = btoa(bin);
		}

		const res = await fetch(this.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				url: remote.href,
				method,
				headers,
				body: encoded,
			}),
			signal,
		});
		const out = await res.json();

		return {
			body: Uint8Array.from(atob(out.body), (c) => c.charCodeAt(0)).buffer,
			headers: out.headers ?? [["content-type", out.mime || "text/plain"]],
			status: out.status ?? 200,
			statusText: out.statusText ?? "",
		};
	}

	/**
	 * Not proxied. A WebSocket would have to go back through wisp, which is
	 * the machinery this transport exists to remove from the picture.
	 */
	connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
		queueMicrotask(() =>
			onerror(`sbxdiff-live: WebSocket to ${url.href} is not proxied`)
		);
		return [() => {}, () => {}];
	}
}

window.SbxdiffLiveTransport = SbxdiffLiveTransport;
