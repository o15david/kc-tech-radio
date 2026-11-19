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
//   - if a span still runs short of its anchor, the shortfall is filled
//     with short deterministic station material (station IDs, weather
//     checks, producer's desk bits, station promos from lib/gonzo.js),
//     composed by a small exact solver so the chain lands within a
//     couple of seconds of the anchor, part of it as a station break
//     after the span's first show and the rest right before the anchor;
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
// Speech rate assumption for duration estimates. The Edge neural voices at
// their default rate speak roughly 150-160 wpm, as does browser
// speechSynthesis at rate 1.0 (the fallback path).
export const WORDS_PER_MINUTE = 155;
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

function cleanSummary(summary) {
  if (!summary) return '';
  let s = summary
    .replace(/\s*(Continue reading|Read more|Read More)[\s\S]*$/, '')
    .replace(/\[…\]|\[\.\.\.\]/g, '')
    .trim();
  const MAX = 480;
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

  // Two-host banter: in the talk shows (block.banter), one story per
  // airing gets a short exchange after it: the co-host reacts, the
  // anchor counters. Which story is picked by hash of the block
  // instance, so the exchange lands on a different story each hour.
  // The story itself was drawn (and counted in the aired set) exactly
  // once by the rotation above; the banter lines are framing copy and
  // draw nothing.
  if (block.banter && storyUnits.length) {
    const banterSlot = hashString(`banter-${instance}`) % storyUnits.length;
    const unit = storyUnits[banterSlot];
    const item = unit.item;
    const itemKey = hashString(item.id).toString(36);
    const storyPos = segments.indexOf(unit.segments[0]);
    const reactionId = `seg-${instance}-${block.key}-banter-reaction-${itemKey}`;
    const reaction = pickFromPool(BANTER_REACTIONS, reactionId);
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
    const counter = pickFromPool(BANTER_COUNTERS, counterId);
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
    segments.splice(storyPos + 1, 0, reactionSeg, counterSeg);
    unit.segments.push(reactionSeg, counterSeg);
    unit.seconds += reactionSeg.estSeconds + counterSeg.estSeconds;
    seconds += reactionSeg.estSeconds + counterSeg.estSeconds;
  }

  return { segments, storyUnits, seconds };
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
// pure function of the span instance. Filler scripts that speak a time
// are written against the segment's own chained start; their word count
// (and therefore their estimated duration) does not depend on which
// minute they land in, so a candidate's estimate is valid wherever the
// solver places it.
// ---------------------------------------------------------------------------

const FILLER_PATTERN = ['promo', 'id', 'promo', 'weather', 'desk', 'promo', 'id', 'weather', 'promo', 'desk'];
const FILLER_PATTERN_LAST_SPAN = ['signoff', 'promo', 'id', 'weather', 'promo', 'signoff', 'desk', 'id', 'promo', 'weather'];

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
 * without exceeding it (residual 0-2s in practice; see the solver note).
 * If the target is small and no combination fits inside it, one shortest
 * candidate is placed anyway and the anchor caps its window (slotEndMs),
 * so the chain still tiles exactly. `state.nextN` is the span's shared
 * candidate counter: generated indices are consumed whether chosen or
 * not, keeping segment ids unique and the output deterministic.
 */
function solveFillerChunk(ctx, spanInstance, spanIndex, targetSec, startMs, state) {
  if (targetSec <= 2) return [];
  const placeholderDate = new Date(startMs);
  const candidates = [];
  let sum = 0;
  while (sum < targetSec + 45 && candidates.length < 240) {
    const cand = makeFillerCandidate(ctx, spanInstance, spanIndex, state.nextN + candidates.length, placeholderDate);
    candidates.push(cand);
    sum += cand.estSeconds;
  }
  state.nextN += candidates.length;

  // 0/1 knapsack over seconds: the largest reachable total <= targetSec.
  const R = targetSec;
  const reachable = new Array(R + 1).fill(false);
  const parentCand = new Int32Array(R + 1).fill(-1);
  const parentSum = new Int32Array(R + 1).fill(-1);
  reachable[0] = true;
  candidates.forEach((cand, ci) => {
    const d = cand.estSeconds;
    for (let s = R - d; s >= 0; s--) {
      if (reachable[s] && !reachable[s + d]) {
        reachable[s + d] = true;
        parentCand[s + d] = ci;
        parentSum[s + d] = s;
      }
    }
  });
  let best = R;
  while (best > 0 && !reachable[best]) best--;
  const chosen = [];
  for (let s = best; s > 0; s = parentSum[s]) chosen.push(candidates[parentCand[s]]);
  chosen.sort((a, b) => a.n - b.n);

  if (R - best > 2 && R <= 45) {
    // Nothing fits inside this small remainder: place the shortest
    // candidate and let the anchor cap it (its slotEndMs is the next
    // segment's start, so the schedule still tiles with no hole).
    const chosenIdx = new Set(chosen.map((c) => c.n));
    const extra = candidates
      .filter((c) => !chosenIdx.has(c.n))
      .sort((a, b) => a.estSeconds - b.estSeconds)[0];
    if (extra) chosen.push(extra);
  }

  const segments = [];
  let t = startMs;
  for (const cand of chosen) {
    const script = cand.scriptFor(new Date(t));
    segments.push({
      id: cand.id,
      kind: 'filler',
      blockKey: 'filler',
      category: 'station',
      title: FILLER_TITLES[cand.type] || 'KC Tech Radio',
      headline: 'KC Tech Radio',
      source: 'KC Tech Radio',
      script,
      estSeconds: estimateSeconds(script),
    });
    t += segments[segments.length - 1].estSeconds * 1000;
  }
  return segments;
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

  // Station break after the span's first show block, when the span
  // projects to run well short of its anchor: part of the shortfall is
  // filled here so the filler does not all pile up against the anchor.
  const firstShowIdx = parts.findIndex((p) => p.block.kind === 'show');
  const showCount = parts.filter((p) => p.block.kind === 'show').length;
  let breakSegs = [];
  if (showCount >= 2 && spanLengthSec - total > 150) {
    const breakTarget = Math.min(200, Math.floor((spanLengthSec - total) * 0.4));
    const posMs =
      spanStartMs +
      parts.slice(0, firstShowIdx + 1).reduce((acc, p) => acc + p.seconds, 0) * 1000;
    breakSegs = solveFillerChunk(ctx, anchorInstance, span.index, breakTarget, posMs, fillerState);
    total += breakSegs.reduce((acc, s) => acc + s.estSeconds, 0);
  }

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

  // Final fill: compose station material for whatever shortfall
  // remains, landing the chain within a couple of seconds of the anchor.
  let finalSegs = [];
  const residual = spanLengthSec - total;
  if (residual > 2) {
    finalSegs = solveFillerChunk(
      ctx, anchorInstance, span.index, residual, spanStartMs + total * 1000, fillerState
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
  ordered.push(...finalSegs);
  let t = spanStartMs;
  for (const seg of ordered) {
    seg.startMs = t;
    t += seg.estSeconds * 1000;
  }
  return ordered;
}

function buildHour(ctx, hourStartMs) {
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
  const ctx = { pools, weather, airedItemIds: new Set() };

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
