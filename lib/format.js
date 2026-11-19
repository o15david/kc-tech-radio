// ============================================================================
// THE FORMAT CLOCK
//
// KC Tech Radio runs on a fixed hourly wheel, like a real radio station.
// Every hour has the same shape; only the headlines change. All copy is
// template-driven: there is NO language model anywhere in this pipeline,
// so an hour of programming costs exactly zero AI credits and the output
// for a given set of headlines is fully deterministic.
//
//   :00  TOP-OF-HOUR NEWS       general news, INSIDE-OUT: KC metro first,
//                               then MO/KS state, Midwest regional,
//                               national (briefest), world last
//   :08  KC LOCAL show          Kansas City tech & business (+ banter)
//   :20  AI NEWS show           artificial intelligence, TBPN-style pacing
//                               (+ banter)
//   :30  STATION ID + KC time/weather check
//   :33  TECH HEADLINES           (newsletter items are the secondary pool)
//   :37  KC MUSIC SCENE         tonight's shows, announcements, weekend
//                               picks, jazz picks (music feed; silent when
//                               the feed is empty)
//   :45  BUSINESS HEADLINES
//   :50  THE PRODUCER'S DESK    fixed-copy gonzo bit (lib/gonzo.js)
//   :53  KC LOCAL ENCORE        more local (falls back to AI/tech overflow)
//   :57  STATION ID + tease for top-of-hour news
//
// Coverage runs inside-out (David's model): for a KC metro listener, the
// news that matters most is the news they have the most control over and
// feel the most impact from, so the top-of-hour general block draws by
// ring: metro (local) first, state next, regional after that, national
// briefest, and world at the outermost ring. Selection weight follows
// the rings; within a ring, stories are still freshest-first and drawn
// without replacement under the same cycle rules as every other show.
//
// Two-host banter lives INSIDE the two talk shows (KC report, AI Report):
// one story per airing gets a reaction from the co-host (Aria) and a
// counter from the anchor (Christopher), both lines drawn from the
// hand-written pools in lib/gonzo.js by hash of the segment id. The story
// itself is read exactly as usual and counts once in the aired set.
//
// Headline selection is deterministic too, and it NEVER repeats a story
// inside a cycle (David's hard rule: "should never repeat stories. the
// news should be fresh."). Pools are ordered newest-first and drawn
// freshest-first, without replacement, across every block instance of
// every show. If nothing fresh remains anywhere in a block's draw order,
// the block runs short rather than recycling an aired story.
//
// The cycle is 8 hours, anchored at 00:00, 08:00, and 16:00 in
// America/Chicago. Within a cycle, no story airs twice, in any show.
// A story becomes eligible again only when the pool has fully cycled
// (the next cycle window begins) or when a genuinely new edition of the
// story arrives (a new link/GUID is a new item, eligible immediately).
// Why 8 hours: a cycle consumes at most ~185 story slots (23 per hour)
// against a live pool of ~1,000 stories across the enlarged inside-out
// roster, so blocks do not run dry mid-cycle; a longer cycle would
// exhaust the wire and leave the back half of it with empty blocks, and
// a shorter one would let stories resurface inside a single long
// listening session.
// In practice the pools churn all day: newly published stories enter at
// the front of their newest-first pool and are drawn first, so the
// station stays fresh; if the wires ever run truly dry, blocks run
// short rather than repeating anything.
//
// Stateless implementation: the set of stories already aired in the
// current cycle is a pure function of (pool snapshot, absolute block
// instance). buildPlaylist replays the schedule from the cycle anchor
// (the start of the current 8-hour Chicago window) up to the current
// block instance, applying the same draw rules, which reconstructs
// exactly the aired set a live broadcast would have produced. One
// honesty rule in the
// replay: an instance may only draw stories published by that instance's
// start, so a story published at 10:05 AM is never retroactively "aired"
// by a 3 AM replay instance; it enters rotation at the first block after
// it actually existed. Repeated /api/playlist calls over the same pool
// snapshot therefore return identical queues, and the queues advance as
// the clock advances.
//
// Spoken times are derived from each block instance's true scheduled
// start (that date at the block's start hour:minute in America/Chicago,
// zero seconds), never from "now plus whole hours": a block that starts
// at 10:00 says 10:00, even when the playlist was generated at 9:59.
// Every segment also carries startMs (its scheduled start epoch) and
// slotEndMs (the scheduled start of the next block instance), so the
// player can drop segments whose slot has fully passed instead of
// re-airing stale content after a refill.
//
// The station's attitude (TBPN pacing, NPR polish, Hunter S. Thompson at
// the producer's desk) lives entirely in lib/gonzo.js: fixed hand-written
// template pools for opens, transitions, station IDs, and sign-offs. News
// facts are never touched; the gonzo layer is framing only. Pool picks are
// hashed from the segment id, exactly like headline cursors, so an hour
// sounds identical on every request and every segment is cacheable.
// ============================================================================

import { itemsForCategory } from './ingest';
import {
  SHOW_OPENS,
  GENERAL_FRAMING,
  TRANSITIONS,
  STATION_IDS,
  PRODUCERS_DESK,
  SIGN_OFFS,
  MUSIC_LEADS,
  BANTER_REACTIONS,
  BANTER_COUNTERS,
} from './gonzo';
import { voiceForSegment, COHOST_VOICE } from './voices';
import { audioUrlFor } from './tts';

export const TIME_ZONE = 'America/Chicago';
// Speech rate assumption for duration estimates. The Edge neural voices at
// their default rate speak roughly 150-160 wpm, as does browser
// speechSynthesis at rate 1.0 (the fallback path).
export const WORDS_PER_MINUTE = 155;
// The playlist endpoint always returns at least this much audio ahead.
export const TARGET_BUFFER_SECONDS = 12 * 60;

export const FORMAT_CLOCK = [
  // Top of the hour: general news, inside-out. `rings` replaces the plain
  // category draw for this block: slots are dealt ring by ring (metro 2,
  // state 1, regional 1, national 1, world 1), and a dry ring's slot
  // falls outward through the remaining rings before touching the general
  // fallback order, so the block always leads as close to home as the
  // wire allows. National is deliberately the briefest ring.
  {
    startMinute: 0, key: 'general-news', kind: 'show', category: 'general',
    title: 'News at the Top of the Hour', stories: 6,
    rings: [
      { category: 'local', count: 2 },
      { category: 'state', count: 1 },
      { category: 'regional', count: 1 },
      { category: 'national', count: 1 },
      { category: 'global', count: 1 },
    ],
  },
  { startMinute: 8, key: 'kc-local', kind: 'show', category: 'local', title: 'Kansas City Tech & Business Report', stories: 4, banter: true },
  { startMinute: 20, key: 'ai-news', kind: 'show', category: 'ai', title: 'The AI Report', stories: 4, alsoFrom: ['newsletter'], banter: true },
  { startMinute: 30, key: 'station-id', kind: 'station-id', category: null, title: 'Station ID & Kansas City Weather', stories: 0 },
  { startMinute: 33, key: 'tech-headlines', kind: 'show', category: 'tech', title: 'Tech Headlines', stories: 4, alsoFrom: ['newsletter'] },
  { startMinute: 37, key: 'kc-music', kind: 'music', category: 'music', title: 'Kansas City Music Scene', stories: 0 },
  { startMinute: 45, key: 'business-headlines', kind: 'show', category: 'business', title: 'Business & Markets', stories: 3 },
  { startMinute: 50, key: 'producers-desk', kind: 'producers-desk', category: null, title: "The Producer's Desk", stories: 0 },
  { startMinute: 53, key: 'kc-encore', kind: 'show', category: 'local', title: 'Kansas City Encore', stories: 2 },
  { startMinute: 57, key: 'hour-tease', kind: 'station-id', category: null, title: 'Station ID', stories: 0 },
];

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

// Numeric wall-clock parts in America/Chicago, for schedule arithmetic.
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
 * (hour 24, day 32, ...) are normalized the way Date.UTC normalizes them,
 * so "today at hour 23 + 2, minute 8" lands at 1:08 AM tomorrow, Chicago
 * time. This is how a block instance gets its TRUE scheduled start: the
 * block's own hour and minute on the Chicago clock, zero seconds, instead
 * of the old "now plus whole hours" that dragged the current minutes
 * (e.g. :59) into every future block's spoken time.
 */
export function epochForChicagoWall(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes settle the offset around DST transitions.
  const first = guess - chicagoOffsetMs(new Date(guess));
  return guess - chicagoOffsetMs(new Date(first));
}

function spokenTime(date) {
  const p = chicagoParts(date);
  // On the hour, radio style drops the ":00": "10 AM", not "10:00 AM".
  // One rule everywhere a time is spoken, so blocks sound consistent.
  if (p.minute === '00') return `${p.hour} ${p.dayPeriod}`;
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

function spokenDate(date) {
  const p = chicagoParts(date);
  return `${p.weekday}, ${p.month} ${p.day}`;
}

export function estimateSeconds(script) {
  const words = script.split(/\s+/).filter(Boolean).length;
  return Math.max(5, Math.round((words / WORDS_PER_MINUTE) * 60));
}

// ---------------------------------------------------------------------------
// Script templates
// ---------------------------------------------------------------------------

/** Deterministic pool pick: hash of the segment id into the pool, so the
 *  same segment always gets the same line (cache-friendly, stable hours). */
function pickFromPool(pool, segmentId) {
  return pool[hashString(segmentId) % pool.length];
}

// Show opens come from the gonzo style pools (lib/gonzo.js). The
// top-of-hour general block keeps its NPR structure: a framing line, then
// the factual time and date, then the headlines.
function showIntro(blockKey, segmentId, date) {
  if (blockKey === 'general-news') {
    const framing = pickFromPool(GENERAL_FRAMING, segmentId);
    return `${framing} It is ${spokenTime(date)} Central Time, ${spokenDate(date)}. Here are the headlines.`;
  }
  return pickFromPool(SHOW_OPENS[blockKey], segmentId);
}

// Transitions between stories also come from lib/gonzo.js (TRANSITIONS),
// picked by hash of the segment id in storyScript below.

function cleanSummary(summary) {
  if (!summary) return '';
  let s = summary
    .replace(/\s*(Continue reading|Read more|Read More)[\s\S]*$/, '')
    .replace(/\[…\]|\[\.\.\.\]/g, '')
    .trim();
  const MAX = 340;
  if (s.length <= MAX) return s;
  // Truncate at the last full sentence inside the limit if we can.
  const cut = s.slice(0, MAX);
  const lastSentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastSentence > MAX * 0.5) return cut.slice(0, lastSentence + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace).replace(/[\s,;:]+$/, '')}.`;
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
  parts.push(`From ${item.source}.`);
  return parts.join(' ');
}

function stationIdScript(blockKey, segmentId, date, weather) {
  const idLine = pickFromPool(STATION_IDS, segmentId);
  const base = `${idLine} It is ${spokenTime(date)} in Kansas City.`;
  const weatherLine = weather
    ? ` Currently ${weather.tempF} degrees with ${weather.condition}, and winds around ${weather.windMph} miles per hour.`
    : '';
  const tease =
    blockKey === 'hour-tease' ? ` ${pickFromPool(SIGN_OFFS, segmentId)}` : '';
  return base + weatherLine + tease;
}

function producersDeskScript(segmentId) {
  return pickFromPool(PRODUCERS_DESK, segmentId);
}

const FILLER_SCRIPT =
  'You are listening to KC Tech Radio. Our news wires are momentarily quiet, ' +
  'so here is a quick station note: KC Tech Radio brings you Kansas City tech ' +
  'and business news, the latest in artificial intelligence, and world news ' +
  'at the top of every hour, twenty four hours a day. Stay with us; the next ' +
  'headlines are coming up shortly.';

// Category fallback order when a block's own pool has no fresh story left:
// the block draws a fresh (never-aired-this-cycle) story from the next
// pool instead of recycling one of its own. The order itself runs
// inside-out for the news rings (metro, state, regional, then the subject
// pools, then national and world), so even fallbacks favor the close and
// the relevant over the far away. Newsletter items ride last in the
// general fallback and second in the AI and Tech blocks (see alsoFrom on
// the format clock): they are an additional wire, not a block of their
// own. Music is NOT here: music items are listings, not stories, and only
// the music block reads them.
const FALLBACK_ORDER = [
  'local', 'state', 'regional', 'ai', 'tech', 'business', 'national', 'global', 'newsletter',
];

// ---------------------------------------------------------------------------
// Playlist builder
// ---------------------------------------------------------------------------

function blockIndexForMinute(minute) {
  let idx = 0;
  FORMAT_CLOCK.forEach((block, i) => {
    if (minute >= block.startMinute) idx = i;
  });
  return idx;
}

/**
 * Build the rolling playlist starting "now".
 *
 * @param pool    news pool from ingest.getNewsPool()
 * @param weather weather object or null
 * @param nowMs   epoch ms to build from (injectable for tests)
 * @returns { generatedAt, segments, bufferSeconds }
 *   Each segment: { id, kind, blockKey, category, title, headline, source,
 *                   script, estSeconds, startMs, slotEndMs, voice, audioUrl }
 *   `startMs` is the segment's scheduled start epoch (its block instance's
 *   true Chicago start plus the estimated durations ahead of it in the
 *   block); `slotEndMs` is the next block instance's scheduled start.
 *   `voice`/`audioUrl` point at the pre-rendered Edge TTS MP3 for the
 *   segment (see lib/voices.js and lib/tts.js); the player falls back to
 *   browser speechSynthesis only if that MP3 fails.
 */
export function buildPlaylist(pool, weather, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const parts = chicagoParts(now);
  const minute = parseInt(parts.minute, 10);
  const startBlockIdx = blockIndexForMinute(minute);
  const nowWall = chicagoWallParts(now);
  const BLOCKS = FORMAT_CLOCK.length;

  const segments = [];
  let bufferSeconds = 0;

  // Attach the segment's voice and its pre-rendered audio URL. The voice is
  // decided by block (lib/voices.js); the URL derives entirely from the
  // segment's voice + script, so it is as deterministic as the segment id.
  function withAudio(seg) {
    const voice = voiceForSegment(seg);
    return { ...seg, voice, audioUrl: audioUrlFor(voice, seg.script, seg.id) };
  }

  const pools = {};
  for (const cat of [...FALLBACK_ORDER, 'music']) pools[cat] = itemsForCategory(pool, cat);

  // --- No-repeat rotation (David's hard rule) ------------------------------
  // airedItemIds holds every story drawn since the cycle anchor, across
  // ALL shows: a story airs once, then it is out of rotation until its
  // pool fully cycles. The set is reconstructed by replay (below), never
  // stored, which keeps the serverless design stateless and the output a
  // pure function of the pool snapshot and the clock.
  const airedItemIds = new Set();

  function drawItem(order, cutoffMs = Infinity) {
    for (const cat of order) {
      const list = pools[cat];
      if (!list || !list.length) continue;
      // Freshest first: pools are newest-first, so the first unaired item
      // is the freshest story that has not aired this cycle. There is NO
      // mid-cycle reset: once a story has aired it stays out of rotation
      // until the next cycle window (00:00 / 08:00 / 16:00 Chicago time,
      // when the pool has fully cycled) or until a new edition of it
      // arrives under a new link/GUID, which is a new item and lands at
      // the front of the pool, eligible immediately.
      // The replay passes a cutoff: a story can only be "already aired"
      // at an instance if it had actually been published by then, so a
      // story published at 10:05 is never retroactively consumed by the
      // 3 AM replay. Undated items are treated as always published.
      const item = list.find(
        (candidate) =>
          !airedItemIds.has(candidate.id) &&
          (candidate.publishedAt == null || candidate.publishedAt <= cutoffMs)
      );
      if (item) {
        airedItemIds.add(item.id);
        return item;
      }
    }
    return null;
  }

  // Draw order for a show block: its own category, any alsoFrom pools
  // (e.g. newsletters in the AI/Tech blocks), then the general fallback.
  // In alsoFrom blocks, odd-numbered story slots lead with the alsoFrom
  // pools instead, so the secondary wire (newsletters) is guaranteed
  // airtime rather than only surfacing when the primary pool runs dry.
  // drawItem still walks the full order, so an empty secondary pool
  // silently falls back to the primary category. Fully deterministic:
  // the slot pattern depends only on the block definition.
  function drawStories(block, cutoffMs = Infinity) {
    // Inside-out blocks (the top-of-hour general news) deal their slots
    // ring by ring instead of from one category: metro slots first, then
    // state, regional, national, world. Each slot draws freshest-first
    // from its own ring; if that ring has no fresh story left, the slot
    // falls outward through the rings after it, then through the general
    // fallback order, so the block fills without ever repeating a story
    // and still leads as close to home as the wire allows. The replay
    // calls this same function, so the aired set stays consistent.
    if (block.rings) {
      const ringCats = block.rings.map((r) => r.category);
      const slots = block.rings.flatMap((ring) =>
        Array.from({ length: ring.count }, () => ring.category)
      );
      const items = [];
      for (let s = 0; s < slots.length; s++) {
        const outward = ringCats.slice(ringCats.indexOf(slots[s]));
        const order = [...new Set([...outward, ...FALLBACK_ORDER])];
        const item = drawItem(order, cutoffMs);
        if (!item) break; // nothing fresh anywhere: the block runs short
        items.push(item);
      }
      return items;
    }
    const drawOrder = [
      ...new Set([block.category, ...(block.alsoFrom || []), ...FALLBACK_ORDER]),
    ];
    const altDrawOrder = block.alsoFrom?.length
      ? [...new Set([...block.alsoFrom, block.category, ...FALLBACK_ORDER])]
      : drawOrder;
    const items = [];
    for (let s = 0; s < block.stories; s++) {
      const item = drawItem(s % 2 === 1 ? altDrawOrder : drawOrder, cutoffMs);
      if (!item) break; // nothing fresh anywhere: the block runs short
      items.push(item);
    }
    return items;
  }

  // Absolute hour counter (UTC-based) gives each airing of a block a unique,
  // monotonically increasing instance number -> stable ids per airing.
  const absHour = Math.floor(nowMs / 3600000);

  // --- Cycle replay ---------------------------------------------------------
  // Reconstruct the aired set by replaying this cycle's schedule from the
  // cycle anchor (start of the current 8-hour America/Chicago window:
  // 00:00, 08:00, or 16:00) up to, but not including, the current block
  // instance, applying the exact draw rules above. Only story draws
  // matter; station IDs, the producer's desk, and music listings are
  // fixed copy / listings, not stories, and are exempt from the no-repeat
  // rule. Cost is bounded: at most ~9 hours of block instances (a
  // fall-back day stretches a window by one hour), each drawing a handful
  // of items from small in-memory pools.
  const anchorHour = Math.floor(nowWall.hour / 8) * 8;
  const anchorMs = epochForChicagoWall(nowWall.year, nowWall.month, nowWall.day, anchorHour, 0);
  const anchorAbsHour = Math.round(anchorMs / 3600000);
  const anchorInstance = anchorAbsHour * BLOCKS;
  const currentInstance = absHour * BLOCKS + startBlockIdx;
  for (let inst = anchorInstance; inst < currentInstance; inst++) {
    const replayBlock = FORMAT_CLOCK[inst % BLOCKS];
    if (replayBlock.kind !== 'show') continue;
    // The instance's own scheduled start doubles as the publication
    // cutoff for its draws (see drawItem).
    const instStartMs = epochForChicagoWall(
      nowWall.year, nowWall.month, nowWall.day,
      anchorHour + (Math.floor(inst / BLOCKS) - anchorAbsHour), replayBlock.startMinute
    );
    drawStories(replayBlock, instStartMs);
  }

  // True scheduled start of a block instance, on the Chicago wall clock.
  function blockStartMsFor(hourOffset, block) {
    return epochForChicagoWall(
      nowWall.year, nowWall.month, nowWall.day,
      nowWall.hour + hourOffset, block.startMinute
    );
  }

  // Segment emission with schedule bookkeeping: each segment is stamped
  // with its scheduled start (block start + estimated durations ahead of
  // it in the block) and tagged with its walk step so slotEndMs can be
  // filled in once every step's start is known.
  const stepStarts = [];
  let curStep = -1;
  let curElapsed = 0;
  function emit(seg) {
    seg.startMs = stepStarts[curStep] + curElapsed * 1000;
    seg._step = curStep;
    curElapsed += seg.estSeconds;
    segments.push(withAudio(seg));
    bufferSeconds += seg.estSeconds;
  }

  // Walk the wheel forward from the current block until we have filled the
  // target buffer. The guard bound keeps a pathological pool from looping.
  for (let step = 0; step < FORMAT_CLOCK.length * 4 && bufferSeconds < TARGET_BUFFER_SECONDS; step++) {
    const blockIdx = (startBlockIdx + step) % FORMAT_CLOCK.length;
    const hourOffset = Math.floor((startBlockIdx + step) / FORMAT_CLOCK.length);
    const block = FORMAT_CLOCK[blockIdx];
    const instance = (absHour + hourOffset) * FORMAT_CLOCK.length + blockIdx;
    // Every spoken time for this block derives from its TRUE scheduled
    // start on the Chicago wall clock (this date, the block's start
    // hour:minute, zero seconds). The one exception is the station ID /
    // tease of the block on air right now (step 0), which speaks the
    // actual current time.
    const stepStartMs = blockStartMsFor(hourOffset, block);
    const blockDate = new Date(stepStartMs);
    curStep = step;
    curElapsed = 0;
    stepStarts[step] = stepStartMs;

    if (block.kind === 'station-id') {
      const id = `seg-${instance}-${block.key}`;
      const script = stationIdScript(block.key, id, step === 0 ? now : blockDate, weather);
      emit({
        id,
        kind: 'station-id',
        blockKey: block.key,
        category: 'station',
        title: block.title,
        headline: 'KC Tech Radio',
        source: 'KC Tech Radio',
        script,
        estSeconds: estimateSeconds(script),
      });
      continue;
    }

    if (block.kind === 'producers-desk') {
      // Fixed-copy gonzo bit from lib/gonzo.js; no news content, ever.
      const id = `seg-${instance}-${block.key}`;
      const script = producersDeskScript(id);
      emit({
        id,
        kind: 'producers-desk',
        blockKey: block.key,
        category: 'station',
        title: block.title,
        headline: block.title,
        source: 'KC Tech Radio',
        script,
        estSeconds: estimateSeconds(script),
      });
      continue;
    }

    if (block.kind === 'music') {
      // Kansas City Music Scene. Listings come from the music feed
      // (venue-verified only; see README "Music feed"). An empty feed
      // means the block is silent this hour: no filler, no fake shows.
      const listings = pools.music;
      if (listings.length) {
        const introId = `seg-${instance}-${block.key}-intro`;
        const intro = showIntro(block.key, introId, blockDate);
        emit({
          id: introId,
          kind: 'intro',
          blockKey: block.key,
          category: 'music',
          title: block.title,
          headline: block.title,
          source: 'KC Tech Radio',
          script: intro,
          estSeconds: estimateSeconds(intro),
        });

        // Fixed rundown order: tonight, just announced, weekend, jazz.
        // Feed order is preserved inside each kind; cap keeps the block
        // near five minutes.
        const KIND_ORDER = ['tonight', 'announced', 'weekend', 'jazz'];
        const rundown = KIND_ORDER.flatMap((kind) =>
          listings.filter((it) => it.musicKind === kind)
        ).slice(0, 6);

        rundown.forEach((item, i) => {
          const id = `seg-${instance}-${block.key}-${i}-${hashString(item.id).toString(36)}`;
          const lead = MUSIC_LEADS[item.musicKind][
            hashString(id) % MUSIC_LEADS[item.musicKind].length
          ];
          const transition =
            i === 0 ? '' : TRANSITIONS[hashString(id) % TRANSITIONS.length];
          // Facts stay straight: artist, venue, and date/time exactly as
          // the (venue-verified) feed carries them.
          const script =
            `${transition ? `${transition} ` : ''}${lead} ${item.artist} at ${item.venue}, ${item.when}.`;
          const seg = {
            id,
            kind: 'music',
            blockKey: block.key,
            category: 'music',
            title: block.title,
            headline: item.title,
            source: item.venue,
            link: item.url || item.link,
            artist: item.artist,
            venue: item.venue,
            when: item.when,
            musicKind: item.musicKind,
            script,
            estSeconds: estimateSeconds(script),
          };
          emit(seg);
        });
      }
      continue;
    }

    // Show block: intro, then the stories drawn for this instance by the
    // no-repeat rotation (the same drawStories the cycle replay used, so
    // the aired set stays consistent across the whole day).
    const drawnItems = drawStories(block);

    const introId = `seg-${instance}-${block.key}-intro`;
    const intro = showIntro(block.key, introId, blockDate);
    emit({
      id: introId,
      kind: 'intro',
      blockKey: block.key,
      category: block.category,
      title: block.title,
      headline: block.title,
      source: 'KC Tech Radio',
      script: intro,
      estSeconds: estimateSeconds(intro),
    });

    // Two-host banter: in the talk shows (block.banter), one story per
    // airing gets a short exchange after it: the co-host reacts, the
    // anchor counters. Which story is picked by hash of the block
    // instance, so the exchange lands on a different story each hour.
    // The story itself was drawn (and counted in the aired set) exactly
    // once by the rotation above; the banter lines are framing copy and
    // draw nothing.
    const banterSlot =
      block.banter && drawnItems.length
        ? hashString(`banter-${instance}`) % drawnItems.length
        : -1;

    drawnItems.forEach((item, s) => {
      const id = `seg-${instance}-${block.key}-${s}-${hashString(item.id).toString(36)}`;
      const script = storyScript(item, id, s === 0);
      emit({
        id,
        kind: 'story',
        blockKey: block.key,
        category: item.category,
        title: block.title,
        headline: item.title,
        source: item.source,
        link: item.link,
        script,
        estSeconds: estimateSeconds(script),
      });

      if (s === banterSlot) {
        const itemKey = hashString(item.id).toString(36);
        const reactionId = `seg-${instance}-${block.key}-banter-reaction-${itemKey}`;
        const reaction = pickFromPool(BANTER_REACTIONS, reactionId);
        emit({
          id: reactionId,
          kind: 'banter',
          role: 'reaction',
          blockKey: block.key,
          category: item.category,
          title: block.title,
          headline: item.title,
          source: 'KC Tech Radio',
          link: item.link,
          script: reaction,
          estSeconds: estimateSeconds(reaction),
          voice: COHOST_VOICE,
        });
        const counterId = `seg-${instance}-${block.key}-banter-counter-${itemKey}`;
        const counter = pickFromPool(BANTER_COUNTERS, counterId);
        emit({
          id: counterId,
          kind: 'banter',
          role: 'counter',
          blockKey: block.key,
          category: item.category,
          title: block.title,
          headline: item.title,
          source: 'KC Tech Radio',
          link: item.link,
          script: counter,
          estSeconds: estimateSeconds(counter),
        });
      }
    });
  }

  // Total wire failure (or first cold start): never return an empty queue.
  // The filler is fixed station copy, not a story, so it is exempt from
  // the no-repeat rule; it exists only so the stream never goes silent
  // when every wire is down.
  if (!segments.some((s) => s.kind === 'story')) {
    const filler = withAudio({
      id: `seg-filler-${absHour}`,
      kind: 'filler',
      blockKey: 'filler',
      category: 'station',
      title: 'Station Note',
      headline: 'KC Tech Radio',
      source: 'KC Tech Radio',
      script: FILLER_SCRIPT,
      estSeconds: estimateSeconds(FILLER_SCRIPT),
    });
    // Deterministic within the hour (a nowMs stamp here would make two
    // consecutive playlist calls differ, breaking queue determinism).
    filler.startMs = epochForChicagoWall(nowWall.year, nowWall.month, nowWall.day, nowWall.hour, 0);
    filler.slotEndMs = filler.startMs + 3600000;
    segments.push(filler);
    bufferSeconds += filler.estSeconds;
  }

  // Fill in slotEndMs now that every walked step's start is known: a
  // segment's slot ends when the next block instance starts. The last
  // walked step's slot ends at the following block instance's start,
  // which is computed but not walked.
  const walkedSteps = stepStarts.length;
  const nextBlockIdx = (startBlockIdx + walkedSteps) % BLOCKS;
  const nextHourOffset = Math.floor((startBlockIdx + walkedSteps) / BLOCKS);
  const nextStartMs = blockStartMsFor(nextHourOffset, FORMAT_CLOCK[nextBlockIdx]);
  for (const seg of segments) {
    if (seg._step !== undefined) {
      seg.slotEndMs = stepStarts[seg._step + 1] ?? nextStartMs;
      delete seg._step;
    }
  }

  return { generatedAt: new Date(nowMs).toISOString(), segments, bufferSeconds };
}
