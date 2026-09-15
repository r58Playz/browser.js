/**
 * What the widget SAYS and what it is TOLD, over postMessage.
 *
 * FINDINGS #247 left the poll question here. Per 550 ms round both sides do the
 * same guest-visible work -- three `MessageEvent.data` reads, one
 * `postMessage`, one `createScript` -- and the oracle stops after 7 rounds
 * while the sandbox runs 208. The shapes match; the contents have never been
 * read on either side.
 *
 * They cannot be read from the trace. `Window.postMessage` is Web IDL so the
 * CALL is recorded, but RULES #2 forbids the tracer serialising object
 * contents, so `MessageEvent.data` arrives as an object id and says nothing.
 * The guest-op recorder inherits the same rule. So the contents need a probe,
 * in the page, which is what this is.
 *
 *     rym.sh probe "turnstile/f/av0" probes/postmessage.js
 *
 * Planted in the widget's own script, so it runs on BOTH sides at the same
 * point in the same code -- the one thing no amount of reasoning about two
 * separate runs can give you.
 *
 * ## What it perturbs, and why that is acceptable here
 *
 * It wraps `window.postMessage`, so `postMessage.toString()` stops reading
 * `[native code]` while the probe is installed. That is a real perturbation and
 * it is SYMMETRIC: both sides are patched identically by the same planted
 * bytes, which is the whole point of `probestore.ts`. The same reasoning as
 * every other probe in this directory -- and the report from a probed run means
 * nothing anyway, so read these lines and ignore the bucket count.
 *
 * Rule 215 the other way round: hooking a global BEFORE scramjet snapshots it
 * measures scramjet. This runs after, inside guest code, so on the sandbox it
 * wraps the shim and on the oracle the native -- which is exactly the guest's
 * view, and the view being compared.
 *
 * NO TIMERS. The guest-op recorder's first version flushed on `setInterval`
 * and took timer id 1, shifting every id the page minted after it and
 * manufacturing a divergence in the thing it was measuring. This reports
 * synchronously.
 */
(function () {
	"use strict";
	var doc = document;
	if (!doc || !doc.createComment) return;
	// Bound before anything else, so a later patch by the page or the shim does
	// not reach the sink.
	var createComment = Function.prototype.bind.call(doc.createComment, doc);
	/** The tracer truncates a traced string at 512 bytes; stay inside it. */
	var CHUNK = 440;
	var n = 0;

	var say = function (line) {
		// Split explicitly and mark the pieces. A silently split line decodes as
		// two wrong events, which is worse than a line that says it was cut.
		for (var i = 0; i < line.length; i += CHUNK) {
			var part = line.slice(i, i + CHUNK);
			try {
				createComment(
					"sbxpm: " +
						(i ? "+" : "") +
						part +
						(i + CHUNK < line.length ? "…" : "")
				);
			} catch (err) {
				/* nothing to do; the sink is the only channel */
			}
		}
	};

	/** FNV-1a, so a long value is compared on its whole content, not a prefix. */
	var hash = function (s) {
		var h = 2166136261;
		for (var i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		return h.toString(36);
	};

	/**
	 * A value as something two runs can be compared on.
	 *
	 * Structured-clone data is JSON-shaped in practice, and where it is not the
	 * fallback names the type rather than guessing. Long strings carry a prefix,
	 * the true length and a hash -- the same contract the guest-op recorder
	 * uses, so a difference in the middle of a big string is still caught.
	 */
	var enc = function (v, depth) {
		var t = typeof v;
		if (v === null) return "null";
		if (t === "undefined") return "undefined";
		if (t === "boolean" || t === "number") return String(v);
		if (t === "string") {
			return v.length <= 120
				? JSON.stringify(v)
				: JSON.stringify(v.slice(0, 60)) +
						"..<" +
						v.length +
						":" +
						hash(v) +
						">";
		}
		if (t === "function") return "fn:" + (v.name || "?");
		if (t !== "object") return t;
		if (depth > 3) return "{…}";
		try {
			if (Array.isArray(v)) {
				var out = [];
				for (var i = 0; i < v.length && i < 12; i++)
					out.push(enc(v[i], depth + 1));
				if (v.length > 12) out.push("+" + (v.length - 12));
				return "[" + out.join(",") + "]";
			}
			// Keys in their own order, not sorted: the order is the page's and a
			// difference in it is a difference worth seeing.
			var keys = Object.keys(v);
			var parts = [];
			for (var k = 0; k < keys.length && k < 24; k++) {
				parts.push(keys[k] + ":" + enc(v[keys[k]], depth + 1));
			}
			if (keys.length > 24) parts.push("+" + (keys.length - 24));
			return "{" + parts.join(",") + "}";
		} catch (err) {
			return "{unreadable}";
		}
	};

	// ---- outgoing ----------------------------------------------------------
	try {
		var nativePost = window.postMessage;
		window.postMessage = function (message, targetOrigin) {
			try {
				say(++n + "|OUT|" + enc(targetOrigin, 0) + "|" + enc(message, 0));
			} catch (err) {
				/* never let the probe break the page it is watching */
			}
			return nativePost.apply(this, arguments);
		};
	} catch (err) {
		say("OUT-HOOK-FAILED");
	}

	// ---- incoming ----------------------------------------------------------
	//
	// A capture listener rather than a wrap of `addEventListener`: wrapping it
	// would change the registration order of every listener the page adds after
	// this point, and order decides who sees an event first.
	try {
		window.addEventListener(
			"message",
			function (e) {
				try {
					say(
						++n +
							"|IN|" +
							enc(e.origin, 0) +
							"|src=" +
							(e.source === window.parent
								? "parent"
								: e.source === window
									? "self"
									: e.source
										? "other"
										: "null") +
							"|" +
							enc(e.data, 0)
					);
				} catch (err) {
					/* as above */
				}
			},
			true
		);
	} catch (err) {
		say("IN-HOOK-FAILED");
	}

	say("installed");
})();
