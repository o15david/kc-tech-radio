// ============================================================================
// KC Tech Radio played-store sync (Nov 21, 2026)
//
// Records the station-wide aired set into data/played-stories.json
// (append-only), bucket by bucket, from the deterministic timeline
// walk (lib/format.js). Also records CONTENT-class segment plays
// from the modeled per-bucket queues: Wasteland Jukebox tracks
// (strict reading, key track:<audio file>) and Dispatches from the
// Bunker bits (key desk:<pool index>). A segment play is recorded
// only when the segment STARTS inside its bucket's aired window
// (the bucket's 30 minutes minus the carry-in from the previous
// bucket's straddling story): appearing anywhere in a bucket's
// ~4-hour queue is not airing, and the first version of this sync
// over-recorded plays by treating it as such. Service/format
// segments are exempt and are never recorded.
//
// RECORDING IS INCREMENTAL AND FROZEN PER BUCKET (Nov 22, 2026,
// pool-drift fix). The first version of this sync unioned a FULL
// replay (epoch to now, over the current pool snapshot) into the
// store on every run. But the replay is a function of the pool
// snapshot, and the pool is rebuilt from the live wires every
// refresh: items arrive with old publishedAt stamps, feeds drop
// out, headline dedupe swaps which item id survives a cluster,
// body enrichment changes story durations. Each run's replay
// therefore re-told history with different bucket heads (measured:
// one refresh changed the modeled head of every one of 17 past
// buckets), and the append-only union banked every variant as
// phantom plays: the store grew 458 -> 1,007 entries in under
// three hours against ~55 stories/hour of real airtime. Now a
// bucket's aired set is derived ONCE, by the first sync after the
// bucket completes, walking only the not-yet-recorded buckets
// (lib/format.js timelineReplayRange) seeded with the store's
// frozen record, and is never re-derived: no later pool state can
// add stories to a recorded bucket. The store doc carries the
// watermark (lastSyncBucket) and the walk's carry into the next
// unrecorded bucket (lastSyncCarryInSeconds) so the next run
// resumes the same continuous broadcast the last one left off.
//
// --rederive-stories (one-time correction, Nov 22, 2026): the
// story portion of the store was poisoned twice over, first by
// the seeded-replay bug and then by the pool-drift union above
// (see lib/format.js): thousands of stories that never aired were
// marked played. This mode rebuilds the story entries from one
// seed-free full replay over the current pool, preserving every
// track:/desk: entry verbatim, and deliberately relaxes the
// entry-count guard for that one rebuild (the segment guard still
// applies). It also re-pins the watermark and carry to that
// replay, so incremental recording resumes from a clean state.
// Normal runs never use it.
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
const {
  timelineReplay,
  timelineReplayRange,
  buildPlaylist,
  BUCKET_MS,
  STATION_EPOCH_MS,
  TRACK_PLAYED_PREFIX,
  DESK_PLAYED_PREFIX,
} = await import('../lib/format.js');
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
const rederiveStories = process.argv.includes('--rederive-stories');

const currentBucket = Math.floor(nowMs / BUCKET_MS);
const epochBucket = Math.floor(STATION_EPOCH_MS / BUCKET_MS);
const oldWatermark = Number.isInteger(existingDoc.lastSyncBucket)
  ? existingDoc.lastSyncBucket
  : epochBucket - 1;
// The first bucket whose aired set has not been frozen into the
// store. Recording covers [fromBucket, currentBucket): completed
// buckets only, derived once, in order. The 96-bucket catch-up
// bound is the segment pass's long-standing acceptance: after an
// outage longer than 48 hours the oldest unrecorded buckets stay
// unrecorded rather than being re-modeled over a drifted pool.
let fromBucket = Math.max(oldWatermark + 1, epochBucket);
if (currentBucket - fromBucket > 96) fromBucket = currentBucket - 96;

const byKey = new Map();
let added = 0;
let carryInByBucket = new Map(); // carry-in per bucket recorded this run
let endCarrySeconds = 0; // carry into currentBucket; persisted for the next run
let replayAired = null; // rederive mode only, for the log line

if (rederiveStories) {
  // One-time correction: story entries come from one seed-free
  // full replay over the current pool. Existing track:/desk:
  // entries are real plays and are carried over verbatim before
  // the segment pass below.
  const replay = timelineReplay(storyItems, nowMs);
  replayAired = replay.played.size;
  for (const [key, playedAtMs] of replay.played) {
    byKey.set(key, { key, firstQueuedAtMs: playedAtMs, playedAtMs });
  }
  added = replay.played.size;
  for (const e of existing) {
    if (e.key.startsWith(TRACK_PLAYED_PREFIX) || e.key.startsWith(DESK_PLAYED_PREFIX)) {
      byKey.set(e.key, e);
    }
  }
  carryInByBucket = replay.carryInByBucket;
  endCarrySeconds = replay.carryInSeconds;
  console.error(
    `played-store sync: --rederive-stories: rebuilding story entries from the corrected replay ` +
      `(${replay.played.size} stories); existing store had ${existingEntryCount} entries; ` +
      `track/desk entries preserved`
  );
} else {
  for (const e of existing) byKey.set(e.key, e);
  // Walk ONLY the unrecorded buckets, seeded with the frozen
  // record, so the modeled heads continue the broadcast the store
  // already documents. The persisted carry is meaningful only
  // when the range starts exactly at the bucket after the
  // watermark; a clamped catch-up restarts the carry at 0 (one
  // boundary story's remainder is approximated, nothing more).
  const startCarry =
    fromBucket === oldWatermark + 1 &&
    fromBucket > epochBucket &&
    Number.isFinite(existingDoc.lastSyncCarryInSeconds)
      ? existingDoc.lastSyncCarryInSeconds
      : 0;
  const range = timelineReplayRange(storyItems, fromBucket, currentBucket, existingMap, startCarry);
  for (const [key, playedAtMs] of range.played) {
    if (!byKey.has(key)) {
      byKey.set(key, { key, firstQueuedAtMs: playedAtMs, playedAtMs });
      added += 1;
    }
  }
  carryInByBucket = range.carryInByBucket;
  endCarrySeconds = range.carryInSeconds;
}

// Content-class segment plays from modeled bucket queues, over
// the same bucket range the story pass just recorded. Buckets are
// modeled one at a time with a seed that accumulates everything
// found so far, so a track or desk bit is modeled at most once.
let segAdded = 0;
for (let b = fromBucket; b < currentBucket; b++) {
  const bucketStart = b * BUCKET_MS;
  const seedNow = new Map([...byKey.values()].map((e) => [e.key, e.playedAtMs]));
  const q = buildPlaylist(pool, null, bucketStart + 1000, [], seedNow);
  // Only the head of the bucket's queue airs in that bucket: the
  // window is the bucket's 30 minutes minus the carry-in (the
  // previous bucket's straddling story finishing), taken from the
  // same walk that recorded the bucket's stories. A track or desk
  // bit records as played only when it STARTS inside the window;
  // sitting deeper in the ~4-hour queue is not a play.
  const windowSeconds = BUCKET_MS / 1000 - (carryInByBucket.get(b) || 0);
  let offset = 0;
  for (const seg of q.segments) {
    const startsInWindow = offset < windowSeconds;
    offset += seg.estSeconds || 0;
    if (!startsInWindow) continue;
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
  lastSyncCarryInSeconds: endCarrySeconds,
  entries: [...byKey.values()].sort((a, b) => a.playedAtMs - b.playedAtMs),
};

// APPEND-ONLY GUARDS (Nov 22, 2026). The store is append-only by
// ruling; that is asserted here, not left to vigilance. A merge that
// would shrink the store, or that loses any content-segment play
// (track:/desk:) the existing store carries, aborts with a nonzero
// exit and writes nothing. This is the exact failure the Nov 22
// 00:49 run caught by hand: the existing store parsed empty, so the
// merged file dropped all 12 track/desk entries.
if (raw && !rederiveStories && doc.entries.length < existingEntryCount) {
  console.error(
    `played-store sync: ABORT: merged store has ${doc.entries.length} entries, fewer than the existing store's ${existingEntryCount}; append-only violated, nothing written`
  );
  process.exit(1);
}
if (raw && rederiveStories && doc.entries.length < existingEntryCount) {
  // The one sanctioned shrink: the --rederive-stories correction
  // removes story entries the poisoned replay fabricated. The
  // segment guard below still runs, so no real play can be lost.
  console.error(
    `played-store sync: --rederive-stories: store shrinks ${existingEntryCount} -> ${doc.entries.length} entries (fabricated story plays removed; track/desk entries preserved)`
  );
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
  `played-store sync: pool=${storyItems.length} recorded buckets ${fromBucket}..${currentBucket - 1} ` +
  `store entries=${doc.entries.length} (+${added} stories, +${segAdded} content segments this run)` +
  (rederiveStories ? ` [story entries re-derived from the corrected replay: ${replayAired} stories]` : '')
);
