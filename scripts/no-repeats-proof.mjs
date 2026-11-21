#!/usr/bin/env node
// NO-REPEATS PROOF (David's ruling, Nov 21, 2026): the global
// broadcast never airs a story twice. Four checks over a synthetic
// pool pinned to fixed times relative to the station epoch:
//
//   1. STORE EXCLUSION: with a played store naming story X, a built
//      queue contains zero segments for X (and zero overlap with
//      the whole store).
//   2. TIMELINE MARKING: the stories bucket B's head consumes are
//      in the aired map at bucket B+1, and bucket B+1's queue
//      contains none of them.
//   3. STORE WRITE PATH: the sync's merge logic (timelineAired +
//      parsePlayedStore round-trip through a store document) puts
//      a consumed story into the store document, and a queue built
//      with that store excludes it.
//   4. SCIENCE IN THE 65% BAND: a science-classified story filed
//      under a summarized ring category counts toward the tech
//      band in the mix accounting (David, Nov 21, 2026).
import { register } from 'node:module';

register('./extensionless-loader.mjs', import.meta.url);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

const { buildPlaylist, timelineAired, STATION_EPOCH_MS, BUCKET_MS } = await import('../lib/format.js');
const { parsePlayedStore } = await import('../lib/played.js');

const BODY =
  'The announcement drew a crowd of engineers, founders, and city staff to a downtown hall on Tuesday morning. ' +
  'Speakers walked through the roadmap in detail, pointing to hiring plans, new office space, and a timeline that stretches into next year. ' +
  'Local suppliers said the work would ripple through machine shops, logistics firms, and software teams across the metro. ' +
  'Analysts who follow the sector called the move significant but measured, noting that execution over the next two quarters will decide whether the early momentum holds. ' +
  'Residents at the meeting asked about traffic, timelines, and how the project fits the neighborhood plan, and the presenters promised monthly updates as milestones land.';
const SUMMARY =
  'A short wire summary with the essential facts and a quote from an official familiar with the matter.';

// Deterministic fixture: every item published just before the
// epoch, so all of it is eligible from the first bucket on.
let seq = 0;
function item(category, opts = {}) {
  seq += 1;
  const n = seq;
  return {
    id: `syn-${n}`,
    category,
    source: opts.source || 'Wire',
    title: opts.title || `Company${n} unveils initiative ${n} for sector ${n}`,
    summary: opts.summary || SUMMARY,
    link: `https://example.com/story-${n}`,
    publishedAt: STATION_EPOCH_MS - 3600 * 1000,
    ...(opts.full ? { body: BODY } : {}),
  };
}
function makePool() {
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

const T0 = STATION_EPOCH_MS + 5 * 60 * 1000; // 5 min into bucket 0

// --- 1. Store exclusion ------------------------------------------------------
{
  const pool = makePool();
  const victim = pool.items[10];
  const store = new Map([[victim.id, STATION_EPOCH_MS]]);
  const q = buildPlaylist(pool, null, T0, [], store);
  const storySegs = q.segments.filter((s) => s.kind === 'story');
  check('store: queue built', storySegs.length > 50);
  check(
    'store: played story absent from queue',
    !storySegs.some((s) => s.link === victim.link)
  );
  check(
    'store: zero overlap with the whole store',
    !storySegs.some((s) => store.has(`syn-${s.link.split('-').pop()}`) && s.link === victim.link)
  );
  check('store: playedExcludedStories counts the victim', q.playedExcludedStories >= 1);
  check('store: recycledStories is 0', q.recycledStories === 0);
  check('store: timeline present with on-air segment', Boolean(q.timeline && q.timeline.onAir));
}

// --- 2. Timeline marking ------------------------------------------------------
{
  const pool = makePool();
  const storyItems = pool.items;
  const airedAtB1 = timelineAired(storyItems, STATION_EPOCH_MS + BUCKET_MS + 1000, null);
  check('timeline: bucket 0 consumed stories', airedAtB1.size >= 10);
  const qB1 = buildPlaylist(pool, null, STATION_EPOCH_MS + BUCKET_MS + 1000, [], null);
  const qLinks = new Set(qB1.segments.filter((s) => s.kind === 'story').map((s) => s.link));
  const byLink = new Map(storyItems.map((i) => [i.link, i.id]));
  const overlap = [...airedAtB1.keys()].filter((id) => {
    const link = storyItems.find((i) => i.id === id)?.link;
    return link && qLinks.has(link);
  });
  check('timeline: bucket 1 queue excludes everything bucket 0 aired', overlap.length === 0);
  check('timeline: bucket 1 queue still has fresh stories', qLinks.size > 50);
  void byLink;
}

// --- 3. Store write path (sync merge round-trip) ------------------------------
{
  const pool = makePool();
  const storyItems = pool.items;
  const played = timelineAired(storyItems, STATION_EPOCH_MS + 2 * BUCKET_MS + 1000, null);
  const doc = {
    version: 1,
    epochMs: STATION_EPOCH_MS,
    updatedAt: new Date(STATION_EPOCH_MS + 2 * BUCKET_MS).toISOString(),
    entries: [...played.entries()].map(([key, playedAt]) => {
      const it = storyItems.find((i) => i.id === key);
      return { key, title: it?.title || '', link: it?.link || '', firstSeenAt: it?.publishedAt || null, playedAt };
    }),
  };
  const storeMap = parsePlayedStore(doc);
  check('sync: store document round-trips', storeMap.size === played.size && played.size > 10);
  const q = buildPlaylist(pool, null, STATION_EPOCH_MS + 2 * BUCKET_MS + 1000, [], storeMap);
  const qLinks = new Set(q.segments.filter((s) => s.kind === 'story').map((s) => s.link));
  const leaked = doc.entries.filter((e) => qLinks.has(e.link));
  check('sync: queue built on the written store excludes every recorded play', leaked.length === 0);
}

// --- 4. Science counts inside the 65% band ------------------------------------
{
  // A small pool, so every candidate queues and the band each story
  // lands in is directly observable on its segment.
  const smallPool = () => {
    const items = [];
    const cats = [
      ['ai', 12, true], ['tech', 12, true], ['business', 8, true],
      ['local', 12, true], ['state', 8, true], ['regional', 8, true],
      ['national', 10, false], ['global', 10, false],
    ];
    for (const [cat, n, full] of cats) {
      for (let i = 0; i < n; i++) items.push(item(cat, { full }));
    }
    return { items };
  };
  // A research story filed under 'global' (a summarized ring
  // category) by a general wire: the science classifier must pull
  // it into the tech band.
  const pool = smallPool();
  const sci = item('global', {
    source: 'Wire',
    title: 'Researchers discover a new species of frog in the Amazon canopy',
    summary: 'Scientists said the discovery, published in the journal Nature, rewrites the family tree of the group.',
  });
  pool.items.push(sci);
  const q = buildPlaylist(pool, null, T0, [], null);
  const seg = q.segments.find((s) => s.kind === 'story' && s.link === sci.link);
  check('science: research story queued', Boolean(seg));
  check('science: research story counts in the tech band', seg ? seg.mixBand === 'tech' : false);
  const pool2 = smallPool();
  const sciCat = item('science', { source: 'ScienceDaily', title: 'Telescope captures a newborn exoplanet' });
  pool2.items.push(sciCat);
  const q2 = buildPlaylist(pool2, null, T0, [], null);
  const seg2 = q2.segments.find((s) => s.kind === 'story' && s.link === sciCat.link);
  check('science: science-category story queued in tech band', Boolean(seg2) && seg2.mixBand === 'tech');
}


// ---------------------------------------------------------------------------
// Content-class segments under the generalized exception (Nov 21, 2026):
// Jukebox tracks (strict reading) and Dispatches bits are content and
// never repeat once recorded; service segments repeat freely.
{
const pool = makePool();
const baseQ = buildPlaylist(pool, null, T0, [], null);
const allTrackFiles = [...new Set(baseQ.segments.filter((s) => s.kind === 'track').map((s) => s.audioUrl))];
check('baseline queue has jukebox tracks to test with', allTrackFiles.length >= 2, `files=${allTrackFiles.length}`);

const trackStore = new Map(allTrackFiles.map((f) => ['track:' + f, STATION_EPOCH_MS + 1000]));
const noTracks = buildPlaylist(pool, null, T0, [], trackStore);
check('tracks recorded as played never air again (strict reading)',
  noTracks.segments.filter((s) => s.kind === 'track').length === 0);

const deskStore = new Map();
for (let i = 0; i < 64; i++) deskStore.set('desk:' + i, STATION_EPOCH_MS + 1000);
const noDesk = buildPlaylist(pool, null, T0, [], deskStore);
check('Dispatches bits recorded as played never air again',
  noDesk.segments.filter((s) => s.kind === 'producers-desk').length === 0);

const svc1 = buildPlaylist(pool, null, T0, [], null);
const svc2 = buildPlaylist(pool, null, T0 + BUCKET_MS, [], null);
check('service segments (station IDs) still repeat freely across buckets',
  svc1.segments.some((s) => s.kind === 'station-id') && svc2.segments.some((s) => s.kind === 'station-id'));
check('shows rundown stays capped at once per queue hour',
  svc1.segments.filter((s) => s.kind === 'music').length <= 1);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
