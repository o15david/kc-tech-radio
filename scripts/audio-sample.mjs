// ============================================================================
// AUDIO SAMPLE — broad sampling of the live queue's audio, locally.
//
//   node scripts/audio-sample.mjs [--port 3100] [--samples 48] [--build]
//
// Starts the production server (`next start`; run `npm run build`
// first, or pass --build), fetches /api/playlist, and requests a broad
// sample of segment audio URLs spread across the whole queue (the
// first few plus an even stride over the rest, at least 40 by
// default). Each request is a full GET; the /api/audio route returns
// 502 only after its server-side retry ladder (global limiter,
// backoff, truncated-render guard in lib/tts.js) is exhausted, so the
// bar is ZERO failures. Reports per-request status, bytes, the
// X-Audio-Duration-Seconds header, and wall time, plus a summary with
// min/median/max timings. Exits non-zero if any request fails.
// ============================================================================

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = parseInt(opt('port', '3100'), 10);
const SAMPLES = parseInt(opt('samples', '48'), 10);
const BASE = `http://127.0.0.1:${PORT}`;

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit', ...opts });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
    child.on('error', reject);
  });
}

async function waitForServer(deadlineMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > deadlineMs) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let server = null;
async function main() {
  if (args.includes('--build') || !existsSync(path.join(root, '.next', 'BUILD_ID'))) {
    console.log('Building (npm run build)...');
    await run('npm', ['run', 'build']);
  }
  console.log(`Starting production server on :${PORT}...`);
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Detached: the server gets its own process group so cleanup can
    // kill the group. Killing only the npx wrapper orphans the actual
    // next-server worker, which keeps the port (found the hard way).
    detached: true,
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer();

  const playlist = await (await fetch(`${BASE}/api/playlist`)).json();
  const segs = playlist.segments || [];
  console.log(`Queue: ${segs.length} segments, ~${Math.round((playlist.queueSeconds || 0) / 60)} min`);

  // Broad sample: the first 4 (the playhead's path) plus an even
  // stride across the rest of the queue.
  const picked = new Map();
  for (let i = 0; i < Math.min(4, segs.length); i++) picked.set(i, segs[i]);
  const stride = Math.max(1, Math.floor(segs.length / Math.max(1, SAMPLES - 4)));
  for (let i = 4; i < segs.length && picked.size < SAMPLES; i += stride) {
    picked.set(i, segs[i]);
  }
  const sample = [...picked.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`Sampling ${sample.length} audio URLs across the queue...`);

  const results = [];
  const CONCURRENCY = 4; // the server limiter caps synthesis at 3 anyway
  // Per-request ceiling: the route's own worst case is its full retry
  // ladder (3 attempts, each bounded by the TTS client's 30s connect +
  // 60s synthesis timeouts, plus backoff), roughly 280s. 300s covers
  // that with margin; anything beyond it is a hang, and the sample
  // records a failure rather than stalling the whole run forever.
  const REQUEST_TIMEOUT_MS = 300_000;
  let cursor = 0;
  async function worker() {
    while (cursor < sample.length) {
      const [idx, seg] = sample[cursor++];
      const t0 = Date.now();
      try {
        const res = await fetch(new URL(seg.audioUrl, BASE), {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const buf = await res.arrayBuffer();
        const ms = Date.now() - t0;
        const dur = res.headers.get('x-audio-duration-seconds');
        const ok = res.status === 200 && buf.byteLength > 1000;
        results.push({ idx, id: seg.id, ok, status: res.status, bytes: buf.byteLength, ms, dur });
        console.log(
          `  ${ok ? 'OK  ' : 'FAIL'} #${idx} ${seg.kind} ${res.status} ${buf.byteLength}B ` +
            `dur=${dur || '?'}s ${ms}ms ${seg.id}`
        );
      } catch (err) {
        results.push({ idx, id: seg.id, ok: false, status: 0, bytes: 0, ms: Date.now() - t0 });
        console.log(`  FAIL #${idx} ${seg.id}: ${err?.message || err}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const failed = results.filter((r) => !r.ok);
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  console.log(
    `\nSampled ${results.length}: ${results.length - failed.length} OK, ${failed.length} failed. ` +
      `Timings ms: min=${times[0] || 0} median=${median} max=${times[times.length - 1] || 0}`
  );
  if (failed.length) {
    console.log(`FAILURES: ${failed.map((f) => `#${f.idx} ${f.id} (HTTP ${f.status})`).join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('ZERO FAILURES');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        server.kill('SIGTERM');
      }
    }
  });
