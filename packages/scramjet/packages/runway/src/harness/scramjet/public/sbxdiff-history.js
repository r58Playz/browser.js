/**
 * Does the challenge rewrite its own URL, and does the proxy keep it?
 *
 * Measured on rateyourmusic: the oracle's `orchestrate/chl_page/v1` request --
 * the one the served `KbTG4` flag comes back on -- carries
 * `referer: https://rateyourmusic.com/?__cf_chl_rt_tk=...`, and the sandbox's
 * carries `referer: https://rateyourmusic.com/` with no token. Neither side
 * ever REQUESTS a URL with that token (checked against both stores), so the
 * oracle's document URL is being changed in place by `history.replaceState`,
 * and the sandbox's is not.
 *
 * Which leaves two possibilities, and they want different fixes: the guest
 * never calls it, or it calls it and the proxy refuses. `resolveStateUrl`
 * throws a SecurityError on a cross-origin or unparseable URL, and a throw here
 * is invisible from outside -- the challenge would simply carry on with the old
 * URL, which is exactly what the referer shows.
 *
 * So: log the call, the argument, what `location.href` was before and after,
 * and any throw. Guarded by a Symbol, never a string property --
 * `getOwnPropertyNames` does not list symbols, and a string guard called
 * `__sbxpay` once came back inside Cloudflare's own payload.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.history");
	if (window[GUARD]) return;
	window[GUARD] = true;

	var say = function (msg) {
		try {
			console.info("sbxdiff-history: " + msg);
		} catch (err) {}
	};

	var here = function () {
		try {
			return String(location.href).slice(0, 160);
		} catch (err) {
			return "unreadable";
		}
	};

	say(
		"start at " +
			here() +
			" referrer=" +
			String(document.referrer).slice(0, 160)
	);

	["pushState", "replaceState"].forEach(function (name) {
		var real = History.prototype[name];
		if (typeof real !== "function") return;
		History.prototype[name] = function (data, unused, url) {
			var before = here();
			try {
				var out = real.apply(this, arguments);
				say(
					name +
						"(" +
						String(url).slice(0, 120) +
						") OK  before=" +
						before +
						"  after=" +
						here()
				);
				return out;
			} catch (err) {
				// The interesting case. A throw leaves the document URL alone and
				// the guest almost never checks, so it looks like nothing happened.
				say(name + "(" + String(url).slice(0, 120) + ") THREW " + err);
				throw err;
			}
		};
	});

	// The URL can also move without either of those -- a fragment change, or a
	// same-document navigation -- so sample it too.
	var last = here();
	setInterval(function () {
		var now = here();
		if (now !== last) {
			say("url changed to " + now);
			last = now;
		}
	}, 500);
})();
