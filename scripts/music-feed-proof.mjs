#!/usr/bin/env node
// ===========================================================================
// MUSIC FEED PROOF — proves the KC Music Scene feed airs, end to end with
// the station's own code, without touching production.
//
//   node scripts/music-feed-proof.mjs
//
// Serves this repo's data/ folder over a throwaway local HTTP server,
// points MUSIC_FEED_URL (and NEWSLETTER_FEED_URL, so no production feed
// is consulted for either JSON source) at it, then runs the REAL
// pipeline: lib/ingest.js getNewsPool() -> countByCategory() ->
// lib/format.js buildPlaylist(). Prints the music category count, the
// full Kansas City Music Scene section (intro + listings) exactly as
// scripted for the queue, and where the section lands in the queue.
//
// The RSS wire is fetched live as usual; if it is unreachable the pool
// is smaller but the music assertions still run against whatever pool
// ingestion returns (the music feed itself is local and deterministic).
// ===========================================================================

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register('./extensionless-loader.mjs', import.meta.url);

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

const server = createServer(async (req, res) => {
  const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(join(DATA_DIR, name));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.MUSIC_FEED_URL = `${base}/music-feed.json`;
process.env.NEWSLETTER_FEED_URL = `${base}/newsletter-feed.json`;

try {
  const { getNewsPool, countByCategory } = await import('../lib/ingest.js');
  const { buildPlaylist } = await import('../lib/format.js');

  const pool = await getNewsPool();
  const counts = countByCategory(pool);
  const musicItems = pool.items.filter((i) => i.category === 'music');
  console.log(`pool: ${pool.items.length} items; music category count = ${counts.music}`);
  for (const it of musicItems) {
    console.log(`  [${it.musicKind}] ${it.title} — ${it.when}`);
  }
  if (counts.music <= 0) {
    console.error('PROOF FAILED: music category count is 0');
    process.exitCode = 1;
  } else {
    const queue = buildPlaylist(pool, null);
    const musicSegs = queue.segments.filter((s) => s.blockKey === 'kc-music');
    const firstMusicIdx = queue.segments.findIndex((s) => s.blockKey === 'kc-music');
    console.log(
      `\nqueue: ${queue.segments.length} segments, ${Math.round(queue.queueSeconds / 60)} min; ` +
        `music section = ${musicSegs.length} segments starting at segment #${firstMusicIdx + 1}`
    );
    if (!musicSegs.length) {
      console.error('PROOF FAILED: no Kansas City Music Scene section in the built queue');
      process.exitCode = 1;
    } else {
      console.log('\n--- Kansas City Music Scene section, as scripted ---');
      for (const s of musicSegs) console.log(`[${s.kind}] ${s.script}`);
    }
  }
} finally {
  server.close();
}
console.log(process.exitCode ? '\nPROOF FAILED' : '\nPROOF PASSED');
