// News ingestion: fetch every feed, normalize, dedupe, categorize.
//
// Cost discipline: no paid APIs, no LLM calls. Feed fetches are cached for
// FEED_TTL_MS in module memory (globalThis, so the cache survives across
// requests on a warm serverless instance). A /api/playlist hit therefore
// costs at most one round of RSS fetches per 5 minutes, and usually zero.

import { FEEDS, CATEGORIES } from './feeds';
import { parseFeed } from './rss';

const FEED_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 9000;
const MAX_ITEMS_PER_FEED = 25;
const MAX_SUMMARY_CHARS = 600;

// A browser-like UA: a couple of the local feeds sit behind Cloudflare and
// intermittently challenge obviously-bot user agents.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36 KC-Tech-Radio/1.0';

const cache =
  globalThis.__kctrNewsCache ||
  (globalThis.__kctrNewsCache = {
    fetchedAt: 0,
    items: [],
    feeds: [], // per-feed status: { name, category, ok, count, error }
    inFlight: null,
  });

function normalizeLink(link) {
  try {
    const u = new URL(link);
    // Tracking params make the same story look like different items.
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return link;
  }
}

async function fetchOneFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Let Vercel's data cache share the fetch across instances too.
      next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = parseFeed(xml).slice(0, MAX_ITEMS_PER_FEED);
    const items = parsed.map((item) => ({
      ...item,
      link: normalizeLink(item.link),
      summary: item.summary.slice(0, MAX_SUMMARY_CHARS),
      source: feed.name,
      category: feed.category,
      // Stable id for dedupe and for the player's queue bookkeeping.
      id: item.guid || item.link,
    }));
    return { feed, ok: true, items, error: null };
  } catch (err) {
    return { feed, ok: false, items: [], error: String(err?.message || err) };
  }
}

async function refresh() {
  const results = await Promise.allSettled(FEEDS.map(fetchOneFeed));
  const seen = new Set();
  const items = [];
  const feedStatus = [];

  results.forEach((result, i) => {
    const feed = FEEDS[i];
    const value =
      result.status === 'fulfilled'
        ? result.value
        : { ok: false, items: [], error: String(result.reason) };
    feedStatus.push({
      name: feed.name,
      category: feed.category,
      ok: value.ok,
      count: value.items.length,
      error: value.error,
    });
    for (const item of value.items) {
      const key = normalizeLink(item.link).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  });

  // Newest first within each category is applied at read time; globally we
  // keep a stable order: publishedAt desc, undated items last.
  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

  cache.items = items;
  cache.feeds = feedStatus;
  cache.fetchedAt = Date.now();
  return cache;
}

/**
 * Return the current news pool: { items, feeds, fetchedAt }.
 * Serves from cache while fresh; concurrent callers share one refresh.
 */
export async function getNewsPool() {
  const fresh = Date.now() - cache.fetchedAt < FEED_TTL_MS;
  if (fresh && cache.items.length) return cache;
  if (!cache.inFlight) {
    cache.inFlight = refresh().finally(() => {
      cache.inFlight = null;
    });
  }
  // If we have stale items and a refresh is running, serve stale rather
  // than blocking the stream: the show must go on.
  if (cache.items.length && cache.fetchedAt) return cache;
  await cache.inFlight;
  return cache;
}

/** Items for one category, newest first. Falls back handled by caller. */
export function itemsForCategory(pool, category) {
  return pool.items.filter((item) => item.category === category);
}

export function countByCategory(pool) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const item of pool.items) {
    if (counts[item.category] !== undefined) counts[item.category] += 1;
  }
  return counts;
}
