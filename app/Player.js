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
//  - PRELOAD AHEAD. The next segment's MP3 is downloaded while the
//    current one plays, and segments further ahead are HEAD-warmed
//    (a HEAD on /api/audio renders server-side exactly like a GET),
//    because a cold Edge TTS render takes seconds.
//  - RETRY, THEN DEGRADE, THEN SKIP. If a segment's MP3 errors (the
//    route 502s after its own server-side retry ladder) or stalls (no
//    progress for 8 seconds: a stalled fetch fires no error event),
//    the player reloads it up to 2 times with a short pause; then the
//    browser's speechSynthesis reads that one segment; if even that
//    is unavailable, the segment is skipped. The stream moves on.
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
const MAX_LOAD_ATTEMPTS = 2; // MP3 reloads per segment before the speech fallback
const RETRY_PAUSE_MS = 1200;
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

  const queueRef = useRef([]);
  const indexRef = useRef(0); // playhead position in queueRef
  const seenIdsRef = useRef(new Set()); // every segment id ever queued
  const queuedStoryKeysRef = useRef(new Set()); // story keys in the loaded queue
  const playedStoryKeysRef = useRef(new Set()); // story keys that started playing
  const warmedIdsRef = useRef(new Set()); // segment ids already HEAD-warmed
  const loadAttemptsRef = useRef(new Map()); // segment id -> MP3 reload attempts
  const playingRef = useRef(false);
  const pausedModeRef = useRef(null); // mode held by Pause: 'audio' | 'speech' | null
  const rateRef = useRef(1);
  const volumeRef = useRef(1);
  const voiceRef = useRef(null); // browser fallback voice
  const fetchingRef = useRef(false);
  const startedRef = useRef(false);
  const currentIdRef = useRef(null);
  const stallRef = useRef({ id: null, lastSample: 0, since: 0, nudges: 0 });
  const retryTimerRef = useRef(null);
  const audioRef = useRef(null); // main MP3 element
  const preloadRef = useRef(null); // next-segment MP3 preload element
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

  const getPreload = useCallback(() => {
    if (!preloadRef.current) {
      preloadRef.current = new Audio();
      preloadRef.current.preload = 'auto';
    }
    return preloadRef.current;
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

  // Start downloading the next segment's MP3 while the current one plays.
  const preloadNext = useCallback(
    (index) => {
      const next = queueRef.current[index + 1];
      if (next?.audioUrl) {
        const pre = getPreload();
        const target = new URL(next.audioUrl, window.location.origin).href;
        if (pre.src !== target) {
          pre.src = next.audioUrl;
          pre.load();
        }
      }
      warmAhead(index + 1);
    },
    [getPreload, warmAhead]
  );

  // ---- playback engine -----------------------------------------------------------
  const advanceRef = useRef(null);
  const retryLoadRef = useRef(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

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
  }, [fetchQueue, syncView]);

  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  // The MP3 for the current segment failed to load or stalled out:
  // reload it (up to MAX_LOAD_ATTEMPTS times, with a short pause —
  // the first attempt usually triggered the server render, so the
  // reload is often a cache hit), then degrade to the browser voice
  // for this one segment, then skip. Never silence.
  const retryLoad = useCallback(
    (seg) => {
      if (!playingRef.current || currentIdRef.current !== seg.id) return;
      const attempts = (loadAttemptsRef.current.get(seg.id) || 0) + 1;
      loadAttemptsRef.current.set(seg.id, attempts);
      if (attempts > MAX_LOAD_ATTEMPTS) {
        if (window.speechSynthesis) {
          speakSegment(seg, () => advanceRef.current?.());
        } else {
          advanceRef.current?.();
        }
        return;
      }
      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        if (!playingRef.current || currentIdRef.current !== seg.id) return;
        const audio = getAudio();
        modeRef.current = 'audio';
        stallRef.current = { id: seg.id, lastSample: 0, since: Date.now(), nudges: 0 };
        audio.src = seg.audioUrl;
        audio.load();
        audio.play().catch(() => retryLoadRef.current?.(seg));
      }, RETRY_PAUSE_MS);
    },
    [clearRetryTimer, getAudio, speakSegment]
  );

  useEffect(() => {
    retryLoadRef.current = retryLoad;
  }, [retryLoad]);

  const startSegment = useCallback(
    (index) => {
      const seg = queueRef.current[index];
      if (!seg) {
        advanceRef.current?.();
        return;
      }
      startTokenRef.current += 1;
      const token = startTokenRef.current;
      indexRef.current = index;
      currentIdRef.current = seg.id;
      stallRef.current = { id: seg.id, lastSample: 0, since: Date.now(), nudges: 0 };
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
        // Stall watchdog evidence: the last position the audio element
        // actually reached. A stalled fetch leaves this frozen while
        // producing no 'error' and no 'ended'.
        if (currentIdRef.current === seg.id) {
          stallRef.current.lastSample = audio.currentTime || 0;
        }
      };
      audio.onerror = () => {
        if (token === startTokenRef.current) retryLoadRef.current?.(seg);
      };
      audio.playbackRate = rateRef.current;
      audio.volume = volumeRef.current;
      audio.src = seg.audioUrl;
      audio.play().catch(() => {
        if (token === startTokenRef.current) retryLoadRef.current?.(seg);
      });
    },
    [getAudio, maybeRefill, preloadNext, speakSegment, storyKey, syncView]
  );

  const startSegmentRef = useRef(null);
  useEffect(() => {
    startSegmentRef.current = startSegment;
  }, [startSegment]);

  // Stall watchdog: an audio element that has stopped progressing (a
  // slow cold render, a stalled fetch) produces no 'error' event and
  // no 'ended' — it just sits silent. Watch for exactly that: nudge
  // play() once, then hand the segment to the retry ladder (reload,
  // speech fallback, skip). A progressing segment is never touched.
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
        stall.nudges = 0;
        return;
      }
      if (Date.now() - stall.since < STALL_LIMIT_MS) return;
      stall.since = Date.now();
      stall.nudges += 1;
      if (stall.nudges === 1) {
        audio.play().catch(() => {});
      } else {
        const seg = queueRef.current.find((s) => s.id === currentIdRef.current);
        if (seg) retryLoadRef.current?.(seg);
      }
    }, 2000);
    return () => clearInterval(t);
  }, []);

  // Returning to the page: if the stream is playing but the browser
  // throttled the audio while backgrounded, nudge it back to life.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible' || !playingRef.current) return;
      if (
        modeRef.current === 'audio' &&
        audioRef.current &&
        audioRef.current.paused &&
        !audioRef.current.ended
      ) {
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
    pausedModeRef.current = modeRef.current;
    setStatus('paused');
    if (modeRef.current === 'audio') audioRef.current?.pause();
    else if (modeRef.current === 'speech') window.speechSynthesis?.pause();
  };

  const onStop = () => {
    // Halt and rewind to the start of the current segment: pressing
    // Play again restarts that segment, it does not jump anywhere.
    playingRef.current = false;
    clearRetryTimer();
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
