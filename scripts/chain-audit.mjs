// ============================================================================
// CHAIN AUDIT HARNESS — the dead-air fix verification bar.
//
//   node scripts/chain-audit.mjs              (simulated audits + cycle walk)
//   node scripts/chain-audit.mjs --url http://localhost:3000/api/playlist
//
// Simulated mode (no network except the one real-pool fetch):
//   A. Gap audit at several simulated times of day (03:00 thin-pool
//      hours included), against the REAL pool time-filtered the way the
//      repeat investigation modeled a live wire, plus a SPARSE variant
//      (every 6th item per category) to stress the filler path:
//        - zero gaps over 2s between consecutive segment windows
//          (window = [startMs, startMs + estSeconds), capped at slotEndMs)
//        - no uncapped overlap over 2s (nothing meaningful gets cut)
//        - on-air sampling: at every sampled instant, exactly one
//          segment's window contains it
//        - anchor audit: :00 / :30 / :57 anchors start at their exact
//          pinned Chicago minute, and every segment that speaks a time
//          (anchors and time-check fillers alike) speaks the time of
//          its own start
//        - determinism: two builds over the same pool + clock are
//          byte-identical
//   B. Cycle walk: a simulated listener over one full 8-hour cycle
//      (08:00-16:00 CT) against the real pool, stepping 15s at a time
//      and recording the segment live at each step. Zero story links
//      may air twice in the cycle. Also reports story vs filler
//      minutes per cycle hour.
//
// URL mode: fetch a live /api/playlist response once and run the same
// gap / on-air / anchor audits on it at real now.
// ============================================================================

import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ctParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
function spokenTimeOf(ms) {
  const parts = {};
  for (const p of ctParts.formatToParts(new Date(ms))) parts[p.type] = p.value;
  if (parts.minute === '00') return `${parts.hour} ${parts.dayPeriod}`;
  return `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}
function chicagoMinuteOf(ms) {
  const parts = {};
  for (const p of ctParts.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return parseInt(parts.minute, 10);
}

function windowOf(seg) {
  const start = seg.startMs;
  const end = Math.min(seg.startMs + seg.estSeconds * 1000, seg.slotEndMs ?? Infinity);
  return [start, end];
}

function auditPlaylist(label, segments, sampleFromMs, sampleToMs) {
  console.log(`\n--- ${label}: ${segments.length} segments ---`);
  // Gap audit (uncapped windows: what would actually be heard back to back)
  let maxGapMs = 0;
  let worstOverlapMs = 0;
  let capped = 0;
  for (let i = 0; i + 1 < segments.length; i++) {
    const gap = segments[i + 1].startMs - (segments[i].startMs + segments[i].estSeconds * 1000);
    if (gap > maxGapMs) maxGapMs = gap;
    if (gap < 0) {
      capped++;
      if (-gap > worstOverlapMs) worstOverlapMs = -gap;
    }
  }
  check('zero gaps over 2s between consecutive segment windows', maxGapMs <= 2000, `maxGapMs=${maxGapMs}`);
  check('no uncapped overlap over 2s (nothing meaningful is cut)', worstOverlapMs <= 2000, `worstOverlapMs=${worstOverlapMs} cappedSegments=${capped}`);
  if (capped) console.log(`  note: ${capped} segment(s) capped by their slot end (overshoot filler path)`);

  // On-air sampling: exactly one live segment at every sampled instant.
  let samples = 0;
  let violations = 0;
  for (let t = sampleFromMs; t < sampleToMs; t += 37000) {
    samples++;
    let live = 0;
    for (const seg of segments) {
      const [s, e] = windowOf(seg);
      if (s <= t && t < e) live++;
    }
    if (live !== 1) violations++;
  }
  check(`exactly one segment on air at every sampled instant (${samples} samples)`, violations === 0, `violations=${violations}`);

  // Anchor audit.
  let anchors = 0;
  let anchorBad = 0;
  let timeSpeakers = 0;
  let timeBad = 0;
  for (const seg of segments) {
    let pinnedMinute = null;
    if (seg.blockKey === 'general-news' && seg.kind === 'intro') pinnedMinute = 0;
    if (seg.blockKey === 'station-id') pinnedMinute = 30;
    if (seg.blockKey === 'hour-tease') pinnedMinute = 57;
    if (pinnedMinute !== null) {
      anchors++;
      if (chicagoMinuteOf(seg.startMs) !== pinnedMinute || seg.startMs % 60000 !== 0) anchorBad++;
    }
    // EVERY spoken time phrase in the script (anchors and fillers
    // alike) must be the minute of the segment's own startMs. All
    // matches are checked, not just the first: a filler composed
    // before its chain position was final once shipped with a time
    // phrase a minute off its true start.
    const phrases = [...(seg.script || '').matchAll(/It is (\d{1,2}(?::\d{2})? [AP]M)/g)];
    if (phrases.length) {
      timeSpeakers++;
      for (const m of phrases) {
        if (m[1] !== spokenTimeOf(seg.startMs)) {
          timeBad++;
          if (timeBad <= 3) {
            console.log(`    time mismatch: seg ${seg.id} starts ${new Date(seg.startMs).toISOString()} speaks "${m[1]}" expected "${spokenTimeOf(seg.startMs)}"`);
          }
        }
      }
    }
  }
  check(`all ${anchors} anchors start at their pinned minute exactly`, anchorBad === 0, `bad=${anchorBad}`);
  check(`every time-speaking segment (${timeSpeakers}) speaks its own start time`, timeBad === 0, `bad=${timeBad}`);
}

const urlArg = process.argv.indexOf('--url');
if (urlArg !== -1) {
  const url = process.argv[urlArg + 1];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const data = await res.json();
  const now = Date.now();
  const segs = data.segments;
  const lastEnd = segs.length ? Math.min(segs[segs.length - 1].startMs + segs[segs.length - 1].estSeconds * 1000, segs[segs.length - 1].slotEndMs ?? Infinity) : now;
  auditPlaylist(`LIVE ${url} (bufferSeconds=${data.bufferSeconds})`, segs, now, lastEnd);
  const liveNow = segs.filter((s) => { const [a, b] = windowOf(s); return a <= now && now < b; });
  check('a segment is on air right now', liveNow.length === 1, `live=${liveNow.length}`);
  if (liveNow.length) console.log(`  on air now: [${liveNow[0].blockKey}/${liveNow[0].kind}] ${liveNow[0].headline}`);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Simulated mode
// ---------------------------------------------------------------------------
const { getNewsPool } = await import('../lib/ingest.js');
const { buildPlaylist, epochForChicagoWall } = await import('../lib/format.js');

const pool = await getNewsPool();
console.log(`REAL POOL: ${pool.items.length} items, feeds ok ${pool.feeds.filter((f) => f.ok).length}/${pool.feeds.length}`);
const weather = { tempF: 55, condition: 'clear skies', windMph: 7 };

const poolAt = (t, sparse = false) => {
  let items = pool.items.filter((it) => it.publishedAt == null || it.publishedAt <= t);
  if (sparse) {
    const byCat = new Map();
    items = items.filter((it) => {
      const n = (byCat.get(it.category) || 0) + 1;
      byCat.set(it.category, n);
      return n % 6 === 1;
    });
  }
  return { ...pool, items };
};

// A. Gap / on-air / anchor / determinism audits at several times of day.
const TIMES = [
  ['03:00 (thin overnight wire)', epochForChicagoWall(2026, 11, 19, 3, 0), false],
  ['03:00 SPARSE (every 6th item)', epochForChicagoWall(2026, 11, 19, 3, 0), true],
  ["10:54 (David's dead-air check time)", epochForChicagoWall(2026, 11, 19, 10, 54), false],
  ['12:52 (top-of-hour approach: pre-anchor fill run before 13:00)', epochForChicagoWall(2026, 11, 19, 12, 52), false],
  ['18:52:37 (top-of-hour approach, live-style odd seconds)', epochForChicagoWall(2026, 11, 19, 18, 52) + 37000, false],
  ['17:20 (drive time)', epochForChicagoWall(2026, 11, 19, 17, 20), false],
  ['23:40 (late night, cycle edge)', epochForChicagoWall(2026, 11, 19, 23, 40), false],
];
for (const [label, t, sparse] of TIMES) {
  const p = poolAt(t, sparse);
  const { segments, bufferSeconds } = buildPlaylist(p, weather, t);
  const firstStart = segments[0].startMs;
  const lastEnd = segments[segments.length - 1].startMs + segments[segments.length - 1].estSeconds * 1000;
  console.log(`\n=== ${label}: pool ${p.items.length} items, bufferSeconds=${bufferSeconds} ===`);
  auditPlaylist(label, segments, Math.max(t, firstStart), lastEnd);
  const again = buildPlaylist(p, weather, t);
  check('determinism: two builds byte-identical', JSON.stringify(again.segments) === JSON.stringify(segments));
}

// B. Cycle walk: simulated listener, 08:00-16:00 CT, 15s steps.
// The pool snapshot is FIXED for the whole walk: the builder's honesty
// cutoff (an instance may only draw stories published by its own start)
// is what keeps not-yet-published stories out of early blocks, exactly
// as designed. (Time-filtering the pool per step instead would double-
// apply that constraint and manufacture false repeats: a story that
// joins the filtered pool mid-block gets dealt an earlier slot, the
// block's chain shifts, and stories it already dealt reappear under new
// segment ids, revisions of a prediction, not second airings. The
// repeat investigation flagged the same overcount in its union walk.)
console.log('\n=== Cycle walk 08:00-16:00 CT (real pool, fixed snapshot) ===');
const CYCLE_START = epochForChicagoWall(2026, 11, 19, 8, 0);
const CYCLE_END = epochForChicagoWall(2026, 11, 19, 16, 0);
const STEP = 15000;
const airedById = new Map(); // segment id -> { link, blockKey }
const perHour = new Map(); // hour -> { storySec, fillerSec }
const t0 = Date.now();
let steps = 0;
for (let t = CYCLE_START; t < CYCLE_END; t += STEP) {
  steps++;
  const { segments } = buildPlaylist(pool, null, t);
  const live = segments.find((s) => { const [a, b] = windowOf(s); return a <= t && t < b; });
  if (!live) {
    check(`segment on air at ${new Date(t).toISOString()}`, false, 'nothing live');
    break;
  }
  if (!airedById.has(live.id)) {
    airedById.set(live.id, live);
    const hour = new Date(live.startMs).getUTCHours(); // reporting only
    const agg = perHour.get(hour) || { story: 0, filler: 0, other: 0 };
    if (live.kind === 'story') agg.story += live.estSeconds;
    else if (live.kind === 'filler') agg.filler += live.estSeconds;
    else agg.other += live.estSeconds;
    perHour.set(hour, agg);
  }
}
console.log(`walk: ${steps} steps in ${((Date.now() - t0) / 1000).toFixed(1)}s; distinct segments aired: ${airedById.size}`);
const byLink = new Map();
for (const seg of airedById.values()) {
  if (seg.kind !== 'story' || !seg.link) continue;
  if (!byLink.has(seg.link)) byLink.set(seg.link, []);
  byLink.get(seg.link).push(seg);
}
const dupes = [...byLink.entries()].filter(([, v]) => v.length > 1);
check(`zero duplicate story links in the cycle (${byLink.size} distinct stories aired)`, dupes.length === 0,
  dupes.slice(0, 5).map(([l, v]) => `${l} x${v.length}`).join('; '));
for (const [link, v] of dupes.slice(0, 10)) {
  console.log(`  DUPE ${link}`);
  for (const s of v) console.log(`    - [${s.blockKey}] ${s.headline} @ ${new Date(s.startMs).toISOString()}`);
}
console.log('per-hour aired segment-seconds (by segment start, UTC hour):');
for (const [h, agg] of [...perHour.entries()].sort()) {
  console.log(`  ${String(h).padStart(2, '0')}:00Z  story=${agg.story}s filler=${agg.filler}s other=${agg.other}s`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
