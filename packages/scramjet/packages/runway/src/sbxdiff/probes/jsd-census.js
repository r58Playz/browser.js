/**
 * jsd's census, run from jsd's OWN realm.
 *
 * FINDINGS #224 decoded the classifier and the walk: from the about:blank
 * frame jsd runs in, it creates a hidden iframe, takes that child's
 * `contentWindow`, and files each function under
 *
 *   Z instanceof X.Function &&
 *   X.Function.prototype.toString.call(Z).indexOf("[native code]") > 0
 *
 * where X is the CHILD's window -- so the `toString` doing the judging is the
 * child realm's, which nothing in the page has touched. Replicating this from
 * a test page said every shim passes. Replicating it from the realm jsd
 * actually runs in is the difference that was never tested.
 *
 * Planted with `rym.sh probe "scripts/jsd" probes/jsd-census.js`, so both
 * sides run it in the same script at the same point. Reports through
 * `document.createComment`, which the tracer records and the page cannot read.
 */
(function () {
	"use strict";
	var say = function (msg) {
		try {
			document.createComment("sbxcensus: " + msg);
		} catch (err) {
			/* no document here */
		}
	};
	var run = function () {
		try {
			var fr = document.createElement("iframe");
			fr.style = "display: none";
			fr.tabIndex = "-1";
			document.body.appendChild(fr);
			var X = fr.contentWindow;
			var names = [
				["", "fetch"],
				["", "setTimeout"],
				["", "clearTimeout"],
				["", "postMessage"],
				["", "getComputedStyle"],
				["", "open"],
				["", "addEventListener"],
				["", "alert"],
				["", "btoa"],
				["n.", "sendBeacon"],
				["d.", "write"],
				["d.", "querySelector"],
			];
			var owners = {
				"": X,
				"n.": X.clientInformation || X.navigator,
				"d.": fr.contentDocument,
			};
			for (var i = 0; i < names.length; i++) {
				var pre = names[i][0],
					nm = names[i][1];
				var Z = owners[pre][nm];
				var inst = false,
					ts = "",
					idx = -1;
				try {
					inst = Z instanceof X.Function;
				} catch (err) {
					inst = "THREW";
				}
				try {
					ts = X.Function.prototype.toString.call(Z);
					idx = ts.indexOf("[native code]");
				} catch (err) {
					ts = "THREW:" + err;
				}
				say(
					pre +
						nm +
						" => " +
						(inst && idx > 0 ? "N" : "f") +
						" inst=" +
						inst +
						" idx=" +
						idx +
						" ts=" +
						String(ts).slice(0, 38)
				);
			}
			document.body.removeChild(fr);
		} catch (err) {
			say("census failed: " + err);
		}
	};
	say("ready in " + String(location.href).slice(0, 34));
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", run);
	} else {
		run();
	}
})();
