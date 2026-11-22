// ============================================================================
// KC Tech Radio played-store sync (Nov 21, 2026)
//
// Derives the station-wide aired set from the deterministic timeline
// replay (lib/format.js timelineAired) over the live pool, seeded with
// the existing store, and merges it into data/played-stories.json
// (append-only). Also records CONTENT-class segment plays from the
// modeled per-bucket queues: Wasteland Jukebox tracks (strict
// reading, key track:<audio file>) and Dispatches from the Bunker
// bits (key desk:<pool index>). Service/format segments are exempt
// and are never recorded.
//
// Run on the same cadence as the other data pipelines (the wire
// refresh, about every 15 minutes). The store file is committed to
// GitHub by the pipeline's usual git step; the playlist route reads
// it back from the raw GitHub URL with the deployed local copy as
// fallback. Real-time exclusion does not depend on this file being
// fresh: the queue builder replays the timeline itself and unions
// the store in. This sync is what makes the record durable and
// auditable, and what carries track/desk plays (which the story
// replay does not model).
// ============================================================================

import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { getNewsPool } = await import('../lib/ingest.js');
const { timelineAired, buildPlaylist, BUCKET_MS, TRACK_PLAYED_PREFIX, DESK_PLAYED_PREFIX } =
  await import('../lib/format.js');
const { parsePlayedStore } = await import('../lib/played.js');
const { PRODUCERS_DESK } = await import('../lib/gonzo.js');

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const storePath = process.env.KCTR_PLAYED_STORE_PATH || path.join(repoRoot, 'data', 'played-stories.json');

let raw = null;
try {
  raw = await readFile(storePath, 'utf8');
} catch {
  raw = null;
}
let existingDoc = { lastSyncBucket: null, entries: [] };
if (raw) {
  try {
    existingDoc = JSON.parse(raw);
  } catch (err) {
    // A store we cannot read must stop the sync, never be treated
    // as an empty store: merging against "nothing" and writing the
    // result would erase the record.
    console.error(`played-store sync: ABORT: existing store at ${storePath} is not valid JSON (${err.message}); nothing written`);
    process.exit(1);
  }
}
const existingMap = parsePlayedStore(existingDoc); // Map<key, playedAtMs>
const existing = [...existingMap.entries()].map(([key, playedAtMs]) => ({
  key,
  firstQueuedAtMs: playedAtMs,
  playedAtMs,
}));
const existingEntryCount = Array.isArray(existingDoc.entries) ? existingDoc.entries.length : 0;

const pool = await getNewsPool();
const storyItems = pool.items.filter((i) => i.category !== 'music');
const nowMs = Date.now();
const seed = new Map(existingMap);

const aired = timelineAired(storyItems, nowMs, seed);

const byKey = new Map(existing.map((e) => [e.key, e]));
let added = 0;
for (const [key, playedAtMs] of aired) {
  if (!byKey.has(key)) {
    byKey.set(key, { key, firstQueuedAtMs: playedAtMs, playedAtMs });
    added += 1;
  }
}

// Content-class segment plays from modeled bucket queues. Buckets
// are modeled one at a time with a seed that accumulates everything
// found so far, so a track or desk bit is modeled at most once.
const currentBucket = Math.floor(nowMs / BUCKET_MS);
const epochBucket = Math.floor((existingDoc.epochMs || 0) / BUCKET_MS) || currentBucket;
let fromBucket = Number.isInteger(existingDoc.lastSyncBucket)
  ? existingDoc.lastSyncBucket + 1
  : epochBucket;
if (currentBucket - fromBucket > 96) fromBucket = currentBucket - 96; // bound catch-up
let segAdded = 0;
for (let b = Math.max(fromBucket, epochBucket); b < currentBucket; b++) {
  const bucketStart = b * BUCKET_MS;
  const seedNow = new Map([...byKey.values()].map((e) => [e.key, e.playedAtMs]));
  const q = buildPlaylist(pool, null, bucketStart + 1000, [], seedNow);
  for (const seg of q.segments) {
    let key = null;
    if (seg.kind === 'track' && seg.audioUrl) key = TRACK_PLAYED_PREFIX + seg.audioUrl;
    if (seg.kind === 'producers-desk') {
      const idx = PRODUCERS_DESK.indexOf(seg.script);
      if (idx >= 0) key = DESK_PLAYED_PREFIX + idx;
    }
    if (key && !byKey.has(key)) {
      byKey.set(key, { key, firstQueuedAtMs: bucketStart, playedAtMs: bucketStart });
      segAdded += 1;
    }
  }
}

const doc = {
  version: 1,
  epochMs: existingDoc.epochMs ?? null,
  updatedAt: new Date(nowMs).toISOString(),
  lastSyncBucket: currentBucket - 1,
  entries: [...byKey.values()].sort((a, b) => a.playedAtMs - b.playedAtMs),
};

// APPEND-ONLY GUARDS (Nov 22, 2026). The store is append-only by
// ruling; that is asserted here, not left to vigilance. A merge that
// would shrink the store, or that loses any content-segment play
// (track:/desk:) the existing store carries, aborts with a nonzero
// exit and writes nothing. This is the exact failure the Nov 22
// 00:49 run caught by hand: the existing store parsed empty, so the
// merged file dropped all 12 track/desk entries.
if (raw && doc.entries.length < existingEntryCount) {
  console.error(
    `played-store sync: ABORT: merged store has ${doc.entries.length} entries, fewer than the existing store's ${existingEntryCount}; append-only violated, nothing written`
  );
  process.exit(1);
}
if (raw) {
  const missingSegments = (Array.isArray(existingDoc.entries) ? existingDoc.entries : [])
    .map((e) => e && e.key)
    .filter(
      (k) =>
        typeof k === 'string' &&
        (k.startsWith(TRACK_PLAYED_PREFIX) || k.startsWith(DESK_PLAYED_PREFIX)) &&
        !byKey.has(k)
    );
  if (missingSegments.length > 0) {
    console.error(
      `played-store sync: ABORT: merged store is missing ${missingSegments.length} content-segment entries from the existing store (${missingSegments.slice(0, 3).join(', ')}${missingSegments.length > 3 ? ', ...' : ''}); append-only violated, nothing written`
    );
    process.exit(1);
  }
}
await writeFile(storePath, JSON.stringify(doc, null, 1) + '\n');
console.log(
  `played-store sync: pool=${storyItems.length} aired total=${aired.size} ` +
  `store entries=${doc.entries.length} (+${added} stories, +${segAdded} content segments this run)`
);
