#!/usr/bin/env node
// ===========================================================================
// PERFORMANCES FEED BUILDER — builds data/performances-feed.json from the
// KC Performances Space's data, in the contract lib/ingest.js consumes
// for the performance category (The Marquee rundown).
//
//   node scripts/performances-feed-builder.mjs [--snapshot <path>]
//                                              [--out data/performances-feed.json]
//                                              [--today YYYY-MM-DD]
//
// Source: ~/workspace/kc-performances/space_latest.json, a saved copy of
// the KC Performances Space's getdata output. That Space harvests the
// twelve venue calendars weekly and ALREADY applies David's
// venue-primary rule (Nov 12, 2026): when sources disagree, the venue's
// own calendar wins. This converter never re-aggregates; it reads the
// venue-verified data as-is.
//
// David's rule for this feed (Nov 24, 2026) is stricter than the music
// feed's: never stale, never expired. Enforced here, at ingest, and
// again at queue build:
//   - a performance without valid start AND end dates is dropped
//     (droppedUndated): an unverifiable date never airs;
//   - a performance whose run has ended (endDate before today,
//     America/Chicago) is dropped (droppedExpired);
//   - a performance starting more than HORIZON_DAYS out is held back
//     (droppedHorizon) until daily refreshes bring it inside the
//     window; a run already in progress is never held back.
// Kept items carry their dates through untouched, sorted soonest
// first by air date (today for a run in progress, opening night for
// one coming up).
// ===========================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HORIZON_DAYS = 75;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const snapshotPath =
  argValue('--snapshot') ||
  join(homedir(), 'workspace', 'kc-performances', 'space_latest.json');
const outPath = argValue('--out') || join(ROOT, 'data', 'performances-feed.json');

function chicagoToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const today = argValue('--today') || chicagoToday();
const horizon = new Date(`${today}T12:00:00Z`);
horizon.setUTCDate(horizon.getUTCDate() + HORIZON_DAYS);
const horizonStr = horizon.toISOString().slice(0, 10);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const raw = JSON.parse(await readFile(snapshotPath, 'utf8'));
const performances = Array.isArray(raw?.performances) ? raw.performances : [];

const items = [];
let droppedUndated = 0;
let droppedExpired = 0;
let droppedHorizon = 0;
for (const p of performances) {
  if (!p || !p.title || !p.venue) continue;
  const startDate = typeof p.startDate === 'string' ? p.startDate : '';
  const endDate = typeof p.endDate === 'string' ? p.endDate : '';
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || startDate > endDate) {
    droppedUndated += 1;
    continue;
  }
  if (endDate < today) {
    droppedExpired += 1;
    continue;
  }
  const inProgress = startDate <= today && today <= endDate;
  if (!inProgress && startDate > horizonStr) {
    droppedHorizon += 1;
    continue;
  }
  items.push({
    id: p.id ?? `${p.title}|${p.venue}|${startDate}`,
    title: String(p.title),
    venue: String(p.venue),
    category: String(p.category || '').toLowerCase() === 'theatre' ? 'theatre' : 'comedy',
    kind: String(p.kind || ''),
    startDate,
    endDate,
    timeText: String(p.timeText || ''),
    preview: String(p.preview || ''),
    url: typeof p.url === 'string' ? p.url : '',
  });
}

const airDate = (it) =>
  it.startDate <= today && today <= it.endDate ? today : it.startDate;
items.sort(
  (a, b) => airDate(a).localeCompare(airDate(b)) || a.startDate.localeCompare(b.startDate)
);

const doc = {
  generatedAt: new Date().toISOString(),
  source:
    'KC Performances Space (twelve venue calendars, venue-primary per David\'s rule); converted by scripts/performances-feed-builder.mjs',
  items,
};
await writeFile(outPath, JSON.stringify(doc, null, 2) + '\n');
console.log(
  `performances feed: ${items.length} kept ` +
    `(theatre ${items.filter((i) => i.category === 'theatre').length}, ` +
    `comedy ${items.filter((i) => i.category === 'comedy').length}); ` +
    `dropped: ${droppedUndated} undated, ${droppedExpired} expired, ${droppedHorizon} beyond ${HORIZON_DAYS}d horizon; ` +
    `today ${today}, horizon ${horizonStr}; wrote ${outPath}`
);
