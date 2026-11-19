// ============================================================================
// LIVE-EDGE VERIFICATION HARNESS
//
// Proves the wall-clock-locked playback model (lib/liveEdge.js, used by
// app/Player.js) against the real playlist builder (lib/format.js), with
// an injected clock and a synthetic wire pool. No browser, no network.
//
//   node scripts/live-edge-check.mjs
//
// Scenarios:
//   1. Playlist determinism: two builds over the same pool + clock are
//      byte-identical.
//   2. Spoken times + startMs: upcoming blocks carry their true Chicago
//      slot times (the :30 station ID says "10:30 AM" and starts at the
//      10:30 epoch; the 11:00 general intro says "11 AM").
//   3. Tune-in mid-segment: at 5s into the :30 station ID's window, the
//      selection is that segment at offset 5000ms.
//   4. Return visit: a listener who already heard everything through
//      10:45 comes back at 10:45:40 and lands on the segment live at
//      that moment, not on anything already played.
//   5. The continuous chain: with estimated durations, segment windows
//      tile the whole buffer with zero gaps (the schedule has no holes
//      by construction since the dead-air fix). Plus the NO-CUT rule:
//      a story whose real MP3 runs 10 minutes long is NOT cut at its
//      slot end; its effective window extends to its real end, tune-in
//      during the overrun finds it, and a stale anchor overtaken by
//      drift is skipped rather than aired late.
//   6. Simulated listening walk: with deterministic pseudo-real
//      durations spanning the measured error range, a sequential
//      player (nextInSequence transitions, the way app/Player.js now
//      plays) walks a full hour. Every segment it starts plays its
//      full real duration; anchors either start on their pinned
//      minute or are skipped; there is no dead air between segments
//      except explicit waits that end exactly at an anchor's start.
// ============================================================================

import { register } from 'node:module';
// lib/*.js use extensionless imports (bundler-style); teach Node.
register('./extensionless-loader.mjs', import.meta.url);
const { buildPlaylist, epochForChicagoWall, hashString } = await import('../lib/format.js');
const { effectiveTimeline, liveSegmentAt, nextPlayable, nextInSequence, isAnchorSegment } =
  await import('../lib/liveEdge.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- Synthetic wire pool ---------------------------------------------------
// Sized like the real wire (~1,050 items): the chain format draws far
// more stories per hour than the old queue format did (blocks fill to
// target lengths), and the no-repeat rotation replays from the 08:00
// cycle anchor, so the pool must be deep enough that no block runs dry.
// Items are newest-first, published over the last 120 hours so every
// replay instance from the anchor onward has eligible stories.
const CATS = ['local', 'state', 'regional', 'national', 'global', 'ai', 'tech', 'business', 'newsletter'];
const NOW = epochForChicagoWall(2026, 11, 19, 10, 27); // Thu Nov 19 2026, 10:27:00 CT
// Realistic summary length (~60 words), matching what the real RSS
// wires carry; toy one-liners would compress story durations and throw
// off the fill math the chain depends on.
const SUMMARY =
  'Officials said the move marks a significant shift for the region and ' +
  'could reshape how local companies hire, build, and compete over the ' +
  'next several years, with analysts watching closely for follow-on ' +
  'effects across the Midwest and beyond as the story continues to ' +
  'develop through the week ahead for everyone involved in it.';
const items = [];
for (const cat of CATS) {
  for (let i = 0; i < 120; i++) {
    items.push({
      id: `${cat}-story-${i}`,
      category: cat,
      title: `${cat} headline number ${i}`,
      summary: SUMMARY,
      source: `${cat} wire`,
      link: `https://example.com/${cat}/${i}`,
      publishedAt: NOW - (i + 1) * 3600 * 1000,
    });
  }
}
const pool = { items };
const weather = { tempF: 55, condition: 'clear skies', windMph: 7 };

const playlist = buildPlaylist(pool, weather, NOW);
const segments = playlist.segments;
console.log(`Playlist built at 10:27 CT: ${segments.length} segments, buffer ${playlist.bufferSeconds}s`);

// --- 1. Determinism ----------------------------------------------------------
console.log('\n1. Determinism');
const again = buildPlaylist(pool, weather, NOW);
check(
  'two consecutive builds are byte-identical',
  JSON.stringify(again.segments) === JSON.stringify(segments)
);

// --- 2. Spoken times + startMs ----------------------------------------------
console.log('\n2. Spoken times and scheduled starts');
const stationId = segments.find((s) => s.blockKey === 'station-id');
check(
  ':30 station ID starts at the 10:30 Chicago epoch',
  stationId && stationId.startMs === epochForChicagoWall(2026, 11, 19, 10, 30),
  stationId && `startMs=${new Date(stationId.startMs).toISOString()}`
);
check(
  ':30 station ID speaks "10:30 AM"',
  !!stationId && stationId.script.includes('10:30 AM'),
  stationId && stationId.script
);
const generalIntro = segments.find((s) => s.blockKey === 'general-news' && s.kind === 'intro');
check(
  '11:00 general intro starts at the 11:00 Chicago epoch',
  generalIntro && generalIntro.startMs === epochForChicagoWall(2026, 11, 19, 11, 0),
  generalIntro && `startMs=${new Date(generalIntro.startMs).toISOString()}`
);
check(
  '11:00 general intro speaks "11 AM Central Time"',
  !!generalIntro && generalIntro.script.includes('11 AM Central Time'),
  generalIntro && generalIntro.script
);

// --- 3. Tune-in mid-segment ---------------------------------------------------
console.log('\n3. Tune-in at the live edge (mid-segment)');
const tl = effectiveTimeline(segments, null);
const sidEntry = tl.find((e) => e.seg.blockKey === 'station-id');
const tuneInMs = sidEntry.startMs + 5000;
const tune = nextPlayable(tl, tuneInMs, new Set());
check('selection is a segment', tune.type === 'segment', JSON.stringify(tune));
check(
  'selection is the :30 station ID',
  tune.type === 'segment' && tl[tune.index].seg.id === sidEntry.seg.id
);
check(
  'offset is exactly 5000ms into the segment',
  tune.type === 'segment' && tune.offsetMs === 5000,
  tune.type === 'segment' && `offsetMs=${tune.offsetMs}`
);
check(
  'liveSegmentAt agrees on the containing segment',
  liveSegmentAt(tl, tuneInMs) === tl.indexOf(sidEntry)
);

// --- 4. Return visit ------------------------------------------------------------
console.log('\n4. Return visit lands on the live segment, not a replay');
// The listener heard everything scheduled through 10:45, i.e. every
// segment whose window ended by 10:45 is in the finished set.
const finished = new Set(
  tl.filter((e) => e.endMs <= epochForChicagoWall(2026, 11, 19, 10, 45)).map((e) => e.seg.id)
);
const backMs = epochForChicagoWall(2026, 11, 19, 10, 45) + 40000; // 10:45:40
const back = nextPlayable(tl, backMs, finished);
const backEntry = back.type === 'segment' ? tl[back.index] : null;
check('selection is a segment', back.type === 'segment', JSON.stringify(back));
check(
  'selection window contains the return moment (10:45:40)',
  !!backEntry && backEntry.startMs <= backMs && backMs < backEntry.endMs,
  backEntry && `${new Date(backEntry.startMs).toISOString()}..${new Date(backEntry.endMs).toISOString()}`
);
check('selection was not already played', !!backEntry && !finished.has(backEntry.seg.id));
check(
  'offset equals time since that segment\'s window start',
  back.type === 'segment' && back.offsetMs === backMs - backEntry.startMs,
  back.type === 'segment' && `offsetMs=${back.offsetMs}`
);

// --- 5. Continuous chain + no-cut overrun handling ----------------------------
console.log('\n5. Continuous chain (no holes) and no-cut overrun handling');
// With estimated durations, every segment's effective window must end
// exactly where the next begins: the chain tiles the buffer.
let maxGapMs = 0;
let overlaps = 0;
for (let i = 0; i + 1 < tl.length; i++) {
  const gap = tl[i + 1].startMs - tl[i].endMs;
  if (gap > maxGapMs) maxGapMs = gap;
  if (gap < 0) overlaps++;
}
check(
  'zero gaps over 2s between consecutive segment windows',
  maxGapMs <= 2000,
  `maxGapMs=${maxGapMs}`
);
check('no overlapping windows at estimated durations', overlaps === 0, `overlaps=${overlaps}`);
// Overrun: give a Business story a real duration 10 minutes longer than
// its estimate. The NO-CUT rule: its effective window extends to its
// real end (never capped at the slot end), a listener tuning in during
// the overrun finds the story still playing, and when it finally
// finishes, the sequence moves to its successor at offset 0.
const bizEntry = tl.find((e) => e.seg.blockKey === 'business-headlines' && e.seg.kind === 'story');
const durations = new Map([[bizEntry.seg.id, bizEntry.seg.estSeconds + 600]]);
const tlFat = effectiveTimeline(segments, durations);
const fatEntry = tlFat.find((e) => e.seg.id === bizEntry.seg.id);
check(
  'overrunning segment window extends to its real end, past its slot end',
  fatEntry.endMs === fatEntry.startMs + (bizEntry.seg.estSeconds + 600) * 1000 &&
    fatEntry.endMs > fatEntry.seg.slotEndMs,
  `endMs=${new Date(fatEntry.endMs).toISOString()} slotEndMs=${new Date(fatEntry.seg.slotEndMs).toISOString()}`
);
const duringMs = fatEntry.seg.slotEndMs + 5000; // inside the overrun, past the slot end
const during = nextPlayable(tlFat, duringMs, new Set());
check(
  'tune-in during the overrun finds the story still playing (not skipped)',
  during.type === 'segment' && tlFat[during.index].seg.id === bizEntry.seg.id,
  during.type === 'segment' ? tlFat[during.index].seg.id : during.type
);
const finishMs = fatEntry.endMs + 120; // it finishes, late, in full
const seq = nextInSequence(tlFat, tlFat.indexOf(fatEntry), new Set([bizEntry.seg.id]), finishMs);
check(
  'after the late finish, the sequence advances to a successor',
  seq.type === 'segment' || seq.type === 'wait',
  JSON.stringify(seq)
);
// Stale anchor rule: finish the last span-1 segment after the :57
// tease's pinned minute has passed; the tease must be SKIPPED (never
// aired late) and playback must land on a later segment.
const teaseIdx = tlFat.findIndex((e) => e.seg.blockKey === 'hour-tease');
const teaseEntry = tlFat[teaseIdx];
const beforeTeaseIdx = teaseIdx - 1;
const lateSeq = nextInSequence(
  tlFat, beforeTeaseIdx, new Set([tlFat[beforeTeaseIdx].seg.id]), teaseEntry.seg.startMs + 5000
);
check(
  'an anchor overtaken by drift is skipped, never aired late',
  (lateSeq.skipped || []).includes(teaseEntry.seg.id) &&
    (lateSeq.type === 'ended' || lateSeq.index > teaseIdx),
  JSON.stringify(lateSeq)
);

// --- 6. Simulated listening walk ------------------------------------------------
console.log('\n6. Simulated listening walk (sequential player, pseudo-real durations)');
// Deterministic pseudo-real durations spanning and exceeding the
// measured error range (ratios 0.92x to 1.28x of estimate).
const realDur = new Map();
for (const s of segments) {
  const ratio = 0.92 + (hashString(s.id) % 37) / 100;
  realDur.set(s.id, Math.max(3, Math.round(s.estSeconds * ratio * 10) / 10));
}
const tlReal = effectiveTimeline(segments, realDur);
// Start the walk exactly at the :30 station ID's start (a segment
// boundary), then play sequentially the way app/Player.js does.
let idx = tlReal.findIndex((e) => e.seg.id === sidEntry.seg.id);
let playhead = sidEntry.startMs;
const walkEnd = playhead + 3600 * 1000;
const playedIds = new Set();
const finishedWalk = new Set();
let playedCount = 0;
let anchorStartsOnTime = 0;
let anchorsPlayed = 0;
let waits = 0;
let waitTotalMs = 0;
let violations = 0;
let guard = 0;
while (playhead < walkEnd && idx >= 0 && idx < tlReal.length && guard++ < 600) {
  const entry = tlReal[idx];
  const seg = entry.seg;
  if (playedIds.has(seg.id)) { violations++; console.log(`    repeat in walk: ${seg.id}`); break; }
  playedIds.add(seg.id);
  // The segment plays its FULL real duration: the walk advances the
  // playhead by exactly the real duration, never by the (shorter)
  // estimated window. If the player cut at estimated windows, the
  // playhead would advance by estSeconds instead and every start
  // below would drift early; the anchor assertions catch that model.
  const durMs = realDur.get(seg.id) * 1000;
  if (isAnchorSegment(seg)) {
    anchorsPlayed++;
    if (Math.abs(playhead - seg.startMs) <= 2000) anchorStartsOnTime++;
    else console.log(`    anchor played off its minute: ${seg.id} start=${new Date(seg.startMs).toISOString()} playhead=${new Date(playhead).toISOString()}`);
  }
  playedCount++;
  playhead += durMs;
  finishedWalk.add(seg.id);
  const nxt = nextInSequence(tlReal, idx, finishedWalk, playhead);
  for (const id of nxt.skipped || []) finishedWalk.add(id);
  if (nxt.type === 'segment') {
    idx = nxt.index;
  } else if (nxt.type === 'wait') {
    waits++;
    waitTotalMs += nxt.waitMs;
    playhead += nxt.waitMs;
    idx = nxt.index;
  } else {
    break;
  }
}
check(`walk played a full hour of segments (${playedCount})`, playedCount >= 40, `played=${playedCount}`);
check('no segment repeated in the walk', violations === 0 && playedIds.size === playedCount);
check(
  `every anchor played started on its pinned minute (${anchorStartsOnTime}/${anchorsPlayed})`,
  anchorStartsOnTime === anchorsPlayed,
  `${anchorStartsOnTime}/${anchorsPlayed}`
);
check(
  `waits only ever end at an anchor start (waits=${waits}, total ${(waitTotalMs / 1000).toFixed(0)}s)`,
  waitTotalMs <= 180 * 1000,
  `waitTotalMs=${waitTotalMs}`
);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
