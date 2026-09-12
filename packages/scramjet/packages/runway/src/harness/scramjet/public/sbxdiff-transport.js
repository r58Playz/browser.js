/**
 * A scramjet ProxyTransport that serves every upstream request from an sbxdiff
 * network store instead of the live internet.
 *
 * Why this exists, in order of importance:
 *
 * 1. **The oracle needs both runs to see the same bytes.** The direct run
 *    records a store; this transport replays it into the sandbox. Without it
 *    the two runs fetch the live site independently and diverge on content
 *    neither side controls.
 *
 * 2. **The Chromium-side replay cannot reach here.** `--sbxdiff-net-replay` is
 *    installed at `WillCreateURLLoaderFactory`, but a sandbox's real egress is
 *    WebSocket frames to a wisp server, which never goes through a
 *    URLLoaderFactory. Replacing the transport is the only layer that sees
 *    these requests.
 *
 * 3. **It keys on the real URL.** The transport is called with the upstream
 *    URL *before* scramjet proxies it, so a store recorded from a direct run
 *    matches directly -- no proxy-URL normalization needed.
 *
 * 4. **It removes the WebSocket, which is what deadlocks virtual time.** The
 *    wisp transport drives itself with timers; `kDeterministicLoading` pauses
 *    virtual time while a load is outstanding; the load waits on the timer and
 *    the timer waits on the clock. A plain same-origin `fetch` is a load the
 *    scheduler already knows how to account for.
 *
 * A miss is a hard failure, never a live fetch: a silent fallback would let a
 * real divergence look like a clean run, which is the bug class this whole tool
 * exists to catch (RULES.md #14).
 */
class SbxdiffTransport {
	/** @param {{ endpoint?: string, onMiss?: (url: string) => void }} [opts] */
	constructor(opts = {}) {
		this.endpoint = opts.endpoint ?? "/__sbxdiff/fetch";
		this.onMiss = opts.onMiss ?? null;
		this.ready = false;
		/** URLs the store did not have. Surfaced so a run can report them. */
		this.misses = [];
	}

	async init() {
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
		// The method goes along even though the store keys on URL alone, so a
		// non-GET is reported as an honest miss rather than silently served a
		// GET's body. See DETERMINISM.md §6 gap 1.
		const res = await fetch(
			`${this.endpoint}?url=${encodeURIComponent(remote.href)}&method=${encodeURIComponent(method)}`,
			{ method: "GET", signal }
		);

		if (res.status === 404) {
			this.misses.push(remote.href);
			if (this.onMiss) this.onMiss(remote.href);
			// 504, not a thrown error: scramjet surfaces this to the guest as a
			// failed load, which is what a miss *is*. Throwing would look like a
			// transport bug instead of a missing recording.
			return {
				body: `sbxdiff: no recorded response for ${remote.href}`,
				headers: [["content-type", "text/plain"]],
				status: 504,
				statusText: "sbxdiff replay miss",
			};
		}

		const stored = await res.json();
		/** @type {[string, string][]} */
		const outHeaders = [];
		if (stored.mime) outHeaders.push(["content-type", stored.mime]);
		// The store keeps a decoded body, so any recorded transfer-encoding no
		// longer describes it. Emitting one would make the browser try to
		// decode already-decoded bytes.
		return {
			body: Uint8Array.from(atob(stored.body), (c) => c.charCodeAt(0)).buffer,
			headers: outHeaders,
			status: stored.status ?? 200,
			statusText: "",
		};
	}

	/**
	 * WebSockets are not recorded, so there is nothing to replay. Failing
	 * loudly beats opening a live socket and silently making the run
	 * non-hermetic.
	 */
	connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
		queueMicrotask(() =>
			onerror(`sbxdiff: WebSocket to ${url.href} is not replayable`)
		);
		return [() => {}, () => {}];
	}
}

window.SbxdiffTransport = SbxdiffTransport;
