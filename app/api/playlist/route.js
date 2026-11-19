import { NextResponse, after } from 'next/server';
import { getNewsPool } from '../../../lib/ingest';
import { getKansasCityWeather } from '../../../lib/weather';
import { buildPlaylist, TIME_ZONE } from '../../../lib/format';
import { warmSegmentAudio } from '../../../lib/tts';

// Always compute fresh from the (cached) pool: the pool itself is cached for
// 5 minutes inside ingest, so this stays cheap while the queue tracks the
// format clock in real time.
export const dynamic = 'force-dynamic';
// Pre-render warming continues after the response via after(); give the
// invocation room to finish a pass.
export const maxDuration = 60;

export async function GET() {
  const [pool, weather] = await Promise.all([
    getNewsPool(),
    getKansasCityWeather(),
  ]);
  const { generatedAt, segments, bufferSeconds } = buildPlaylist(pool, weather);
  // Server-side pre-render (lib/tts.js): warm the audio cache for the
  // nearest upcoming segments so a listener's player finds them already
  // rendered. Pure side effect: it never alters the response, and a
  // failed warm render just leaves that segment to the player's stall
  // ladder. after() keeps the invocation alive for the pass on Vercel;
  // where after() is unavailable the renders still run fire-and-forget,
  // and every playlist build re-triggers the pass, so coverage of the
  // upcoming window is incremental across requests.
  const warming = warmSegmentAudio(segments);
  try {
    after(() => warming);
  } catch {
    // Not a request context that supports after(): the renders are
    // already running; nothing else to do.
  }
  return NextResponse.json({
    station: 'KC Tech Radio',
    timeZone: TIME_ZONE,
    generatedAt,
    bufferSeconds,
    segments,
  });
}
