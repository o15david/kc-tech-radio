#!/usr/bin/env node
/**
 * Proof for the Wasteland Jukebox music pass (Nov 20, 2026):
 * the queue's Jukebox block closes with two track segments whose
 * audio files exist in public/jukebox, whose durations match the
 * manifest, and which are not the same track twice. Every manifest
 * entry carries its Internet Archive identifier (the per-track
 * verification record lives in public/jukebox/CREDITS.md).
 */
import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);
import { existsSync, readFileSync } from 'node:fs';
const { buildPlaylist } = await import('../lib/format.js');
const manifest = JSON.parse(readFileSync(new URL('../lib/jukebox.json', import.meta.url), 'utf8'));

let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures += 1; };

check('manifest has 8 tracks', manifest.length === 8);
check('every manifest entry has an archiveId and year <= 1925', manifest.every((e) => e.archiveId && e.year <= 1925));
check('every manifest file exists under public/', manifest.every((e) => existsSync(new URL(`../public${e.file}`, import.meta.url))));

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const TOPICS = [
  ['Chip firm ships new sensor line for factories', 'Semiconductor output rose again as the plant added a second shift and new tooling.'],
  ['Riverfront warehouse converts to cold storage', 'The logistics operator signed a ten year lease and plans to hire forty drivers this fall.'],
  ['University lab wins grant for battery research', 'The chemistry team will study solid state cells with partners at two national laboratories.'],
  ['Airline adds nonstop route to the coast', 'Twice daily flights begin in March with introductory fares on the morning departure.'],
  ['Hospital system opens urgent care clinic', 'The new site adds weekend hours and an on site lab for the growing suburb nearby.'],
  ['Farm co-op tests drone scouting service', 'Growers will get weekly imagery of corn and soybean fields during the growing season.'],
  ['City council funds streetcar extension study', 'Engineers will model three corridors and report back to the council next summer.'],
  ['Brewery expands taproom and canning line', 'The owners expect to double production and add a patio facing the rail yard.'],
  ['School district pilots later start times', 'High schools in the pilot will begin classes forty five minutes later next semester.'],
  ['Port authority dredges shipping channel', 'The deeper channel lets larger barges reach the terminal during low water months.'],
  ['Insurer launches cyber policy for small firms', 'The product bundles monitoring with incident response for companies under fifty staff.'],
  ['Railroad restores vintage depot as offices', 'The renovation keeps the original brick and adds a public hall for community events.'],
  ['Wind farm reaches full capacity output', 'The forty turbine site now supplies power to roughly thirty thousand homes nearby.'],
  ['Library system digitizes photo archives', 'Volunteers scanned ten thousand images documenting the region across the last century.'],
];
const story = (n) => ({
  id: `s${n}`, category: 'tech', source: 'Wire',
  title: TOPICS[n - 1][0],
  summary: TOPICS[n - 1][1],
  link: `https://example.com/s${n}`, publishedAt: Date.now() - n * 60000,
  body: 'The announcement drew a crowd of engineers, founders, and city staff to a downtown hall on Tuesday morning. Speakers walked through the roadmap in detail, pointing to hiring plans, new office space, and a timeline that stretches into next year. Local suppliers said the work would ripple through machine shops, logistics firms, and software teams across the metro area.',
});
const listing = (n) => ({
  id: `m${n}`, category: 'music', source: 'Venue',
  title: `Show ${n}`, artist: `Band ${n}`, venue: 'miniBar', when: 'Tonight at 8 PM',
  eventDate: today, musicKind: 'tonight', link: 'https://example.com/show',
});
const items = [...Array.from({ length: 14 }, (_, i) => story(i + 1)), listing(1), listing(2), listing(3)];
const q = buildPlaylist({ items }, null, Date.now(), []);
const tracks = q.segments.filter((s) => s.kind === 'track');
console.log('track segments:', tracks.map((t) => `${t.headline} [${t.audioUrl}, ${t.estSeconds}s]`).join(' | '));
// Updated Nov 21, 2026: the queue no longer carries exactly one
// two-track block. David's burn-rate lever added Jukebox blocks
// through the queue and thin-bucket padding, and his hourly
// exception repeats the shows rundown (with its closing tracks) up
// to once an hour. What must still hold: at least one block, every
// track from the manifest, and no track ever repeated back to back
// (the rotation cursor guarantees it).
check('at least 2 track segments in the queue', tracks.length >= 2);
check('no track repeats back to back', tracks.every((t, i) => i === 0 || t.audioUrl !== tracks[i - 1].audioUrl));
check('track audioUrls come from the manifest', tracks.every((t) => manifest.some((e) => e.file === t.audioUrl)));
check('track estSeconds match the manifest', tracks.every((t) => manifest.find((e) => e.file === t.audioUrl)?.seconds === t.estSeconds));
const musicIdx = q.segments.findIndex((s) => s.kind === 'music');
const trackIdx = q.segments.findIndex((s) => s.kind === 'track');
check('tracks sit inside the Jukebox block (after the rundown)', musicIdx >= 0 && trackIdx > musicIdx);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
