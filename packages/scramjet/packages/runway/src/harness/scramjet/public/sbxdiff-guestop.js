/**
 * The guest-op recorder: what the GUEST asked scramjet for, and what it got.
 *
 * This is the half of the diff that did not exist.
 *
 * The binding tracer records native calls. For an API scramjet leaves alone
 * that is the guest's view and both sides record it. For an API scramjet
 * INTERCEPTS it is not: the guest calls a trap, the trap calls the native, and
 * the native's record has scramjet's script on top -- so the differ, which
 * pairs guest calls against guest calls, finds zero on the sandbox side and
 * reports `missing-call` at T2. Measured on rateyourmusic, in the page realm
 * alone: 43 APIs and 1344 calls, `Element.getAttribute` at 217 against 0. A
 * further 18 APIs never reach a native at all -- scramjet answers `location`
 * out of the URL string it already holds -- so no binding record exists to
 * compare even in principle.
 *
 * That is the whole intercepted surface, which is exactly the surface scramjet
 * can be WRONG about, and 663 buckets of the rateyourmusic baseline are it.
 *
 * scramjet funnels every interception through four places, and each of them
 * knows both who asked and what the answer was:
 *
 *   ScramjetClient.RawProxy    function and constructor members
 *   ScramjetClient.RawTrap     accessor and data members
 *   ScramjetClient.Intercept   class-handler members (`createProxy`)
 *   createLocationProxy        location's own per-property proxies
 *
 * They call the recorder this file installs, if it is there. Off unless the
 * symbol is present, which is one global lookup when off.
 *
 * ## Depth is the cut
 *
 * scramjet's own code uses the trapped members -- its URL rewriter reads
 * `location`, its element shims read attributes -- so a recorder that logged
 * every entry would log scramjet's plumbing as though the guest had asked for
 * it. The outermost entry is the guest's; everything nested inside it is
 * scramjet working. So the recorder counts depth and records only at zero.
 *
 * That is the guest-op bracket ARCHITECTURE.md specifies, in JS rather than in
 * C++, and it needs no Chromium rebuild.
 *
 * ## The sink
 *
 * `document.createComment`, buffered. The argument lands in the trace as a
 * string and nothing else in the page can read a detached Comment, which is
 * why `probestore.ts` already reports through it. Buffered because an
 * unbuffered one would put a binding record between every pair of guest ops
 * and roughly double the trace.
 *
 * Long values are NOT shipped out whole -- the tracer truncates a string at
 * 512 bytes, so a chunk that overran would lose the end of it silently. The
 * recorder emits a prefix, the true length and a hash. It also runs the leak
 * check itself, on the value it still has in hand, so a proxy URL buried in
 * the middle of a 40 KB string is still caught. Doing it here is strictly
 * better than shipping the string: no truncation can hide it.
 *
 * Documents only. A worker has no `document`, and the realms that matter on
 * rateyourmusic -- the page, the interstitial, the Turnstile widget -- are all
 * documents. The blob workers run Cloudflare's SubtleCrypto benchmark, which is
 * a timing loop, not an API surface.
 */
(function () {
	"use strict";
	var GUARD = Symbol.for("sbxdiff.guestop.installed");
	if (typeof window === "undefined" || window[GUARD]) return;
	window[GUARD] = true;

	// Captured before scramjet installs anything, which is what `probePath`
	// guarantees: this runs with scramjet's own bootstrap, ahead of the guest.
	// Reading them later would read the interceptors instead and the sink would
	// re-enter the thing it is measuring.
	var doc = window.document;
	var createComment =
		doc && doc.createComment
			? Function.prototype.bind.call(doc.createComment, doc)
			: null;
	if (!createComment) return;
	var stringify = String;
	var WeakMapCtor = window.WeakMap;

	/** Chunk marker. Not a string the page would pass to createComment. */
	var MARK = "sbxgop";
	/** Separates events inside one chunk. */
	var SEP = "";
	/** Marks a line that was itself over the chunk budget. */
	var OVERLONG = "";
	/** The tracer truncates a traced string at 512 bytes; stay inside it. */
	var CHUNK_MAX = 440;
	/**
	 * A value longer than this is emitted as prefix + true length + hash.
	 *
	 * 200 because that is above every value the comparison turns on -- a URL,
	 * an origin, a cookie string, a referrer, a user-agent -- and below the
	 * chunk budget, so an ordinary event still shares a chunk with its
	 * neighbours. Past it the oracle has the first 512 bytes (the tracer's own
	 * cap) and this has the first 48 plus a hash of the whole, so the two are
	 * compared on length and the common prefix. See `docs/sbxdiff/GUEST-OPS.md`.
	 */
	var VALUE_MAX = 200;

	var buf = "";
	var n = 0;
	var dropped = 0;

	function flush() {
		if (!buf) return;
		var payload = MARK + buf;
		buf = "";
		try {
			createComment(payload);
		} catch (err) {
			dropped++;
		}
	}

	// NOT a timer.
	//
	// The first version flushed on `setInterval(flush, 250)` and the run
	// promptly reported `Window.setTimeout` returning 3 on the oracle against 2
	// in the sandbox, and `setInterval` 2 against 5. Those were real
	// divergences in a real sense -- the guest CAN read a timer id and
	// rateyourmusic's own probe page exists because Cloudflare does -- and they
	// were caused by the instrument. The recorder had taken timer id 1 and
	// shifted every id the page minted after it.
	//
	// A microtask takes no id and nothing observable. Scheduled only when
	// there is something to flush and only one at a time, so an idle page
	// schedules nothing at all, and every task's ops reach the trace at the end
	// of that task -- which bounds what a kill can lose to one task rather than
	// to 250 ms.
	var pending = false;
	var queue =
		typeof queueMicrotask === "function"
			? queueMicrotask
			: function (f) {
					Promise.resolve().then(f);
				};

	function scheduleFlush() {
		if (pending || !buf) return;
		pending = true;
		queue(function () {
			pending = false;
			flush();
		});
	}

	function emit(line) {
		if (buf.length + line.length + 1 > CHUNK_MAX) flush();
		// A single line over the budget would loop forever against the check
		// above, so it goes out alone and is marked as over-long rather than
		// silently split -- a split line decodes as two wrong events.
		if (line.length > CHUNK_MAX) {
			buf = line.slice(0, CHUNK_MAX - 2) + OVERLONG;
			flush();

			return;
		}
		buf = buf ? buf + SEP + line : line;
		scheduleFlush();
	}

	// ---- leak markers -------------------------------------------------------
	//
	// The recorder checks these itself, on the whole value, because it is the
	// last place that HAS the whole value. Taken from the document's own
	// location rather than hardcoded: the harness port is a harness detail and
	// a stale constant here would report a clean run.
	var chromeOrigin = "";
	try {
		chromeOrigin = window.location.origin;
	} catch (err) {
		/* opaque origin */
	}
	var SHIM_IDS = [
		"$scramjet",
		"ScramjetClient",
		"__scramjet",
		"$scramjetController",
	];

	function leaks(s) {
		if (s.indexOf("/~/sj/") >= 0) return "p";
		if (chromeOrigin && s.indexOf(chromeOrigin) >= 0) return "c";
		for (var i = 0; i < SHIM_IDS.length; i++) {
			if (s.indexOf(SHIM_IDS[i]) >= 0) return "s";
		}

		return "";
	}

	/**
	 * Length in UTF-8 BYTES, which is what the tracer reports for a traced
	 * string.
	 *
	 * `s.length` is UTF-16 code units, and comparing one against the other
	 * reports every non-ASCII value as a length divergence -- a page title with
	 * an accent in it, which rateyourmusic has. Computed only when the string
	 * is not ASCII, so the common case is still a property read.
	 */
	var NON_ASCII = /[^\x00-\x7f]/;

	function utf8len(s) {
		if (!NON_ASCII.test(s)) return s.length;
		var n = 0;
		for (var i = 0; i < s.length; i++) {
			var c = s.charCodeAt(i);
			if (c < 0x80) n += 1;
			else if (c < 0x800) n += 2;
			else if (c >= 0xd800 && c <= 0xdbff) {
				// A surrogate PAIR is one 4-byte code point. A lone surrogate is
				// not, and the encoder would emit U+FFFD for it -- 3 bytes -- so
				// only advance past a real low surrogate.
				var d = s.charCodeAt(i + 1);
				if (d >= 0xdc00 && d <= 0xdfff) {
					n += 4;
					i++;
				} else n += 3;
			} else n += 3;
		}

		return n;
	}

	function hash(s) {
		// FNV-1a, matching store.ts so a hash can be read across the two.
		var h = 0x811c9dc5;
		for (var i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i) & 0xff;
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}

		return h.toString(36);
	}

	// ---- identity -----------------------------------------------------------
	//
	// Run-local ids in first-sighting order, the same scheme the C++ tracer
	// uses, so "the sandbox minted a fresh object where the oracle reused one"
	// is answerable. A WeakMap rather than a property on the object: a property
	// forces a hidden-class transition and is visible to the page.
	var ids = WeakMapCtor ? new WeakMapCtor() : null;
	var nextId = 1;

	function idOf(o) {
		if (!ids) return 0;
		var got = ids.get(o);
		if (got === undefined) {
			got = nextId++;
			ids.set(o, got);
		}

		return got;
	}

	function esc(s) {
		var out = "";
		for (var i = 0; i < s.length; i++) {
			var c = s.charCodeAt(i);
			if (c === 0x5c) out += "\\\\";
			else if (c === 0x7c) out += "\\p";
			else if (c < 0x20) out += "\\x" + c.toString(16);
			else out += s[i];
		}

		return out;
	}

	/**
	 * `{tag}{payload}`, never contents.
	 *
	 * Strings are the exception and deliberately so: a string IS the value, and
	 * every leak and nearly every real divergence on a proxied site is one.
	 * Everything else gets a tag and an identity.
	 */
	function enc(v) {
		var t = typeof v;
		if (v === null) return "N";
		if (t === "undefined") return "U";
		if (t === "boolean") return v ? "B1" : "B0";
		if (t === "number") return "#" + (Object.is(v, -0) ? "-0" : stringify(v));
		if (t === "bigint") return "G" + stringify(v);
		if (t === "symbol") return "Y";
		if (t === "string") {
			var mark = leaks(v);
			if (v.length <= VALUE_MAX) {
				return (mark ? "!" + mark : "") + '"' + esc(v);
			}

			return (
				(mark ? "!" + mark : "") +
				"~" +
				utf8len(v) +
				"," +
				hash(v) +
				',"' +
				esc(v.slice(0, 48))
			);
		}
		// Functions and objects. Reading a constructor NAME would run guest code
		// on a Proxy, which is the one thing the tracer's own rules forbid, so
		// identity is all this carries.
		return (t === "function" ? "F" : "O") + idOf(v);
	}

	// ---- the recorder -------------------------------------------------------

	var depth = 0;
	/** Members scramjet installed, reported once so coverage is not inferred. */
	var installed = [];

	function record(member, op, args, result, threw) {
		var line;
		try {
			line =
				++n + "|" + op + "|" + member + "|" + (threw ? "!" : "") + enc(result);
			for (var i = 0; i < args.length && i < 6; i++) line += "|" + enc(args[i]);
			if (args.length > 6) line += "|+" + (args.length - 6);
		} catch (err) {
			dropped++;

			return;
		}
		emit(line);
	}

	/**
	 * Wraps one funnel's call. `fn` does the real work; everything it does
	 * re-entrantly is scramjet's own and must not be recorded, hence the depth.
	 */
	function around(member, op, args, fn) {
		var entered = depth === 0;
		depth++;
		var out;
		try {
			out = fn();
		} catch (err) {
			depth--;
			if (entered) record(member, op, args, err, true);
			throw err;
		}
		depth--;
		if (entered) record(member, op, args, out, false);

		return out;
	}

	window[Symbol.for("sbxdiff.guestop")] = {
		around: around,
		/** Registered at install time, so coverage is measured, not guessed. */
		note: function (member, kind) {
			installed.push(kind + " " + member);
		},
		/** Flushed on demand; the run's end is not a thing the page can see. */
		flush: flush,
		stats: function () {
			return { events: n, dropped: dropped, installed: installed.length };
		},
	};

	// The run can end at any time -- the harness kills the browser after its
	// grace period -- so the tail must not depend on a clean shutdown. Both
	// hooks, because `pagehide` does not fire for a killed process and a timer
	// does not fire for a page that is torn down first.
	try {
		window.addEventListener("pagehide", flush, { capture: true });
		window.addEventListener("beforeunload", flush, { capture: true });
	} catch (err) {
		/* no window */
	}
	// One line so a run says whether this was in the picture at all. A probe
	// that silently did not install reads as "no divergences", which is the
	// failure mode this whole file exists to remove.
	try {
		console.info("sbxdiff-guestop: installed");
	} catch (err) {
		/* no console */
	}
})();
