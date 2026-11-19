import { NextResponse } from 'next/server';
import { getNewsPool, countByCategory } from '../../../lib/ingest';
import { getKansasCityWeather } from '../../../lib/weather';
import { buildPlaylist } from '../../../lib/format';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [pool, weather] = await Promise.all([
    getNewsPool(),
    getKansasCityWeather(),
  ]);
  const { bufferSeconds } = buildPlaylist(pool, weather);
  return NextResponse.json({
    ok: true,
    station: 'KC Tech Radio',
    lastFeedFetchAt: pool.fetchedAt ? new Date(pool.fetchedAt).toISOString() : null,
    totalItems: pool.items.length,
    countsByCategory: countByCategory(pool),
    bufferMinutes: Math.round((bufferSeconds / 60) * 10) / 10,
    weatherAvailable: Boolean(weather),
    feeds: pool.feeds,
  });
}
