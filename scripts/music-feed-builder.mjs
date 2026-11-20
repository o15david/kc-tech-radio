#!/usr/bin/env node
// ===========================================================================
// MUSIC FEED BUILDER — builds data/music-feed.json from David's maintained
// KC show data, in the contract lib/ingest.js consumes for the music
// category (see README section 9, "Music feed").
//
//   node scripts/music-feed-builder.mjs [--out data/music-feed.json]
//                                       [--today YYYY-MM-DD]
//
// Sources (both maintained OUTSIDE this repo; this script only converts):
//   1. KC Upcoming Shows snapshot: the newest space_*.json / existing_*.json
//      export in ~/workspace/kc-venue-playlist/ (picked by its own
//      lastUpdated field). That pipeline refreshes weekly from the nine
//      venue calendars (miniBar, recordBar, Warehouse on Broadway, The
//      Truman, Knuckleheads, Howdy, Farewell, The RINO, Uptown Theater)
//      and ALREADY applies David's venue-primary rule (Nov 12, 2026):
//      when sources disagree about a show, the venue's own calendar wins.
//      This converter therefore never re-aggregates from aggregators; it
//      reads the venue-verified snapshot as-is. Shows the snapshot flags
//      as cancelled are skipped; every other show is taken with the date,
//      artist, and venue the snapshot carries.
//   2. KC jazz watch: ~/workspace/goals/kc-jazz-and-big-band-show-watch/
//      hidden_files/seen_shows.json (optional; missing means no jazz
//      picks, never an error). Venue strings there carry street
//      addresses; the feed keeps the venue NAME (text before the first
//      comma), which is the name the watch itself lists first.
//
// Classification (deterministic; "today" is the America/Chicago date):
//   tonight   shows dated today, snapshot order, cap 4
//   weekend   shows in the upcoming Fri-Sun window (excluding today),
//             date order, cap 3
//   announced shows the snapshot's latest refresh newly added
//             (calendarStatus "added"), future, outside the weekend
//             window, date order, cap 3
//   jazz      jazz-watch shows dated today or later, date order, cap 2
// A show lands in at most one kind (precedence: tonight, weekend,
// announced, jazz), deduped by artist|venue|date. Past shows (before
// today, America/Chicago) are ALWAYS excluded.
//
// NO INVENTED FACTS: the snapshot carries no show times, so none are
// written; `when` is the date in words ("tonight, Thursday, November 19"
// / "Saturday, November 21"). Jazz entries carry the watch's own time
// string verbatim when it has one. URLs are the snapshot's venue/ticket
// links, verbatim (empty string when the snapshot has none).
//
// Overrides: KCMUSIC_SHOWS_FILE, KCMUSIC_JAZZ_FILE, MUSIC_FEED_TODAY.
// ===========================================================================

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOWS_DIR =
  process.env.KCMUSIC_SHOWS_DIR || join(REPO, '..', 'kc-venue-playlist');
const JAZZ_FILE =
  process.env.KCMUSIC_JAZZ_FILE ||
  join(
    REPO,
    '..',
    'goals',
    'kc-jazz-and-big-band-show-watch',
    'hidden_files',
    'seen_shows.json'
  );

const CAPS = { tonight: 4, announced: 3, weekend: 3, jazz: 2 };

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const outPath = argValue('--out') || join(REPO, 'data', 'music-feed.json');

// ---- dates (America/Chicago) ----------------------------------------------
function chicagoToday() {
  // en-CA yields YYYY-MM-DD; timeZone pins it to Kansas City's calendar.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const today = argValue('--today') || process.env.MUSIC_FEED_TODAY || chicagoToday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error(`music-feed-builder: bad --today "${today}" (want YYYY-MM-DD)`);
  process.exit(1);
}

// Parse a YYYY-MM-DD calendar date at UTC noon so weekday/month names are
// timezone-proof, and do calendar arithmetic in whole days.
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayNameFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const weekdayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'short',
});
function dateInWords(dateStr) {
  return dayNameFmt.format(parseDate(dateStr)); // "Thursday, November 19"
}

// The upcoming weekend window: the Friday/Saturday/Sunday that end the
// current week (if today is Fri/Sat/Sun, that same weekend; its past
// days simply match no future shows). Returns a Set of YYYY-MM-DD.
function weekendDates(todayStr) {
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    weekdayFmt.format(parseDate(todayStr))
  ); // 0=Sun .. 6=Sat
  // Days until the Sunday that closes this weekend (today if Sunday).
  const untilSunday = (7 - dow) % 7;
  const sunday = addDays(todayStr, untilSunday);
  return new Set([addDays(sunday, -2), addDays(sunday, -1), sunday]);
}

// ---- source 1: KC Upcoming Shows snapshot -----------------------------------
function pickShowsFile() {
  if (process.env.KCMUSIC_SHOWS_FILE) return process.env.KCMUSIC_SHOWS_FILE;
  const candidates = readdirSync(SHOWS_DIR).filter((f) =>
    /^(space|existing)_\d{8}\.json$/.test(f)
  );
  if (!candidates.length) {
    throw new Error(`no space_*.json / existing_*.json snapshot in ${SHOWS_DIR}`);
  }
  let best = null;
  for (const f of candidates) {
    const doc = JSON.parse(readFileSync(join(SHOWS_DIR, f), 'utf8'));
    const stamp = doc.lastUpdated || f.match(/(\d{8})/)[1];
    if (!best || stamp > best.stamp) best = { file: join(SHOWS_DIR, f), stamp, doc };
  }
  return best.file;
}

const showsPath = pickShowsFile();
const showsDoc = JSON.parse(readFileSync(showsPath, 'utf8'));
const shows = Array.isArray(showsDoc.shows) ? showsDoc.shows : [];

// ---- classify ----------------------------------------------------------------
const weekend = weekendDates(today);
const items = [];
const seen = new Set();
const pushItem = (kind, artist, venue, when, url, date) => {
  const key = `${artist}|${venue}|${when}`;
  if (seen.has(key)) return false;
  seen.add(key);
  // `date` (YYYY-MM-DD, the show's calendar date) rides along so the
  // queue builder can enforce David's rule (Nov 20, 2026) at queue-build
  // time: dated events air only when current or future, regardless of
  // how old this feed file is when the queue is built.
  items.push({ kind, artist, venue, when, url: url || '', date });
  return true;
};
const usable = (s) =>
  s &&
  s.headliner &&
  s.venue &&
  /^\d{4}-\d{2}-\d{2}$/.test(s.date || '') &&
  s.date >= today &&
  !/cancel/i.test(s.calendarStatus || '');

const byDate = (a, b) => a.date.localeCompare(b.date);

// tonight: snapshot order (the snapshot is date-ordered, venue-grouped).
let n = 0;
for (const s of shows) {
  if (n >= CAPS.tonight) break;
  if (usable(s) && s.date === today) {
    if (pushItem('tonight', s.headliner, s.venue, `tonight, ${dateInWords(s.date)}`, s.url, s.date)) n++;
  }
}
// weekend: upcoming Fri-Sun window, excluding today, date order.
n = 0;
for (const s of [...shows].sort(byDate)) {
  if (n >= CAPS.weekend) break;
  if (usable(s) && s.date !== today && weekend.has(s.date)) {
    if (pushItem('weekend', s.headliner, s.venue, dateInWords(s.date), s.url, s.date)) n++;
  }
}
// announced: newly added by the snapshot's latest refresh, beyond the
// weekend window, date order.
n = 0;
for (const s of [...shows].sort(byDate)) {
  if (n >= CAPS.announced) break;
  if (usable(s) && s.date !== today && !weekend.has(s.date) && s.calendarStatus === 'added') {
    if (pushItem('announced', s.headliner, s.venue, dateInWords(s.date), s.url, s.date)) n++;
  }
}

// ---- source 2: KC jazz watch (optional) ---------------------------------------
let jazzNote = 'jazz watch not read';
try {
  const jazzDoc = JSON.parse(readFileSync(JAZZ_FILE, 'utf8'));
  const jazzShows = (Array.isArray(jazzDoc.shows) ? jazzDoc.shows : [])
    .filter((s) => s && s.band && s.venue && /^\d{4}-\d{2}-\d{2}$/.test(s.date || '') && s.date >= today)
    .sort(byDate);
  n = 0;
  for (const s of jazzShows) {
    if (n >= CAPS.jazz) break;
    const venueName = String(s.venue).split(',')[0].trim();
    const base = s.date === today ? `tonight, ${dateInWords(s.date)}` : dateInWords(s.date);
    const when = s.time ? `${base}, ${s.time}` : base;
    if (pushItem('jazz', s.band, venueName, when, s.url, s.date)) n++;
  }
  jazzNote = `jazz watch: ${jazzShows.length} upcoming shows`;
} catch (err) {
  jazzNote = `jazz watch unavailable (${err.message}); jazz picks omitted`;
}

// ---- write ---------------------------------------------------------------------
const feed = {
  generatedAt: new Date().toISOString(),
  source:
    `KC Upcoming Shows snapshot ${basename(showsPath)} (nine venue calendars, ` +
    `venue-primary per David's rule) + KC jazz watch seen_shows.json; ` +
    `converted by scripts/music-feed-builder.mjs`,
  items,
};
writeFileSync(outPath, JSON.stringify(feed) + '\n');

const byKind = {};
for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
console.log(`music-feed-builder: today (America/Chicago) = ${today}`);
console.log(`  shows source: ${showsPath} (lastUpdated ${showsDoc.lastUpdated || 'n/a'}, ${shows.length} shows)`);
console.log(`  ${jazzNote}`);
console.log(`  wrote ${items.length} items to ${outPath}: ${JSON.stringify(byKind)}`);
for (const it of items) console.log(`    [${it.kind}] ${it.artist} at ${it.venue}, ${it.when}`);
