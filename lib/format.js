// ============================================================================
// THE FORMAT CLOCK
//
// KC Tech Radio runs on a fixed hourly wheel, like a real radio station.
// Every hour has the same shape; only the headlines change. All copy is
// template-driven: there is NO language model anywhere in this pipeline,
// so an hour of programming costs exactly zero AI credits and the output
// for a given set of headlines is fully deterministic.
//
//   :00  GLOBAL NEWS block      world headlines, top of the hour
//   :08  KC LOCAL show          Kansas City tech & business
//   :20  AI NEWS show           artificial intelligence, TBPN-style pacing
//   :30  STATION ID + KC time/weather check
//   :33  TECH HEADLINES
//   :45  BUSINESS HEADLINES
//   :53  KC LOCAL ENCORE        more local (falls back to AI/tech overflow)
//   :57  STATION ID + tease for top-of-hour global news
//
// Headline selection is deterministic too: a per-category cursor derived
// from the absolute block-instance number (hours since epoch * blocks +
// block index), so repeated /api/playlist calls inside the same window
// return the same queue, and the queue advances as the clock advances.
// ============================================================================

import { itemsForCategory } from './ingest';

export const TIME_ZONE = 'America/Chicago';
// Speech rate assumption for duration estimates. Browser speechSynthesis at
// rate 1.0 speaks roughly 150-160 wpm for typical en-US voices.
export const WORDS_PER_MINUTE = 155;
// The playlist endpoint always returns at least this much audio ahead.
export const TARGET_BUFFER_SECONDS = 12 * 60;

export const FORMAT_CLOCK = [
  { startMinute: 0, key: 'global-news', kind: 'show', category: 'global', title: 'World News at the Top of the Hour', stories: 4 },
  { startMinute: 8, key: 'kc-local', kind: 'show', category: 'local', title: 'Kansas City Tech & Business Report', stories: 4 },
  { startMinute: 20, key: 'ai-news', kind: 'show', category: 'ai', title: 'The AI Report', stories: 4 },
  { startMinute: 30, key: 'station-id', kind: 'station-id', category: null, title: 'Station ID & Kansas City Weather', stories: 0 },
  { startMinute: 33, key: 'tech-headlines', kind: 'show', category: 'tech', title: 'Tech Headlines', stories: 4 },
  { startMinute: 45, key: 'business-headlines', kind: 'show', category: 'business', title: 'Business & Markets', stories: 3 },
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

function spokenTime(date) {
  const p = chicagoParts(date);
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

const SHOW_INTROS = {
  'global-news': (date) =>
    `World news at the top of the hour, on KC Tech Radio. It is ${spokenTime(date)} Central Time, ${spokenDate(date)}. Here are the global headlines.`,
  'kc-local': () =>
    'From the Crossroads to the Northland, this is the Kansas City Tech and Business Report, on KC Tech Radio. Here is what is happening in the local tech scene.',
  'ai-news': () =>
    'Now, the AI Report: new models, big funding, and the business of artificial intelligence. Here is the latest in AI.',
  'tech-headlines': () =>
    'Tech headlines: the biggest stories in technology right now, on KC Tech Radio.',
  'business-headlines': () =>
    'Business and markets: here is the latest from the business wires.',
  'kc-encore': () =>
    'More from Kansas City: another look at local tech and business, on KC Tech Radio.',
};

// Fixed transition pool. The pick is a hash of the segment's deterministic
// id, so the same segment always gets the same transition (cache-friendly).
const TRANSITIONS = [
  '',
  'In other news,',
  'Meanwhile,',
  'Next,',
  'Also today,',
  'On a related note,',
  'Here is another story.',
  'Turning to the wires,',
];

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

function stationIdScript(blockKey, date, weather) {
  const base =
    `You are listening to KC Tech Radio: Kansas City tech, business, and AI news, around the clock. ` +
    `It is ${spokenTime(date)} in Kansas City.`;
  const weatherLine = weather
    ? ` Currently ${weather.tempF} degrees with ${weather.condition}, and winds around ${weather.windMph} miles per hour.`
    : '';
  const tease =
    blockKey === 'hour-tease'
      ? ' World news is next, at the top of the hour, right here on KC Tech Radio.'
      : '';
  return base + weatherLine + tease;
}

const FILLER_SCRIPT =
  'You are listening to KC Tech Radio. Our news wires are momentarily quiet, ' +
  'so here is a quick station note: KC Tech Radio brings you Kansas City tech ' +
  'and business news, the latest in artificial intelligence, and world news ' +
  'at the top of every hour, twenty four hours a day. Stay with us; the next ' +
  'headlines are coming up shortly.';

// Category fallback order when a pool runs dry: never let a block go silent.
const FALLBACK_ORDER = ['local', 'ai', 'tech', 'business', 'global'];

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
 *                   script, estSeconds }
 */
export function buildPlaylist(pool, weather, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const parts = chicagoParts(now);
  const minute = parseInt(parts.minute, 10);
  const startBlockIdx = blockIndexForMinute(minute);

  const segments = [];
  const usedItemIds = new Set();
  let bufferSeconds = 0;

  const pools = {};
  for (const cat of FALLBACK_ORDER) pools[cat] = itemsForCategory(pool, cat);

  function pickItem(category, cursorSeed) {
    const order = [category, ...FALLBACK_ORDER.filter((c) => c !== category)];
    for (const cat of order) {
      const list = pools[cat];
      if (!list.length) continue;
      // Deterministic rotation: start at a cursor derived from the block
      // instance, then walk forward until an unused item appears.
      let idx = cursorSeed % list.length;
      for (let tried = 0; tried < list.length; tried++) {
        const item = list[(idx + tried) % list.length];
        if (!usedItemIds.has(item.id)) {
          usedItemIds.add(item.id);
          return item;
        }
      }
    }
    return null;
  }

  // Absolute hour counter (UTC-based) gives each airing of a block a unique,
  // monotonically increasing instance number -> stable cursors per airing.
  const absHour = Math.floor(nowMs / 3600000);

  // Walk the wheel forward from the current block until we have filled the
  // target buffer. The guard bound keeps a pathological pool from looping.
  for (let step = 0; step < FORMAT_CLOCK.length * 4 && bufferSeconds < TARGET_BUFFER_SECONDS; step++) {
    const blockIdx = (startBlockIdx + step) % FORMAT_CLOCK.length;
    const hourOffset = Math.floor((startBlockIdx + step) / FORMAT_CLOCK.length);
    const block = FORMAT_CLOCK[blockIdx];
    const instance = (absHour + hourOffset) * FORMAT_CLOCK.length + blockIdx;
    // Segments are dated by the hour they belong to, for spoken time lines.
    const blockDate = new Date(nowMs + hourOffset * 3600000);

    if (block.kind === 'station-id') {
      const script = stationIdScript(block.key, blockDate, weather);
      segments.push({
        id: `seg-${instance}-${block.key}`,
        kind: 'station-id',
        blockKey: block.key,
        category: 'station',
        title: block.title,
        headline: 'KC Tech Radio',
        source: 'KC Tech Radio',
        script,
        estSeconds: estimateSeconds(script),
      });
      bufferSeconds += segments[segments.length - 1].estSeconds;
      continue;
    }

    const intro = SHOW_INTROS[block.key](blockDate);
    segments.push({
      id: `seg-${instance}-${block.key}-intro`,
      kind: 'intro',
      blockKey: block.key,
      category: block.category,
      title: block.title,
      headline: block.title,
      source: 'KC Tech Radio',
      script: intro,
      estSeconds: estimateSeconds(intro),
    });
    bufferSeconds += segments[segments.length - 1].estSeconds;

    for (let s = 0; s < block.stories; s++) {
      const item = pickItem(block.category, instance * 31 + s * 7);
      if (!item) break;
      const id = `seg-${instance}-${block.key}-${s}-${hashString(item.id).toString(36)}`;
      const script = storyScript(item, id, s === 0);
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
      segments.push(seg);
      bufferSeconds += seg.estSeconds;
    }
  }

  // Total wire failure (or first cold start): never return an empty queue.
  if (!segments.some((s) => s.kind === 'story')) {
    segments.push({
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
    bufferSeconds += segments[segments.length - 1].estSeconds;
  }

  return { generatedAt: new Date(nowMs).toISOString(), segments, bufferSeconds };
}
