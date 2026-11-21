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
// items.
//
// STARTUP ADDITION (David, later Nov 19): "startup stories can also
// be expanded." A story in a summarized category (national, global,
// newsletter) that is ABOUT a startup joins the full-depth tier via
// the deterministic classifier below (classifyStartup). AI and tech
// needed no change: both were already full-depth categories.
// ---------------------------------------------------------------------------
export const FULL_DEPTH_CATEGORIES = new Set([
  'ai', 'tech', 'business', 'local', 'state', 'regional', 'science',
]);

export function isFullDepthCategory(category) {
  return FULL_DEPTH_CATEGORIES.has(category);
}

// ---------------------------------------------------------------------------
// STARTUP CLASSIFIER (David, Nov 19): how "startup story" is decided.
//
// Deterministic pattern matching over the item's source, headline,
// and summary. No language model, no invented data. A story is a
// startup story when ANY of these rules fires, checked in order;
// classifyStartup returns the name of the rule that fired (the
// measurement harness in scripts/startup-tier-measure.mjs reports
// the split), or null when none does.
//
//   'source'   The item's source is an exclusively startup-focused
//              outlet: STARTUP_SOURCES below. Today that is
//              Startland News and Silicon Prairie News, the two
//              startup-ecosystem wires on the roster. (Both RSS
//              feeds sit in the local ring, already full depth; the
//              rule's real work is on newsletter items, which carry
//              the newsletter's own name as their source: Startland's
//              newsletter items arrive as category 'newsletter' with
//              source 'Startland News'.) Broader outlets that cover
//              startups among other things (TechCrunch, Hacker News,
//              The Hustle) are deliberately NOT source-listed; their
//              startup stories are caught by the text rules below.
//
//   'funding'  The headline or summary carries a funding-round
//              signal: a named round (Series A-E, pre-seed, a seed
//              round, an angel round, a funding round), the phrase
//              "venture capital" or a venture round/funding/debt, or
//              a money pattern: a money verb (raises, secures,
//              closes, lands, bags, nets) with a dollar amount close
//              behind it, or a dollar amount tied to a round/funding
//              mention. A bare "raises" with no money and no round
//              ("raises concerns", "raises questions") does NOT
//              fire. The money patterns (never the named rounds) are
//              vetoed by campaign context (CAMPAIGN_RE below):
//              politicians "raise" money too, and a candidate who
//              raised $100,000 for a House race is not a startup
//              funding story. Named rounds need no veto: campaigns
//              do not close Series A rounds.
//
//   'founder'  The headline or summary carries a founder/accelerator
//              signal: founder or co-founder, the word startup or
//              start-up itself, accelerator, incubator, Y
//              Combinator, Techstars, pitch competition, demo day,
//              venture-backed, or a company emerging from stealth.
//              (The word "entrepreneur" is deliberately NOT a
//              signal: it appears in plenty of non-startup profiles.)
//
//   'launch'   The headline or summary carries a launch verb
//              (launches, unveils, debuts, rolls out) AND a startup
//              context in the same text: a funding or founder signal
//              above, or an explicit early-stage marker (early-stage,
//              new company, new venture). A launch verb ALONE never
//              fires: a giant public company's product launch or an
//              earnings-season "launch" stays summarized unless the
//              text also ties it to a startup.
//
// isFullDepthItem is the single gate both the script builder
// (lib/format.js) and ingest's body coverage (lib/ingest.js) use:
// full depth when the category is a full-depth category OR the
// classifier calls the story a startup story.
// ---------------------------------------------------------------------------
export const STARTUP_SOURCES = new Set(['Startland News', 'Silicon Prairie News']);

// Named rounds and venture vocabulary: unambiguous startup funding
// signals, never vetoed.
const FUNDING_NAMED_RE = new RegExp(
  [
    '\\bseries [a-e]\\b',
    '\\bpre-?seed\\b',
    '\\bseed (round|funding|stage|capital)\\b',
    '\\bangel (round|funding|investors?)\\b',
    '\\bventure capital\\b',
    '\\bventure (round|funding|debt)\\b',
    '\\bfunding round\\b',
  ].join('|'),
  'i',
);

// Money patterns: a raise/seize verb with a dollar amount, or a
// dollar amount tied to a round. Vetoed by CAMPAIGN_RE (below).
const FUNDING_MONEY_RE = new RegExp(
  [
    '\\b(raises|raised|raising|secures|secured|closes|closed|lands|landed|bags|bagged|nets|netted)\\b[^.!?]{0,60}?\\$\\s?\\d',
    '\\$\\s?\\d+(?:\\.\\d+)?\\s?(?:million|billion|m|b)\\b[^.!?]{0,40}?\\b(round|funding)\\b',
    '\\b(round|funding)\\b[^.!?]{0,30}?\\$\\s?\\d',
  ].join('|'),
  'i',
);

// Campaign context: when the text is about an election, money verbs
// describe campaign fundraising, not startup funding. The markers
// are the vocabulary election coverage actually uses: party names,
// incumbency, unseating, House/Senate races, the midterms. (A real
// measurement catch: a PBS summary said a House challenger won
// "despite raising less than $100,000", with none of the obvious
// words campaign/candidate/election anywhere in the text.)
const CAMPAIGN_RE =
  /\b(campaign|candidates?|elections?|re-?election|congressional|ballot|fundrais\w+|war chest|democrats?|republicans?|gop|dnc|rnc|incumbent|unseat\w+|midterms?|rep\.|sen\.)\b/i;

function hasFundingSignal(text) {
  if (FUNDING_NAMED_RE.test(text)) return true;
  return FUNDING_MONEY_RE.test(text) && !CAMPAIGN_RE.test(text);
}

const FOUNDER_RE = new RegExp(
  [
    '\\bco-?founders?\\b',
    '\\bfounders?\\b',
    '\\bstart-?ups?\\b',
    '\\baccelerators?\\b',
    '\\bincubators?\\b',
    '\\by combinator\\b',
    '\\btechstars\\b',
    '\\bpitch competition\\b',
    '\\bdemo day\\b',
    '\\bventure[-\\s]backed\\b',
    '\\b(emerg\\w+|exit\\w*|comes? out of|out of) stealth\\b',
    '\\bstealth (mode|startup|company)\\b',
  ].join('|'),
  'i',
);

const LAUNCH_VERB_RE =
  /\b(launches|launched|launching|unveils|unveiled|unveiling|debuts|debuted|debuting|rolls out|rolled out|rolling out)\b/i;
const LAUNCH_CONTEXT_RE = /\b(early[-\s]stage|new company|new venture)\b/i;

/**
 * Classify one pool item as a startup story. Returns 'source',
 * 'funding', 'founder', or 'launch' (the rule that fired), or null
 * when the item is not a startup story under the rules above.
 */
export function classifyStartup(item) {
  if (!item) return null;
  if (STARTUP_SOURCES.has(item.source)) return 'source';
  const text = `${item.title || ''} ${item.summary || ''}`;
  if (hasFundingSignal(text)) return 'funding';
  if (FOUNDER_RE.test(text)) return 'founder';
  if (
    LAUNCH_VERB_RE.test(text) &&
    (LAUNCH_CONTEXT_RE.test(text) || hasFundingSignal(text) || FOUNDER_RE.test(text))
  ) {
    return 'launch';
  }
  return null;
}

export function isStartupStory(item) {
  return classifyStartup(item) !== null;
}

/** Full-depth gate: full-depth category, or a startup story. */
export function isFullDepthItem(item) {
  if (!item) return false;
  return isFullDepthCategory(item.category) || isStartupStory(item) || isScienceStory(item);
}

// ---------------------------------------------------------------------------
// SCIENCE CLASSIFIER (David, Nov 21, 2026): "science, research, and
// discoveries count inside the 65% band alongside tech, AI, startup,
// business, and innovation." Mix targets stay 65/20/10/5; a science
// story counts toward the TECH band in the mix accounting
// (lib/format.js mixBandOf), whatever ring it was filed under, and
// joins the full-depth tier the same way a startup story does: a
// story in a summarized category that is ABOUT science, research,
// or a discovery is a science story. Deterministic, like the
// startup classifier: category, source list, or a tight set of
// research-context text signals. General news that merely mentions
// a university or a hospital does NOT fire; the signals require
// research vocabulary (a study's findings, researchers, a journal,
// a discovery claim).
// ---------------------------------------------------------------------------
export const SCIENCE_SOURCES = new Set([
  'ScienceDaily',
  'Phys.org',
  'NASA',
  'Live Science',
  'Quanta Magazine',
  'Science News',
  'Scientific American',
]);

const SCIENCE_TEXT_RE = new RegExp(
  [
    '\\b(?:study|studies) (?:finds|found|shows?|showed|reveals?|revealed|suggests?|suggested|links?|linked|confirms?|confirmed)\\b',
    '\\bresearchers\\b',
    '\\bscientists\\b',
    '\\bpeer[- ]reviewed\\b',
    '\\bclinical trials?\\b',
    '\\bpublished in (?:the )?(?:journal|nature|science|proceedings|cell|jama|lancet)\\b',
    '\\bnew species\\b',
    '\\bfossils?\\b',
    '\\bexoplanets?\\b',
    '\\bdiscover(?:y|ies|ed) (?:of|a new|the)\\b',
    '\\bbreakthrough (?:in|for) (?:cancer|alzheimer|fusion|quantum|gene|brain|climate)\\b',
  ].join('|'),
  'i',
);

/**
 * Classify one pool item as a science story. Returns 'category',
 * 'source', or 'text' (the rule that fired), or null.
 */
export function classifyScience(item) {
  if (!item) return null;
  if (item.category === 'science') return 'category';
  if (SCIENCE_SOURCES.has(item.source)) return 'source';
  const text = `${item.title || ''} ${item.summary || ''}`;
  if (SCIENCE_TEXT_RE.test(text)) return 'text';
  return null;
}

export function isScienceStory(item) {
  return classifyScience(item) !== null;
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
