/**
 * What the Turnstile widget is SHOWING, sampled over the life of the page.
 *
 * The widget's verdict about itself is the state it renders, and reading it
 * needs all three of these: it draws into a SHADOW ROOT (so a document-level
 * `querySelectorAll` finds nothing and `body.textContent` is ""), the root may
 * be closed (so it is captured at `attachShadow` rather than looked up
 * afterwards), and every state's label -- "Verify you are human", "Verifying...",
 * "Success!", the failure text -- lives in the DOM at once and is toggled, so
 * only elements the layout actually produced say which one is up.
 *
 * It also cannot be read from anywhere else: the widget is cross-origin to the
 * interstitial in a direct load, and the differ scopes to the page's realm.
 */
(function () {
	"use strict";
	// What the Turnstile widget is SHOWING.
	//
	// The one observable that was asked for and never read. The widget's UI is
	// a stack of divs -- success, fail, expired, timeout -- toggled by display,
	// so "which one is visible" is the widget's verdict about itself, and it is
	// only legible from inside the widget's own realm: cross-origin in the
	// oracle, so the interstitial cannot look in and neither can the differ.
	// Turnstile renders into a shadow root, so `querySelectorAll("*")` on the
	// document finds nothing and `body.textContent` is "" -- which is exactly
	// what both sides reported, and is the probe failing to look rather than
	// the widget failing to draw. Roots are captured at `attachShadow`, which
	// also works when the root is closed and there is no `el.shadowRoot` to
	// find afterwards.
	var roots = [];
	try {
		var origAttach = Element.prototype.attachShadow;
		Element.prototype.attachShadow = function () {
			var r = origAttach.apply(this, arguments);
			try {
				roots.push(r);
			} catch (e) {}

			return r;
		};
	} catch (e) {}

	var n = 0;
	function say(s) {
		if (n >= 300) return;
		var line = "cfs." + n++ + "=" + s;
		// Both sinks: `createComment` is what a TRACED run records, and a live
		// run is not traced, so the console is the only way out of it.
		try {
			document.createComment(line);
		} catch (e) {}
		try {
			console.info("sbxdiff-widget: " + line);
		} catch (e) {}
	}
	// The UI is not in this document. It renders in a blob: iframe this
	// document creates, which inherits this origin -- so it can be walked into
	// from here, and only from here: the interstitial is cross-origin to it in
	// the oracle and the differ never diffs it either.
	function docs() {
		var list = [document];
		for (var d = 0; d < list.length && list.length < 12; d++) {
			var frames;
			try {
				frames = list[d].querySelectorAll("iframe,frame");
			} catch (e) {
				continue;
			}
			for (var i = 0; i < frames.length; i++) {
				try {
					var cd = frames[i].contentDocument;
					if (cd && list.indexOf(cd) === -1) list.push(cd);
				} catch (e) {
					/* cross-origin, not ours to read */
				}
			}
		}

		for (var k = 0; k < roots.length; k++)
			if (list.indexOf(roots[k]) === -1) list.push(roots[k]);

		return list;
	}
	// Only what is actually LAID OUT, and only leaves.
	//
	// `textContent` of the wrapper concatenates every state's label -- the
	// widget keeps "Verify you are human", "Verifying...", "Success!" and the
	// failure text all in the DOM and toggles them -- so reading the wrapper
	// says nothing about which one is showing. An element with client rects is
	// one the layout actually produced, which is the question.
	function visible() {
		var out = [];
		try {
			var ds = docs();
			for (var q = 0; q < ds.length; q++) {
				var got = ds[q].querySelectorAll("*");
				for (var i = 0; i < got.length && out.length < 14; i++) {
					var el = got[i];
					if (el.querySelector && el.querySelector("*")) continue;
					var t = (el.textContent || "").trim();
					if (!t) continue;
					if (!el.getClientRects || el.getClientRects().length === 0) continue;
					out.push(JSON.stringify(t.slice(0, 46)));
				}
			}
		} catch (e) {
			out.push("err:" + e);
		}

		return out.join(" ");
	}
	function sample(tag) {
		var text = "";
		try {
			var ds = docs();
			for (var i = 0; i < ds.length; i++)
				text += ((ds[i].body || ds[i]).textContent || "").trim() + "|";
		} catch (e) {
			text = "err:" + e;
		}
		var shown = visible();
		say(tag + " shown=" + shown);
		dumpOnFailure(shown);
	}
	// Turnstile reports failures through a callback and through its own
	// logging; both are worth having next to the UI state.
	try {
		var oe = window.onerror;
		window.addEventListener("error", function (e) {
			say("window.error " + String(e.message).slice(0, 120));
		});
		window.addEventListener("unhandledrejection", function (e) {
			say("rejection " + String(e.reason).slice(0, 120));
		});
	} catch (e) {}
	// Turnstile says WHY it failed over postMessage, not in the DOM: the widget
	// reports its outcome to the interstitial that embedded it, and the error
	// code rides in that message. "Verification failed" is the UI; the code is
	// what names the check.
	function brief(v) {
		try {
			var t = typeof v === "string" ? v : JSON.stringify(v);
			// The interstitial forwards the client-side errors it collected in a
			// `cs` field, and an error is only useful whole -- the stack is the
			// part that names what broke. Everything else stays short; these
			// messages are the reason the hook exists.
			var limit =
				t.indexOf('"cs"') !== -1 || t.indexOf('"fail"') !== -1 ? 2200 : 200;

			return t.slice(0, limit);
		} catch (e) {
			return "(unserialisable " + typeof v + ")";
		}
	}
	var posts = 0;
	try {
		var origPost = window.postMessage;
		["postMessage"].forEach(function () {});
		var wrapPost = function (target, name) {
			var orig = target.postMessage;
			if (typeof orig !== "function") return;
			target.postMessage = function (msg) {
				if (posts++ < 60) say("post[" + name + "] " + brief(msg));

				return orig.apply(this, arguments);
			};
		};
		wrapPost(window.parent, "parent");
		if (window.top !== window.parent) wrapPost(window.top, "top");
		window.addEventListener("message", function (e) {
			if (posts++ < 60) say("recv " + brief(e.data));
		});
	} catch (e) {
		say("post-hook-failed " + e);
	}

	// Everything the failure state carries, once, when it appears.
	var dumped = false;
	function dumpOnFailure(shown) {
		if (dumped) return;
		if (shown.indexOf("failed") === -1 && shown.indexOf("expired") === -1)
			return;
		dumped = true;
		try {
			var ds = docs();
			for (var q = 0; q < ds.length; q++) {
				var all = ds[q].querySelectorAll("*");
				for (var i = 0; i < all.length && i < 60; i++) {
					var el = all[i];
					var at = [];
					for (var a = 0; a < el.attributes.length; a++)
						at.push(
							el.attributes[a].name + "=" + el.attributes[a].value.slice(0, 60)
						);
					if (!at.length) continue;
					say(
						"fail-dom " +
							el.tagName.toLowerCase() +
							" " +
							at.join(" ").slice(0, 200)
					);
				}
			}
		} catch (e) {
			say("fail-dump-err " + e);
		}
	}

	var ticks = 0;
	var iv = setInterval(function () {
		ticks++;
		sample("t" + ticks);
		if (ticks > 24) clearInterval(iv);
	}, 900);
	try {
		document.addEventListener("DOMContentLoaded", function () {
			sample("domready");
		});
		window.addEventListener("pagehide", function () {
			sample("pagehide");
		});
	} catch (e) {}
})();
