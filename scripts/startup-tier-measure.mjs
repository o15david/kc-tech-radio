// ============================================================================
// STARTUP TIER MEASUREMENT (Nov 19, David: startup stories join the
// full-expansion tier). Harness, not station code: pulls the live pool
// through the station's own ingest, lets the background article pass
// settle, builds one queue with lib/format.js, and reports:
//
//   - blended story seconds and stories/hour for the queue
//   - how many summarized-tier stories (national, global, newsletter)
//     the startup classifier in lib/article.js flips to full depth,
//     broken out by the signal that caught them (source, funding,
//     founder/accelerator, launch-with-context), with examples
//   - near-miss stories that stayed summarized (launch verb with no
//     startup context, "entrepreneur" mentions, bare "raises")
//
// Run BEFORE the classifier existed it prints the baseline queue
// numbers only (the classifier import is optional). Run after, it
// prints the full flip analysis. Either way the numbers come from
// the same pool and the same queue builder.
// ============================================================================

import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);

const { getNewsPool, computeEnrichStats } = await import('../lib/ingest.js');
const { buildPlaylist, estimateSeconds } = await import('../lib/format.js');
const { trimToSentenceBoundary, ensureTerminalPunctuation } = await import(
  '../lib/rss.js'
);

// The summarized headline+summary script, replicated from
// lib/format.js's fallback form, for the same-queue A/B below:
// what a flipped story's segment would have cost under the old
// gate. An estimate (format.js's cleanSummary has two extra
// defensive trims), close enough to price the rule's effect.
function summarizedScript(item) {
  let s = String(item.summary || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s*(Continue reading|Read more|Read More)[\s\S]*$/, '')
    .replace(/\[…\]|\[\.\.\.\]/g, '')
    .trim();
  s = trimToSentenceBoundary(s, 480);
  const parts = [ensureTerminalPunctuation(item.title)];
  if (s && !s.toLowerCase().startsWith(item.title.toLowerCase().slice(0, 40))) {
    parts.push(s);
  }
  return `${ensureTerminalPunctuation(parts.join(' '))} From ${item.source}.`;
}
let article = null;
try {
  article = await import('../lib/article.js');
} catch {
  article = null;
}

const SUMMARIZED = new Set(['national', 'global', 'newsletter']);

const pool = await getNewsPool();

// Let the background article-fetch pass settle: poll the coverage
// stats until the with-body count stops moving (max ~2 minutes).
let lastWithBody = -1;
let stableRounds = 0;
for (let i = 0; i < 24; i++) {
  const stats = computeEnrichStats(pool.items);
  if (stats.withBody === lastWithBody) {
    stableRounds += 1;
    if (stableRounds >= 2) break;
  } else {
    stableRounds = 0;
    lastWithBody = stats.withBody;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

const queue = buildPlaylist(pool, null);
const stories = queue.segments.filter((s) => s.kind === 'story');
const storySeconds = stories.reduce((a, s) => a + (s.estSeconds || 0), 0);
const blendedAvg = stories.length ? storySeconds / stories.length : 0;
const storiesPerHour = queue.queueSeconds
  ? stories.length / (queue.queueSeconds / 3600)
  : 0;

console.log('=== QUEUE ===');
console.log(`pool items: ${pool.items.length}`);
{
  const byCat = {};
  for (const i of pool.items) byCat[i.category] = (byCat[i.category] || 0) + 1;
  console.log(`pool by category: ${JSON.stringify(byCat)}`);
  const okFeeds = pool.feeds.filter((f) => f.ok).length;
  console.log(`feeds ok: ${okFeeds} of ${pool.feeds.length}`);
}
console.log(`queue stories: ${stories.length}`);
console.log(`queue seconds: ${queue.queueSeconds}`);
console.log(`blended avg story seconds: ${blendedAvg.toFixed(1)}`);
console.log(`stories per hour: ${storiesPerHour.toFixed(1)}`);
console.log(
  `enrich stats: ${JSON.stringify(computeEnrichStats(pool.items))}`,
);

if (article?.classifyStartup) {
  const { classifyStartup, isFullDepthCategory } = article;
  const flips = [];
  for (const item of pool.items) {
    if (!SUMMARIZED.has(item.category)) continue;
    if (isFullDepthCategory(item.category)) continue;
    const reason = classifyStartup(item);
    if (reason) flips.push({ item, reason });
  }
  const byReason = {};
  for (const f of flips) byReason[f.reason] = (byReason[f.reason] || 0) + 1;
  const summarizedCount = pool.items.filter((i) =>
    SUMMARIZED.has(i.category),
  ).length;
  console.log('\n=== STARTUP FLIPS ===');
  console.log(
    `summarized-tier pool stories: ${summarizedCount}; flipped to full depth: ${flips.length}`,
  );
  console.log(`by signal: ${JSON.stringify(byReason)}`);
  console.log(
    `flipped with a body ready: ${flips.filter((f) => f.item.body).length} of ${flips.length}`,
  );

  // Same-queue A/B: this queue was built WITH the startup rule.
  // Price the flipped stories that actually aired at their
  // summarized-form length instead, and recompute the blended
  // numbers for the identical queue: that is the rule's own
  // effect, with pool drift removed.
  const itemByLink = new Map(pool.items.map((i) => [i.link, i]));
  let deltaSeconds = 0;
  let airedFlips = 0;
  let queuedFlips = 0;
  for (const seg of stories) {
    const item = itemByLink.get(seg.link);
    if (!item || !SUMMARIZED.has(item.category)) continue;
    const reason = classifyStartup(item);
    if (!reason) continue;
    queuedFlips += 1;
    console.log(
      `QUEUED FLIP [${reason}] segment ${seg.estSeconds}s, body ${item.body ? 'ready' : 'missing'}: ${item.title}`,
    );
    if (!item.body) continue;
    const alt = estimateSeconds(summarizedScript(item));
    airedFlips += 1;
    deltaSeconds += seg.estSeconds - alt;
    console.log(
      `AIRED FLIP [${reason}] ${seg.estSeconds}s full-depth vs ~${alt}s summarized: ${item.title}`,
    );
  }
  console.log(`flipped stories present in this queue: ${queuedFlips}`);
  const beforeStorySeconds = storySeconds - deltaSeconds;
  const beforeQueueSeconds = queue.queueSeconds - deltaSeconds;
  console.log('\n=== SAME-QUEUE A/B (startup rule on vs off) ===');
  console.log(`flipped stories aired in this queue: ${airedFlips}`);
  console.log(
    `blended avg story seconds: ${(beforeStorySeconds / stories.length).toFixed(1)} before -> ${blendedAvg.toFixed(1)} after`,
  );
  console.log(
    `stories per hour: ${(stories.length / (beforeQueueSeconds / 3600)).toFixed(1)} before -> ${storiesPerHour.toFixed(1)} after`,
  );
  for (const f of flips) {
    console.log(
      `FLIP [${f.reason}] (${f.item.category}/${f.item.source}) ${f.item.title}`,
    );
  }

  // Near misses: summarized stories carrying a launch verb or the
  // word "entrepreneur" or a bare "raises" that the rule deliberately
  // did NOT flip (no startup context / no money / not a listed signal).
  const LAUNCHISH =
    /\b(launches|launched|launching|unveils|unveiled|debuts|debuted|rolls out|entrepreneurs?|raises|raised)\b/i;
  const misses = pool.items.filter(
    (i) =>
      SUMMARIZED.has(i.category) &&
      !classifyStartup(i) &&
      LAUNCHISH.test(`${i.title} ${i.summary || ''}`),
  );
  console.log('\n=== NEAR MISSES (stayed summarized) ===');
  console.log(`near-miss candidates: ${misses.length}`);
  for (const m of misses.slice(0, 15)) {
    console.log(`MISS (${m.category}/${m.source}) ${m.title}`);
  }
} else {
  console.log('\n(classifier not present yet: baseline run)');
}
