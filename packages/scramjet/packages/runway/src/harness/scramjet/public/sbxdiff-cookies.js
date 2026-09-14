/**
 * How many `cf_clearance` cookies does the guest hold?
 *
 * The sandbox encodes a 907-byte blob into its payload that begins with the
 * literal `cf_clearance` and contains no separators -- about the length of four
 * or five clearances concatenated, and the sandbox runs four or five challenge
 * cycles. A browser REPLACES a cookie of the same name; a jar that appends one
 * per cycle is a divergence that grows with every retry.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.cookies");
	if (self[GUARD]) return;
	self[GUARD] = true;
	var look = function (when) {
		try {
			var c = document.cookie || "";
			var names = c.split(";").map(function (p) {
				return p.split("=")[0].trim();
			});
			var seen = {};
			var dupes = [];
			for (var i = 0; i < names.length; i++) {
				if (seen[names[i]]) dupes.push(names[i]);
				seen[names[i]] = (seen[names[i]] || 0) + 1;
			}
			console.info(
				"sbxdiff-cookie " +
					when +
					" len=" +
					c.length +
					" n=" +
					names.length +
					" cf_clearance=" +
					(seen["cf_clearance"] || 0) +
					" dupes=" +
					(dupes.join(",") || "none") +
					" names=" +
					names.join(",").slice(0, 120)
			);
		} catch (err) {
			console.info("sbxdiff-cookie " + when + " THREW " + err);
		}
	};
	setTimeout(function () {
		look("t3 ");
	}, 3000);
	setTimeout(function () {
		look("t15");
	}, 15000);
	setTimeout(function () {
		look("t30");
	}, 30000);
})();
