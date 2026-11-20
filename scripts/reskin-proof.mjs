#!/usr/bin/env node
// RESKIN PROOF (local only): renamed blocks + station ID rotation.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register('./extensionless-loader.mjs', import.meta.url);
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const server = createServer(async (req, res) => {
  const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
  if (!/^[a-z0-9._-]+$/i.test(name)) { res.writeHead(404).end('not found'); return; }
  try {
    const body = await readFile(join(DATA_DIR, name));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.MUSIC_FEED_URL = `${base}/music-feed.json`;
process.env.NEWSLETTER_FEED_URL = `${base}/newsletter-feed.json`;
process.env.SOCIAL_FEED_URL = `${base}/social-feed.json`;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures += 1; };

try {
  const { getNewsPool } = await import('../lib/ingest.js');
  const { getSocialItems } = await import('../lib/social.js');
  const { buildPlaylist } = await import('../lib/format.js');
  const { STATION_IDS } = await import('../lib/gonzo.js');
  const pool = await getNewsPool();
  const social = await getSocialItems().catch(() => []);
  const weather = { tempF: 52, condition: 'clear skies', windMph: 9 };
  // Build several queues at different buckets: rotation must hold in each.
  for (const offsetMin of [0, 31, 62, 97]) {
    const q = buildPlaylist(pool, weather, Date.now() + offsetMin * 60000, social);
    const ids = q.segments.filter((s) => s.kind === 'station-id').map((s) => s.script);
    const noBackToBack = ids.every((v, i) => i === 0 || v !== ids[i - 1]);
    check(`queue +${offsetMin}m: ${ids.length} station IDs, none back-to-back`, ids.length >= 3 && noBackToBack);
    check(`queue +${offsetMin}m: all IDs from the new pool`, ids.every((v) => STATION_IDS.includes(v)));
    if (offsetMin === 0) {
      const titles = new Set(q.segments.map((s) => s.title));
      check('music block renamed: The Wasteland Jukebox', titles.has('The Wasteland Jukebox'));
      check('weather block renamed: Surface Conditions', titles.has('Surface Conditions'));
      check('desk block renamed: Dispatches from the Bunker', titles.has('Dispatches from the Bunker'));
      const callers = q.segments.filter((s) => s.kind === 'caller');
      console.log(`callers in queue: ${callers.length}` + (callers.length ? ` (title: ${callers[0].title})` : ''));
      if (callers.length) check('caller block renamed: Voices on the Wire', callers[0].title === 'Voices on the Wire');
      const wx = q.segments.find((s) => s.kind === 'weather');
      check('weather script leads with Surface conditions', !!wx && /^Surface conditions in Kansas City:/.test(wx.script));
      const desk = q.segments.find((s) => s.kind === 'producers-desk');
      if (desk) check('desk script speaks from the Bunker', /Bunker/.test(desk.script));
      const musicIntro = q.segments.find((s) => s.blockKey === 'kc-music' && s.kind === 'intro');
      if (musicIntro) check('music open names the Wasteland Jukebox', /Wasteland Jukebox/.test(musicIntro.script));
      console.log('sample station ID:', ids[0]);
      const jingles = q.segments.filter((s) => s.kind === 'jingle');
      const jingleFiles = jingles.map((s) => s.audioUrl);
      check(`jingles present (${jingles.length}), static audio, rotated`,
        jingles.length >= 3 &&
        jingleFiles.every((f) => /^\/jingles\/jingle-\d\.mp3$/.test(f)) &&
        jingleFiles.every((v, i) => i === 0 || v !== jingleFiles[i - 1]));
      const musicIdx = q.segments.findIndex((s) => s.blockKey === 'kc-music' && s.kind === 'intro');
      check('a jingle opens the Wasteland Jukebox',
        musicIdx > 0 && q.segments[musicIdx - 1].kind === 'jingle');
    }
  }
} finally {
  server.close();
}
console.log(failures ? `\nPROOF FAILED (${failures})` : '\nPROOF PASSED');
process.exitCode = failures ? 1 : 0;
