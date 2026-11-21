// ============================================================================
// THE PLAYED STORE: the station's permanent record of what has aired.
//
// David's ruling, Nov 21, 2026: "create a database of queued stories
// and whether they have ever played or not. mark played after they
// play. i'm not kidding when I say no repeats." And the architecture
// ruling the same day: this is ONE global broadcast, not a per-person
// station. A story that has aired on the shared timeline, for anyone,
// never airs again for anyone.
//
// THE STORE: data/played-stories.json in this repo, read at runtime
// from its raw GitHub URL (the same pattern as the social, music, and
// newsletter JSON feeds) with the deployed local copy as fallback.
// It is shared across every Vercel instance and survives deploys,
// which per-instance memory provably does not on this stack (the
// Nov 20 body-coverage detour: cold instances start fresh). The
// tradeoff, stated honestly: GitHub JSON is a batch store, not a
// real-time database. Writes land when scripts/played-store-sync.mjs
// runs (it materializes the timeline's aired set from the same
// deterministic replay the queue builder uses) and the file is
// uploaded, on the wire-refresh cadence. Real-time exclusion does
// NOT depend on the file being fresh: the queue builder also replays
// the timeline itself (lib/format.js timelineAired), so a story the
// timeline has consumed is excluded even before the next sync writes
// it down. The store is the durable audit record and the checkpoint
// that keeps the replay short; the replay is the live guarantee.
// The exclusion set is the UNION of the two, so neither a stale file
// nor a pool that has churned can resurrect a played story that is
// still in the pool.
//
// Entry shape: { key, title, link, firstSeenAt, playedAt }.
//   key         the story's stable identity: ingest item.id
//               (the feed guid, or the canonical link when no guid).
//   firstSeenAt when the story first entered the pool (its
//               publishedAt is the honest proxy the pool carries).
//   playedAt    the timeline moment the story aired: the start of
//               the 30-minute bucket whose queue head consumed it.
// ============================================================================

import { readFile } from 'node:fs/promises';

export const PLAYED_STORE_URL =
  'https://raw.githubusercontent.com/o15david/kc-tech-radio/main/data/played-stories.json';

const FETCH_TIMEOUT_MS = 8000;
const FEED_TTL_MS = 60 * 1000; // the store moves slowly; 60s is plenty
const USER_AGENT = 'KC Tech Radio played-store (https://kc-tech-radio.vercel.app)';

/** The story's stable identity in the played store. */
export function storyKeyOf(item) {
  return item ? String(item.id || item.link || '') : '';
}

/**
 * Parse a played-store document into a Map of key -> playedAt (ms).
 * Forgiving by design: a malformed store yields an empty map, never
 * an exception, because the timeline replay still protects the queue.
 */
export function parsePlayedStore(doc) {
  const map = new Map();
  if (!doc || !Array.isArray(doc.entries)) return map;
  for (const e of doc.entries) {
    if (!e || !e.key || !Number.isFinite(e.playedAt)) continue;
    const prev = map.get(e.key);
    if (prev === undefined || e.playedAt < prev) map.set(e.key, e.playedAt);
  }
  return map;
}

async function readLocalStore() {
  // Test/local override, and the deployed-bundle fallback.
  const path = process.env.KCTR_PLAYED_STORE_PATH
    ? process.env.KCTR_PLAYED_STORE_PATH
    : new URL('../data/played-stories.json', import.meta.url);
  try {
    const raw = await readFile(path, 'utf8');
    return parsePlayedStore(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

async function fetchRemoteStore() {
  try {
    const res = await fetch(PLAYED_STORE_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parsePlayedStore(await res.json());
  } catch {
    return null;
  }
}

const playedCache =
  globalThis.__kctrPlayedCache ||
  (globalThis.__kctrPlayedCache = { fetchedAt: 0, map: new Map(), inFlight: null });

/**
 * The shared played map (key -> playedAt ms), union of the remote
 * store and the deployed local copy. Cached 60 seconds per instance;
 * the cache is a performance detail only, because any instance can
 * rebuild the same exclusion from the timeline replay.
 */
export async function getPlayedMap() {
  const now = Date.now();
  if (playedCache.fetchedAt && now - playedCache.fetchedAt < FEED_TTL_MS) {
    return playedCache.map;
  }
  if (!playedCache.inFlight) {
    playedCache.inFlight = (async () => {
      const [remote, local] = await Promise.all([fetchRemoteStore(), readLocalStore()]);
      const merged = new Map(local);
      if (remote) {
        for (const [k, v] of remote) {
          const prev = merged.get(k);
          if (prev === undefined || v < prev) merged.set(k, v);
        }
      }
      playedCache.map = merged;
      playedCache.fetchedAt = Date.now();
      return merged;
    })().finally(() => {
      playedCache.inFlight = null;
    });
  }
  if (playedCache.fetchedAt) return playedCache.map; // serve stale
  return playedCache.inFlight;
}
