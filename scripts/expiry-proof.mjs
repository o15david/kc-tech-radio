#!/usr/bin/env node
// EXPIRY PROOF (local only): time-bound story expiry, unit + pipeline.
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
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

try {
  const { isStoryExpired, referencedEventDate } = await import('../lib/format.js');
  const TODAY = '2026-11-20';
  const ts = (d) => Date.parse(`${d}T12:00:00Z`);

  // The real offenders, as the pool carries them.
  check('Defender voter guide (pub Oct 22, election Nov 3) expired',
    isStoryExpired({ title: 'The People’s Ballot: Kansas City’s Voter Guide for November Elections', summary: "The Kansas City Defender's voter guide breaks down every measure and race on your November 3 ballot in plain language, from Prop A to Amendment 3 to COMBAT.", publishedAt: ts('2026-10-22') }, TODAY) === true);
  check('Defender Prop A advocacy (pub Oct 15, vote by Nov. 3) expired',
    isStoryExpired({ title: 'Why a Daughter of Kansas City Is Voting NO on Prop A', summary: "what Prop A does, and how to vote by Nov. 3.", publishedAt: ts('2026-10-15') }, TODAY) === true);
  check('Flatland "Election Day is finally here" (pub Nov 2) expired',
    isStoryExpired({ title: 'Nick’s Picks | Senate, Pollsters, Data Centers and More …', summary: "Election Day is finally here after another onslaught of campaign ads", publishedAt: ts('2026-11-02') }, TODAY) === true);

  // Controls: legitimate coverage that must survive.
  check('Post-election analysis survives',
    isStoryExpired({ title: 'The Latino vote and the community work that changed the electoral map in Kansas', summary: 'After the Nov. 3 election, Kansas was left with a rare political setup', publishedAt: ts('2026-11-19') }, TODAY) === false);
  check('Redistricting follow-up survives',
    isStoryExpired({ title: 'Missouri Republicans weigh another redistricting fight after voters reject GOP map', summary: 'Missouri voters rejected a Republican-drawn congressional map earlier this month.', publishedAt: ts('2026-11-19') }, TODAY) === false);
  check('Hall of Fame ballot (sports) survives',
    isStoryExpired({ title: 'Royals closers Davis, Soria debut on 2027 Hall of Fame ballot', summary: '', publishedAt: ts('2026-11-16') }, TODAY) === false);
  check('Future voter guide survives (Dec 16 hearing guide, pub today)',
    isStoryExpired({ title: 'Voter Guide: What to Know for the December 16 Election', summary: 'Our voter guide to the December 16 ballot.', publishedAt: ts('2026-11-20') }, TODAY) === false);
  check('Tonight title published today survives',
    isStoryExpired({ title: 'Chiefs Face the Broncos Tonight at Arrowhead', summary: '', publishedAt: ts('2026-11-20') }, TODAY) === false);
  check('Tonight title published 3 days ago expired',
    isStoryExpired({ title: 'Chiefs Face the Broncos Tonight at Arrowhead', summary: '', publishedAt: ts('2026-11-17') }, TODAY) === true);
  check('referencedEventDate picks Nov 3 for the Defender guide',
    referencedEventDate('breaks down every measure and race on your November 3 ballot', ts('2026-10-22')) === '2026-11-03');

  // Pipeline: build the real queue and confirm the offenders are gone.
  const { getNewsPool } = await import('../lib/ingest.js');
  const { buildPlaylist } = await import('../lib/format.js');
  const pool = await getNewsPool();
  const queue = buildPlaylist(pool, null, Date.now());
  const headlines = queue.segments.filter((s) => s.kind === 'story').map((s) => s.headline || '');
  console.log(`\nqueue: ${headlines.length} stories, expiredStories = ${queue.expiredStories}`);
  check('expiredStories >= 2 (the two Defender items; feed rotation varies the rest)', queue.expiredStories >= 2);
  check('Defender ballot guide not in queue', !headlines.some((h) => /People’s Ballot/.test(h)));
  check('Prop A advocacy not in queue', !headlines.some((h) => /Voting NO on Prop A/.test(h)));
  check('No "Election Day is finally here" segment script',
    !queue.segments.some((s) => /Election Day is finally here/.test(s.script || '')));

  // Age cap acceptance test (David's condition: "as long as it filters
  // out stale items"): no story in the built queue may be older than
  // 72 hours, and the drop count must be visible on the response.
  const byLink = new Map(pool.items.map((i) => [i.link, i]));
  const nowMs = Date.now();
  let tooOld = 0;
  let undated = 0;
  for (const s of queue.segments) {
    if (s.kind !== 'story') continue;
    const it = byLink.get(s.link);
    if (!it || !it.publishedAt) { undated += 1; continue; }
    if (nowMs - it.publishedAt > 72 * 3600000) tooOld += 1;
  }
  console.log(`age cap: ageCappedStories = ${queue.ageCappedStories}, queued stories older than 72h = ${tooOld}, undated queued = ${undated}`);
  check('ageCappedStories is reported (not undefined)', typeof queue.ageCappedStories === 'number');
  check('No queued story older than 72 hours', tooOld === 0);
} finally {
  server.close();
}
console.log(failures ? `\nPROOF FAILED (${failures})` : '\nPROOF PASSED');
process.exitCode = failures ? 1 : 0;
