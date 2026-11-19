import { NextResponse, after } from 'next/server';
import { getNewsPool } from '../../../lib/ingest';
import { getKansasCityWeather } from '../../../lib/weather';
import { getSocialItems } from '../../../lib/social';
import { buildPlaylist, TIME_ZONE } from '../../../lib/format';
import { warmSegmentAudio } from '../../../lib/tts';

// Always compute fresh from the (cached) pool: the pool itself is cached for
// 5 minutes inside ingest, so this stays cheap while the queue's rotation
// bucket rolls every 30 minutes.
export const dynamic = 'force-dynamic';
// Pre-render warming continues after the response via after(); give the
// invocation room to finish a pass.
export const maxDuration = 60;

export async function GET() {
  const [pool, weather, socialItems] = await Promise.all([
    getNewsPool(),
    getKansasCityWeather(),
    getSocialItems(),
  ]);
  const {
    generatedAt,
    segments,
    queueSeconds,
    bufferSeconds,
    callerCount,
    topicGuardSkipped,
    entityBudgetSkipped,
    neverAiredStories,
    recycledStories,
    poolNeverAired,
    poolRecycled,
  } = buildPlaylist(pool, weather, Date.now(), socialItems);
  // Server-side pre-render (lib/tts.js): warm the audio cache for the
  // segments at the head of the queue so a listener's player finds them
  // already rendered. Pure side effect: it never alters the response, and
  // a failed warm render just leaves that segment to the player's retry
  // ladder. after() keeps the invocation alive for the pass on Vercel;
  // where after() is unavailable the renders still run fire-and-forget,
  // and every playlist build re-triggers the pass, so coverage of the
  // queue head is incremental across requests.
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
    queueSeconds,
    bufferSeconds,
    // The same buffer in MINUTES (queueSeconds / 60, one decimal):
    // consumers reading a minutes field here previously found only
    // the seconds value (~14411) where ~240.2 belonged.
    bufferMinutes: Math.round((bufferSeconds / 60) * 10) / 10,
    callerCount,
    // Guard observability: stories this build held out of the queue
    // as same-event repeats (topic guard) and as over-budget repeats
    // of one dominant entity (entity budget). Both were previously
    // invisible in the response.
    topicGuardSkipped,
    entityBudgetSkipped,
    // Consume-and-replace observability: the served mix (stories
    // in this queue that are never-aired vs recycled from the
    // aired fallback, oldest-aired first) and the pool split at
    // build time. Recycling is never quiet: if fresh inflow ever
    // falls behind consumption, recycledStories climbs visibly.
    neverAiredStories,
    recycledStories,
    poolNeverAired,
    poolRecycled,
    segments,
  });
}
