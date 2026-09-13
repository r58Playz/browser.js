// import { flagEnabled } from "@/shared";
import type { URLMeta } from "@rewriters/url";
import { Error, Math_min, Performance_now } from "@/shared/snapshot";

const logfuncs = {
	// eslint-disable-next-line scramjet-core/no-globals
	log: console.log,
	// eslint-disable-next-line scramjet-core/no-globals
	warn: console.warn,
	// eslint-disable-next-line scramjet-core/no-globals
	error: console.error,
	// eslint-disable-next-line scramjet-core/no-globals
	debug: console.debug,
	// eslint-disable-next-line scramjet-core/no-globals
	info: console.info,
};

/**
 * A short, log-safe rendering of a `dbg` call's trailing arguments.
 *
 * Strings and numbers in full up to a cap, because those are the values worth
 * reading back; anything else by its kind, because a serialised DOM node in a
 * log line is noise that pushes the message off the end.
 */
function preview(args: any[]): string {
	if (!args.length) return "";
	const parts: string[] = [];
	for (const arg of args) {
		if (arg === null) parts.push("null");
		else if (arg === undefined) parts.push("undefined");
		else if (typeof arg === "string")
			parts.push(arg.length > 160 ? `${arg.slice(0, 160)}…` : arg);
		else if (typeof arg === "number" || typeof arg === "boolean")
			parts.push(String(arg));
		else if (arg instanceof Error) parts.push(`${arg.name}: ${arg.message}`);
		else parts.push(`[${typeof arg}]`);
	}

	return ` ${parts.join(" ")}`;
}

export default {
	fmt: function (severity: string, message: string, ...args: any[]) {
		const old = Error.prepareStackTrace;

		Error.prepareStackTrace = (_, stack) => {
			stack.shift(); // stack();
			stack.shift(); // fmt();
			stack.shift();

			let fmt = "";
			for (let i = 1; i < Math_min(2, stack.length); i++) {
				if (stack[i].getFunctionName()) {
					// const f = stack[i].getThis()?.constructor?.name;
					// if (f) fmt += `${f}.`
					fmt += `${stack[i].getFunctionName()} -> ` + fmt;
				}
			}
			fmt += stack[0].getFunctionName() || "Anonymous";

			return fmt;
		};

		const fmt = (function stack() {
			try {
				throw new Error();
			} catch (e) {
				return e.stack;
			}
		})();

		Error.prepareStackTrace = old;

		this.print(severity, fmt, message, ...args);
	},
	print(severity: string, tag: string, message: string, ...args: any[]) {
		const fn = logfuncs[severity] || logfuncs.log;
		const bg = {
			log: "#000",
			warn: "#f80",
			error: "#f00",
			debug: "transparent",
		}[severity];
		const fg = {
			log: "#fff",
			warn: "#fff",
			error: "#fff",
			debug: "gray",
		}[severity];
		const padding = {
			log: 2,
			warn: 4,
			error: 4,
			debug: 0,
		}[severity];

		// The arguments go in the MESSAGE as well as after it.
		//
		// `console.error("%c..%c text", style, style, value)` shows `value` in
		// devtools and nowhere else: Chromium's `--enable-logging` CONSOLE line
		// carries the format string alone. So a headless run's log reads
		// "unrewriteurl: unexpected url" with no url -- the one thing the
		// message exists to say. Measured chasing exactly that, 129 times in
		// one run.
		//
		// Still passed as arguments too, so devtools keeps an object clickable;
		// the preview is only a short, log-safe rendering beside it.
		fn(
			`%c${tag}%c ${message}${preview(args)}`,
			`
  	background-color: ${bg};
  	color: ${fg};
  	padding: ${padding}px;
  	font-weight: bold;
  	font-family: monospace;
  	font-size: 0.9em;
  `,
			`${severity === "debug" ? "color: gray" : ""}`,
			...args
		);
	},
	log: function (message: string, ...args: any[]) {
		this.fmt("log", message, ...args);
	},
	warn: function (message: string, ...args: any[]) {
		this.fmt("warn", message, ...args);
	},
	error: function (message: string, ...args: any[]) {
		this.fmt("error", message, ...args);
	},
	debug: function (message: string, ...args: any[]) {
		this.fmt("debug", message, ...args);
	},
	time(meta: URLMeta, before: number, type: string) {
		const after = Performance_now();
		const duration = after - before;

		let timespan: string;
		if (duration < 1) {
			timespan = "BLAZINGLY FAST";
		} else if (duration < 500) {
			timespan = "decent speed";
		} else {
			timespan = "really slow";
		}
		this.print(
			"debug",
			"[time]",
			`${type} was ${timespan} (${duration.toFixed(2)}ms)`
		);
	},
};
