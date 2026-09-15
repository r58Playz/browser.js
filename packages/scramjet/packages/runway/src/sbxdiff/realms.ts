/**
 * The realm sweep: every realm both sides have, not only the page's.
 *
 * Its own module because `index.ts` runs `main()` on import, so anything left
 * there can only be used by a live run. The realm sweep is what the gate FAILS
 * on -- 13 findings on rateyourmusic against 3 in the page realm -- so an
 * offline re-diff that could not do it was blind to most of the gate. You would
 * fix something, re-diff in a second, and not know whether it had moved.
 */

import { Kind } from "./trace.ts";
import {
	bucketize,
	diff,
	visibleRealmUrl,
	type DiffOptions,
	type Report,
	type Side,
} from "./diff.ts";

export type RealmFinding = { url: string; report: Report };

/**
 * Every realm the two sides have in common, not just the page.
 *
 * The default comparison scopes to ONE realm per side because that is the only
 * scoping under which two sides are certainly comparable -- and on
 * rateyourmusic that realm is 2% of the run. Cloudflare's fingerprinting runs
 * in the Turnstile widget's realm and in a blob worker, so "0 T0 leak(s)" was a
 * statement about the 2%: diffing the widget's realm turned up six T1
 * divergences at once, every one of them in the payload it posts (RULES.md
 * #132, #133).
 *
 * Reported, not gated. The extra realms have no baseline -- the widget's alone
 * carries over a thousand T2 buckets -- and the proxy's worker bootstrap is
 * served from behind the prefix, so it classifies as guest and its own
 * `importScripts` reads as a T0. Making that fail the run would be a false
 * alarm; leaving the realms unexamined was a silent one.
 */
export function diffExtraRealms(
	oracle: Side,
	sandbox: Side,
	opts: DiffOptions,
	/** Where the per-group pairing notes go. Printed by the caller. */
	notes: string[] = []
): RealmFinding[] {
	const skipped = notes;
	const index = (side: Side) => {
		const counts = new Map<number, number>();
		for (const r of side.trace.records) {
			if (r.kind !== Kind.BindingCall && r.kind !== Kind.Interceptor) continue;
			counts.set(r.realm, (counts.get(r.realm) ?? 0) + 1);
		}
		const byKey = new Map<
			string,
			{ realm: number; url: string; n: number }[]
		>();
		for (const [realm, url] of side.trace.realms) {
			const n = counts.get(realm) ?? 0;
			// A realm with nothing in it never ran, and one with a handful of
			// records is a document that only got as far as being created.
			if (n < 50) continue;
			const key = visibleRealmUrl(url);
			const list = byKey.get(key) ?? [];
			list.push({ realm, url, n });
			byKey.set(key, list);
		}
		// Creation order, so the Nth blob worker on one side pairs with the Nth
		// on the other.
		const created = side.trace.realmCreatedUs;
		for (const list of byKey.values()) {
			list.sort(
				(a, b) => (created.get(a.realm) ?? 0) - (created.get(b.realm) ?? 0)
			);
		}

		return byKey;
	};

	const o = index(oracle);
	const s = index(sandbox);
	const out: RealmFinding[] = [];
	for (const [key, oList] of o) {
		const sList = s.get(key);
		if (!sList) continue;
		// Only when the two sides have the SAME number of documents at this
		// URL. One URL can host several in sequence -- rateyourmusic serves the
		// challenge and the real page both at `/`, and Critical-CH makes
		// Chromium restart the navigation on top of that -- so with unequal
		// counts, pairing by creation order silently holds a challenge page up
		// against a real one and reports the difference between two documents
		// as a divergence. `selectGuestRealm` has the same warning for the same
		// reason.
		// Unequal counts no longer throw the whole group away.
		//
		// On rateyourmusic the sandbox has twelve blob realms to the oracle's
		// nine, so `blob:https://challenges.cloudflare.com` was refused entirely
		// -- and with it the EIGHT Cloudflare benchmark workers that pair
		// one-to-one and carry 35000 records each. Refusing nine good pairs
		// because three realms had no partner is the wrong trade: those eight
		// are most of the run.
		//
		// When the counts differ, pair by SIZE RANK rather than creation order
		// and refuse a pair whose record counts are more than 4x apart. That is
		// what the original warning was really about: holding a 35600-record
		// worker up against an 822-record one reports the difference between two
		// unrelated documents. Equal counts still pair by creation order, which
		// is the case where the Nth document really is the Nth.
		let pairsList = oList.map((o, i) => [o, sList[i]] as const);
		if (oList.length !== sList.length) {
			const bySize = (l: typeof oList) => [...l].sort((a, b) => b.n - a.n);
			const o2 = bySize(oList);
			const s2 = bySize(sList);
			pairsList = [];
			const unpaired: string[] = [];
			for (let i = 0; i < Math.max(o2.length, s2.length); i++) {
				const a = o2[i];
				const b = s2[i];
				if (!a || !b) {
					unpaired.push(`${(a ?? b)!.n} record(s)`);
					continue;
				}
				const ratio = Math.max(a.n, b.n) / Math.max(1, Math.min(a.n, b.n));
				if (ratio > 4) {
					unpaired.push(`${a.n} vs ${b.n}`);
					continue;
				}
				pairsList.push([a, b]);
			}
			skipped.push(
				`${key}: ${pairsList.length} realm(s) paired by size, ` +
					`${unpaired.length} with no partner (${unpaired.join(", ")})`
			);
		}
		for (const [o, sPair] of pairsList) {
			if (o.realm === oracle.realm && sPair.realm === sandbox.realm) {
				continue;
			}
			const divergences = diff(
				{ ...oracle, realm: o.realm, url: o.url },
				{ ...sandbox, realm: sPair.realm, url: sPair.url },
				opts
			);
			const report = bucketize(divergences);
			const interesting = [...report.buckets.keys()].filter(
				(k) => k.startsWith("T0|") || k.startsWith("T1|")
			);
			if (interesting.length) out.push({ url: key, report });
		}
	}
	return out;
}
