// ============================================================================
// TOPIC-DEDUPE CHECK — the same story must never air twice, even when
// several outlets carry it.
//
//   node scripts/dedupe-check.mjs
//
// Rebuilds the RAW pool (the ingest mapping with exact-link dedupe
// only, no headline dedupe) straight from the live feeds, then runs
// lib/ingest.js dedupeByHeadline over it and asserts:
//   1. before/after counts and the flagged-pair pressure in the raw
//      pool (the Nov 19 investigation measured ~200 pairs at threshold
//      in a ~1,040-item pool);
//   2. every raw cluster of near-duplicates collapses to exactly ONE
//      survivor (this is the States Newsroom / Myanmar ICJ guarantee,
//      checked generically so it holds whatever today's wire carries);
//   3. zero flagged pairs remain among the deduped items;
//   4. control pairs (same entity, genuinely different stories, below
//      threshold, neither side in any flagged pair) both survive;
//   5. the served pool from getNewsPool() carries dedupe stats, its
//      size matches them, and it too contains zero flagged pairs.
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
function note(text) {
  console.log(`  ....  ${text}`);
}

const { FEEDS, JSON_FEEDS } = await import('../lib/feeds.js');
const { parseFeed, trimToSentenceBoundary, headlineTokens, cleanText } = await import('../lib/rss.js');
const { dedupeByHeadline, getNewsPool } = await import('../lib/ingest.js');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36 KC-Tech-Radio/1.0';
const MAX_ITEMS_PER_FEED = 25;
const MAX_SUMMARY_CHARS = 600;

function normalizeLink(link) {
  try {
    const u = new URL(link);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return link;
  }
}
const itemKey = (item) => (item.dedupeKey || normalizeLink(item.link)).toLowerCase();

// ------------------------------------------------------------ raw pool
async function fetchRawPool() {
  const seen = new Set();
  const items = [];
  const absorb = (list) => {
    for (const item of list) {
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  };
  await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
          signal: AbortSignal.timeout(9000),
        });
        if (!res.ok) return;
        const parsed = parseFeed(await res.text()).slice(0, MAX_ITEMS_PER_FEED);
        absorb(
          parsed.map((item) => ({
            ...item,
            link: normalizeLink(item.link),
            summary: trimToSentenceBoundary(item.summary, MAX_SUMMARY_CHARS),
            source: feed.name,
            category: feed.category,
            id: item.guid || item.link,
          })),
        );
      } catch {
        /* a dead feed is zero items, same as ingest */
      }
    }),
  );
  await Promise.all(
    JSON_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
          signal: AbortSignal.timeout(9000),
        });
        if (!res.ok) return;
        const doc = await res.json();
        const rawItems = Array.isArray(doc?.items) ? doc.items : [];
        if (feed.category === 'music') {
          absorb(
            rawItems
              .filter((it) => it && it.artist && it.venue)
              .map((it) => {
                const kind = ['announced', 'tonight', 'weekend', 'jazz'].includes(it.kind) ? it.kind : 'announced';
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
                };
              }),
          );
        } else {
          absorb(
            rawItems
              .filter((it) => it && it.title && it.link)
              .slice(0, MAX_ITEMS_PER_FEED)
              .map((it) => ({
                title: cleanText(String(it.title)),
                link: normalizeLink(String(it.link)),
                summary: trimToSentenceBoundary(cleanText(String(it.summary || '')), MAX_SUMMARY_CHARS),
                source: String(it.source || feed.name),
                category: feed.category,
                publishedAt:
                  typeof it.publishedAt === 'number'
                    ? it.publishedAt
                    : typeof it.publishedAt === 'string'
                      ? Date.parse(it.publishedAt) || null
                      : null,
                id: String(it.id || it.link),
              })),
          );
        }
      } catch {
        /* same */
      }
    }),
  );
  return items;
}

// ------------------------------------------------- pair/cluster utils
const MIN_SHARED = 4;
function tokenized(items) {
  return items
    .map((item, idx) => ({ item, idx, tokens: headlineTokens(item.title, item.source), key: itemKey(item) }))
    .filter((c) => c.item.category !== 'music' && c.item.title && c.tokens.size >= MIN_SHARED);
}
function flaggedPairs(list) {
  const toks = tokenized(list);
  const byToken = new Map();
  toks.forEach((c, ci) => {
    for (const w of c.tokens) {
      if (!byToken.has(w)) byToken.set(w, []);
      byToken.get(w).push(ci);
    }
  });
  const seenPair = new Set();
  const pairs = [];
  for (const idxs of byToken.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const pk = `${idxs[a]}:${idxs[b]}`;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);
        const A = toks[idxs[a]];
        const B = toks[idxs[b]];
        if (A.key === B.key) continue;
        let inter = 0;
        for (const w of A.tokens) if (B.tokens.has(w)) inter++;
        if (inter < MIN_SHARED) continue;
        const j = inter / (A.tokens.size + B.tokens.size - inter);
        const c = inter / Math.min(A.tokens.size, B.tokens.size) || 0;
        if (j >= 0.5 || c >= 0.8) pairs.push({ A, B, inter, j, c });
      }
    }
  }
  return pairs;
}
function clustersOf(list, pairs) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const p of pairs) {
    const ra = find(p.A.idx);
    const rb = find(p.B.idx);
    if (ra !== rb) parent.set(ra, rb);
  }
  const byRoot = new Map();
  for (const p of pairs) {
    for (const side of [p.A, p.B]) {
      const root = find(side.idx);
      if (!byRoot.has(root)) byRoot.set(root, new Map());
      byRoot.get(root).set(side.idx, side.item);
    }
  }
  return [...byRoot.values()].map((m) => [...m.values()]);
}

// ---------------------------------------------------------------- run
console.log('Fetching the live wire and rebuilding the raw pool...');
const raw = await fetchRawPool();
const rawPairs = flaggedPairs(raw);
const rawClusters = clustersOf(raw, rawPairs);
console.log(
  `RAW POOL: ${raw.length} items; flagged pairs at threshold: ${rawPairs.length}; ` +
    `clusters: ${rawClusters.length}`,
);

const { items: deduped, dropped, clusters } = dedupeByHeadline(raw);
console.log(`DEDUPED POOL: ${deduped.length} items (dropped ${dropped.length}, clusters collapsed ${clusters})`);
check('pool shrinks by the dropped count', deduped.length === raw.length - dropped.length);
check(
  'clusters collapsed matches the raw cluster count',
  clusters === rawClusters.length,
  `dedupe=${clusters} raw=${rawClusters.length}`,
);

// Every raw cluster reduces to exactly one survivor.
const dedupedKeys = new Set(deduped.map(itemKey));
let badClusters = 0;
for (const members of rawClusters) {
  const survivors = members.filter((m) => dedupedKeys.has(itemKey(m)));
  if (survivors.length !== 1) badClusters++;
}
check('every raw near-duplicate cluster reduces to exactly one survivor', badClusters === 0, `${badClusters} bad`);

// Show the biggest clusters so the known syndication cases are visible.
const shown = [...rawClusters].sort((a, b) => b.length - a.length).slice(0, 4);
for (const members of shown) {
  const survivor = members.find((m) => dedupedKeys.has(itemKey(m)));
  note(
    `cluster of ${members.length}: kept [${survivor?.source}] "${survivor?.title}"; ` +
      `dropped from ${members.filter((m) => m !== survivor).map((m) => m.source).join(', ')}`,
  );
}

// Zero flagged pairs remain.
const remaining = flaggedPairs(deduped);
check('zero flagged pairs remain in the deduped pool', remaining.length === 0, `${remaining.length} remain`);

// Controls: same-entity, below-threshold pairs whose members are in no
// flagged pair must both survive.
const ENTITIES = ['nvidia', 'anthropic', 'openai', 'google', 'trump', 'chiefs', 'missouri', 'ukraine', 'apple', 'amazon'];
const flaggedIdx = new Set();
for (const p of rawPairs) {
  flaggedIdx.add(p.A.idx);
  flaggedIdx.add(p.B.idx);
}
const toks = tokenized(raw);
let controls = 0;
let controlFailures = 0;
for (let i = 0; i < toks.length; i++) {
  for (let j = i + 1; j < toks.length; j++) {
    const A = toks[i];
    const B = toks[j];
    if (A.item.source === B.item.source || A.key === B.key) continue;
    if (flaggedIdx.has(A.idx) || flaggedIdx.has(B.idx)) continue;
    if (!ENTITIES.some((e) => A.tokens.has(e) && B.tokens.has(e))) continue;
    let inter = 0;
    for (const w of A.tokens) if (B.tokens.has(w)) inter++;
    if (inter < 3) continue;
    const jac = inter / (A.tokens.size + B.tokens.size - inter);
    const cont = inter / Math.min(A.tokens.size, B.tokens.size) || 0;
    if (jac >= 0.5 || cont >= 0.8) continue;
    controls++;
    if (!dedupedKeys.has(A.key) || !dedupedKeys.has(B.key)) controlFailures++;
  }
}
note(`control pairs examined: ${controls}`);
check('all below-threshold control stories survive', controlFailures === 0, `${controlFailures} lost`);

// Served pool integration.
const pool = await getNewsPool();
check('served pool carries dedupe stats', !!pool.dedupe, JSON.stringify(pool.dedupe));
check(
  'served pool size matches its dedupe stats',
  pool.dedupe && pool.items.length === pool.dedupe.after,
  `items=${pool.items.length} stats=${JSON.stringify(pool.dedupe)}`,
);
const servedRemaining = flaggedPairs(pool.items);
check('zero flagged pairs in the served pool', servedRemaining.length === 0, `${servedRemaining.length} remain`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
