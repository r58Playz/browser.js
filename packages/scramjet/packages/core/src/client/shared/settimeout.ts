import { rewriteJs } from "@rewriters/js";
import { GlobalScope, ScramjetClient } from "@client/index";
import { String, TextDecoder_decode, _Map } from "@/shared/snapshot";
import { Arguments, Returns } from "@client/webidl";

export default function (client: ScramjetClient, self: Self) {
	const nativeGlobal = new client.native.window(self);

	/**
	 * Timer ids the PAGE would have had, counted from one.
	 *
	 * Chromium hands out timer ids from a per-document counter, so the first
	 * timer a document sets is 1. The shim sets timers of its own on the same
	 * document -- for its bootstrap, and for every rewritten handler it
	 * schedules -- so the guest's first timer was not the document's first, and
	 * every id it saw was shifted. Measured in Cloudflare's Turnstile realm,
	 * which passes them back: `clearTimeout(10)` on a direct load against
	 * `clearTimeout(15)` through the proxy, twenty times over.
	 *
	 * Renumbered rather than hidden, because an id is a handle the page holds:
	 * it goes back into `clearTimeout` and has to still name the same timer.
	 * An id this map has never seen is passed through untouched -- it belongs
	 * to a timer set before the shim was installed, or to another realm.
	 */
	let nextId = 1;
	const toNative = new _Map<number, number>();
	const toGuest = new _Map<number, number>();
	const publish = (native: number): number => {
		const existing = toGuest.get(native);
		if (existing !== undefined) return existing;
		const id = nextId++;
		toNative.set(id, native);
		toGuest.set(native, id);

		return id;
	};
	const resolve = (id: unknown): unknown => {
		if (typeof id !== "number") return id;
		const native = toNative.get(id);

		return native === undefined ? id : native;
	};

	const rewriteHandler = (handler: TimerHandler): TimerHandler => {
		if (typeof handler === "function") return handler;

		const rewritten = rewriteJs(
			String(handler),
			"(setTimeout string eval)",
			client.context,
			client.meta
		);

		return typeof rewritten === "string"
			? rewritten
			: TextDecoder_decode(rewritten);
	};

	// https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers
	client.Intercept(class extends GlobalScope {
		@Arguments("TimerHandler", "optional long timeout = 0", "any... arguments")
		@Returns("long")
		static setTimeout(
			handler: TimerHandler,
			timeout?: number,
			...args: any[]
		): number {
			return publish(
				nativeGlobal.setTimeout(rewriteHandler(handler), timeout, ...args)
			);
		}

		@Arguments("optional long handle = 0")
		@Returns("undefined")
		static clearTimeout(handle?: number): void {
			nativeGlobal.clearTimeout(resolve(handle) as number);
		}

		@Arguments("optional long handle = 0")
		@Returns("undefined")
		static clearInterval(handle?: number): void {
			nativeGlobal.clearInterval(resolve(handle) as number);
		}

		@Arguments("TimerHandler", "optional long timeout = 0", "any... arguments")
		@Returns("long")
		static setInterval(
			handler: TimerHandler,
			timeout?: number,
			...args: any[]
		): number {
			return publish(
				nativeGlobal.setInterval(rewriteHandler(handler), timeout, ...args)
			);
		}
	});
}
