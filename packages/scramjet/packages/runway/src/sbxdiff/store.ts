/**
 * Reader for an sbxdiff network store, and the HTTP endpoint the in-page
 * `SbxdiffTransport` fetches from.
 *
 * The store is written by `base/sbxdiff_net_store.cc` as one file per response:
 *
 *     url \n mime \n encoding \n body
 *
 * with the filename derived from two `base::PersistentHash` values of the URL.
 * This reader deliberately does NOT reimplement that hash -- getting a
 * Chromium hash subtly wrong in JS would produce silent misses that look like
 * the sandbox diverging. It indexes the directory by reading each file's URL
 * line instead, which is exact by construction.
 */

import express from "express";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type StoredResponse = {
	url: string;
	mime: string;
	encoding: string;
	body: Buffer;
};

function parse(buf: Buffer): StoredResponse | null {
	// Three newline-delimited headers, then the body verbatim. Split manually
	// rather than with String.split so a body containing newlines survives.
	const ends: number[] = [];
	for (let i = 0; i < buf.length && ends.length < 3; i++) {
		if (buf[i] === 0x0a) ends.push(i);
	}
	if (ends.length < 3) return null;
	return {
		url: buf.subarray(0, ends[0]).toString("utf8"),
		mime: buf.subarray(ends[0] + 1, ends[1]).toString("utf8"),
		encoding: buf.subarray(ends[1] + 1, ends[2]).toString("utf8"),
		body: buf.subarray(ends[2] + 1),
	};
}

export async function loadStore(
	dir: string
): Promise<Map<string, StoredResponse[]>> {
	const out = new Map<string, StoredResponse[]>();
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return out;
	}
	// Order comes from the `_<micros>_<seq>` suffix the recorder puts on each
	// filename; files without one predate ordinals and sort first.
	const staged: { key: [number, number]; entry: StoredResponse }[] = [];
	for (const name of names) {
		// Metadata, not a recording.
		if (name.startsWith("sbxdiff-")) continue;
		const parsed = parse(await readFile(path.join(dir, name)));
		if (!parsed) continue;
		const m = /_(\d+)_(\d+)$/.exec(name);
		staged.push({
			key: m ? [Number(m[1]), Number(m[2])] : [0, 0],
			entry: parsed,
		});
	}
	staged.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
	for (const { entry } of staged) {
		const list = out.get(entry.url);
		if (list) list.push(entry);
		else out.set(entry.url, [entry]);
	}
	return out;
}

/**
 * Mounts `GET /__sbxdiff/fetch?url=…`.
 *
 * A miss is a 404 and is counted, never a live fetch: falling through to the
 * network would make a real divergence look like a clean run (RULES.md #14).
 */
export function mountStoreEndpoint(
	app: express.Express,
	store: Map<string, StoredResponse[]>,
	misses: string[]
) {
	app.get("/__sbxdiff/fetch", (req, res) => {
		// The harness page and the store live on different ports, so the
		// transport's fetch is cross-origin.
		res.set("Access-Control-Allow-Origin", "*");

		// ?all=1 hands over the whole store in one response, so the transport
		// can answer the page under test without any real I/O. See the comment
		// on SbxdiffTransport.init.
		if (req.query.all) {
			// url -> ordered list; the transport keeps its own per-URL counter,
			// so the page under test sees the recorded sequence.
			const all: Record<
				string,
				{ mime: string; status: number; body: string }[]
			> = {};
			for (const [url, hits] of store) {
				all[url] = hits.map((hit) => ({
					mime: hit.mime,
					status: 200,
					body: hit.body.toString("base64"),
				}));
			}
			res.json(all);

			return;
		}

		const url = String(req.query.url ?? "");
		const method = String(req.query.method ?? "GET").toUpperCase();
		// The store keys on URL alone, so it cannot answer for a method whose
		// body would differ. Report that as a miss instead of serving the GET.
		const ordinal = Number(req.query.ordinal ?? 0) || 0;
		const hits =
			method === "GET" || method === "HEAD" ? store.get(url) : undefined;
		// Past the end reuses the last: a resource fetched more often than it
		// was recorded is normal, and the oracle saw no more than it recorded.
		const hit = hits?.[Math.min(ordinal, hits.length - 1)];
		if (!hit) {
			misses.push(`${method} ${url}`);
			res.status(404).json({ error: "no recorded response", url, method });

			return;
		}
		res.json({
			mime: hit.mime,
			status: 200,
			body: hit.body.toString("base64"),
		});
	});
}
