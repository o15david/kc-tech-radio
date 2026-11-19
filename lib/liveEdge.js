// ============================================================================
// THE LIVE EDGE — wall-clock-locked playback math.
//
// KC Tech Radio is one constant stream, not a personal queue: every
// listener hears the same segment at the same moment, like a regular
// radio station. This module is the pure, testable core of that model.
// It has no DOM, React, or Node dependencies, so the browser player
// (app/Player.js) and the verification harness (scripts/live-edge-check.mjs)
// run exactly the same code.
//
// The server's schedule is the source of truth. The schedule is a
// CONTINUOUS CHAIN (see lib/format.js): the hour is laid end to end
// between anchors pinned to their wall-clock minutes (:00, :30, :57),
// with blocks drawn to target lengths and shortfalls filled first with
// more stories and only lastly with station material, so segment
// windows tile with no holes. Every playlist segment carries:
//   startMs   — its chained scheduled start epoch: the previous
//               segment's end, counting forward from the hour's anchor
//               at :00 on the Chicago clock.
//   slotEndMs — the NEXT segment's startMs, i.e. the end of this
//               segment's scheduled slot.
//   estSeconds— the word-count duration estimate.
//
// MEASURED REALITY (Nov 19): rendered MP3s run systematically LONGER
// than the word-count estimates (a 38-segment sample averaged 1.12x the
// estimate; the estimate rate in lib/format.js has been recalibrated,
// but a residual error of a few seconds per segment remains, in both
// directions). Two rules follow, and they are the point of this module:
//
//  1. NO SEGMENT IS EVER CUT BY THE SCHEDULE. effectiveTimeline()
//     builds elastic windows within a span: each segment's effective
//     start is its scheduled start shifted by the accumulated
//     (real - estimated) duration delta of the segments ahead of it
//     IN THE SAME SPAN, and its effective end is start + real duration,
//     NEVER capped at slotEndMs. A story that runs 7 seconds long
//     pushes its span-mates 7 seconds later; it is not amputated at
//     its slot boundary. (The old code capped the window at slotEndMs
//     and grouped the delta by block, so the player cut stories at
//     block and slot boundaries, mid-sentence.)
//
//  2. ANCHORS ABSORB THE DRIFT, NOT STORIES. The delta resets at each
//     span's anchor. If accumulated overrun pushes playback past an
//     anchor's pinned minute, the anchor is SKIPPED, never started
//     late (nextInSequence): a time check heard late is a wrong time
//     check, while skipping one costs no story. The span's remaining
//     content butt-joins immediately after the finished segment, so
//     there is no dead air either. Time-speaking filler reached after
//     its spoken minute has passed is skipped for the same reason.
//
// nextPlayable() remains the tune-in / re-anchor rule, applied at
// first play, on resume, and on return to the page (moments when the
// listener is joining the stream, so entering mid-segment is correct):
// the playable segment at time T is the first segment whose effective
// window ends after T and which has not already finished this session.
// Segment TRANSITIONS during playback do NOT use it: they use
// nextInSequence(), which starts the successor at offset 0, always.
// ============================================================================

/**
 * Span layout mirrored from lib/format.js's FORMAT_CLOCK: blockKey ->
 * [blockIndex, anchorBlockIndex]. A span's segments all share one
 * anchor instance: instance numbers are per block airing, so a block's
 * span-anchor instance is its own instance minus its offset within
 * the span. Filler and span-fill segments carry the anchor instance
 * directly in their ids.
 */
const BLOCK_SPAN = {
  'general-news': [0, 0],
  'kc-local': [1, 0],
  'ai-news': [2, 0],
  'station-id': [3, 3],
  'tech-headlines': [4, 3],
  'kc-music': [5, 3],
  'business-headlines': [6, 3],
  'producers-desk': [7, 3],
  'kc-encore': [8, 3],
  'hour-tease': [9, 9],
};

function spanGroupKeyFor(seg) {
  const m = /^seg-(\d+)-/.exec(seg.id || '');
  if (!m) return `solo-${seg.id}`;
  const instance = parseInt(m[1], 10);
  if (seg.blockKey === 'filler' || seg.blockKey === 'span-fill') {
    return `span-${instance}`; // id already carries the anchor instance
  }
  const layout = BLOCK_SPAN[seg.blockKey];
  if (!layout) return `solo-${seg.id}`;
  return `span-${instance - (layout[0] - layout[1])}`;
}

function realSecondsFor(seg, durations) {
  if (!durations) return seg.estSeconds;
  const v =
    typeof durations.get === 'function' ? durations.get(seg.id) : durations[seg.id];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : seg.estSeconds;
}

/**
 * Build effective playback windows for a segment list.
 *
 * @param segments  playlist segments in schedule order
 * @param durations Map or plain object: segment id -> REAL duration in
 *                  seconds (from rendered MP3s). Missing entries fall
 *                  back to the segment's estSeconds.
 * @returns [{ seg, index, startMs, endMs }] in the same order, where
 *          [startMs, endMs) is the segment's effective window: its
 *          scheduled start shifted by the accumulated real-minus-
 *          estimated delta of earlier segments in the same span, and
 *          its end at start + (real or estimated) duration. Windows
 *          are NEVER capped at slotEndMs: a segment occupies its full
 *          real duration. Windows of consecutive spans may overlap
 *          when a span overruns its anchor; that overlap is resolved
 *          by the anchor-skip rule in nextInSequence, not by cutting.
 */
export function effectiveTimeline(segments, durations) {
  const groups = new Map(); // span group key -> accumulated (real - est) ms delta
  return segments.map((seg, index) => {
    const key = spanGroupKeyFor(seg);
    const deltaMs = groups.get(key) || 0;
    const durSec = realSecondsFor(seg, durations);
    const startMs = (seg.startMs || 0) + deltaMs;
    const endMs = startMs + durSec * 1000;
    groups.set(key, deltaMs + (durSec - (seg.estSeconds || 0)) * 1000);
    return { seg, index, startMs, endMs };
  });
}

/**
 * Index of the timeline entry whose effective window contains nowMs,
 * or -1 if nowMs falls in a gap (or outside the loaded schedule).
 * If windows overlap (a span overrunning its anchor), the entry with
 * the greatest startMs wins for display purposes.
 */
export function liveSegmentAt(timeline, nowMs) {
  let best = -1;
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    if (e.startMs <= nowMs && nowMs < e.endMs) {
      if (best === -1 || e.startMs > timeline[best].startMs) best = i;
    }
  }
  return best;
}

/**
 * The tune-in / re-anchor decision for time nowMs. Used when JOINING
 * the stream (first play, resume, return to page), never for a
 * transition between two playing segments (see nextInSequence).
 *
 * @param timeline    from effectiveTimeline()
 * @param nowMs       wall clock, epoch ms
 * @param finishedIds Set of segment ids that already finished playing
 *                    this session (may be null/undefined). A finished
 *                    segment is never re-entered, even if the wall
 *                    clock is still inside its window.
 * @returns one of:
 *   { type: 'segment', index, offsetMs } — play timeline[index].seg,
 *       starting offsetMs into it (its window contains nowMs).
 *   { type: 'gap', index, waitMs } — nothing is scheduled at nowMs;
 *       timeline[index].seg starts in waitMs. Wait for it.
 *   { type: 'ended' } — the loaded schedule is exhausted at nowMs;
 *       refetch the playlist.
 */
export function nextPlayable(timeline, nowMs, finishedIds) {
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    if (e.endMs <= nowMs) continue; // window fully past
    if (finishedIds && finishedIds.has(e.seg.id)) continue; // already aired here
    if (e.startMs <= nowMs) {
      return { type: 'segment', index: i, offsetMs: nowMs - e.startMs };
    }
    return { type: 'gap', index: i, waitMs: e.startMs - nowMs };
  }
  return { type: 'ended' };
}

/** True for the segments that pin a span: they speak a time and must
 *  start on their exact minute or not at all. */
export function isAnchorSegment(seg) {
  return (
    seg.blockKey === 'station-id' ||
    seg.blockKey === 'hour-tease' ||
    (seg.blockKey === 'general-news' && seg.kind === 'intro')
  );
}

const TIME_PHRASE = /It is \d{1,2}(:\d{2})? [AP]M/;

/** True if the segment's script speaks a clock time. */
export function isTimeSpeaking(seg) {
  return typeof seg.script === 'string' && TIME_PHRASE.test(seg.script);
}

const chicagoMinuteFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

/** True if two epochs fall in the same America/Chicago minute. */
export function sameChicagoMinute(aMs, bMs) {
  return chicagoMinuteFmt.format(new Date(aMs)) === chicagoMinuteFmt.format(new Date(bMs));
}

/**
 * The TRANSITION decision: the segment that just finished playing is
 * at timeline[afterIndex]; what plays next, starting at offset 0?
 * This is the no-cut rule in code form:
 *  - Segments play in schedule order, each from its beginning, each
 *    to its natural end. A successor is never entered mid-way, so a
 *    story can never lose its beginning or its end to drift.
 *  - An anchor reached more than ~2s after its pinned start is
 *    SKIPPED (reported in `skipped`): it is never aired late. Its
 *    span's content follows immediately, butt-joined, so skipping
 *    opens no gap.
 *  - A time-speaking non-anchor (filler time checks) reached after
 *    its spoken minute has passed is likewise skipped; reached more
 *    than ~2s BEFORE its start, playback waits for its true start
 *    rather than speaking a future time early.
 *  - An anchor in the future means the span's content ran short:
 *    wait for the anchor's minute (type 'wait').
 *
 * @returns one of:
 *   { type: 'segment', index, skipped } — play timeline[index] from 0.
 *   { type: 'wait', index, waitMs, skipped } — timeline[index] is an
 *       anchor (or time-speaker) starting in waitMs; wait for it.
 *   { type: 'ended', skipped } — nothing left in the loaded schedule.
 */
export function nextInSequence(timeline, afterIndex, finishedIds, nowMs) {
  const skipped = [];
  for (let i = afterIndex + 1; i < timeline.length; i++) {
    const e = timeline[i];
    if (finishedIds && finishedIds.has(e.seg.id)) continue;
    if (isAnchorSegment(e.seg)) {
      if (nowMs > e.seg.startMs + 2000) {
        skipped.push(e.seg.id); // stale anchor: never aired late
        continue;
      }
      if (e.seg.startMs > nowMs + 2000) {
        return { type: 'wait', index: i, waitMs: e.seg.startMs - nowMs, skipped };
      }
      return { type: 'segment', index: i, skipped };
    }
    if (isTimeSpeaking(e.seg)) {
      if (e.seg.startMs <= nowMs && !sameChicagoMinute(e.seg.startMs, nowMs)) {
        skipped.push(e.seg.id); // its spoken minute is already gone
        continue;
      }
      if (e.seg.startMs > nowMs + 2000) {
        return { type: 'wait', index: i, waitMs: e.seg.startMs - nowMs, skipped };
      }
    }
    return { type: 'segment', index: i, skipped };
  }
  return { type: 'ended', skipped };
}
