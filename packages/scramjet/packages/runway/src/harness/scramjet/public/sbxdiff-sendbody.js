/**
 * How is the interstitial's payload actually built?
 *
 * Payload 3 -- the interstitial's second `/fo/` POST, ~8.7 KB on the oracle and
 * ~890 bytes shorter in the sandbox -- is not assembled through `TextEncoder`
 * (the oracle's interstitial hands it nothing over 512 bytes) and not through
 * `atob` (~64 bytes). So it is built some third way, and until that is known
 * there is nothing to instrument.
 *
 * This asks the send itself: for every POST to a `/fo/` endpoint, what TYPE is
 * the body and how long is it. That is enough to say where to look next, and
 * the length is directly comparable to the recorded request sizes.
 *
 * Hooks XHR and fetch both. No global is wrapped that scramjet later snapshots,
 * so this does not have the ordering problem of rule 215 -- `XMLHttpRequest
 * .prototype.send` is called by the guest, not captured by scramjet at load.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.sendbody");
	if (self[GUARD]) return;
	self[GUARD] = true;

	var where = function () {
		try {
			var h = String(location.href);
			return h.indexOf("challenges.cloudflare.com") !== -1 ? "widget" : "page";
		} catch (err) {
			return "worker";
		}
	};

	var describe = function (b) {
		try {
			if (b == null) return "null 0";
			if (typeof b === "string") return "string " + b.length;
			if (b instanceof ArrayBuffer) return "ArrayBuffer " + b.byteLength;
			if (ArrayBuffer.isView(b)) return b.constructor.name + " " + b.byteLength;
			if (typeof Blob !== "undefined" && b instanceof Blob)
				return "Blob " + b.size;
			if (typeof FormData !== "undefined" && b instanceof FormData)
				return "FormData";
			if (
				typeof URLSearchParams !== "undefined" &&
				b instanceof URLSearchParams
			)
				return "URLSearchParams " + String(b).length;
			if (typeof ReadableStream !== "undefined" && b instanceof ReadableStream)
				return "ReadableStream";
			return (b && b.constructor && b.constructor.name) || typeof b;
		} catch (err) {
			return "?";
		}
	};

	var say = function (url, b) {
		try {
			// `%2Ffo%2F` as well as `/fo/`: under the proxy the target URL is
			// percent-encoded inside the prefix, so the plain form never
			// appears and a `/fo/` test silently matches nothing at all.
			if (!/\/fo\/|%2Ffo%2F/i.test(String(url))) return;
			console.info(
				"sbxdiff-send " +
					where() +
					" " +
					describe(b) +
					" " +
					String(url)
						.replace(/[A-Za-z0-9_.:-]{30,}/g, "<t>")
						.slice(0, 80)
			);
			// The body is a STRING, so its shape is readable even though its
			// contents are ciphertext. The head says which encoding it is in --
			// base64, JSON, form-encoded -- which is what decides whether there
			// is anything further to compare without deobfuscating.
			if (typeof b === "string" && b.length > 5000)
				console.info(
					"sbxdiff-send HEAD " +
						where() +
						" " +
						b.length +
						" " +
						JSON.stringify(b.slice(0, 120)) +
						" ... " +
						JSON.stringify(b.slice(-40))
				);
		} catch (err) {}
	};

	try {
		var realOpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function (m, u) {
			try {
				this.__sbxurl = u;
			} catch (e) {}
			return realOpen.apply(this, arguments);
		};
		var realSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function (body) {
			say(this.__sbxurl, body);
			return realSend.apply(this, arguments);
		};
	} catch (err) {}

	try {
		var realFetch = self.fetch;
		self.fetch = function (input, init) {
			try {
				var u = typeof input === "string" ? input : input && input.url;
				say(u, init && init.body);
			} catch (e) {}
			return realFetch.apply(this, arguments);
		};
	} catch (err) {}
})();
