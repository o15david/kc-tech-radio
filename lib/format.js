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
// THE CONTINUOUS CHAIN (no dead air). The hour is laid out as ONE
// continuous chain of segments, end to end, inside three spans pinned by
// ANCHORS (David's mechanism): the segments that speak a time, the
// top-of-hour intro (:00), the station ID (:30), and the hour tease
// (:57), start at their true wall-clock minute, exactly, every hour.
// Anchors are never early, never late, and never floating in a hole.
// The content between two anchors FLEXES to meet the next one:
//   - each show block draws stories until it reaches its target length
//     (targetSeconds on the format clock; the old fixed story counts are
//     now minimums), so blocks run minutes long, not seconds;
//   - if a span still runs short of its anchor, the span first draws
//     MORE STORIES from the widest fallback pools (span-fill "More
//     Headlines", under the same no-repeat rules) until the shortfall
//     is under a minute; only that last shortfall is filled with short
//     deterministic station material (station IDs, weather checks,
//     producer's desk bits, station promos from lib/gonzo.js), under
//     strict run caps: at most 5 filler segments / 60 seconds in a
//     row, each filler type at most once per chunk and never within
//     3 minutes of its last use. Filler is seasoning, never the meal
//     (David's rule, after a live screenshot showed ~100 seconds of
//     consecutive station bits crowding out stories);
//   - if a span would overrun its anchor, trailing story units are
//     trimmed (and returned to the pool: a trimmed story never aired,
//     so it does not consume its no-repeat slot) until the anchor lands
//     on its minute.
// The next hour starts on the hour regardless: each span restarts its
// cursor at its anchor's pinned minute, so estimate error can never
// accumulate across an anchor. Because every segment's window is the
// previous segment's end, the schedule has no holes by construction,
// and any segment that speaks a time speaks its own true start:
// correct times by construction, not by patching.
//
// Coverage runs inside-out (David's model): for a KC metro listener, the
// news that matters most is the news they have the most control over and
// feel the most impact from, so the top-of-hour general block draws by
// ring: metro (local) first, state next, regional after that, national
// briefest, and world at the outermost ring. Selection weight follows
// the rings; within a ring, stories are still freshest-first and drawn
// without replacement under the same cycle rules as every other show.
//
// Two-host banter runs through EVERY story block: the talk shows (KC
// report, AI Report) trade an exchange after every 4th story, the
// other story blocks after every 8th, roughly 8-12 exchanges an hour.
// The co-host (Aria) reacts and the anchor (Christopher) counters,
// lines drawn from the hand-written pools in lib/gonzo.js in a
// per-hour rotation without replacement. The story itself is read
// exactly as usual and counts once in the aired set.
//
// Headline selection is deterministic too, and it NEVER repeats a story
// inside a cycle (David's hard rule: "should never repeat stories. the
// news should be fresh."). Pools are ordered newest-first and drawn
// freshest-first, without replacement, across every block instance of
// every show. If a block's fresh pool runs dry mid-span, the span fills
// the shortfall with station material rather than recycling an aired
// story (see the chain rules above).
//
// The cycle is 8 hours, anchored at 00:00, 08:00, and 16:00 in
// America/Chicago. Within a cycle, no story airs twice, in any show.
// A story becomes eligible again only when the pool has fully cycled
// (the next cycle window begins) or when a genuinely new edition of the
// story arrives (a new link/GUID is a new item, eligible immediately).
// Why 8 hours: the enlarged inside-out roster carries ~1,000 stories
// (about 5-6 hours of story audio), and a cycle's draws, sized by the
// blocks' target lengths, consume most of that depth exactly once; a
// much longer cycle would exhaust the wire and leave its back half
// with nothing but station material, and a shorter one would let
// stories resurface inside a single long listening session.
// In practice the pools churn all day: newly published stories enter at
// the front of their newest-first pool and are drawn first, so the
// station stays fresh; if the wires ever run truly dry, spans fill
// with station material rather than repeating anything.
//
// Stateless implementation: the set of stories already aired in the
// current cycle is a pure function of (pool snapshot, absolute block
// instance). buildPlaylist replays the schedule from the cycle anchor
// (the start of the current 8-hour Chicago window) up to the current
// hour, applying the same draw rules, which reconstructs exactly the
// aired set a live broadcast would have produced. Replay and emission
// are the SAME code path (buildHour) with the SAME honesty rule: an
// instance may only draw stories published by that instance's own
// scheduled start, in replay and in the forward walk alike. (An earlier
// version let the forward walk draw the current instance with no
// publication cutoff while the replay used the instance start as the
// cutoff; a story published mid-block could then be emitted live yet
// never counted as aired by later replays, and air again. That
// asymmetry is gone: emission and replay cannot diverge.) A story
// published at 10:05 AM is therefore never retroactively "aired" by a
// 3 AM replay instance, and never drawn into the 10:00 instance that
// is already on air; it enters rotation at the first block whose start
// follows its publication. Repeated /api/playlist calls over the same
// pool snapshot therefore return identical queues, and the queues
// advance as the clock advances.
//
// Spoken times are derived from each segment's own chained start (its
// true position in the hour, on the America/Chicago clock), never from
// "now plus whole hours": an anchor at :30 says its :30 time, a filler
// station ID at :47 says :47, and the top-of-hour intro says the hour
// it starts. Every segment also carries startMs (its chained scheduled
// start epoch) and slotEndMs (the NEXT segment's startMs: the chain
// tiles, so a segment's slot ends exactly where its successor begins),
// so the player can drop segments whose slot has fully passed instead
// of re-airing stale content after a refill.
//
// The station's attitude (TBPN pacing, NPR polish, Hunter S. Thompson at
// the producer's desk) lives entirely in lib/gonzo.js: fixed hand-written
// template pools for opens, transitions, station IDs, promos, and
// sign-offs. News facts are never touched; the gonzo layer is framing
// only. Pool picks are hashed from the segment id, exactly like headline
// cursors, so an hour sounds identical on every request and every
// segment is cacheable.
// ============================================================================

import { itemsForCategory } from './ingest';
import { trimToSentenceBoundary, lastSentenceEnd } from './rss';
import {
  SHOW_OPENS,
  GENERAL_FRAMING,
  TRANSITIONS,
  STATION_IDS,
  STATION_PROMOS,
  PRODUCERS_DESK,
  SIGN_OFFS,
  MUSIC_LEADS,
  BANTER_REACTIONS,
  BANTER_COUNTERS,
} from './gonzo';
import { voiceForSegment, COHOST_VOICE } from './voices';
import { audioUrlFor } from './tts';

export const TIME_ZONE = 'America/Chicago';
// Speech rate assumption for duration estimates, CALIBRATED against
// rendered MP3s (Nov 19): a 38-segment sample of real segments (24
// stories, 13 filler, 1 desk) compared estSeconds against the actual
// MP3 durations from lib/tts.js. At the old 155 wpm the renders ran
// systematically LONG: mean real/estimate ratio 1.119 overall and
// 1.122 for stories, median story overrun +2.0s, half of all stories
// overrunning by more than 2s and 8% by more than 5s. Nearly every
// story therefore outlived its estimated window, which is what let
// the old player cut stories at their slot ends. 155 / 1.119 puts the
// true rate at ~138 wpm; 136 centers the residual error and biases
// estimates a touch long, because an underrun is harmless (the chain
// shifts earlier) while an overrun pushes against the next anchor.
export const WORDS_PER_MINUTE = 136;
// The playlist endpoint always returns at least this much WALL-CLOCK
// coverage ahead of now (the chain has no holes, so coverage and audio
// duration are the same thing now).
export const TARGET_BUFFER_SECONDS = 12 * 60;

export const FORMAT_CLOCK = [
  // Top of the hour: general news, inside-out. `rings` replaces the plain
  // category draw for this block: slots are dealt ring by ring (metro 2,
  // state 1, regional 1, national 1, world 1) and the dealing pattern
  // repeats until the block reaches its target length; a dry ring's slot
  // falls outward through the remaining rings before touching the general
  // fallback order, so the block always leads as close to home as the
  // wire allows. National is deliberately the briefest ring.
  // `anchor: true` marks the blocks whose first segment pins a span.
  // `span` groups blocks between two anchors; `targetSeconds` is the
  // length a show block draws stories to reach (its `stories` count is
  // now a minimum, not a cap).
  {
    startMinute: 0, key: 'general-news', kind: 'show', span: 0, anchor: true,
    category: 'general', title: 'News at the Top of the Hour', stories: 6, targetSeconds: 450,
    rings: [
      { category: 'local', count: 2 },
      { category: 'state', count: 1 },
      { category: 'regional', count: 1 },
      { category: 'national', count: 1 },
      { category: 'global', count: 1 },
    ],
  },
  { startMinute: 8, key: 'kc-local', kind: 'show', span: 0, category: 'local', title: 'Kansas City Tech & Business Report', stories: 4, targetSeconds: 540, banter: true },
  { startMinute: 20, key: 'ai-news', kind: 'show', span: 0, category: 'ai', title: 'The AI Report', stories: 4, targetSeconds: 470, alsoFrom: ['newsletter'], banter: true },
  { startMinute: 30, key: 'station-id', kind: 'station-id', span: 1, anchor: true, category: null, title: 'Station ID & Kansas City Weather', stories: 0 },
  { startMinute: 33, key: 'tech-headlines', kind: 'show', span: 1, category: 'tech', title: 'Tech Headlines', stories: 4, targetSeconds: 320, alsoFrom: ['newsletter'] },
  { startMinute: 37, key: 'kc-music', kind: 'music', span: 1, category: 'music', title: 'Kansas City Music Scene', stories: 0 },
  { startMinute: 45, key: 'business-headlines', kind: 'show', span: 1, category: 'business', title: 'Business & Markets', stories: 3, targetSeconds: 420 },
  { startMinute: 50, key: 'producers-desk', kind: 'producers-desk', span: 1, category: null, title: "The Producer's Desk", stories: 0 },
  { startMinute: 53, key: 'kc-encore', kind: 'show', span: 1, category: 'local', title: 'Kansas City Encore', stories: 2, targetSeconds: 320 },
  { startMinute: 57, key: 'hour-tease', kind: 'station-id', span: 2, anchor: true, category: null, title: 'Station ID', stories: 0 },
];

const BLOCKS = FORMAT_CLOCK.length;

// Spans: the runs of blocks between anchors. A span starts at its anchor
// block's start minute and ends where the next span begins (or on the
// hour). Span 0: :00-:30. Span 1: :30-:57. Span 2: :57-:00.
const SPANS = [];
for (const block of FORMAT_CLOCK) {
  const span = SPANS[block.span] || (SPANS[block.span] = { index: block.span, blocks: [] });
  span.blocks.push(block);
}
for (const span of SPANS) {
  span.startMinute = span.blocks[0].startMinute;
  const next = SPANS[span.index + 1];
  span.endMinute = next ? next.blocks[0].startMinute : 60;
}

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

const SUMMARY_MAX_CHARS = 480;

function cleanSummary(summary) {
  if (!summary) return '';
  let s = summary
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
// Story draws (the no-repeat rotation)
// ---------------------------------------------------------------------------

// Draw the freshest story in `order` that has not aired this cycle and
// was published by cutoffMs, and mark it aired. The cutoff is the honesty
// rule, applied identically by replay and emission: a story can only be
// drawn by an instance if it had actually been published by that
// instance's scheduled start. Undated items are treated as always
// published.
function drawItem(ctx, order, cutoffMs) {
  for (const cat of order) {
    const list = ctx.pools[cat];
    if (!list || !list.length) continue;
    const item = list.find(
      (candidate) =>
        !ctx.airedItemIds.has(candidate.id) &&
        (candidate.publishedAt == null || candidate.publishedAt <= cutoffMs)
    );
    if (item) {
      ctx.airedItemIds.add(item.id);
      return item;
    }
  }
  return null;
}

// Draw one story for slot `slot` of a show block, honoring the block's
// draw pattern:
// - Ring blocks (the top-of-hour general news) deal their slots by the
//   ring pattern (metro 2, state 1, regional 1, national 1, world 1),
//   repeating the pattern as the block fills to its target length. A
//   slot whose ring has no fresh story left falls outward through the
//   rings after it, then through the general fallback order.
// - Plain blocks draw from their own category, then any alsoFrom pools
//   (e.g. newsletters in the AI/Tech blocks), then the general fallback.
//   In alsoFrom blocks, odd-numbered slots lead with the alsoFrom pools
//   instead, so the secondary wire is guaranteed airtime rather than
//   only surfacing when the primary pool runs dry.
function drawOneForSlot(ctx, block, slot, cutoffMs) {
  if (block.rings) {
    const ringCats = block.rings.map((r) => r.category);
    const pattern = block.rings.flatMap((ring) =>
      Array.from({ length: ring.count }, () => ring.category)
    );
    const cat = pattern[slot % pattern.length];
    const outward = ringCats.slice(ringCats.indexOf(cat));
    const order = [...new Set([...outward, ...FALLBACK_ORDER])];
    return drawItem(ctx, order, cutoffMs);
  }
  const drawOrder = [
    ...new Set([block.category, ...(block.alsoFrom || []), ...FALLBACK_ORDER]),
  ];
  const altDrawOrder = block.alsoFrom?.length
    ? [...new Set([...block.alsoFrom, block.category, ...FALLBACK_ORDER])]
    : drawOrder;
  return drawItem(ctx, slot % 2 === 1 ? altDrawOrder : drawOrder, cutoffMs);
}

// ---------------------------------------------------------------------------
// Block builders. Each returns { segments, storyUnits, seconds } with the
// segments in air order (startMs is assigned later, when the span's chain
// is assembled). storyUnits tracks each drawn story's segments (the story
// plus any banter attached to it) so the span trimmer can remove a whole
// unit and return the story to the pool.
// ---------------------------------------------------------------------------

function buildShowBlock(ctx, block, instance, blockDate, cutoffMs) {
  const segments = [];
  const storyUnits = [];
  const introId = `seg-${instance}-${block.key}-intro`;
  const intro = showIntro(block.key, introId, blockDate);
  const introSeg = {
    id: introId,
    kind: 'intro',
    blockKey: block.key,
    category: block.category,
    title: block.title,
    headline: block.title,
    source: 'KC Tech Radio',
    script: intro,
    estSeconds: estimateSeconds(intro),
  };
  segments.push(introSeg);
  let seconds = introSeg.estSeconds;

  // Draw stories until the block reaches BOTH its minimum story count
  // and its target length, or the wires run dry for this block.
  let slot = 0;
  while (storyUnits.length < block.stories || seconds < (block.targetSeconds || 0)) {
    const item = drawOneForSlot(ctx, block, slot, cutoffMs);
    if (!item) break; // nothing fresh anywhere: the span fills the gap
    const id = `seg-${instance}-${block.key}-${slot}-${hashString(item.id).toString(36)}`;
    const script = storyScript(item, id, slot === 0);
    const seg = {
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
    };
    storyUnits.push({ itemId: item.id, item, segments: [seg], seconds: seg.estSeconds });
    segments.push(seg);
    seconds += seg.estSeconds;
    slot++;
  }

  // Two-host banter CADENCE (David, Nov 19: banter shipped in the
  // expansion but was effectively absent, 4 segments in a whole
  // buffer, because only the two talk shows carried a single
  // hash-picked exchange each). Now every story block trades
  // exchanges around its stories: the talk shows (block.banter, the
  // KC Report and The AI Report) after every 4th story, every other
  // story block after every 8th story. Across the wheel that lands
  // roughly 8-12 exchanges per hour. The story itself was drawn (and
  // counted in the aired set) exactly once by the rotation above;
  // banter lines are framing copy and draw nothing. Banter is
  // CONTENT, not filler: it never counts toward the filler caps, and
  // its seconds count toward the block's total like any content.
  const cadence = block.banter ? 4 : 8;
  const exchangeUnits = new Set();
  storyUnits.forEach((unit, ui) => {
    if ((ui + 1) % cadence === 0) exchangeUnits.add(ui);
  });
  if (exchangeUnits.size) {
    const rebuilt = [segments[0]]; // the block intro
    storyUnits.forEach((unit, ui) => {
      rebuilt.push(unit.segments[0]);
      if (!exchangeUnits.has(ui)) return;
      const item = unit.item;
      const itemKey = hashString(item.id).toString(36);
      const reactionId = `seg-${instance}-${block.key}-banter-reaction-${itemKey}`;
      const reaction = nextBanterLine(ctx, 'reaction', BANTER_REACTIONS);
      const reactionSeg = {
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
      };
      const counterId = `seg-${instance}-${block.key}-banter-counter-${itemKey}`;
      const counter = nextBanterLine(ctx, 'counter', BANTER_COUNTERS);
      const counterSeg = {
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
      };
      rebuilt.push(reactionSeg, counterSeg);
      unit.segments.push(reactionSeg, counterSeg);
      unit.seconds += reactionSeg.estSeconds + counterSeg.estSeconds;
      seconds += reactionSeg.estSeconds + counterSeg.estSeconds;
    });
    segments.length = 0;
    segments.push(...rebuilt);
  }

  return { segments, storyUnits, seconds };
}

// Banter line rotation: within one hour, lines are drawn WITHOUT
// replacement from each pool, starting at an offset hashed from the
// hour, so no line repeats inside an hour and the rotation shifts
// every hour. (At the implemented cadence an hour uses at most ~12
// of the 15 reactions and 14 counters, so the pools cover the hour;
// the hash-pick fallback exists only as a belt-and-braces overflow.)
// buildHour resets the used sets at each hour boundary; replay and
// emission walk hours in the same order, so picks are deterministic.
function nextBanterLine(ctx, poolName, pool) {
  if (!ctx.banterUsed) ctx.banterUsed = { reaction: new Set(), counter: new Set() };
  const used = ctx.banterUsed[poolName];
  const start = hashString(`banter-${ctx.banterHourKey || 0}-${poolName}`) % pool.length;
  for (let j = 0; j < pool.length; j++) {
    const idx = (start + j) % pool.length;
    if (!used.has(idx)) {
      used.add(idx);
      return pool[idx];
    }
  }
  return pickFromPool(pool, `banter-overflow-${ctx.banterHourKey || 0}-${used.size}`);
}

function buildStationIdBlock(ctx, block, instance, blockDate) {
  const id = `seg-${instance}-${block.key}`;
  const script = stationIdScript(block.key, id, blockDate, ctx.weather);
  const seg = {
    id,
    kind: 'station-id',
    blockKey: block.key,
    category: 'station',
    title: block.title,
    headline: 'KC Tech Radio',
    source: 'KC Tech Radio',
    script,
    estSeconds: estimateSeconds(script),
  };
  return { segments: [seg], storyUnits: [], seconds: seg.estSeconds };
}

function buildProducersDeskBlock(ctx, block, instance) {
  const id = `seg-${instance}-${block.key}`;
  const script = producersDeskScript(id);
  const seg = {
    id,
    kind: 'producers-desk',
    blockKey: block.key,
    category: 'station',
    title: block.title,
    headline: block.title,
    source: 'KC Tech Radio',
    script,
    estSeconds: estimateSeconds(script),
  };
  return { segments: [seg], storyUnits: [], seconds: seg.estSeconds };
}

function buildMusicBlock(ctx, block, instance, blockDate) {
  // Kansas City Music Scene. Listings come from the music feed
  // (venue-verified only; see README "Music feed"). An empty feed means
  // the block contributes nothing this hour: no filler, no fake shows.
  // The chain absorbs its minutes (the span's other blocks and the
  // station-material filler cover the span to the next anchor).
  const listings = ctx.pools.music;
  if (!listings.length) return { segments: [], storyUnits: [], seconds: 0 };
  const segments = [];
  let seconds = 0;
  const introId = `seg-${instance}-${block.key}-intro`;
  const intro = showIntro(block.key, introId, blockDate);
  const introSeg = {
    id: introId,
    kind: 'intro',
    blockKey: block.key,
    category: 'music',
    title: block.title,
    headline: block.title,
    source: 'KC Tech Radio',
    script: intro,
    estSeconds: estimateSeconds(intro),
  };
  segments.push(introSeg);
  seconds += introSeg.estSeconds;

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
    segments.push(seg);
    seconds += seg.estSeconds;
  });
  return { segments, storyUnits: [], seconds };
}

// ---------------------------------------------------------------------------
// Station-material filler: the chain's shock absorber.
//
// When a span's stories and fixed copy do not reach the next anchor, the
// shortfall is filled with short deterministic station material: station
// IDs, Kansas City weather checks, producer's desk bits, station promos,
// and (in the last span of the hour) sign-offs. A small 0/1 knapsack
// solver composes candidates so the chain lands within a couple of
// seconds of the anchor. Candidates are generated in a fixed rotation
// with pool picks hashed from their segment ids, so the choice is a
// pure function of the span instance. A filler's script is composed
// BEFORE its final chain position is known (the solver lays candidates
// out in estimates, and span trimming can shift a station break after
// it was composed), so any time phrase baked in at compose time can be
// a minute off the segment's true start. Filler segments therefore
// carry their script renderer (scriptFor) through assembly, and
// buildSpan re-renders the script from the segment's own final chained
// startMs once positions are laid out: a filler speaks the minute of
// its own start, never a target or rounded minute. The time phrase's
// word count (and therefore the estimated duration) does not depend on
// which minute is spoken, so re-rendering never changes estSeconds and
// the chain tiling is unaffected.
// ---------------------------------------------------------------------------

const FILLER_PATTERN = ['promo', 'id', 'promo', 'weather', 'desk', 'promo', 'id', 'weather', 'promo', 'desk'];
const FILLER_PATTERN_LAST_SPAN = ['signoff', 'promo', 'id', 'weather', 'promo', 'signoff', 'desk', 'id', 'promo', 'weather'];

// FILL RULES (David, Nov 19, after a live screenshot showed ~100s of
// consecutive station bits with the first story at position 8):
// filler is seasoning, never the meal.
//  - A span that runs short draws MORE STORIES first (span-fill, from
//    the widest fallback pools, no-repeat rules intact) until the
//    remaining shortfall is at most FILLER_ALLOWANCE_SEC.
//  - A single filler chunk is at most FILLER_MAX_RUN_SEGMENTS
//    segments and at most FILLER_MAX_RUN_SECONDS of audio, with each
//    filler TYPE used at most once per chunk.
//  - A filler type does not recur within FILLER_TYPE_COOLDOWN_MS of
//    its last use inside the same span (ctx.fillerTypeEndMs, reset at
//    each span start and seeded by the station-id anchors and the
//    producer's desk block, which are the same types in block form).
//  - Only when the wire itself is exhausted (a span shortfall larger
//    than the allowance that story-fill could not cover) may the
//    solver top up past the run caps, because no dead air outranks
//    the seasoning rule; the top-up lands on the anchor by subset
//    sum and its segments are marked wireExhausted so audits report
//    the exhausted hour instead of mistaking it for a discipline
//    failure.
export const FILLER_ALLOWANCE_SEC = 60;
export const FILLER_MAX_RUN_SEGMENTS = 5;
export const FILLER_MAX_RUN_SECONDS = 60;
export const FILLER_TYPE_COOLDOWN_MS = 180 * 1000;

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

const FILLER_TITLES = {
  id: 'Station ID',
  weather: 'Kansas City Weather',
  desk: "The Producer's Desk",
  signoff: 'Station ID',
  promo: 'KC Tech Radio',
};

function fillerScriptFor(type, segId, date, weather, withWeather) {
  switch (type) {
    case 'id':
      return stationIdScript('station-id', segId, date, withWeather ? weather : null);
    case 'weather':
      return weather
        ? `It is ${spokenTime(date)} in Kansas City. Currently ${weather.tempF} degrees with ${weather.condition}, and winds around ${weather.windMph} miles per hour.`
        : pickFromPool(STATION_PROMOS, segId);
    case 'desk':
      return producersDeskScript(segId);
    case 'signoff':
      return pickFromPool(SIGN_OFFS, segId);
    default:
      return pickFromPool(STATION_PROMOS, segId);
  }
}

function makeFillerCandidate(ctx, spanInstance, spanIndex, n, placeholderDate) {
  const pattern = spanIndex === SPANS.length - 1 ? FILLER_PATTERN_LAST_SPAN : FILLER_PATTERN;
  let type = pattern[n % pattern.length];
  if (type === 'weather' && !ctx.weather) type = 'promo';
  const id = `seg-${spanInstance}-fill-${n}`;
  // Roughly every third station ID also carries the weather, for variety.
  const withWeather = type === 'id' && n % 3 === 2;
  const scriptFor = (date) => fillerScriptFor(type, id, date, ctx.weather, withWeather);
  return { n, id, type, scriptFor, estSeconds: estimateSeconds(scriptFor(placeholderDate)) };
}

/**
 * Compose filler segments totaling as close to targetSec as possible
 * without exceeding it, under the FILL RULES above: at most
 * FILLER_MAX_RUN_SEGMENTS segments, each filler type at most once,
 * and no type that is still inside its cooldown window at the chunk's
 * start position. A small 0/1 knapsack DP over (seconds, type-mask)
 * finds the best fit. If the rules leave a residual over 2s on a
 * SMALL target, one shortest extra candidate that overshoots by at
 * most 2s is placed anyway and the anchor caps its window
 * (slotEndMs), so the chain still tiles exactly. If the target is
 * LARGE (the wire ran dry and story-fill could not cover the span),
 * the solver tops up past the run caps with the shortest rotating
 * candidates, never repeating a type back to back: no dead air
 * outranks the seasoning rule, but that path should not occur while
 * the pools hold fresh stories. `state.nextN` is the span's shared
 * candidate counter: generated indices are consumed whether chosen
 * or not, keeping segment ids unique and the output deterministic.
 * Chosen segments record their type's end position in
 * ctx.fillerTypeEndMs for the cooldown rule.
 */
function solveFillerChunk(ctx, spanInstance, spanIndex, targetSec, startMs, state, opts = {}) {
  if (targetSec <= 2) return [];
  const placeholderDate = new Date(startMs);
  const candidates = [];
  let sum = 0;
  // Generate a deep candidate pool (at least 120, up to the 240 cap):
  // the strict DP and the landing swap both need several lengths per
  // filler type to hit a small target within a couple of seconds.
  while (candidates.length < 240 && (candidates.length < 120 || sum < targetSec + 240)) {
    const cand = makeFillerCandidate(ctx, spanInstance, spanIndex, state.nextN + candidates.length, placeholderDate);
    candidates.push(cand);
    sum += cand.estSeconds;
  }
  state.nextN += candidates.length;

  const TYPE_BIT = { promo: 1, id: 2, weather: 4, desk: 8, signoff: 16 };
  const cooldowns = ctx.fillerTypeEndMs || new Map();
  const usable = candidates.filter((cand) => {
    const lastEnd = cooldowns.get(cand.type);
    // A seed dated in the FUTURE of this chunk (the producer's desk
    // block sits later in the span than the mid-span break) does not
    // block this chunk; only actual past uses inside the window do.
    return !lastEnd || lastEnd > startMs || startMs - lastEnd >= FILLER_TYPE_COOLDOWN_MS;
  });

  // 0/1 knapsack over (seconds, type mask): the largest reachable
  // total <= targetSec using each filler type at most once and at
  // most FILLER_MAX_RUN_SEGMENTS segments (the mask's popcount).
  const dp = new Map();
  dp.set('0|0', { sum: 0, mask: 0, cand: -1, prev: null });
  usable.forEach((cand, ci) => {
    const bit = TYPE_BIT[cand.type] || 0;
    const d = cand.estSeconds;
    for (const [key, st] of [...dp.entries()]) {
      if (bit && st.mask & bit) continue;
      const ns = st.sum + d;
      if (ns > targetSec) continue;
      const nmask = st.mask | bit;
      if (popcount(nmask) > FILLER_MAX_RUN_SEGMENTS) continue;
      const nk = `${ns}|${nmask}`;
      if (!dp.has(nk)) dp.set(nk, { sum: ns, mask: nmask, cand: ci, prev: key });
    }
  });
  let bestKey = '0|0';
  let bestSum = 0;
  for (const [key, st] of dp) {
    if (st.sum > bestSum) { bestSum = st.sum; bestKey = key; }
  }
  const chosen = [];
  for (let k = bestKey; k && k !== '0|0'; ) {
    const st = dp.get(k);
    if (!st || st.cand < 0) break;
    chosen.push(usable[st.cand]);
    k = st.prev;
  }
  let composedSec = chosen.reduce((acc, c) => acc + c.estSeconds, 0);

  if (targetSec - composedSec > 2 && targetSec <= FILLER_MAX_RUN_SECONDS && chosen.length < FILLER_MAX_RUN_SEGMENTS) {
    // Small remainder the strict fit could not reach: place the
    // shortest candidate that overshoots by at most 2s and let the
    // anchor cap it, rather than leaving a hole. A fresh type is
    // preferred; if every type is already in the chunk, landing on
    // the anchor outranks type uniqueness, so any type except the
    // chunk's last segment's may close the gap.
    const usedTypes = new Set(chosen.map((c) => c.type));
    const usedIds = new Set(chosen.map((c) => c.n));
    // First try a same-type SWAP: replace one chosen candidate with
    // a longer unused candidate of the same type whose length lands
    // the chunk within 2s of the target. The chunk's type mix and
    // segment count are unchanged, so the run and cooldown rules
    // are untouched.
    let landed = false;
    for (let i = chosen.length - 1; i >= 0 && !landed; i--) {
      const cur = chosen[i];
      const want = targetSec - (composedSec - cur.estSeconds);
      const swap = usable
        .filter((c) => !usedIds.has(c.n) && c.type === cur.type && Math.abs(c.estSeconds - want) <= 2)
        .sort((a, b) => Math.abs(a.estSeconds - want) - Math.abs(b.estSeconds - want))[0];
      if (swap) {
        chosen[i] = swap;
        composedSec += swap.estSeconds - cur.estSeconds;
        landed = true;
      }
    }
    if (!landed) {
      const fits = (c) => !usedIds.has(c.n) && composedSec + c.estSeconds <= targetSec + 2;
      const lastType = chosen.length ? chosen[chosen.length - 1].type : null;
      const extra =
        usable.filter((c) => fits(c) && !usedTypes.has(c.type)).sort((a, b) => a.estSeconds - b.estSeconds)[0] ||
        usable.filter((c) => fits(c) && c.type !== lastType).sort((a, b) => a.estSeconds - b.estSeconds)[0];
      if (extra) {
        chosen.push(extra);
        composedSec += extra.estSeconds;
      }
    }
  }

  const topUpCands = new Set();
  if (targetSec - composedSec > 2 && targetSec > FILLER_MAX_RUN_SECONDS) {
    // Wire-exhaustion top-up: the span's story-fill ran dry, so the
    // run caps cannot hold; what still must hold is landing on the
    // anchor. A subset-sum DP over the remaining candidates (each at
    // most once) finds the largest reachable total at or under the
    // remaining target, which lands within a couple of seconds in
    // practice; a final single candidate may overshoot by at most
    // 2s and be capped by the anchor, as in the small-target path.
    // Candidates come in generation order, which interleaves types,
    // so the composed run rotates material instead of stacking one
    // type. Segments placed here are marked wireExhausted when the
    // caller knows the wire ran dry (opts.exhausted), so audits can
    // tell an exhaustion wall from a discipline failure.
    const usedIds = new Set(chosen.map((c) => c.n));
    const rest = candidates.filter((c) => !usedIds.has(c.n));
    const remainder = targetSec - composedSec;
    const reach = new Uint8Array(remainder + 1);
    const pickAt = new Int32Array(remainder + 1).fill(-1);
    const prevAt = new Int32Array(remainder + 1).fill(-1);
    reach[0] = 1;
    rest.forEach((cand, ci) => {
      const d = cand.estSeconds;
      for (let s = remainder - d; s >= 0; s--) {
        if (reach[s] && !reach[s + d]) {
          reach[s + d] = 1;
          pickAt[s + d] = ci;
          prevAt[s + d] = s;
        }
      }
    });
    let best = remainder;
    while (best > 0 && !reach[best]) best--;
    for (let s = best; s > 0; s = prevAt[s]) {
      const cand = rest[pickAt[s]];
      chosen.push(cand);
      topUpCands.add(cand);
      composedSec += cand.estSeconds;
    }
    if (targetSec - composedSec > 2) {
      const usedNow = new Set(chosen.map((c) => c.n));
      const lastType = chosen.length ? chosen[chosen.length - 1].type : null;
      const extra = candidates
        .filter((c) => !usedNow.has(c.n) && c.type !== lastType && composedSec + c.estSeconds <= targetSec + 2)
        .sort((a, b) => a.estSeconds - b.estSeconds)[0];
      if (extra) {
        chosen.push(extra);
        topUpCands.add(extra);
        composedSec += extra.estSeconds;
      }
    }
  }

  chosen.sort((a, b) => a.n - b.n);
  const segments = [];
  let t = startMs;
  for (const cand of chosen) {
    // Provisional script, rendered at the solver's layout position. It
    // is used for the duration estimate only; buildSpan re-renders it
    // from the segment's final chained startMs via scriptFor (below)
    // once the chain positions are final.
    const script = cand.scriptFor(new Date(t));
    segments.push({
      id: cand.id,
      kind: 'filler',
      fillerType: cand.type,
      ...(opts.exhausted && topUpCands.has(cand) ? { wireExhausted: true } : {}),
      blockKey: 'filler',
      category: 'station',
      title: FILLER_TITLES[cand.type] || 'KC Tech Radio',
      headline: 'KC Tech Radio',
      source: 'KC Tech Radio',
      script,
      estSeconds: estimateSeconds(script),
      scriptFor: cand.scriptFor,
    });
    t += segments[segments.length - 1].estSeconds * 1000;
    if (ctx.fillerTypeEndMs) ctx.fillerTypeEndMs.set(cand.type, t);
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Span-fill stories: when a span's own blocks run short of the next
// anchor, the span draws MORE STORIES before it touches filler
// (David's rule: cross-category borrowing beats padding). Stories are
// drawn freshest-first across the full fallback order, under the same
// no-repeat aired set and the same honesty cutoff as block draws (the
// span's own start). A candidate is only taken if its whole estimated
// length fits the remaining shortfall, so story-fill never overruns
// the anchor; a story skipped for length stays eligible for a later
// span. The segments air as a "More Headlines" run at the end of the
// span, right before any final filler and the anchor.
// ---------------------------------------------------------------------------

function drawSpanFillStory(ctx, anchorInstance, k, cutoffMs, maxSeconds) {
  for (const cat of FALLBACK_ORDER) {
    const list = ctx.pools[cat];
    if (!list || !list.length) continue;
    for (const item of list) {
      if (ctx.airedItemIds.has(item.id)) continue;
      if (item.publishedAt != null && item.publishedAt > cutoffMs) continue;
      const id = `seg-${anchorInstance}-spanfill-${k}-${hashString(item.id).toString(36)}`;
      const script = storyScript(item, id, false);
      const estSeconds = estimateSeconds(script);
      if (estSeconds > maxSeconds) continue;
      ctx.airedItemIds.add(item.id);
      return {
        itemId: item.id,
        seconds: estSeconds,
        seg: {
          id,
          kind: 'story',
          blockKey: 'span-fill',
          category: item.category,
          title: 'More Headlines',
          headline: item.title,
          source: item.source,
          link: item.link,
          script,
          estSeconds,
        },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Span + hour assembly (the continuous chain)
// ---------------------------------------------------------------------------

function buildSpan(ctx, span, wall, instanceBase) {
  const spanStartMs = epochForChicagoWall(wall.year, wall.month, wall.day, wall.hour, span.startMinute);
  const spanEndMs =
    span.endMinute === 60
      ? epochForChicagoWall(wall.year, wall.month, wall.day, wall.hour + 1, 0)
      : epochForChicagoWall(wall.year, wall.month, wall.day, wall.hour, span.endMinute);
  const spanLengthSec = Math.round((spanEndMs - spanStartMs) / 1000);
  const anchorBlock = span.blocks[0];
  const anchorInstance = instanceBase + FORMAT_CLOCK.indexOf(anchorBlock);
  const fillerState = { nextN: 0 };

  // Build every block in the span, in clock order. Block scripts are
  // position-independent (only the span's anchor speaks a time, and its
  // start is the span start by construction), so blocks can be built
  // before the chain positions are known. Each show block's draws use
  // the honesty cutoff of its own scheduled (nominal) start.
  const parts = span.blocks.map((block) => {
    const instance = instanceBase + FORMAT_CLOCK.indexOf(block);
    const blockStartMs = epochForChicagoWall(wall.year, wall.month, wall.day, wall.hour, block.startMinute);
    const blockDate = new Date(blockStartMs);
    let built;
    if (block.kind === 'show') built = buildShowBlock(ctx, block, instance, blockDate, blockStartMs);
    else if (block.kind === 'station-id') built = buildStationIdBlock(ctx, block, instance, blockDate);
    else if (block.kind === 'producers-desk') built = buildProducersDeskBlock(ctx, block, instance);
    else if (block.kind === 'music') built = buildMusicBlock(ctx, block, instance, blockDate);
    else built = { segments: [], storyUnits: [], seconds: 0 };
    return { block, ...built };
  });
  const totalSec = () => parts.reduce((acc, p) => acc + p.seconds, 0);
  let total = totalSec();

  // Filler-type cooldown scope: the cooldown window runs WITHIN a
  // span. Anchors are natural separators (a real station break), so
  // the map resets at each span start; the span then seeds the types
  // its own blocks embody: the anchor, when it is a station ID (the
  // :30 ID and the :57 tease), IS the 'id' type, and the producer's
  // desk block IS the 'desk' type, so filler of those types must not
  // recur within the cooldown window of the blocks themselves.
  // (This is what stacked a filler Station ID and a filler
  // Producer's Desk on top of their block counterparts in the
  // Nov 19 screenshot.)
  if (ctx.fillerTypeEndMs) {
    ctx.fillerTypeEndMs.clear();
    const anchorSeg = parts[0]?.segments[0];
    if (anchorSeg && (anchorBlock.key === 'station-id' || anchorBlock.key === 'hour-tease')) {
      const end = spanStartMs + anchorSeg.estSeconds * 1000;
      if (end > (ctx.fillerTypeEndMs.get('id') || 0)) ctx.fillerTypeEndMs.set('id', end);
    }
    let deskPosSec = 0;
    for (const part of parts) {
      if (part.block.key === 'producers-desk' && part.segments.length) {
        const end = spanStartMs + (deskPosSec + part.seconds) * 1000;
        if (end > (ctx.fillerTypeEndMs.get('desk') || 0)) ctx.fillerTypeEndMs.set('desk', end);
      }
      deskPosSec += part.seconds;
    }
  }

  const firstShowIdx = parts.findIndex((p) => p.block.kind === 'show');
  const showCount = parts.filter((p) => p.block.kind === 'show').length;

  // Trim: if the span would overrun its anchor, drop trailing story
  // units (story + its banter) until it fits. Units ahead of the
  // station break are trimmed only as a last resort (their removal
  // would shift the break's position, and the break's scripts speak
  // their position's time). A trimmed story is returned to the pool:
  // it never aired, so it must not consume its no-repeat slot.
  const trimFrom = (fromPartIdx) => {
    for (let pi = parts.length - 1; pi >= fromPartIdx && total > spanLengthSec; pi--) {
      const part = parts[pi];
      while (part.storyUnits.length && total > spanLengthSec) {
        const unit = part.storyUnits.pop();
        const ids = new Set(unit.segments.map((s) => s.id));
        part.segments = part.segments.filter((s) => !ids.has(s.id));
        part.seconds -= unit.seconds;
        total -= unit.seconds;
        ctx.airedItemIds.delete(unit.itemId);
      }
    }
  };
  if (total > spanLengthSec) {
    trimFrom(firstShowIdx + 1);
    if (total > spanLengthSec) trimFrom(0);
    // If fixed copy alone ever overran a span (it cannot with the
    // current clock: anchors + desk + music run about a minute), the
    // anchor would still pin the next span and the player would cut
    // the overrun at the anchor via slotEndMs.
  }

  // Span-fill stories: a short span draws MORE STORIES before it
  // touches filler (David's rule). Stories are drawn from the widest
  // fallback pools until the shortfall is down to the filler
  // allowance; they air as a "More Headlines" run at the end of the
  // span. This is the main absorber now: the old design went straight
  // to station material, which is how an hour ended up with ~800s of
  // filler (see the Nov 19 diagnosis in the README).
  const spanFillSegs = [];
  let fillExhausted = false;
  if (total < spanLengthSec) {
    let k = 0;
    while (spanLengthSec - total > FILLER_ALLOWANCE_SEC && k < 48) {
      const drawn = drawSpanFillStory(
        ctx, anchorInstance, k, spanStartMs, spanLengthSec - total
      );
      if (!drawn) { fillExhausted = true; break; } // wire exhausted for this span: filler tops up
      spanFillSegs.push(drawn.seg);
      total += drawn.seconds;
      k++;
    }
  }

  // Station break after the span's first show block: a SHORT break
  // only (one small chunk under the run caps), and only when a real
  // shortfall remains after story-fill, so the remaining filler does
  // not all pile up against the anchor.
  let breakSegs = [];
  if (showCount >= 2 && spanLengthSec - total >= 90) {
    const breakTarget = Math.min(30, spanLengthSec - total - FILLER_ALLOWANCE_SEC);
    if (breakTarget >= 8) {
      const posMs =
        spanStartMs +
        parts.slice(0, firstShowIdx + 1).reduce((acc, p) => acc + p.seconds, 0) * 1000;
      breakSegs = solveFillerChunk(ctx, anchorInstance, span.index, breakTarget, posMs, fillerState);
      total += breakSegs.reduce((acc, s) => acc + s.estSeconds, 0);
    }
  }

  // Final fill: compose station material for whatever shortfall
  // remains (at most the allowance, while the wire holds out),
  // landing the chain within a couple of seconds of the anchor.
  let finalSegs = [];
  const residual = spanLengthSec - total;
  if (residual > 2) {
    finalSegs = solveFillerChunk(
      ctx, anchorInstance, span.index, residual, spanStartMs + total * 1000, fillerState,
      { exhausted: fillExhausted }
    );
    total += finalSegs.reduce((acc, s) => acc + s.estSeconds, 0);
  }

  // Assemble in air order and lay the chain: each segment starts where
  // the previous one ended, beginning exactly at the anchor's minute.
  const ordered = [];
  parts.forEach((part, i) => {
    ordered.push(...part.segments);
    if (i === firstShowIdx) ordered.push(...breakSegs);
  });
  ordered.push(...spanFillSegs);
  ordered.push(...finalSegs);
  let t = spanStartMs;
  for (const seg of ordered) {
    seg.startMs = t;
    if (seg.scriptFor) {
      // Positions are final now: re-render the filler's script from
      // its own chained start so any time it speaks is the minute of
      // its true start. (The solver composed the script earlier, at
      // its estimated layout position, and trimming since then can
      // have shifted the segment.) The spoken-time phrase has the
      // same word count in every minute, so estSeconds, and therefore
      // the rest of the chain, is unchanged by the re-render.
      seg.script = seg.scriptFor(new Date(seg.startMs));
      delete seg.scriptFor;
    }
    t += seg.estSeconds * 1000;
  }
  return ordered;
}

function buildHour(ctx, hourStartMs) {
  // Banter rotation is per hour: fresh used-line sets at each hour
  // boundary (see nextBanterLine).
  ctx.banterHourKey = hourStartMs;
  ctx.banterUsed = { reaction: new Set(), counter: new Set() };
  const wall = chicagoWallParts(new Date(hourStartMs));
  // Absolute hour counter (UTC-based) gives each airing of a block a
  // unique, monotonically increasing instance number -> stable ids.
  const instanceBase = Math.round(hourStartMs / 3600000) * BLOCKS;
  const segments = [];
  for (const span of SPANS) segments.push(...buildSpan(ctx, span, wall, instanceBase));
  return segments;
}

function nextHourStartMs(hourStartMs) {
  const wall = chicagoWallParts(new Date(hourStartMs));
  return epochForChicagoWall(wall.year, wall.month, wall.day, wall.hour + 1, 0);
}

function cycleStartMsFor(hourStartMs) {
  const wall = chicagoWallParts(new Date(hourStartMs));
  return epochForChicagoWall(wall.year, wall.month, wall.day, Math.floor(wall.hour / 8) * 8, 0);
}

// ---------------------------------------------------------------------------
// Playlist builder
// ---------------------------------------------------------------------------

/**
 * Build the rolling playlist starting "now".
 *
 * @param pool    news pool from ingest.getNewsPool()
 * @param weather weather object or null
 * @param nowMs   epoch ms to build from (injectable for tests)
 * @returns { generatedAt, segments, bufferSeconds }
 *   Each segment: { id, kind, blockKey, category, title, headline, source,
 *                   script, estSeconds, startMs, slotEndMs, voice, audioUrl }
 *   `startMs` is the segment's chained scheduled start epoch (the chain
 *   tiles the hour end to end from the top of the hour); `slotEndMs` is
 *   the next segment's startMs, i.e. the exact end of this segment's
 *   window. `bufferSeconds` is WALL-CLOCK COVERAGE: seconds from now
 *   until the end of the last returned segment (the chain has no holes,
 *   so coverage is continuous). Segments whose window has fully passed
 *   are dropped from the response (their draws still count in the
 *   cycle's aired set, via the replay). `voice`/`audioUrl` point at the
 *   pre-rendered Edge TTS MP3 for the segment (see lib/voices.js and
 *   lib/tts.js); the player falls back to browser speechSynthesis only
 *   if that MP3 fails.
 */
export function buildPlaylist(pool, weather, nowMs = Date.now()) {
  const pools = {};
  for (const cat of [...FALLBACK_ORDER, 'music']) pools[cat] = itemsForCategory(pool, cat);

  // --- No-repeat rotation (David's hard rule) ------------------------------
  // airedItemIds holds every story drawn since the cycle anchor, across
  // ALL shows: a story airs once, then it is out of rotation until its
  // pool fully cycles. The set is reconstructed by replay (below), never
  // stored, which keeps the serverless design stateless and the output a
  // pure function of the pool snapshot and the clock.
  const ctx = { pools, weather, airedItemIds: new Set(), fillerTypeEndMs: new Map() };

  const nowWall = chicagoWallParts(new Date(nowMs));
  const currentHourStartMs = epochForChicagoWall(nowWall.year, nowWall.month, nowWall.day, nowWall.hour, 0);
  const anchorMs = cycleStartMsFor(currentHourStartMs);

  // --- Cycle replay ---------------------------------------------------------
  // Reconstruct the aired set by replaying this cycle's schedule from
  // the cycle anchor (start of the current 8-hour America/Chicago
  // window: 00:00, 08:00, or 16:00) up to the current hour, through the
  // exact buildHour code path emission uses, publication cutoffs and
  // all. Only the draws matter; the segments are discarded. Cost is
  // bounded: at most 8 hours of schedule per request.
  for (
    let h = anchorMs, guard = 0;
    h < currentHourStartMs && guard < 10;
    h = nextHourStartMs(h), guard++
  ) {
    buildHour(ctx, h);
  }

  // --- Emission ---------------------------------------------------------------
  // Build the current hour's full chain (its early segments are already
  // in the past; they are dropped below, after slotEndMs is assigned),
  // then keep building whole hours until the wall-clock coverage ahead
  // of now reaches the target buffer. At least two hours are always
  // built (the current hour and the next), so the top-of-hour anchor is
  // already in the response as the hour turns. Crossing a cycle
  // boundary resets the aired set: the next 8-hour window starts with
  // a fresh rotation.
  const segments = [];
  let lastEndMs = 0;
  let emissionCycleStart = anchorMs;
  for (
    let h = currentHourStartMs, i = 0;
    i < 4;
    h = nextHourStartMs(h), i++
  ) {
    const hCycleStart = cycleStartMsFor(h);
    if (hCycleStart !== emissionCycleStart) {
      ctx.airedItemIds.clear();
      emissionCycleStart = hCycleStart;
    }
    const hourSegs = buildHour(ctx, h);
    segments.push(...hourSegs);
    if (hourSegs.length) {
      const last = hourSegs[hourSegs.length - 1];
      lastEndMs = last.startMs + last.estSeconds * 1000;
    }
    if (i >= 1 && lastEndMs - nowMs >= TARGET_BUFFER_SECONDS * 1000) break;
  }

  // Fill in slotEndMs: in the chain, a segment's slot ends exactly where
  // the next segment begins. The last segment's slot ends at its own
  // chained end (the next hour's top, not yet walked).
  for (let i = 0; i < segments.length; i++) {
    segments[i].slotEndMs =
      i + 1 < segments.length
        ? segments[i + 1].startMs
        : segments[i].startMs + segments[i].estSeconds * 1000;
  }

  // Drop segments whose window has fully passed; the player never needs
  // them, and the response stays small. The live segment (the one whose
  // window contains now) is always kept: its slotEndMs is in the future.
  const live = segments.filter((s) => s.slotEndMs > nowMs);

  // Total wire failure (or first cold start): never return an empty
  // queue. The chain builder cannot actually produce one (the anchors
  // always emit), so this is a belt-and-braces guard only. The filler
  // is fixed station copy, not a story, so it is exempt from the
  // no-repeat rule.
  if (!live.length) {
    const filler = {
      id: `seg-filler-${Math.floor(nowMs / 3600000)}`,
      kind: 'filler',
      blockKey: 'filler',
      category: 'station',
      title: 'Station Note',
      headline: 'KC Tech Radio',
      source: 'KC Tech Radio',
      script: FILLER_SCRIPT,
      estSeconds: estimateSeconds(FILLER_SCRIPT),
      startMs: currentHourStartMs,
      slotEndMs: currentHourStartMs + 3600000,
    };
    live.push(filler);
    lastEndMs = filler.slotEndMs;
  }

  // Attach each segment's voice and its pre-rendered audio URL. The
  // voice is decided by block (lib/voices.js); the URL derives entirely
  // from the segment's voice + script, so it is as deterministic as the
  // segment id.
  const out = live.map((seg) => {
    const voice = voiceForSegment(seg);
    return { ...seg, voice, audioUrl: audioUrlFor(voice, seg.script, seg.id) };
  });

  const bufferSeconds = Math.max(0, Math.round((lastEndMs - nowMs) / 1000));
  return { generatedAt: new Date(nowMs).toISOString(), segments: out, bufferSeconds };
}
