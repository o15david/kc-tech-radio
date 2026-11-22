#!/usr/bin/env node
// PLAYED-STORE DRIFT PROOF (Nov 22, 2026, pool-drift fix): the
// played store's recording is stable under pool drift. The defect
// it guards: the sync used to union a FULL timeline replay (epoch
// to now, over the current pool snapshot) into the append-only
// store on every run. The pool is rebuilt from the live wires
// every refresh, so each replay re-told history with different
// bucket heads, and the union banked every variant as phantom
// plays (measured live: store 458 -> 1,007 in under 3 hours
// against ~55 stories/hour of airtime; in simulation, one pool
// perturbation changed the modeled head of all 17 past buckets).
// The corrected discipline, implemented by
// scripts/played-store-sync.mjs and mirrored here over the same
// exported primitives (timelineReplayRange + the store
// watermark/carry): a bucket's aired set is derived ONCE, by the
// first recording walk after the bucket completes, seeded with
// the frozen record, and never re-derived.
//
// Checks, over a synthetic pool with deterministic churn (items
// dropped, bodies enriched, late items arriving with publishedAt
// stamps inside already-recorded buckets, exactly what a
// returning feed does):
//   1. AIRTIME BAND: incremental recording over a simulated 8.5
//      hours lands in the same plausible band as the one-shot
//      replay (350-600 stories).
//   2. PER-RUN RATE: every post-bucket recording run adds at
//      most one bucket's worth of stories (<= 60), including runs
//      late in the simulation with 17+ buckets of frozen history
//      behind them: growth tracks airtime, not history length.
//      Mid-bucket runs (the production sync fires twice per
//      bucket; no bucket completes between them) record nothing.
//   3. PAST-BUCKET INVARIANCE: after the 8.5h snapshot, six more
//      buckets are recorded under heavy churn; after every run,
//      the recorded set of every already-recorded bucket is
//      byte-identical to the snapshot. No later pool state adds
//      stories to a recorded bucket.
//   4. OLD-ALGORITHM CONTRAST: the retired full-replay union,
//      run over the identical pool sequence, banks hundreds of
//      phantom plays at mid-bucket runs, where the set of
//      completed buckets has not changed and no new airtime
//      exists to record, proving the churn in this fixture is
//      strong enough to expose the defect.
//   5. STORE ROUND-TRIP: the recorded entries survive a
//      parsePlayedStore round-trip through a store document.
import { register } from 'node:module';

register('./extensionless-loader.mjs', import.meta.url);

const { timelineReplay, timelineReplayRange, STATION_EPOCH_MS, BUCKET_MS } = await import(
  '../lib/format.js'
);
const { parsePlayedStore } = await import('../lib/played.js');

// Pool generator: the same fixture as timeline-replay-proof.mjs,
// whose one-shot replay lands in the 350-600 band at 8.5 hours.
const BODY_BASE =
  'The announcement drew a crowd of engineers, founders, and city staff to a downtown hall on Tuesday morning. ' +
  'Speakers walked through the roadmap in detail, pointing to hiring plans, new office space, and a timeline that stretches into next year. ' +
  'Local suppliers said the work would ripple through machine shops, logistics firms, and software teams across the metro. ' +
  'Analysts who follow the sector called the move significant but measured, noting that execution over the next two quarters will decide whether the early momentum holds. ' +
  'Residents at the meeting asked about traffic, timelines, and how the project fits the neighborhood plan, and the presenters promised monthly updates as milestones land. ' +
  'The company said the next phase begins early next year, with hiring across engineering, operations, and support roles. ' +
  'City officials welcomed the announcement and pointed to recent investments in transit and broadband nearby. ' +
  'Competitors offered no comment, but industry watchers said the move raises the stakes for every firm in the sector.';
const BODY_EXTRA = [
  'A spokesperson confirmed the timeline in a brief statement after the event.',
  'Documents filed with the city put the projected investment in the tens of millions over five years.',
  'Workers at the site said preparations have been under way for several weeks already.',
  'The announcement follows a year of quiet negotiations, according to people familiar with the talks.',
];
const SUMMARY_BASE =
  'Officials confirmed the essential facts on Tuesday, describing the development as significant for the region and promising further details in a written statement later this week, according to people familiar with the matter who spoke with reporters.';
const SUMMARY_EXTRA = [
  'Shares moved slightly on the news.',
  'No timeline was given for the next step in the process.',
  'The statement did not address the cost of the proposal.',
];

let seq = 0;
function item(category, opts = {}) {
  seq += 1;
  const n = seq;
  const summary = SUMMARY_BASE + (n % 3 ? ` ${SUMMARY_EXTRA[n % 3]}` : '');
  const body = BODY_BASE + (n % 4 ? ` ${BODY_EXTRA[n % 4]}` : '');
  return {
    id: `syn-${n}`,
    category,
    source: opts.source || 'Wire',
    title: opts.title || `Company${n} unveils initiative ${n} for sector ${n}`,
    summary: opts.summary || summary,
    link: `https://example.com/story-${n}`,
    publishedAt: opts.publishedAt ?? STATION_EPOCH_MS - 3600 * 1000,
    ...(opts.full ? { body } : {}),
  };
}
function makePool() {
  seq = 0;
  const items = [];
  const cats = [
    ['ai', 150, true], ['tech', 170, true], ['business', 60, true],
    ['newsletter', 20, false], ['local', 230, true], ['state', 90, true],
    ['regional', 150, true], ['national', 150, false], ['global', 190, false],
  ];
  for (const [cat, n, full] of cats) {
    for (let i = 0; i < n; i++) items.push(item(cat, { full }));
  }
  return items;
}

// Deterministic churn (seeded LCG): the same pool sequence for
// every algorithm under test.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
let lateSeq = 0;
function churn(items, rng, nowMs, lateCount) {
  let out = items.filter(() => rng() > 1 / 15); // a feed drops out
  out = out.map((it) => (!it.body && rng() < 1 / 9 ? { ...it, body: BODY_BASE } : it)); // enrichment lands
  const elapsedH = Math.max(1, Math.floor((nowMs - STATION_EPOCH_MS) / 3600000));
  for (let i = 0; i < lateCount; i++) {
    lateSeq += 1;
    const cat = ['ai', 'tech', 'local', 'state', 'business'][lateSeq % 5];
    out.push(
      item(cat, {
        full: lateSeq % 2 === 0,
        // Published INSIDE the already-elapsed window: the
        // signature move of a feed that was down and came back.
        publishedAt: nowMs - Math.floor(rng() * elapsedH) * 3600000 - 999,
        title: `LateWire${lateSeq} breaks story ${lateSeq} for sector ${lateSeq}`,
      })
    );
  }
  return out;
}

// The corrected recording discipline, mirroring
// scripts/played-store-sync.mjs (normal mode): walk only the
// unrecorded buckets, seeded with the frozen store; persist the
// watermark and the carry into the next unrecorded bucket.
function makeStore() {
  return { entries: [], lastSyncBucket: null, lastSyncCarryInSeconds: null };
}
function recordRun(state, storyItems, nowMs) {
  const currentBucket = Math.floor(nowMs / BUCKET_MS);
  const epochBucket = Math.floor(STATION_EPOCH_MS / BUCKET_MS);
  const oldWatermark = Number.isInteger(state.lastSyncBucket) ? state.lastSyncBucket : epochBucket - 1;
  let fromBucket = Math.max(oldWatermark + 1, epochBucket);
  if (currentBucket - fromBucket > 96) fromBucket = currentBucket - 96;
  const startCarry =
    fromBucket === oldWatermark + 1 && fromBucket > epochBucket && Number.isFinite(state.lastSyncCarryInSeconds)
      ? state.lastSyncCarryInSeconds
      : 0;
  const seed = new Map(state.entries.map((e) => [e.key, e.playedAtMs]));
  const range = timelineReplayRange(storyItems, fromBucket, currentBucket, seed, startCarry);
  const byKey = new Map(state.entries.map((e) => [e.key, e]));
  let added = 0;
  for (const [key, playedAtMs] of range.played) {
    if (!byKey.has(key)) {
      byKey.set(key, { key, playedAtMs });
      added += 1;
    }
  }
  state.entries = [...byKey.values()];
  state.lastSyncBucket = currentBucket - 1;
  state.lastSyncCarryInSeconds = range.carryInSeconds;
  return added;
}

// The retired discipline: union the full replay into the store
// on every run.
function recordRunOldStyle(state, storyItems, nowMs) {
  const { played } = timelineReplay(storyItems, nowMs);
  const byKey = new Map(state.entries.map((e) => [e.key, e]));
  let added = 0;
  for (const [key, playedAtMs] of played) {
    if (!byKey.has(key)) {
      byKey.set(key, { key, playedAtMs });
      added += 1;
    }
  }
  state.entries = [...byKey.values()];
  return added;
}

const perBucketSets = (entries) => {
  const m = new Map();
  for (const e of entries) {
    const b = Math.floor(e.playedAtMs / BUCKET_MS);
    if (!m.has(b)) m.set(b, new Set());
    m.get(b).add(e.key);
  }
  return m;
};
const setsEqual = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures += 1;
};

const EPOCH_BUCKET = Math.floor(STATION_EPOCH_MS / BUCKET_MS);
const PHASE_A_BUCKETS = 17; // 8.5 hours
const PHASE_B_BUCKETS = 6; // 3 more hours under heavy churn

// Drive both algorithms over the IDENTICAL pool sequence: build
// the sequence once (pool snapshots per recording run), then run
// each algorithm across it. The cadence matches production: the
// sync and the wire refresh both run about every 15 minutes, so
// each 30-minute bucket sees TWO recording runs: a mid-bucket run
// (no new bucket has completed since the last post-bucket run)
// and a post-bucket run (one new bucket completed). The pool
// churns before every run after the first.
function buildSequence() {
  const rng = makeRng(20261122);
  lateSeq = 0;
  const snapshots = [];
  let items = makePool();
  let first = true;
  for (let k = 1; k <= PHASE_A_BUCKETS + PHASE_B_BUCKETS; k++) {
    for (const kind of ['mid', 'post']) {
      const nowMs =
        kind === 'post'
          ? STATION_EPOCH_MS + k * BUCKET_MS + 1000
          : STATION_EPOCH_MS + k * BUCKET_MS - BUCKET_MS / 2;
      if (!first) items = churn(items, rng, nowMs, k > PHASE_A_BUCKETS ? 40 : 25);
      first = false;
      snapshots.push({ nowMs, items, kind, bucketIndex: k });
    }
  }
  return snapshots;
}

// --- Corrected discipline -----------------------------------------------------
{
  const snapshots = buildSequence();
  const store = makeStore();
  const postAdditions = [];
  const midAdditions = [];
  let totalA = 0;
  let totalB = 0;
  let snapshotA = null;
  let invarianceOk = true;
  let invarianceDetail = '';
  for (const { nowMs, items, kind, bucketIndex } of snapshots) {
    const added = recordRun(store, items, nowMs);
    if (kind === 'post') {
      postAdditions.push(added);
      if (bucketIndex <= PHASE_A_BUCKETS) totalA += added;
      else totalB += added;
      if (bucketIndex === PHASE_A_BUCKETS) snapshotA = perBucketSets(store.entries);
    } else {
      midAdditions.push(added);
    }
    if (bucketIndex > PHASE_A_BUCKETS && snapshotA) {
      const nowSets = perBucketSets(store.entries);
      for (const [b, setA] of snapshotA) {
        const setNow = nowSets.get(b) || new Set();
        if (!setsEqual(setA, setNow)) {
          invarianceOk = false;
          invarianceDetail = `bucket ${b - EPOCH_BUCKET} changed at bucket ${bucketIndex} (${kind}): ${setA.size} -> ${setNow.size}`;
        }
      }
    }
  }
  check(
    'airtime: incremental recording over 8.5h lands in the plausible band 350-600',
    totalA >= 350 && totalA <= 600,
    `recorded=${totalA}`
  );
  check(
    'rate: no post-bucket run adds more than one bucket of stories (<= 60)',
    postAdditions.every((a) => a <= 60),
    `max run=${Math.max(...postAdditions)}, additions=${postAdditions.join(',')}`
  );
  check(
    'cadence: mid-bucket runs (no bucket completed) record nothing',
    midAdditions.every((a) => a === 0),
    `mid additions=${midAdditions.join(',')}`
  );
  check(
    'invariance: recorded buckets never gain entries under pool drift',
    invarianceOk,
    invarianceDetail || 'all past buckets byte-identical after every churned run'
  );
  check(
    'growth: 3 more hours under heavy churn add ~3h of airtime (60-270 stories)',
    totalB >= 60 && totalB <= 270,
    `added=${totalB} over ${PHASE_B_BUCKETS} buckets`
  );
  check(
    'carry: persisted carry into the next bucket is a partial story (0 <= c < 300s)',
    Number.isFinite(store.lastSyncCarryInSeconds) &&
      store.lastSyncCarryInSeconds >= 0 &&
      store.lastSyncCarryInSeconds < 300,
    `carry=${(store.lastSyncCarryInSeconds || 0).toFixed(1)}`
  );

  // --- 5. Store round-trip -----------------------------------------------------
  const doc = {
    version: 1,
    epochMs: STATION_EPOCH_MS,
    updatedAt: new Date(STATION_EPOCH_MS).toISOString(),
    lastSyncBucket: store.lastSyncBucket,
    lastSyncCarryInSeconds: store.lastSyncCarryInSeconds,
    entries: store.entries.map((e) => ({ key: e.key, firstQueuedAtMs: e.playedAtMs, playedAtMs: e.playedAtMs })),
  };
  const parsed = parsePlayedStore(doc);
  check(
    'round-trip: recorded entries survive parsePlayedStore',
    parsed.size === store.entries.length,
    `entries=${store.entries.length} parsed=${parsed.size}`
  );

  // --- 4. Old-algorithm contrast over the identical sequence -------------------
  // At a mid-bucket run the set of completed buckets is unchanged
  // since the previous post-bucket run, so EVERY story the retired
  // full-replay union adds there is definitionally a phantom: no
  // new airtime exists for it to record. The corrected discipline
  // adds exactly 0 at those runs (asserted above); the retired one
  // banks drift variance by the hundred.
  const oldStore = makeStore();
  let oldTotal = 0;
  let oldMidPhantoms = 0;
  for (const { nowMs, items, kind } of snapshots) {
    const added = recordRunOldStyle(oldStore, items, nowMs);
    oldTotal += added;
    if (kind === 'mid') oldMidPhantoms += added;
  }
  const newTotal = totalA + totalB;
  check(
    'contrast: retired union banks hundreds of phantom plays at mid-bucket runs (zero new airtime)',
    oldMidPhantoms > 300,
    `old mid-bucket phantoms=${oldMidPhantoms}, corrected mid-bucket additions=0`
  );
  check(
    'contrast: retired full-replay union grows well beyond the corrected recording on identical churn',
    oldTotal > newTotal + 300,
    `old=${oldTotal} new=${newTotal}`
  );
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
