// ============================================================================
// WIRE-RESILIENCE CHECK — a collapsed refresh never replaces the last
// good pool (the Nov 19, 12:22 PM incident: 57 of 58 feeds timed out
// and a ~1,045-item pool was replaced by 5 items).
//
//   node scripts/wire-resilience-check.mjs
//
// Drives the REAL lib/ingest.js with a stubbed global fetch:
//   good mode      every feed answers with 10 items (~560-item pool)
//   collapsed mode every feed but one throws; the survivor returns 5
// Asserts: the good pool survives consecutive collapses untouched, the
// failed attempts are recorded in pool.lastRefresh (what /api/health
// serializes), retries are gated by retryAt, a healthy refresh clears
// the streak, and a collapse sustained past the acceptance window is
// finally accepted as the wire's new reality. Also asserts ingest-side
// summary trimming lands on sentence boundaries.
// ============================================================================

import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const { FEEDS } = await import('../lib/feeds.js');

let mode = 'good';
const NASTY_SUMMARY =
  'The chipmaker opened the week with a major announcement that caught the whole industry by surprise. ' +
  'Analysts said the move could reshape the market for years, with more than 10,000 GPUs, delivering ' +
  'capacity that rivals said would take them quarters to match on their own roadmaps and budgets. ' +
  'The company declined to give a timeline, but people familiar with the matter said shipments begin ' +
  'early next year, and preorders are already open for the largest customers in North America and Europe. ' +
  'Shares rose in early trading as investors weighed the announcement against a crowded field of rivals. ' +
  'Vendors at the show said the announcement was the talk of the floor, and several smaller suppliers ' +
  'quietly raised their own forecasts before the closing bell rang on a busy day of trading downtown.';

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function rssXml(feedUrl, count) {
  const tag = hashStr(feedUrl);
  const items = [];
  for (let i = 0; i < count; i++) {
    const summary =
      feedUrl === FEEDS[0].url && i === 0
        ? NASTY_SUMMARY
        : `Summary number ${i} for this wire item, complete and self-contained.`;
    items.push(
      `<item><title>Story ${i} from ${tag}</title>` +
        `<link>https://example.com/${tag}/${i}</link>` +
        `<guid>https://example.com/${tag}/${i}</guid>` +
        `<description>${summary}</description>` +
        `<pubDate>Wed, 19 Nov 2026 12:00:00 GMT</pubDate></item>`,
    );
  }
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>stub</title>${items.join('')}</channel></rss>`;
}

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('.json')) {
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }
  if (mode === 'collapsed') {
    if (u === FEEDS[0].url) {
      return new Response(rssXml(u, 5), { status: 200 });
    }
    throw new Error('The operation timed out');
  }
  return new Response(rssXml(u, 10), { status: 200 });
};

const { getNewsPool } = await import('../lib/ingest.js');
const cache = globalThis.__kctrNewsCache;

// Force a refresh cycle and wait for it to land: expire the TTL (a
// stale sentinel 10 minutes in the past, so a test can prove a
// rejected refresh did not move fetchedAt) and any retry gate, kick
// getNewsPool, then await the in-flight refresh.
let staleSentinel = 0;
async function forceRefresh() {
  staleSentinel = Date.now() - 10 * 60 * 1000;
  cache.fetchedAt = staleSentinel;
  cache.retryAt = 0;
  const served = getNewsPool();
  if (cache.inFlight) await cache.inFlight;
  await served;
  return cache;
}

// 1. Healthy wire: full pool, refresh recorded as ok.
let pool = await getNewsPool();
check('good wire builds a full pool', pool.items.length >= 500, `${pool.items.length} items`);
check('healthy refresh recorded ok', pool.lastRefresh?.ok === true && pool.lastRefresh?.collapsed === false);
const goodCount = pool.items.length;

// 2. Ingest-side summary trimming lands on a sentence boundary.
const nasty = pool.items.find((it) => it.link === `https://example.com/${hashStr(FEEDS[0].url)}/0`);
check(
  'ingest trims long summaries at a sentence boundary',
  Boolean(nasty) &&
    /[.!?]["'”’)\]]*$/.test(nasty.summary) &&
    nasty.summary.length <= 600 &&
    nasty.summary.length < NASTY_SUMMARY.length,
  nasty ? `ends "...${nasty.summary.slice(-50)}" (${nasty.summary.length} of ${NASTY_SUMMARY.length} chars)` : 'item not found',
);

// 3. First collapse: pool untouched, attempt recorded, retry in 60s.
mode = 'collapsed';
pool = await forceRefresh();
check('collapsed refresh does not replace the pool', pool.items.length === goodCount, `${pool.items.length} items`);
check('pool fetch time untouched by the rejected refresh', pool.fetchedAt === staleSentinel, `fetchedAt=${pool.fetchedAt}, sentinel=${staleSentinel}`);
check(
  'failed attempt recorded in lastRefresh',
  pool.lastRefresh?.ok === false &&
    pool.lastRefresh?.collapsed === true &&
    pool.lastRefresh?.attemptedItems === 5 &&
    pool.lastRefresh?.servedItems === goodCount &&
    pool.lastRefresh?.collapseStreak === 1,
  JSON.stringify(pool.lastRefresh),
);
check('retry scheduled 60s out, not a full TTL', cache.retryAt - pool.lastRefresh.at === 60 * 1000, `retryAt-lastRefresh.at=${cache.retryAt - pool.lastRefresh.at}`);

// 4. Retry gating: TTL expired but retryAt still in the future means
//    no new refresh is started under playlist traffic.
const lastAttemptAt = pool.lastRefresh.at;
cache.fetchedAt = 0;
cache.retryAt = Date.now() + 60 * 1000;
await getNewsPool();
check('retry gate holds: no refresh before retryAt', cache.inFlight === null && cache.lastRefresh.at === lastAttemptAt);

// 5. Second collapse after the retry comes due: streak grows, pool holds.
pool = await forceRefresh();
check('second collapse also rejected', pool.items.length === goodCount && pool.lastRefresh?.collapseStreak === 2, `streak=${pool.lastRefresh?.collapseStreak}`);

// 6. Recovery: a healthy refresh flows through and clears the streak.
mode = 'good';
pool = await forceRefresh();
check(
  'healthy refresh after collapses is accepted and clears the streak',
  pool.items.length === goodCount &&
    pool.fetchedAt > staleSentinel &&
    pool.lastRefresh?.ok === true &&
    pool.lastRefresh?.collapseStreak === 0 &&
    cache.collapseSince === 0 &&
    cache.retryAt === 0,
  JSON.stringify(pool.lastRefresh),
);

// 7. Sustained collapse: past the acceptance window the newest pool is
//    accepted as the wire's new reality (the guard is not a pin).
mode = 'collapsed';
cache.collapseSince = Date.now() - 31 * 60 * 1000;
pool = await forceRefresh();
check(
  'collapse sustained past 30 min is accepted',
  pool.items.length === 5 &&
    pool.lastRefresh?.ok === true &&
    pool.lastRefresh?.acceptedAfterSustainedCollapse === true,
  JSON.stringify(pool.lastRefresh),
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
