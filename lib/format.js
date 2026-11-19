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
//   - Two-host banter: after every 5th story, the co-host (Aria)
//     reacts and the anchor (Christopher) counters, lines drawn from
//     the hand-written pools in lib/gonzo.js, rotating without
//     replacement (a pool reshuffles only after every line has aired).
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
//     stories do not exist in this design).
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
// hand-written template pools for opens, transitions, station IDs, and
// banter. News facts are never touched; the gonzo layer is framing
// only. There is NO language model anywhere in this pipeline: an hour
// of programming costs exactly zero AI credits.
// ============================================================================

import { itemsForCategory } from './ingest';
import { trimToSentenceBoundary, lastSentenceEnd, ensureTerminalPunctuation } from './rss';
import {
  SHOW_OPENS,
  TRANSITIONS,
  STATION_IDS,
  PRODUCERS_DESK,
  MUSIC_LEADS,
  BANTER_REACTIONS,
  BANTER_COUNTERS,
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
const BANTER_EVERY_STORIES = 5; // one exchange after every 5th story
const STATION_ID_EVERY_SECONDS = 20 * 60;
const WEATHER_EVERY_SECONDS = 35 * 60;
const DESK_EVERY_SECONDS = 50 * 60;
const MUSIC_AT_SECONDS = 45 * 60; // music rundown lands ~45 min into the queue

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

// Transitions between stories come from lib/gonzo.js (TRANSITIONS),
// picked by hash of the segment id in storyScript below.

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

function storyScript(item, segmentId, isFirst) {
  const transition = isFirst
    ? ''
    : TRANSITIONS[hashString(segmentId) % TRANSITIONS.length];
  const summary = cleanSummary(item.summary);
  const parts = [];
  if (transition) parts.push(transition);
  parts.push(`${item.title}.`);
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

// Total wire failure (or an empty first pool): the queue falls back to
// fixed station copy. It is not a story, so it is exempt from the
// no-repeat rule.
const STATION_NOTE_SCRIPT =
  'You are listening to KC Tech Radio. Our news wires are momentarily quiet, ' +
  'so here is a quick station note: KC Tech Radio brings you Kansas City tech ' +
  'and business news, the latest in artificial intelligence, and news from ' +
  'around the world, around the clock. Stay with us; the headlines resume shortly.';

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

// Banter line rotation for one queue: lines are drawn WITHOUT
// replacement from each pool, starting at an offset hashed from the
// queue bucket. When a pool is exhausted it reshuffles from a shifted
// offset (a long queue trades more exchanges than either pool holds;
// a line still never repeats until the whole pool has aired).
function makeBanterPicker(bucket) {
  const state = {
    reaction: { used: new Set(), round: 0 },
    counter: { used: new Set(), round: 0 },
  };
  return (poolName, pool) => {
    const st = state[poolName];
    if (st.used.size >= pool.length) {
      st.used.clear();
      st.round += 1;
    }
    const start =
      (hashString(`banter-${bucket}-${poolName}`) + st.round * 7) % pool.length;
    for (let j = 0; j < pool.length; j++) {
      const idx = (start + j) % pool.length;
      if (!st.used.has(idx)) {
        st.used.add(idx);
        return pool[idx];
      }
    }
    return pool[start];
  };
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
 * @returns { generatedAt, bucket, queueSeconds, bufferSeconds, segments }
 *   Each segment: { id, kind, blockKey, category, title, headline, source,
 *                   script, estSeconds, voice, audioUrl } (stories and
 *                   music listings also carry `link`; banter carries
 *                   `role`). There are deliberately no startMs/slotEndMs
 *                   fields: nothing is scheduled. `queueSeconds` is the
 *                   total estimated audio in the queue; `bufferSeconds`
 *                   is the same number, kept for the health route.
 */
export function buildPlaylist(pool, weather, nowMs = Date.now()) {
  const pools = {};
  for (const cat of [...STORY_CATEGORIES, 'music']) {
    pools[cat] = itemsForCategory(pool, cat);
  }

  const bucket = Math.floor(nowMs / BUCKET_MS);
  const dealt = dealStories(pools);
  const offset = dealt.length ? hashString(`kctr-queue-${bucket}`) % dealt.length : 0;
  const rotated = [...dealt.slice(offset), ...dealt.slice(0, offset)];

  const pickBanter = makeBanterPicker(bucket);
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
      const transition =
        i === 0 ? '' : TRANSITIONS[hashString(id) % TRANSITIONS.length];
      // Facts stay straight: artist, venue, and date/time exactly as
      // the (venue-verified) feed carries them.
      const script =
        `${transition ? `${transition} ` : ''}${lead} ${item.artist} at ${item.venue}, ${item.when}.`;
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

  for (const item of rotated) {
    if (elapsed >= TARGET_QUEUE_SECONDS) break;
    if (segments.length >= MAX_QUEUE_SEGMENTS) break;

    const section = SECTION_OF_CATEGORY[item.category] || 'news';
    const id = nextId('story', `-${hashString(item.id).toString(36)}`);
    const script = storyScript(item, id, storyCount === 0);
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

    // Two-host banter: one exchange after every 5th story. The story
    // itself was dealt (and counted) exactly once; banter lines are
    // framing copy and draw nothing. Banter is CONTENT, not station
    // material: it never counts toward the station-material share.
    if (storyCount % BANTER_EVERY_STORIES === 0) {
      const itemKey = hashString(item.id).toString(36);
      const reactionId = nextId('banter', `-reaction-${itemKey}`);
      const reaction = pickBanter('reaction', BANTER_REACTIONS);
      push({
        id: reactionId,
        kind: 'banter',
        role: 'reaction',
        blockKey: section,
        category: item.category,
        title: SECTION_TITLES[section],
        headline: item.title,
        source: 'KC Tech Radio',
        link: item.link,
        script: reaction,
        estSeconds: estimateSeconds(reaction),
        voice: COHOST_VOICE,
      });
      const counterId = nextId('banter', `-counter-${itemKey}`);
      const counter = pickBanter('counter', BANTER_COUNTERS);
      push({
        id: counterId,
        kind: 'banter',
        role: 'counter',
        blockKey: section,
        category: item.category,
        title: SECTION_TITLES[section],
        headline: item.title,
        source: 'KC Tech Radio',
        link: item.link,
        script: counter,
        estSeconds: estimateSeconds(counter),
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
    segments: out,
  };
}
