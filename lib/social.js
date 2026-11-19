// ============================================================================
// SOCIAL CALLERS — real public reactions to stories the station airs,
// presented like callers phoning in.
//
// The reactions live OUTSIDE Vercel (Reddit / X / Facebook have no usable
// public wire for this), so they arrive as an assistant-generated JSON
// feed, the same pattern as the newsletter and music feeds: a small
// document at SOCIAL_FEED_URL (default: data/social-feed.json in this
// repo) that the station fetches with the same caching and forgiving
// failure handling as RSS. Unreachable, malformed, or empty means zero
// callers, never an error and never filler.
//
// Feed contract (documented in README.md, "Social callers"):
//
//   { "generatedAt": "2026-11-19T14:00:00.000Z",
//     "items": [
//       { "storyLink": "https://example.com/the-story",
//         "platform": "Reddit",            // "Reddit" | "X" | "Facebook"
//         "username": "some_redditor",
//         "text": "The reaction, verbatim from the public post.",
//         "engagement": 128,               // number, or null when unknown
//         "sourceUrl": "https://www.reddit.com/r/.../comment/...",
//         "capturedAt": "2026-11-19T13:55:00.000Z" }
//     ] }
//
// Every item is validated and filtered HERE, deterministically, before
// the queue builder ever sees it (see validateSocialItem): length
// bounds, no URLs, a basic profanity blocklist, no duplicate texts, a
// plausible story link. The queue builder (lib/format.js) then enforces
// placement: at most one caller per story, at most 16 per queue, each
// immediately after its story, read by the co-host voice.
// ============================================================================

import { SOCIAL_FEED } from './feeds';
import { cleanText } from './rss';

const FEED_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 9000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36 KC-Tech-Radio/1.0';

export const SOCIAL_PLATFORMS = ['Reddit', 'X', 'Facebook'];
export const SOCIAL_TEXT_MIN_CHARS = 20;
export const SOCIAL_TEXT_MAX_CHARS = 280;

// Basic profanity blocklist for caller text (and usernames). Word-
// boundary matched, case-insensitive. Deliberately small: this is a
// broadcast-clean floor, not a moderation system.
export const SOCIAL_PROFANITY_BLOCKLIST = [
  'fuck', 'fucking', 'shit', 'shitty', 'bitch', 'asshole', 'bastard',
  'damn', 'dammit', 'crap', 'piss', 'dick', 'cock', 'pussy', 'slut',
  'whore', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'cunt',
];
const PROFANITY_RE = new RegExp(
  `\\b(?:${SOCIAL_PROFANITY_BLOCKLIST.join('|')})\\b`,
  'i'
);
const URL_RE = /https?:\/\/|www\.\S+/i;

/** True when the text contains a blocklisted word (word boundaries). */
export function hasBlockedWord(text) {
  return PROFANITY_RE.test(String(text || ''));
}

/** True when the text contains a URL (http(s) or a bare www. link). */
export function hasUrl(text) {
  return URL_RE.test(String(text || ''));
}

/**
 * Normalize a link the way ingestion does (tracking parameters and
 * hash stripped), so a feed item's storyLink matches the pool item's
 * link even when the feed was built from a decorated URL.
 */
export function normalizeSocialLink(link) {
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

function isPlausibleUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate and normalize ONE raw feed item. Returns the clean item, or
 * null when the item fails any rule:
 *   - platform is one of Reddit / X / Facebook
 *   - storyLink is a plausible http(s) URL (normalized)
 *   - username is a non-empty string with no URL and no blocked word
 *   - text (after cleanText) is 20-280 chars, contains no URL and no
 *     blocklisted word
 *   - engagement is kept only when it is a finite number >= 0,
 *     otherwise null
 *   - sourceUrl is kept only when it is a plausible URL, else ''
 * Pure and deterministic; used by the station ingest AND by
 * scripts/social-feed-builder.mjs, so a feed built anywhere is held to
 * exactly the rules the station enforces.
 */
export function validateSocialItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!SOCIAL_PLATFORMS.includes(raw.platform)) return null;
  if (!isPlausibleUrl(raw.storyLink)) return null;

  const username = String(raw.username || '').trim();
  if (!username || username.length > 60) return null;
  if (hasUrl(username) || hasBlockedWord(username)) return null;

  const text = cleanText(String(raw.text || ''));
  if (text.length < SOCIAL_TEXT_MIN_CHARS || text.length > SOCIAL_TEXT_MAX_CHARS) {
    return null;
  }
  if (hasUrl(text) || hasBlockedWord(text)) return null;

  const engagement =
    typeof raw.engagement === 'number' &&
    Number.isFinite(raw.engagement) &&
    raw.engagement >= 0
      ? raw.engagement
      : null;

  return {
    storyLink: normalizeSocialLink(String(raw.storyLink).trim()),
    platform: raw.platform,
    username,
    text,
    engagement,
    sourceUrl: isPlausibleUrl(raw.sourceUrl) ? String(raw.sourceUrl).trim() : '',
    capturedAt:
      typeof raw.capturedAt === 'string' && raw.capturedAt ? raw.capturedAt : null,
  };
}

/**
 * Validate a whole feed document ({ generatedAt, items }). Returns the
 * clean items in feed order, with duplicate texts dropped (first one
 * wins, compared case-insensitively on the normalized text). A
 * malformed document yields [].
 */
export function parseSocialFeed(doc) {
  const rawItems = Array.isArray(doc?.items) ? doc.items : [];
  const seenTexts = new Set();
  const items = [];
  for (const raw of rawItems) {
    const item = validateSocialItem(raw);
    if (!item) continue;
    const key = item.text.toLowerCase();
    if (seenTexts.has(key)) continue;
    seenTexts.add(key);
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Feed fetching (cached, forgiving — the ingest pattern)
// ---------------------------------------------------------------------------

const socialCache =
  globalThis.__kctrSocialCache ||
  (globalThis.__kctrSocialCache = { fetchedAt: 0, items: [], inFlight: null });

async function fetchSocialFeed() {
  try {
    const res = await fetch(SOCIAL_FEED.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    return parseSocialFeed(doc);
  } catch {
    return [];
  }
}

/**
 * The current social caller items (validated). Serves from a 5-minute
 * in-memory cache; a failed fetch is zero items, never an error.
 */
export async function getSocialItems() {
  const now = Date.now();
  if (now - socialCache.fetchedAt < FEED_TTL_MS && socialCache.fetchedAt) {
    return socialCache.items;
  }
  if (!socialCache.inFlight) {
    socialCache.inFlight = fetchSocialFeed()
      .then((items) => {
        socialCache.items = items;
        socialCache.fetchedAt = Date.now();
        return items;
      })
      .finally(() => {
        socialCache.inFlight = null;
      });
  }
  if (socialCache.fetchedAt) return socialCache.items; // serve stale
  return socialCache.inFlight;
}
