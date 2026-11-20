// News ingestion: fetch every feed, normalize, dedupe, categorize.
//
// Cost discipline: no paid APIs, no LLM calls. Feed fetches are cached for
// FEED_TTL_MS in module memory (globalThis, so the cache survives across
// requests on a warm serverless instance). A /api/playlist hit therefore
// costs at most one round of RSS fetches per 5 minutes, and usually zero.

import { FEEDS, JSON_FEEDS, CATEGORIES } from './feeds';
import { parseFeed, trimToSentenceBoundary, headlineTokens, cleanText } from './rss';
import { extractArticleText, isFullDepthItem, MAX_BODY_CHARS } from './article';

const FEED_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 9000;
const MAX_ITEMS_PER_FEED = 25;
const MAX_SUMMARY_CHARS = 600;

// ---------------------------------------------------------------------------
// Article bodies: story scripts are built from article substance
// (lib/article.js), not from the wire's summary alone. A pool item
// carries `body` (the article's own text) and `bodySource`:
//   'content'  extracted at ingest from the feed's own full content
//              (content:encoded / Atom content), or from an unusually
//              long feed description; no extra fetch, always fresh.
//   'fetch'    extracted from the article page by the background
//              pass below.
// Bodies are cached by link in cache.articles, so they survive pool
// refreshes (pool items are rebuilt from the wires every refresh;
// the cache is what persists). The fetch pass is bounded the same
// way the rest of ingest is: a per-pass attempt cap, a small
// concurrency, a per-fetch timeout, and a negative cache so a dead
// or paywalled page is not re-fetched every refresh. It runs in the
// background after a refresh is ACCEPTED and mutates the served
// pool's items in place, so it never delays a playlist build and a
// failed pass costs nothing: items without a body simply keep the
// headline+summary script. A rejected (collapsed) refresh starts no
// pass and touches no bodies: the wire-resilience rule is unchanged.
// ---------------------------------------------------------------------------
const ARTICLE_FETCH_TIMEOUT_MS = 7000;
const ARTICLE_FETCH_CONCURRENCY = 8;
const ARTICLE_FETCH_MAX_PER_PASS = 250;
const ARTICLE_CACHE_MAX = 2000;
const ARTICLE_NEGATIVE_TTL_MS = 30 * 60 * 1000;
// A feed description at least this long is itself article substance
// (some wires publish the full lede as the description).
const LONG_DESCRIPTION_MIN_CHARS = 500;

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
    // Topic-dedupe stats of the pool currently being served:
    // { before, after, dropped, clusters } (see dedupeByHeadline).
    dedupe: null,
    // Article-body state (see the note at the top): link -> { body, at }
    // extraction cache ('' body = a negative entry, honored for
    // ARTICLE_NEGATIVE_TTL_MS), the in-flight background pass, and
    // the coverage stats of the pool currently being served.
    articles: new Map(),
    enrichInFlight: null,
    enrich: null,
  });
// A cache object created before article bodies existed (hot reload)
// gains the fields lazily rather than crashing the pass.
if (!cache.articles) cache.articles = new Map();
if (!('enrichInFlight' in cache)) cache.enrichInFlight = null;
if (!('enrich' in cache)) cache.enrich = null;

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

/**
 * The article body a feed item carries for free (full-depth items
 * only: a full-depth category, or a startup story under the
 * classifier in lib/article.js; see the depth-tier note there): the
 * feed's own full content extracted to prose, or, when the wire's
 * description is itself long enough to be substance, the full
 * description trimmed at a sentence boundary. Returns '' when the
 * feed carries neither: the background fetch pass may still get
 * the body from the article page. The raw content markup is never
 * carried into the pool: extraction happens here and it is dropped.
 */
function feedCarriedBody(item, category, source) {
  if (
    !isFullDepthItem({
      category,
      source,
      title: item.title,
      summary: item.summary,
    })
  ) {
    return '';
  }
  if (item.content) {
    const text = extractArticleText(item.content, { minParagraphs: 1 });
    if (text) return text;
  }
  const description = item.summary || '';
  if (description.length >= LONG_DESCRIPTION_MIN_CHARS) {
    const text = trimToSentenceBoundary(description, MAX_BODY_CHARS);
    if (text.length >= LONG_DESCRIPTION_MIN_CHARS) return text;
  }
  return '';
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
    const items = parsed.map((item) => {
      const body = feedCarriedBody(item, feed.category, feed.name);
      return {
        title: item.title,
        publishedAt: item.publishedAt,
        guid: item.guid,
        link: normalizeLink(item.link),
        // Trim at a sentence boundary, never mid-clause (see lib/rss.js).
        summary: trimToSentenceBoundary(item.summary, MAX_SUMMARY_CHARS),
        source: feed.name,
        category: feed.category,
        // Stable id for dedupe and for the player's queue bookkeeping.
        id: item.guid || item.link,
        ...(body ? { body, bodySource: 'content' } : {}),
      };
    });
    return { feed, ok: true, items, error: null };
  } catch (err) {
    return { feed, ok: false, items: [], error: String(err?.message || err) };
  }
}

// ---------------------------------------------------------------------------
// Topic-level dedupe: the same story must never air twice, even when
// several outlets carry it.
//
// The exact-link dedupe in refresh() cannot catch syndication: a States
// Newsroom story ran on Minnesota Reformer, Arkansas Advocate, Missouri
// Independent, and Iowa Capital Dispatch with identical headlines but
// four different links, and a Myanmar ICJ story ran on CBC World, BBC
// World, and France 24. The Nov 19 repeat investigation measured the
// pool at ~200 such near-duplicate pairs in ~1,040 items.
//
// Rule (measured, deliberately conservative): two items with DIFFERENT
// links are the same story when their significant headline tokens
// (lib/rss.js headlineTokens) share at least 4 tokens AND score
// Jaccard >= 0.5 OR containment >= 0.8. Softer same-event coverage,
// different outlets' own reporting on one event (Jaccard ~0.3), stays:
// only near-identical headlines merge. Flagged items are clustered
// (union-find, so a chain of editions lands in one cluster) and each
// cluster keeps ONE item: the higher-priority source wins, priority by
// the station's inside-out ring order (local > state > regional >
// national > global > subject pools), FEEDS roster order within a
// ring, then the newest item. Losers are dropped from the pool
// entirely: they can never air. Music
// listings are exempt: they are not headlines and are already keyed
// by artist/venue/when.
// ---------------------------------------------------------------------------
const DEDUPE_MIN_SHARED_TOKENS = 4;
const DEDUPE_JACCARD_MIN = 0.5;
const DEDUPE_CONTAINMENT_MIN = 0.8;

// Inside-out ring rank by category; subject pools rank after the world
// ring, in roster order among themselves.
const RING_RANK = {
  local: 0,
  state: 1,
  regional: 2,
  national: 3,
  global: 4,
  ai: 5,
  tech: 6,
  business: 7,
  newsletter: 8,
};

const ROSTER = [...FEEDS, ...JSON_FEEDS];
const rosterIndexBySource = new Map(ROSTER.map((f, i) => [f.name, i]));
const rosterIndexByCategory = new Map();
ROSTER.forEach((f, i) => {
  if (!rosterIndexByCategory.has(f.category)) rosterIndexByCategory.set(f.category, i);
});

function dedupePriority(item) {
  const ring = RING_RANK[item.category] ?? 9;
  // Newsletter items carry the newsletter's own name as source, not the
  // feed's; fall back to the category's first roster position.
  const roster =
    rosterIndexBySource.get(item.source) ??
    rosterIndexByCategory.get(item.category) ??
    Number.MAX_SAFE_INTEGER;
  return { ring, roster };
}

// Keeper order: ring, then roster, then newest, then link (a total
// order, so the survivor never depends on iteration order).
function compareKeepers(a, b) {
  const pa = dedupePriority(a);
  const pb = dedupePriority(b);
  if (pa.ring !== pb.ring) return pa.ring - pb.ring;
  if (pa.roster !== pb.roster) return pa.roster - pb.roster;
  const byDate = (b.publishedAt || 0) - (a.publishedAt || 0);
  if (byDate !== 0) return byDate;
  return String(a.link).localeCompare(String(b.link));
}

/**
 * Drop topic-level duplicates from a pool item list (see the rule
 * above). Pure and deterministic. Returns { items, dropped, clusters }:
 * the surviving items in their original relative order, the dropped
 * items, and how many multi-item clusters were collapsed.
 */
export function dedupeByHeadline(items) {
  const candidates = [];
  items.forEach((item, idx) => {
    if (item.category === 'music' || !item.title) return;
    const tokens = headlineTokens(item.title, item.source);
    if (tokens.size < DEDUPE_MIN_SHARED_TOKENS) return;
    candidates.push({
      idx,
      item,
      tokens,
      key: (item.dedupeKey || normalizeLink(item.link)).toLowerCase(),
    });
  });

  // Union-find over flagged pairs, enumerated through an inverted
  // token index so the pool never pays an O(n^2) all-pairs pass.
  const parent = candidates.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const byToken = new Map();
  candidates.forEach((c, ci) => {
    for (const w of c.tokens) {
      if (!byToken.has(w)) byToken.set(w, []);
      byToken.get(w).push(ci);
    }
  });
  const seenPair = new Set();
  for (const idxs of byToken.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const pairKey = `${idxs[a]}:${idxs[b]}`;
        if (seenPair.has(pairKey)) continue;
        seenPair.add(pairKey);
        const A = candidates[idxs[a]];
        const B = candidates[idxs[b]];
        if (A.key === B.key) continue; // same link: exact dedupe's job
        let inter = 0;
        for (const w of A.tokens) if (B.tokens.has(w)) inter++;
        if (inter < DEDUPE_MIN_SHARED_TOKENS) continue;
        const union = A.tokens.size + B.tokens.size - inter;
        const jaccard = union ? inter / union : 0;
        const containment = inter / Math.min(A.tokens.size, B.tokens.size) || 0;
        if (jaccard >= DEDUPE_JACCARD_MIN || containment >= DEDUPE_CONTAINMENT_MIN) {
          const ra = find(idxs[a]);
          const rb = find(idxs[b]);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }
  }

  const clustersByRoot = new Map();
  candidates.forEach((c, ci) => {
    const root = find(ci);
    if (!clustersByRoot.has(root)) clustersByRoot.set(root, []);
    clustersByRoot.get(root).push(c);
  });

  const droppedIdx = new Set();
  const dropped = [];
  let clusters = 0;
  for (const members of clustersByRoot.values()) {
    if (members.length < 2) continue;
    clusters++;
    const sorted = [...members].sort((x, y) => compareKeepers(x.item, y.item));
    for (const loser of sorted.slice(1)) {
      droppedIdx.add(loser.idx);
      dropped.push(loser.item);
    }
  }

  return {
    items: items.filter((_, idx) => !droppedIdx.has(idx)),
    dropped,
    clusters,
  };
}

function parsePublishedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

const MONTH_NAME_TO_NUMBER = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function chicagoTodayString(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// The show's calendar date (YYYY-MM-DD) for a music feed item. The
// builder writes `date` directly; for a feed built before that field
// existed, recover the date from the `when` text ("tonight, Thursday,
// November 19" / "Friday, November 20, 7:30 PM") by taking the
// month/day and the year (of the three around today) that lands
// closest to today. Returns null when no date can be determined; the
// queue builder only filters items whose date is known.
function musicEventDate(it) {
  if (typeof it.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.date)) {
    return it.date;
  }
  const m = /([A-Za-z]+)\s+(\d{1,2})\b/.exec(String(it.when || ''));
  if (!m) return null;
  const month = MONTH_NAME_TO_NUMBER[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const todayStr = chicagoTodayString();
  const thisYear = Number(todayStr.slice(0, 4));
  const todayMs = Date.parse(`${todayStr}T12:00:00Z`);
  let best = null;
  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    const cand = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const diff = Math.abs(Date.parse(`${cand}T12:00:00Z`) - todayMs);
    if (!best || diff < best.diff) best = { cand, diff };
  }
  return best.cand;
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
            eventDate: musicEventDate(it),
            url: typeof it.url === 'string' ? it.url : '',
          };
        });
    } else {
      // newsletter (and any future story-shaped JSON feed)
      items = rawItems
        .filter((it) => it && it.title && it.link)
        .slice(0, MAX_ITEMS_PER_FEED)
        .map((it) => ({
          title: cleanText(String(it.title)),
          link: normalizeLink(String(it.link)),
          summary: trimToSentenceBoundary(cleanText(String(it.summary || '')), MAX_SUMMARY_CHARS),
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

// ---------------------------------------------------------------------------
// Article-body enrichment (see the note at the top of this file)
// ---------------------------------------------------------------------------

function setArticleCache(link, body) {
  cache.articles.set(link, { body, at: Date.now() });
  while (cache.articles.size > ARTICLE_CACHE_MAX) {
    cache.articles.delete(cache.articles.keys().next().value);
  }
}

/** Fetch one article page and extract its text; '' on any failure. */
async function fetchArticleBody(link) {
  try {
    const res = await fetch(link, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html, application/xhtml+xml, */*',
      },
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const type = res.headers.get('content-type') || '';
    if (type && !/text\/html|xhtml|text\/plain/i.test(type)) return '';
    const html = await res.text();
    // A fetched page must prove itself with at least two substantive
    // paragraphs: one stray paragraph is as likely chrome as story.
    return extractArticleText(html.slice(0, 4_000_000), { minParagraphs: 2 });
  } catch {
    return '';
  }
}

/** Apply link-cached bodies to fresh pool items (no fetching). */
function applyCachedBodies(items) {
  for (const item of items) {
    if (item.body || !isFullDepthItem(item) || !item.link) continue;
    const hit = cache.articles.get(item.link);
    if (hit?.body) {
      item.body = hit.body;
      item.bodySource = 'fetch';
    }
  }
}

/** Coverage stats for the pool being served (surfaced by /api/health). */
export function computeEnrichStats(items) {
  const stats = {
    fullDepthStories: 0,
    withBody: 0,
    fromFeedContent: 0,
    fromArticleFetch: 0,
    fallback: 0,
  };
  for (const item of items) {
    if (!isFullDepthItem(item)) continue;
    stats.fullDepthStories += 1;
    if (item.body) {
      stats.withBody += 1;
      if (item.bodySource === 'content') stats.fromFeedContent += 1;
      else stats.fromArticleFetch += 1;
    } else {
      stats.fallback += 1;
    }
  }
  return stats;
}

/**
 * The background fetch pass: walk the served pool freshest first
 * (pool order is publishedAt desc, and the queue is freshest first,
 * so the stories likeliest to air get bodies first), fetch article
 * pages for full-depth items that still lack a body, and set the
 * body on the live item objects. Bounded by ARTICLE_FETCH_MAX_PER_PASS
 * attempts; a link already in the cache (positive, or negative and
 * fresh) is never re-fetched. Never throws.
 */
async function enrichPoolBodies(items) {
  try {
    const targets = items.filter(
      (item) => !item.body && isFullDepthItem(item) && item.link,
    );
    let cursor = 0;
    let attempts = 0;
    const worker = async () => {
      while (cursor < targets.length && attempts < ARTICLE_FETCH_MAX_PER_PASS) {
        const item = targets[cursor];
        cursor += 1;
        const hit = cache.articles.get(item.link);
        if (hit?.body) {
          item.body = hit.body;
          item.bodySource = 'fetch';
          continue;
        }
        if (hit && Date.now() - hit.at < ARTICLE_NEGATIVE_TTL_MS) continue;
        if (attempts >= ARTICLE_FETCH_MAX_PER_PASS) break;
        attempts += 1;
        const body = await fetchArticleBody(item.link);
        setArticleCache(item.link, body);
        if (body) {
          item.body = body;
          item.bodySource = 'fetch';
        }
      }
    };
    await Promise.all(
      Array.from({ length: ARTICLE_FETCH_CONCURRENCY }, () => worker()),
    );
  } catch {
    // Enrichment is best-effort by design: a failed pass leaves the
    // pool exactly as the wires delivered it.
  } finally {
    cache.enrich = computeEnrichStats(cache.items);
  }
}

async function refresh() {
  const results = await Promise.allSettled(FEEDS.map(fetchOneFeed));
  const jsonResults = await Promise.allSettled(JSON_FEEDS.map(fetchJsonFeed));
  const seen = new Set();
  let items = [];
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

  // Topic-level dedupe (see dedupeByHeadline): syndicated copies of
  // the same story collapse to the highest-priority source's item
  // before anything downstream (sorting, the collapse guard, queue
  // building) sees the pool.
  const rawItemCount = items.length;
  const dedupe = dedupeByHeadline(items);
  items = dedupe.items;

  // Newest first within each category is applied at read time; globally we
  // keep a stable order: publishedAt desc, undated items last.
  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

  // Bodies fetched by earlier passes ride the link cache into the
  // fresh pool (pool items are rebuilt every refresh; the cache is
  // what persists). Counts are untouched: the collapse guard below
  // judges exactly the pool it judged before bodies existed.
  applyCachedBodies(items);

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
  cache.dedupe = {
    before: rawItemCount,
    after: items.length,
    dropped: dedupe.dropped.length,
    clusters: dedupe.clusters,
  };
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

  // Article bodies: record the coverage this refresh starts with,
  // then kick the background fetch pass for the items still missing
  // one. The pass mutates the served items in place; playlist builds
  // pick bodies up as they land. A rejected refresh (the return in
  // the collapse branch above) never reaches here, so a collapsed
  // wire starts no fetches and disturbs no bodies.
  cache.enrich = computeEnrichStats(cache.items);
  if (!cache.enrichInFlight) {
    cache.enrichInFlight = enrichPoolBodies(cache.items).finally(() => {
      cache.enrichInFlight = null;
    });
  }
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
