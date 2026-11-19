'use client';

// KC Tech Radio browser player — a WALL-CLOCK-LOCKED live stream.
//
// This is one constant stream, not a personal queue: every listener hears
// the same segment at the same moment, like a regular radio station. The
// server's schedule (each segment's startMs on the America/Chicago clock,
// see lib/format.js) is the source of truth, and lib/liveEdge.js turns it
// into effective windows using REAL MP3 durations (learned from the audio
// elements and the /api/audio duration header) with word-count estimates
// as fallback only.
//
// The rules:
//  - TUNE-IN AT THE LIVE EDGE. Play, a return to the page, and a resume
//    all find the segment whose scheduled window contains NOW and start
//    it at offset (now - window start) via currentTime. Nobody ever
//    hears the queue from the top, and a returning listener lands on
//    whatever is live then, never on a replay.
//  - A PLAYING SEGMENT IS NEVER CUT. Rendered MP3s run a few seconds
//    longer or shorter than the schedule's word-count estimates, so
//    transitions do NOT consult the wall clock: when a segment ends
//    naturally, its successor starts at offset 0 (nextInSequence in
//    lib/liveEdge.js) and plays to its own natural end. Anchors absorb
//    the accumulated drift: an anchor reached after its pinned minute
//    is skipped rather than aired late, and its span's content
//    butt-joins with no gap. (The previous design re-anchored at every
//    transition and cut stories mid-sentence at their slot ends; it
//    also abandoned segments whose MP3 was still loading when their
//    estimated window passed, which listeners heard as silence.)
//  - NO SILENT FAILURE. Cold /api/audio renders take seconds and
//    occasionally far longer, so the player warms several minutes of
//    audio ahead, and a stall watchdog watches for an audio element
//    that stops progressing: it nudges play(), reloads the segment
//    once (the render it triggered is usually cached by then), and
//    finally falls back to speechSynthesis for that segment. Silence
//    is never the failure mode.
//  - GAPS SHOULD NOT EXIST. The server schedule is a continuous chain
//    (blocks drawn to target lengths, shortfalls filled first with
//    more stories and only lastly with station material, anchors
//    pinned at :00/:30/:57), so segment windows tile with no holes.
//    The wait-for-the-next-start path below remains as a safety net:
//    if a gap ever does appear, the player waits for the next
//    segment's true start rather than starting it early, because a
//    segment that announces a time is only ever heard inside its true
//    window, so spoken times stay correct by construction.
//  - PAUSE IS A DELIBERATE HOLD. It freezes the output where it is; on
//    resume the player re-anchors to the live edge (you rejoin the
//    stream, you do not catch up on what aired while you were gone).
//  - AUDIO FAILURE IS PER-SEGMENT. If a segment's MP3 fails, that one
//    segment falls back to the browser's speechSynthesis (sentence-
//    chunked, since long utterances stall Chrome) and the next segment
//    re-anchors and tries MP3 again.
//
// Backstops kept from the queue era: the server's no-repeat rotation is
// untouched, and the player still records played segment ids and played
// story keys so a refill can never re-queue them this session. They now
// guard edge cases (and the speech fallback, which cannot seek), while
// the live-edge model is the primary mechanism.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  effectiveTimeline,
  liveSegmentAt,
  nextPlayable,
  nextInSequence,
} from '../lib/liveEdge';

const REFILL_THRESHOLD_SECONDS = 300; // refetch when the loaded schedule runs out within 5 min
// Warming depth, in seconds of audio ahead of the playhead (with a
// segment-count cap). Cold /api/audio renders measured ~5s each in
// good conditions but tens of seconds (or an outright failure) in bad
// ones, and the previous depth of 4 short segments was under a minute
// of runway: a slow render at the playhead meant silence. Five
// minutes of runway absorbs realistic render latency.
const WARM_AHEAD_SECONDS = 300;
const WARM_AHEAD_MAX = 24;
const STALL_LIMIT_MS = 8000; // no audio progress for this long = stalled
const TIME_ZONE = 'America/Chicago';

/** Split a script into speakable chunks of at most ~180 chars, by sentence. */
function chunkScript(script) {
  const sentences = script.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [script];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > 180 && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() || [];
  return (
    voices.find((v) => v.name === 'Google US English') ||
    voices.find((v) => v.lang === 'en-US' && v.default) ||
    voices.find((v) => v.lang?.startsWith('en')) ||
    null
  );
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function Player() {
  const [status, setStatus] = useState('loading'); // loading|ready|playing|paused|error
  const [nowPlaying, setNowPlaying] = useState(null); // segment on air (or live right now, pre-play)
  const [standby, setStandby] = useState(null); // { seg, atMs } when the live edge is in a schedule gap
  const [queueView, setQueueView] = useState([]); // segments from the live position onward
  const [bufferSeconds, setBufferSeconds] = useState(0);
  const [health, setHealth] = useState(null);
  const [clock, setClock] = useState('');
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [voiceLabel, setVoiceLabel] = useState('Edge neural TTS');

  const queueRef = useRef([]);
  const seenIdsRef = useRef(new Set()); // every segment id ever queued
  const playedIdsRef = useRef(new Set()); // ids that started playing (refill backstop)
  const playedStoryKeysRef = useRef(new Set()); // link/headline of played stories (backstop)
  const finishedIdsRef = useRef(new Set()); // ids that finished: never re-entered (liveEdge)
  const durationsRef = useRef(new Map()); // segment id -> real MP3 seconds
  const playingRef = useRef(false); // stream is ON (sounding or waiting out a gap)
  const rateRef = useRef(1);
  const volumeRef = useRef(1);
  const voiceRef = useRef(null); // browser fallback voice
  const fetchingRef = useRef(false);
  const startedRef = useRef(false);
  const currentIdRef = useRef(null); // segment currently sounding, or null
  const currentIndexRef = useRef(-1); // its index in queueRef (transitions are sequential)
  const stallRef = useRef({ id: null, lastSample: 0, since: 0, recoveries: 0 }); // stall watchdog state
  const displayIdRef = useRef(null); // segment id currently shown as live (pre-play display)
  const audioRef = useRef(null); // main MP3 element
  const preloadRef = useRef(null); // next-segment MP3 preload element
  const modeRef = useRef(null); // 'audio' | 'speech' | null (current segment)
  const gapTimerRef = useRef(null);
  const speechGenRef = useRef(0); // bumped whenever speech is superseded/cancelled

  const timeline = useCallback(
    () => effectiveTimeline(queueRef.current, durationsRef.current),
    []
  );

  // ---- clock -------------------------------------------------------------
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    const tick = () => setClock(`${fmt.format(new Date())} CT`);
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- browser fallback voice ----------------------------------------------
  useEffect(() => {
    const load = () => {
      voiceRef.current = pickVoice();
    };
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, []);

  // ---- view sync -------------------------------------------------------------
  // The view always reflects the LIVE position: what is on air now (or,
  // in a schedule gap, what comes next and when), never a personal queue
  // position.
  const syncView = useCallback(
    (fromIndex, tl) => {
      const t = tl || timeline();
      setQueueView(queueRef.current.slice(fromIndex, fromIndex + 9));
      const last = t[t.length - 1];
      setBufferSeconds(
        last ? Math.max(0, Math.round((last.endMs - Date.now()) / 1000)) : 0
      );
    },
    [timeline]
  );

  // Pre-play / paused display: show the segment that is live right now.
  const refreshLiveDisplay = useCallback(() => {
    if (playingRef.current) return;
    const tl = timeline();
    if (!tl.length) return;
    const pos = nextPlayable(tl, Date.now(), finishedIdsRef.current);
    if (pos.type === 'ended') return;
    const entry = tl[pos.index];
    if (!entry) return;
    if (displayIdRef.current !== entry.seg.id) {
      displayIdRef.current = entry.seg.id;
      if (pos.type === 'segment') {
        setNowPlaying(entry.seg);
        setStandby(null);
      } else {
        setNowPlaying(null);
        setStandby({ seg: entry.seg, atMs: entry.startMs });
      }
    }
    syncView(pos.index, tl);
  }, [syncView, timeline]);

  // ---- playlist fetching -----------------------------------------------------
  // Identity of a story segment independent of its segment id: if a pool
  // refresh reassigns slots, the same story can come back wearing a new
  // segment id, but its link (or headline) gives it away.
  const storyKey = useCallback((seg) => {
    if (seg.kind !== 'story') return null;
    return seg.link || seg.headline || seg.id;
  }, []);

  // Drop whole blocks whose slot has fully passed (the tab sat open for
  // hours). The segment currently sounding is protected. Pruned ids stay
  // in seenIds, so a later refill cannot resurrect them.
  const pruneQueue = useCallback(() => {
    const nowMs = Date.now();
    queueRef.current = queueRef.current.filter(
      (seg) =>
        seg.id === currentIdRef.current || !seg.slotEndMs || seg.slotEndMs > nowMs
    );
  }, []);

  const fetchPlaylist = useCallback(async () => {
    if (fetchingRef.current) return 0;
    fetchingRef.current = true;
    try {
      pruneQueue();
      const res = await fetch('/api/playlist', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const nowMs = Date.now();
      let added = 0;
      for (const seg of data.segments) {
        // Never re-queue: already queued, already played, or the same
        // story under a new segment id.
        if (seenIdsRef.current.has(seg.id)) continue;
        if (playedIdsRef.current.has(seg.id)) continue;
        const key = storyKey(seg);
        if (key && playedStoryKeysRef.current.has(key)) continue;
        // Never append a segment whose slot has already ended.
        if (seg.slotEndMs && seg.slotEndMs <= nowMs) continue;
        seenIdsRef.current.add(seg.id);
        queueRef.current.push(seg);
        added++;
      }
      if (added) {
        warmDurationsRef.current?.();
        if (playingRef.current) syncViewRef.current?.();
        else refreshLiveDisplay();
      }
      return added;
    } catch {
      return 0;
    } finally {
      fetchingRef.current = false;
    }
  }, [pruneQueue, refreshLiveDisplay, storyKey]);

  // Initial queue load (so the live segment and Up Next show before Play).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    fetchPlaylist().then(() => {
      refreshLiveDisplay();
      setStatus((s) => (s === 'loading' ? 'ready' : s));
    });
  }, [fetchPlaylist, refreshLiveDisplay]);

  // Keep the pre-play display honest as the clock moves.
  useEffect(() => {
    const t = setInterval(refreshLiveDisplay, 5000);
    return () => clearInterval(t);
  }, [refreshLiveDisplay]);

  // ---- health footer -----------------------------------------------------------
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) setHealth(await res.json());
      } catch {
        /* footer is informational only */
      }
    };
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  // ---- audio elements ---------------------------------------------------------
  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'auto';
    }
    return audioRef.current;
  }, []);

  const getPreload = useCallback(() => {
    if (!preloadRef.current) {
      preloadRef.current = new Audio();
      preloadRef.current.preload = 'auto';
    }
    return preloadRef.current;
  }, []);

  const noteDuration = useCallback((segId, seconds) => {
    if (segId && Number.isFinite(seconds) && seconds > 0) {
      durationsRef.current.set(segId, seconds);
    }
  }, []);

  // Learn real durations ahead of the playhead AND trigger the
  // server-side renders before the playhead arrives: HEAD each upcoming
  // segment's audioUrl (the route renders on HEAD exactly as on GET,
  // so the MP3 is cached server-side and CDN-side by the time it is
  // needed) and read the duration header. Depth is measured in seconds
  // of audio, not segment count: short segments used to give under a
  // minute of runway against multi-second cold renders.
  const warmDurations = useCallback(
    (fromIndex = 0) => {
      const q = queueRef.current;
      let seconds = 0;
      let count = 0;
      for (let i = fromIndex; i < q.length && count < WARM_AHEAD_MAX; i++) {
        const seg = q[i];
        if (!seg) break;
        seconds += seg.estSeconds || 0;
        count++;
        if (seconds >= WARM_AHEAD_SECONDS && count >= 2) break;
        if (!seg.audioUrl || durationsRef.current.has(seg.id)) continue;
        fetch(seg.audioUrl, { method: 'HEAD' })
          .then((res) => {
            const d = parseFloat(res.headers.get('x-audio-duration-seconds'));
            if (Number.isFinite(d)) noteDuration(seg.id, d);
          })
          .catch(() => {
            /* estimates remain the fallback; the stall ladder covers a slow render */
          });
      }
    },
    [noteDuration]
  );
  const warmDurationsRef = useRef(null);
  useEffect(() => {
    warmDurationsRef.current = warmDurations;
  }, [warmDurations]);

  // Start downloading the next segment's MP3 while the current one plays,
  // and record its real duration when the metadata lands.
  const preloadNext = useCallback(
    (index) => {
      const next = queueRef.current[index + 1];
      if (!next?.audioUrl) return;
      const pre = getPreload();
      const target = new URL(next.audioUrl, window.location.origin).href;
      pre.onloadedmetadata = () => noteDuration(next.id, pre.duration);
      if (pre.src !== target) {
        pre.src = next.audioUrl;
        pre.load();
      }
      warmDurations(index + 1);
    },
    [getPreload, noteDuration, warmDurations]
  );

  // ---- playback engine -----------------------------------------------------------
  // Defined with refs so the anchor chain never goes stale.
  const anchorRef = useRef(null);
  const sequentialRef = useRef(null);
  const syncViewRef = useRef(null);

  const clearGapTimer = useCallback(() => {
    if (gapTimerRef.current) {
      clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
    }
  }, []);

  const haltOutput = useCallback(() => {
    if (audioRef.current) audioRef.current.pause();
    speechGenRef.current += 1; // any in-flight fallback speech is now stale
    window.speechSynthesis?.cancel();
    modeRef.current = null;
  }, []);

  const speakSegment = useCallback((seg, onDone) => {
    const synth = window.speechSynthesis;
    if (!synth) {
      onDone();
      return;
    }
    // Supersede anything the fallback voice was still saying (e.g. a
    // segment held by Pause): a re-anchor must never talk over itself.
    speechGenRef.current += 1;
    const gen = speechGenRef.current;
    synth.cancel();
    modeRef.current = 'speech';
    setVoiceLabel(`browser voice (${voiceRef.current?.name || 'default'}) · fallback`);
    const chunks = chunkScript(seg.script);
    let chunkIdx = 0;
    const speakChunk = () => {
      if (!playingRef.current || gen !== speechGenRef.current) return;
      if (chunkIdx >= chunks.length) {
        onDone();
        return;
      }
      const utter = new SpeechSynthesisUtterance(chunks[chunkIdx]);
      if (voiceRef.current) utter.voice = voiceRef.current;
      utter.rate = rateRef.current;
      utter.volume = volumeRef.current;
      utter.onend = () => {
        chunkIdx += 1;
        speakChunk();
      };
      utter.onerror = () => {
        // A single bad utterance must not kill the stream.
        chunkIdx += 1;
        speakChunk();
      };
      synth.speak(utter);
    };
    speakChunk();
  }, []);

  const finishSegment = useCallback((seg) => {
    finishedIdsRef.current.add(seg.id);
    if (currentIdRef.current === seg.id) currentIdRef.current = null;
    modeRef.current = null;
    // TRANSITIONS ARE SEQUENTIAL, never wall-clock re-anchors: the
    // successor starts at offset 0 and plays to its natural end, so a
    // segment can never be cut at its estimated slot end. Anchors
    // absorb the drift inside nextInSequence (a stale anchor is
    // skipped; its span's content butt-joins). The wall-clock anchor
    // path runs only when the loaded sequence is exhausted (refill)
    // or when joining the stream (play / resume / return).
    sequentialRef.current?.(currentIndexRef.current);
  }, []);

  const startSegment = useCallback(
    (tl, index, offsetMs) => {
      const seg = tl[index].seg;
      currentIdRef.current = seg.id;
      currentIndexRef.current = index;
      stallRef.current = { id: seg.id, lastSample: 0, since: Date.now(), recoveries: 0 };
      displayIdRef.current = seg.id;
      // Session no-repeat backstops: once a segment starts, neither it
      // nor its story (under any segment id) can be queued again.
      playedIdsRef.current.add(seg.id);
      const playedKey = storyKey(seg);
      if (playedKey) playedStoryKeysRef.current.add(playedKey);
      setNowPlaying(seg);
      setStandby(null);
      syncView(index, tl);
      preloadNext(index);

      if (!seg.audioUrl) {
        speakSegment(seg, () => finishSegment(seg));
        return;
      }

      // Primary path: the pre-rendered MP3, entered at the live offset.
      modeRef.current = 'audio';
      setVoiceLabel(seg.voice ? `${seg.voice} · Edge neural` : 'Edge neural TTS');
      const audio = getAudio();
      let fellBack = false;
      const fallBack = () => {
        if (fellBack || !playingRef.current) return;
        fellBack = true;
        // Fall back for THIS segment only; the next transition re-anchors
        // and tries MP3 again. Speech cannot seek, so the fallback reads
        // the segment from its top.
        if (currentIdRef.current === seg.id) {
          speakSegment(seg, () => finishSegment(seg));
        }
      };
      audio.onended = () => {
        if (playingRef.current && currentIdRef.current === seg.id) {
          finishSegment(seg);
        }
      };
      audio.ontimeupdate = () => {
        // Stall watchdog evidence: the last position the audio
        // element actually reached. A loading or stalled MP3 leaves
        // this frozen while the wall clock (and the old watchdog)
        // marched on.
        if (currentIdRef.current === seg.id) {
          stallRef.current.lastSample = audio.currentTime || 0;
        }
      };
      audio.onerror = fallBack;
      audio.onloadedmetadata = () => {
        noteDuration(seg.id, audio.duration);
        // Tune in at the live edge: jump to (now - window start).
        if (offsetMs > 400 && Number.isFinite(audio.duration)) {
          try {
            audio.currentTime = Math.min(offsetMs / 1000, audio.duration);
          } catch {
            /* a failed seek self-corrects at the next re-anchor */
          }
        }
      };
      audio.playbackRate = rateRef.current;
      audio.volume = volumeRef.current;
      audio.src = seg.audioUrl;
      audio.play().catch(fallBack);
    },
    [finishSegment, getAudio, noteDuration, preloadNext, speakSegment, storyKey, syncView]
  );

  // THE SEQUENCE: advance from the segment that just finished to its
  // successor, which always starts at offset 0 (see nextInSequence).
  // A successor that is an anchor still in the future is waited for;
  // stale anchors and stale time checks are skipped inside
  // nextInSequence and recorded as finished so nothing resurrects
  // them. Only an exhausted sequence falls through to the wall-clock
  // anchor path, which refills the playlist.
  const advanceSequential = useCallback(
    (fromIndex) => {
      if (!playingRef.current) return;
      const tl = timeline();
      const nxt = nextInSequence(tl, fromIndex, finishedIdsRef.current, Date.now());
      for (const id of nxt.skipped || []) finishedIdsRef.current.add(id);
      if (nxt.type === 'segment') {
        startSegment(tl, nxt.index, 0);
        return;
      }
      if (nxt.type === 'wait') {
        const entry = tl[nxt.index];
        currentIdRef.current = null;
        displayIdRef.current = entry.seg.id;
        setNowPlaying(null);
        setStandby({ seg: entry.seg, atMs: entry.seg.startMs });
        syncView(nxt.index, tl);
        gapTimerRef.current = setTimeout(
          () => {
            if (!playingRef.current) return;
            const tl2 = timeline();
            const idx = tl2.findIndex((e) => e.seg.id === entry.seg.id);
            if (idx >= 0) startSegment(tl2, idx, 0);
            else sequentialRef.current?.(fromIndex);
          },
          Math.max(0, nxt.waitMs) + 30
        );
        return;
      }
      anchorRef.current?.();
    },
    [startSegment, syncView, timeline]
  );

  useEffect(() => {
    sequentialRef.current = advanceSequential;
  }, [advanceSequential]);

  // THE ANCHOR: recompute the live position from the wall clock and put
  // playback there. Called when JOINING the stream (tune-in, resume,
  // return to the page) and to refill an exhausted sequence. It must
  // never interrupt a segment that is sounding: transitions belong to
  // the sequence above.
  const anchorPlayback = useCallback(() => {
    if (!playingRef.current) return;
    if (
      currentIdRef.current &&
      modeRef.current === 'audio' &&
      audioRef.current &&
      !audioRef.current.paused &&
      !audioRef.current.ended
    ) {
      return; // a segment is sounding; the sequence owns transitions
    }
    clearGapTimer();
    pruneQueue();
    const tl = timeline();
    const nowMs = Date.now();
    const pos = nextPlayable(tl, nowMs, finishedIdsRef.current);

    if (pos.type === 'ended') {
      // The loaded schedule is exhausted: refill, then anchor again. If
      // nothing new arrives, the stream stops cleanly rather than
      // replaying anything.
      fetchPlaylist().then((added) => {
        if (!playingRef.current) return;
        if (added) anchorRef.current?.();
        else {
          playingRef.current = false;
          currentIdRef.current = null;
          setStatus('ready');
          refreshLiveDisplay();
        }
      });
      return;
    }

    const entry = tl[pos.index];

    if (pos.type === 'gap') {
      // The schedule itself is quiet right now. Wait for the next
      // segment's true start instead of airing it early.
      currentIdRef.current = null;
      haltOutput();
      displayIdRef.current = entry.seg.id;
      setNowPlaying(null);
      setStandby({ seg: entry.seg, atMs: entry.startMs });
      syncView(pos.index, tl);
      gapTimerRef.current = setTimeout(
        () => anchorRef.current?.(),
        Math.max(0, pos.waitMs) + 60
      );
      // Keep the schedule loaded ahead while we wait.
      const last = tl[tl.length - 1];
      if (last && last.endMs - nowMs < REFILL_THRESHOLD_SECONDS * 1000) {
        fetchPlaylist();
      }
      return;
    }

    startSegment(tl, pos.index, pos.offsetMs);

    // Keep the buffer ahead of the live edge.
    const last = tl[tl.length - 1];
    if (last && last.endMs - nowMs < REFILL_THRESHOLD_SECONDS * 1000) {
      fetchPlaylist();
    }
  }, [
    clearGapTimer,
    fetchPlaylist,
    haltOutput,
    pruneQueue,
    refreshLiveDisplay,
    startSegment,
    syncView,
    timeline,
  ]);

  useEffect(() => {
    anchorRef.current = anchorPlayback;
  }, [anchorPlayback]);
  useEffect(() => {
    syncViewRef.current = () => {
      const tl = timeline();
      const idx = liveSegmentAt(tl, Date.now());
      syncView(idx >= 0 ? idx : 0, tl);
    };
  }, [syncView, timeline]);

  // Stall watchdog. The old drift watchdog compared the audio against
  // the segment's estimated window and re-anchored when the window
  // passed: that is what cut stories mid-sentence (real MP3s run
  // longer than estimates) and what abandoned segments whose MP3 was
  // still rendering when their window passed (heard as silence). This
  // watchdog never touches a progressing segment. It watches for the
  // one failure that produces silence: an audio element that has
  // stopped progressing (a slow cold render, a stalled fetch: no
  // 'error' event, no 'ended', currentTime frozen). Recovery ladder,
  // one rung per stall period: (1) nudge play(); (2) reload the
  // segment and seek back to the last heard position (the first
  // attempt usually triggered the server render, so the reload is a
  // cache hit); (3) fall back to speechSynthesis for this segment.
  // The ladder always ends in sound or in the sequence advancing.
  useEffect(() => {
    const t = setInterval(() => {
      if (!playingRef.current || !currentIdRef.current) return;
      if (modeRef.current !== 'audio' || !audioRef.current) return;
      const audio = audioRef.current;
      if (audio.ended) return;
      const stall = stallRef.current;
      if (stall.id !== currentIdRef.current) return;
      if (audio.paused) {
        // A browser-side pause we did not ask for (autoplay policy,
        // interruption): try to resume rather than sit silent.
        if (audio.readyState >= 2) audio.play().catch(() => {});
        return;
      }
      const cur = audio.currentTime || 0;
      if (cur > stall.lastSample + 0.2) {
        stall.lastSample = cur;
        stall.since = Date.now();
        stall.recoveries = 0;
        return;
      }
      if (Date.now() - stall.since < STALL_LIMIT_MS) return;
      // Stalled: no progress for STALL_LIMIT_MS while supposedly playing.
      stall.since = Date.now();
      stall.recoveries += 1;
      const seg = queueRef.current.find((s) => s.id === currentIdRef.current);
      if (stall.recoveries === 1) {
        audio.play().catch(() => {});
      } else if (stall.recoveries === 2 && seg?.audioUrl) {
        const resumeAt = stall.lastSample;
        audio.src = seg.audioUrl;
        audio.onloadedmetadata = () => {
          noteDuration(seg.id, audio.duration);
          try {
            audio.currentTime = resumeAt;
          } catch {
            /* resume from the top of the segment if the seek fails */
          }
        };
        audio.load();
        audio.play().catch(() => {});
      } else if (seg) {
        // The MP3 cannot be delivered in time: the browser voice reads
        // this segment (from its top; speech cannot seek) and the
        // sequence moves on. Degraded voice beats silence.
        modeRef.current = 'speech';
        speakSegment(seg, () => finishSegment(seg));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [finishSegment, noteDuration, speakSegment]);

  // Returning to the page: if a segment is sounding, leave it alone
  // (re-anchoring used to cut it). Only a stream whose output actually
  // stopped while backgrounded re-anchors to the live edge.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible' || !playingRef.current) return;
      if (
        modeRef.current === 'audio' &&
        audioRef.current &&
        !audioRef.current.paused &&
        !audioRef.current.ended
      ) {
        return;
      }
      anchorRef.current?.();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Chrome desktop can silently stall long speech sessions; nudge resume()
  // while the fallback voice is speaking (a well-known workaround).
  useEffect(() => {
    const t = setInterval(() => {
      if (
        playingRef.current &&
        modeRef.current === 'speech' &&
        window.speechSynthesis?.speaking
      ) {
        window.speechSynthesis.resume();
      }
    }, 5000);
    return () => clearInterval(t);
  }, []);

  // ---- controls ---------------------------------------------------------------------
  const onPlay = async () => {
    if (!queueRef.current.length) await fetchPlaylist();
    pruneQueue();
    const tl = timeline();
    const last = tl[tl.length - 1];
    if (!last || last.endMs - Date.now() < REFILL_THRESHOLD_SECONDS * 1000) {
      await fetchPlaylist();
    }
    playingRef.current = true;
    setStatus('playing');
    // Tune in at the live edge — always. Play, resume after pause, and
    // restart after Stop all land on whatever is live right now.
    anchorPlayback();
  };

  const onPause = () => {
    // A deliberate hold: freeze the output. The wall clock keeps moving;
    // resume re-anchors to the live edge rather than catching up.
    playingRef.current = false;
    clearGapTimer();
    setStatus('paused');
    if (modeRef.current === 'audio') audioRef.current?.pause();
    else window.speechSynthesis?.pause();
    modeRef.current = null;
  };

  const onStop = () => {
    playingRef.current = false;
    clearGapTimer();
    currentIdRef.current = null;
    haltOutput();
    setStatus('ready');
    refreshLiveDisplay();
  };

  useEffect(() => {
    rateRef.current = rate;
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    volumeRef.current = volume;
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(
    () => () => {
      window.speechSynthesis?.cancel();
      audioRef.current?.pause();
      preloadRef.current?.pause();
    },
    []
  );

  const upcoming = queueView.slice(1);

  return (
    <div className="station">
      <header className="masthead">
        <div>
          <h1>KC Tech Radio</h1>
          <p className="tagline">
            Kansas City tech &amp; business · AI news · world news on the hour
          </p>
        </div>
        <div className="clock" aria-label="Kansas City time">
          {clock}
          <span className={`live-dot ${status === 'playing' ? 'on' : ''}`}>
            {status === 'playing' ? 'ON AIR' : 'STANDBY'}
          </span>
        </div>
      </header>

      <section className="deck">
        <div className="transport">
          {status !== 'playing' ? (
            <button className="play-btn" onClick={onPlay} disabled={status === 'loading'}>
              ▶ Play
            </button>
          ) : (
            <button className="play-btn" onClick={onPause}>
              ❚❚ Pause
            </button>
          )}
          <button className="stop-btn" onClick={onStop} disabled={status === 'loading'}>
            ■ Stop
          </button>
        </div>

        <div className="sliders">
          <label>
            Volume
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
            />
          </label>
          <label>
            Voice rate
            <select value={rate} onChange={(e) => setRate(parseFloat(e.target.value))}>
              <option value={0.85}>0.85×</option>
              <option value={1}>1.0×</option>
              <option value={1.15}>1.15×</option>
              <option value={1.3}>1.3×</option>
            </select>
          </label>
          <span className="buffer" title="How far ahead the live schedule is loaded">
            Buffer: {(bufferSeconds / 60).toFixed(1)} min
          </span>
        </div>
      </section>

      <section className="now-playing">
        <h2>Now Playing</h2>
        {nowPlaying ? (
          <>
            <p className="np-title">{nowPlaying.title}</p>
            <p className="np-headline">{nowPlaying.headline}</p>
            <p className="np-meta">
              {nowPlaying.category} · {nowPlaying.source} · ~
              {Math.round(nowPlaying.estSeconds)}s
            </p>
          </>
        ) : standby ? (
          <>
            <p className="np-title">{standby.seg.title}</p>
            <p className="np-headline">{standby.seg.headline}</p>
            <p className="np-meta">
              On air at {clockTime(standby.atMs)} CT · the live stream resumes with the
              next scheduled block
            </p>
          </>
        ) : (
          <p className="np-headline">Loading the wire…</p>
        )}
      </section>

      <div className="columns">
        <section className="up-next">
          <h2>Up Next</h2>
          {upcoming.length ? (
            <ol>
              {upcoming.map((seg) => (
                <li key={seg.id}>
                  <span className="un-title">{seg.title}</span>
                  <span className="un-headline">{seg.headline}</span>
                  <span className="un-meta">
                    {seg.category} · ~{Math.round(seg.estSeconds)}s
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No queue yet.</p>
          )}
        </section>

        <section className="transcript">
          <h2>Live Script</h2>
          {nowPlaying ? (
            <p className="script-text">{nowPlaying.script}</p>
          ) : standby ? (
            <p className="script-text">{standby.seg.script}</p>
          ) : (
            <p>The script for the current segment will appear here.</p>
          )}
          <p className="voice-note">Voice: {voiceLabel}</p>
        </section>
      </div>

      <footer className="status-footer">
        {health ? (
          <p>
            Wire status: {health.totalItems} stories · local {health.countsByCategory.local} ·
            state {health.countsByCategory.state} · regional {health.countsByCategory.regional} ·
            AI {health.countsByCategory.ai} · tech {health.countsByCategory.tech} · business{' '}
            {health.countsByCategory.business} · national {health.countsByCategory.national} ·
            global {health.countsByCategory.global} ·
            newsletters {health.countsByCategory.newsletter} · music listings{' '}
            {health.countsByCategory.music} · last fetch{' '}
            {health.lastFeedFetchAt
              ? new Date(health.lastFeedFetchAt).toLocaleTimeString('en-US', {
                  timeZone: TIME_ZONE,
                })
              : 'n/a'}{' '}
            · server buffer {health.bufferMinutes} min · deterministic templates, zero AI credits
          </p>
        ) : (
          <p>Wire status: loading…</p>
        )}
      </footer>
    </div>
  );
}
