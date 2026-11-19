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
//   4. Return visit: a listener who already heard the early blocks comes
//      back at 10:47:30 and lands on the live Business segment, not on
//      anything already played.
//   5. Drift / overrun: a Business story whose real MP3 runs long is cut
//      by its slot end (10:50); at 10:51 the selection is the Producer's
//      Desk, never the stale overrun. Plus a schedule gap (the silent
//      music slot) resolves to a 'gap' decision, not an early start.
// ============================================================================

import { register } from 'node:module';
// lib/*.js use extensionless imports (bundler-style); teach Node.
register('./extensionless-loader.mjs', import.meta.url);
const { buildPlaylist, epochForChicagoWall } = await import('../lib/format.js');
const { effectiveTimeline, liveSegmentAt, nextPlayable } = await import('../lib/liveEdge.js');

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
// Enough fresh stories per category that the no-repeat rotation (which
// replays from the 08:00 cycle anchor) never runs a block dry. Items are
// newest-first, published over the last 30 hours so every replay instance
// from the anchor onward has eligible stories.
const CATS = ['local', 'state', 'regional', 'national', 'global', 'ai', 'tech', 'business', 'newsletter'];
const NOW = epochForChicagoWall(2026, 11, 19, 10, 27); // Thu Nov 19 2026, 10:27:00 CT
// Realistic summary length (~60 words -> ~23s at the station's 155 wpm),
// matching what the real RSS wires carry; toy one-liners would compress
// every block to a few seconds and make the schedule mostly gaps.
const SUMMARY =
  'Officials said the move marks a significant shift for the region and ' +
  'could reshape how local companies hire, build, and compete over the ' +
  'next several years, with analysts watching closely for follow-on ' +
  'effects across the Midwest and beyond as the story continues to ' +
  'develop through the week ahead for everyone involved in it.';
const items = [];
for (const cat of CATS) {
  for (let i = 0; i < 40; i++) {
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
// The listener heard everything scheduled through the tech block (they
// left during the music slot), i.e. every segment whose window ended by
// 10:45 is in the finished set.
const finished = new Set(
  tl.filter((e) => e.endMs <= epochForChicagoWall(2026, 11, 19, 10, 45)).map((e) => e.seg.id)
);
const backMs = epochForChicagoWall(2026, 11, 19, 10, 45) + 40000; // 10:45:40, inside a Business story
const back = nextPlayable(tl, backMs, finished);
const backSeg = back.type === 'segment' ? tl[back.index].seg : null;
check('selection is a segment', back.type === 'segment', JSON.stringify(back));
check(
  'selection is in the Business & Markets block (started 10:45)',
  !!backSeg && backSeg.blockKey === 'business-headlines',
  backSeg && backSeg.blockKey
);
check('selection was not already played', !!backSeg && !finished.has(backSeg.id));
check(
  'offset equals time since that segment\'s window start',
  back.type === 'segment' && back.offsetMs === backMs - tl[back.index].startMs,
  back.type === 'segment' && `offsetMs=${back.offsetMs}`
);

// --- 5. Drift, overrun, and the schedule gap -------------------------------------
console.log('\n5. Drift / overrun / gap handling');
// Give the first Business story a real duration 10 minutes longer than
// its estimate: its effective window must be cut at the block's slot end
// (10:50, the Producer's Desk start), and at 10:51 the live selection
// must be the Desk, not the stale overrun.
const bizEntry = tl.find((e) => e.seg.blockKey === 'business-headlines' && e.seg.kind === 'story');
const durations = new Map([[bizEntry.seg.id, bizEntry.seg.estSeconds + 600]]);
const tlFat = effectiveTimeline(segments, durations);
const fatEntry = tlFat.find((e) => e.seg.id === bizEntry.seg.id);
check(
  'overrunning segment is cut at its slot end (10:50)',
  fatEntry.endMs === epochForChicagoWall(2026, 11, 19, 10, 50),
  `endMs=${new Date(fatEntry.endMs).toISOString()}`
);
const deskEntry = tlFat.find((e) => e.seg.blockKey === 'producers-desk');
const deskMs = deskEntry.startMs + 5000; // 5s into the Desk's window (10:50:05)
const desk = nextPlayable(tlFat, deskMs, new Set());
check(
  'just after 10:50 the selection is the Producer\'s Desk, not the stale overrun',
  desk.type === 'segment' && tlFat[desk.index].seg.blockKey === 'producers-desk',
  desk.type === 'segment' ? tlFat[desk.index].seg.blockKey : desk.type
);
// Playback-behind variant: the same decision when the listener's player
// only finished the fat segment at 10:50:05 (it played the full overrun).
const late = nextPlayable(tlFat, deskMs, new Set([bizEntry.seg.id]));
check(
  'a player that finished the overrun late also skips to the Desk',
  late.type === 'segment' && tlFat[late.index].seg.blockKey === 'producers-desk',
  late.type === 'segment' ? tlFat[late.index].seg.blockKey : late.type
);
// Gap: the music feed is empty, so after the tech block's copy ends there
// is scheduled silence until Business at 10:45. A moment inside that
// silence must produce a 'gap' decision pointing at the Business intro,
// never an early start.
const bizStart = epochForChicagoWall(2026, 11, 19, 10, 45);
const techEntries = tl.filter(
  (e) => e.seg.blockKey === 'tech-headlines' && e.startMs < bizStart
);
const lastTechEnd = Math.max(...techEntries.map((e) => e.endMs));
if (lastTechEnd < bizStart) {
  const gapMs = lastTechEnd + 1000;
  const gap = nextPlayable(tl, gapMs, new Set());
  check(
    'inside the schedule gap the decision is a wait, not an early start',
    gap.type === 'gap' && tl[gap.index].seg.blockKey === 'business-headlines',
    JSON.stringify(gap)
  );
  check(
    'gap wait ends exactly at the Business block start',
    gap.type === 'gap' && gapMs + gap.waitMs === bizStart,
    gap.type === 'gap' && `waitMs=${gap.waitMs}`
  );
} else {
  check('a schedule gap exists after the tech block (music slot is silent)', false,
    `lastTechEnd=${new Date(lastTechEnd).toISOString()}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
