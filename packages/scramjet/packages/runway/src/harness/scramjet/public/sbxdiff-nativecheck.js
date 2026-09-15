/**
 * Which of the shim's functions does NOT look native, and by which test?
 *
 * Cloudflare's `/jsd/` payload sorts every function it probes into two arrays:
 * `N` for native and `f` for tampered. The oracle puts 0 in `f`; the sandbox
 * puts 22, and they are exactly the APIs scramjet shims. This asks each of the
 * obvious tests, so the fix aims at the one that actually fires.
 */
(function () {
	"use strict";
	var s = typeof globalThis !== "undefined" ? globalThis : this;
	if (!s || !s.document) return;

	var NAMES = [
		"clearInterval",
		"clearTimeout",
		"fetch",
		"getComputedStyle",
		"open",
		"postMessage",
		"setInterval",
		"setTimeout",
		"addEventListener",
		"removeEventListener",
	];
	var DOC = [
		"close",
		"hasFocus",
		"open",
		"querySelector",
		"write",
		"addEventListener",
	];
	var NAV = ["sendBeacon", "registerProtocolHandler"];

	var report = function (label, owner, name) {
		try {
			var f = owner[name];
			if (typeof f !== "function") return;
			var ts;
			try {
				ts = Function.prototype.toString.call(f);
			} catch (err) {
				ts = "THREW: " + err;
			}
			var native = /\{\s*\[native code\]\s*\}/.test(ts);
			// A fresh realm's toString, which the page's own hook cannot have
			// touched -- the classic way to see past a patched one.
			var crossTs = "n/a";
			try {
				var f2 = s.__sbxdiffProbeFrame;
				if (f2 && f2.contentWindow) {
					crossTs = f2.contentWindow.Function.prototype.toString.call(f);
				}
			} catch (err) {
				crossTs = "THREW: " + String(err).slice(0, 40);
			}
			// WHERE the function lives. A shim installed as an own property of
			// the window shadows the prototype that natively declares it, and
			// "this name is an own property here" is a far cheaper test than
			// any toString trick -- and one the masking does not touch.
			var where = "?";
			try {
				var o = owner;
				var depth = 0;
				while (o) {
					if (Object.getOwnPropertyDescriptor(o, name)) {
						var d = Object.getOwnPropertyDescriptor(o, name);
						where =
							(depth === 0 ? "OWN" : "proto+" + depth) +
							"/" +
							(o.constructor && o.constructor.name) +
							(d.get ? "/accessor" : "/value");
						break;
					}
					o = Object.getPrototypeOf(o);
					depth++;
				}
			} catch (err) {
				where = "THREW";
			}
			console.info(
				"sbxdiff-native: " +
					label +
					"." +
					name +
					" | at=" +
					where +
					" | native=" +
					native +
					" | name=" +
					JSON.stringify(f.name) +
					" | len=" +
					f.length +
					" | ts=" +
					JSON.stringify(String(ts).slice(0, 52)) +
					" | crossTs=" +
					JSON.stringify(String(crossTs).slice(0, 52))
			);
		} catch (err) {
			console.info("sbxdiff-native: " + label + "." + name + " FAILED " + err);
		}
	};

	var run = function () {
		try {
			var fr = s.document.createElement("iframe");
			fr.style.display = "none";
			s.document.documentElement.appendChild(fr);
			s.__sbxdiffProbeFrame = fr;
		} catch (err) {
			/* no iframe, cross-realm test degrades to n/a */
		}
		for (var i = 0; i < NAMES.length; i++) report("win", s, NAMES[i]);
		for (var j = 0; j < DOC.length; j++) report("doc", s.document, DOC[j]);
		for (var k = 0; k < NAV.length; k++) report("nav", s.navigator, NAV[k]);
	};

	if (s.document.readyState === "loading") {
		s.document.addEventListener("DOMContentLoaded", run);
	} else {
		run();
	}
})();
