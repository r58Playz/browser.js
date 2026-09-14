import {
	Array_join,
	Array_sort,
	String_indexOf,
	String_split,
	String_startsWith,
	String_substring,
	String_toLowerCase,
} from "@/shared/snapshot";
import { carriedHeaderName, uncarriedHeaderName } from "@/shared/headers";
import { ScramjetClient } from "@client/client";
import { Arguments, Constructor, Returns, Type } from "@client/webidl";
import { controlledAncestor, isUncontrolledDocument } from "@client/helpers";

export const enabled = (client: ScramjetClient, self: Self) =>
	"XMLHttpRequest" in self;

export default function (client: ScramjetClient) {
	client.Intercept(class extends XMLHttpRequest {
		/**
		 * In a document no service worker controls, the request object comes
		 * from an ancestor that one does.
		 *
		 * An XHR is attributed to the document whose realm created it, so one
		 * made here would leave for the proxy's own origin and come back as
		 * whatever that server says -- measured on rateyourmusic, Cloudflare's
		 * JS detections POST their result from a blank iframe and that POST was
		 * the only request of the run to reach the proxy's HTTP server instead
		 * of the worker.
		 *
		 * The ancestor's object carries the ancestor's interception, which
		 * rewrites against the same scramjet context this document would have
		 * used, so the URL is unchanged by the move. Only when there IS an
		 * uncontrolled document and an ancestor to ask: everywhere else this is
		 * the ordinary constructor, because handing a page an object from
		 * another realm is a difference in itself and is only worth it where
		 * the alternative is the request not being proxied at all.
		 */
		@Constructor()
		static konstructor() {
			if (isUncontrolledDocument(client)) {
				const ancestor = controlledAncestor(client) as
					| (Window & { XMLHttpRequest: typeof XMLHttpRequest })
					| null;
				if (ancestor) return new ancestor.XMLHttpRequest();
			}

			return new this();
		}

		@Arguments(
			"ByteString",
			"USVString",
			"optional boolean",
			"optional USVString?",
			"optional USVString?"
		)
		@Returns("undefined")
		open(
			method: string,
			url: string,
			isAsync?: boolean,
			username?: string | null,
			password?: string | null
		): void {
			const rewritten = client.rewriteUrl(url);

			if (arguments.length < 3) return super.open(method, rewritten);

			if (isAsync === false) {
				// TODO: bring back sync xhr
				throw client.errors.domException("InvalidAccessError", {
					execute: "open",
					on: "XMLHttpRequest",
					detail: "Synchronous requests are not supported.",
				});
			}

			return super.open(method, rewritten, isAsync, username, password);
		}

		@Type("USVString")
		get responseURL() {
			const url = super.responseURL;

			return String_startsWith(url, client.context.prefix.href)
				? client.unrewriteUrl(url)
				: url;
		}

		@Returns("ByteString?")
		@Arguments("ByteString")
		getResponseHeader(name: string): string | null {
			return super.getResponseHeader(carriedHeaderName(name));
		}

		@Returns("ByteString")
		@Arguments()
		getAllResponseHeaders(): string {
			const raw = super.getAllResponseHeaders();
			if (!raw) return raw;

			const restored: [string, string][] = [];
			const lines = String_split(raw, "\r\n");

			for (let i = 0; i < lines.length; i++) {
				const colon = String_indexOf(lines[i], ":");
				if (colon === -1) continue;

				const name = uncarriedHeaderName(String_substring(lines[i], 0, colon));
				if (name === null) continue;

				// the value keeps the separator and its leading space verbatim
				restored[restored.length] = [
					String_toLowerCase(name),
					String_substring(lines[i], colon),
				];
			}

			// a carrier sorts under `x-`, and the name it stands for almost never
			// does, so the list has to be re-sorted rather than filtered in place.
			//
			// By NAME, not by the whole line. Sorting the joined text compares the
			// separator too, and `:` (0x3a) is above `-` (0x2d), so a name that is
			// a prefix of another came out after it: Cloudflare's challenge sends
			// both `cf-chl-out` and `cf-chl-out-s`, and this returned them in that
			// reversed order where a browser returns them sorted by name. Measured
			// on rateyourmusic, oracle `cf-chl-out|cf-chl-out-s` against sandbox
			// `cf-chl-out-s|cf-chl-out`, same values and same length.
			Array_sort(restored, (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

			return restored.length
				? Array_join(
						restored.map((h) => h[0] + h[1]),
						"\r\n"
					) + "\r\n"
				: "";
		}
	});
}
