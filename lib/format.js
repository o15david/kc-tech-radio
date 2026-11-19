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
//   :33  TECH HEADLINES           (newsletter items are the secondary pool)
//   :37  KC MUSIC SCENE         tonight's shows, announcements, weekend
//                               picks, jazz picks (music feed; silent when
//                               the feed is empty)
//   :45  BUSINESS HEADLINES
//   :50  THE PRODUCER'S DESK    fixed-copy gonzo bit (lib/gonzo.js)
//   :53  KC LOCAL ENCORE        more local (falls back to AI/tech overflow)
//   :57  STATION ID + tease for top-of-hour global news
//
// Headline selection is deterministic too: a per-category cursor derived
// from the absolute block-instance number (hours since epoch * blocks +
// block index), so repeated /api/playlist calls inside the same window
// return the same queue, and the queue advances as the clock advances.
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
  GLOBAL_FRAMING,
  TRANSITIONS,
  STATION_IDS,
  PRODUCERS_DESK,
  SIGN_OFFS,
  MUSIC_LEADS,
} from './gonzo';
import { voiceForSegment } from './voices';
import { audioUrlFor } from './tts';

export const TIME_ZONE = 'America/Chicago';
// Speech rate assumption for duration estimates. The Edge neural voices at
// their default rate speak roughly 150-160 wpm, as does browser
// speechSynthesis at rate 1.0 (the fallback path).
export const WORDS_PER_MINUTE = 155;
// The playlist endpoint always returns at least this much audio ahead.
export const TARGET_BUFFER_SECONDS = 12 * 60;

export const FORMAT_CLOCK = [
  { startMinute: 0, key: 'global-news', kind: 'show', category: 'global', title: 'World News at the Top of the Hour', stories: 4 },
  { startMinute: 8, key: 'kc-local', kind: 'show', category: 'local', title: 'Kansas City Tech & Business Report', stories: 4 },
  { startMinute: 20, key: 'ai-news', kind: 'show', category: 'ai', title: 'The AI Report', stories: 4, alsoFrom: ['newsletter'] },
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

/** Deterministic pool pick: hash of the segment id into the pool, so the
 *  same segment always gets the same line (cache-friendly, stable hours). */
function pickFromPool(pool, segmentId) {
  return pool[hashString(segmentId) % pool.length];
}

// Show opens come from the gonzo style pools (lib/gonzo.js). The global
// block keeps its NPR structure: a framing line, then the factual time and
// date, then the headlines.
function showIntro(blockKey, segmentId, date) {
  if (blockKey === 'global-news') {
    const framing = pickFromPool(GLOBAL_FRAMING, segmentId);
    return `${framing} It is ${spokenTime(date)} Central Time, ${spokenDate(date)}. Here are the global headlines.`;
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

// Category fallback order when a pool runs dry: never let a block go silent.
// Newsletter items ride last in the general fallback and second in the AI
// and Tech blocks (see alsoFrom on the format clock): they are an
// additional wire, not a block of their own. Music is NOT here: music
// items are listings, not stories, and only the music block reads them.
const FALLBACK_ORDER = ['local', 'ai', 'tech', 'business', 'global', 'newsletter'];

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
 *                   script, estSeconds, voice, audioUrl }
 *   `voice`/`audioUrl` point at the pre-rendered Edge TTS MP3 for the
 *   segment (see lib/voices.js and lib/tts.js); the player falls back to
 *   browser speechSynthesis only if that MP3 fails.
 */
export function buildPlaylist(pool, weather, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const parts = chicagoParts(now);
  const minute = parseInt(parts.minute, 10);
  const startBlockIdx = blockIndexForMinute(minute);

  const segments = [];
  const usedItemIds = new Set();
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

  function pickItem(order, cursorSeed) {
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
      const id = `seg-${instance}-${block.key}`;
      const script = stationIdScript(block.key, id, blockDate, weather);
      segments.push(withAudio({
        id,
        kind: 'station-id',
        blockKey: block.key,
        category: 'station',
        title: block.title,
        headline: 'KC Tech Radio',
        source: 'KC Tech Radio',
        script,
        estSeconds: estimateSeconds(script),
      }));
      bufferSeconds += segments[segments.length - 1].estSeconds;
      continue;
    }

    if (block.kind === 'producers-desk') {
      // Fixed-copy gonzo bit from lib/gonzo.js; no news content, ever.
      const id = `seg-${instance}-${block.key}`;
      const script = producersDeskScript(id);
      segments.push(withAudio({
        id,
        kind: 'producers-desk',
        blockKey: block.key,
        category: 'station',
        title: block.title,
        headline: block.title,
        source: 'KC Tech Radio',
        script,
        estSeconds: estimateSeconds(script),
      }));
      bufferSeconds += segments[segments.length - 1].estSeconds;
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
        segments.push(withAudio({
          id: introId,
          kind: 'intro',
          blockKey: block.key,
          category: 'music',
          title: block.title,
          headline: block.title,
          source: 'KC Tech Radio',
          script: intro,
          estSeconds: estimateSeconds(intro),
        }));
        bufferSeconds += segments[segments.length - 1].estSeconds;

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
          segments.push(withAudio(seg));
          bufferSeconds += seg.estSeconds;
        });
      }
      continue;
    }

    const introId = `seg-${instance}-${block.key}-intro`;
    const intro = showIntro(block.key, introId, blockDate);
    segments.push(withAudio({
      id: introId,
      kind: 'intro',
      blockKey: block.key,
      category: block.category,
      title: block.title,
      headline: block.title,
      source: 'KC Tech Radio',
      script: intro,
      estSeconds: estimateSeconds(intro),
    }));
    bufferSeconds += segments[segments.length - 1].estSeconds;

    // Draw order for this block: its own category, any alsoFrom pools
    // (e.g. newsletters in the AI/Tech blocks), then the general fallback.
    // In alsoFrom blocks, odd-numbered story slots lead with the alsoFrom
    // pools instead, so the secondary wire (newsletters) is guaranteed
    // airtime rather than only surfacing when the primary pool runs dry.
    // pickItem still walks the full order, so an empty secondary pool
    // silently falls back to the primary category. Fully deterministic:
    // the slot pattern depends only on the block definition.
    const drawOrder = [
      ...new Set([block.category, ...(block.alsoFrom || []), ...FALLBACK_ORDER]),
    ];
    const altDrawOrder = block.alsoFrom?.length
      ? [...new Set([...block.alsoFrom, block.category, ...FALLBACK_ORDER])]
      : drawOrder;

    for (let s = 0; s < block.stories; s++) {
      const item = pickItem(s % 2 === 1 ? altDrawOrder : drawOrder, instance * 31 + s * 7);
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
      segments.push(withAudio(seg));
      bufferSeconds += seg.estSeconds;
    }
  }

  // Total wire failure (or first cold start): never return an empty queue.
  if (!segments.some((s) => s.kind === 'story')) {
    segments.push(withAudio({
      id: `seg-filler-${absHour}`,
      kind: 'filler',
      blockKey: 'filler',
      category: 'station',
      title: 'Station Note',
      headline: 'KC Tech Radio',
      source: 'KC Tech Radio',
      script: FILLER_SCRIPT,
      estSeconds: estimateSeconds(FILLER_SCRIPT),
    }));
    bufferSeconds += segments[segments.length - 1].estSeconds;
  }

  return { generatedAt: new Date(nowMs).toISOString(), segments, bufferSeconds };
}
