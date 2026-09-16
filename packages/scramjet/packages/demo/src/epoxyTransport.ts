import type {
	RawHeaders,
	TransferrableResponse,
	ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import {
	WispSocketProvider,
	WebSocketJsProvider,
	EpoxyClient,
	init,
	type EpoxyWS,
	type EpoxyWSCloseInfo,
} from "@mercuryworkshop/epoxy-tls/full/bundled";

// Talks to the `../epoxy-tls` checkout directly (see demo/package.json), not
// the published `@mercuryworkshop/epoxy-transport`, which still bundles the
// pre-rewrite epoxy-tls@2.x client API.

function toArrayBuffer(chunk: Uint8Array): ArrayBuffer {
	if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength)
		return chunk.buffer as ArrayBuffer;
	return chunk.buffer.slice(
		chunk.byteOffset,
		chunk.byteOffset + chunk.byteLength
	) as ArrayBuffer;
}

export default class EpoxyTransport implements ProxyTransport {
	ready = false;

	client: EpoxyClient = null!;
	wisp: string;

	constructor(opts: { wisp: string }) {
		this.wisp = opts.wisp;
	}

	async init() {
		await init();
		const provider = new WispSocketProvider(
			new WebSocketJsProvider(),
			this.wisp
		);
		this.client = new EpoxyClient(provider);
		this.ready = true;
	}

	async meta() {}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		if (body instanceof Blob) body = await body.arrayBuffer();

		try {
			let res = await this.client.fetch(remote.href, {
				method,
				body,
				headers,
				redirect: "manual",
				signal,
			});

			let headersEntries: RawHeaders = [];
			for (let [key, values] of Object.entries(res.rawHeaders)) {
				for (let value of values) {
					headersEntries.push([key, value]);
				}
			}

			return {
				body: res.body!,
				headers: headersEntries,
				status: res.status,
				statusText: res.statusText,
			};
		} catch (err) {
			console.error(err);
			throw err;
		}
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: Blob | ArrayBuffer | string) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [
		(data: Blob | ArrayBuffer | string) => void,
		(code: number, reason: string) => void,
	] {
		const ws = this.client.websocket(url.href, {
			protocols,
			headers: requestHeaders,
		});
		const writer = ws.then((socket) => socket.writable.getWriter());
		writer.catch(() => {});

		let settled = false;
		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			onerror(String(err));
		};
		const finish = (info: EpoxyWSCloseInfo) => {
			if (settled) return;
			settled = true;
			onclose(info.closeCode ?? 1000, info.reason ?? "");
		};

		(async () => {
			let socket: EpoxyWS;
			try {
				socket = await ws;
			} catch (err) {
				fail(err);
				return;
			}

			socket.closed.then(finish, fail);
			onopen(
				socket.protocol,
				socket.headers.get("sec-websocket-extensions") || ""
			);

			const reader = socket.readable.getReader();
			try {
				while (true) {
					// eslint-disable-next-line no-await-in-loop
					const { done, value } = await reader.read();
					if (done || value === undefined) break;
					onmessage(typeof value === "string" ? value : toArrayBuffer(value));
				}
			} catch (err) {
				fail(err);
			} finally {
				reader.releaseLock();
			}
		})();

		return [
			async (data) => {
				try {
					if (data instanceof Blob) data = await data.arrayBuffer();
					await (
						await writer
					).write(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
				} catch (err) {
					fail(err);
				}
			},
			async (code, reason) => {
				try {
					(await ws).close({ closeCode: code, reason: reason || "" });
				} catch (err) {
					fail(err);
				}
			},
		];
	}
}
