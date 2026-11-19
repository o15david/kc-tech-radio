'use client';

// KC Tech Radio browser player.
//
// Playback model: the server hands us a queue of segments covering 12+
// minutes. Each segment carries an audioUrl to a pre-rendered MP3 (natural
// Edge TTS neural voice, rendered server-side by /api/audio) — that is the
// primary audio path. While a segment plays we preload the NEXT segment's
// MP3 into a second audio element, so playback rolls gaplessly and the
// stream stays minutes ahead of the listener. If an MP3 fails to load or
// play, we fall back to reading that segment with the browser's
// speechSynthesis (chunked by sentence, since long single utterances stall
// in Chrome) and try MP3 again on the next segment. When the unplayed tail
// of the queue drops under REFILL_THRESHOLD_SECONDS we fetch /api/playlist
// again and append only segments we have not already queued.

import { useCallback, useEffect, useRef, useState } from 'react';

const REFILL_THRESHOLD_SECONDS = 300; // refetch when < 5 min remain
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
  const [status, setStatus] = useState('loading'); // loading|ready|playing|paused|error
  const [nowPlaying, setNowPlaying] = useState(null);
  const [queueView, setQueueView] = useState([]); // segments from current onward
  const [bufferSeconds, setBufferSeconds] = useState(0);
  const [health, setHealth] = useState(null);
  const [clock, setClock] = useState('');
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [voiceLabel, setVoiceLabel] = useState('Edge neural TTS');

  const queueRef = useRef([]);
  const posRef = useRef(0);
  const seenIdsRef = useRef(new Set());
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const volumeRef = useRef(1);
  const voiceRef = useRef(null); // browser fallback voice
  const fetchingRef = useRef(false);
  const startedRef = useRef(false);
  const currentRef = useRef(null);
  const audioRef = useRef(null); // main MP3 element
  const preloadRef = useRef(null); // next-segment MP3 preload element
  const modeRef = useRef(null); // 'audio' | 'speech' | null (current segment)
  const suspendedRef = useRef(false); // paused mid-segment

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

  // ---- playlist fetching -----------------------------------------------------
  const remainingSeconds = useCallback(() => {
    let sum = 0;
    for (let i = posRef.current; i < queueRef.current.length; i++) {
      sum += queueRef.current[i].estSeconds / rateRef.current;
    }
    return sum;
  }, []);

  const syncView = useCallback(() => {
    setQueueView(queueRef.current.slice(posRef.current, posRef.current + 9));
    setNowPlaying(queueRef.current[posRef.current] || null);
    setBufferSeconds(Math.round(remainingSeconds()));
  }, [remainingSeconds]);

  const fetchPlaylist = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetch('/api/playlist', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      let added = 0;
      for (const seg of data.segments) {
        if (seenIdsRef.current.has(seg.id)) continue;
        seenIdsRef.current.add(seg.id);
        queueRef.current.push(seg);
        added++;
      }
      if (added) syncView();
      return added;
    } catch {
      return 0;
    } finally {
      fetchingRef.current = false;
    }
  }, [syncView]);

  // Initial queue load (so Up Next is populated before Play is pressed).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    fetchPlaylist().then(() => setStatus((s) => (s === 'loading' ? 'ready' : s)));
  }, [fetchPlaylist]);

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

  // Start downloading the next segment's MP3 while the current one plays.
  const preloadNext = useCallback(() => {
    const next = queueRef.current[posRef.current + 1];
    if (!next?.audioUrl) return;
    const pre = getPreload();
    const target = new URL(next.audioUrl, window.location.origin).href;
    if (pre.src !== target) {
      pre.src = next.audioUrl;
      pre.load();
    }
  }, [getPreload]);

  // ---- playback engine -----------------------------------------------------------
  // Defined with refs so the recursive advance chain never goes stale.
  const playCurrentRef = useRef(null);

  const speakSegment = useCallback(
    (seg, onDone) => {
      const synth = window.speechSynthesis;
      if (!synth) {
        onDone();
        return;
      }
      modeRef.current = 'speech';
      setVoiceLabel(`browser voice (${voiceRef.current?.name || 'default'}) · fallback`);
      const chunks = chunkScript(seg.script);
      let chunkIdx = 0;
      const speakChunk = () => {
        if (!playingRef.current) return;
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
    },
    []
  );

  const playCurrent = useCallback(() => {
    if (!playingRef.current) return;
    const seg = queueRef.current[posRef.current];
    if (!seg) {
      // Queue exhausted: try a refill; if nothing arrives, stop cleanly.
      fetchPlaylist().then((added) => {
        if (added && playingRef.current) playCurrentRef.current?.();
        else if (playingRef.current) {
          playingRef.current = false;
          setStatus('ready');
        }
      });
      return;
    }
    currentRef.current = seg;
    syncView();
    preloadNext();

    const advance = () => {
      posRef.current += 1;
      // Keep the buffer ahead of the listener.
      if (remainingSeconds() < REFILL_THRESHOLD_SECONDS) fetchPlaylist();
      playCurrentRef.current?.();
    };

    if (!seg.audioUrl) {
      speakSegment(seg, advance);
      return;
    }

    // Primary path: the pre-rendered MP3.
    modeRef.current = 'audio';
    setVoiceLabel(seg.voice ? `${seg.voice} · Edge neural` : 'Edge neural TTS');
    const audio = getAudio();
    let fellBack = false;
    const fallBack = () => {
      if (fellBack || !playingRef.current) return;
      fellBack = true;
      // Only fall back if this segment is still the one on air.
      if (currentRef.current === seg) speakSegment(seg, advance);
    };
    audio.onended = () => {
      if (playingRef.current && currentRef.current === seg) advance();
    };
    audio.onerror = fallBack;
    audio.playbackRate = rateRef.current;
    audio.volume = volumeRef.current;
    audio.src = seg.audioUrl;
    audio.play().catch(fallBack);
  }, [fetchPlaylist, getAudio, preloadNext, remainingSeconds, speakSegment, syncView]);

  useEffect(() => {
    playCurrentRef.current = playCurrent;
  }, [playCurrent]);

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
    playingRef.current = true;
    setStatus('playing');
    if (suspendedRef.current) {
      suspendedRef.current = false;
      // Resume the segment we paused, in whichever mode it was playing.
      if (modeRef.current === 'audio' && audioRef.current) {
        audioRef.current.play().catch(() => {});
        return;
      }
      if (modeRef.current === 'speech' && window.speechSynthesis?.paused) {
        window.speechSynthesis.resume();
        return;
      }
    }
    playCurrent();
  };

  const onPause = () => {
    playingRef.current = false;
    suspendedRef.current = true;
    setStatus('paused');
    if (modeRef.current === 'audio') audioRef.current?.pause();
    else window.speechSynthesis?.pause();
  };

  const onStop = () => {
    playingRef.current = false;
    suspendedRef.current = false;
    modeRef.current = null;
    setStatus('ready');
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    window.speechSynthesis?.cancel();
    // The current segment restarts from its top next time Play is pressed.
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
          <span className="buffer" title="Minutes of queued audio ahead of playback">
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
            AI {health.countsByCategory.ai} · tech {health.countsByCategory.tech} · business{' '}
            {health.countsByCategory.business} · global {health.countsByCategory.global} ·
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
