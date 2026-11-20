#!/usr/bin/env node
// ============================================================================
// HACKER NEWS HARVEST — finds real named Hacker News comments on
// stories in the station's live playlist and writes them as caller
// candidates.
//
//   node scripts/hn-harvest.mjs [--out data/social-candidates-hackernews.json]
//                               [--stories 30] [--per-story 2]
//
// Channel facts (verified from this network, Nov 19, 2026):
//   - The HN Algolia search API (hn.algolia.com) is public and needs
//     no credentials. It returns named usernames and verbatim comment
//     text.
//   - HN discussion is anchored to submissions, so matching is by
//     URL, never by loose keyword: a story qualifies only when an HN
//     submission's URL IS the playlist story's URL (normalized). That
//     makes HN a tech-story channel; local stories essentially never
//     appear there, and this script reports those as no-submission
//     rather than reaching for keyword lookalikes.
//   - Only top-level comments (direct replies to the submission) are
//     taken: they are the reactions to the story itself, not to
//     another commenter. Algolia does not expose comment scores, so
//     engagement is null, never invented.
//
// Every candidate still has to pass the station's own
// validateSocialItem (20-280 chars after cleaning, no URLs, profanity
// blocklist) before it is written.
//
// Output: data/social-candidates-hackernews.json in the same shape as
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
const OUT = argValue('--out', 'data/social-candidates-hackernews.json');
// HN submission density is low (about 1 in 7 tech stories in the
// Nov 19 probe) and a URL lookup is two cheap API calls, so this
// channel scans more stories than the others: 30, tech first.
const MAX_STORIES = parseInt(argValue('--stories', '30'), 10);
const PER_STORY = parseInt(argValue('--per-story', '2'), 10);

const ALGOLIA = 'https://hn.algolia.com/api/v1/search';

const common = await import('./harvest-common.mjs');
const { validateSocialItem } = await import('../lib/social.js');
const { cleanText } = await import('../lib/rss.js');
const {
  fetchLiveStories, pickDiscussableStories, existingFeedTexts,
  loadExistingFeedItems, normalizeSocialLink, candidatesDoc, fetchJson,
} = common;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findSubmission(story) {
  const storyLinkNorm = normalizeSocialLink(story.link);
  const queries = [story.link, story.headline];
  for (const q of queries) {
    const url = `${ALGOLIA}?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=5`;
    const doc = await fetchJson(url, 12000);
    for (const hit of doc.hits || []) {
      if (hit.url && normalizeSocialLink(hit.url) === storyLinkNorm) {
        return { id: hit.objectID, title: hit.title, points: hit.points, numComments: hit.num_comments };
      }
    }
  }
  return null;
}

async function topLevelComments(storyId) {
  const url = `${ALGOLIA}?tags=comment,story_${storyId}&hitsPerPage=50`;
  const doc = await fetchJson(url, 12000);
  return (doc.hits || []).filter(
    (h) => String(h.parent_id) === String(h.story_id) && h.author && h.comment_text
  );
}

async function candidatesForStory(story, seenTexts) {
  let submission;
  try {
    submission = await findSubmission(story);
  } catch (err) {
    console.log(`    submission search failed: ${err.message}`);
    return { found: 0, candidates: [], failed: true };
  }
  if (!submission) return { found: 0, candidates: [], noSubmission: true };

  let comments;
  try {
    comments = await topLevelComments(submission.id);
  } catch (err) {
    console.log(`    comments failed: ${err.message}`);
    return { found: 0, candidates: [], failed: true };
  }

  const passing = [];
  for (const hit of comments) {
    const text = cleanText(hit.comment_text);
    const item = validateSocialItem({
      storyLink: story.link,
      platform: 'Hacker News',
      username: hit.author,
      text,
      engagement: null, // Algolia does not expose comment scores.
      sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      capturedAt: new Date().toISOString(),
    });
    if (!item) continue;
    if (seenTexts.has(item.text.toLowerCase())) continue;
    passing.push(item);
  }
  // Substantive first: comments in the 60-280 band before short ones.
  passing.sort((a, b) => {
    const band = (t) => (t.length >= 60 ? 0 : 1);
    return band(a.text) - band(b.text) || b.text.length - a.text.length;
  });
  const picked = passing.slice(0, PER_STORY);
  for (const item of picked) seenTexts.add(item.text.toLowerCase());
  return { found: comments.length, candidates: picked, submission };
}

// ---------------------------------------------------------------------------
console.log('Hacker News harvest: pulling the live playlist...');
const stories = await fetchLiveStories();
const callerStoryLinks = new Set(
  loadExistingFeedItems().map((it) => normalizeSocialLink(it.storyLink || ''))
);
const targets = pickDiscussableStories(stories, {
  total: MAX_STORIES,
  primaryCap: MAX_STORIES,
  callerStoryLinks,
  primaryCategories: ['ai', 'tech', 'business'],
});
console.log(`Playlist: ${stories.length} unique stories; targeting ${targets.length} (tech first).`);

const seenTexts = existingFeedTexts();
const candidates = [];
let totalFound = 0;
let withSubmission = 0;
let failedSearches = 0;
for (const [i, story] of targets.entries()) {
  console.log(`[${i + 1}/${targets.length}] [${story.category}] ${story.headline.slice(0, 80)}`);
  const r = await candidatesForStory(story, seenTexts);
  totalFound += r.found;
  if (r.failed) failedSearches += 1;
  if (r.submission) {
    withSubmission += 1;
    console.log(`    HN submission: "${String(r.submission.title || '').slice(0, 60)}" (${r.submission.points} pts, ${r.submission.numComments} comments)`);
  }
  for (const item of r.candidates) {
    candidates.push({
      storyHeadline: story.headline,
      storyLink: item.storyLink,
      platform: item.platform,
      username: item.username,
      text: item.text,
      engagement: item.engagement,
      sourceUrl: item.sourceUrl,
    });
    console.log(`    caller: ${item.username}: ${item.text.slice(0, 90)}`);
  }
  await sleep(300);
}

writeFileSync(OUT, `${JSON.stringify(candidatesDoc('hackernews', candidates), null, 2)}\n`);
console.log(
  `\nHacker News yield: ${withSubmission}/${targets.length} stories had an HN submission, ` +
    `${totalFound} top-level comments returned, ${candidates.length} passed validation. Wrote ${OUT}.`
);
if (failedSearches > 0) console.log(`(${failedSearches} searches failed; see log lines above.)`);
process.exit(0);
