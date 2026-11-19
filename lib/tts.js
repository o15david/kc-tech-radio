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
// Production note: the in-memory cache resets on serverless cold starts,
// so a cold instance may re-render a segment once. The pre-render warmer
// below (warmSegmentAudio) absorbs most of that: every schedule build
// renders the upcoming window in the background, so listeners rarely
// wait on a cold render. If latency ever still matters, put a persistent
// blob store (e.g. Vercel Blob) behind getSegmentMp3() keyed by the same
// hash; nothing else changes.
// ============================================================================

import { createHash } from 'node:crypto';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const OUTPUT_FORMAT_MP3 = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;

// The output format above is constant-bitrate (96 kbit/s), so an MP3's
// duration follows from its byte size to within a frame or two. The
// player uses this (via the /api/audio duration header, or the audio
// element's own metadata) to build its wall-clock timeline from REAL
// durations instead of word-count estimates.
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

export function segmentCacheKey(voice, text) {
  return createHash('sha256').update(`${voice}\n${text}`).digest('hex');
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

async function renderMp3(voice, text) {
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

/**
 * Get the MP3 for (voice, text), rendering and caching on first ask.
 * @returns {Promise<{ mp3: Buffer, cacheKey: string, fromCache: boolean }>}
 */
export async function getSegmentMp3(voice, text) {
  const cacheKey = segmentCacheKey(voice, text);

  const hit = mp3Cache.get(cacheKey);
  if (hit) return { mp3: hit, cacheKey, fromCache: true };

  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = renderMp3(voice, text)
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
// the synthesis completed"), which is what the player's stall ladder
// exists to absorb. Warming moves that cost off the listener's path:
// every time the schedule is built, the nearest upcoming segments that
// are not yet rendered are rendered in the background, so by the time
// any player asks for them they serve at cache-hit speed.
//
// The pass is deliberately early and incremental rather than complete:
// it queues at most WARM_MAX_PER_PASS unrendered segments from the
// next ~45 minutes of the schedule, nearest first, at bounded
// concurrency, and dedupes against the render cache and the in-flight
// map, so repeated playlist builds (the player polls regularly) walk
// the window forward a pass at a time instead of re-rendering or
// piling up. A failed warm render is swallowed: the segment simply
// stays unrendered and the player's stall ladder handles it at
// airtime, exactly as it did before warming existed.
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
 * `segments` (playlist order is air order, so nearest first), covering
 * roughly the next `targetSeconds` of airtime and at most `maxSegments`
 * new renders. Returns a promise that settles when this pass's renders
 * have all finished or failed; callers that do not need it may ignore
 * it (fire-and-forget), and the playlist route hands it to after().
 */
export function warmSegmentAudio(
  segments,
  { maxSegments = WARM_MAX_PER_PASS, targetSeconds = WARM_TARGET_SECONDS } = {},
) {
  const jobs = [];
  let windowSeconds = 0;
  for (const seg of segments || []) {
    if (jobs.length >= maxSegments || windowSeconds >= targetSeconds) break;
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
