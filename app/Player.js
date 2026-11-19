'use client';

// KC Tech Radio browser player — a simple sequential queue player.
//
// Back to basics (Nov 19): there is no format clock and no live edge.
// /api/playlist returns one ordered queue of segments (see
// lib/format.js); pressing Play starts the queue at its head, and each
// segment plays to its natural end, butt-joined to the next. Listeners
// are NOT synced to a clock or to each other: everyone gets the same
// queue (within a half-hour rotation bucket) and hears it at their own
// pace. Pause is a plain hold: it freezes the current segment, and
// resume continues that same segment where it left off.
//
// Reliability rules (a segment must never become silence):
//  - PRELOAD AHEAD. The next TWO segments' MP3s are genuinely
//    buffered (preload="auto" on hidden audio elements, not just
//    metadata) while the current one plays, so a brief network gap
//    does not stall the playhead; segments further ahead are
//    HEAD-warmed (a HEAD on /api/audio renders server-side exactly
//    like a GET), because a cold Edge TTS render takes seconds.
//    Two segments is the bound, for mobile data's sake.
//  - PATIENT RECOVERY LADDER (Nov 19 iOS finding: on David's iPhone
//    in the WKWebView in-app browser, segments were still cutting out
//    mid-story and skipping to the next one, while a server-side
//    sample proved the MP3s themselves complete. iOS stalls are
//    frequent and usually transient — WKWebView media throttling,
//    network handoffs, screen lock, background timer throttling —
//    and the old ladder judged them in about a second and moved on).
//    Recovery for the current segment is now deliberately patient:
//    Stage 0: on a stall signal, wait briefly and call play() again
//    WITHOUT touching src; most iOS stalls self-recover here.
//    Stage 1: if still frozen after ~4s of observed freeze, reload
//    and seek to the last heard position (the resume machinery
//    below), then wait a generous ~10s grace window for canplay /
//    progress before judging the attempt. Up to 3 resume attempts,
//    with backoff between them.
//    Stage 2: skip to the next segment ONLY after 3 failed resume
//    attempts at the same position, or a hard media error that
//    survives those retries, or when only the last second of the
//    segment is left. A freeze shorter than ~2s never counts as a
//    failure at all. A segment nothing was heard from gets plain
//    load retries with backoff, then the speech fallback (unchanged
//    rule: speech only when nothing was heard).
//    Watchdog hygiene: freezes are never counted while the document
//    is hidden, and a long gap between watchdog samples (a throttled
//    timer while backgrounded or locked) is discarded as evidence
//    rather than counted as freeze time. Session stall counters are
//    kept and shown in a small diagnostics line under the controls,
//    so a field report carries numbers, not impressions.
//  - NO REPLAY, EVER (Nov 19 production finding: 5 of 38 segments in
//    a 15-minute listen had their audio restart from the beginning
//    after a stall, cutting off mid-sentence — the old retryLoad
//    reassigned src and reloaded from position 0 no matter how much
//    had already been heard). A segment's audio plays AT MOST ONCE
//    per session. The player tracks each segment's maximum heard
//    position (heardMaxRef): a reload of the current segment seeks
//    back to that position before playing, never to 0; if the heard
//    position is already within the last second of the segment (or
//    the duration is unknown while something was heard), the player
//    advances instead of reloading. The speechSynthesis fallback
//    re-reads the whole script, so it is FORBIDDEN once more than
//    half a second of the segment was heard — the player skips to
//    the next segment instead. And a segment that has finished or
//    been skipped is recorded (finishedIdsRef) and can never be
//    started again this session, whatever path leads to it.
//  - REFILL BEFORE THE END. When the loaded queue runs low, the
//    player fetches the next queue and appends only segments it has
//    not already queued or played this session (segment ids, plus
//    story keys — link, falling back to headline — so a story can
//    never repeat inside a session even across queue rotations).

import { useCallback, useEffect, useRef, useState } from 'react';

const REFILL_MIN_SEGMENTS = 12; // refill when fewer than this remain unplayed
const REFILL_MIN_SECONDS = 600; // ...or when under 10 minutes remain
const WARM_AHEAD_SECONDS = 300; // HEAD-warm this much audio ahead of the playhead
const WARM_AHEAD_MAX = 24;
const WATCHDOG_TICK_MS = 1000; // stall watchdog sampling interval
const SAMPLE_GAP_MAX_MS = 3500; // a longer gap between samples = throttled timer, not freeze evidence
const FREEZE_MIN_MS = 2000; // a freeze shorter than this never counts as a failure
const STAGE0_AT_MS = 1500; // observed freeze this long -> stage 0 (play() nudge, src untouched)
const STAGE0_DELAY_MS = 800; // stage 0 waits this long after a stall signal before nudging play()
const STAGE1_AT_MS = 4000; // still frozen this long -> stage 1 (resume-reload)
const RESUME_GRACE_MS = 10000; // after a resume-reload, wait this long for canplay/progress before judging it
const MAX_RESUME_ATTEMPTS = 3; // stage-1 resume attempts at one position before stage 2 (skip)
const RESUME_BACKOFF_MS = [1500, 3000, 6000]; // wait before resume attempt 2, 3 (index by attempts already made)
const MAX_LOAD_ATTEMPTS = 3; // plain reloads of a never-heard segment before the speech fallback
const LOAD_BACKOFF_MS = [1200, 2500, 5000]; // wait before load retry 2, 3
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

export default function Player() {
  const [status, setStatus] = useState('loading'); // loading|ready|playing|paused
  const [nowPlaying, setNowPlaying] = useState(null); // segment at the playhead
  const [queueView, setQueueView] = useState([]); // playhead segment + what follows
  const [queueSeconds, setQueueSeconds] = useState(0); // estimated audio loaded from the playhead on
  const [health, setHealth] = useState(null);
  const [clock, setClock] = useState('');
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [voiceLabel, setVoiceLabel] = useState('Edge neural TTS');
  const [diagView, setDiagView] = useState({
    stalls: 0,
    stage0Recoveries: 0,
    resumeAttempts: 0,
    resumesOk: 0,
    skips: 0,
    loadErrors: 0,
  });

  const queueRef = useRef([]);
  const indexRef = useRef(0); // playhead position in queueRef
  const seenIdsRef = useRef(new Set()); // every segment id ever queued
  const queuedStoryKeysRef = useRef(new Set()); // story keys in the loaded queue
  const playedStoryKeysRef = useRef(new Set()); // story keys that started playing
  const warmedIdsRef = useRef(new Set()); // segment ids already HEAD-warmed
  const heardMaxRef = useRef(new Map()); // segment id -> max audio position (s) actually heard
  const finishedIdsRef = useRef(new Set()); // segment ids finished or skipped this session
  const pendingSeekRef = useRef(null); // 'canplay' seek handler armed by a resume-reload
  // Recovery state machine for the CURRENT segment only (reset by
  // startSegment). phase: 'idle' (progressing, or frozen < stage 0)
  // -> 'stage0' (play() nudged, src untouched) -> 'grace' (a resume
  // reload is inside its RESUME_GRACE_MS judgement window) ->
  // 'backoff' (waiting to make the next resume attempt) -> 'idle'
  // again on any progress. frozenMs accumulates ONLY timely, visible
  // watchdog samples, so background/lock timer throttling can never
  // inflate it. loadAttempts counts plain reloads of a segment
  // nothing was heard from; resumeAttempts counts stage-1 reloads.
  const recoveryRef = useRef({
    id: null,
    phase: 'idle',
    viaResume: false,
    frozenAt: 0,
    lastSample: 0,
    lastTickAt: 0,
    frozenMs: 0,
    countedStall: false,
    resumeAttempts: 0,
    loadAttempts: 0,
    graceUntil: 0,
  });
  // Session stall diagnostics: rendered in the UI and mirrored to
  // the console with segment ids, so the next field report is data.
  const diagRef = useRef({
    stalls: 0,
    stage0Recoveries: 0,
    resumeAttempts: 0,
    resumesOk: 0,
    skips: 0,
    loadErrors: 0,
  });
  const playingRef = useRef(false);
  const pausedModeRef = useRef(null); // mode held by Pause: 'audio' | 'speech' | null
  const rateRef = useRef(1);
  const volumeRef = useRef(1);
  const voiceRef = useRef(null); // browser fallback voice
  const fetchingRef = useRef(false);
  const startedRef = useRef(false);
  const currentIdRef = useRef(null);
  const retryTimerRef = useRef(null); // backoff timer for the recovery ladder
  const stallTimerRef = useRef(null); // stage-0 delayed nudge timer
  const audioRef = useRef(null); // main MP3 element
  const preloadRef = useRef(null); // next-segment MP3 buffer element
  const preload2Ref = useRef(null); // next-next-segment MP3 buffer element
  const modeRef = useRef(null); // 'audio' | 'speech' | null (current segment)
  const speechGenRef = useRef(0); // bumped whenever speech is superseded/cancelled
  const startTokenRef = useRef(0); // bumped per segment start; stale handlers check it

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
  const syncView = useCallback(() => {
    const q = queueRef.current;
    const idx = Math.min(indexRef.current, Math.max(0, q.length - 1));
    setQueueView(q.slice(idx, idx + 10));
    setNowPlaying(q[idx] || null);
    let secs = 0;
    for (let i = idx; i < q.length; i++) secs += q[i].estSeconds || 0;
    setQueueSeconds(secs);
  }, []);

  // Identity of a story segment independent of its segment id: a fresh
  // queue can carry the same story under a new id, but its link (or
  // headline) gives it away.
  const storyKey = useCallback((seg) => {
    if (seg.kind !== 'story') return null;
    return seg.link || seg.headline || seg.id;
  }, []);

  // ---- queue fetching -----------------------------------------------------
  const fetchQueue = useCallback(
    async (append) => {
      if (fetchingRef.current) return 0;
      fetchingRef.current = true;
      try {
        const res = await fetch('/api/playlist', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        let added = 0;
        if (!append) {
          queueRef.current = [];
          seenIdsRef.current = new Set();
          queuedStoryKeysRef.current = new Set();
          indexRef.current = 0;
        }
        for (const seg of data.segments) {
          if (seenIdsRef.current.has(seg.id)) continue;
          const key = storyKey(seg);
          // Never re-queue a story already queued or already played
          // this session, under any segment id.
          if (key && (queuedStoryKeysRef.current.has(key) || playedStoryKeysRef.current.has(key))) {
            continue;
          }
          seenIdsRef.current.add(seg.id);
          if (key) queuedStoryKeysRef.current.add(key);
          queueRef.current.push(seg);
          added++;
        }
        if (added || !append) syncView();
        return added;
      } catch {
        return 0;
      } finally {
        fetchingRef.current = false;
      }
    },
    [storyKey, syncView]
  );

  // Initial queue load (so the head of the queue shows before Play).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    fetchQueue(false).then(() => {
      setStatus((s) => (s === 'loading' ? 'ready' : s));
    });
  }, [fetchQueue]);

  // Refill when the loaded queue runs low ahead of the playhead.
  const maybeRefill = useCallback(() => {
    if (!playingRef.current) return;
    const q = queueRef.current;
    const remaining = q.length - indexRef.current;
    let secs = 0;
    for (let i = indexRef.current; i < q.length; i++) secs += q[i].estSeconds || 0;
    if (remaining <= REFILL_MIN_SEGMENTS || secs <= REFILL_MIN_SECONDS) {
      fetchQueue(true);
    }
  }, [fetchQueue]);

  useEffect(() => {
    const t = setInterval(maybeRefill, 15000);
    return () => clearInterval(t);
  }, [maybeRefill]);

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

  const getPreload = useCallback((which) => {
    const ref = which === 2 ? preload2Ref : preloadRef;
    if (!ref.current) {
      ref.current = new Audio();
      ref.current.preload = 'auto';
    }
    return ref.current;
  }, []);

  // Bump one session diagnostics counter, mirror it to the UI state
  // and to the console with the segment id attached.
  const bumpDiag = useCallback((key, segId, note) => {
    diagRef.current = { ...diagRef.current, [key]: (diagRef.current[key] || 0) + 1 };
    setDiagView(diagRef.current);
    try {
      console.info(
        `[kc-tech-radio] diag ${key} seg=${segId || '-'}${note ? ` ${note}` : ''} totals=${JSON.stringify(diagRef.current)}`
      );
    } catch {
      /* console is best-effort */
    }
  }, []);

  // Trigger server-side renders ahead of the playhead: HEAD each
  // upcoming segment's audioUrl (the route renders on HEAD exactly as
  // on GET, so the MP3 is cached server-side and CDN-side by the time
  // it is needed). Depth is measured in seconds of audio, not segment
  // count: short segments used to give under a minute of runway
  // against multi-second cold renders.
  const warmAhead = useCallback((fromIndex) => {
    const q = queueRef.current;
    let seconds = 0;
    let count = 0;
    for (let i = fromIndex; i < q.length && count < WARM_AHEAD_MAX; i++) {
      const seg = q[i];
      if (!seg) break;
      seconds += seg.estSeconds || 0;
      count++;
      if (seconds >= WARM_AHEAD_SECONDS && count >= 2) break;
      if (!seg.audioUrl || warmedIdsRef.current.has(seg.id)) continue;
      warmedIdsRef.current.add(seg.id);
      fetch(seg.audioUrl, { method: 'HEAD' }).catch(() => {
        /* a failed warm just leaves the render to the playhead's retry ladder */
        warmedIdsRef.current.delete(seg.id);
      });
    }
  }, []);

  // Genuinely buffer the next TWO segments' MP3s while the current
  // one plays: one hidden preload="auto" element each, pointed at
  // the segment after next as well as the next one, so a brief
  // network gap (an iOS handoff, a tunnel, a lock-screen radio
  // renegotiation) finds the upcoming audio already on the device.
  // Bounded at two for mobile data. HEAD-warming continues further
  // ahead for the server-side render cache.
  const preloadNext = useCallback(
    (index) => {
      for (const [offset, which] of [
        [1, 1],
        [2, 2],
      ]) {
        const seg = queueRef.current[index + offset];
        if (!seg?.audioUrl) continue;
        const pre = getPreload(which);
        const target = new URL(seg.audioUrl, window.location.origin).href;
        if (pre.src !== target) {
          pre.src = seg.audioUrl;
          pre.load();
        }
      }
      warmAhead(index + 1);
    },
    [getPreload, warmAhead]
  );

  // ---- playback engine -----------------------------------------------------------
  const advanceRef = useRef(null);
  const performResumeRef = useRef(null);
  const failAttemptRef = useRef(null);
  const handleFailureRef = useRef(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const clearStallTimer = useCallback(() => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  // Disarm a pending resume-seek. The audio element is shared across
  // segments, so a 'canplay' handler armed by one segment's reload
  // must never survive into another segment (or past a Stop): if it
  // fired there, it would seek the WRONG segment to the old position.
  const clearPendingSeek = useCallback(() => {
    if (pendingSeekRef.current && audioRef.current) {
      audioRef.current.removeEventListener('canplay', pendingSeekRef.current);
    }
    pendingSeekRef.current = null;
  }, []);

  // Real forward progress on the current segment: update the
  // no-replay heard record, and close out whatever recovery episode
  // was open (crediting the stage that achieved the recovery).
  const noteProgress = useCallback(
    (segId, cur) => {
      if (cur > (heardMaxRef.current.get(segId) || 0)) {
        heardMaxRef.current.set(segId, cur);
      }
      const rec = recoveryRef.current;
      if (rec.id !== segId) return;
      rec.lastSample = cur;
      // An open episode closes only on REAL advancement past the
      // position where it began. A resume-reload's seek makes
      // currentTime JUMP to the heard position and fires timeupdate
      // before a single new frame has played; counting that as a
      // successful resume would reset the attempt budget and let a
      // segment stall at the same position forever.
      const advanced = cur > (rec.frozenAt || 0) + 0.2;
      if (!advanced && rec.phase !== 'idle') return;
      if (rec.phase === 'stage0') {
        // Stage 0 recovered the segment without touching src.
        if (rec.countedStall) bumpDiag('stage0Recoveries', segId, 'recovered in place');
        rec.phase = 'idle';
        rec.frozenMs = 0;
        rec.countedStall = false;
        clearStallTimer();
      } else if (rec.phase === 'grace' || rec.phase === 'backoff' || rec.phase === 'resuming') {
        // A stage-1 resume attempt worked. (The initial load and
        // pre-heard load retries also pass through a grace window,
        // flagged viaResume=false: their success is just a load,
        // not a resume, and is not credited as one.)
        if (rec.viaResume) bumpDiag('resumesOk', segId, `resumed at ${cur.toFixed(1)}s`);
        rec.viaResume = false;
        rec.phase = 'idle';
        rec.frozenMs = 0;
        rec.countedStall = false;
        rec.resumeAttempts = 0;
        rec.loadAttempts = 0;
        clearRetryTimer();
      } else if (rec.frozenMs > 0 || rec.countedStall) {
        rec.frozenMs = 0;
        rec.countedStall = false;
      }
    },
    [bumpDiag, clearRetryTimer, clearStallTimer]
  );

  // A stall signal for the current segment (a waiting/stalled event,
  // or the watchdog's first frozen samples). Stage 0 only: wait a
  // short delay, then call play() again WITHOUT touching src. Many
  // iOS stalls self-recover; nothing here can skip or restart
  // anything. The watchdog escalates to stage 1 only if the freeze
  // persists to STAGE1_AT_MS of observed frozen time.
  const signalStall = useCallback(
    (seg, source) => {
      if (!playingRef.current || currentIdRef.current !== seg.id) return;
      const rec = recoveryRef.current;
      if (rec.id !== seg.id) return;
      if (rec.phase !== 'idle') return; // an episode is already open
      rec.phase = 'stage0';
      rec.frozenAt = rec.lastSample;
      clearStallTimer();
      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        if (!playingRef.current || currentIdRef.current !== seg.id) return;
        if (recoveryRef.current.phase !== 'stage0') return; // progress already closed it
        if (!rec.countedStall) {
          rec.countedStall = true;
          bumpDiag('stalls', seg.id, `signal=${source}`);
        }
        const audio = audioRef.current;
        if (audio && !audio.ended) audio.play().catch(() => {});
      }, STAGE0_DELAY_MS);
    },
    [bumpDiag, clearStallTimer]
  );

  const speakSegment = useCallback((seg, onDone) => {
    const synth = window.speechSynthesis;
    if (!synth) {
      onDone();
      return;
    }
    // Supersede anything the fallback voice was still saying: a new
    // segment must never talk over the previous one.
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

  const advance = useCallback(() => {
    if (!playingRef.current) return;
    // Whatever led here (natural end, speech fallback done, skip),
    // the segment at the playhead is finished for this session: it
    // can never be started again (see finishedIdsRef).
    clearRetryTimer();
    clearStallTimer();
    if (currentIdRef.current) finishedIdsRef.current.add(currentIdRef.current);
    const nextIndex = indexRef.current + 1;
    if (nextIndex >= queueRef.current.length) {
      // Queue exhausted: try one refill; if nothing new arrives, stop
      // cleanly rather than replaying anything.
      fetchQueue(true).then((added) => {
        if (!playingRef.current) return;
        if (added > 0 && indexRef.current + 1 < queueRef.current.length) {
          advanceRef.current?.();
        } else {
          playingRef.current = false;
          currentIdRef.current = null;
          modeRef.current = null;
          setStatus('ready');
          syncView();
        }
      });
      return;
    }
    startSegmentRef.current?.(nextIndex);
  }, [clearRetryTimer, clearStallTimer, fetchQueue, syncView]);

  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  // ------------------------------------------------------------------
  // THE PATIENT RECOVERY LADDER (see the header for the full spec).
  // Stage 0 lives in signalStall/noteProgress above. Everything here
  // is stage 1 (resume-reload), stage 2 (skip), and the separate
  // pre-heard load-failure path. The NO-REPLAY rules bind every path:
  // a reload of a partially heard segment seeks to the heard
  // position before playing, never to 0; the speech fallback may
  // only take over a segment nothing was heard from; a finished or
  // skipped segment id never starts again.
  // ------------------------------------------------------------------

  // Stage 2 / load-path exhaustion: the current segment is over.
  // Speech fallback only when nothing (beyond a breath) was heard;
  // a heard segment is skipped, never re-read or restarted.
  const exhaustSegment = useCallback(
    (seg, why) => {
      if (!playingRef.current || currentIdRef.current !== seg.id) return;
      const heard = heardMaxRef.current.get(seg.id) || 0;
      if (heard <= 0.5 && window.speechSynthesis) {
        try {
          console.info(`[kc-tech-radio] diag speech-fallback seg=${seg.id} why=${why}`);
        } catch {}
        speakSegment(seg, () => advanceRef.current?.());
      } else {
        bumpDiag('skips', seg.id, `why=${why} heard=${heard.toFixed(1)}s`);
        advanceRef.current?.();
      }
    },
    [bumpDiag, speakSegment]
  );

  // Stage 1: reload the current segment and seek to the last heard
  // position, then give it RESUME_GRACE_MS to produce canplay /
  // progress before the watchdog judges the attempt. Entering stage
  // 1 with the attempt budget already spent is stage 2.
  const performResume = useCallback(
    (seg, why) => {
      if (!playingRef.current || currentIdRef.current !== seg.id) return;
      const rec = recoveryRef.current;
      if (rec.id !== seg.id) return;
      const heard = heardMaxRef.current.get(seg.id) || 0;
      if (heard <= 0.5) {
        // Nothing heard: this is a load problem, not a resume.
        handleFailureRef.current?.(seg, 'resume-without-progress');
        return;
      }
      const audio = getAudio();
      const dur = audio?.duration;
      const durKnown = Number.isFinite(dur) && dur > 0;
      if (durKnown && dur - heard <= 1) {
        // Only the last second is left: not worth a reload, and the
        // segment is effectively finished. Move on (existing rule);
        // this is a completion, not a failure skip.
        advanceRef.current?.();
        return;
      }
      if (rec.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
        exhaustSegment(seg, `resume-budget-spent:${why}`);
        return;
      }
      rec.resumeAttempts += 1;
      rec.phase = 'grace';
      rec.viaResume = true;
      rec.frozenAt = heard;
      rec.graceUntil = Date.now() + RESUME_GRACE_MS;
      bumpDiag('resumeAttempts', seg.id, `attempt=${rec.resumeAttempts} at=${heard.toFixed(1)}s why=${why}`);
      clearStallTimer();
      modeRef.current = 'audio';
      // Reassigning src restarts the element at 0; seek back to the
      // last heard position as soon as the reload can accept a seek,
      // BEFORE playing. Clamped to duration - 0.3s when the duration
      // is known, so the seek lands inside the file. The handler is
      // registered in pendingSeekRef so a segment change (or Stop)
      // can disarm it: the element is shared, and a stale handler
      // firing on the next segment's load would seek THAT segment
      // to this one's position.
      clearPendingSeek();
      const onCanPlay = () => {
        if (pendingSeekRef.current === onCanPlay) pendingSeekRef.current = null;
        audio.removeEventListener('canplay', onCanPlay);
        if (currentIdRef.current !== seg.id) return;
        const d = audio.duration;
        if (!(Number.isFinite(d) && d > 0)) {
          // The duration is still unknown, so the seek cannot be
          // aimed: letting the reload play would risk restarting a
          // partially heard segment from 0, which the no-replay
          // rule forbids absolutely. Fail this attempt instead;
          // the ladder retries, and stage 2 skips if it never
          // becomes aimable. (Served MP3s are complete files with
          // known durations, so this path should be rare.)
          try {
            audio.pause();
          } catch {
            /* nothing to pause */
          }
          failAttemptRef.current?.(seg, 'seek-unaimable');
          return;
        }
        const target = Math.min(heard, Math.max(0, d - 0.3));
        try {
          audio.currentTime = target;
        } catch {
          /* element not seekable yet; the grace window still guards */
        }
      };
      pendingSeekRef.current = onCanPlay;
      audio.addEventListener('canplay', onCanPlay);
      audio.src = seg.audioUrl;
      audio.load();
      // A rejected play() here is NOT judged instantly: the grace
      // window and the watchdog decide, because iOS rejects play()
      // transiently during exactly the stalls this ladder exists
      // to survive.
      audio.play().catch(() => {});
    },
    [bumpDiag, clearPendingSeek, clearStallTimer, exhaustSegment, getAudio]
  );

  useEffect(() => {
    performResumeRef.current = performResume;
  }, [performResume]);

  // The current resume attempt (or load retry) has failed: either
  // its grace window expired with no progress, or a hard media
  // error cut it short. Back off, then try the next attempt; spend
  // the budget and it is stage 2.
  const failAttempt = useCallback(
    (seg, why) => {
      if (!playingRef.current || currentIdRef.current !== seg.id) return;
      const rec = recoveryRef.current;
      if (rec.id !== seg.id) return;
      if (rec.phase === 'backoff') return; // already judged
      const heard = heardMaxRef.current.get(seg.id) || 0;
      clearRetryTimer();
      if (heard <= 0.5) {
        // Pre-heard path: plain load retries with backoff, counted
        // separately; exhaustion goes to speech / skip.
        if (rec.loadAttempts >= MAX_LOAD_ATTEMPTS) {
          exhaustSegment(seg, `load-budget-spent:${why}`);
          return;
        }
        rec.phase = 'backoff';
        const wait = LOAD_BACKOFF_MS[Math.min(rec.loadAttempts - 1, LOAD_BACKOFF_MS.length - 1)] || 1200;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (!playingRef.current || currentIdRef.current !== seg.id) return;
          if (recoveryRef.current.id !== seg.id) return;
          recoveryRef.current.phase = 'idle';
          handleFailureRef.current?.(seg, 'load-retry-timer');
        }, wait);
        return;
      }
      if (rec.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
        exhaustSegment(seg, `attempt-failed:${why}`);
        return;
      }
      rec.phase = 'backoff';
      const wait =
        RESUME_BACKOFF_MS[Math.min(Math.max(rec.resumeAttempts - 1, 0), RESUME_BACKOFF_MS.length - 1)];
      try {
        console.info(
          `[kc-tech-radio] diag attempt-failed seg=${seg.id} why=${why} attempts=${rec.resumeAttempts} next-in=${wait}ms`
        );
      } catch {}
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (!playingRef.current || currentIdRef.current !== seg.id) return;
        performResumeRef.current?.(seg, 'backoff-expired');
      }, wait);
    },
    [clearRetryTimer, exhaustSegment]
  );

  useEffect(() => {
    failAttemptRef.current = failAttempt;
  }, [failAttempt]);

  // Entry point for hard failures: a media 'error' event, or a
  // rejected initial play(). Routing depends on how much was heard
  // and what the ladder is already doing — an error during a grace
  // window fails that attempt early instead of escalating blindly,
  // and an error with a partially heard segment goes straight to
  // stage 1 (a play() nudge cannot fix a hard error).
  const handleFailure = useCallback(
    (seg, source) => {
      if (!playingRef.current || currentIdRef.current !== seg.id) return;
      const rec = recoveryRef.current;
      if (rec.id !== seg.id) return;
      const heard = heardMaxRef.current.get(seg.id) || 0;
      if (source === 'media-error') bumpDiag('loadErrors', seg.id, `heard=${heard.toFixed(1)}s`);
      if (rec.phase === 'grace' || rec.phase === 'resuming') {
        failAttemptRef.current?.(seg, `error-during-grace:${source}`);
        return;
      }
      if (rec.phase === 'backoff') return; // a retry is already scheduled
      if (heard <= 0.5) {
        rec.loadAttempts += 1;
        if (rec.loadAttempts > MAX_LOAD_ATTEMPTS) {
          exhaustSegment(seg, `load-failed:${source}`);
          return;
        }
        // Plain reload of a segment nothing was heard from: no seek
        // is armed, position 0 IS the start. Backoff first.
        rec.phase = 'backoff';
        clearRetryTimer();
        const wait =
          LOAD_BACKOFF_MS[Math.min(rec.loadAttempts - 1, LOAD_BACKOFF_MS.length - 1)] || 1200;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (!playingRef.current || currentIdRef.current !== seg.id) return;
          if (recoveryRef.current.id !== seg.id) return;
          recoveryRef.current.phase = 'grace';
          recoveryRef.current.viaResume = false;
          recoveryRef.current.graceUntil = Date.now() + RESUME_GRACE_MS;
          const audio = getAudio();
          modeRef.current = 'audio';
          audio.src = seg.audioUrl;
          audio.load();
          audio.play().catch(() => {});
        }, wait);
        return;
      }
      // Partially heard + hard failure: stage 1, now.
      if (!rec.countedStall) {
        rec.countedStall = true;
        bumpDiag('stalls', seg.id, `signal=${source}`);
      }
      performResumeRef.current?.(seg, `hard-failure:${source}`);
    },
    [bumpDiag, clearRetryTimer, exhaustSegment, getAudio]
  );

  useEffect(() => {
    handleFailureRef.current = handleFailure;
  }, [handleFailure]);

  const startSegment = useCallback(
    (index) => {
      const seg = queueRef.current[index];
      if (!seg) {
        advanceRef.current?.();
        return;
      }
      if (finishedIdsRef.current.has(seg.id)) {
        // No-replay backstop: a segment that finished or was skipped
        // this session never starts again, whatever path led here.
        indexRef.current = index;
        advanceRef.current?.();
        return;
      }
      startTokenRef.current += 1;
      const token = startTokenRef.current;
      indexRef.current = index;
      currentIdRef.current = seg.id;
      clearPendingSeek(); // a previous segment's resume-seek must not fire here
      clearRetryTimer();
      clearStallTimer();
      recoveryRef.current = {
        id: seg.id,
        // The initial load gets the same generous grace window as a
        // resume attempt: a cold Edge TTS render takes seconds, and
        // judging the first load before 10s would manufacture the
        // very cutouts this ladder exists to prevent.
        phase: 'grace',
        viaResume: false,
        frozenAt: 0,
        lastSample: 0,
        lastTickAt: Date.now(),
        frozenMs: 0,
        countedStall: false,
        resumeAttempts: 0,
        loadAttempts: 0,
        graceUntil: Date.now() + RESUME_GRACE_MS,
      };
      // Session no-repeat backstop: once a story starts, it can never
      // be re-queued by a refill this session.
      const key = storyKey(seg);
      if (key) playedStoryKeysRef.current.add(key);
      setNowPlaying(seg);
      syncView();
      preloadNext(index);
      maybeRefill();

      if (!seg.audioUrl) {
        speakSegment(seg, () => advanceRef.current?.());
        return;
      }

      modeRef.current = 'audio';
      setVoiceLabel(seg.voice ? `${seg.voice} · Edge neural` : 'Edge neural TTS');
      const audio = getAudio();
      audio.onended = () => {
        if (playingRef.current && currentIdRef.current === seg.id && token === startTokenRef.current) {
          advanceRef.current?.();
        }
      };
      audio.ontimeupdate = () => {
        // Progress evidence: the position the audio element actually
        // reached. A stalled fetch leaves this frozen while producing
        // no 'error' and no 'ended'. The samples feed heardMaxRef
        // (the no-replay record) and close out recovery episodes.
        if (currentIdRef.current === seg.id && token === startTokenRef.current) {
          noteProgress(seg.id, audio.currentTime || 0);
        }
      };
      audio.onwaiting = () => {
        if (token === startTokenRef.current) signalStall(seg, 'waiting');
      };
      audio.onstalled = () => {
        if (token === startTokenRef.current) signalStall(seg, 'stalled');
      };
      audio.onerror = () => {
        if (token === startTokenRef.current) handleFailureRef.current?.(seg, 'media-error');
      };
      audio.playbackRate = rateRef.current;
      audio.volume = volumeRef.current;
      audio.src = seg.audioUrl;
      audio.play().catch(() => {
        // Not judged instantly: a transient iOS rejection routes to
        // the same patient failure path as a media error.
        if (token === startTokenRef.current) handleFailureRef.current?.(seg, 'play-rejected');
      });
    },
    [
      clearPendingSeek,
      clearRetryTimer,
      clearStallTimer,
      getAudio,
      maybeRefill,
      noteProgress,
      preloadNext,
      signalStall,
      speakSegment,
      storyKey,
      syncView,
    ]
  );

  const startSegmentRef = useRef(null);
  useEffect(() => {
    startSegmentRef.current = startSegment;
  }, [startSegment]);

  // Stall watchdog: an audio element that has stopped progressing
  // (a slow cold render, a stalled fetch, an iOS media throttle)
  // produces no 'error' event and no 'ended' — it just sits silent.
  // The watchdog samples currentTime once a second and drives the
  // recovery state machine, with two iOS hygiene rules: samples
  // taken while the document is hidden never count, and a sample
  // gap longer than SAMPLE_GAP_MAX_MS (the interval timer itself
  // was throttled while backgrounded or locked) is discarded as
  // evidence instead of being counted as freeze time. Only timely,
  // visible, frozen samples accumulate frozenMs.
  useEffect(() => {
    const t = setInterval(() => {
      if (!playingRef.current || !currentIdRef.current) return;
      if (modeRef.current !== 'audio' || !audioRef.current) return;
      const audio = audioRef.current;
      if (audio.ended) return;
      const rec = recoveryRef.current;
      if (rec.id !== currentIdRef.current) return;
      const now = Date.now();
      const gap = rec.lastTickAt ? now - rec.lastTickAt : WATCHDOG_TICK_MS;
      rec.lastTickAt = now;
      if (document.hidden) {
        // Backgrounded or locked: re-baseline and count nothing.
        rec.lastSample = audio.currentTime || 0;
        return;
      }
      const cur = audio.currentTime || 0;
      if (cur > rec.lastSample + 0.2) {
        noteProgress(rec.id, cur);
        return;
      }
      rec.lastSample = cur;
      if (rec.phase === 'grace' || rec.phase === 'resuming') {
        // A resume (or load) attempt is inside its judgement window:
        // frozen samples are expected and count for nothing until
        // the window closes. The element may also sit paused in
        // this phase (a seek that could not be aimed): never nudge
        // play() here, it could restart the segment from 0.
        if (now >= rec.graceUntil) {
          const seg = queueRef.current.find((s) => s.id === currentIdRef.current);
          if (seg) failAttemptRef.current?.(seg, 'grace-expired');
        }
        return;
      }
      if (rec.phase === 'backoff') return; // a retry is already scheduled
      if (gap > SAMPLE_GAP_MAX_MS) {
        // The timer was throttled (background, lock screen): this
        // gap says nothing about playback. Discard it.
        return;
      }
      // A timely, visible, frozen sample in phase idle or stage0.
      rec.frozenMs += gap;
      if (rec.frozenMs >= FREEZE_MIN_MS && !rec.countedStall) {
        rec.countedStall = true;
        bumpDiag('stalls', rec.id, 'signal=watchdog');
      }
      const seg = queueRef.current.find((s) => s.id === currentIdRef.current);
      if (!seg) return;
      if (audio.paused) {
        // A browser-side pause we did not ask for (autoplay policy,
        // interruption, an iOS freeze that parks the element):
        // nudge play() while the freeze is young; if the pause
        // itself persists to STAGE1_AT_MS it is a hard stall, so
        // escalate instead of nudging forever.
        if (audio.readyState >= 2) audio.play().catch(() => {});
        if (rec.frozenMs >= STAGE1_AT_MS) {
          if ((heardMaxRef.current.get(seg.id) || 0) > 0.5) {
            performResumeRef.current?.(seg, 'paused-freeze');
          } else {
            handleFailureRef.current?.(seg, 'paused-freeze');
          }
        }
        return;
      }
      if (rec.phase === 'idle' && rec.frozenMs >= STAGE0_AT_MS) {
        signalStall(seg, 'watchdog');
      } else if (rec.phase === 'stage0' && rec.frozenMs >= STAGE1_AT_MS) {
        // Stage 0 did not recover it in ~4s of observed freeze:
        // escalate to a resume-reload.
        performResumeRef.current?.(seg, 'stall-escalation');
      }
    }, WATCHDOG_TICK_MS);
    return () => clearInterval(t);
  }, [bumpDiag, noteProgress, signalStall]);

  // Returning to the page: if the stream is playing but the browser
  // throttled the audio while backgrounded, resume it rather than
  // letting recovery escalate. The return also re-baselines the
  // watchdog, so the hidden interval is never counted as a freeze.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible' || !playingRef.current) return;
      const rec = recoveryRef.current;
      rec.lastTickAt = Date.now();
      if (audioRef.current) rec.lastSample = audioRef.current.currentTime || 0;
      if (
        modeRef.current === 'audio' &&
        audioRef.current &&
        !audioRef.current.ended &&
        currentIdRef.current &&
        rec.phase !== 'grace' &&
        rec.phase !== 'backoff'
      ) {
        // play() whether the element reports paused or merely
        // frozen: on iOS a backgrounded element can claim to be
        // playing while producing nothing.
        audioRef.current.play().catch(() => {});
      }
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
    if (!queueRef.current.length) {
      await fetchQueue(false);
    }
    if (!queueRef.current.length) return;
    playingRef.current = true;
    setStatus('playing');
    // Resume a deliberate hold where it froze, if there is one.
    if (pausedModeRef.current === 'audio' && currentIdRef.current && audioRef.current?.src) {
      pausedModeRef.current = null;
      // Re-baseline the recovery machine for the resumed segment:
      // the pause cleared its timers, so a 'backoff' phase would
      // otherwise wait forever, and a stale grace deadline would
      // fail an attempt the listener never gave a chance.
      const rec = recoveryRef.current;
      if (rec.id === currentIdRef.current) {
        rec.lastTickAt = Date.now();
        rec.lastSample = audioRef.current.currentTime || 0;
        rec.frozenMs = 0;
        if (rec.phase === 'backoff') rec.phase = 'idle';
        if (rec.phase === 'grace') rec.graceUntil = Date.now() + RESUME_GRACE_MS;
      }
      audioRef.current.play().catch(() => {});
      return;
    }
    if (pausedModeRef.current === 'speech') {
      pausedModeRef.current = null;
      window.speechSynthesis?.resume();
      return;
    }
    pausedModeRef.current = null;
    startSegmentRef.current?.(indexRef.current);
  };

  const onPause = () => {
    // A deliberate hold: freeze the output exactly where it is. Resume
    // continues the same segment; nothing is skipped or caught up.
    playingRef.current = false;
    clearRetryTimer();
    clearStallTimer();
    pausedModeRef.current = modeRef.current;
    setStatus('paused');
    if (modeRef.current === 'audio') audioRef.current?.pause();
    else if (modeRef.current === 'speech') window.speechSynthesis?.pause();
  };

  const onStop = () => {
    // Halt and rewind to the start of the current segment: pressing
    // Play again restarts that segment, it does not jump anywhere.
    // The rewind is the listener's own deliberate act, so the heard
    // record for this segment restarts too: a stall during the
    // replay must resume from the NEW playback position, not seek
    // back to where the pre-Stop playback had reached.
    if (currentIdRef.current) heardMaxRef.current.delete(currentIdRef.current);
    playingRef.current = false;
    clearRetryTimer();
    clearStallTimer();
    clearPendingSeek();
    pausedModeRef.current = null;
    speechGenRef.current += 1;
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      try {
        audioRef.current.currentTime = 0;
      } catch {
        /* nothing loaded yet */
      }
    }
    modeRef.current = null;
    setStatus('ready');
    syncView();
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
      preload2Ref.current?.pause();
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
            Kansas City tech &amp; business · AI news · world news, around the clock
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
          <span className="buffer" title="Estimated audio loaded from the playhead onward">
            Queue: {(queueSeconds / 60).toFixed(1)} min
          </span>
        </div>

        <p
          className="diag-line"
          title="This session's stall recovery counters. Stalls: freezes detected. In place: recovered by a play() nudge without reloading. Resumes: reload-and-seek attempts, and how many worked. Skips: segments abandoned after 3 failed resumes."
        >
          Playback health: stalls {diagView.stalls} · recovered in place {diagView.stage0Recoveries}{' '}
          · resume attempts {diagView.resumeAttempts} · resumes ok {diagView.resumesOk} · skips{' '}
          {diagView.skips} · load errors {diagView.loadErrors}
        </p>
      </section>

      <section className="now-playing">
        <h2>{status === 'playing' || status === 'paused' ? 'Now Playing' : 'Up First'}</h2>
        {nowPlaying ? (
          <>
            <p className="np-title">{nowPlaying.title}</p>
            <p className="np-headline">{nowPlaying.headline}</p>
            <p className="np-meta">
              {nowPlaying.category} · {nowPlaying.source} · ~
              {Math.round(nowPlaying.estSeconds)}s
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
            · server queue {health.bufferMinutes} min · deterministic templates, zero AI credits
          </p>
        ) : (
          <p>Wire status: loading…</p>
        )}
      </footer>
    </div>
  );
}
