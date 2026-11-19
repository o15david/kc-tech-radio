import { NextResponse } from 'next/server';
import { getNewsPool } from '../../../lib/ingest';
import { getKansasCityWeather } from '../../../lib/weather';
import { buildPlaylist, TIME_ZONE } from '../../../lib/format';

// Always compute fresh from the (cached) pool: the pool itself is cached for
// 5 minutes inside ingest, so this stays cheap while the queue tracks the
// format clock in real time.
export const dynamic = 'force-dynamic';

export async function GET() {
  const [pool, weather] = await Promise.all([
    getNewsPool(),
    getKansasCityWeather(),
  ]);
  const { generatedAt, segments, bufferSeconds } = buildPlaylist(pool, weather);
  return NextResponse.json({
    station: 'KC Tech Radio',
    timeZone: TIME_ZONE,
    generatedAt,
    bufferSeconds,
    segments,
  });
}
