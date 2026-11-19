import { getSegmentMp3, mp3DurationSeconds } from '../../../lib/tts';
import { ALLOWED_VOICES } from '../../../lib/voices';

// GET /api/audio?v=<voice>&t=<script text>[&s=<segment id>]
//
// Renders (or serves from cache) the MP3 for one queue segment. The URL
// fully determines the audio: segments are deterministic, so the same URL
// always yields the same bytes, which is why the response carries year-long
// immutable cache headers for browsers and the Vercel CDN. The in-memory
// cache in lib/tts.js (keyed by SHA-256 of voice + text) means a warm
// instance renders each segment exactly once. Rendering itself is
// hardened in lib/tts.js: a global per-instance concurrency limiter,
// retries with backoff, a truncated-render guard, and failures are never
// cached — this route returns 502 only after that whole ladder fails,
// and the player then retries, degrades to browser speech for the one
// segment, or skips it.
//
// Node runtime is required: Edge TTS runs over a WebSocket (the `ws`
// package), which the Edge runtime cannot do.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A cold render of a long segment can take a few seconds.
export const maxDuration = 60;

const MAX_TEXT_CHARS = 4000; // a segment script is a few hundred chars

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const voice = searchParams.get('v') || '';
  const text = searchParams.get('t') || '';

  if (!ALLOWED_VOICES.includes(voice)) {
    return new Response('Unknown voice', { status: 400 });
  }
  if (!text || text.length > MAX_TEXT_CHARS) {
    return new Response('Missing or oversized script text', { status: 400 });
  }

  try {
    const { mp3, fromCache } = await getSegmentMp3(voice, text);
    return new Response(mp3, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(mp3.length),
        // The renders are constant-bitrate, so the duration follows from
        // the byte size. Reported for diagnostics and sampling audits;
        // playback itself is sequential and never times on it.
        'X-Audio-Duration-Seconds': mp3DurationSeconds(mp3).toFixed(3),
        // Safe forever: the URL is the content's identity.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Audio-Cache': fromCache ? 'memory-hit' : 'rendered',
      },
    });
  } catch (err) {
    // The player falls back to browser speechSynthesis on a non-200, so a
    // TTS outage degrades the voice, never the stream.
    console.error('Edge TTS render failed:', err);
    return new Response('Speech synthesis failed', { status: 502 });
  }
}
