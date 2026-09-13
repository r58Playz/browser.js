import { ScramjetClient } from "@client/index";

/**
 * `crossOriginIsolated`, which a proxy turns off by existing.
 *
 * The flag is true only for a document served with
 * `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) AND
 * `Cross-Origin-Opener-Policy: same-origin`. A proxy cannot pass those through:
 * COEP would refuse every subresource it serves from its own origin, and COOP
 * would sever the opener relationship the client needs. So they are stripped,
 * and the page reads `false` where a real browser reads `true`.
 *
 * Not cosmetic, and not rare. Measured on rateyourmusic, inside Cloudflare's
 * Turnstile widget -- which is served with both headers:
 *
 *     oracle   crossOriginIsolated true,  read 3 times
 *     sandbox  crossOriginIsolated false, read 17 times
 *
 * Read seventeen times because the answer changed what the challenge did next.
 * It also gates `SharedArrayBuffer`, `performance.measureUserAgentSpecificMemory`
 * and high-resolution timers, so a page can reach the same conclusion several
 * ways.
 *
 * The headers that decide it arrive with the document and the client already
 * keeps them (`initHeaders`, the same place `referrer-policy` is read from), so
 * the honest value is computable without asking anyone. Reporting what the
 * unproxied response would have produced is the same obligation as unrewriting
 * a URL before handing it to the page.
 */
function isolatedByHeaders(client: ScramjetClient): boolean {
	const headers = client.initHeaders;
	if (!headers) return false;

	const coep = (headers.get("cross-origin-embedder-policy") || "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	const coop = (headers.get("cross-origin-opener-policy") || "")
		.split(";")[0]
		.trim()
		.toLowerCase();

	return (
		(coep === "require-corp" || coep === "credentialless") &&
		coop === "same-origin"
	);
}

export default function (client: ScramjetClient) {
	// A bare global, like `event` -- NOT
	// "WindowOrWorkerGlobalScope.crossOriginIsolated". A Trap target is a dotted
	// path resolved against the global, so an interface name that is not itself
	// a global resolves to nothing and the trap silently does not install.
	client.Trap("crossOriginIsolated", {
		get() {
			return isolatedByHeaders(client);
		},
	});
}
