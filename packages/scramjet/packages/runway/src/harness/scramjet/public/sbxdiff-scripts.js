/**
 * Every script the interstitial tries to load.
 *
 * The oracle's challenge page fetches `challenge-platform/scripts/jsd/main.js`
 * and runs it at t=181 ms; the sandbox requests it zero times (RULES.md #218).
 * Both sides are told to by a `/fo/` response of identical size, so the
 * question is whether the sandbox ATTEMPTS the load and it fails, or never
 * attempts it -- and those want completely different fixes.
 *
 * Hooks the three ways a script can be introduced: the `src` setter,
 * `setAttribute`, and insertion. `document.createElement` is deliberately NOT
 * wrapped -- Cloudflare caches it at parse time, so a wrapper installed here is
 * either too late or visible, and the `src` setter catches the same thing
 * without touching what the page cached.
 *
 * `window._cf_chl_opt` tells the interstitial from the real page: they share
 * the URL `https://rateyourmusic.com/` and both have an empty title this early.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.scripts");
	if (self[GUARD]) return;
	self[GUARD] = true;

	var t0 = Date.now();
	var who = function () {
		try {
			if (String(location.href).indexOf("challenges.cloudflare.com") !== -1)
				return "widget";
			return self._cf_chl_opt ? "INTERSTITIAL" : "realpage";
		} catch (err) {
			return "?";
		}
	};
	var say = function (how, url) {
		try {
			var u = String(url);
			console.info(
				"sbxdiff-script " +
					who() +
					" t=" +
					(Date.now() - t0) +
					" " +
					how +
					" " +
					(/jsd/.test(u) ? "JSD! " : "") +
					u.replace(/[A-Za-z0-9_.:-]{34,}/g, "<t>").slice(0, 96)
			);
		} catch (err) {}
	};

	try {
		var d = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
		if (d && d.set) {
			Object.defineProperty(HTMLScriptElement.prototype, "src", {
				configurable: true,
				enumerable: d.enumerable,
				get: d.get,
				set: function (v) {
					say("src=", v);

					return d.set.call(this, v);
				},
			});
		}
	} catch (err) {}

	try {
		var realSetAttr = Element.prototype.setAttribute;
		Element.prototype.setAttribute = function (name, value) {
			try {
				if (String(name).toLowerCase() === "src" && this.tagName === "SCRIPT")
					say("setAttribute", value);
			} catch (e) {}

			return realSetAttr.apply(this, arguments);
		};
	} catch (err) {}

	["appendChild", "insertBefore", "append"].forEach(function (m) {
		try {
			var real = Node.prototype[m] || Element.prototype[m];
			if (typeof real !== "function") return;
			var host = Node.prototype[m] ? Node.prototype : Element.prototype;
			host[m] = function (node) {
				try {
					if (node && node.tagName === "SCRIPT" && node.src) say(m, node.src);
				} catch (e) {}

				return real.apply(this, arguments);
			};
		} catch (err) {}
	});
})();
