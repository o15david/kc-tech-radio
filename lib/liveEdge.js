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
// The server's schedule is the source of truth. Every playlist segment
// carries:
//   startMs   — its scheduled start epoch: its block instance's true
//               Chicago start plus the ESTIMATED durations ahead of it
//               in the block (see lib/format.js).
//   slotEndMs — the scheduled start of the NEXT block instance, i.e. the
//               hard end of this segment's block slot. A block never runs
//               past it: on a real station the next show starts on time.
//   estSeconds— the word-count duration estimate.
//
// effectiveTimeline() turns a segment list into effective windows:
// within a block instance, segments tile back-to-back from the block's
// anchor, but each segment's effective start is its server startMs
// adjusted by the accumulated (real - estimated) duration delta of the
// segments ahead of it in the same block. Real durations come from the
// rendered MP3s (the player learns them from the audio elements / the
// /api/audio duration header); until a real duration is known, the
// estimate stands in. A segment's effective window is capped at its
// block's slotEndMs, so an overrunning block is cut by the schedule
// instead of spilling into the next show.
//
// nextPlayable() is the tune-in / re-anchor rule, applied identically at
// first play, on return to the page, on resume, and at every segment
// transition: the playable segment at time T is the first segment (in
// schedule order) whose effective window ends after T and which has not
// already finished playing this session. If T is inside its window, it
// plays from offset (T - window start); if T is before it (a gap between
// blocks, where the schedule itself is quiet), the player waits for its
// start. Because a segment is only ever entered inside its own window,
// a segment that announces a time can only be heard when that time is
// actually true — spoken times are correct by construction.
// ============================================================================

/**
 * Group key for one block airing. Segment ids are `seg-<instance>-...`
 * where instance = absHour * FORMAT_CLOCK.length + blockIndex, unique
 * per block airing. Anything else (the wire-failure filler) is its own
 * group.
 */
function groupKeyFor(seg) {
  const m = /^seg-(\d+)-/.exec(seg.id || '');
  return m ? `inst-${m[1]}` : `solo-${seg.id}`;
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
 *          [startMs, endMs) is the segment's effective window on the
 *          wall clock. Windows tile within a block, never cross the
 *          block's slotEndMs, and may be empty (endMs <= startMs) for
 *          segments the schedule has fully cut.
 */
export function effectiveTimeline(segments, durations) {
  const groups = new Map(); // groupKey -> accumulated (real - est) ms delta
  return segments.map((seg, index) => {
    const key = groupKeyFor(seg);
    const deltaMs = groups.get(key) || 0;
    const realSec = realSecondsFor(seg, durations);
    const startMs = (seg.startMs || 0) + deltaMs;
    const cap = typeof seg.slotEndMs === 'number' ? seg.slotEndMs : Infinity;
    const endMs = Math.min(startMs + realSec * 1000, cap);
    groups.set(key, deltaMs + (realSec - (seg.estSeconds || 0)) * 1000);
    return { seg, index, startMs, endMs };
  });
}

/**
 * Index of the timeline entry whose effective window contains nowMs,
 * or -1 if nowMs falls in a gap (or outside the loaded schedule).
 * Windows are disjoint by construction; if pathological input ever
 * overlaps them, the entry with the greatest startMs wins (the later
 * scheduled segment is the live one).
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
 * The tune-in / re-anchor decision for time nowMs.
 *
 * @param timeline    from effectiveTimeline()
 * @param nowMs       wall clock, epoch ms
 * @param finishedIds Set of segment ids that already finished playing
 *                    this session (may be null/undefined). A finished
 *                    segment is never re-entered, even if the wall clock
 *                    is still inside its window (e.g. it was played at a
 *                    faster voice rate): playback moves to the next
 *                    segment on the schedule instead of repeating it.
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
    if (e.endMs <= nowMs) continue; // window fully past (or cut by the schedule)
    if (finishedIds && finishedIds.has(e.seg.id)) continue; // already aired here
    if (e.startMs <= nowMs) {
      return { type: 'segment', index: i, offsetMs: nowMs - e.startMs };
    }
    return { type: 'gap', index: i, waitMs: e.startMs - nowMs };
  }
  return { type: 'ended' };
}
