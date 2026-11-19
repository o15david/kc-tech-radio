#!/usr/bin/env node
// ============================================================================
// SOCIAL FEED BUILDER — builds data/social-feed.json from real Reddit
// reactions to stories in the station's live pool.
//
//   node scripts/social-feed-builder.mjs [--out data/social-feed.json]
//                                        [--stories 40] [--delay 700]
//
// How it works:
//   1. Pull the current story pool with the station's own ingestion
//      (lib/ingest.js getNewsPool), take the ~40 freshest stories.
//   2. For each story, search Reddit's public JSON endpoints for
//      matching threads: a global search plus the subreddit the
//      story's category maps to (local -> r/kansascity, ai ->
//      r/artificial, tech -> r/technology, business -> r/business).
//      A thread matches when its own link IS the story's link (a link
//      post of the article itself) or its title shares at least 2
//      significant tokens with the story headline.
//   3. From the best matching thread (by post score), take the
//      highest-scoring top-level comment that passes the station's
//      own validation (lib/social.js validateSocialItem: 20-280
//      chars, no URLs, no blocklisted words, plausible links). One
//      caller per story, never more.
//   4. Write the feed in the contract lib/social.js consumes.
//
// REAL DATA ONLY: usernames, texts, and engagement (comment score)
// are copied verbatim from Reddit's responses. Nothing is invented,
// paraphrased, or backfilled; a story with no qualifying comment
// simply gets no caller.
//
// Reddit reachability: Reddit's public JSON endpoints bot-wall many
// datacenter networks (HTTP 403 with an HTML challenge page). When
// the first few searches all fail that way this script says so
// plainly, stops early instead of hammering, and writes whatever it
// genuinely found (possibly an empty feed). An honest empty feed
// beats a fabricated full one.
// ============================================================================

import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const OUT = argValue('--out', 'data/social-feed.json');
const MAX_STORIES = parseInt(argValue('--stories', '40'), 10);
const DELAY_MS = parseInt(argValue('--delay', '700'), 10);

const { getNewsPool } = await import('../lib/ingest.js');
const { validateSocialItem, normalizeSocialLink } = await import('../lib/social.js');
const { headlineTokens } = await import('../lib/rss.js');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36 KC-Tech-Radio/1.0 (social feed builder)';

const SUBREDDIT_BY_CATEGORY = {
  local: 'kansascity',
  ai: 'artificial',
  tech: 'technology',
  business: 'business',
};
const ALL_SUBREDDITS = ['kansascity', 'technology', 'artificial', 'business'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let blockedResponses = 0;
let redditBlocked = false;

async function redditJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.includes('json')) {
    // Reddit's bot wall answers 403 (or a 200 HTML challenge on some
    // hosts) with an HTML page instead of JSON.
    if (res.status === 403 || contentType.includes('html')) blockedResponses += 1;
    throw new Error(`HTTP ${res.status} (${contentType.split(';')[0]})`);
  }
  return res.json();
}

function threadMatchesStory(thread, storyTokens, storyLink) {
  if (!thread || thread.stickied) return false;
  if (thread.url && normalizeSocialLink(thread.url) === storyLink) return true;
  const titleTokens = headlineTokens(thread.title || '', '');
  let shared = 0;
  for (const w of titleTokens) if (storyTokens.has(w)) shared += 1;
  return shared >= 2;
}

async function bestCommentForThread(permalink) {
  const doc = await redditJson(
    `https://www.reddit.com${permalink}.json?limit=60&sort=top&depth=1`
  );
  const listing = Array.isArray(doc) ? doc[1] : null;
  const children = listing?.data?.children || [];
  return children
    .filter((c) => c.kind === 't1' && c.data && !c.data.stickied)
    .sort((a, b) => (b.data.score || 0) - (a.data.score || 0));
}

async function findCallerForStory(story) {
  const storyTokens = headlineTokens(story.title, story.source);
  const query = [...storyTokens].slice(0, 6).join(' ') || story.title;
  const searches = [
    `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=month&limit=10`,
  ];
  const sub = SUBREDDIT_BY_CATEGORY[story.category];
  if (sub) {
    searches.push(
      `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&t=month&limit=10`
    );
  }

  const threads = [];
  for (const url of searches) {
    try {
      const doc = await redditJson(url);
      for (const child of doc?.data?.children || []) {
        if (child.kind === 't3') threads.push(child.data);
      }
    } catch (err) {
      console.log(`    search failed: ${err.message}`);
    }
    await sleep(DELAY_MS);
    if (blockedResponses >= 3) {
      redditBlocked = true;
      return null;
    }
  }

  const matches = threads
    .filter((t) => threadMatchesStory(t, storyTokens, normalizeSocialLink(story.link)))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const thread of matches.slice(0, 3)) {
    try {
      const comments = await bestCommentForThread(thread.permalink);
      for (const comment of comments) {
        const item = validateSocialItem({
          storyLink: story.link,
          platform: 'Reddit',
          username: comment.data.author,
          text: comment.data.body,
          engagement: typeof comment.data.score === 'number' ? comment.data.score : null,
          sourceUrl: `https://www.reddit.com${comment.data.permalink}`,
          capturedAt: new Date().toISOString(),
        });
        if (item) return item;
      }
    } catch (err) {
      console.log(`    comments failed for ${thread.permalink}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
console.log('Pulling the live story pool...');
const pool = await getNewsPool();
const stories = pool.items
  .filter((it) => it.category !== 'music' && it.link)
  .slice(0, MAX_STORIES);
console.log(`Pool: ${pool.items.length} items; trying the ${stories.length} freshest stories.`);
console.log(`Subreddits in play: ${ALL_SUBREDDITS.map((s) => `r/${s}`).join(', ')}`);

const items = [];
for (const [i, story] of stories.entries()) {
  if (redditBlocked) break;
  console.log(`[${i + 1}/${stories.length}] ${story.title.slice(0, 80)}`);
  const item = await findCallerForStory(story);
  if (item) {
    items.push(item);
    console.log(`    caller: u/${item.username} (score ${item.engagement}): ${item.text.slice(0, 80)}...`);
  }
  await sleep(DELAY_MS);
}

if (redditBlocked) {
  console.log(
    '\nReddit appears BLOCKED from this network: the public JSON endpoints ' +
      'returned the bot-wall page (HTTP 403 / HTML) on the first searches. ' +
      'Stopping early rather than hammering. The feed below contains only ' +
      'what was genuinely retrieved before the wall (possibly nothing).'
  );
}

const feed = {
  generatedAt: new Date().toISOString(),
  source: 'kc-tech-radio social feed builder (Reddit public JSON)',
  items,
};
writeFileSync(OUT, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`\nWrote ${OUT}: ${items.length} caller(s) matched to ${stories.length} stories tried.`);
process.exit(0);
