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
		/** url -> ordered [{mime, body}, ...] pulled in by init(); see why there. */
		this.preloaded = new Map();
		/** url -> how many times this run has asked for it. */
		this.counts = new Map();
	}

	/**
	 * Pull the whole store into memory before the page under test loads.
	 *
	 * This is not an optimisation. Under the `advance` virtual time policy the
	 * clock races forward whenever the run is idle, so every *real* I/O wait on
	 * the guest-load path converts real elapsed time into a nondeterministic
	 * amount of virtual time. A per-request `fetch` to the store endpoint is
	 * exactly such a wait. Preloading moves all of it before virtual time is
	 * enabled, leaving the guest load with no real I/O to race against.
	 */
	async init() {
		const res = await fetch(`${this.endpoint}?all=1`);
		if (res.ok) {
			const all = await res.json();
			for (const [url, entries] of Object.entries(all)) {
				this.preloaded.set(url, entries);
			}
		}
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
		// The store keys on URL alone, so a non-GET cannot be answered from it;
		// report that as an honest miss rather than serving a GET's body.
		// See DETERMINISM.md §6 gap 1.
		// Nth request for a URL gets the Nth recording. A URL can return
		// different bodies on successive requests -- a challenge page and then
		// the real page -- and collapsing them silently replays a different
		// journey than the one recorded.
		const ordinal = this.counts.get(remote.href) ?? 0;
		this.counts.set(remote.href, ordinal + 1);

		const hits =
			method === "GET" || method === "HEAD"
				? this.preloaded.get(remote.href)
				: undefined;
		if (hits && hits.length) {
			// Past the end reuses the last: fetched more often than recorded is
			// normal, and the oracle saw no more than it recorded.
			return this.#toResponse(hits[Math.min(ordinal, hits.length - 1)]);
		}

		const res = await fetch(
			`${this.endpoint}?url=${encodeURIComponent(remote.href)}&method=${encodeURIComponent(method)}&ordinal=${ordinal}`,
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

		return this.#toResponse(await res.json());
	}

	/**
	 * @param {{mime?: string, body: string, status?: number,
	 *          headers?: [string, string][]}} stored
	 */
	#toResponse(stored) {
		/** @type {[string, string][]} */
		const outHeaders = [];
		let sawContentType = false;
		for (const [name, value] of stored.headers ?? []) {
			const lower = name.toLowerCase();
			// The store keeps a DECODED body, so the recorded framing headers no
			// longer describe it: content-length is the wrong number and
			// content-encoding would ask for a second decode of already-decoded
			// bytes.
			if (
				lower === "content-encoding" ||
				lower === "content-length" ||
				lower === "transfer-encoding"
			) {
				continue;
			}
			if (lower === "content-type") sawContentType = true;
			outHeaders.push([name, value]);
		}
		// Everything else is passed through, `location` included. A redirect is
		// a recorded response now, and the URL a redirect lands on is content:
		// Cloudflare's challenge reads its token out of `location`, so a
		// transport that flattened the chain would run the script at a URL the
		// recording never committed to.
		if (!sawContentType && stored.mime) {
			outHeaders.push(["content-type", stored.mime]);
		}
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
