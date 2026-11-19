// News ingestion: fetch every feed, normalize, dedupe, categorize.
//
// Cost discipline: no paid APIs, no LLM calls. Feed fetches are cached for
// FEED_TTL_MS in module memory (globalThis, so the cache survives across
// requests on a warm serverless instance). A /api/playlist hit therefore
// costs at most one round of RSS fetches per 5 minutes, and usually zero.

import { FEEDS, JSON_FEEDS, CATEGORIES } from './feeds';
import { parseFeed, trimToSentenceBoundary } from './rss';

const FEED_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 9000;
const MAX_ITEMS_PER_FEED = 25;
const MAX_SUMMARY_CHARS = 600;

// ---------------------------------------------------------------------------
// Wire resilience: a collapsed refresh never replaces the last good pool.
//
// On Nov 19, 2026 at 12:22 PM CT one ingest refresh timed out on 57 of 58
// feeds and replaced a healthy ~1,045-item pool with 5 items; the station
// aired marked filler until the next refresh happened to restore it. A
// mass timeout is a network event, not an editorial one, so a refresh
// whose item count falls under COLLAPSE_RATIO of the pool currently being
// served is treated as FAILED: the last good pool keeps serving, the
// attempt is recorded in cache.lastRefresh (surfaced by /api/health),
// and the next retry is due after COLLAPSE_RETRY_MS instead of the full
// 5-minute TTL, so recovery is quick when the network returns.
//
// The guard is not a pin: if collapses keep coming for
// COLLAPSE_ACCEPT_AFTER_MS of wall clock, the newest pool is accepted as
// the new reality (a wire can genuinely shrink: feeds die, a source
// folds). Until then a shrinking-but-plausible refresh (at or above the
// ratio) flows through immediately, as do all healthy refreshes.
// ---------------------------------------------------------------------------
const COLLAPSE_RATIO = 0.25;
const COLLAPSE_RETRY_MS = 60 * 1000;
const COLLAPSE_ACCEPT_AFTER_MS = 30 * 60 * 1000;

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
    feeds: [], // per-feed status of the last ACCEPTED refresh: { name, category, ok, count, error }
    inFlight: null,
    // Wire-resilience state (see the constants above). retryAt is the
    // earliest time a post-collapse retry may start; collapseSince /
    // collapseStreak track the current run of rejected refreshes;
    // lastRefresh describes the most recent attempt, accepted or not.
    retryAt: 0,
    collapseSince: 0,
    collapseStreak: 0,
    lastRefresh: null,
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
      // Trim at a sentence boundary, never mid-clause (see lib/rss.js).
      summary: trimToSentenceBoundary(item.summary, MAX_SUMMARY_CHARS),
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

function parsePublishedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// Assistant-generated JSON feeds (newsletter + music). Same contract as
// RSS from the pool's point of view; an unreachable or malformed feed is
// zero items, never an error. Item shapes are documented in README.md.
async function fetchJsonFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const rawItems = Array.isArray(doc?.items) ? doc.items : [];

    let items;
    if (feed.category === 'music') {
      items = rawItems
        .filter((it) => it && it.artist && it.venue)
        .map((it) => {
          const kind = ['announced', 'tonight', 'weekend', 'jazz'].includes(it.kind)
            ? it.kind
            : 'announced';
          // Shows are identified by who/where/when, not by URL: several
          // listings can share one venue or ticketing link.
          const id = `music:${kind}:${it.artist}|${it.venue}|${it.when || ''}`;
          return {
            id,
            dedupeKey: id,
            title: `${it.artist} at ${it.venue}`,
            link: typeof it.url === 'string' ? it.url : '',
            summary: '',
            source: feed.name,
            category: 'music',
            publishedAt: null,
            musicKind: kind,
            artist: String(it.artist),
            venue: String(it.venue),
            when: String(it.when || ''),
            url: typeof it.url === 'string' ? it.url : '',
          };
        });
    } else {
      // newsletter (and any future story-shaped JSON feed)
      items = rawItems
        .filter((it) => it && it.title && it.link)
        .slice(0, MAX_ITEMS_PER_FEED)
        .map((it) => ({
          title: String(it.title),
          link: normalizeLink(String(it.link)),
          summary: trimToSentenceBoundary(String(it.summary || ''), MAX_SUMMARY_CHARS),
          // Attribution is the newsletter's own name, carried in the feed.
          source: String(it.source || feed.name),
          category: feed.category,
          publishedAt: parsePublishedAt(it.publishedAt),
          id: String(it.id || it.link),
        }));
    }
    return { feed, ok: true, items, error: null };
  } catch (err) {
    return { feed, ok: false, items: [], error: String(err?.message || err) };
  }
}

async function refresh() {
  const results = await Promise.allSettled(FEEDS.map(fetchOneFeed));
  const jsonResults = await Promise.allSettled(JSON_FEEDS.map(fetchJsonFeed));
  const seen = new Set();
  const items = [];
  const feedStatus = [];

  const absorb = (feed, value) => {
    feedStatus.push({
      name: feed.name,
      category: feed.category,
      ok: value.ok,
      count: value.items.length,
      error: value.error,
    });
    for (const item of value.items) {
      const key = (item.dedupeKey || normalizeLink(item.link)).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  };

  results.forEach((result, i) => {
    const value =
      result.status === 'fulfilled'
        ? result.value
        : { ok: false, items: [], error: String(result.reason) };
    absorb(FEEDS[i], value);
  });
  jsonResults.forEach((result, i) => {
    const value =
      result.status === 'fulfilled'
        ? result.value
        : { ok: false, items: [], error: String(result.reason) };
    absorb(JSON_FEEDS[i], value);
  });

  // Newest first within each category is applied at read time; globally we
  // keep a stable order: publishedAt desc, undated items last.
  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

  // --- Collapse guard (see the wire-resilience note at the top) --------
  const now = Date.now();
  const servedCount = cache.items.length;
  const okFeeds = feedStatus.filter((f) => f.ok).length;
  const collapsed =
    servedCount > 0 && items.length < servedCount * COLLAPSE_RATIO;
  const collapseExpired =
    collapsed &&
    cache.collapseSince > 0 &&
    now - cache.collapseSince >= COLLAPSE_ACCEPT_AFTER_MS;

  if (collapsed && !collapseExpired) {
    // Reject the refresh: keep serving the last good pool and its
    // per-feed status untouched, record the failed attempt, and make
    // the next retry due in COLLAPSE_RETRY_MS rather than a full TTL.
    cache.collapseStreak += 1;
    if (!cache.collapseSince) cache.collapseSince = now;
    cache.retryAt = now + COLLAPSE_RETRY_MS;
    cache.lastRefresh = {
      at: now,
      ok: false,
      collapsed: true,
      accepted: false,
      attemptedItems: items.length,
      attemptedOkFeeds: okFeeds,
      totalFeeds: feedStatus.length,
      servedItems: servedCount,
      collapseStreak: cache.collapseStreak,
    };
    return cache;
  }

  // Accept: a healthy refresh, a plausible shrink, the first pool ever,
  // or a collapse that has lasted COLLAPSE_ACCEPT_AFTER_MS and is
  // therefore treated as the wire's new reality.
  cache.items = items;
  cache.feeds = feedStatus;
  cache.fetchedAt = now;
  cache.retryAt = 0;
  cache.lastRefresh = {
    at: now,
    ok: true,
    collapsed,
    accepted: true,
    acceptedAfterSustainedCollapse: collapseExpired,
    attemptedItems: items.length,
    attemptedOkFeeds: okFeeds,
    totalFeeds: feedStatus.length,
    servedItems: items.length,
    collapseStreak: 0,
  };
  cache.collapseSince = 0;
  cache.collapseStreak = 0;
  return cache;
}

/**
 * Return the current news pool: { items, feeds, fetchedAt, lastRefresh }.
 * Serves from cache while fresh; concurrent callers share one refresh.
 * After a rejected (collapsed) refresh, the pool is served as usual but
 * a retry becomes due after COLLAPSE_RETRY_MS instead of the full TTL,
 * and retries are not started more often than that even under constant
 * playlist traffic: a down wire gets probed once a minute, not on every
 * request.
 */
export async function getNewsPool() {
  const now = Date.now();
  const ttlFresh = now - cache.fetchedAt < FEED_TTL_MS;
  const retryDue = cache.retryAt > 0 && now >= cache.retryAt;
  if (ttlFresh && !retryDue && cache.items.length) return cache;
  if (!cache.inFlight) {
    if (cache.retryAt > 0 && now < cache.retryAt && cache.items.length) {
      return cache; // collapsed wire, retry not yet due: serve last good
    }
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
