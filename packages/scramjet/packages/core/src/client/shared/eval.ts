import { ScramjetClient } from "@client/index";
import { Object_defineProperty, String } from "@/shared/snapshot";
import { rewriteCached } from "./rewritecache";

export default function (client: ScramjetClient, self: Self) {
	// used for proxying *direct eval*
	// eval("...") -> eval($scramjet$rewrite("..."))
	Object_defineProperty(self, client.config.globals.rewritefn, {
		value: function (js: any) {
			// if eval is called on anything other than a string, we should just return it unchanged
			// the one exception is TrustedScript, which can just be stringified and rewritten
			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			// Memoized: a page that evals the same large source repeatedly pays
			// one rewrite rather than one per eval. See `rewritecache.ts`.
			return rewriteCached(client, js, "(direct eval proxy)");
		},
		writable: false,
		configurable: false,
	});
}

export function createIndirectEval(client: ScramjetClient) {
	const indirection = client.global.eval;
	const proxy = new Proxy(client.global.eval, {
		apply(_target, _thisArg, args) {
			let js = args[0];
			// > If the argument of eval() is not a string, eval() returns the argument unchanged
			// the one exception is TrustedScript, which can just be stringified and rewritten
			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			return indirection(rewriteCached(client, js, "(indirect eval proxy)"));
		},
	});
	client.box.unproxy.set(proxy, client.global.eval);

	return proxy;
}
