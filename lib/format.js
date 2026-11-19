// ============================================================================
// THE CONTINUOUS QUEUE (back to basics, Nov 19)
//
// KC Tech Radio used to run on a fixed hourly format clock: pinned
// anchors, spans that flexed to meet them, time checks spoken on their
// minute. David scrapped it: "let's go back to basics... I just want a
// stream of news and don't need to be synced so we can get the content
// locked down first." So there is NO clock anymore. No top-of-hour
// block, no anchors, no spans, no span-fill, no scheduled time callouts,
// no wall-clock scheduling of any kind. /api/playlist returns one
// ordered QUEUE of segments and the player simply plays it head to
// tail, each segment to its natural end, butt-joined.
//
// What the queue is:
//   - Full stories, back to back, story-led. Stories are dealt from the
//     category pools freshest-first in a weighted inside-out rotation
//     (Kansas City and the close rings lead; the subject pools run
//     strong; national and world ride lightest), so the mix leans home
//     without ever pinning a block to a minute.
//   - No banter and no canned transitions: just news, back to back
//     (David cut both on Nov 19 as repetitive).
//   - SOCIAL CALLERS (Nov 19, David's chosen personality layer now
//     that the canned material is gone): real public reactions to
//     real stories, from the social feed (lib/social.js), presented
//     like callers phoning in. When a queued story has a matched
//     reaction, ONE caller segment airs immediately after that story,
//     read by the co-host voice in a single fixed attribution format
//     ("Caller on Reddit, <username>: <text>"). At most one caller
//     per story and at most 16 per queue; callers are not stories
//     and count toward no cadence.
//   - Station material as seasoning, at natural intervals measured in
//     queue audio, never stacked: a station ID about every 20 minutes,
//     a Kansas City weather check about every 35 (when weather is
//     available), a Producer's Desk bit about every 50, and one Kansas
//     City Music Scene rundown per queue when the music feed has
//     listings. None of it speaks a time. The weather speaks current
//     conditions as natural content ("currently 54 degrees..."), the
//     way a human would, never as a schedule readout.
//   - NO REPEATS in any form within a queue: the rotation draws without
//     replacement, by link AND by headline cluster (ingestion already
//     collapsed syndicated copies to one item, and the queue never
//     re-slots an item at any length; trimmed fragment versions of
//     stories do not exist in this design). On top of that, a
//     queue-level TOPIC GUARD (see headlineProfile/topicGuardMatches)
//     keeps one queue from carrying two outlets' differently worded
//     versions of the same event: ingestion dedupe only merges
//     near-identical headlines, but David's rule is no topic repeats,
//     and a production audit (Nov 19) found 15+ same-event clusters
//     inside a single queue (one event alone had 8 stories). The
//     guard applies within one queue build only; the pool keeps every
//     version, so a later queue may air another outlet's take.
//
// Queue length and rotation: a queue targets about 4 hours of audio
// (TARGET_QUEUE_SECONDS), or the whole pool rotation when the pool
// holds less than that. The dealt story list is rotated by a
// deterministic offset that changes every 30-minute bucket, so
// consecutive queue fetches start at different points of the rotation
// and a listener who plays for hours is not handed the same head of
// the queue twice. Within a bucket the build is a pure function of
// (pool snapshot, weather): identical inputs, identical queue.
//
// Honest semantics: listeners are NOT synced to a clock or to each
// other. Pressing play starts the current queue from its head. Two
// listeners pressing play in the same bucket hear the same queue from
// the same head, each at their own pace; nothing anywhere claims
// otherwise.
//
// The station's attitude (TBPN pacing, NPR polish, Hunter S. Thompson
// at the producer's desk) lives entirely in lib/gonzo.js: fixed
// hand-written template pools for opens and station IDs.
// News facts are never touched; the gonzo layer is framing
// only. There is NO language model anywhere in this pipeline: an hour
// of programming costs exactly zero AI credits.
// ============================================================================

import { itemsForCategory } from './ingest';
import { trimToSentenceBoundary, lastSentenceEnd, ensureTerminalPunctuation, headlineTokens } from './rss';
import {
  SHOW_OPENS,
  STATION_IDS,
  PRODUCERS_DESK,
  MUSIC_LEADS,
} from './gonzo';
import { voiceForSegment, COHOST_VOICE } from './voices';
import { audioUrlFor } from './tts';

export const TIME_ZONE = 'America/Chicago';
// Speech rate assumption for duration estimates, CALIBRATED against
// rendered MP3s (Nov 19): a 38-segment sample of real segments compared
// estSeconds against the actual MP3 durations from lib/tts.js. At the
// old 155 wpm the renders ran systematically LONG (mean real/estimate
// ratio 1.119). 155 / 1.119 puts the true rate at ~138 wpm; 136 centers
// the residual error. Estimates now only shape queue composition and
// the truncated-render guard: playback itself is sequential and never
// cuts on an estimate.
export const WORDS_PER_MINUTE = 136;

// Queue shape.
export const BUCKET_MS = 30 * 60 * 1000; // rotation offset changes per bucket
export const TARGET_QUEUE_SECONDS = 4 * 60 * 60; // ~4 hours of audio per queue
const MAX_QUEUE_SEGMENTS = 900; // belt-and-braces cap
const STATION_ID_EVERY_SECONDS = 20 * 60;
const WEATHER_EVERY_SECONDS = 35 * 60;
const DESK_EVERY_SECONDS = 50 * 60;
const MUSIC_AT_SECONDS = 45 * 60; // music rundown lands ~45 min into the queue
const MAX_CALLERS_PER_QUEUE = 16; // social callers per queue, hard cap

// Story categories in the queue (music is listings, handled separately).
const STORY_CATEGORIES = [
  'local', 'state', 'regional', 'ai', 'tech', 'business', 'national', 'global', 'newsletter',
];

// Weighted inside-out dealing pattern: one pass deals 16 slots —
// local x3, ai x3, state x2, regional x2, tech x2, business x1,
// national x1, global x1, newsletter x1 — interleaved so no category
// clumps. The close rings and the hometown subject pools lead; the
// far rings ride lightest. A category whose pool runs dry is skipped;
// dealing continues until every pool is exhausted.
const DEAL_PATTERN = [
  'local', 'ai', 'state', 'tech',
  'local', 'regional', 'ai', 'business',
  'local', 'tech', 'national', 'ai',
  'regional', 'global', 'state', 'newsletter',
];

// Display titles per section (the player shows these; stories carry
// their section's title, as blocks did under the clock).
const SECTION_OF_CATEGORY = {
  local: 'kc-local',
  ai: 'ai-news',
  tech: 'tech-headlines',
  business: 'business-headlines',
  state: 'news',
  regional: 'news',
  national: 'news',
  global: 'news',
  newsletter: 'news',
};
const SECTION_TITLES = {
  'kc-local': 'Kansas City Tech & Business Report',
  'ai-news': 'The AI Report',
  'tech-headlines': 'Tech Headlines',
  'business-headlines': 'Business & Markets',
  news: 'The News, Inside-Out',
  'kc-music': 'Kansas City Music Scene',
  'social-callers': 'Listener Callers',
};

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** FNV-1a string hash -> unsigned 32-bit int. Stable across runs/processes. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const ctFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** Parts of a Date in America/Chicago: { weekday, month, day, hour, minute, ... } */
export function chicagoParts(date) {
  const parts = {};
  for (const p of ctFormatter.formatToParts(date)) parts[p.type] = p.value;
  return parts;
}

// Numeric wall-clock parts in America/Chicago. Retained for the
// verification harnesses (scripts/repeat-investigation.mjs converts
// simulated times with epochForChicagoWall); the queue itself does no
// wall-clock scheduling anymore.
const ctWallFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

function chicagoWallParts(date) {
  const parts = {};
  for (const p of ctWallFormatter.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  }
  return parts; // { year, month, day, hour (0-23), minute, second }
}

/** Offset of America/Chicago from UTC at the given instant, in ms. */
function chicagoOffsetMs(date) {
  const p = chicagoWallParts(date);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Epoch ms for a wall-clock time in America/Chicago. Out-of-range fields
 * are normalized the way Date.UTC normalizes them. Kept for the test
 * harnesses; production queue building does not schedule by the clock.
 */
export function epochForChicagoWall(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes settle the offset around DST transitions.
  const first = guess - chicagoOffsetMs(new Date(guess));
  return guess - chicagoOffsetMs(new Date(first));
}

export function estimateSeconds(script) {
  const words = script.split(/\s+/).filter(Boolean).length;
  return Math.max(5, Math.round((words / WORDS_PER_MINUTE) * 60));
}

// ---------------------------------------------------------------------------
// Script templates
// ---------------------------------------------------------------------------

/** Deterministic pool pick: hash of the segment id into the pool, so the
 *  same segment always gets the same line (cache-friendly, stable queues). */
function pickFromPool(pool, segmentId) {
  return pool[hashString(segmentId) % pool.length];
}

const SUMMARY_MAX_CHARS = 480;

function cleanSummary(summary) {
  if (!summary) return '';
  let s = summary
    // Defensive tag strip (ingest's cleanText is the primary cleaner;
    // a summary that reaches composition with markup still in it must
    // not put tags on the air).
    .replace(/<[^>]*>/g, ' ')
    .replace(/<\/?[a-zA-Z!][^>]*$/, ' ')
    .replace(/\s*(Continue reading|Read more|Read More)[\s\S]*$/, '')
    .replace(/\[…\]|\[\.\.\.\]/g, '')
    .trim();
  if (!s) return '';
  // Cut to length at a sentence boundary, never mid-clause (the shared
  // rule in lib/rss.js): the last complete sentence that fits, or the
  // first complete sentence when none fits. The old fallback here cut
  // at the last space and glued a period on, which is how scripts came
  // to end "...with more than 10,000 GPUs, delivering."
  s = trimToSentenceBoundary(s, SUMMARY_MAX_CHARS);
  // Some wires truncate their own summaries mid-clause (the "[…]"
  // stripped above is one marker of it). If what remains still does
  // not end a sentence but contains a complete one, cut back to the
  // last complete sentence rather than airing a fragment. A summary
  // with no complete sentence at all is the source's own text and is
  // left as-is.
  if (!/[.!?]["'”’)\]]*$/.test(s)) {
    const end = lastSentenceEnd(s);
    if (end > 0) s = s.slice(0, end).trim();
  }
  return s;
}

function storyScript(item) {
  // Stories start directly with the headline. There are no canned
  // intro/transition phrases: David found them repetitive and ordered
  // them removed (Nov 19).
  const summary = cleanSummary(item.summary);
  const parts = [];
  // The headline carries its own terminal punctuation when it has
  // any: a headline that already ends with a period (wire headlines
  // like "Death and Taxes. Rats and Real Estate.") must not gain a
  // second one ("Real Estate.. The inevitabilities...").
  // ensureTerminalPunctuation appends a period only when the text
  // does not already end with terminal punctuation.
  parts.push(ensureTerminalPunctuation(item.title));
  if (summary && !summary.toLowerCase().startsWith(item.title.toLowerCase().slice(0, 40))) {
    parts.push(summary);
  }
  // The body must end with terminal punctuation before the sign-off:
  // some wires publish summaries with no final period at all, and the
  // sign-off would otherwise run straight into the dangling clause
  // ("...was denied parole again From ABC News.").
  const body = ensureTerminalPunctuation(parts.join(' '));
  return `${body} From ${item.source}.`;
}

// Station ID lines for the queue: the gonzo STATION_IDS pool minus the
// lines that still advertise the retired format clock ("world on the
// hour, every hour"). No station ID speaks a time, ever.
const STATION_ID_LINES = STATION_IDS.filter(
  (line) => !/top of the hour|on the hour/i.test(line)
);

function stationIdScript(segmentId) {
  return pickFromPool(STATION_ID_LINES, segmentId);
}

// Weather as natural content: current conditions, spoken the way a
// person would say them. No time, no schedule framing.
function weatherScript(weather) {
  return (
    `Kansas City weather: currently ${weather.tempF} degrees with ` +
    `${weather.condition}, and winds around ${weather.windMph} miles per hour.`
  );
}

function producersDeskScript(segmentId) {
  return pickFromPool(PRODUCERS_DESK, segmentId);
}

// Social caller script: ONE fixed attribution format, never a pool
// (pools are what made the old banter sound canned). The reaction
// text is a real public post, validated in lib/social.js, and is
// framed as listener reaction, never as news.
function callerScript(caller) {
  return `Caller on ${caller.platform}, ${caller.username}: ${caller.text}`;
}

// Total wire failure (or an empty first pool): the queue falls back to
// fixed station copy. It is not a story, so it is exempt from the
// no-repeat rule.
const STATION_NOTE_SCRIPT =
  'You are listening to KC Tech Radio. Our news wires are momentarily quiet, ' +
  'so here is a quick station note: KC Tech Radio brings you Kansas City tech ' +
  'and business news, the latest in artificial intelligence, and news from ' +
  'around the world, around the clock. Stay with us; the headlines resume shortly.';

// ---------------------------------------------------------------------------
// Queue-level topic guard (Nov 19; v3 the same day)
//
// Ingestion dedupe (lib/ingest.js) merges near-identical headlines —
// syndicated copies of one story. It deliberately does NOT merge
// softer same-event coverage: different outlets' own reporting on one
// event, with differently worded headlines (Jaccard ~0.3). But inside
// ONE queue that still reads as a repeat to the listener: a production
// audit found 15+ same-event clusters in a single queue, one event
// (the Anthropic IPO) with 8 stories. David's rule is no topic
// repeats, so the queue build applies a second, lower bar, scoped to
// the queue only (the pool keeps every version for future queues).
// Two stories are the same EVENT when ANY of these paths fires:
//
//   HEADLINE SIMILARITY: the headlines share at least 3 significant
//   tokens, at least one shared token is an entity token, AND they
//   score Jaccard >= 0.3 OR containment >= 0.6 over significant
//   tokens.
//
//   ENTITY+EVENT: the headlines share as few as 2 significant tokens
//   when one shared token is an entity token AND a DIFFERENT shared
//   token is a strong event token (TOPIC_GUARD_EVENT_TOKENS: ipo,
//   merger, lawsuit, outage, summit, ... — words that name a news
//   event, not a topic area). The production pair that motivated it
//   shares only {anthropic, ipo}: "Anthropic valued at over $1
//   trillion in historic IPO" vs "Investors scramble for a piece of
//   AI giant Anthropic in blockbuster IPO". The distinctness
//   requirement matters: "Investors cheer as Rivian files for IPO"
//   shares {investors, ipo} with the second headline, but "investors"
//   is a generic opener (not an entity) and ipo is an event token
//   (never an entity), so the two companies' IPO stories stay apart.
//
//   SUMMARY PATH (v3): the headlines share a dominant entity AND
//   their cleaned summaries share at least 4 significant tokens at
//   containment >= 0.5 against the shorter summary's token set.
//   Developing stories defeat headline matching — the same IPO
//   reappears as "prices its IPO", "debuts", "shares pare gains"
//   with almost no shared headline vocabulary — but the summaries
//   still describe the same priced deal in the same words. The
//   dominant-entity anchor keeps genuinely different stories about
//   one company apart: a product launch and an IPO have summaries
//   that share almost nothing.
//
// ENTITY TOKENS (v3 fix): a token is an entity token when its word
// is capitalized in the original headline and survives as a
// significant token. Sentence-initial capitalization used to prove
// nothing, so headline-initial names were invisible ("Anthropic
// prices its IPO..." had NO anthropic entity and the entity+event
// rule misfired). Now a headline-initial word counts too, UNLESS it
// is in HEADLINE_STARTER_STOPWORDS: function words, generic news
// openers and role nouns ("Investors", "Regulators", "Major") whose
// capitalization is positional, not nominal. Event tokens never
// count as entities at any position: "IPO" capitalized mid-headline
// names the event, not an actor.
//
// ENTITY BUDGET (v3, the listener-first rule): even when no pair
// matches above, one entity must not colonize a queue. At most
// ENTITY_BUDGET_MAX stories whose headline's DOMINANT entity (first
// entity token) is the same may air in one queue; further
// same-entity stories are skipped during the deal. Stories with no
// entity are exempt. The pool is untouched, as with every guard
// mechanism: skipped items stay available to later queues.
// ---------------------------------------------------------------------------
const TOPIC_GUARD_MIN_SHARED = 3;
const TOPIC_GUARD_JACCARD_MIN = 0.3;
const TOPIC_GUARD_CONTAINMENT_MIN = 0.6;
const TOPIC_GUARD_EVENT_MIN_SHARED = 2;
const TOPIC_GUARD_SUMMARY_MIN_SHARED = 4;
const TOPIC_GUARD_SUMMARY_CONTAINMENT_MIN = 0.5;
const ENTITY_BUDGET_MAX = 3;
// Strong event tokens: nouns/verbs that signal one specific news
// event (a filing, a death, a verdict, an outage, a summit), never
// a topic area (no "ai", "market", "launch", "protests"). Inflections
// are listed separately because headlineTokens does no stemming.
const TOPIC_GUARD_EVENT_TOKENS = new Set([
  'ipo', 'merger', 'mergers', 'acquires', 'acquired', 'acquisition',
  'bankruptcy', 'resigns', 'resigned', 'dies', 'died', 'verdict',
  'guilty', 'shooting', 'earthquake', 'recall', 'recalls', 'lawsuit',
  'indictment', 'charged', 'arrest', 'arrested', 'explosion',
  'explosions', 'crash', 'crashes', 'outage', 'outages',
  'summit', 'summits', 'trial', 'trials', 'hearing', 'hearings',
  'strike', 'strikes',
]);

// Headline-initial words whose capitalization is positional, not
// nominal: function words, question and framing openers, generic
// adjectives, and role/subject nouns that open wire headlines
// without naming anyone ("Investors scramble...", "Regulators open
// probe...", "Major outage..."). Conservative on purpose: a word is
// listed only when it plainly is not a proper name. A capitalized
// initial word NOT in this list (Anthropic, Nvidia, Microsoft)
// registers as an entity token.
const HEADLINE_STARTER_STOPWORDS = new Set([
  // function words
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'as', 'at', 'by', 'for',
  'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over',
  'under', 'up', 'down', 'with', 'without', 'amid', 'among',
  'between', 'through', 'during', 'before', 'after', 'about',
  'against', 'per', 'via', 'to', 'it', 'its', 'this', 'that', 'these',
  'those', 'he', 'she', 'they', 'we', 'you', 'his', 'her', 'their',
  'our', 'your', 'who', 'whom', 'whose', 'what', 'which', 'when',
  'where', 'why', 'how', 'all', 'any', 'some', 'no', 'not', 'one',
  'two', 'three', 'first', 'second', 'third', 'last', 'next',
  'other', 'another', 'more', 'most', 'many', 'few', 'much', 'each',
  'every', 'both', 'same', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'can', 'could', 'will',
  'would', 'should', 'may', 'might', 'must',
  // framing openers and generic adjectives/adverbs
  'new', 'live', 'watch', 'video', 'videos', 'photo', 'photos',
  'opinion', 'analysis', 'report', 'reports', 'study', 'studies',
  'poll', 'polls', 'breaking', 'update', 'updated', 'exclusive',
  'just', 'now', 'then', 'here', 'there', 'yes', 'back', 'inside',
  'behind', 'ahead', 'again', 'still', 'yet', 'already', 'once',
  'today', 'tonight', 'tomorrow', 'yesterday', 'daily', 'weekly',
  'big', 'top', 'best', 'worst', 'major', 'key', 'full', 'real',
  // common opener verbs (capitalized only by position)
  'says', 'said', 'say', 'meet', 'meets', 'see', 'sees', 'read',
  'get', 'gets', 'make', 'makes', 'take', 'takes', 'show', 'shows',
  'call', 'calls', 'ask', 'asks', 'tell', 'tells',
  // generic role/subject nouns (name a class, never an actor)
  'investors', 'regulators', 'officials', 'police', 'lawmakers',
  'scientists', 'researchers', 'experts', 'analysts', 'traders',
  'consumers', 'voters', 'workers', 'employees', 'students',
  'parents', 'doctors', 'farmers', 'residents', 'critics',
  'supporters', 'opponents', 'fans', 'users', 'customers',
  'drivers', 'teachers', 'nurses', 'patients', 'children',
  'families', 'authorities', 'prosecutors', 'shares', 'stocks',
]);

/**
 * Similarity profile for one headline: its significant tokens (the
 * shared lib/rss.js normalization ingestion dedupe uses), the subset
 * that are entity tokens (capitalized in the original headline and
 * surviving as significant tokens; see the entity note above), the
 * dominant entity (the FIRST entity token in headline word order,
 * or null), and an empty summary-token set (storyProfile fills it).
 */
export function headlineProfile(title, source) {
  const tokens = headlineTokens(title, source);
  const entities = new Set();
  let dominantEntity = null;
  const words = String(title || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  words.forEach((word, i) => {
    if (!/^[A-Z]/.test(word)) return;
    const lower = word.toLowerCase();
    // An event token names the event, never an actor: it cannot be
    // an entity at any position ("IPO", "Outage", "Summit").
    if (TOPIC_GUARD_EVENT_TOKENS.has(lower)) return;
    // A headline-initial word counts as an entity only when it is
    // not a positional-capitalization stopword.
    if (i === 0 && HEADLINE_STARTER_STOPWORDS.has(lower)) return;
    // Normalize the word the way headlineTokens does and keep any of
    // its token runs that are significant tokens of this headline.
    for (const run of word.normalize('NFKD').toLowerCase().split(/[^a-z0-9]+/)) {
      if (run && tokens.has(run) && !TOPIC_GUARD_EVENT_TOKENS.has(run)) {
        entities.add(run);
        if (!dominantEntity) dominantEntity = run;
      }
    }
  });
  return { tokens, entities, dominantEntity, summaryTokens: new Set() };
}

/**
 * Full guard profile for a pool item: the headline profile plus the
 * significant tokens of its CLEANED summary (the same summary text
 * the script airs), which the summary path of the guard matches on.
 */
export function storyProfile(item) {
  const profile = headlineProfile(item?.title, item?.source);
  const summary = cleanSummary(item?.summary || '');
  profile.summaryTokens = summary ? headlineTokens(summary, item?.source) : new Set();
  return profile;
}

/** True when two story profiles are the same event (rules above). */
export function topicGuardMatches(a, b) {
  // Summary path: same dominant entity, and the cleaned summaries
  // describe the same development in substantially the same words.
  // (Profiles built from headlines alone carry empty summary sets,
  // so this path is inert for them.)
  if (
    a.dominantEntity &&
    a.dominantEntity === b.dominantEntity &&
    a.summaryTokens?.size &&
    b.summaryTokens?.size
  ) {
    let sharedSummary = 0;
    for (const w of a.summaryTokens) if (b.summaryTokens.has(w)) sharedSummary += 1;
    if (sharedSummary >= TOPIC_GUARD_SUMMARY_MIN_SHARED) {
      const containment =
        sharedSummary / Math.min(a.summaryTokens.size, b.summaryTokens.size);
      if (containment >= TOPIC_GUARD_SUMMARY_CONTAINMENT_MIN) return true;
    }
  }
  let shared = 0;
  let sharedEntity = false;
  const sharedEntities = new Set();
  const sharedEvents = new Set();
  for (const w of a.tokens) {
    if (b.tokens.has(w)) {
      shared += 1;
      if (a.entities.has(w) || b.entities.has(w)) {
        sharedEntity = true;
        sharedEntities.add(w);
      }
      if (TOPIC_GUARD_EVENT_TOKENS.has(w)) sharedEvents.add(w);
    }
  }
  // Entity+event rule: a shared entity token and a DIFFERENT shared
  // event token are enough at 2 shared tokens total. (The same token
  // cannot testify twice: a pair whose only shared entity is the
  // event token itself, like two companies' IPO stories that both
  // happen to say "IPO", does not match.)
  if (shared >= TOPIC_GUARD_EVENT_MIN_SHARED && sharedEvents.size > 0) {
    for (const e of sharedEntities) {
      for (const v of sharedEvents) {
        if (e !== v) return true;
      }
    }
  }
  if (shared < TOPIC_GUARD_MIN_SHARED || !sharedEntity) return false;
  const union = a.tokens.size + b.tokens.size - shared;
  const jaccard = union ? shared / union : 0;
  const containment = shared / Math.min(a.tokens.size, b.tokens.size) || 0;
  return jaccard >= TOPIC_GUARD_JACCARD_MIN || containment >= TOPIC_GUARD_CONTAINMENT_MIN;
}

// ---------------------------------------------------------------------------
// Story dealing: the weighted inside-out rotation
// ---------------------------------------------------------------------------

// Deal every story item exactly once: cycle the DEAL_PATTERN, taking
// the next freshest item from each named pool (pools arrive
// newest-first from ingest), skipping dry pools, until a full pass
// deals nothing. The dealt list is the queue's story rotation BEFORE
// the per-bucket rotation offset is applied.
function dealStories(pools) {
  const cursors = new Map();
  const dealt = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const cat of DEAL_PATTERN) {
      const list = pools[cat];
      if (!list || !list.length) continue;
      const idx = cursors.get(cat) || 0;
      if (idx < list.length) {
        dealt.push(list[idx]);
        cursors.set(cat, idx + 1);
        progressed = true;
      }
    }
  }
  return dealt;
}

// ---------------------------------------------------------------------------
// Queue builder
// ---------------------------------------------------------------------------

/**
 * Build the continuous queue starting "now".
 *
 * @param pool    news pool from ingest.getNewsPool()
 * @param weather weather object or null
 * @param nowMs   epoch ms to build from (injectable for tests); only
 *                its 30-minute bucket matters (the rotation offset)
 * @param socialItems  validated social caller items from
 *                lib/social.js (optional; may also arrive as
 *                pool.socialItems). An empty or missing list means
 *                no callers, and the queue is exactly the just-news
 *                queue.
 * @returns { generatedAt, bucket, queueSeconds, bufferSeconds, topicGuardSkipped, entityBudgetSkipped, callerCount, segments }
 *   Each segment: { id, kind, blockKey, category, title, headline, source,
 *                   script, estSeconds, voice, audioUrl } (stories and
 *                   music listings also carry `link`). There are deliberately no startMs/slotEndMs
 *                   fields: nothing is scheduled. `queueSeconds` is the
 *                   total estimated audio in the queue; `bufferSeconds`
 *                   is the same number, kept for the health route.
 *                   `topicGuardSkipped` counts pool stories the
 *                   queue-level topic guard held out of this queue as
 *                   same-event repeats of a story already queued;
 *                   `entityBudgetSkipped` counts stories held out by
 *                   the entity budget (a 4th story in this queue
 *                   whose dominant entity already has 3).
 */
export function buildPlaylist(pool, weather, nowMs = Date.now(), socialItems) {
  const pools = {};
  for (const cat of [...STORY_CATEGORIES, 'music']) {
    pools[cat] = itemsForCategory(pool, cat);
  }

  // Social callers, keyed by the story link they react to. Items are
  // validated upstream (lib/social.js); the first item per story wins,
  // which is what enforces one caller per story at placement time.
  const callerByStoryLink = new Map();
  for (const caller of socialItems ?? pool?.socialItems ?? []) {
    if (caller && caller.storyLink && !callerByStoryLink.has(caller.storyLink)) {
      callerByStoryLink.set(caller.storyLink, caller);
    }
  }
  let callerCount = 0;

  const bucket = Math.floor(nowMs / BUCKET_MS);
  const dealt = dealStories(pools);
  const offset = dealt.length ? hashString(`kctr-queue-${bucket}`) % dealt.length : 0;
  const rotated = [...dealt.slice(offset), ...dealt.slice(0, offset)];

  const musicListings = pools.music;

  const segments = [];
  let seq = 0;
  let elapsed = 0; // estimated seconds of queue audio so far
  const nextId = (kind, extra = '') => {
    seq += 1;
    return `q${bucket}-${seq}-${kind}${extra}`;
  };
  const push = (seg) => {
    segments.push(seg);
    elapsed += seg.estSeconds || 0;
    return seg;
  };

  // The queue opens with a station ID: identification first, then news.
  {
    const id = nextId('station-id');
    const script = stationIdScript(id);
    push({
      id,
      kind: 'station-id',
      blockKey: 'station-id',
      category: 'station',
      title: 'Station ID',
      headline: 'KC Tech Radio',
      source: 'KC Tech Radio',
      script,
      estSeconds: estimateSeconds(script),
    });
  }
  let lastIdEnd = elapsed;
  let lastWeatherEnd = 0;
  let lastDeskEnd = 0;

  const pushMusicSection = () => {
    // Kansas City Music Scene. Listings come from the music feed
    // (venue-verified only; see README "Music feed"). Rundown order is
    // fixed: tonight, just announced, weekend, jazz; feed order is
    // preserved inside each kind; the section caps at 6 listings.
    const introId = nextId('intro');
    const intro = pickFromPool(SHOW_OPENS['kc-music'], introId);
    push({
      id: introId,
      kind: 'intro',
      blockKey: 'kc-music',
      category: 'music',
      title: SECTION_TITLES['kc-music'],
      headline: SECTION_TITLES['kc-music'],
      source: 'KC Tech Radio',
      script: intro,
      estSeconds: estimateSeconds(intro),
    });
    const KIND_ORDER = ['tonight', 'announced', 'weekend', 'jazz'];
    const rundown = KIND_ORDER.flatMap((kind) =>
      musicListings.filter((it) => it.musicKind === kind)
    ).slice(0, 6);
    rundown.forEach((item, i) => {
      const id = nextId('music', `-${hashString(item.id).toString(36)}`);
      const lead =
        MUSIC_LEADS[item.musicKind][hashString(id) % MUSIC_LEADS[item.musicKind].length];
      // Facts stay straight: artist, venue, and date/time exactly as
      // the (venue-verified) feed carries them. Listings open with
      // their own MUSIC_LEADS lead-in only, no story transition.
      const script =
        `${lead} ${item.artist} at ${item.venue}, ${item.when}.`;
      push({
        id,
        kind: 'music',
        blockKey: 'kc-music',
        category: 'music',
        title: SECTION_TITLES['kc-music'],
        headline: item.title,
        source: item.venue,
        link: item.url || item.link,
        artist: item.artist,
        venue: item.venue,
        when: item.when,
        musicKind: item.musicKind,
        script,
        estSeconds: estimateSeconds(script),
      });
    });
  };

  let storyCount = 0;
  let musicInserted = false;
  // Topic guard state: profiles of the stories already in THIS queue.
  // The pool is untouched; a skipped item stays available to the next
  // queue build (and may air there as that queue's version of the
  // event).
  const queuedProfiles = [];
  let topicGuardSkipped = 0;
  // Entity budget state: how many queued stories carry each dominant
  // entity. A story the topic guard skips never consumes budget.
  const entityCounts = new Map();
  let entityBudgetSkipped = 0;

  for (const item of rotated) {
    if (elapsed >= TARGET_QUEUE_SECONDS) break;
    if (segments.length >= MAX_QUEUE_SEGMENTS) break;

    // Queue-level topic guard: never two versions of the same event
    // in one queue, even when the outlets worded them differently
    // enough to survive ingestion dedupe (see the guard note above).
    const profile = storyProfile(item);
    if (queuedProfiles.some((p) => topicGuardMatches(p, profile))) {
      topicGuardSkipped += 1;
      continue;
    }
    // Entity budget: at most ENTITY_BUDGET_MAX stories per dominant
    // entity in one queue, however distinct their events are.
    if (
      profile.dominantEntity &&
      (entityCounts.get(profile.dominantEntity) || 0) >= ENTITY_BUDGET_MAX
    ) {
      entityBudgetSkipped += 1;
      continue;
    }
    queuedProfiles.push(profile);
    if (profile.dominantEntity) {
      entityCounts.set(
        profile.dominantEntity,
        (entityCounts.get(profile.dominantEntity) || 0) + 1
      );
    }

    const section = SECTION_OF_CATEGORY[item.category] || 'news';
    const id = nextId('story', `-${hashString(item.id).toString(36)}`);
    const script = storyScript(item);
    push({
      id,
      kind: 'story',
      blockKey: section,
      category: item.category,
      title: SECTION_TITLES[section],
      headline: item.title,
      source: item.source,
      link: item.link,
      script,
      estSeconds: estimateSeconds(script),
    });
    storyCount += 1;

    // Social caller: immediately after its story, before any station
    // material, so a caller is never separated from the story it
    // reacts to and never sits next to station material on the story
    // side. Read by the co-host voice so callers sound distinct from
    // the anchor. Callers are not stories: storyCount and every
    // cadence above are untouched by them.
    const caller = callerByStoryLink.get(item.link);
    if (caller && callerCount < MAX_CALLERS_PER_QUEUE) {
      callerCount += 1;
      const cId = nextId('caller', `-${hashString(item.id).toString(36)}`);
      const cScript = callerScript(caller);
      push({
        id: cId,
        kind: 'caller',
        blockKey: 'social-callers',
        category: 'social',
        title: SECTION_TITLES['social-callers'],
        headline: item.title,
        source: caller.platform,
        link: item.link,
        storyLink: item.link,
        platform: caller.platform,
        username: caller.username,
        sourceUrl: caller.sourceUrl || '',
        // Explicit voice: voiceForSegment honors a segment's own
        // voice over its section, so callers always get the co-host.
        voice: COHOST_VOICE,
        script: cScript,
        estSeconds: estimateSeconds(cScript),
      });
    }

    // Station material at natural intervals, at most one piece per
    // story step, never stacked: a station ID about every 20 minutes
    // of queue audio, weather about every 35, the Producer's Desk
    // about every 50.
    if (elapsed - lastIdEnd >= STATION_ID_EVERY_SECONDS) {
      const sidId = nextId('station-id');
      const sidScript = stationIdScript(sidId);
      push({
        id: sidId,
        kind: 'station-id',
        blockKey: 'station-id',
        category: 'station',
        title: 'Station ID',
        headline: 'KC Tech Radio',
        source: 'KC Tech Radio',
        script: sidScript,
        estSeconds: estimateSeconds(sidScript),
      });
      lastIdEnd = elapsed;
    } else if (weather && elapsed - lastWeatherEnd >= WEATHER_EVERY_SECONDS) {
      const wId = nextId('weather');
      const wScript = weatherScript(weather);
      push({
        id: wId,
        kind: 'weather',
        blockKey: 'weather',
        category: 'station',
        title: 'Kansas City Weather',
        headline: 'KC Tech Radio',
        source: 'KC Tech Radio',
        script: wScript,
        estSeconds: estimateSeconds(wScript),
      });
      lastWeatherEnd = elapsed;
    } else if (elapsed - lastDeskEnd >= DESK_EVERY_SECONDS) {
      const dId = nextId('producers-desk');
      const dScript = producersDeskScript(dId);
      push({
        id: dId,
        kind: 'producers-desk',
        blockKey: 'producers-desk',
        category: 'station',
        title: "The Producer's Desk",
        headline: "The Producer's Desk",
        source: 'KC Tech Radio',
        script: dScript,
        estSeconds: estimateSeconds(dScript),
      });
      lastDeskEnd = elapsed;
    }

    // One music rundown per queue, landing about 45 minutes in.
    if (!musicInserted && musicListings.length && elapsed >= MUSIC_AT_SECONDS) {
      pushMusicSection();
      musicInserted = true;
    }
  }

  // A short queue (thin pool) still gets its music rundown, at the end.
  if (!musicInserted && musicListings.length && storyCount >= 5) {
    pushMusicSection();
    musicInserted = true;
  }

  // No stories at all (total wire failure or a cold first pool): the
  // station note keeps the queue non-empty and honest about why.
  if (storyCount === 0 && !musicInserted) {
    const id = nextId('filler');
    push({
      id,
      kind: 'filler',
      blockKey: 'filler',
      category: 'station',
      title: 'Station Note',
      headline: 'KC Tech Radio',
      source: 'KC Tech Radio',
      script: STATION_NOTE_SCRIPT,
      estSeconds: estimateSeconds(STATION_NOTE_SCRIPT),
    });
  }

  // Attach each segment's voice and its pre-rendered audio URL. The
  // voice is decided by section (lib/voices.js); the URL derives
  // entirely from the segment's voice + script, so it is as
  // deterministic as the segment id.
  const out = segments.map((seg) => {
    const voice = voiceForSegment(seg);
    return { ...seg, voice, audioUrl: audioUrlFor(voice, seg.script, seg.id) };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    bucket,
    queueSeconds: elapsed,
    bufferSeconds: elapsed,
    topicGuardSkipped,
    entityBudgetSkipped,
    callerCount,
    segments: out,
  };
}
