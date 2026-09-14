/**
 * Instrumentation for a LIVE run, wrapped around whichever transport is doing
 * the fetching.
 *
 * A live run has no store to diff against and no baseline to compare to. The
 * only things it can report are what it sent, what came back, and whether
 * Cloudflare ever handed over a `cf_clearance` -- and those have to be the same
 * measurements whichever transport is underneath, or two transports cannot be
 * compared to each other. Hence a wrapper rather than a method on one of them.
 *
 * On the wisp transports (epoxy, libcurl) the headers logged here ARE the wire
 * bytes: nothing between this seam and the socket adds, drops, renames or
 * reorders a header. That is not true of the Blink transport, where Chromium
 * recomposes the request afterwards -- for that path the equivalent measurement
 * is SBXDIFF_LOG_WIRE_HEADERS inside the browser.
 */
export class SbxdiffLiveLogTransport {
	/**
	 * @param {any} inner
	 * @param {string} label transport name, so a log says which one it was
	 * @param {boolean} headers whether to dump request headers and Set-Cookie
	 */
	constructor(inner, label, headers) {
		this.inner = inner;
		this.label = label;
		this.headers = headers;
		this.stats = { requests: 0, failures: 0, clearances: 0 };
	}

	get ready() {
		return this.inner.ready;
	}

	init() {
		return this.inner.init();
	}

	meta(...args) {
		return this.inner.meta?.(...args);
	}

	async request(remote, method, body, headers, signal) {
		this.stats.requests++;
		if (this.headers) {
			console.info(
				`sbxdiff-live-req: ${method} ${remote.href} :: ` +
					(headers ?? []).map(([k, v]) => `${k}: ${v}`).join(" | ")
			);
		}

		let res;
		try {
			res = await this.inner.request(remote, method, body, headers, signal);
		} catch (err) {
			this.stats.failures++;
			// Logged rather than swallowed: a transport failure reaches the
			// guest as a rejected fetch, which on a challenge page looks exactly
			// like the challenge deciding not to answer.
			console.error(
				`sbxdiff-live: FAILED ${method} ${remote.host}${remote.pathname}: ${err}`
			);
			throw err;
		}

		// Cloudflare returns its verdict on the `/fo/` XHR as `cf-chl-out` and
		// `cf-chl-out-s` RESPONSE headers; the Turnstile widget reads them and
		// that is what redeems the challenge. A header the guest cannot read is
		// indistinguishable, from inside the page, from a challenge that was
		// refused -- so what arrives here is worth seeing whole.
		if (this.headers) {
			const interesting = (res.headers ?? []).filter(([k]) =>
				/^cf-|^access-control-expose/i.test(k)
			);
			if (interesting.length) {
				console.info(
					`sbxdiff-live-cf: ${remote.host}${remote.pathname.slice(0, 48)} :: ` +
						interesting.map(([k, v]) => `${k}=${v.slice(0, 40)}`).join(" | ")
				);
			}
		}

		for (const [key, value] of res.headers ?? []) {
			if (key.toLowerCase() !== "set-cookie") continue;
			if (this.headers) {
				console.info(`sbxdiff-live-setcookie: ${remote.host} ${value}`);
			}
			// The one response header a live run is waiting for. Cloudflare
			// issues `cf_clearance` when it accepts the challenge, and nothing
			// else on this path reports success: the page looks the same whether
			// the cookie came back or the challenge looped.
			//
			// Being issued one is NOT passing. The clearance is bound to the
			// client that earned it, and the binding reaches below HTTP -- so
			// the next request can present it and still be answered 403. Both
			// numbers are in the summary for that reason.
			if (value.startsWith("cf_clearance=")) {
				this.stats.clearances++;
				console.info(`sbxdiff-live: CF_CLEARANCE issued by ${remote.host}`);
			}
		}

		console.info(
			`sbxdiff-live: ${res.status} ${method} ${remote.host}${remote.pathname}`
		);

		return res;
	}

	connect(...args) {
		return this.inner.connect(...args);
	}
}
