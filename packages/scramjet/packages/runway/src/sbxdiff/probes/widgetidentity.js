/**
 * Does the Turnstile widget see `parent === top`, in the real widget?
 *
 * FINDINGS #243 claimed it does not, from trace object ids, and #245 withdraws
 * that: the ids compared were the ORACLE's guest reads against the SANDBOX's
 * SHIM reads, because `parent` is intercepted and the guest's read is a guest
 * op. `pages/windowidentity.html` then said the relation holds on both sides --
 * but for a same-origin `srcdoc` child, which is not what the widget is.
 *
 * The widget is cross-origin to the page that embeds it, so it exercises
 * `client/shared/crossorigin.ts`, and that path is what `windowidentity.html`
 * cannot reach hermetically: the harness serves every guest from one real
 * origin and only a STORE has two pretend ones.
 *
 * So ask inside the widget's own script, on both sides at once:
 *   rym.sh probe "turnstile/f/av0" probes/widgetidentity.js
 *
 * Reports through `document.createComment`, which lands in the trace and which
 * nothing else in the page can read.
 */
(function () {
	"use strict";
	var say = function (s) {
		try {
			document.createComment("sbxwid: " + s);
		} catch (err) {
			/* no document */
		}
	};
	var probe = function (label, get) {
		try {
			say(label + " " + String(get()));
		} catch (err) {
			say(label + " THREW " + (err && err.name ? err.name : "?"));
		}
	};
	// The relation the widget would care about, and the ones that would explain
	// it if it fails.
	probe("parent===top", function () {
		return window.parent === window.top;
	});
	probe("parent===self", function () {
		return window.parent === window.self;
	});
	probe("top===self", function () {
		return window.top === window.self;
	});
	// Read twice: scramjet mints a proxy per access unless it caches, and two
	// mints of one window are two objects. This is the shape #243 guessed at
	// and never actually tested.
	probe("parent===parent", function () {
		return window.parent === window.parent;
	});
	probe("top===top", function () {
		return window.top === window.top;
	});
	// What a browser allows across the boundary, and what it refuses.
	probe("parent.location.href", function () {
		return window.parent.location.href;
	});
	probe("parent.origin", function () {
		return window.parent.origin;
	});
	probe("self.origin", function () {
		return window.self.origin;
	});
	probe("ancestorOrigins", function () {
		var a = window.location.ancestorOrigins;
		return a ? Array.prototype.join.call(a, ",") : "(none)";
	});
})();
