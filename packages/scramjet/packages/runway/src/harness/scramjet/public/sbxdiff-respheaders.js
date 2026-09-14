/**
 * Can the guest read response headers a browser forbids?
 *
 * `set-cookie` is a forbidden response header: `getAllResponseHeaders()` never
 * returns it and `getResponseHeader("set-cookie")` is always null, in every
 * browser. scramjet carries response headers across the proxy under renamed
 * keys and restores them, so the question is whether the restore puts back a
 * header the browser would have withheld.
 *
 * It matters because the sandbox encodes a 907-byte blob into its payload that
 * begins with the literal `cf_clearance`, and the guest's `document.cookie`
 * does not contain it -- so it is reaching the page some other way.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.respheaders");
	if (self[GUARD]) return;
	self[GUARD] = true;
	var seen = {};
	try {
		var real = XMLHttpRequest.prototype.getAllResponseHeaders;
		XMLHttpRequest.prototype.getAllResponseHeaders = function () {
			var out = real.apply(this, arguments);
			try {
				var names = String(out || "")
					.split("\r\n")
					.map(function (l) {
						return l.split(":")[0].trim().toLowerCase();
					})
					.filter(Boolean);
				for (var i = 0; i < names.length; i++) {
					if (seen[names[i]]) continue;
					seen[names[i]] = 1;
					// Only the forbidden ones are worth a line.
					if (/^set-cookie|^cookie$/.test(names[i]))
						console.info("sbxdiff-hdr FORBIDDEN-EXPOSED " + names[i]);
				}
				if (/set-cookie/i.test(String(out || "")))
					console.info(
						"sbxdiff-hdr getAllResponseHeaders leaks set-cookie, len=" +
							out.length
					);
			} catch (err) {}
			return out;
		};
	} catch (err) {}
	try {
		var realOne = XMLHttpRequest.prototype.getResponseHeader;
		XMLHttpRequest.prototype.getResponseHeader = function (name) {
			var v = realOne.apply(this, arguments);
			try {
				if (/^set-cookie$/i.test(String(name)) && v != null)
					console.info(
						"sbxdiff-hdr getResponseHeader('set-cookie') returned " +
							String(v).length +
							" chars"
					);
			} catch (err) {}
			return v;
		};
	} catch (err) {}
})();
