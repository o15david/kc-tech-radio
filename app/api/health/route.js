import { NextResponse } from 'next/server';
import { getNewsPool, countByCategory } from '../../../lib/ingest';
import { getKansasCityWeather } from '../../../lib/weather';
import { buildPlaylist } from '../../../lib/format';
import { warmSegmentAudio } from '../../../lib/tts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [pool, weather] = await Promise.all([
    getNewsPool(),
    getKansasCityWeather(),
  ]);
  const { segments, bufferSeconds } = buildPlaylist(pool, weather);
  // Health checks build the schedule anyway; use the pass to warm the
  // audio cache for upcoming segments too (fire-and-forget, deduped
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
  });
}
