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
//   - Full stories, back to back, story-led, FRESHEST FIRST (David's
//     explicit ordering rule, Nov 19): within the never-aired
//     inventory the queue runs newest-first by published timestamp
//     across ALL categories, so the freshest reporting leads every
//     queue and older items sink to the back, where the retirement
//     window below usually claims them before they ever air. The
//     rule supersedes the weighted inside-out category deal the
//     queue used earlier the same day, and it wins any conflict
//     with rotation: nothing pulls an older story to the head.
//   - NO REPEATS, EVER (David, Nov 21, 2026): "create a database of
//     queued stories and whether they have ever played or not. mark
//     played after they play. i'm not kidding when I say no repeats.
//     should harvest more if need new stories." This supersedes the
//     Nov 19 consume-and-replace model (12-hour retirement, recycled
//     fallback tail), the Nov 20 72-hour recycling cap, and the
//     per-listener 24-hour heard registry: a story that has aired on
//     the shared timeline NEVER airs again. The queue builder selects
//     only never-played stories; when they run short the queue gets
//     shorter and non-story programming (Wasteland Jukebox tracks,
//     station material) fills the clock. Nothing is recycled, ever.
//     The played record is lib/played.js (data/played-stories.json),
//     unioned with the deterministic timeline replay below.
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
// Queue length: a queue targets about 4 hours of audio
// (TARGET_QUEUE_SECONDS), or the whole never-played candidate list
// when the pool holds less than that. Within a bucket the build is
// a pure function of (pool snapshot, weather, played store):
// identical inputs, identical queue.
//
// ONE GLOBAL BROADCAST (David, Nov 21, 2026): "it's not a per
// person station it's a global station where everyone should be
// hearing the same thing." There is ONE station timeline, anchored
// at STATION_EPOCH_MS, advancing by the wall clock in 30-minute
// buckets: each bucket, the timeline consumes the head of that
// bucket's queue (30 minutes of story audio), and those stories are
// played, permanently. Everyone who tunes in hears the same thing
// at the same time: the playlist response carries the live offset
// (seconds into the current bucket) and the on-air segment, and the
// player joins THERE, mid-story if that is where the broadcast is,
// exactly like turning on a radio. The per-listener queue, the
// personal resume-at-left-off position, and the per-listener heard
// registry are retired by this model: the player is a thin client
// that plays the shared timeline from the live offset and appends
// later buckets' queues (never-played stories only) as they come.
//
// The station's attitude (TBPN pacing, NPR polish, Hunter S. Thompson
// at the producer's desk) lives entirely in lib/gonzo.js: fixed
// hand-written template pools for opens and station IDs.
// News facts are never touched; the gonzo layer is framing
// only. There is NO language model anywhere in this pipeline: an hour
// of programming costs exactly zero AI credits.
// ============================================================================

import { itemsForCategory } from './ingest';
import { trimToSentenceBoundary, lastSentenceEnd, ensureTerminalPunctuation, headlineTokens, sentenceEndPositions } from './rss';
import { isFullDepthItem, isStartupStory, isScienceStory, STARTUP_SOURCES } from './article';
import {
  SHOW_OPENS,
  STATION_IDS,
  PRODUCERS_DESK,
  MUSIC_LEADS,
  PERF_LEADS,
} from './gonzo';
import { voiceForSegment, COHOST_VOICE } from './voices';
import { audioUrlFor } from './tts';
import JINGLE_MANIFEST from './jingles.json' with { type: 'json' };
import JUKEBOX_MANIFEST from './jukebox.json' with { type: 'json' };

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
export const BUCKET_MS = 30 * 60 * 1000; // the timeline advances per bucket
export const TARGET_QUEUE_SECONDS = 4 * 60 * 60; // ~4 hours of audio per queue
// The shared broadcast timeline starts at the no-repeats cutover:
// midnight America/Chicago at the start of Nov 22, 2026. Buckets
// before the epoch belong to the retired per-listener era and are
// not replayed (see the migration note at timelineAired).
export const STATION_EPOCH_MS = Date.UTC(2026, 10, 22, 6, 0, 0);
const CONSUME_SECONDS_PER_BUCKET = BUCKET_MS / 1000; // one bucket's airtime window: the replay consumes story audio against it, carrying a straddling story's remainder into the next bucket
const MAX_QUEUE_SEGMENTS = 900; // belt-and-braces cap
const STATION_ID_EVERY_SECONDS = 20 * 60;
const WEATHER_EVERY_SECONDS = 35 * 60;
const DESK_EVERY_SECONDS = 50 * 60;
const JUKEBOX_EVERY_SECONDS = 45 * 60;

// Segment classes under David's generalized exception (Nov 21, 2026):
// "any service segments can repeat" and "just news and content can
// not." Never-repeat applies to NEWS AND CONTENT only: news stories,
// newsletter items (story segments), story-tied social callers, and
// Dispatches from the Bunker bits. SERVICE AND FORMAT segments are
// exempt and repeat on their natural cadences: station IDs, jingles,
// Surface Conditions weather, the live shows listing (still capped at
// once an hour), time checks, Signal Strength elements.
// BOUNDARY ITEM: the Wasteland Jukebox vintage recordings are held
// under the STRICT reading (content: each track airs once, ever)
// until David rules otherwise. JUKEBOX_TRACK_CLASS is the one-line
// flip: set it to 'service' and the shelf rotates as format again.
// Content plays are recorded in the shared played store under
// prefixed keys (track:<audio file>, desk:<pool index>) by the sync
// script, from the same deterministic timeline replay that marks
// stories; the queue builder never selects a recorded one again.
export const JUKEBOX_TRACK_CLASS = 'content';
export const TRACK_PLAYED_PREFIX = 'track:';
export const DESK_PLAYED_PREFIX = 'desk:';
const MUSIC_AT_SECONDS = 45 * 60; // first music rundown lands ~45 min into the queue
const MUSIC_RUNDOWN_EVERY_SECONDS = 60 * 60; // then at most once an hour (see the exception note in buildPlaylist)
const PERF_AT_SECONDS = 100 * 60; // first Marquee rundown lands ~100 min in, clear of the first music rundown
const MAX_CALLERS_PER_QUEUE = 16; // social callers per queue, hard cap

// Story categories in the queue (music is listings, handled separately).
const STORY_CATEGORIES = [
  'local', 'state', 'regional', 'ai', 'tech', 'business', 'science', 'national', 'global', 'newsletter',
];

// Display titles per section (the player shows these; stories carry
// their section's title, as blocks did under the clock).
const SECTION_OF_CATEGORY = {
  local: 'kc-local',
  ai: 'ai-news',
  tech: 'tech-headlines',
  business: 'business-headlines',
  science: 'science',
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
  science: 'Science & Discovery',
  news: 'The News, Inside-Out',
  'kc-music': 'The Wasteland Jukebox',
  'kc-stage': 'The Marquee',
  'social-callers': 'Voices on the Wire',
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

// ---------------------------------------------------------------------------
// No spoken URLs (David, Nov 23, 2026): on air, a script never reads a
// full URL. Article bodies and wire summaries carry raw links ("read
// more at https://www.startlandnews.com/2026/11/the-story/"), and a
// TTS voice would spell out every slash. Any URL in spoken copy is
// replaced by its BARE DOMAIN, citation style: "startlandnews.com"
// (no protocol, no "www.", no path). Bare domains already in the copy
// stay as they are. The function is idempotent, and buildPlaylist
// applies it to every segment script as the final step, so no segment
// kind can leak a URL onto the air.
// ---------------------------------------------------------------------------
function bareDomainOf(urlToken) {
  const host = String(urlToken)
    .replace(/^https?:\/\//i, '')
    .split(/[/?#]/)[0];
  return host.replace(/^www\./i, '');
}

const SPOKEN_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'()]+/gi;
// A bare domain carrying a path but no protocol ("example.com/a/b").
// The TLD list keeps prose like "and/or", dates, and version numbers
// ("2.0/3") out of the match: a real citation domain plus a slash
// path is the only shape replaced.
const SPOKEN_DOMAIN_PATH_RE =
  /\b((?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|mil|io|co|us|info|news|site|online|tech|ai|tv|fm|me|cc|biz|dev|app|xyz|pro|mobi))\/[^\s<>"'()]+/gi;

export function sanitizeSpokenText(text) {
  if (!text) return text;
  let out = String(text);
  const swap = (match, hostPart) => {
    // Sentence punctuation glued to the end of a link belongs to the
    // sentence, not the URL: keep it after the domain.
    const trail = match.match(/[.,;:!?)\]]+$/);
    const core = trail ? match.slice(0, -trail[0].length) : match;
    const domain = bareDomainOf(hostPart || core);
    return domain + (trail ? trail[0] : '');
  };
  out = out.replace(SPOKEN_URL_RE, (m) => swap(m));
  out = out.replace(SPOKEN_DOMAIN_PATH_RE, (m, host) => swap(m, host));
  return out;
}

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

// ---------------------------------------------------------------------------
// Story depth (Nov 19): scripts target 60-90 seconds of audio
// (roughly 800-1,200 characters at the calibrated rate) for
// FULL-DEPTH items (lib/article.js: the ai, tech, business, local,
// state, regional categories, plus startup stories in any category
// per David's later Nov 19 addition; the classifier's rules are
// documented at classifyStartup in lib/article.js), built from the
// article's own text when ingest extracted a body for the item.
// National and global stories that are not startup stories stay in
// the summarized headline+summary form, and any full-depth story
// whose body never materialized (extraction failed, page blocked)
// falls back to that same form rather than being padded: depth is
// earned from substance, never faked.
//
// LENGTHENING (David, Nov 21, 2026): "also can expand the other
// stories to make them longer." Applied WITHIN the depth rules
// above: full-depth stories (now including science, Nov 21) push
// toward and past the top of the 60-90 second band wherever the
// article substance honestly supports it, so the script budget
// rises to 1750 chars (about 110-120 seconds at the calibrated
// rate). This is a burn-rate lever for the no-repeats era: longer
// stories mean fewer unique stories burned per hour of broadcast.
// The boundary David's standing depth rule sets still holds:
// national and global stay summarized; nothing here expands them,
// and no copy is invented or padded to reach the budget: a body
// that runs out of sentences simply airs shorter.
// ---------------------------------------------------------------------------
const SCRIPT_TARGET_CHARS = 1750;
// A trimmed body shorter than this is not substance enough to air
// over the summary (stored bodies are at least MIN_BODY_CHARS in
// lib/article.js; trimming to the script budget can only shrink
// them, and a body that shrinks below this was mostly one sentence).
const BODY_MIN_CHARS = 300;

function cleanBodyText(body) {
  if (!body) return '';
  // Defensive cleaning, mirroring cleanSummary: ingest's extractor
  // is the primary cleaner, but markup must never reach a script.
  return String(body)
    .replace(/<[^>]*>/g, ' ')
    .replace(/<\/?[a-zA-Z!][^>]*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The body a full-depth story airs: the article's own text, trimmed
 * at a sentence boundary to the script budget. '' when the text
 * cannot fill the budget with complete sentences.
 */
function storyBodyText(item, budget) {
  let body = cleanBodyText(item.body);
  if (!body) return '';
  // Articles often open by restating the headline, which the script
  // already carries: drop that first sentence when enough substance
  // remains behind it.
  if (body.toLowerCase().startsWith(item.title.toLowerCase().slice(0, 40))) {
    const ends = sentenceEndPositions(body);
    if (ends.length && body.length - ends[0] >= BODY_MIN_CHARS) {
      body = body.slice(ends[0]).trim();
    }
  }
  const ends = sentenceEndPositions(body).filter((e) => e <= budget);
  if (ends.length) return body.slice(0, ends[ends.length - 1]).trim();
  // No complete sentence fits the budget: the first complete
  // sentence may still air when it overshoots only modestly (the
  // shared trim rule's spirit in lib/rss.js); a body with no
  // sentence boundary near the budget is one unbroken run, and the
  // summary serves the story better.
  const first = sentenceEndPositions(body)[0];
  if (first && first <= budget * 1.4) return body.slice(0, first).trim();
  return '';
}

function storyScript(item) {
  // Stories start directly with the headline. There are no canned
  // intro/transition phrases: David found them repetitive and ordered
  // them removed (Nov 19).
  if (isFullDepthItem(item) && item.body) {
    const headlinePart = ensureTerminalPunctuation(item.title);
    const signoff = ` From ${item.source}.`;
    const budget = SCRIPT_TARGET_CHARS - headlinePart.length - signoff.length;
    const bodyText = storyBodyText(item, budget);
    if (bodyText.length >= BODY_MIN_CHARS) {
      return sanitizeSpokenText(
        `${headlinePart} ${ensureTerminalPunctuation(bodyText)}${signoff}`
      );
    }
  }
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
  return sanitizeSpokenText(`${body} From ${item.source}.`);
}

// Station ID lines for the queue: the gonzo STATION_IDS pool minus the
// lines that still advertise the retired format clock ("world on the
// hour, every hour"). No station ID speaks a time, ever.
const STATION_ID_LINES = STATION_IDS.filter(
  (line) => !/top of the hour|on the hour/i.test(line)
);

function stationIdScript(segmentId, avoidIndex = -1) {
  // Pool pick by segment-id hash, with one guarantee the hash alone
  // cannot make: never the same line twice in a row within a queue.
  // When the hash lands on the previous ID's line, step one forward.
  let idx = hashString(segmentId) % STATION_ID_LINES.length;
  if (STATION_ID_LINES.length > 1 && idx === avoidIndex) {
    idx = (idx + 1) % STATION_ID_LINES.length;
  }
  return { script: STATION_ID_LINES[idx], idx };
}

// Weather as natural content: current conditions, spoken the way a
// person would say them. No time, no schedule framing. The block is
// "Surface Conditions" in-world (Nov 20, 2026 reskin); the facts are
// the weather service's, untouched.
function weatherScript(weather) {
  return (
    `Surface conditions in Kansas City: currently ${weather.tempF} degrees with ` +
    `${weather.condition}, and winds around ${weather.windMph} miles per hour.`
  );
}

// Dispatches are CONTENT under the generalized exception: a bit
// that has aired (recorded in the played store as desk:<index>)
// never airs again. Returns null when the whole pool has aired;
// the segment class then stops until new bits are written.
function producersDeskScript(segmentId, playedMap) {
  const start = hashString(segmentId) % PRODUCERS_DESK.length;
  for (let k = 0; k < PRODUCERS_DESK.length; k++) {
    const idx = (start + k) % PRODUCERS_DESK.length;
    if (playedMap && playedMap.has(DESK_PLAYED_PREFIX + idx)) continue;
    return PRODUCERS_DESK[idx];
  }
  return null;
}

// Social caller script: ONE fixed attribution format, never a pool
// (pools are what made the old banter sound canned). The reaction
// text is a real public post, validated in lib/social.js, and is
// framed as listener reaction, never as news.
function callerScript(caller) {
  // Caller text is validated URL-free upstream (lib/social.js), but
  // the no-spoken-URLs rule applies to every voice on the station,
  // so the sanitizer runs here too (a no-op for validated callers).
  return sanitizeSpokenText(
    `Caller on ${caller.platform}, ${caller.username}: ${caller.text}`
  );
}

// Total wire failure (or an empty first pool): the queue falls back to
// fixed station copy. It is not a story, so it is exempt from the
// no-repeat rule.
const STATION_NOTE_SCRIPT =
  'You are listening to K-B-U-N-K-C, KC Tech Radio. Our news wires are momentarily quiet, ' +
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
// Story ordering and the timeline: freshest first, never twice
//
// David's ordering rule (Nov 19): "stories should be freshest
// first." Within the never-played inventory the queue runs
// newest-first by published timestamp across ALL categories (via
// the mix interleave below): the freshest reporting leads every
// queue. Played items are not ordered at all: they are excluded.
//
// THE TIMELINE (David, Nov 21, 2026; see the header note): one
// shared broadcast, anchored at STATION_EPOCH_MS, advancing in
// 30-minute buckets. "Aired" is computed by DETERMINISTIC REPLAY
// from the pool snapshot: step through every bucket from the
// epoch to the current one; for each, model that bucket's queue
// head exactly the way the real build orders candidates (topic
// guard and entity budget applied; only items published by that
// bucket's end are eligible), and mark the first
// CONSUME_SECONDS_PER_BUCKET of story audio (30 minutes, one
// bucket's worth of broadcast) as played at that bucket. Because
// every instance replays the same function over the same snapshot,
// every instance derives the same aired set: the replay is the
// timeline's memory, and it needs no per-instance state to be
// correct (a module-level cache below only makes it faster).
// The replay is faithful about ORDER and approximate about the
// WORLD, the same honesty as before: past buckets are modeled
// from today's snapshot, so items that have since aged out of
// the feeds are missing from their modeled heads (they cannot
// repeat anyway: they are no longer in the pool), and station
// material is not counted in the 30 minutes.
//
// The persisted played store (lib/played.js) is unioned into the
// replay's RESULT, never into the walk itself: entries the sync
// script has written down stay played even if a pool snapshot
// churns, but they do not steer what the walk consumes.
//
// NOV 22, 2026 CORRECTION (the runaway-consumption bug): the
// first version of this replay pre-loaded the store into the
// walk's played set before stepping through the buckets. That
// made every past bucket's modeled head slide forward past
// everything already recorded, so EACH replay over a fresh pool
// snapshot consumed a brand-new 30-minute slice for EVERY past
// bucket, and the sync unioned all of it into the store: 2,693
// stories were marked played in the first 8.5 hours of the
// timeline, when roughly 450 could actually have aired, and the
// never-played pool collapsed to single digits. The walk below
// is therefore strictly sequential and seed-free: bucket b's
// head is modeled against only what buckets before it, IN THE
// SAME WALK, consumed. A story also counts its straddle: when
// the story crossing a bucket's window boundary has a remainder,
// that remainder is spent at the top of the next bucket (its
// budget shrinks by the carry), so total consumption tracks
// airtime, not queue builds. The store union is applied once,
// at the end, for exclusion only.
//
// NOV 22, 2026, SECOND DEFECT (pool drift, found hours after the
// correction above shipped): seed-free fixed the walk, but the
// sync still unioned a FULL replay (epoch to now) into the
// store on every run, and the replay is a function of the
// current pool snapshot. The pool is rebuilt from the live wires
// every refresh, so each run's replay re-told history with
// different bucket heads (one refresh changed all 17 past
// buckets' heads in measurement), and the append-only union
// banked every variant as phantom plays: the store grew from
// 458 to 1,007 entries in under three hours against ~55
// stories/hour of real airtime. The replay itself is unchanged
// (it is the live exclusion model, recomputed per build); the
// RECORDING is now incremental and frozen per bucket: see
// timelineReplayRange and scripts/played-store-sync.mjs.
//
// MIGRATION SEEDING (Nov 21, 2026): the old system kept no
// trustworthy station-wide play log (its frontier was a model
// over a rolling 12 hours and its exact record was per-listener),
// so nothing from before the epoch is seeded as played. The
// honest consequence: a story that aired under the old system
// before cutover can air once more after cutover if it is still
// in the pool; from the epoch forward, the guarantee is absolute.
// Stories published after cutover are the bulk of the pool within
// a day, so the exposure window is short and stated, not hidden.
// ---------------------------------------------------------------------------

const byFreshestFirst = (a, b) => (b.publishedAt || 0) - (a.publishedAt || 0);

// ---------------------------------------------------------------------------
// Programming mix (David, Nov 20, 2026): the queue targets about 65%
// tech / AI / startup / business, 20% Kansas City, 10% Missouri and
// regional, 5% national and global, measured by story AIRTIME (the
// listener's experience), not by story count. Topic sets the band: a
// startup story counts in the tech band wherever it was filed. Over
// the bands sits the local-out lens: inside every band, Kansas City
// first, then Missouri, then regional, then national, then global;
// and inside the tech band, crossover stories (local tech, local
// business, KC-area SaaS, local startups and founders, the Startland
// and Silicon Prairie class) rank above national tech coverage.
//
// Mechanism: candidates are grouped by band, ordered inside the
// band by freshness and the lens, then interleaved by airtime
// deficit (the band furthest behind its target share of seconds so
// far goes next). The frontier simulation replays this same order,
// so modeled consumption tracks the real build.
// The achieved mix rides the playlist response (see `mix` in
// buildPlaylist's return); a band whose candidates ran out before
// the queue filled is flagged as a shortfall, never silently
// backfilled.
// ---------------------------------------------------------------------------

const MIX_BANDS = [
  { key: 'tech', target: 0.65 },
  { key: 'kc', target: 0.2 },
  { key: 'state', target: 0.1 },
  { key: 'outer', target: 0.05 },
];

const GEO_KC_RE = /kansas city|kc[-\s]?area|kc metro/i;
const GEO_MO_RE = /missouri|st\.?\s*louis|jefferson city/i;
const GEO_REGIONAL_RE = /midwest|\bkansas\b|nebraska|iowa|omaha|wichita|des moines|topeka/i;

/** Geography rank for the local-out lens: 0 KC, 1 Missouri, 2 regional, 3 national, 4 global. */
function geoRankOf(item) {
  switch (item.category) {
    case 'local':
      return 0;
    case 'state':
      return 1;
    case 'regional':
      return 2;
    case 'national':
      return 3;
    case 'global':
      return 4;
    default:
      break;
  }
  const text = `${item.title || ''} ${item.summary || ''}`;
  if (GEO_KC_RE.test(text)) return 0;
  if (GEO_MO_RE.test(text)) return 1;
  if (GEO_REGIONAL_RE.test(text)) return 2;
  return 3;
}

/** The mix band an item counts toward. Topic first: a startup story is tech band. */
function mixBandOf(item) {
  if (isStartupStory(item)) return 'tech';
  // Science, research, and discoveries count inside the 65% band
  // (David, Nov 21, 2026), whatever ring the item was filed under.
  if (isScienceStory(item)) return 'tech';
  switch (item.category) {
    case 'ai':
    case 'tech':
    case 'business':
    case 'science':
    case 'newsletter':
      return 'tech';
    case 'local':
      return 'kc';
    case 'state':
    case 'regional':
      return 'state';
    default:
      return 'outer';
  }
}

/** Crossover: a tech-band story rooted in KC or Missouri, or from a crossover source. */
function isCrossover(item) {
  return (
    mixBandOf(item) === 'tech' &&
    (geoRankOf(item) <= 1 || STARTUP_SOURCES.has(item.source))
  );
}

// Story script seconds, cached per pool item object: the frontier
// replays the candidate order 24 times per build, and the mix
// interleave prices every candidate once per replay.
const storySecondsCache = new WeakMap();
function storySeconds(item) {
  let s = storySecondsCache.get(item);
  if (s === undefined) {
    s = estimateSeconds(storyScript(item));
    storySecondsCache.set(item, s);
  }
  return s;
}

/**
 * Merge one phase's band-ordered entries into a single candidate
 * order that converges on the target airtime mix: repeatedly take
 * the head of the band furthest behind its target share of the
 * seconds selected so far. A band that runs out simply stops
 * competing; the rest keep balancing among themselves.
 */
function interleaveByMix(entries) {
  const lists = MIX_BANDS.map((b) => ({ ...b, queue: [], seconds: 0 }));
  const byKey = new Map(lists.map((l) => [l.key, l]));
  for (const e of entries) byKey.get(e.band).queue.push(e);
  const out = [];
  for (;;) {
    let best = null;
    for (const l of lists) {
      if (!l.queue.length) continue;
      if (!best || l.seconds / l.target < best.seconds / best.target) best = l;
    }
    if (!best) break;
    const e = best.queue.shift();
    best.seconds += storySeconds(e.item);
    out.push(e);
  }
  return out;
}

/**
 * Candidate order for one build, given the played map, interleaved
 * toward the programming mix (see the mix note above). Inside a
 * band: never-played items only (played items sort last and are
 * filtered out by the caller; the timeline replay uses the same
 * order to decide what a bucket's head consumed), then crossover
 * first (tech band), then the local-out lens, then freshest first.
 * The interleave runs over the combined list, not per phase:
 * consumption retires bands roughly in mix proportion, so a strict
 * fresh-first phase split would drain the fresh tech supply and
 * let the queue backfill with out-of-band fresh items long before
 * it reached the played tech items. Freshness leads INSIDE each
 * band; the mix governs across bands. Each entry is
 * { item, played, band, geo }.
 */
export function orderCandidates(storyItems, played) {
  const entries = storyItems.map((item) => ({
    item,
    played: played.has(item.id),
    band: mixBandOf(item),
    geo: geoRankOf(item),
  }));
  entries.sort(
    (a, b) =>
      Number(a.played) - Number(b.played) ||
      Number(isCrossover(b.item)) - Number(isCrossover(a.item)) ||
      a.geo - b.geo ||
      byFreshestFirst(a.item, b.item)
  );
  return interleaveByMix(entries);
}

/**
 * The deterministic timeline replay described above, as a pure
 * function of (pool snapshot, clock): walk every bucket from the
 * station epoch to the current one IN ORDER, modeling each
 * bucket's queue head against only what earlier buckets IN THE
 * SAME WALK consumed, and spending each bucket's airtime window
 * (CONSUME_SECONDS_PER_BUCKET) on the head's story audio. The
 * story straddling a window's end counts as aired at that bucket,
 * and its remainder carries into the next bucket, whose window
 * shrinks by the carry: the walk models ONE continuous broadcast,
 * not a stack of independent queue builds.
 *
 * Returns { played, carryInByBucket, carryInSeconds }:
 *   played           Map of item.id -> playedAt (epoch ms of the
 *                    bucket start whose modeled head aired it).
 *   carryInByBucket  Map of bucket -> seconds of that bucket's
 *                    window already spent finishing the previous
 *                    bucket's straddling story.
 *   carryInSeconds   the carry into the current bucket.
 *
 * The persisted played store is NOT an input to this walk (see
 * the Nov 22 correction note above): timelineAired unions it
 * into the result for exclusion. The walk itself must stay
 * seed-free, or every past head slides and re-consumes.
 *
 * Performance: a module-level cache keyed by the pool signature
 * lets a warm instance extend the walk bucket by bucket instead
 * of replaying from the epoch on every build. The cache is a
 * speed detail only: a cold instance replays from the epoch and
 * derives the identical map.
 */
const timelineCache =
  globalThis.__kctrTimelineCache ||
  (globalThis.__kctrTimelineCache = {
    sig: '',
    bucket: -1,
    played: null,
    carryIn: 0,
    carryInByBucket: null,
  });

/**
 * The bucket walk itself, shared by timelineReplay (the full
 * seed-free walk) and timelineReplayRange (a bounded walk over
 * not-yet-recorded buckets). Steps buckets [fromBucket, toBucket)
 * in order, mutating `played` (item.id -> bucket start ms) with
 * everything the walked heads consume, starting from `carryIn`
 * seconds of the first bucket's window already spent on the
 * previous bucket's straddling story. Returns the per-bucket
 * carry-ins for the walked range and the carry into toBucket.
 */
function walkBuckets(storyItems, fromBucket, toBucket, played, carryIn) {
  const epochBucket = Math.floor(STATION_EPOCH_MS / BUCKET_MS);
  const carryInByBucket = new Map();
  // Guard profiles are pure per item; compute each at most once
  // across all modeled heads in this replay pass.
  const profileCache = new Map();
  const profileOf = (item) => {
    let p = profileCache.get(item.id);
    if (!p) {
      p = storyProfile(item);
      profileCache.set(item.id, p);
    }
    return p;
  };
  for (let b = Math.max(fromBucket, epochBucket); b < toBucket; b++) {
    const bucketStart = b * BUCKET_MS;
    // Eligibility is gated on the bucket's END, not its start: a
    // queue built during bucket b serves listeners until b+1, and
    // its pool snapshot includes anything published before the
    // build, so an item published mid-bucket can sit in that
    // bucket's head and must be consumable by it. (Start-gating
    // left the freshest items unretirable for a full extra
    // bucket: they led two consecutive queues untouched.)
    const eligibleBefore = bucketStart + BUCKET_MS;
    carryInByBucket.set(b, carryIn);
    // This bucket's window is what's left of its 30 minutes after
    // finishing the story that straddled the previous boundary.
    const budget = CONSUME_SECONDS_PER_BUCKET - carryIn;
    const profiles = [];
    const entityCounts = new Map();
    let seconds = 0;
    let carryOut = 0;
    for (const { item, played: alreadyPlayed } of orderCandidates(storyItems, played)) {
      if (seconds >= budget) break;
      // A played story is not in the queue, so a modeled head can
      // never consume it again. (Under the retired model this loop
      // could re-consume aired items as the fallback tail; that was
      // the recycling mechanism, and it is gone.)
      if (alreadyPlayed) continue;
      if ((item.publishedAt || 0) > eligibleBefore) continue; // not yet published at that bucket
      const profile = profileOf(item);
      if (profiles.some((p) => topicGuardMatches(p, profile))) continue;
      if (
        profile.dominantEntity &&
        (entityCounts.get(profile.dominantEntity) || 0) >= ENTITY_BUDGET_MAX
      ) {
        continue;
      }
      profiles.push(profile);
      if (profile.dominantEntity) {
        entityCounts.set(
          profile.dominantEntity,
          (entityCounts.get(profile.dominantEntity) || 0) + 1
        );
      }
      played.set(item.id, bucketStart);
      seconds += storySeconds(item);
      // The story that crosses the window's end has aired; only
      // its remainder carries into the next bucket.
      if (seconds > budget) carryOut = seconds - budget;
    }
    carryIn = carryOut;
  }
  return { carryInByBucket, carryInSeconds: carryIn };
}

export function timelineReplay(storyItems, nowMs) {
  const bucket = Math.floor(nowMs / BUCKET_MS);
  const epochBucket = Math.floor(STATION_EPOCH_MS / BUCKET_MS);
  const sig = `${storyItems.length}|${storyItems[0]?.id || ''}|${storyItems[storyItems.length - 1]?.id || ''}`;
  let played;
  let fromBucket;
  let carryIn;
  let carryInByBucket;
  if (
    timelineCache.sig === sig &&
    timelineCache.played &&
    timelineCache.bucket >= epochBucket &&
    timelineCache.bucket <= bucket
  ) {
    played = timelineCache.played;
    fromBucket = timelineCache.bucket;
    carryIn = timelineCache.carryIn;
    carryInByBucket = timelineCache.carryInByBucket;
  } else {
    played = new Map();
    fromBucket = epochBucket;
    carryIn = 0;
    carryInByBucket = new Map();
  }
  const walked = walkBuckets(storyItems, fromBucket, bucket, played, carryIn);
  for (const [b, c] of walked.carryInByBucket) carryInByBucket.set(b, c);
  carryIn = walked.carryInSeconds;
  timelineCache.sig = sig;
  timelineCache.bucket = bucket;
  timelineCache.played = played;
  timelineCache.carryIn = carryIn;
  timelineCache.carryInByBucket = carryInByBucket;
  return { played, carryInByBucket, carryInSeconds: carryIn };
}

/**
 * A bounded walk over buckets [fromBucket, toBucket), starting
 * from an existing played map and carry-in: the recording walk
 * the played-store sync uses (Nov 22, 2026, pool-drift fix).
 *
 * Why this exists: the full replay is a pure function of the
 * CURRENT pool snapshot, and the pool is rebuilt from the live
 * wires every refresh (items arrive with old publishedAt stamps,
 * feeds drop out, headline dedupe swaps which item id survives a
 * cluster, body enrichment changes story durations). Replaying
 * PAST buckets over a drifted pool therefore tells a different
 * history each time: measured Nov 22, one refresh changed the
 * modeled head of every one of 17 past buckets, and the sync's
 * append-only union of each full replay converted that variance
 * into phantom plays, growing the store ~200 stories/hour
 * against ~55/hour of real airtime. The recording discipline is
 * now: a bucket's aired set is derived ONCE, by the first walk
 * that reaches it after it completes, seeded with everything
 * already recorded, and is then frozen in the store forever;
 * later pool states are never allowed to add stories to a
 * recorded bucket. This walk is that derivation: it consumes
 * only the not-yet-recorded range, against the recorded state.
 *
 * Returns { played, carryInByBucket, carryInSeconds } where
 * `played` holds ONLY the entries consumed inside the range
 * (item.id -> bucket start ms), carryInByBucket covers the
 * range, and carryInSeconds is the carry into toBucket (persist
 * it: it is the next range's starting carry).
 */
export function timelineReplayRange(storyItems, fromBucket, toBucket, initialPlayed, initialCarryInSeconds = 0) {
  const played = new Map(initialPlayed || []);
  const { carryInByBucket, carryInSeconds } = walkBuckets(
    storyItems,
    fromBucket,
    toBucket,
    played,
    initialCarryInSeconds || 0
  );
  const fresh = new Map();
  for (const [key, playedAt] of played) {
    if (!initialPlayed || !initialPlayed.has(key)) fresh.set(key, playedAt);
  }
  return { played: fresh, carryInByBucket, carryInSeconds };
}

/**
 * The aired set for exclusion: the deterministic replay UNION the
 * persisted played store (`seed`, a Map of key -> playedAt from
 * lib/played.js), so store entries stay played even when a pool
 * snapshot churns. The seed never steers the replay (see
 * timelineReplay); it only adds exclusions on top of it.
 */
export function timelineAired(storyItems, nowMs, seed) {
  const { played } = timelineReplay(storyItems, nowMs);
  if (!seed || seed.size === 0) return played;
  const merged = new Map(played);
  const inPool = new Set(storyItems.map((i) => i.id));
  for (const [key, playedAt] of seed) {
    if (inPool.has(key) && playedAt <= nowMs && !merged.has(key)) {
      merged.set(key, playedAt);
    }
  }
  return merged;
}

/** Back-compat alias: the retired name for the timeline replay. */
export const simulateAiredFrontier = timelineAired;

// ---------------------------------------------------------------------------
// Queue builder
// ---------------------------------------------------------------------------

/**
 * Build the continuous queue starting "now".
 *
 * @param pool    news pool from ingest.getNewsPool()
 * @param weather weather object or null
 * @param nowMs   epoch ms to build from (injectable for tests); only
 *                its 30-minute bucket matters (the lead window)
 * @param socialItems  validated social caller items from
 *                lib/social.js (optional; may also arrive as
 *                pool.socialItems). An empty or missing list means
 *                no callers, and the queue is exactly the just-news
 *                queue.
 * @param playedMap  the persisted played store (Map key -> playedAt
 *                from lib/played.js; optional). Unioned with the
 *                timeline replay: a story in either never queues.
 * @returns { generatedAt, bucket, queueSeconds, bufferSeconds, topicGuardSkipped, entityBudgetSkipped, callerCount, neverAiredStories, recycledStories, poolNeverAired, poolRecycled, playedExcludedStories, playedStoreSize, timeline, segments }
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
 *                   `neverAiredStories` counts this queue's stories
 *                   (every story in the queue is never-played by
 *                   construction); `recycledStories` is always 0
 *                   since Nov 21, 2026 and is kept only so older
 *                   consumers do not break; `poolNeverAired` is the
 *                   never-played candidate count at build time and
 *                   `poolRecycled` is kept as the count of pool
 *                   stories excluded as already played (the field's
 *                   pre-ruling meaning, the served recycled count,
 *                   no longer exists). `timeline` carries the shared
 *                   broadcast position: { epochMs, bucketStartMs,
 *                   liveOffsetSeconds, onAir }.
 */
// ============================================================================
// TIME-BOUND STORY EXPIRY — David's date rule, generalized (Nov 20, 2026).
//
// The music rule ("anything with a date should be for current or future")
// applies to stories too. A voter guide for the November 3 election was
// still airing as news on November 20 because time-bound stories carried
// no expiry: the pool kept them and the recycled fallback kept re-airing
// them. Post-election ANALYSIS is news and must survive; only the
// time-bound classes below expire, each against its own date:
//
//   guide     voter guides and ballot recommendations (title matches
//             VOTER GUIDE / PEOPLE'S BALLOT / BALLOT GUIDE / ELECTION
//             GUIDE / WHAT'S ON THE/YOUR BALLOT): expire after the
//             election date the item itself references (latest month/day
//             reference in title+summary at or after publication); with
//             no parseable date, 14 days after publication.
//   advocacy  ballot advocacy (title matches VOTING YES/NO ON, IS VOTING
//             NO ON, ...): same date rule as guides.
//   dayof     "Election Day is here" class (title+summary): the event is
//             publication day; expires the day after.
//   tonight   titles claiming TONIGHT: the event is publication day;
//             expires the day after.
//
// Expiry is enforced at queue build (in buildPlaylist), never at ingest:
// the pool stays complete, and the drop count is reported on the
// playlist as expiredStories so the filtering is never silent.
// ============================================================================

const EXPIRY_MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3,
  april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const EXPIRY_DATE_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;

function chicagoDateStr(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function addDaysToDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The latest month/day date a text references, resolved against the
 * publication time: candidates in the publication year (rolling to the
 * next year when the date falls more than 2 days before publication),
 * kept when they land within [pub - 2d, pub + 60d]. Returns a
 * YYYY-MM-DD string or null.
 */
export function referencedEventDate(text, pubMs) {
  if (!text || !pubMs) return null;
  const pubYear = new Date(pubMs).getUTCFullYear();
  let best = null;
  for (const m of String(text).matchAll(EXPIRY_DATE_RE)) {
    const month = EXPIRY_MONTHS[m[1].toLowerCase().replace('.', '')];
    const day = parseInt(m[2], 10);
    if (month === undefined || !(day >= 1 && day <= 31)) continue;
    for (const year of [pubYear, pubYear + 1]) {
      const ms = Date.UTC(year, month, day, 12);
      if (ms >= pubMs - 2 * 86400000 && ms <= pubMs + 60 * 86400000) {
        const s = new Date(ms).toISOString().slice(0, 10);
        if (!best || s > best) best = s;
      }
    }
  }
  return best;
}

/**
 * True when a story item belongs to a time-bound class whose date has
 * passed as of `todayStr` (YYYY-MM-DD, America/Chicago). Conservative by
 * design: bare election coverage, results, and analysis match no class.
 */
/**
 * RETIRED Nov 21, 2026: the 72-hour cap governed which RECYCLED
 * stories could re-air; the no-repeats ruling abolished recycling,
 * so no age makes a played story eligible again. Kept as an export
 * only so older harnesses that import the name do not break.
 */
export const MAX_RECYCLED_AGE_MS = 72 * 60 * 60 * 1000;

export function isStoryExpired(item, todayStr) {
  const title = item.title || '';
  const text = `${title} ${item.summary || ''}`;
  const pubMs = item.publishedAt || null;
  const pubStr = pubMs ? chicagoDateStr(pubMs) : todayStr;

  const isGuide =
    /voter guide|people'?s ballot|ballot guide|election guide|what'?s on (the|your) ballot/i.test(title);
  const isAdvocacy = /vot(ing|e)\s+(yes|no)\s+on|is voting (yes|no)/i.test(title);
  if (isGuide || isAdvocacy) {
    const eventDate = referencedEventDate(text, pubMs || Date.now());
    if (eventDate) return todayStr > eventDate;
    // No parseable date: guides publish close to their election.
    return todayStr > addDaysToDateStr(pubStr, 14);
  }
  if (/election day is (finally\s+)?here|it'?s election day/i.test(text)) {
    return todayStr > addDaysToDateStr(pubStr, 1);
  }
  if (/\btonight\b/i.test(title)) {
    return todayStr > addDaysToDateStr(pubStr, 1);
  }
  return false;
}

export function buildPlaylist(pool, weather, nowMs = Date.now(), socialItems, playedMap) {
  const pools = {};
  for (const cat of [...STORY_CATEGORIES, 'music', 'performance']) {
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

  // Story candidates in queue order (see the ordering note at
  // timelineAired): never-played items only, freshest first inside
  // each mix band. Music is not part of this: listings keep their
  // own section, below.
  const storyItems = STORY_CATEGORIES.flatMap((cat) => pools[cat]);
  const played = timelineAired(storyItems, nowMs, playedMap);
  const allOrdered = orderCandidates(storyItems, played);
  // NO REPEATS (David, Nov 21, 2026): a played story is excluded,
  // full stop. There is no fallback tail and no age at which a
  // played story becomes eligible again, so the Nov 20 72-hour
  // recycling cap is retired with the recycling it governed
  // (ageCappedStories stays in the return shape, always 0, so the
  // response never lies by omission about the old field).
  // Time-bound story expiry (see isStoryExpired) still applies to
  // never-played items: a voter guide for a past election never
  // reaches the queue, however the pool holds it.
  const storyTodayStr = chicagoDateStr(nowMs);
  let expiredStories = 0;
  let ageCappedStories = 0;
  let playedExcludedStories = 0;
  const ordered = allOrdered.filter(({ item, played: isPlayed }) => {
    if (isPlayed) {
      playedExcludedStories += 1;
      return false;
    }
    if (isStoryExpired(item, storyTodayStr)) {
      expiredStories += 1;
      return false;
    }
    return true;
  });
  const poolNeverAired = ordered.length;
  const poolRecycled = playedExcludedStories;
  // Mix accounting (see the programming mix note at orderCandidates):
  // candidates available per band after the expiry and age filters,
  // and how many the fill loop actually considers before it stops.
  const mixPool = {};
  const mixConsidered = {};
  for (const e of ordered) mixPool[e.band] = (mixPool[e.band] || 0) + 1;

  const musicListings = pools.music;
  // David's event-date rule (Nov 20, 2026), applied once for the whole
  // build: dated listings air only when their date is today or later
  // (America/Chicago), and "tonight" copy airs only for today's date.
  // See pushMusicSection for the rundown ordering.
  const musicTodayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
  const currentMusicListings = musicListings.filter((it) => {
    if (it.eventDate && it.eventDate < musicTodayStr) return false;
    if (/tonight/i.test(it.when || '') && it.eventDate !== musicTodayStr) return false;
    return true;
  });

  // The Marquee (David, Nov 24, 2026): theatre and comedy listings
  // from the KC Performances Space, aired like the music rundown.
  // David's rule is absolute: never stale, never expired. Ingest has
  // already dropped listings without verified dates; HERE, at queue
  // build, anything whose run has ended (endDate before today,
  // America/Chicago) is dropped and counted as expiredPerformances on
  // the response. The spoken date text is composed from the dates
  // themselves (perfWhenText), so "tonight" can only ever be said
  // about today's date.
  const perfListings = pools.performance;
  let expiredPerformances = 0;
  const fmtPerfDay = (dateStr) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(new Date(`${dateStr}T12:00:00Z`));
  const perfAirDate = (it) =>
    it.startDate <= musicTodayStr && musicTodayStr <= it.endDate
      ? musicTodayStr
      : it.startDate;
  const perfWhenText = (it) => {
    const inProgress = it.startDate <= musicTodayStr && musicTodayStr <= it.endDate;
    const time =
      it.timeText && it.timeText.length <= 45 ? it.timeText : '';
    if (it.perfCategory === 'theatre') {
      if (inProgress) return `now playing through ${fmtPerfDay(it.endDate)}`;
      return it.endDate > it.startDate
        ? `opens ${fmtPerfDay(it.startDate)}, runs through ${fmtPerfDay(it.endDate)}`
        : `opens ${fmtPerfDay(it.startDate)}`;
    }
    // comedy
    if (inProgress) {
      if (it.endDate === musicTodayStr) {
        return time ? `tonight, ${time}, final show` : 'tonight, final show';
      }
      return `tonight, and running through ${fmtPerfDay(it.endDate)}`;
    }
    if (it.startDate === musicTodayStr) {
      return time ? `tonight, ${time}` : 'tonight';
    }
    return time ? `${fmtPerfDay(it.startDate)}, ${time}` : fmtPerfDay(it.startDate);
  };
  const currentPerfListings = perfListings.filter((it) => {
    if (!it.startDate || !it.endDate || it.endDate < musicTodayStr) {
      expiredPerformances += 1;
      return false;
    }
    return true;
  });

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

  // Station ID rotation state for this build: the pool index of the
  // last ID aired, so the next one never repeats it back to back.
  let lastStationIdIdx = -1;

  // Jingles (Route 1, David approved Nov 20, 2026): pre-rendered
  // half-chanted IDs over the public-domain Tiger Rag bed, manifest in
  // lib/jingles.json (rendered by scripts/render-jingles.mjs). They
  // take every third station ID slot and open the Wasteland Jukebox,
  // rotating through the pool so the same jingle never airs twice in
  // a row. Their audio is a finished static file, not a TTS render.
  let stationIdSlot = 0;
  let jingleCursor = JINGLE_MANIFEST.length
    ? hashString(bucket) % JINGLE_MANIFEST.length
    : 0;
  const nextJingle = (id) => {
    if (!JINGLE_MANIFEST.length) return null;
    const entry = JINGLE_MANIFEST[jingleCursor % JINGLE_MANIFEST.length];
    jingleCursor += 1;
    return {
      id,
      kind: 'jingle',
      blockKey: 'station-id',
      category: 'station',
      title: 'KBUNKC Jingle',
      headline: 'KC Tech Radio',
      source: 'KC Tech Radio',
      script: entry.script,
      estSeconds: entry.seconds,
      audioUrl: entry.file,
    };
  };

  // Wasteland Jukebox tracks (David approved Nov 20, 2026): vintage
  // recordings whose public-domain status was verified track by
  // track before airing (see public/jukebox/CREDITS.md), manifest in
  // lib/jukebox.json. Each Jukebox block closes with two tracks,
  // rotating through the pool by the same bucket-seeded cursor
  // pattern as the jingles. Finished static files, not TTS renders.
  let jukeboxCursor = JUKEBOX_MANIFEST.length
    ? hashString(bucket) % JUKEBOX_MANIFEST.length
    : 0;
  const usedTrackFiles = new Set();
  const usedDeskScripts = new Set();
  const nextJukeboxTrack = (id) => {
    if (!JUKEBOX_MANIFEST.length) return null;
    // Strict reading (boundary item): in content class, a track
    // recorded in the played store never airs again; when the whole
    // shelf has aired, there are no more track segments.
    if (JUKEBOX_TRACK_CLASS === 'content' && playedMap) {
      let entry = null;
      for (let k = 0; k < JUKEBOX_MANIFEST.length; k++) {
        const cand = JUKEBOX_MANIFEST[(jukeboxCursor + k) % JUKEBOX_MANIFEST.length];
        if (usedTrackFiles.has(cand.file)) continue;
        if (!playedMap.has(TRACK_PLAYED_PREFIX + cand.file)) { entry = cand; break; }
      }
      if (!entry) return null;
      usedTrackFiles.add(entry.file);
      jukeboxCursor += 1;
      const display = `${entry.title}, ${entry.artist} (${entry.year})`;
      return {
        id,
        kind: 'track',
        blockKey: 'kc-music',
        category: 'music',
        title: SECTION_TITLES['kc-music'],
        headline: display,
        source: 'Internet Archive 78rpm',
        script: `From the Wasteland Jukebox shellac shelf: ${display}.`,
        estSeconds: entry.seconds,
        audioUrl: entry.file,
      };
    }
    const entry = JUKEBOX_MANIFEST[jukeboxCursor % JUKEBOX_MANIFEST.length];
    jukeboxCursor += 1;
    const display = `${entry.title}, ${entry.artist} (${entry.year})`;
    return {
      id,
      kind: 'track',
      blockKey: 'kc-music',
      category: 'music',
      title: SECTION_TITLES['kc-music'],
      headline: display,
      source: 'Internet Archive 78rpm',
      script: `From the Wasteland Jukebox shellac shelf: ${display}.`,
      estSeconds: entry.seconds,
      audioUrl: entry.file,
    };
  };

  // The queue opens with a station ID: identification first, then news.
  {
    const id = nextId('station-id');
    const pick = stationIdScript(id, lastStationIdIdx);
    lastStationIdIdx = pick.idx;
    const script = pick.script;
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
    stationIdSlot = 1;
  }
  let lastIdEnd = elapsed;
  let lastWeatherEnd = 0;
  let lastDeskEnd = 0;
  let lastJukeboxEnd = 0;

  const pushMusicSection = () => {
    // Kansas City Music Scene. Listings come from the music feed
    // (venue-verified only; see README "Music feed").
    //
    // David's event-date rule (Nov 20, 2026), enforced HERE, at queue
    // build, so no feed staleness can put a past show on air: the
    // currentMusicListings filter above has already dropped past-dated
    // listings and any "tonight" copy not dated today. The rundown
    // runs soonest first (the event form of freshest first), kind
    // order breaking same-date ties, feed order inside that; the
    // section caps at 6 listings.
    const currentListings = currentMusicListings;
    // The Wasteland Jukebox opens with a jingle (Route 1).
    const jingle = nextJingle(nextId('jingle'));
    if (jingle) push(jingle);
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
    const kindRank = (kind) => {
      const i = KIND_ORDER.indexOf(kind);
      return i === -1 ? KIND_ORDER.length : i;
    };
    const rundown = [...currentListings]
      .sort(
        (a, b) =>
          String(a.eventDate || '9999-99-99').localeCompare(
            String(b.eventDate || '9999-99-99')
          ) || kindRank(a.musicKind) - kindRank(b.musicKind)
      )
      .slice(0, 6);
    rundown.forEach((item, i) => {
      const id = nextId('music', `-${hashString(item.id).toString(36)}`);
      const lead =
        MUSIC_LEADS[item.musicKind][hashString(id) % MUSIC_LEADS[item.musicKind].length];
      // Facts stay straight: artist, venue, and date/time exactly as
      // the (venue-verified) feed carries them. Listings open with
      // their own MUSIC_LEADS lead-in only, no story transition.
      const script = sanitizeSpokenText(
        `${lead} ${item.artist} at ${item.venue}, ${item.when}.`
      );
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
        eventDate: item.eventDate || null,
        musicKind: item.musicKind,
        script,
        estSeconds: estimateSeconds(script),
      });
    });
    // The block closes with two spins from the shellac shelf
    // (Wasteland Jukebox tracks, verified public domain; see
    // nextJukeboxTrack above).
    for (let t = 0; t < 2; t++) {
      const track = nextJukeboxTrack(nextId('track'));
      if (track) push(track);
    }
  };

  const pushStageSection = () => {
    // The Marquee: Kansas City theatre and comedy from the KC
    // Performances Space feed. A service segment like the shows
    // rundown: exempt from the played store, capped at once an hour
    // of queue audio by lastPerfEnd. Listings run soonest first (by
    // air date: today for a run in progress, opening night for one
    // coming up), cap 6, and the spoken dates come from
    // perfWhenText, never from free feed text, so nothing stale or
    // misdated can be announced.
    const introId = nextId('intro');
    const intro = pickFromPool(SHOW_OPENS['kc-stage'], introId);
    push({
      id: introId,
      kind: 'intro',
      blockKey: 'kc-stage',
      category: 'performance',
      title: SECTION_TITLES['kc-stage'],
      headline: SECTION_TITLES['kc-stage'],
      source: 'KC Tech Radio',
      script: intro,
      estSeconds: estimateSeconds(intro),
    });
    const rundown = [...currentPerfListings]
      .sort(
        (a, b) =>
          perfAirDate(a).localeCompare(perfAirDate(b)) ||
          String(a.startDate).localeCompare(String(b.startDate))
      )
      .slice(0, 6);
    rundown.forEach((item) => {
      const id = nextId('performance', `-${hashString(item.id).toString(36)}`);
      const leads = PERF_LEADS[item.perfCategory] || PERF_LEADS.comedy;
      const lead = leads[hashString(id) % leads.length];
      const preview = item.preview
        ? trimToSentenceBoundary(item.preview, 200)
        : '';
      const script = sanitizeSpokenText(
        `${lead} ${item.title} at ${item.venue}, ${perfWhenText(item)}.${preview ? ` ${preview}` : ''}`
      );
      push({
        id,
        kind: 'performance',
        blockKey: 'kc-stage',
        category: 'performance',
        title: SECTION_TITLES['kc-stage'],
        headline: item.title,
        source: item.venue,
        link: item.url || item.link,
        venue: item.venue,
        perfCategory: item.perfCategory,
        startDate: item.startDate,
        endDate: item.endDate,
        eventDate: perfAirDate(item),
        script,
        estSeconds: estimateSeconds(script),
      });
    });
  };

  let storyCount = 0;
  // Every story in the queue is never-played by construction (the
  // played filter above is absolute). neverAiredStories therefore
  // equals storyCount; recycledStories is structurally 0 and is
  // still reported, so the absence of recycling is measured on
  // every response rather than asserted.
  let neverAiredStories = 0;
  let recycledStories = 0;
  let musicInserted = false;
  let lastMusicEnd = -Infinity; // last shows-rundown placement (hourly cap)
  let perfInserted = false;
  let lastPerfEnd = -Infinity; // last Marquee placement (hourly cap)
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

  for (const entry of ordered) {
    const { item } = entry;
    if (elapsed >= TARGET_QUEUE_SECONDS) break;
    if (segments.length >= MAX_QUEUE_SEGMENTS) break;
    mixConsidered[entry.band] = (mixConsidered[entry.band] || 0) + 1;

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
      mixBand: entry.band,
      title: SECTION_TITLES[section],
      headline: item.title,
      source: item.source,
      link: item.link,
      script,
      estSeconds: estimateSeconds(script),
    });
    storyCount += 1;
    neverAiredStories += 1;

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
      stationIdSlot += 1;
      // Every third ID slot is a jingle instead of a spoken PSA ID.
      const jingle = stationIdSlot % 3 === 0 ? nextJingle(sidId) : null;
      if (jingle) {
        push(jingle);
      } else {
        const sidPick = stationIdScript(sidId, lastStationIdIdx);
        lastStationIdIdx = sidPick.idx;
        const sidScript = sidPick.script;
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
      }
      lastIdEnd = elapsed;
    } else if (weather && elapsed - lastWeatherEnd >= WEATHER_EVERY_SECONDS) {
      const wId = nextId('weather');
      const wScript = weatherScript(weather);
      push({
        id: wId,
        kind: 'weather',
        blockKey: 'weather',
        category: 'station',
        title: 'Surface Conditions',
        headline: 'KC Tech Radio',
        source: 'KC Tech Radio',
        script: wScript,
        estSeconds: estimateSeconds(wScript),
      });
      lastWeatherEnd = elapsed;
    } else if (elapsed - lastDeskEnd >= DESK_EVERY_SECONDS) {
      const dId = nextId('producers-desk');
      let dScript = producersDeskScript(dId, playedMap);
      for (let retry = 1; dScript && usedDeskScripts.has(dScript) && retry < PRODUCERS_DESK.length; retry++) {
        dScript = producersDeskScript(dId + ':r' + retry, playedMap);
      }
      if (dScript && usedDeskScripts.has(dScript)) dScript = null;
      if (dScript) usedDeskScripts.add(dScript);
      if (dScript) push({
        id: dId,
        kind: 'producers-desk',
        blockKey: 'producers-desk',
        category: 'station',
        title: 'Dispatches from the Bunker',
        headline: 'Dispatches from the Bunker',
        source: 'KC Tech Radio',
        script: dScript,
        estSeconds: estimateSeconds(dScript),
      });
      if (dScript) lastDeskEnd = elapsed;
    } else if (elapsed - lastJukeboxEnd >= JUKEBOX_EVERY_SECONDS) {
      // Wasteland Jukebox block (burn-rate lever, Nov 21, 2026):
      // two shellac tracks about every 45 minutes of queue audio.
      // Every block is airtime that burns zero unique stories.
      // Under the strict reading the shelf is finite (each track
      // airs once, ever), so this lever lasts only while unplayed
      // tracks remain; see JUKEBOX_TRACK_CLASS.
      for (let t = 0; t < 2; t++) {
        const track = nextJukeboxTrack(nextId('track'));
        if (track) push(track);
      }
      lastJukeboxEnd = elapsed;
    }

    // The KC shows rundown: first lands about 45 minutes in, then
    // at most ONCE AN HOUR of queue audio. This is David's single
    // stated exception to the no-repeats rule (Nov 21, 2026):
    // "the exceptions are live shows listing can play once an
    // hour." The rundown is a service segment, not a news story:
    // it is exempt from the played store, never enters it, and the
    // hourly cap is enforced by lastMusicEnd. The underlying feed
    // is refreshed daily, as before. No other exceptions exist:
    // news stories remain never-repeat, permanently.
    if (
      currentMusicListings.length &&
      elapsed >= MUSIC_AT_SECONDS &&
      elapsed - lastMusicEnd >= MUSIC_RUNDOWN_EVERY_SECONDS
    ) {
      pushMusicSection();
      musicInserted = true;
      lastMusicEnd = elapsed;
      lastJukeboxEnd = elapsed;
    }

    // The Marquee rundown: first lands about 100 minutes in, then at
    // most once an hour of queue audio, under the same Nov 21, 2026
    // service-segment exception as the live shows listing. It never
    // enters the played store.
    if (
      currentPerfListings.length &&
      elapsed >= PERF_AT_SECONDS &&
      elapsed - lastPerfEnd >= MUSIC_RUNDOWN_EVERY_SECONDS
    ) {
      pushStageSection();
      perfInserted = true;
      lastPerfEnd = elapsed;
    }
  }

  // A short queue (thin pool) still gets its music rundown, at the end.
  if (!musicInserted && currentMusicListings.length && storyCount >= 5) {
    pushMusicSection();
    musicInserted = true;
    lastJukeboxEnd = elapsed;
  }

  // Same for The Marquee on a short queue.
  if (!perfInserted && currentPerfListings.length && storyCount >= 5) {
    pushStageSection();
    perfInserted = true;
  }

  // THIN BUCKET (no-repeats era): when the never-played supply runs
  // out before the queue covers even one full bucket of broadcast,
  // the chunk is padded with Wasteland Jukebox tracks until it
  // covers the bucket. The alternative would be repeating a story,
  // which the ruling forbids; the honest cost of a thin hour is
  // more music and less news, and the response counts
  // (poolNeverAired, playedExcludedStories) show exactly how thin
  // the supply was. Padding draws unplayed Jukebox tracks while the
  // shelf lasts (content class, strict reading); after that the
  // chunk is simply shorter rather than repeating anything.
  if (storyCount > 0 && elapsed < BUCKET_MS / 1000) {
    let guard = 0;
    while (elapsed < BUCKET_MS / 1000 && guard < 16) {
      const track = nextJukeboxTrack(nextId('track'));
      if (!track) break;
      push(track);
      guard += 1;
    }
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
    // No spoken URLs (David, Nov 23, 2026): the final guarantee.
    // Story and caller scripts are sanitized where they are composed;
    // this pass covers every other segment kind (station copy, desk,
    // weather, music, filler) so the invariant "no segment script
    // leaves buildPlaylist carrying a URL" holds by construction.
    // A URL and its bare domain are both single spoken tokens, so
    // estimates barely move; when the text did change, re-estimate
    // from the sanitized script to keep labels honest.
    const script = sanitizeSpokenText(seg.script);
    const baseEst =
      script === seg.script ? seg.estSeconds : estimateSeconds(script);
    // Length-label calibration (measured Nov 20, 2026, stratified
    // sample of 28 stories): stories labeled 30 seconds or more
    // actually play at about 0.93 of the raw word-count estimate,
    // while short items and non-story segments are accurate.
    // Correct story labels here so buffer math, the on-page
    // lengths, and the mix measurement all tell the truth.
    const estSeconds =
      seg.kind === 'story' && baseEst >= 30
        ? Math.max(1, Math.round(baseEst * 0.93))
        : baseEst;
    // Jingle segments carry their finished static audio file; every
    // other segment's URL derives from its voice + script as usual.
    return {
      ...seg,
      script,
      estSeconds,
      voice,
      audioUrl: seg.audioUrl || audioUrlFor(voice, script, seg.id),
    };
  });
  const adjustedElapsed = out.reduce((a, s) => a + (s.estSeconds || 0), 0);

  // Achieved mix for this queue, from the finished segments (so the
  // calibrated lengths are what count): per band, the target, the
  // story count and airtime shares, the candidate pool it drew
  // from, and a shortfall flag when the band's candidates ran out
  // before the queue filled and it still landed under target.
  const mix = {};
  {
    const storySegs = out.filter((s) => s.kind === 'story');
    const totalStorySeconds = storySegs.reduce((a, s) => a + (s.estSeconds || 0), 0);
    for (const b of MIX_BANDS) {
      const segsB = storySegs.filter((s) => s.mixBand === b.key);
      const secs = segsB.reduce((a, s) => a + (s.estSeconds || 0), 0);
      const targetPct = Math.round(b.target * 1000) / 10;
      const airtimePct = totalStorySeconds
        ? Math.round((secs / totalStorySeconds) * 1000) / 10
        : 0;
      const unconsidered = (mixPool[b.key] || 0) - (mixConsidered[b.key] || 0);
      mix[b.key] = {
        targetPct,
        stories: segsB.length,
        countPct: storySegs.length
          ? Math.round((segsB.length / storySegs.length) * 1000) / 10
          : 0,
        seconds: secs,
        airtimePct,
        poolCandidates: mixPool[b.key] || 0,
        shortfall: unconsidered <= 0 && airtimePct < targetPct - 2,
      };
    }
  }

  // The shared broadcast position (ONE GLOBAL BROADCAST, Nov 21,
  // 2026): this bucket's chunk of the timeline starts at
  // bucketStartMs; a listener tuning in now joins at
  // liveOffsetSeconds into the chunk, inside the on-air segment.
  // The player is a thin client over these three numbers.
  const bucketStartMs = bucket * BUCKET_MS;
  const liveOffsetSeconds = Math.max(0, (nowMs - bucketStartMs) / 1000);
  let onAir = null;
  {
    let acc = 0;
    for (let i = 0; i < out.length; i++) {
      const dur = out[i].estSeconds || 0;
      if (liveOffsetSeconds < acc + dur || i === out.length - 1) {
        onAir = {
          index: i,
          segmentId: out[i].id,
          kind: out[i].kind,
          offsetSeconds: Math.max(0, Math.round((liveOffsetSeconds - acc) * 10) / 10),
        };
        break;
      }
      acc += dur;
    }
  }
  const timeline = {
    epochMs: STATION_EPOCH_MS,
    bucketStartMs,
    liveOffsetSeconds: Math.round(liveOffsetSeconds * 10) / 10,
    onAir,
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    bucket,
    queueSeconds: adjustedElapsed,
    bufferSeconds: adjustedElapsed,
    topicGuardSkipped,
    entityBudgetSkipped,
    expiredStories,
    expiredPerformances,
    ageCappedStories,
    callerCount,
    neverAiredStories,
    recycledStories,
    poolNeverAired,
    poolRecycled,
    jukeboxTrackClass: JUKEBOX_TRACK_CLASS,
    playedExcludedStories,
    playedStoreSize: playedMap ? playedMap.size : 0,
    timeline,
    mix,
    segments: out,
  };
}
