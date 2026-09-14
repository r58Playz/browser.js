/**
 * The performance entry list, as the PAGE sees it, on either side.
 *
 * Payload 3 -- the interstitial's second `/fo/` POST -- is about 890 bytes
 * shorter in the sandbox than in the oracle (RULES.md #208), and the obvious
 * variable-length thing in an environment payload is a list. Cloudflare walks
 * the resource entries recording nine fields each, so a handful of entries
 * either way is hundreds of bytes.
 *
 * The trace cannot answer this: `getEntries` returns an object, and its
 * attribution puts a shimmed read on the shim rather than the guest
 * (RULES.md #209). So ask the page instead, with the SAME probe on both sides
 * -- injected into the sandbox with SBXDIFF_PROBE and into the oracle over CDP.
 * Identical instrumentation is what makes the two numbers comparable.
 *
 * Reports the count, the per-type breakdown, and a serialised length using the
 * fields Cloudflare actually reads, so the number is in the same units as the
 * payload gap rather than being a bare count.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.perfentries");
	if (window[GUARD]) return;
	window[GUARD] = true;

	var t0 = Date.now();
	var say = function (msg) {
		try {
			console.info("sbxdiff-perf " + msg);
		} catch (err) {}
	};

	// The nine fields the challenge is known to read off a resource entry.
	var FIELDS = [
		"name",
		"entryType",
		"startTime",
		"duration",
		"initiatorType",
		"transferSize",
		"encodedBodySize",
		"decodedBodySize",
		"responseStart",
	];

	var measure = function (when) {
		var entries;
		try {
			entries = performance.getEntries();
		} catch (err) {
			say(when + " getEntries THREW " + err);

			return;
		}
		var byType = {};
		var bytes = 0;
		var names = [];
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i];
			var ty = "?";
			try {
				ty = String(e.entryType);
			} catch (err) {}
			byType[ty] = (byType[ty] || 0) + 1;
			for (var f = 0; f < FIELDS.length; f++) {
				try {
					var v = e[FIELDS[f]];
					if (v !== undefined && v !== null) bytes += String(v).length;
				} catch (err) {}
			}
			if (ty === "resource" || ty === "navigation") {
				try {
					// The tail is the distinguishing part; a rewritten URL shares
					// a long prefix with every other one.
					names.push(String(e.name).slice(-52));
				} catch (err) {}
			}
		}
		var types = Object.keys(byType)
			.sort()
			.map(function (k) {
				return k + "=" + byType[k];
			})
			.join(",");
		say(
			when +
				" t=" +
				(Date.now() - t0) +
				" n=" +
				entries.length +
				" bytes=" +
				bytes +
				" [" +
				types +
				"]"
		);
		for (var j = 0; j < names.length; j++) say(when + "   " + names[j]);
	};

	// Once the page has settled, and again after the challenge has run: the
	// list grows, and the payload is built from whatever it holds at the time.
	setTimeout(function () {
		measure("early");
	}, 2500);
	setTimeout(function () {
		measure("late ");
	}, 9000);
})();
