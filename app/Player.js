'use client';

// KC Tech Radio browser player.
//
// Playback model: the server hands us a queue of segments (scripts + time
// estimates) covering 12+ minutes. We read them aloud with the browser's
// speechSynthesis, one segment at a time, chunked by sentence (long single
// utterances stall or get cut off in Chrome). When the unplayed tail of
// the queue drops under REFILL_THRESHOLD_SECONDS we fetch /api/playlist
// again and append only segments we have not already queued, so the
// stream stays minutes ahead of the listener and never hits a gap.

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
  const [voiceName, setVoiceName] = useState('');

  const queueRef = useRef([]);
  const posRef = useRef(0);
  const seenIdsRef = useRef(new Set());
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const volumeRef = useRef(1);
  const voiceRef = useRef(null);
  const fetchingRef = useRef(false);
  const startedRef = useRef(false);
  const currentRef = useRef(null);

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

  // ---- voice ---------------------------------------------------------------
  useEffect(() => {
    const load = () => {
      voiceRef.current = pickVoice();
      setVoiceName(voiceRef.current?.name || 'browser default');
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

  // ---- speech engine -------------------------------------------------------------
  const speakCurrent = useCallback(() => {
    const synth = window.speechSynthesis;
    if (!synth || !playingRef.current) return;
    const seg = queueRef.current[posRef.current];
    if (!seg) {
      // Queue exhausted: try a refill; if nothing arrives, stop cleanly.
      fetchPlaylist().then((added) => {
        if (added && playingRef.current) speakCurrent();
        else if (playingRef.current) {
          playingRef.current = false;
          setStatus('ready');
        }
      });
      return;
    }
    currentRef.current = seg;
    syncView();

    const chunks = chunkScript(seg.script);
    let chunkIdx = 0;
    const speakChunk = () => {
      if (!playingRef.current) return;
      if (chunkIdx >= chunks.length) {
        posRef.current += 1;
        // Keep the buffer ahead of the listener.
        if (remainingSeconds() < REFILL_THRESHOLD_SECONDS) fetchPlaylist();
        speakCurrent();
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
  }, [fetchPlaylist, remainingSeconds, syncView]);

  // Chrome desktop can silently stall long speech sessions; nudge resume()
  // while playing (a well-known workaround). Harmless elsewhere.
  useEffect(() => {
    const t = setInterval(() => {
      if (playingRef.current && window.speechSynthesis?.speaking) {
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
    if (window.speechSynthesis?.paused) window.speechSynthesis.resume();
    else speakCurrent();
  };

  const onPause = () => {
    playingRef.current = false;
    setStatus('paused');
    window.speechSynthesis?.pause();
  };

  const onStop = () => {
    playingRef.current = false;
    setStatus('ready');
    window.speechSynthesis?.cancel();
    // Restart the current segment from its top next time Play is pressed.
  };

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

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
          <p className="voice-note">Voice: {voiceName || 'loading…'}</p>
        </section>
      </div>

      <footer className="status-footer">
        {health ? (
          <p>
            Wire status: {health.totalItems} stories · local {health.countsByCategory.local} ·
            AI {health.countsByCategory.ai} · tech {health.countsByCategory.tech} · business{' '}
            {health.countsByCategory.business} · global {health.countsByCategory.global} · last
            fetch{' '}
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
