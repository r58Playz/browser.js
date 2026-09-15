/**
 * What does `Function.prototype.toString` return DURING jsd's own census?
 *
 * The census is decoded (FINDINGS #224): jsd builds a hidden iframe, walks
 * that realm's window/navigator/document, and files each function under
 *
 *   Z instanceof X.Function &&
 *   X.Function.prototype.toString.call(Z).indexOf("[native code]") > 0
 *
 * Replicating that by hand says every shim passes, on both sides, in every
 * realm reachable. So stop replicating and watch the real thing: wrap
 * `toString` in the jsd script's own realm and record what it hands back for
 * each function as the census runs.
 *
 * Planted with `rym.sh probe "scripts/jsd" probes/jsd-native.js`, so BOTH
 * sides run it inside the same script at the same point.
 *
 * Reports through `document.createComment`, which the tracer records and the
 * page cannot read.
 */
(function () {
	"use strict";
	try {
		var native = Function.prototype.toString;
		var seen = 0;
		var say = function (msg) {
			try {
				document.createComment("sbxjsd: " + msg);
			} catch (err) {
				/* no document in this realm */
			}
		};
		Function.prototype.toString = function () {
			var out = native.apply(this, arguments);
			try {
				if (seen++ < 80) {
					var nm = "";
					try {
						nm = this && this.name;
					} catch (err) {
						nm = "(unnamed)";
					}
					say(
						nm +
							" => " +
							String(out).slice(0, 40) +
							" idx=" +
							String(out).indexOf("[native code]") +
							" inst=" +
							(this instanceof Function)
					);
				}
			} catch (err) {
				/* a receiver that will not describe itself */
			}

			return out;
		};
		say("installed in " + String(location.href).slice(0, 40));
	} catch (err) {
		/* frozen prototype */
	}
})();
