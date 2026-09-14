/**
 * What the challenge encodes, before it encrypts it.
 *
 * Payload 3 is about 890 bytes shorter in the sandbox (RULES.md #208) and the
 * `/fo/` body is ciphertext, so comparing bodies says only that they differ.
 * But the oracle's trace shows `TextEncoder.encode` being handed things like
 * `"a3b25fb2088d2af7|1789420184395|0|5916eZRpfKwYMIciWDCBBSxYqiybZSeMsKBgv"` --
 * plaintext, on its way in. Encoding is the last point the payload is readable
 * without deobfuscating the VM.
 *
 * So: hook `TextEncoder.prototype.encode` and record every input's LENGTH, in
 * order, plus a masked preview. Lengths are the unit the gap is in; the preview
 * is masked because the contents are per-run tokens that will never match and
 * would only make the log unreadable.
 *
 * Same probe both sides -- SBXDIFF_PROBE for the sandbox, CDP for the oracle --
 * because a number from one side is worth nothing unless the other answered the
 * same question.
 */
(function () {
	"use strict";
	// `self`, not `window`. The challenge does its encoding inside blob
	// WORKERS -- the oracle's biggest realms are `blob:https://challenges...`
	// with 40-50k records each -- and a worker has no `window`, so a probe that
	// reaches for one throws on entry and reports nothing. Which reads as "the
	// oracle never encodes anything", and it does.
	var GUARD = Symbol.for("sbxdiff.encode");
	if (self[GUARD]) return;
	self[GUARD] = true;

	var seq = [];
	var total = 0;

	/**
	 * Which realm this is: the widget, or the page embedding it.
	 *
	 * NOT the tail of `location.href`. Under the proxy the widget's URL ENDS
	 * `...$io=https%3A%2F%2Frateyourmusic.com` -- the embedder's origin is a
	 * query parameter on it -- so a last-40-characters fingerprint files the
	 * widget under the interstitial and the split is silently wrong. The
	 * oracle's URLs have no such suffix, so the same filter behaves differently
	 * on the two sides, which is the worst kind of wrong.
	 *
	 * Ask whether the DOCUMENT is the challenge widget instead, which survives
	 * rewriting because the host appears in the encoded target either way.
	 */
	var here = function () {
		try {
			var h = String(location.href);
			if (h.indexOf("challenges.cloudflare.com") !== -1) return "widget";
			if (h.indexOf("challenges%2Ecloudflare") !== -1) return "widget";
			return "page";
		} catch (err) {
			return "worker";
		}
	};

	/** Shape, not contents: digits to 9, hex-ish runs to x, letters to a. */
	var mask = function (s) {
		try {
			return s
				.slice(0, 44)
				.replace(/[0-9]/g, "9")
				.replace(/[a-f]/g, "x")
				.replace(/[A-Za-z]/g, "a");
		} catch (err) {
			return "?";
		}
	};

	try {
		var real = TextEncoder.prototype.encode;
		TextEncoder.prototype.encode = function (input) {
			try {
				var s = input === undefined ? "" : String(input);
				total += s.length;
				if (seq.length < 4000) seq.push([s.length, mask(s)]);
				// Reported IMMEDIATELY, not at the timed dump. These run inside
				// blob workers that Cloudflare terminates as soon as they are
				// done -- thirteen of them in a run -- so a worker is usually
				// gone before a 4 s timer fires and the dump reports nothing at
				// all. 512 is above every token and key and below the payload.
				if (s.length >= 512)
					// WITH the realm. Without it these are a pile of sizes from
					// every realm at once, and "the big encodes match" is a
					// claim about the wrong thing: payload 3 is the
					// INTERSTITIAL's POST, and the widget's encodes matching
					// says nothing about it.
					console.info(
						"sbxdiff-enc BIG " + s.length + " " + here() + " " + mask(s)
					);
				// One size band, unmasked. The sandbox encodes a ~907 byte
				// string the oracle never does, which is the size of the payload
				// gap, and a masked preview cannot say what it is. Narrow band
				// and a short slice: everything else stays masked.
				if (s.length >= 850 && s.length <= 1000) {
					// WHERE is it assembled? Both header surfaces are clean --
					// XHR's `getAllResponseHeaders` and fetch's `Headers` both
					// refuse `set-cookie` -- and `document.cookie` does not hold
					// a `cf_clearance` at all. The only thing left to ask is the
					// call stack at the moment it is encoded.
					var stack = "";
					try {
						stack = String(new Error().stack || "")
							.split("\n")
							.slice(1, 8)
							.join(" <- ")
							.replace(/[A-Za-z0-9_.-]{40,}/g, "<v>");
					} catch (e2) {}
					console.info("sbxdiff-enc RAW " + s.length + " " + stack);
				}
			} catch (err) {}

			return real.apply(this, arguments);
		};
	} catch (err) {}

	var dump = function (when) {
		try {
			var where = "?";
			try {
				where = String(
					typeof location !== "undefined"
						? location.href
						: self.name || "worker"
				).slice(-44);
			} catch (err) {
				where = "worker";
			}
			console.info(
				"sbxdiff-enc " +
					when +
					" TOTAL calls=" +
					seq.length +
					" bytes=" +
					total +
					" in=" +
					where
			);
			// The big ones are the payload; the small ones are tokens and keys.
			var big = seq
				.filter(function (r) {
					return r[0] >= 64;
				})
				.sort(function (a, b) {
					return b[0] - a[0];
				});
			for (var i = 0; i < big.length && i < 20; i++)
				console.info(
					"sbxdiff-enc " + when + "   " + big[i][0] + " " + big[i][1]
				);
		} catch (err) {}
	};

	setTimeout(function () {
		dump("early");
	}, 4000);
	setTimeout(function () {
		dump("late ");
	}, 11000);
})();
