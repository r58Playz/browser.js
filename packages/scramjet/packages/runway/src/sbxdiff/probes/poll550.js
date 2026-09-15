/**
 * What the widget's 550 ms poll actually tests.
 *
 * FINDINGS #235: the Turnstile widget arms a 550 ms timer 7 times on the
 * oracle and 207 on the sandbox, and those 200 extra rounds are the whole of
 * the 116 seconds the sandbox spends parked (#234). Both sides run the same
 * recorded script, so the poll BODY is the same source on both -- reading it
 * is what says which condition is being re-tested, and reading it from inside
 * the widget's own realm is the only place it exists.
 *
 * Planted with `rym.sh probe "turnstile/f/av0" probes/poll550.js`, so it runs
 * in that script on BOTH sides at the same point.
 *
 * Reports through `document.createComment`, which lands in the trace as a
 * string and which nothing else in the page can read -- `document.title` is
 * read by the payloads this is pointed at (ARCHITECTURE.md, "Probes").
 *
 * Hooks `setTimeout` from INSIDE the widget script, which is after scramjet has
 * installed, so on the sandbox this wraps the shim and on the oracle the
 * native. That asymmetry is fine here and is the point of rule 215's caution
 * read the other way round: the guest's own callback is the argument either
 * way, and the callback is what this reads.
 */
(function () {
	"use strict";
	var say = function (msg) {
		try {
			document.createComment("sbxpoll: " + msg);
		} catch (err) {
			/* no document */
		}
	};
	var native = window.setTimeout;
	if (typeof native !== "function") return;
	var rounds = 0;
	/** Source of a callback, flattened and clipped so a chunk carries it. */
	var srcOf = function (fn) {
		try {
			return String(fn).replace(/\s+/g, " ").slice(0, 300);
		} catch (err) {
			return "<toString threw>";
		}
	};
	var seen = Object.create(null);
	window.setTimeout = function (fn, delay) {
		// Only the poll. Every other delay in this realm is a one-off and
		// already counted in the trace.
		if (delay === 550 && typeof fn === "function") {
			rounds++;
			var s = srcOf(fn);
			// Once per distinct body, plus a count: 207 copies of one line is
			// noise, and whether the body CHANGES between rounds is the thing
			// worth knowing.
			if (!seen[s]) {
				seen[s] = 1;
				say("round " + rounds + " body#" + Object.keys(seen).length + " " + s);
			} else {
				seen[s]++;
			}
			if (rounds === 1 || rounds === 7 || rounds === 8 || rounds % 50 === 0) {
				say("round " + rounds + " armed");
			}
		}
		return native.apply(this, arguments);
	};
	say("installed");
	// The totals, once, at the end -- the run is killed rather than unloaded,
	// so this rides on the same two events the guest-op recorder uses.
	var drain = function () {
		var keys = Object.keys(seen);
		say("TOTAL rounds=" + rounds + " distinct bodies=" + keys.length);
		for (var i = 0; i < keys.length && i < 4; i++) {
			say(
				"body#" + (i + 1) + " x" + seen[keys[i]] + " " + keys[i].slice(0, 200)
			);
		}
	};
	try {
		window.addEventListener("pagehide", drain, { capture: true });
		window.addEventListener("beforeunload", drain, { capture: true });
	} catch (err) {
		/* no events */
	}
})();
