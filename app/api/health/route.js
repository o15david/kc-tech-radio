import { NextResponse } from 'next/server';
import { getNewsPool, countByCategory } from '../../../lib/ingest';
import { getKansasCityWeather } from '../../../lib/weather';
import { getPlayedMap } from '../../../lib/played';
import { buildPlaylist } from '../../../lib/format';
import { warmSegmentAudio } from '../../../lib/tts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [pool, weather, playedMap] = await Promise.all([
    getNewsPool(),
    getKansasCityWeather(),
    getPlayedMap(),
  ]);
  // Social callers removed (David, Nov 24, 2026): health builds the
  // queue with an empty caller list, same as the playlist route.
  const { segments, bufferSeconds, callerCount } = buildPlaylist(
    pool,
    weather,
    Date.now(),
    [],
    playedMap
  );
  // Health checks build the queue anyway; use the pass to warm the
  // audio cache for the queue's head too (fire-and-forget, deduped
  // against the playlist route's passes; see lib/tts.js).
  warmSegmentAudio(segments);
  return NextResponse.json({
    ok: true,
    station: 'KC Tech Radio',
    lastFeedFetchAt: pool.fetchedAt ? new Date(pool.fetchedAt).toISOString() : null,
    totalItems: pool.items.length,
    countsByCategory: countByCategory(pool),
    bufferMinutes: Math.round((bufferSeconds / 60) * 10) / 10,
    weatherAvailable: Boolean(weather),
    // Social callers were removed from the station (David, Nov 24,
    // 2026); callerCount is structurally 0 and kept on the response
    // so its absence is measured, not asserted.
    callerCount,
    socialFeedItems: 0,
    // Per-feed status of the last ACCEPTED refresh. A rejected
    // (collapsed) refresh never overwrites these counts; the failed
    // attempt itself is reported in lastRefresh instead.
    feeds: pool.feeds,
    // The most recent refresh attempt, accepted or not. After a
    // collapse this shows ok: false with the attempted item/feed
    // counts alongside the served pool size, so a wire outage reads
    // as an outage, not as the station quietly shrinking.
    lastRefresh: pool.lastRefresh
      ? {
          ...pool.lastRefresh,
          at: new Date(pool.lastRefresh.at).toISOString(),
        }
      : null,
    wireDegraded: Boolean(pool.lastRefresh && !pool.lastRefresh.ok),
    // Language gate observability (David, Nov 23, 2026): how many
    // items the last accepted refresh dropped as Spanish-language
    // (lib/language.js, applied in lib/ingest.js). Reported on every
    // response so the filter's work is measured, not asserted.
    languageFilter: pool.languageFilter || null,
    // Topic-dedupe stats of the pool being served: how many items the
    // last accepted refresh arrived with, how many survived headline
    // dedupe, and how many syndicated copies were dropped (lib/ingest.js).
    dedupe: pool.dedupe || null,
    // Article-body coverage of the pool being served (lib/ingest.js):
    // of the full-depth categories (ai, tech, business, local, state,
    // regional), how many stories carry an extracted article body,
    // split by where the body came from (the feed's own full content
    // vs the background article-fetch pass), and how many fell back
    // to the headline+summary script.
    articles: pool.enrich || null,
  });
}
