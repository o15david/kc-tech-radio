// ============================================================================
// ARTICLE EXTRACTION — story scripts are built from article substance,
// not from the wire's one-paragraph summary (Nov 19, David: longer
// stories). The text extracted here is the article's OWN words:
// paragraphs lifted verbatim from the feed's full content or from the
// article page, cleaned with the same cleanText the summaries get,
// trimmed at sentence boundaries by the caller. Nothing is generated,
// paraphrased, or padded; when extraction yields too little, the
// caller falls back to the headline+summary script.
//
// What gets stripped, because none of it is the story: script/style
// and chrome blocks (nav, header, footer, aside, figures), bylines,
// photo credits and captions, subscription/cookie/housekeeping
// boilerplate, and link-farm paragraphs. Paragraphs are the unit:
// real articles are written in them, and site chrome mostly is not,
// so a page that yields fewer than the required number of substantive
// paragraphs yields nothing rather than a guess.
// ============================================================================

import { cleanText, trimToSentenceBoundary } from './rss';

// ---------------------------------------------------------------------------
// DEPTH TIERS (David, Nov 19): story depth is tiered by relevance,
// "the more local and relevant the more info." FULL EXPANSION (the
// article-substance treatment) applies to the subject pools and the
// three innermost rings: ai, tech, business, local, state,
// regional. Only the two outermost rings, national and global, STAY
// SUMMARIZED in the current headline+summary form. (David named
// regional in both tiers in his first message, then corrected
// himself: regional is expanded; the summarized pair he meant was
// national and global.) Newsletter is in neither list; it defaults
// to summarized (the expansion list is the affirmative grant) until
// David says otherwise. Enforced in the script builder
// (lib/format.js); ingest only spends article fetches on full-depth
// categories.
// ---------------------------------------------------------------------------
export const FULL_DEPTH_CATEGORIES = new Set([
  'ai', 'tech', 'business', 'local', 'state', 'regional',
]);

export function isFullDepthCategory(category) {
  return FULL_DEPTH_CATEGORIES.has(category);
}

// A body must carry at least this much of the article's own text to
// be worth airing over the summary; below it the story keeps the
// headline+summary script.
export const MIN_BODY_CHARS = 350;
// Stored bodies are capped here (the script trims further, to its
// own budget, at queue-build time in lib/format.js).
export const MAX_BODY_CHARS = 2600;

// Blocks whose contents are never article prose.
const CHROME_BLOCK_RE =
  /<(script|style|noscript|template|iframe|svg|form|nav|header|footer|aside|figure|figcaption|button|select|textarea|object|embed)\b[\s\S]*?<\/\1\s*>/gi;

// Boilerplate that disqualifies a paragraph at ANY length: legal and
// consent furniture, never story text.
const HARD_JUNK_RE =
  /©|all rights reserved|cookie (policy|preferences|settings)|we use cookies|accept (all )?cookies|privacy policy|terms of (use|service)/i;

// Boilerplate that disqualifies a SHORT paragraph: subscription and
// sharing furniture, photo credits, bylines. The same words inside a
// long paragraph are the article's own business and stay.
const SOFT_JUNK_RE =
  /read more|continue reading|click here|sign up|subscribe|subscription|newsletter|follow (us|along)|share this|photo by|image credit|credit:|getty images|associated press photo/i;
const BYLINE_RE = /^by [A-Z][A-Za-z.'-]+( [A-Z][A-Za-z.'-]+){0,3}\b/;

// Inline photo credits ride inside otherwise substantive paragraphs
// ("...(Capitol News Illinois photo by Maggie Dougherty) The bill...")
// where the paragraph-level filters cannot see them. They are
// caption furniture, not story text: strip the parenthetical.
const INLINE_CREDIT_RE = /\s*\([^()]*\b(?:photo|image|photograph|credit)\s+by\b[^()]*\)/gi;

function stripInlineCredits(text) {
  return text.replace(INLINE_CREDIT_RE, '').replace(/\s+/g, ' ').trim();
}

function isSubstantiveParagraph(text) {
  if (text.length < 45) return false; // fragments, captions, datelines
  if (text.includes('://')) return false; // link text, not prose
  if (HARD_JUNK_RE.test(text)) return false;
  if (text.length < 200 && (SOFT_JUNK_RE.test(text) || BYLINE_RE.test(text))) {
    return false;
  }
  return true;
}

/**
 * Extract the article's own text from HTML markup (a feed's
 * content:encoded or a fetched article page).
 *
 * @param html     raw markup (entities may still be encoded)
 * @param options  minParagraphs: substantive paragraphs required
 *                 (feed content is pure article, so 1 suffices; a
 *                 fetched page must prove itself with 2)
 * @returns the article text, paragraphs joined with single spaces
 *          and capped at MAX_BODY_CHARS on a sentence boundary, or
 *          '' when what was found is not substantive article text.
 */
export function extractArticleText(html, { minParagraphs = 1 } = {}) {
  if (!html || typeof html !== 'string') return '';

  let markup = html.replace(/<!--[\s\S]*?-->/g, ' ');
  markup = markup.replace(CHROME_BLOCK_RE, ' ');

  const paragraphs = [];
  const seen = new Set();
  for (const m of markup.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const text = stripInlineCredits(cleanText(m[1]));
    if (!isSubstantiveParagraph(text)) continue;
    if (seen.has(text)) continue; // wires repeat the lede; air it once
    seen.add(text);
    paragraphs.push(text);
  }
  if (paragraphs.length < minParagraphs) return '';

  const joined = paragraphs.join(' ');
  if (joined.length < MIN_BODY_CHARS) return '';
  const body = trimToSentenceBoundary(joined, MAX_BODY_CHARS);
  // trimToSentenceBoundary returns the first sentence whole when no
  // boundary fits the budget; a single sentence that dwarfs the cap
  // is pathological, not substance.
  if (body.length > MAX_BODY_CHARS * 1.5) return '';
  return body.length >= MIN_BODY_CHARS ? body : '';
}
