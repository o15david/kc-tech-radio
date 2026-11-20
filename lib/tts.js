// ============================================================================
// SERVER-SIDE TEXT-TO-SPEECH — natural voices, pre-rendered, cached.
//
// Renders a segment's script to MP3 with Microsoft Edge TTS neural voices
// via the `msedge-tts` client. This is the same free read-aloud service the
// Edge browser uses: no API key, no account, no AI credits.
//
// Caching: segments are deterministic, so a given (voice, text) pair always
// renders the same MP3. We cache by SHA-256 hash of voice + text in module
// memory, and /api/audio sends year-long immutable HTTP cache headers, so
// browsers and the Vercel CDN keep copies too. A segment effectively
// renders once.
//
// RELIABILITY (the Nov 19 back-to-basics hardening). Edge TTS synthesis
// fails intermittently in production ("Stream closed before the synthesis
// completed", outright 502s at the route), and the failures get WORSE
// under concurrency pressure: the warmer, plus several listeners' players
// preloading at once, can stampede the service. So every synthesis on
// this instance — warmer and on-demand alike — flows through ONE global
// limiter (at most SYNTH_MAX_CONCURRENT at a time), each render retries
// with jittered backoff before it is allowed to fail, a failure is NEVER
// cached (a later request retries the synthesis from scratch), and a
// suspiciously short render (a stream that "succeeded" but truncated)
// is treated as a failure rather than cached. A segment therefore 502s
// only after the full retry ladder is exhausted, and the player's own
// retry/skip/speech ladder absorbs even that.
//
// SPEECH SAFETY (the other Nov 19 root cause, proven by direct synthesis
// tests): a bare "&" or "<" ANYWHERE in a script makes Edge TTS close
// the stream on EVERY attempt — deterministically, not intermittently.
// "AT&T", "R&D", "Tom & Jerry", "growth < 5 percent", and a wire's
// dangling "&nbsp" fragment all fail 100% of the time while the same
// text cleaned renders in seconds: the client embeds the script in an
// XML envelope, and the raw metacharacters break it. No retry ladder
// can fix a poisoned script; the segment is simply a permanent hole
// until the text is made safe. So every render goes through
// speechSafeText() below (& becomes "and", < becomes "less than"), and
// the cache key hashes the SAFE text, so cache, in-flight, and warmer
// bookkeeping all agree on one rendering of a script. lib/rss.js
// cleanText strips dangling entity fragments at ingestion as well, so
// scripts are clean long before they get here; this is the guarantee
// at the boundary that actually breaks.
//
// Production note: the in-memory cache resets on serverless cold starts,
// so a cold instance may re-render a segment once. The pre-render warmer
// below (warmSegmentAudio) absorbs most of that: every queue build
// renders the head of the queue in the background, so listeners rarely
// wait on a cold render. If latency ever still matters, put a persistent
// blob store (e.g. Vercel Blob) behind getSegmentMp3() keyed by the same
// hash; nothing else changes.
// ============================================================================

import { createHash } from 'node:crypto';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const OUTPUT_FORMAT_MP3 = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;

// The output format above is constant-bitrate (96 kbit/s), so an MP3's
// duration follows from its byte size to within a frame or two. The
// /api/audio route reports it in a header, and the truncated-render
// guard below compares it against the word-count estimate to catch
// syntheses that ended early.
const MP3_BITRATE_BPS = 96000;

/**
 * Duration in seconds of a rendered segment MP3, from its byte size.
 * Near-exact for the CBR format above; an ID3v2 tag, if one is ever
 * present, carries no audio and is stripped before the math.
 */
export function mp3DurationSeconds(mp3) {
  let bytes = mp3.length;
  if (
    bytes > 10 &&
    mp3[0] === 0x49 && // 'I'
    mp3[1] === 0x44 && // 'D'
    mp3[2] === 0x33 //    '3'
  ) {
    const tagSize =
      ((mp3[6] & 0x7f) << 21) |
      ((mp3[7] & 0x7f) << 14) |
      ((mp3[8] & 0x7f) << 7) |
      (mp3[9] & 0x7f);
    bytes -= 10 + tagSize;
  }
  return (bytes * 8) / MP3_BITRATE_BPS;
}

// hash -> Buffer (rendered MP3). Bounded so a long-running instance cannot
// grow without limit; oldest entries are evicted first (Map keeps order).
const mp3Cache = new Map();
const MAX_CACHE_ENTRIES = 500;

// hash -> Promise<Buffer> for renders in flight, so simultaneous requests
// for the same segment share one synthesis instead of racing.
const inFlight = new Map();

/**
 * Make a script safe to synthesize (see SPEECH SAFETY at the top of
 * this file): a bare & is spoken as "and" ("AT&T" -> "AT and T",
 * "Tom & Jerry" -> "Tom and Jerry") and a bare < as "less than".
 * Pure and idempotent, so it can be applied at key time and at render
 * time interchangeably. `>` needs no handling (proven harmless), and
 * curly quotes, em dashes, and ellipses all render fine as they are.
 */
export function speechSafeText(text) {
  return String(text ?? '')
    .replace(/&/g, ' and ')
    .replace(/</g, ' less than ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function segmentCacheKey(voice, text) {
  // The key hashes the speech-safe text: that is the text that will
  // actually be rendered, so every spelling of a script that speaks
  // identically shares one cache entry.
  return createHash('sha256')
    .update(`${voice}\n${speechSafeText(text)}`)
    .digest('hex');
}

// Environments behind an HTTP(S) proxy (some hosts and corporate networks)
// need the WebSocket tunnelled through it; the `ws` client Edge TTS uses
// does not read proxy env vars on its own. On Vercel there is no proxy env
// and this returns undefined, i.e. a direct connection.
async function proxyAgent() {
  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
  if (!proxyUrl) return undefined;
  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

async function renderMp3Once(voice, text) {
  const agent = await proxyAgent();
  const tts = new MsEdgeTTS({
    ...(agent ? { agent } : {}),
    // Generous deadlines: a proxied or cold connection can take a few
    // seconds to open, and a long segment takes time to stream back.
    connectionTimeoutMs: 30000,
    synthesisTimeoutMs: 60000,
  });
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('Edge TTS returned no audio');
    return buf;
  } finally {
    tts.close();
  }
}

// ---------------------------------------------------------------------------
// Global synthesis limiter + retry ladder (see the reliability note at
// the top of this file). ONE semaphore per server instance caps how many
// Edge TTS syntheses run at once, no matter who asked: the /api/audio
// route serving a listener, or the background warmer. Excess renders
// queue FIFO. The cap is deliberately small: production evidence says
// failure rates climb with concurrency, and a queued render that starts
// a second late beats a parallel render that fails.
// ---------------------------------------------------------------------------

const SYNTH_MAX_CONCURRENT = 3;
const SYNTH_MAX_ATTEMPTS = 3;
const SYNTH_BACKOFF_MS = [500, 1500, 4000]; // before attempts 2 and 3 (+jitter)

let synthActive = 0;
const synthWaiters = []; // FIFO of resolve() fns waiting for a slot

function acquireSynthSlot() {
  if (synthActive < SYNTH_MAX_CONCURRENT) {
    synthActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => synthWaiters.push(resolve));
}

function releaseSynthSlot() {
  const next = synthWaiters.shift();
  if (next) {
    // Hand the slot straight to the next waiter (count unchanged).
    next();
  } else {
    synthActive -= 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Word-count duration estimate for the truncated-render guard. Mirrors
// lib/format.js's calibrated rate (136 wpm); duplicated here because
// format.js imports this module (for audioUrlFor), so importing back
// would be a cycle. It only gates the guard below, never playback.
const GUARD_WORDS_PER_MINUTE = 136;
const GUARD_MIN_WORDS = 20; // shorter scripts are exempt: estimates are noisy
const GUARD_MIN_RATIO = 0.5; // real duration under half the estimate = truncated

/**
 * One synthesis, guarded: holds a global limiter slot, and rejects a
 * render whose real duration is implausibly short for its script (the
 * stream can end "successfully" while truncating the audio; caching
 * that file would amputate the segment forever).
 */
async function synthesizeOnce(voice, text) {
  await acquireSynthSlot();
  try {
    const mp3 = await renderMp3Once(voice, text);
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words >= GUARD_MIN_WORDS) {
      const expectedSec = (words / GUARD_WORDS_PER_MINUTE) * 60;
      const realSec = mp3DurationSeconds(mp3);
      if (realSec < expectedSec * GUARD_MIN_RATIO) {
        throw new Error(
          `Truncated render rejected: ${realSec.toFixed(1)}s of audio for ~${expectedSec.toFixed(1)}s of script`
        );
      }
    }
    return mp3;
  } finally {
    releaseSynthSlot();
  }
}

/**
 * Render with retries: up to SYNTH_MAX_ATTEMPTS attempts, jittered
 * backoff between them. Throws only when every attempt failed; the
 * caller (getSegmentMp3) caches nothing on failure, so a later request
 * runs the ladder again from the top.
 */
async function renderMp3(voice, text) {
  let lastErr;
  for (let attempt = 0; attempt < SYNTH_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const base = SYNTH_BACKOFF_MS[attempt - 1] || 4000;
      await sleep(base + Math.random() * base * 0.5);
    }
    try {
      return await synthesizeOnce(voice, text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Edge TTS render failed');
}

/**
 * Get the MP3 for (voice, text), rendering and caching on first ask.
 * @returns {Promise<{ mp3: Buffer, cacheKey: string, fromCache: boolean }>}
 */
export async function getSegmentMp3(voice, text) {
  const safeText = speechSafeText(text);
  const cacheKey = segmentCacheKey(voice, safeText);

  const hit = mp3Cache.get(cacheKey);
  if (hit) return { mp3: hit, cacheKey, fromCache: true };

  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = renderMp3(voice, safeText)
      .then((mp3) => {
        mp3Cache.set(cacheKey, mp3);
        while (mp3Cache.size > MAX_CACHE_ENTRIES) {
          mp3Cache.delete(mp3Cache.keys().next().value);
        }
        return mp3;
      })
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, pending);
  }
  const mp3 = await pending;
  return { mp3, cacheKey, fromCache: false };
}

// ---------------------------------------------------------------------------
// Server-side pre-render warming.
//
// A cold render costs seconds (measured 1.8-7.9s per segment in
// production) and occasionally fails outright ("Stream closed before
// the synthesis completed"), which is what the player's retry ladder
// exists to absorb. Warming moves that cost off the listener's path:
// every time the queue is built, the segments at the head of the queue
// that are not yet rendered are rendered in the background, so by the
// time any player asks for them they serve at cache-hit speed. All
// warm renders flow through getSegmentMp3, so they share the global
// synthesis limiter and the retry ladder with on-demand renders.
//
// The pass is deliberately early and incremental rather than complete:
// it queues at most WARM_MAX_PER_PASS unrendered segments from roughly
// the first ~45 minutes of the queue, head first, and dedupes against
// the render cache and the in-flight map, so repeated queue builds
// walk coverage forward a pass at a time instead of re-rendering or
// piling up. A failed warm render is swallowed: the segment simply
// stays unrendered and the player's retry ladder handles it when it
// reaches the playhead, exactly as it did before warming existed.
//
// Vercel reality: work started after a response may be cut off when
// the invocation freezes, so the playlist route also hands the pass's
// completion promise to Next's after(), which keeps the invocation
// alive for it (up to the route's maxDuration). Where that is not
// available the renders still proceed on any long-lived instance, and
// because every build re-triggers the pass, a segment missed by one
// pass is the first candidate of the next.
// ---------------------------------------------------------------------------

const WARM_CONCURRENCY = 3;
const WARM_MAX_PER_PASS = 24;
const WARM_TARGET_SECONDS = 45 * 60;
const WARM_MAX_QUEUE = 96;

const warmQueue = []; // { voice, text, key, settle }
const warmQueuedKeys = new Set();
let warmActive = 0;

function pumpWarmQueue() {
  while (warmActive < WARM_CONCURRENCY && warmQueue.length) {
    const job = warmQueue.shift();
    warmQueuedKeys.delete(job.key);
    warmActive += 1;
    getSegmentMp3(job.voice, job.text)
      .catch(() => {
        // Tolerated by design: see the note above.
      })
      .finally(() => {
        warmActive -= 1;
        job.settle();
        pumpWarmQueue();
      });
  }
}

/**
 * Queue background renders for the nearest unrendered segments in
 * `segments` (queue order is play order, so the head comes first),
 * covering roughly the first `targetSeconds` of the queue and at most
 * `maxSegments` new renders. Returns a promise that settles when this
 * pass's renders have all finished or failed; callers that do not need
 * it may ignore it (fire-and-forget), and the playlist route hands it
 * to after().
 */
export function warmSegmentAudio(
  segments,
  { maxSegments = WARM_MAX_PER_PASS, targetSeconds = WARM_TARGET_SECONDS } = {},
) {
  const jobs = [];
  let windowSeconds = 0;
  for (const seg of segments || []) {
    if (jobs.length >= maxSegments || windowSeconds >= targetSeconds) break;
    // Jingles are finished static files; there is nothing to render.
    if (seg.kind === 'jingle') continue;
    windowSeconds += seg.estSeconds || 0;
    if (!seg.voice || !seg.script) continue;
    const key = segmentCacheKey(seg.voice, seg.script);
    if (mp3Cache.has(key) || inFlight.has(key) || warmQueuedKeys.has(key)) {
      continue;
    }
    if (warmQueue.length >= WARM_MAX_QUEUE) break;
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    warmQueue.push({ voice: seg.voice, text: seg.script, key, settle });
    warmQueuedKeys.add(key);
    jobs.push(done);
  }
  pumpWarmQueue();
  return Promise.allSettled(jobs);
}

/** True when (voice, text) is rendered or already rendering. */
export function isSegmentAudioReady(voice, text) {
  const key = segmentCacheKey(voice, text);
  return mp3Cache.has(key) || inFlight.has(key);
}

/**
 * Build the /api/audio URL for a segment script. The URL itself is the
 * cache key (voice + text), which is what makes the immutable HTTP caching
 * on the route safe. `s` is the segment id, carried only for log/debug
 * readability; the route ignores it.
 */
export function audioUrlFor(voice, text, segmentId) {
  const params = new URLSearchParams({ v: voice, t: text });
  if (segmentId) params.set('s', segmentId);
  return `/api/audio?${params.toString()}`;
}
