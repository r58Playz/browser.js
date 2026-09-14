/**
 * The widget's verdict at the instant the interstitial blanks its node.
 *
 * On stock Chromium, pausing on `Node.prototype.textContent = ""` after the
 * challenge shows the Turnstile widget already displaying "Success!" -- the
 * verdict div revealed with an INLINE style (`display: grid; visibility:
 * visible`) while every other state div stays `display: none`. Classes are not
 * the signal: `MmgY4` and friends are on the interstitial's own <h2>.
 *
 * A `debugger` statement is the right tool by hand and useless in an automated
 * run, so this captures the same instant instead:
 *
 *   - every realm hooks the `textContent` setter and logs when it writes "",
 *   - the widget's realm samples which of its state divs is actually revealed
 *     and logs only when that CHANGES,
 *   - `HTMLFormElement.prototype.submit` is hooked too, because the redemption
 *     POST is the thing that does not happen afterwards.
 *
 * Both carry a timestamp, so the state at the blank is the last sample before
 * it. Sampling rather than reading across realms on demand: the interstitial
 * and the widget are cross-origin to each other and the proxy now enforces
 * that, so the blanking realm cannot reach into the widget to ask.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.blankstate");
	if (window[GUARD]) return;
	window[GUARD] = true;

	var t0 = Date.now();
	var at = function () {
		return String(Date.now() - t0);
	};
	var here = function () {
		try {
			return String(location.href).slice(0, 64);
		} catch (err) {
			return "?";
		}
	};
	var say = function (msg) {
		try {
			console.info("sbxdiff-blank " + msg);
		} catch (err) {}
	};

	// Shadow roots have to be caught as they are created: Turnstile's is
	// CLOSED, so there is no `el.shadowRoot` to find afterwards.
	var roots = [];
	try {
		var realAttach = Element.prototype.attachShadow;
		Element.prototype.attachShadow = function () {
			var root = realAttach.apply(this, arguments);
			try {
				roots.push(root);
			} catch (err) {}

			return root;
		};
	} catch (err) {}

	// `textContent = ""`, in whatever realm does it.
	try {
		var desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
		Object.defineProperty(Node.prototype, "textContent", {
			get: desc.get,
			set: function (value) {
				try {
					if (value === "") {
						var what = "";
						try {
							what = String(this.id || this.nodeName || "").slice(0, 24);
						} catch (e) {}
						say("BLANK t=" + at() + " on=" + what + " in=" + here());
					}
				} catch (err) {}

				return desc.set.call(this, value);
			},
			configurable: true,
		});
	} catch (err) {}

	// The redemption form. Both entry points: `submit()` and `requestSubmit()`.
	["submit", "requestSubmit"].forEach(function (fn) {
		try {
			var real = HTMLFormElement.prototype[fn];
			if (typeof real !== "function") return;
			HTMLFormElement.prototype[fn] = function () {
				var where = "?";
				try {
					where = (this.method || "") + " " + (this.action || "");
				} catch (err) {}
				say("FORM." + fn + " t=" + at() + " " + where.slice(0, 90));

				return real.apply(this, arguments);
			};
		} catch (err) {}
	});

	/** The state divs that are actually revealed, with their text. */
	var visible = function () {
		var out = [];
		for (var i = 0; i < roots.length; i++) {
			var all;
			try {
				all = roots[i].querySelectorAll("*");
			} catch (err) {
				continue;
			}
			for (var j = 0; j < all.length; j++) {
				var el = all[j];
				try {
					// Inline style only. That is what the challenge sets, and
					// reading the computed style would report every ancestor's
					// default as a reveal.
					var d = el.style && el.style.display;
					if (!d || d === "none") continue;
					var txt = (el.textContent || "").trim();
					if (!txt || txt.length > 60) continue;
					out.push(txt);
				} catch (err) {}
			}
		}

		return out.join(" | ");
	};

	var last = null;
	setInterval(function () {
		var now = visible();
		if (now !== last) {
			last = now;
			if (now) say("SHOWS t=" + at() + " " + now);
		}
	}, 120);
})();
