/**
 * Does the FETCH path expose what XHR does not?
 *
 * `getAllResponseHeaders()` was checked and is clean, but scramjet shims fetch
 * separately and carries response headers across the proxy under renamed keys.
 * `set-cookie` is a forbidden response header: `Headers.get("set-cookie")` is
 * null and iterating a Response's headers never yields it, in every browser.
 *
 * The sandbox encodes a 907-byte string beginning `cf_clearance` into its
 * challenge payload and the oracle never does, and it is not coming from
 * `document.cookie`. This is the other way it could reach the page.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.fetchhdr");
	if (self[GUARD]) return;
	self[GUARD] = true;

	var shout = function (what) {
		try {
			console.info("sbxdiff-fhdr " + what);
		} catch (err) {}
	};
	var FORBIDDEN = /^set-cookie|^set-cookie2$/i;

	try {
		var realGet = Headers.prototype.get;
		Headers.prototype.get = function (name) {
			var v = realGet.apply(this, arguments);
			try {
				if (FORBIDDEN.test(String(name)) && v != null)
					shout(
						"Headers.get('" + name + "') -> " + String(v).length + " chars"
					);
			} catch (err) {}

			return v;
		};
	} catch (err) {}

	// Iteration is the other way to find one without asking for it by name.
	["forEach", "entries", "keys"].forEach(function (m) {
		try {
			var real = Headers.prototype[m];
			if (typeof real !== "function") return;
			Headers.prototype[m] = function () {
				try {
					var names = [];
					realGet && null;
					var it = Headers.prototype.keys.call(this);
					var n = it.next();
					while (!n.done) {
						names.push(String(n.value).toLowerCase());
						n = it.next();
					}
					for (var i = 0; i < names.length; i++)
						if (FORBIDDEN.test(names[i]))
							shout("Headers." + m + " yields " + names[i]);
				} catch (err) {}

				return real.apply(this, arguments);
			};
		} catch (err) {}
	});

	// And the carried names themselves: if a renamed header survives to the
	// page under ANY spelling, the page can read it and undo the rename.
	try {
		var realKeys = Headers.prototype.keys;
		var reported = {};
		Headers.prototype.keys = function () {
			var out = realKeys.apply(this, arguments);
			try {
				var copy = realKeys.apply(this, arguments);
				var n = copy.next();
				while (!n.done) {
					var k = String(n.value).toLowerCase();
					if (!reported[k] && /cookie|scramjet|x-sj|carried/.test(k)) {
						reported[k] = 1;
						shout("header name visible to guest: " + k);
					}
					n = copy.next();
				}
			} catch (err) {}

			return out;
		};
	} catch (err) {}
})();
