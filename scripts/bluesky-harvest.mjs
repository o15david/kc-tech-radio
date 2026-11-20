#!/usr/bin/env node
// ============================================================================
// BLUESKY HARVEST — finds real named Bluesky reactions to stories in
// the station's live playlist and writes them as caller candidates.
//
//   node scripts/bluesky-harvest.mjs [--out data/social-candidates-bluesky.json]
//                                    [--stories 15] [--per-story 2]
//
// Channel facts (verified from this network, Nov 19, 2026):
//   - app.bsky.feed.searchPosts needs no credentials on the public
//     AppView host api.bsky.app, and returns named authors (handles),
//     verbatim post text, like counts, and timestamps.
//   - The documented public host public.api.bsky.com is WALLED from
//     this network: the TLS handshake completes and the connection is
//     then cut (empty reply, curl HTTP 000 on repeated tries). This
//     script therefore calls api.bsky.app, the same XRPC method on
//     Bluesky's other public AppView host. If that host ever fails
//     the same way, the script says so plainly and writes an empty
//     candidates file rather than padding.
//
// Matching: a post answers a story when it embeds the story's URL,
// or it shares at least 3 significant tokens and a headline phrase
// (bigram) with the headline and names a distinctive proper noun
// from it. Every post, link shares included, must add words of its
// own: headline restatements, crosspost mirrors, commerce spam, bot
// accounts, and the story outlet's own posts are all filtered out.
// Every survivor still has to pass the station's own
// validateSocialItem (20-280 chars, no URLs, profanity blocklist,
// plausible links) before it becomes a candidate.
//
// Output: data/social-candidates-bluesky.json in the same shape as
// data/social-candidates.json, for scripts/social-feed-merge.mjs.
// ============================================================================

import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const OUT = argValue('--out', 'data/social-candidates-bluesky.json');
const MAX_STORIES = parseInt(argValue('--stories', '15'), 10);
const PER_STORY = parseInt(argValue('--per-story', '2'), 10);
const MAX_POST_AGE_MS = 10 * 24 * 60 * 60 * 1000;

const BSKY_HOST = 'https://api.bsky.app';

const common = await import('./harvest-common.mjs');
const { validateSocialItem } = await import('../lib/social.js');
const {
  fetchLiveStories, pickDiscussableStories, existingFeedTexts,
  loadExistingFeedItems, headlineTokens, sharedTokenCount,
  isHeadlineRestatement, capitalizedTokens,
  ownTokenCount, headlineBigrams, sharedBigramCount,
  normalizeSocialLink, candidatesDoc, fetchJson,
} = common;

// A bare domain-with-path fragment ("futurism.com/future-socie...") is
// a link share stub, not a reaction. Full http(s)/www links are the
// station validator's job; this catches the schemeless kind.
const BARE_LINK_RE = /\b[a-z0-9-]+\.(?:com|net|org|io|co|fm|tv|news|app|social|xyz)\/\S/i;
// Crosspost-mirror format ("... Discussion | hackernews | Author: x"):
// a bot echoing another platform's thread title, not a reaction.
const MIRROR_RE = /\|\s*(hackernews|hn)\b/i;
// Commerce spam: product-listing language or a hashtag stack. A fan
// post can carry a hashtag or two; a listing carries the sales copy.
const COMMERCE_RE = /name & number|shop now|buy now|% off|official merch|get yours/i;

// Generic capitalized words that name the event or award, not the
// story's subject: sharing "Silver Slugger" with a headline does not
// prove a post is about THIS winner. The distinctive tokens are the
// proper nouns left after these are removed.
const GENERIC_CAPS = new Set([
  'silver', 'slugger', 'award', 'awards', 'summit', 'championship',
  'title', 'hall', 'fame', 'ballot', 'final', 'finals', 'series',
  'cup', 'league', 'season', 'week', 'game',
]);

/**
 * The capitalized tokens a reaction to this headline must share at
 * least one of: its distinctive proper nouns, in headline
 * order, minus generic event words. When there are several, the lead
 * one alone is not enough (every ASEAN summit post names ASEAN; only
 * this story's posts name Guterres or Myanmar), so one of the later
 * ones is required.
 */
function requiredCapsTokens(headline, source) {
  const significant = headlineTokens(headline, source);
  const ordered = [];
  for (const raw of String(headline || '').split(/\s+/)) {
    const w = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (
      /^[A-Z]/.test(raw) &&
      significant.has(w) &&
      !GENERIC_CAPS.has(w) &&
      !ordered.includes(w)
    ) {
      ordered.push(w);
    }
  }
  if (ordered.length <= 1) return ordered;
  return ordered.slice(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchPosts(query) {
  const url =
    `${BSKY_HOST}/xrpc/app.bsky.feed.searchPosts` +
    `?q=${encodeURIComponent(query)}&limit=25&sort=latest`;
  const doc = await fetchJson(url, 15000);
  return Array.isArray(doc.posts) ? doc.posts : [];
}

function postSourceUrl(post) {
  const handle = post.author?.handle;
  const rkey = String(post.uri || '').split('/').pop();
  if (!handle || !rkey) return '';
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

/** True when the poster IS the story's own outlet (a self-share). */
function isOutletSelfPost(handle, storyLink) {
  try {
    const host = new URL(storyLink).hostname.replace(/^www\./, '');
    const h = String(handle || '').toLowerCase();
    return h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`);
  } catch {
    return false;
  }
}

/** True for obvious feed/bot accounts (mlbbot, hn100, feedbot...). */
function isBotHandle(handle) {
  const first = String(handle || '').split('.')[0].toLowerCase();
  return /bot$/.test(first) || /^hn\d+$/.test(first) || /^feed/.test(first);
}

async function candidatesForStory(story, seenTexts) {
  const storyTokens = headlineTokens(story.headline, story.source);
  const tokens = [...storyTokens];
  if (tokens.length === 0) return { found: 0, candidates: [] };
  const byLength = [...tokens].sort((a, b) => b.length - a.length);
  const caps = capitalizedTokens(story.headline, story.source);
  // Short natural queries return far more than one long token string:
  // an entity pair, the two longest tokens, then a triple as fallback.
  const queries = [];
  const capList = [...caps];
  if (capList.length >= 2) queries.push(capList.slice(0, 2).join(' '));
  queries.push(byLength.slice(0, 2).join(' '));
  queries.push(byLength.slice(0, 3).join(' '));
  const uniqueQueries = [...new Set(queries)];

  const postsByUri = new Map();
  let anySearchOk = false;
  for (const q of uniqueQueries) {
    try {
      const posts = await searchPosts(q);
      anySearchOk = true;
      for (const p of posts) if (p.uri) postsByUri.set(p.uri, p);
      if (postsByUri.size >= 25) break;
    } catch (err) {
      console.log(`    search failed (${q}): ${err.message}`);
    }
    await sleep(200);
  }
  if (!anySearchOk) return { found: 0, candidates: [], failed: true };
  const posts = [...postsByUri.values()];

  const now = Date.now();
  const storyLinkNorm = normalizeSocialLink(story.link);
  const storyBigrams = headlineBigrams(story.headline, story.source);
  // Restatement and own-words checks compare against the FULL
  // headline token set (no source stripping): a verbatim headline
  // post must compare equal to the headline, outlet name included.
  const fullTokens = headlineTokens(story.headline, '');
  const requiredCaps = requiredCapsTokens(story.headline, story.source);
  const passing = [];
  for (const post of posts) {
    const handle = post.author?.handle;
    const text = String(post.record?.text || '').replace(/\s+/g, ' ').trim();
    if (!handle || !text) continue;

    const createdAt = Date.parse(post.record?.createdAt || '');
    if (Number.isFinite(createdAt) && now - createdAt > MAX_POST_AGE_MS) continue;
    if (BARE_LINK_RE.test(text) || MIRROR_RE.test(text)) continue;
    if (COMMERCE_RE.test(text)) continue;
    if ((text.match(/#\S+/g) || []).length >= 3) continue;
    if (isOutletSelfPost(handle, story.link)) continue;
    if (isBotHandle(handle)) continue;

    // Reaction quality applies to EVERY post, link shares included:
    // embedding the story URL proves the post is about the story,
    // but a bare headline share with no words of its own is a
    // restatement, not a reaction.
    if (isHeadlineRestatement(text, fullTokens)) continue;
    if (ownTokenCount(text, fullTokens) < 3) continue;

    const embedUri = post.record?.embed?.external?.uri;
    const urlMatch = embedUri && normalizeSocialLink(embedUri) === storyLinkNorm;
    if (!urlMatch) {
      // Keyword search is loose: two shared generic words prove
      // nothing. A real match shares at least 3 significant tokens
      // AND at least one headline phrase (bigram), or 5+ tokens.
      const shared = sharedTokenCount(text, storyTokens);
      if (shared < 3) continue;
      if (shared < 5 && sharedBigramCount(text, storyTokens, storyBigrams) < 1) continue;
      // The headline's distinctive proper nouns: a genuine reaction
      // names at least one. This kills same-template different-story
      // matches (every team's roster move shares the generic words,
      // never the team name; every Silver Slugger post names the
      // award, only this story's posts name Witt).
      if (requiredCaps.length > 0) {
        const textTokens = headlineTokens(text, '');
        if (!requiredCaps.some((c) => textTokens.has(c))) continue;
      }
    }

    const item = validateSocialItem({
      storyLink: story.link,
      platform: 'Bluesky',
      username: handle,
      text,
      engagement: typeof post.likeCount === 'number' ? post.likeCount : null,
      sourceUrl: postSourceUrl(post),
      capturedAt: new Date().toISOString(),
    });
    if (!item) continue;
    if (seenTexts.has(item.text.toLowerCase())) continue;
    passing.push(item);
  }

  passing.sort((a, b) => (b.engagement || 0) - (a.engagement || 0));
  const picked = passing.slice(0, PER_STORY);
  for (const item of picked) seenTexts.add(item.text.toLowerCase());
  return { found: posts.length, candidates: picked };
}

// ---------------------------------------------------------------------------
console.log('Bluesky harvest: pulling the live playlist...');
const stories = await fetchLiveStories();
const callerStoryLinks = new Set(
  loadExistingFeedItems().map((it) => normalizeSocialLink(it.storyLink || ''))
);
const targets = pickDiscussableStories(stories, {
  total: MAX_STORIES,
  primaryCap: 8,
  callerStoryLinks,
  primaryCategories: ['local'],
});
console.log(`Playlist: ${stories.length} unique stories; targeting ${targets.length} (local first).`);

const seenTexts = existingFeedTexts();
const candidates = [];
let totalFound = 0;
let failedSearches = 0;
for (const [i, story] of targets.entries()) {
  console.log(`[${i + 1}/${targets.length}] [${story.category}] ${story.headline.slice(0, 80)}`);
  const { found, candidates: found2, failed } = await candidatesForStory(story, seenTexts);
  totalFound += found;
  if (failed) failedSearches += 1;
  for (const item of found2) {
    candidates.push({
      storyHeadline: story.headline,
      storyLink: item.storyLink,
      platform: item.platform,
      username: item.username,
      text: item.text,
      engagement: item.engagement,
      sourceUrl: item.sourceUrl,
    });
    console.log(`    caller: @${item.username} (likes ${item.engagement}): ${item.text.slice(0, 90)}`);
  }
  await sleep(300);
}

if (failedSearches === targets.length && targets.length > 0) {
  console.log(
    '\nBluesky appears UNREACHABLE from this network right now: every search ' +
      'failed. Writing an empty candidates file; nothing was padded.'
  );
}

writeFileSync(OUT, `${JSON.stringify(candidatesDoc('bluesky', candidates), null, 2)}\n`);
console.log(
  `\nBluesky yield: ${totalFound} posts returned, ${candidates.length} passed ` +
    `validation across ${targets.length} stories. Wrote ${OUT}.`
);
process.exit(0);
