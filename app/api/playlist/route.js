import { NextResponse, after } from 'next/server';
import { getNewsPool, kickBodyEnrichment } from '../../../lib/ingest';
import { getKansasCityWeather } from '../../../lib/weather';
import { getPlayedMap } from '../../../lib/played';
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
  const [pool, weather, playedMap] = await Promise.all([
    getNewsPool(),
    getKansasCityWeather(),
    getPlayedMap(),
  ]);
  // Social callers removed (David, Nov 24, 2026): the station no
  // longer airs caller segments, so the playlist is built with an
  // empty caller list and the queue is exactly the just-news queue.
  const socialItems = [];
  const {
    generatedAt,
    segments,
    queueSeconds,
    bufferSeconds,
    callerCount,
    topicGuardSkipped,
    entityBudgetSkipped,
    expiredStories,
    expiredPerformances,
    ageCappedStories,
    neverAiredStories,
    recycledStories,
    poolNeverAired,
    poolRecycled,
    playedExcludedStories,
    playedStoreSize,
    timeline,
    mix,
  } = buildPlaylist(pool, weather, Date.now(), socialItems, playedMap);
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
  // Article-body enrichment gets the same protected window: the
  // fetch pass (lib/ingest.js) runs under after() so a serverless
  // freeze after the response cannot strand it mid-pass.
  const enriching = kickBodyEnrichment(pool.items);
  try {
    after(() => enriching);
  } catch {
    // Not a request context that supports after(): the pass is
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
    // Time-bound expiry observability: stories this build dropped
    // because their date had passed (voter guides for a past election,
    // "Election Day is here" items, stale tonight claims). The drop is
    // never silent; the count rides every response.
    expiredStories,
    // Marquee date-gate observability (David, Nov 24, 2026):
    // performance listings this build dropped because their run had
    // already ended. The drop is never silent; the count rides every
    // response, and a nonzero count here means the feed went stale.
    expiredPerformances,
    // Age-cap observability: recycled stories this build dropped for
    // being older than 72 hours (David's Nov 20, 2026 ruling).
    ageCappedStories,
    // No-repeats observability (David, Nov 21, 2026): every story
    // in this queue is never-played (neverAiredStories), recycling
    // no longer exists (recycledStories is structurally 0 and is
    // reported so its absence is measured, not asserted), and
    // playedExcludedStories counts the pool stories this build
    // held out because the shared timeline already aired them.
    // poolRecycled keeps its slot as that same exclusion count for
    // older consumers. playedStoreSize is the persisted played
    // store's entry count; timeline is the shared broadcast
    // position the thin-client player joins at.
    neverAiredStories,
    recycledStories,
    poolNeverAired,
    poolRecycled,
    playedExcludedStories,
    playedStoreSize,
    timeline,
    // Programming mix observability (David, Nov 20, 2026): the
    // achieved mix for this queue per band (target, story count and
    // airtime shares, candidate pool, shortfall flag), the same
    // never-silent pattern as the counts above.
    mix,
    segments,
  });
}
