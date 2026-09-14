/**
 * The oracle half of `sbxdiff-shimread.js`.
 *
 * The sandbox can record what the guest read because scramjet funnels every
 * intercepted access through one trap. The oracle has no such funnel -- there is
 * no shim -- so the same members are wrapped here on their native prototypes,
 * aggregated the same way, and dumped in the same format.
 *
 * Same members, same units, one side through the proxy and one not. That is the
 * whole point: a number from the sandbox is only worth having if the oracle's
 * came from the same question.
 *
 * The member list is the one the sandbox reported reading, so it is derived from
 * a measurement rather than guessed. `Iface.prop` wraps a prototype accessor or
 * method; `window.x` wraps the global's own.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.nativeread.installed");
	if (window[GUARD]) return;
	window[GUARD] = true;

	var MEMBERS = [
		"CSSRule.cssText",
		"window.getComputedStyle",
		"PerformanceEntry.name",
		"HTMLElement.style",
		"URL.createObjectURL",
		"Element.innerHTML",
		"PerformanceResourceTiming.encodedBodySize",
		"XMLHttpRequest.getResponseHeader",
		"PerformanceResourceTiming.transferSize",
		"PerformanceScriptTiming.sourceURL",
		"SVGElement.style",
		"window.origin",
		"Performance.getEntries",
		"Document.cookie",
		"PerformanceObserverEntryList.getEntries",
		"PerformanceResourceTiming.decodedBodySize",
		"Document.referrer",
		"Performance.getEntriesByType",
		"CSSStyleSheet.insertRule",
	];

	var stats = new Map();
	var sizeOf = function (v) {
		try {
			if (typeof v === "string") return v.length;
			if (typeof v === "number" || typeof v === "boolean")
				return String(v).length;
			if (v == null) return 0;
			if (typeof v.length === "number" && typeof v !== "function")
				return v.length;

			return 0;
		} catch (err) {
			return 0;
		}
	};
	var note = function (member, value) {
		var row = stats.get(member);
		if (!row) {
			row = { n: 0, bytes: 0 };
			stats.set(member, row);
		}
		row.n++;
		row.bytes += sizeOf(value);
	};

	MEMBERS.forEach(function (spec) {
		try {
			var dot = spec.indexOf(".");
			var iface = spec.slice(0, dot);
			var prop = spec.slice(dot + 1);
			var host;
			if (iface === "window") host = window;
			else {
				var ctor = window[iface];
				if (!ctor) return;
				host = ctor.prototype;
			}
			var d = Object.getOwnPropertyDescriptor(host, prop);
			if (!d) return;

			if (d.get) {
				var realGet = d.get;
				Object.defineProperty(host, prop, {
					configurable: true,
					enumerable: d.enumerable,
					get: function () {
						var v = realGet.call(this);
						note("get " + iface + "." + prop, v);

						return v;
					},
					set: d.set,
				});
			} else if (typeof d.value === "function") {
				var realFn = d.value;
				Object.defineProperty(host, prop, {
					configurable: true,
					enumerable: d.enumerable,
					writable: d.writable,
					value: function () {
						var v = realFn.apply(this, arguments);
						note(iface + "." + prop + " ", v);

						return v;
					},
				});
			}
		} catch (err) {}
	});

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
