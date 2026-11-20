#!/usr/bin/env node
// ============================================================================
// SOCIAL FEED MERGE — merges caller candidate files into
// data/social-feed.json under the harvest's established merge rule:
//
//   - Existing feed items stay only while their story is still in the
//     live playlist; a caller whose story rotated out rotates out.
//   - New candidates must pass the station's validateSocialItem AND
//     belong to a story in the live playlist.
//   - New items first (strongest engagement first), then kept items;
//     dedupe by text (case-insensitive); cap the feed at 16.
//   - The merged document is re-parsed with the station's own
//     parseSocialFeed before anything is written; a mismatch aborts.
//
//   node scripts/social-feed-merge.mjs \
//     [--candidates data/social-candidates-bluesky.json,data/social-candidates-hackernews.json] \
//     [--feed data/social-feed.json] [--cap 16]
//
// Prints a per-channel yield line (found / passed / merged) and the
// caller mix by platform after the merge, for the harvest report.
// ============================================================================

import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const CANDIDATE_FILES = argValue(
  '--candidates',
  'data/social-candidates-bluesky.json,data/social-candidates-hackernews.json'
).split(',').map((s) => s.trim()).filter(Boolean);
const FEED = argValue('--feed', 'data/social-feed.json');
const CAP = parseInt(argValue('--cap', '16'), 10);

const common = await import('./harvest-common.mjs');
const { validateSocialItem, parseSocialFeed, normalizeSocialLink } = await import('../lib/social.js');
const { fetchLiveStories, playlistLinkSet } = common;

console.log('Merging into the social feed against the live playlist...');
const stories = await fetchLiveStories();
const links = playlistLinkSet(stories);
console.log(`Playlist: ${stories.length} unique stories.`);

let existingDoc = { items: [] };
try {
  existingDoc = JSON.parse(readFileSync(FEED, 'utf8'));
} catch {
  console.log(`No readable existing feed at ${FEED}; starting from empty.`);
}
const beforeCount = Array.isArray(existingDoc.items) ? existingDoc.items.length : 0;
const existingValid = parseSocialFeed(existingDoc);
const kept = existingValid.filter((it) => links.has(normalizeSocialLink(it.storyLink)));
const rotatedOut = existingValid.length - kept.length;
console.log(`Existing feed: ${beforeCount} raw, ${existingValid.length} valid, ${kept.length} kept, ${rotatedOut} rotated out (story left the playlist).`);

const now = new Date().toISOString();
const perChannel = [];
const newItems = [];
for (const file of CANDIDATE_FILES) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log(`Candidates file ${file}: unreadable, skipped.`);
    perChannel.push({ file, found: 0, passed: 0, merged: 0 });
    continue;
  }
  const raw = Array.isArray(doc.candidates) ? doc.candidates : [];
  const valid = [];
  for (const c of raw) {
    const item = validateSocialItem({
      storyLink: c.storyLink,
      platform: c.platform,
      username: c.username,
      text: c.text,
      engagement: c.engagement,
      sourceUrl: c.sourceUrl,
      capturedAt: now,
    });
    if (!item) continue;
    if (!links.has(item.storyLink)) continue;
    valid.push(item);
  }
  perChannel.push({ file, platform: raw[0]?.platform || '(none)', found: raw.length, passed: valid.length, merged: 0, items: valid });
  newItems.push(...valid);
}

// New items first, strongest engagement first (nulls last); then kept.
newItems.sort((a, b) => (b.engagement ?? -1) - (a.engagement ?? -1));
const seen = new Set();
const merged = [];
const mergedSet = new Set();
for (const it of [...newItems, ...kept]) {
  const key = it.text.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  merged.push(it);
  mergedSet.add(it);
  if (merged.length >= CAP) break;
}
for (const ch of perChannel) {
  if (ch.items) ch.merged = ch.items.filter((it) => mergedSet.has(it)).length;
}

const out = {
  generatedAt: now,
  items: merged.map((it) => ({
    capturedAt: it.capturedAt || now,
    engagement: it.engagement,
    platform: it.platform,
    sourceUrl: it.sourceUrl,
    storyLink: it.storyLink,
    text: it.text,
    username: it.username,
  })),
  source: 'kc-tech-radio social feed (assistant-generated, real public reactions)',
};

const finalCheck = parseSocialFeed(out);
if (finalCheck.length !== merged.length) {
  console.error(`FINAL PARSE MISMATCH: merged ${merged.length}, station parser accepts ${finalCheck.length}. Not writing.`);
  process.exit(1);
}
writeFileSync(FEED, `${JSON.stringify(out)}\n`);

const mix = {};
for (const it of merged) mix[it.platform] = (mix[it.platform] || 0) + 1;
console.log('\nPer-channel yield this merge:');
for (const ch of perChannel) {
  console.log(`  ${ch.file}: found ${ch.found}, passed validation ${ch.passed}, merged ${ch.merged}`);
}
console.log(`Caller mix after merge (${merged.length} total): ${Object.entries(mix).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`Wrote ${FEED}: ${merged.length} callers (was ${beforeCount}).`);
process.exit(0);
