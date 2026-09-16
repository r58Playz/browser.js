import { ScramjetClient, ProxyCtx, Proxy } from "@client/index";
import { rewriteCached } from "@client/rewritecache";
import { assertEvalAllowed } from "@client/csp";
import { String } from "@/shared/snapshot";

function rewriteFunction<T extends string, U extends "construct" | "apply">(
	ctx: ProxyCtx<T, U>,
	client: ScramjetClient
) {
	// CreateDynamicFunction converts arguments before the host CSP check, but
	// parses them afterwards. Letting the native constructor parse first would
	// incorrectly return SyntaxError instead of the policy's EvalError.
	// https://tc39.es/ecma262/#sec-createdynamicfunction
	for (let i = 0; i < ctx.args.length; i++) {
		if (typeof ctx.args[i] === "symbol") {
			const global = new client.native.window(client.global);
			throw new global.TypeError("Cannot convert a Symbol value to a string");
		}
		ctx.args[i] = String(ctx.args[i]);
	}
	assertEvalAllowed(client);
	const stringifiedFunction = ctx.call().toString();

	// TODO: also check if the function comes from a weird realm. if so we need to completely block it or do something else weird
	// not much point rewriting the javascript if it's executing in the top level

	// Memoized on the source. Cloudflare's Turnstile widget builds its 1.3 MB
	// challenge script with `new Function(src)` once per 550 ms poll round, and
	// does that ~208 times in a run -- so this was ~870 traced calls a round of
	// re-rewriting byte-identical input (FINDINGS.md #242). `eval` was the
	// obvious suspect and was the wrong one (#241): `Function.constructor` and
	// `Function.prototype.toString` are ECMAScript members with no binding
	// behind them, so this path is invisible to the tracer and shows up only in
	// the guest-op stream.
	const content = rewriteCached(
		client,
		`return ${stringifiedFunction}`,
		"(function proxy)"
	);
	ctx.return(ctx.fn(content)());
}

export default function (client: ScramjetClient, _self: Self) {
	const handler: Proxy = {
		apply(ctx: ProxyCtx) {
			rewriteFunction(ctx, client);
		},
		construct(ctx) {
			rewriteFunction(ctx, client);
		},
	};

	client.Proxy("Function", handler);

	const nWindow = new client.native.window(client.global);
	const RawFunction = nWindow.eval("(function () {})").constructor;
	const RawAsyncFunction = nWindow.eval("(async function () {})").constructor;
	const RawGeneratorFunction = nWindow.eval("(function* () {})").constructor;
	const RawAsyncGeneratorFunction = nWindow.eval(
		"(async function* () {})"
	).constructor;

	client.RawProxy(RawFunction.prototype, "constructor", handler);
	client.RawProxy(RawAsyncFunction.prototype, "constructor", handler);
	client.RawProxy(RawGeneratorFunction.prototype, "constructor", handler);
	client.RawProxy(RawAsyncGeneratorFunction.prototype, "constructor", handler);
}
