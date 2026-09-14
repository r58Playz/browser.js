/**
 * Why does the challenge not redeem?
 *
 * Cloudflare accepts the sandbox -- it issues `cf_clearance` -- and then the
 * interstitial never POSTs back, where a direct load posts a 2606-byte form to
 * `/` and gets the real page. This records every way out of a document, from
 * document start, in every guest realm.
 *
 * Document start matters and is the whole point of this file. Cloudflare caches
 * `document.createElement` and `HTMLFormElement.prototype.submit` at parse
 * time, so a hook installed by polling from the harness is always too late: it
 * watches a page that has already decided. Injected through
 * `Config.probePath`, which puts it in with scramjet's own bootstrap, ahead of
 * anything the page runs.
 *
 * Reports through `console.info`, which reaches Chromium's stderr and so the
 * run's log. `document.createComment` is the quieter channel the store-backed
 * probes use -- the tracer carries it and the page cannot read it -- but it is
 * only visible in a traced run, and a live one usually is not.
 */
(function () {
	"use strict";
	var n = 0;
	function say(msg) {
		try {
			if (n++ > 300) return;
			console.info("sbxredeem: " + String(msg).slice(0, 700));
		} catch (e) {
			/* a realm without a console is not one worth reporting from */
		}
	}

	var where = (function () {
		try {
			return location.href.slice(0, 120);
		} catch (e) {
			return "?";
		}
	})();
	say("start " + where);

	try {
		var proto = HTMLFormElement.prototype;
		var origSubmit = proto.submit;
		proto.submit = function () {
			say(
				"form.submit action=" +
					this.getAttribute("action") +
					" method=" +
					this.getAttribute("method") +
					" connected=" +
					this.isConnected +
					" inputs=" +
					this.querySelectorAll("input").length +
					" target=" +
					this.target
			);

			return origSubmit.apply(this, arguments);
		};
		if (proto.requestSubmit) {
			var origRequest = proto.requestSubmit;
			proto.requestSubmit = function () {
				say("form.requestSubmit action=" + this.getAttribute("action"));

				return origRequest.apply(this, arguments);
			};
		}
	} catch (e) {
		say("form hook failed " + e);
	}

	// Creation as well as submission: a form that is built and submitted in one
	// tick is never in the DOM for anything to find afterwards.
	try {
		var origCreate = document.createElement;
		document.createElement = function (tag) {
			var el = origCreate.apply(this, arguments);
			if (String(tag).toLowerCase() === "form") say("createElement(form)");

			return el;
		};
	} catch (e) {
		say("createElement hook failed " + e);
	}

	try {
		addEventListener(
			"submit",
			function (e) {
				say("submit event prevented=" + e.defaultPrevented);
			},
			true
		);
		addEventListener("beforeunload", function () {
			say("beforeunload from " + where);
		});
	} catch (e) {
		/* not a window */
	}

	// What the `/fo/` exchanges return. Cloudflare puts its verdict in
	// `cf-chl-out` / `cf-chl-out-s`, and the interstitial redeems from them --
	// so a run that never builds the form has either not been given them or not
	// believed them, and those are different bugs.
	try {
		var open = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function (m, u) {
			this.__sbxUrl = String(u);

			return open.apply(this, arguments);
		};
		var send = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function () {
			var xhr = this;
			xhr.addEventListener("load", function () {
				try {
					if (!/\/fo\//.test(xhr.__sbxUrl || "")) return;
					var out = xhr.getResponseHeader("cf-chl-out");
					var outs = xhr.getResponseHeader("cf-chl-out-s");
					say(
						"fo " +
							xhr.status +
							" cf-chl-out=" +
							(out ? "len" + out.length : "MISSING") +
							" cf-chl-out-s=" +
							(outs ? "len" + outs.length : "MISSING") +
							" " +
							String(xhr.__sbxUrl).slice(0, 90)
					);
				} catch (e) {
					say("fo read failed " + e);
				}
			});

			return send.apply(this, arguments);
		};
	} catch (e) {
		say("xhr hook failed " + e);
	}

	// Every assignment that navigates, including the ones a poll cannot see.
	try {
		var loc = location;
		["assign", "replace", "reload"].forEach(function (name) {
			var orig = loc[name];
			if (typeof orig !== "function") return;
			loc[name] = function (arg) {
				// With a stack, because which SCRIPT decides to reload is the
				// whole question: the orchestrator, Turnstile's api.js and the
				// page's own inline script all share this realm.
				var stack = "";
				try {
					stack = String(new Error().stack || "")
						.split("\n")
						.slice(1, 5)
						.join(" | ");
				} catch (e2) {
					/* no stack is still a reload worth reporting */
				}
				say(
					"location." +
						name +
						"(" +
						String(arg).slice(0, 60) +
						") from " +
						stack
				);

				return orig.apply(loc, arguments);
			};
		});
	} catch (e) {
		say("location hook failed " + e);
	}
})();
