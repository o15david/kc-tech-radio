// ============================================================================
// HARVEST COMMON — shared helpers for the social caller channel harvest
// scripts (scripts/bluesky-harvest.mjs, scripts/hn-harvest.mjs).
//
// The harvest pattern (same as the cron-driven Reddit/Facebook/X pass):
// read the LIVE playlist, pick the most discussable stories (local
// first, then the big tech hooks, roughly 15), find real named public
// reactions to those stories on one channel, validate every candidate
// with the station's own rules (lib/social.js validateSocialItem), and
// write a candidates file in the same shape as data/social-candidates.json
// for scripts/social-feed-merge.mjs to merge into data/social-feed.json.
//
// REAL DATA ONLY: nothing here invents a username, a reaction, or an
// engagement number. A channel that returns nothing attributable
// produces an empty candidates file and an honest zero in the report.
// ============================================================================

export const PLAYLIST_URL = 'https://kc-tech-radio.vercel.app/api/playlist';
export const FEED_PATH = 'data/social-feed.json';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36 KC-Tech-Radio/1.0 (social harvest)';

const { readFileSync } = await import('node:fs');
const { normalizeSocialLink } = await import('../lib/social.js');
const { headlineTokens } = await import('../lib/rss.js');

export { normalizeSocialLink, headlineTokens };

/** Fetch JSON with the station user agent and a hard timeout. */
export async function fetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The unique stories in the live playlist, in queue order:
 * [{ headline, link, category, source }]. Caller and station segments
 * are excluded; duplicates by normalized link keep the first airing.
 */
export async function fetchLiveStories() {
  const doc = await fetchJson(PLAYLIST_URL, 30000);
  const seen = new Set();
  const stories = [];
  for (const seg of doc.segments || []) {
    if (seg.kind !== 'story' || !seg.link || !seg.headline) continue;
    const key = normalizeSocialLink(seg.link);
    if (seen.has(key)) continue;
    seen.add(key);
    stories.push({
      headline: seg.headline,
      link: seg.link,
      category: seg.category || '',
      source: seg.source || '',
    });
  }
  return stories;
}

/** The set of normalized story links in the live playlist. */
export function playlistLinkSet(stories) {
  return new Set(stories.map((s) => normalizeSocialLink(s.link)));
}

const HOOK_TOKENS = new Set([
  'championship', 'title', 'trade', 'traded', 'win', 'wins', 'won',
  'award', 'playoff', 'playoffs', 'final', 'finals', 'ipo', 'debut',
  'hack', 'hacked', 'breach', 'sign', 'signs', 'deal', 'upset',
  'clinch', 'clinches', 'advance', 'advances', 'beat', 'beats',
  'record', 'launch', 'raises', 'funding', 'wins',
]);
const ROUTINE_TOKENS = new Set([
  'roster', 'transactions', 'injuries', 'injury', 'recalled',
  'optioned', 'designated', 'waived', 'probable', 'questionable',
]);

/**
 * How likely a story is to draw public reaction: hook words
 * (championship, trade, IPO, win) raise it, routine transaction-wire
 * words (roster moves, injury lists) lower it, proper-noun density
 * raises it, and a story that already carries a caller in the feed is
 * proven discussable. Deterministic; ties break by playlist order.
 */
export function discussabilityScore(story, callerStoryLinks = null) {
  const tokens = headlineTokens(story.headline, story.source);
  let score = 0;
  for (const t of tokens) {
    if (HOOK_TOKENS.has(t)) score += 2;
    if (ROUTINE_TOKENS.has(t)) score -= 2;
  }
  const caps = story.headline.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).length;
  score += Math.min(caps, 5);
  if (callerStoryLinks && callerStoryLinks.has(normalizeSocialLink(story.link))) {
    score += 3;
  }
  return score;
}

/**
 * Pick the discussable target stories: the highest-scoring stories
 * in the primary categories first (local for the station's home-turf
 * channels; ai/tech/business for Hacker News, where local stories
 * are never submitted), then the highest-scoring stories overall,
 * until roughly `total` are picked.
 */
export function pickDiscussableStories(stories, options = {}) {
  const {
    total = 15,
    primaryCap = 8,
    callerStoryLinks = null,
    primaryCategories = ['local'],
  } = options;
  const scored = stories.map((s, i) => ({
    s,
    i,
    score: discussabilityScore(s, callerStoryLinks),
  }));
  const byScore = (a, b) => b.score - a.score || a.i - b.i;
  const picked = scored
    .filter((x) => primaryCategories.includes(x.s.category))
    .sort(byScore)
    .slice(0, primaryCap);
  const pickedLinks = new Set(picked.map((x) => normalizeSocialLink(x.s.link)));
  for (const x of [...scored].sort(byScore)) {
    if (picked.length >= total) break;
    const key = normalizeSocialLink(x.s.link);
    if (pickedLinks.has(key)) continue;
    pickedLinks.add(key);
    picked.push(x);
  }
  return picked.map((x) => x.s);
}

/**
 * The headline's capitalized tokens (lowercased, significant only):
 * the proper nouns a genuine reaction to this story would mention.
 */
export function capitalizedTokens(headline, source) {
  const significant = headlineTokens(headline, source);
  const caps = new Set();
  for (const raw of String(headline || '').split(/\s+/)) {
    const w = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (/^[A-Z]/.test(raw) && significant.has(w)) caps.add(w);
  }
  return caps;
}

/** True when fewer than half the headline's words are capitalized. */
export function isSentenceCase(headline) {
  const words = String(headline || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
  return caps / words.length < 0.5;
}

/**
 * How many significant tokens a reaction contributes beyond the
 * headline's own words. A genuine reaction adds vocabulary of its
 * own; a restatement or bot mirror adds almost none.
 */
export function ownTokenCount(text, storyTokens) {
  const textTokens = headlineTokens(text, '');
  let own = 0;
  for (const w of textTokens) if (!storyTokens.has(w)) own += 1;
  return own;
}

/**
 * The headline's significant-token bigrams, in headline order
 * (stopwords and source tokens removed before pairing, the same
 * sequence headlineTokens is built from). A post about the same
 * event usually reuses at least one of these phrases ("silver
 * slugger", "red sox", "kansas city"); a post that merely shares
 * scattered generic words with the headline almost never does.
 */
export function headlineBigrams(headline, source) {
  const significant = headlineTokens(headline, source);
  const seq = String(headline || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/[^a-z0-9]+/)
    .filter((w) => significant.has(w));
  const grams = new Set();
  for (let i = 0; i + 1 < seq.length; i++) grams.add(`${seq[i]} ${seq[i + 1]}`);
  return grams;
}

/** How many of the story's headline bigrams appear in a text. */
export function sharedBigramCount(text, storyTokens, storyBigrams) {
  const seq = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .split(/[^a-z0-9]+/)
    .filter((w) => storyTokens.has(w));
  let shared = 0;
  for (let i = 0; i + 1 < seq.length; i++) {
    if (storyBigrams.has(`${seq[i]} ${seq[i + 1]}`)) shared += 1;
  }
  return shared;
}

/** The current feed document's items (raw), or [] when unreadable. */
export function loadExistingFeedItems(feedPath = FEED_PATH) {
  try {
    const doc = JSON.parse(readFileSync(feedPath, 'utf8'));
    return Array.isArray(doc.items) ? doc.items : [];
  } catch {
    return [];
  }
}

/** Lowercased texts already in the feed, for cross-channel dedupe. */
export function existingFeedTexts(feedPath = FEED_PATH) {
  return new Set(
    loadExistingFeedItems(feedPath).map((it) => String(it.text || '').toLowerCase())
  );
}

/**
 * Significant-token overlap between a reaction text and a headline:
 * how many of the headline's significant tokens appear in the text.
 * The same matching spirit as the Reddit builder (a thread matches at
 * 2+ shared significant tokens).
 */
export function sharedTokenCount(text, storyTokens) {
  const textTokens = headlineTokens(text, '');
  let shared = 0;
  for (const w of textTokens) if (storyTokens.has(w)) shared += 1;
  return shared;
}

/**
 * True when a post is a headline restatement rather than a reaction:
 * nearly all of its significant tokens come from the headline itself,
 * so it adds no words of its own. News-outlet shares fail this;
 * genuine reactions pass it.
 */
export function isHeadlineRestatement(text, storyTokens) {
  const textTokens = headlineTokens(text, '');
  if (textTokens.size === 0) return true;
  let fromHeadline = 0;
  for (const w of textTokens) if (storyTokens.has(w)) fromHeadline += 1;
  return fromHeadline / textTokens.size >= 0.9 && textTokens.size <= storyTokens.size + 2;
}

/** Write a candidates file in the data/social-candidates.json shape. */
export function candidatesDoc(channelLabel, candidates) {
  return {
    run: `kc-tech-radio-social-harvest ${channelLabel} ${new Date().toISOString()}`,
    harvestedAt: new Date().toISOString(),
    candidates,
  };
}
