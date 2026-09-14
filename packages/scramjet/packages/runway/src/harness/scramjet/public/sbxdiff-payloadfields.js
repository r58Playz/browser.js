/**
 * Payload 3, field by field.
 *
 * Static reading of the interstitial's challenge script (the
 * `orchestrate/chl_page/v1` body, 234 KB, obfuscated with string-table lookups)
 * shows exactly two `/fo/` POST sites. The second builds payload 3 from an
 * object literal of 22 fields -- names randomised per run, but the SHAPE is
 * stable, and only ~500 bytes of it is source, so the 8.7 KB the POST carries
 * lives inside one of those fields.
 *
 * That is the handle. `JSON.stringify` is what turns the object into the string
 * that gets encrypted, so hooking it catches the payload as an object, before
 * the cipher makes it uncomparable (rule 216: the cipher is keyed per run, so
 * there is no comparing ciphertext between sides, ever).
 *
 * Filtered by shape rather than by name, since the names are per-run: a plain
 * object with 10+ short keys serialising to over 2 KB. Reports each field's
 * serialised length, so the two sides can be compared field by field and the
 * ~890-byte gap attributed to one of them.
 *
 * Hooking a global is safe here in a way rule 215's `atob` was not: that
 * measured scramjet's own use because scramjet snapshots `atob` after the probe
 * runs. This filter only matches the challenge's payload shape, and scramjet
 * does not build one.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.payloadfields");
	if (self[GUARD]) return;
	self[GUARD] = true;

	/**
	 * Which document this is.
	 *
	 * "page" is NOT enough. The interstitial and the real page are both
	 * `https://rateyourmusic.com/` -- the same URL -- so a realm label taken
	 * from `location` cannot tell a challenge-time measurement from a
	 * post-redemption one, and the difference is the whole meaning of the
	 * result. The TITLE separates them: "Just a moment..." against the site's
	 * own.
	 */
	var where = function () {
		try {
			if (String(location.href).indexOf("challenges.cloudflare.com") !== -1)
				return "widget";
			// The title is empty this early in BOTH documents, so it does not
			// separate them. `window._cf_chl_opt` does: the interstitial's
			// script defines it and the real page has no such thing.
			var isChl = false;
			try {
				isChl = !!self._cf_chl_opt;
			} catch (e) {}
			var ti = "";
			try {
				ti = String(document.title || "").slice(0, 18);
			} catch (e) {}
			return (isChl ? "INTERSTITIAL" : "realpage") + "[" + ti + "]";
		} catch (err) {
			return "worker";
		}
	};

	var seen = {};

	var stackOf = function () {
		try {
			return String(new Error().stack || "")
				.split("\n")
				.slice(1, 6)
				.join(" <- ")
				.replace(/[A-Za-z0-9_.-]{40,}/g, "<v>");
		} catch (err) {
			return "?";
		}
	};
	var t0 = Date.now();

	try {
		var real = JSON.stringify;
		JSON.stringify = function (value) {
			var out = real.apply(this, arguments);
			try {
				// Loosened: the first filter -- object, 10-40 keys, >2 KB -- matched
				// nothing, so it was a guess about the shape rather than a
				// measurement of it. Report ANY large serialisation and let the
				// output say what the payload actually is.
				if (typeof out === "string" && out.length > 120) {
					var kind = Array.isArray(value)
						? "array[" + value.length + "]"
						: value && typeof value === "object"
							? "object"
							: typeof value;
					// Timestamped, because WHEN decides what this means: a 29 KB
					// value fingerprint built AFTER the challenge completes is a
					// consequence of passing, not a cause of it -- which is what
					// RULES already records about the enumeration payload.
					console.info(
						"sbxdiff-pf " +
							where() +
							" KIND " +
							kind +
							" len=" +
							out.length +
							" t=" +
							(Date.now() - t0) +
							// WHICH script builds it. The keys are not literals in the
							// orchestrate body -- they come from its string table -- so
							// grepping cannot find the site, and the stack is the only
							// way left to name the script.
							(out.length > 5000 ? " @ " + stackOf() : "")
					);
				}
				if (
					typeof out === "string" &&
					out.length > 120 &&
					value &&
					typeof value === "object" &&
					!Array.isArray(value)
				) {
					var keys = Object.keys(value);
					if (keys.length >= 3) {
						// One report per distinct key set, so a payload built
						// once a cycle does not print five times.
						var sig = keys.join(",");
						if (!seen[sig]) {
							seen[sig] = 1;
							var rows = [];
							for (var i = 0; i < keys.length; i++) {
								var n = 0;
								try {
									var piece = real(value[keys[i]]);
									n = piece === undefined ? 0 : piece.length;
								} catch (e) {}
								rows.push(keys[i] + "=" + n);
							}
							rows.sort(function (a, b) {
								return Number(b.split("=")[1]) - Number(a.split("=")[1]);
							});
							console.info(
								"sbxdiff-pf " +
									where() +
									" total=" +
									out.length +
									" fields=" +
									keys.length +
									" :: " +
									rows.join(" ")
							);
						}
					}
				}
			} catch (err) {}

			return out;
		};
	} catch (err) {}
})();
