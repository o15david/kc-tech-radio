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
// so a cold instance may re-render a segment once. If that ever becomes a
// cost/latency problem, put a persistent blob store (e.g. Vercel Blob)
// behind getSegmentMp3() keyed by the same hash; nothing else changes.
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
