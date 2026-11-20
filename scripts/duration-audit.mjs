// ============================================================================
// DURATION AUDIT — do the MP3s the station serves actually run as long
// as their scripts say they should?
//
//   node scripts/duration-audit.mjs [--base https://kc-tech-radio.vercel.app]
//                                   [--full 30] [--summ 10] [--timeout 60]
//
// Written for the Nov 19 field failure: the player began skipping
// again with zero movement on the Playback health counters, which
// means segments were ending through the natural 'ended' path. One
// way that happens honestly is a served MP3 that is SHORTER than its
// script (a truncated or partial render reads as a finished story).
// This audit pulls the live playlist, samples full-depth stories
// (the long 60-90s renders) plus summarized stories for contrast,
// downloads each MP3 in full, and measures its REAL duration with
// ffprobe, comparing three numbers per segment:
//   estSeconds        the queue's word-count estimate (136 wpm)
//   X-Audio-Duration  the server's own byte-size duration header
//   ffprobe           ground truth from the decoded file
// A segment is "materially short" when ffprobe/estSeconds < 0.85.
// ============================================================================

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = opt('base', 'https://kc-tech-radio.vercel.app').replace(/\/$/, '');
const FULL_N = parseInt(opt('full', '30'), 10);
const SUMM_N = parseInt(opt('summ', '10'), 10);
const TIMEOUT_S = parseInt(opt('timeout', '60'), 10);

const FULL_DEPTH = new Set(['ai', 'tech', 'business', 'local', 'state', 'regional']);
const SUMMARIZED = new Set(['national', 'global', 'newsletter']);

const tmp = mkdtempSync(path.join(tmpdir(), 'kctr-dur-'));

async function probeDuration(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ]);
  return parseFloat(stdout.trim());
}

function pickSample(stories, n) {
  // Half the longest (the suspected failure mode is long renders),
  // half an even stride over the rest, so shortness cannot hide in
  // one length band.
  const byLen = [...stories].sort((a, b) => (b.estSeconds || 0) - (a.estSeconds || 0));
  const picked = new Map();
  const half = Math.ceil(n / 2);
  for (const s of byLen.slice(0, half)) picked.set(s.id, s);
  const rest = byLen.slice(half);
  const stride = Math.max(1, Math.floor(rest.length / Math.max(1, n - half)));
  for (let i = 0; i < rest.length && picked.size < n; i += stride) picked.set(rest[i].id, rest[i]);
  return [...picked.values()];
}

async function auditOne(seg, idx) {
  const url = new URL(seg.audioUrl, BASE);
  const t0 = Date.now();
  const rec = {
    idx,
    id: seg.id,
    category: seg.category,
    source: seg.source,
    est: seg.estSeconds || 0,
    scriptChars: (seg.script || '').length,
    words: (seg.script || '').split(/\s+/).filter(Boolean).length,
    title: seg.title,
    headline: (seg.headline || '').slice(0, 70),
  };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_S * 1000) });
    rec.status = res.status;
    rec.headerDur = parseFloat(res.headers.get('x-audio-duration-seconds') || 'NaN');
    rec.cache = res.headers.get('x-audio-cache') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    rec.bytes = buf.length;
    rec.ms = Date.now() - t0;
    if (res.status === 200 && buf.length > 0) {
      const file = path.join(tmp, `${idx}.mp3`);
      writeFileSync(file, buf);
      rec.probe = await probeDuration(file);
      rmSync(file, { force: true });
    }
  } catch (err) {
    rec.status = 0;
    rec.error = String(err?.message || err);
    rec.ms = Date.now() - t0;
  }
  rec.ratio = rec.probe && rec.est ? rec.probe / rec.est : null;
  return rec;
}

async function main() {
  const playlist = await (await fetch(`${BASE}/api/playlist`)).json();
  const stories = (playlist.segments || []).filter((s) => s.kind === 'story' && s.audioUrl);
  const fullPool = stories.filter((s) => FULL_DEPTH.has(s.category));
  const summPool = stories.filter((s) => SUMMARIZED.has(s.category));
  const sample = [
    ...pickSample(fullPool, FULL_N).map((s) => ({ ...s, group: 'full' })),
    ...pickSample(summPool, SUMM_N).map((s) => ({ ...s, group: 'summ' })),
  ];
  console.log(
    `Playlist: ${stories.length} stories (${fullPool.length} full-depth, ${summPool.length} summarized). ` +
      `Auditing ${sample.length} segments against ${BASE} ...`
  );

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < sample.length) {
      const i = cursor++;
      const rec = await auditOne(sample[i], i);
      rec.group = sample[i].group;
      results.push(rec);
      const r = rec.ratio != null ? rec.ratio.toFixed(2) : '  ? ';
      console.log(
        `  [${rec.group}] ${rec.category.padEnd(9)} est=${String(rec.est).padStart(3)}s ` +
          `probe=${rec.probe ? rec.probe.toFixed(1).padStart(6) : '  FAIL'} ratio=${r} ` +
          `hdr=${Number.isFinite(rec.headerDur) ? rec.headerDur.toFixed(1) : '?'} ` +
          `${rec.status} ${rec.ms}ms ${rec.cache} :: ${rec.headline}`
      );
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  results.sort((a, b) => (a.ratio ?? 9) - (b.ratio ?? 9));

  const ok = results.filter((r) => r.ratio != null);
  const failed = results.filter((r) => r.ratio == null);
  const short = ok.filter((r) => r.ratio < 0.85);
  const veryShort = ok.filter((r) => r.ratio < 0.5);
  const long = ok.filter((r) => r.ratio > 1.15);
  console.log('\n==== SUMMARY ====');
  console.log(`measured=${ok.length} failed=${failed.length} materially-short(<0.85)=${short.length} very-short(<0.5)=${veryShort.length} long(>1.15)=${long.length}`);
  for (const g of ['full', 'summ']) {
    const gs = ok.filter((r) => r.group === g);
    const gshort = gs.filter((r) => r.ratio < 0.85);
    const ratios = gs.map((r) => r.ratio).sort((a, b) => a - b);
    const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
    console.log(
      `  ${g}: n=${gs.length} short=${gshort.length} median ratio=${median.toFixed(3)} ` +
        `min=${ratios[0]?.toFixed(3)} max=${ratios[ratios.length - 1]?.toFixed(3)}`
    );
  }
  if (short.length) {
    console.log('SHORT SEGMENTS:');
    for (const r of short) {
      console.log(
        `  ${r.category} est=${r.est}s probe=${r.probe.toFixed(1)}s ratio=${r.ratio.toFixed(2)} src=${r.source} :: ${r.headline}`
      );
    }
  }
  if (failed.length) {
    console.log('FAILURES:');
    for (const r of failed) console.log(`  ${r.category} est=${r.est}s status=${r.status} ${r.error || ''} :: ${r.headline}`);
  }
  // Header vs probe agreement: if the server's own byte math matches
  // ffprobe everywhere, the served bytes are self-consistent and any
  // shortness was baked in at render time, not cut in transit.
  const hdrDiffs = ok
    .filter((r) => Number.isFinite(r.headerDur))
    .map((r) => Math.abs(r.headerDur - r.probe));
  if (hdrDiffs.length) {
    console.log(
      `header-vs-probe: max abs diff=${Math.max(...hdrDiffs).toFixed(2)}s over ${hdrDiffs.length} segments`
    );
  }
  console.log(JSON.stringify({ measured: ok.length, failed: failed.length, short: short.length, veryShort: veryShort.length }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => rmSync(tmp, { recursive: true, force: true }));
