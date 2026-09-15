import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { Object_defineProperty } from "@/shared/snapshot";
import { POLLUTANT } from "./realm";

export default function (client: ScramjetClient, self: Self) {
	if (iswindow)
		client.Proxy("window.postMessage", {
			apply(ctx) {
				// A call with NO arguments goes straight to the native, which is
				// the only thing that throws the right error for it:
				//
				//   Failed to execute 'postMessage' on 'Window':
				//   1 argument required, but only 0 present.
				//
				// Everything below reads and writes `ctx.args`, and writing
				// `args[0]` on an empty list CREATES an argument -- so the
				// native saw one, did not throw, and `window.postMessage()`
				// quietly returned where a browser raises a TypeError.
				// Measured against the oracle on a page that calls each window
				// function with no arguments and records what comes back.
				if (ctx.args.length === 0) return;
				// so we need to send the real origin here, since the recieving window can't possibly know.
				// except, remember that this code is being ran in a different realm than the invoker, so if we ask our `client` it may give us the wrong origin
				// if we were given any object that came from the real realm we can use that to get the real origin
				// and this works in every case EXCEPT for the fact that all three arguments can be strings which are copied instead of cloned
				// so we have to use `$setrealm` which will pollute this with an object from the real realm

				let pollutant;

				if (typeof ctx.args[0] === "object" && ctx.args[0] !== null) {
					pollutant = ctx.args[0]; // try to use the first object we can find because it's more reliable
				} else if (typeof ctx.args[2] === "object" && ctx.args[2] !== null) {
					pollutant = ctx.args[2]; // next try to use transfer
				} else if (
					ctx.this &&
					POLLUTANT in ctx.this &&
					typeof ctx.this[POLLUTANT] === "object" &&
					ctx.this[POLLUTANT] !== null
				) {
					pollutant = ctx.this[POLLUTANT]; // lastly try to use the object from $setrealm
				} else {
					pollutant = {}; // give up
				}

				// and now we can steal Function from the caller's realm
				const {
					constructor: { constructor: Function },
				} = pollutant;

				// invoking stolen function will give us the caller's globalThis, remember scramjet has already proxied it!!!
				const callerGlobalThisProxied: Self = Function("return globalThis")();
				const callerClient = callerGlobalThisProxied[SCRAMJETCLIENT];

				// this WOULD be enough but the source argument of MessageEvent has to return the caller's window
				// and if we just call it normally it would be coming from here, which WILL NOT BE THE CALLER'S because the accessor is from the parent
				// so with the stolen function we wrap postmessage so the source will truly be the caller's window (remember that function is scramjet's!!!)
				//
				// It has to be called ON the receiver. The previous form was
				// `Function("...args", "this(...args)")` invoked with the native
				// as `this`, which calls it with NO receiver -- and WebIDL then
				// substitutes the realm's own global, so every
				// `otherWindow.postMessage(...)` silently delivered to the
				// caller's own window instead. A frame talking to its parent
				// therefore talked only to itself: measured on Cloudflare's
				// Turnstile, whose widget posted 268 times and was never heard,
				// and reproduced by `msg.*` in `sbxdiff/pages/probe.html`.
				const wrappedPostMessage = Function(
					"fn",
					"target",
					"...args",
					"return fn.apply(target, args);"
				);

				// console.log(
				// 	callerClient,
				// 	client,
				// 	callerGlobalThisProxied.document,
				// 	self.document,
				// 	callerClient === client
				// );
				const inherit =
					callerClient.url.href === "about:srcdoc" ||
					callerClient.url.href === "about:blank";
				ctx.args[0] = {
					$scramjet$messagetype: "window",
					$scramjet$origin: inherit
						? callerClient.global.parent[SCRAMJETCLIENT].url.origin
						: callerClient.url.origin,
					$scramjet$data: ctx.args[0],
				};
				// console.error("?", ctx.args);
				// eval("debugger");

				// * origin because obviously
				if (typeof ctx.args[1] === "string") ctx.args[1] = "*";
				if (typeof ctx.args[1] === "object") ctx.args[1].targetOrigin = "*";

				ctx.return(wrappedPostMessage(ctx.fn, ctx.this, ...ctx.args));
			},
		});

	client.Proxy("BroadcastChannel.prototype.postMessage", {
		apply(ctx) {
			ctx.args[0] = {
				$scramjet$messagetype: "window",
				// TODO: need to actually look up the broadcastchannel itself in box i think
				$scramjet$origin: client.url.origin,
				$scramjet$data: ctx.args[0],
			};
		},
	});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage"); // only do the generic version if we're in a worker

	client.Proxy(toproxy, {
		apply(ctx) {
			// origin/source doesn't need to be preserved - it's null in the message event

			ctx.args[0] = {
				$scramjet$messagetype: "worker",
				$scramjet$data: ctx.args[0],
			};
		},
	});
}
