#!/usr/bin/env node
// ===========================================================================
// PERFORMANCES PROOF — proves The Marquee airs, end to end with the
// station's own code, without touching production, and proves David's
// never-stale rule (Nov 24, 2026) at every layer:
//
//   node scripts/performances-proof.mjs
//
// Serves this repo's data/ folder over a throwaway local HTTP server,
// points PERFORMANCE_FEED_URL (plus MUSIC_FEED_URL and
// NEWSLETTER_FEED_URL, so no production JSON feed is consulted) at it,
// then runs the REAL pipeline: lib/ingest.js getNewsPool() ->
// countByCategory() -> lib/format.js buildPlaylist().
//
// Assertions:
//   1. the pool carries performance items, and pool.performanceFilter
//      reports zero ingest-side expired drops for the shipped feed;
//   2. the queue contains a kc-stage (The Marquee) section with
//      performance segments;
//   3. every performance segment's run ends today or later
//      (America/Chicago) and its air date is today or later;
//   4. no performance script contains a URL or says "tonight" about a
//      date that is not today;
//   5. the queue-build gate: a synthetic listing whose run ended
//      yesterday, injected into a copy of the pool, never airs and is
//      counted in expiredPerformances.
// ===========================================================================

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register('./extensionless-loader.mjs', import.meta.url);

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

const server = createServer(async (req, res) => {
  const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '');
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(join(DATA_DIR, name));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.PERFORMANCE_FEED_URL = `${base}/performances-feed.json`;
process.env.MUSIC_FEED_URL = `${base}/music-feed.json`;
process.env.NEWSLETTER_FEED_URL = `${base}/newsletter-feed.json`;

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

try {
  const { getNewsPool, countByCategory } = await import('../lib/ingest.js');
  const { buildPlaylist } = await import('../lib/format.js');

  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const pool = await getNewsPool();
  const counts = countByCategory(pool);
  const perfItems = pool.items.filter((i) => i.category === 'performance');
  console.log(
    `pool: ${pool.items.length} items; performance category count = ${counts.performance}`
  );
  for (const it of perfItems.slice(0, 8)) {
    console.log(`  [${it.perfCategory}] ${it.title} at ${it.venue} — ${it.startDate}..${it.endDate}`);
  }
  check('pool carries performance items', perfItems.length > 0, `${perfItems.length} items`);
  check(
    'ingest dropped no expired listings from the shipped feed',
    (pool.performanceFilter?.droppedExpired ?? -1) === 0,
    JSON.stringify(pool.performanceFilter)
  );

  const result = buildPlaylist(pool, null, Date.now(), [], null);
  const perfSegs = result.segments.filter((s) => s.kind === 'performance');
  const stageSegs = result.segments.filter((s) => s.blockKey === 'kc-stage');
  console.log(`queue: ${result.segments.length} segments; Marquee segments = ${stageSegs.length}`);
  for (const s of perfSegs) {
    console.log(`  [${s.perfCategory}] ${s.script}`);
  }
  check('queue contains The Marquee section', stageSegs.length > 0 && perfSegs.length > 0,
    `${perfSegs.length} listings`);
  check(
    'every aired run ends today or later',
    perfSegs.every((s) => s.endDate >= todayStr),
    `today ${todayStr}`
  );
  check(
    'every air date is today or later',
    perfSegs.every((s) => (s.eventDate || '') >= todayStr)
  );
  check(
    'no performance script contains a URL',
    perfSegs.every((s) => !/https?:\/\//i.test(s.script))
  );
  check(
    '"tonight" is only said about today',
    perfSegs.every(
      (s) => !/tonight/i.test(s.script) || s.eventDate === todayStr
    )
  );
  check(
    'expiredPerformances is reported',
    typeof result.expiredPerformances === 'number',
    `expiredPerformances=${result.expiredPerformances}`
  );

  // Queue-build gate against a synthetic stale listing.
  const yesterday = new Date(`${todayStr}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  const stale = {
    id: 'perf:proof-stale',
    dedupeKey: 'perf:proof-stale',
    title: 'Proof Stale Show',
    link: '',
    summary: '',
    source: 'proof',
    category: 'performance',
    publishedAt: null,
    perfCategory: 'comedy',
    perfKind: 'Stand-up',
    venue: 'Proof Room',
    startDate: yStr,
    endDate: yStr,
    timeText: '7:00 PM',
    preview: '',
    url: '',
  };
  const pool2 = { ...pool, items: [...pool.items, stale] };
  const result2 = buildPlaylist(pool2, null, Date.now(), [], null);
  const staleAired = result2.segments.some((s) => s.headline === 'Proof Stale Show');
  check('synthetic ended-yesterday listing never airs', !staleAired);
  check(
    'queue-build drop is counted',
    result2.expiredPerformances === result.expiredPerformances + 1,
    `before ${result.expiredPerformances}, after ${result2.expiredPerformances}`
  );
} finally {
  server.close();
}

console.log(failures.length ? `PROOF FAILED (${failures.length})` : 'PROOF PASSED');
process.exit(failures.length ? 1 : 0);
