/**
 * What the guest actually read, per shimmed member, in bytes.
 *
 * The trace cannot answer this (RULES.md #209): `topScript` attributes a
 * shimmed read to the shim, `entryScript` drags the whole rewriter in, and a
 * shim that answers from a cache never touches a native at all. scramjet funnels
 * every intercepted getter, setter and method through one `apply` trap, so that
 * trap is the only place that knows both WHO asked and WHAT they got.
 *
 * This installs the recorder that trap looks for. It must be set before the
 * guest's client installs its interceptors, which is exactly what SBXDIFF_PROBE
 * guarantees -- the probe runs at the top of every guest document.
 *
 * Aggregated, not streamed: an intercepted access happens tens of thousands of
 * times a run and one console line each would drown the log and skew the
 * timings this is meant to compare. Counts and summed string lengths are what
 * the payload gap is denominated in anyway (RULES.md #208).
 *
 * On the ORACLE there is no shim, so the same numbers come from
 * `sbxdiff-nativeread.js`, which wraps the same members' native descriptors.
 * Same members, same aggregation, one side through the proxy and one not.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.shimread.installed");
	if (window[GUARD]) return;
	window[GUARD] = true;

	var stats = new Map();

	/** The size of a value as the payload would carry it. */
	var sizeOf = function (v) {
		try {
			if (typeof v === "string") return v.length;
			if (typeof v === "number" || typeof v === "boolean")
				return String(v).length;
			if (v == null) return 0;
			// Lists are the variable-length things that move a payload; their
			// LENGTH is the part worth counting, not their contents.
			if (typeof v.length === "number" && typeof v !== "function")
				return v.length;

			return 0;
		} catch (err) {
			return 0;
		}
	};

	window[Symbol.for("sbxdiff.shimread")] = function (member, value) {
		try {
			var row = stats.get(member);
			if (!row) {
				row = { n: 0, bytes: 0 };
				stats.set(member, row);
			}
			row.n++;
			row.bytes += sizeOf(value);
		} catch (err) {}
	};

	var dump = function (when) {
		try {
			var rows = [];
			stats.forEach(function (v, k) {
				rows.push([k, v.n, v.bytes]);
			});
			rows.sort(function (a, b) {
				return b[2] - a[2];
			});
			var total = 0;
			for (var i = 0; i < rows.length; i++) total += rows[i][2];
			var where = "?";
			try {
				where = String(location.href).slice(-46);
			} catch (err) {}
			console.info(
				"sbxdiff-read " +
					when +
					" TOTAL members=" +
					rows.length +
					" bytes=" +
					total +
					" in=" +
					where
			);
			for (var j = 0; j < rows.length && j < 40; j++)
				console.info(
					"sbxdiff-read " +
						when +
						"   " +
						rows[j][2] +
						" " +
						rows[j][1] +
						" " +
						rows[j][0]
				);
		} catch (err) {}
	};

	setTimeout(function () {
		dump("early");
	}, 3000);
	setTimeout(function () {
		dump("late ");
	}, 10000);
})();
