#!/usr/bin/env node
// TIMELINE REPLAY PROOF (Nov 22, 2026 correction): the global
// broadcast's replay consumes stories at AIRTIME rate, one
// continuous timeline, and its result does not depend on the
// persisted store. Checks over a synthetic pool pinned to fixed
// times relative to the station epoch:
//
//   1. AIRTIME RATE: over a simulated 8.5 hours from the epoch
//      (17 buckets), the replay's aired story count lands in the
//      plausible airtime band (350-600 stories at the pool's
//      story lengths). The seeded-replay bug this corrects marked
//      2,404 stories in the same span.
//   2. SEED INDEPENDENCE: the walk is identical before and after
//      a timelineAired call carrying a large store seed; the seed
//      only ADDS exclusions to the union, it never steers the
//      walk. (Regression test for the Nov 22 runaway consumption.)
//   3. CARRY SANITY: every bucket's carry-in (the previous
//      bucket's straddling story remainder) is a partial story,
//      never a whole window, and straddles actually occur.
//   4. DETERMINISM: two independent processes computing the aired
//      set over the same pool snapshot produce identical results
//      (canonical hash compared via --dump child runs).
import { register } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

register('./extensionless-loader.mjs', import.meta.url);

const { timelineAired, timelineReplay, STATION_EPOCH_MS, BUCKET_MS } = await import(
  '../lib/format.js'
);

// Story lengths mirror the measured real pool (full-depth scripts
// ~85s, summarized ~35s, blended ~65-70s), and vary per item: two
// fixed lengths (52s and 12s) divide the 1800s window exactly at
// the mix ratio, which would make every bucket land on the window
// boundary with zero carry and prove nothing about straddles.
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
    publishedAt: STATION_EPOCH_MS - 3600 * 1000,
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
  return { items };
}

const SIM_MS = STATION_EPOCH_MS + Math.round(8.5 * 3600 * 1000); // 17 buckets in
const canonicalHash = (played) =>
  createHash('sha256')
    .update([...played.entries()].sort().map(([k, v]) => `${k}@${v}`).join('\n'))
    .digest('hex');

if (process.argv.includes('--dump')) {
  const { items } = makePool();
  const { played } = timelineReplay(items, SIM_MS);
  console.log(canonicalHash(played));
  process.exit(0);
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures += 1;
};

// --- 1 + 3. Airtime rate and carry sanity over a simulated 8.5h --------------
{
  const { items } = makePool();
  const { played, carryInByBucket } = timelineReplay(items, SIM_MS);
  check(
    'airtime: aired count after 8.5h is in the plausible band 350-600',
    played.size >= 350 && played.size <= 600,
    `aired=${played.size}`
  );
  const epochBucket = Math.floor(STATION_EPOCH_MS / BUCKET_MS);
  const perBucket = new Map();
  for (const [, at] of played) {
    const b = Math.floor(at / BUCKET_MS);
    perBucket.set(b, (perBucket.get(b) || 0) + 1);
  }
  let maxPerBucket = 0;
  for (let b = epochBucket; b < epochBucket + 17; b++) {
    maxPerBucket = Math.max(maxPerBucket, perBucket.get(b) || 0);
  }
  check('airtime: no bucket consumes more than 80 stories', maxPerBucket <= 80, `max=${maxPerBucket}`);
  const carries = [...carryInByBucket.values()];
  check(
    'carry: every carry-in is a partial story (0 <= carry < 300s)',
    carries.every((c) => c >= 0 && c < 300),
    `max=${Math.max(...carries).toFixed(1)}`
  );
  check('carry: straddles occur (some bucket carries in > 0s)', carries.some((c) => c > 0));
}

// --- 2. Seed independence ------------------------------------------------------
{
  const { items } = makePool();
  const before = timelineReplay(items, SIM_MS).played;
  const seed = new Map(items.slice(0, 600).map((i) => [i.id, STATION_EPOCH_MS]));
  const unioned = timelineAired(items, SIM_MS, seed);
  const after = timelineReplay(items, SIM_MS).played;
  check(
    'seed: walk identical before and after a seeded call',
    canonicalHash(before) === canonicalHash(after)
  );
  check(
    'seed: union contains the whole walk and the seed',
    [...before.keys()].every((k) => unioned.has(k)) &&
      [...seed.keys()].every((k) => unioned.has(k)),
    `walk=${before.size} union=${unioned.size}`
  );
}

// --- 4. Determinism across independent processes --------------------------------
{
  const self = fileURLToPath(import.meta.url);
  const run = () =>
    execFileSync(process.execPath, [self, '--dump'], { encoding: 'utf8' }).trim();
  const h1 = run();
  const h2 = run();
  const { items } = makePool();
  const hLocal = canonicalHash(timelineReplay(items, SIM_MS).played);
  check('determinism: two independent processes agree', h1 === h2, h1.slice(0, 12));
  check('determinism: child processes match the in-process walk', h1 === hLocal);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
