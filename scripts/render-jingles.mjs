#!/usr/bin/env node
// RENDER JINGLES (Route 1): half-chanted spoken IDs over a verified
// public-domain music bed, mixed into finished MP3s.
//
// Bed: "Tiger Rag", Original Dixieland Jass Band, Victor 18472 (1918).
// Public domain; source file from Wikimedia Commons
// (File:Tiger Rag ODJB.ogg, LicenseShortName: Public domain).
// The excerpt lives at public/jingles/bed-tiger-rag.mp3; pass the full
// OGG path as argv[2] to rebuild the excerpt from the original.
//
// Voice: the station's story voice (en-US-ChristopherNeural) via the
// same Edge TTS path as production (lib/tts.js getSegmentMp3).
//
// Output: public/jingles/jingle-N.mp3 + lib/jingles.json manifest
// [{ file, script, seconds }]. Re-run whenever lib/gonzo.js JINGLES
// changes; commit the MP3s and the manifest together.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register('./extensionless-loader.mjs', import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'jingles');
const WORK = '/tmp/jingle-work';
const VOICE = 'en-US-ChristopherNeural';
const BED_SECONDS = 16;

function probeSeconds(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]).toString().trim();
  return Math.round(parseFloat(out) * 10) / 10;
}

const { JINGLES } = await import('../lib/gonzo.js');
const { getSegmentMp3 } = await import('../lib/tts.js');
await mkdir(OUT_DIR, { recursive: true });
await mkdir(WORK, { recursive: true });

// 1. The bed excerpt (rebuilt only when the original OGG is passed in).
const bedPath = join(OUT_DIR, 'bed-tiger-rag.mp3');
if (process.argv[2]) {
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-ss', '4', '-t', String(BED_SECONDS), '-i', process.argv[2],
    '-af', 'afade=t=in:st=0:d=0.3,afade=t=out:st=15:d=1,volume=0.9',
    '-ar', '24000', '-ac', '1', '-b:a', '96k', bedPath,
  ]);
  console.log(`bed excerpt rebuilt: ${probeSeconds(bedPath)}s`);
}

// 2. Each chant: voice over the bed, bed ducked low, short tail.
const manifest = [];
for (let i = 0; i < JINGLES.length; i++) {
  const script = JINGLES[i];
  const { mp3: voiceMp3 } = await getSegmentMp3(VOICE, script);
  const voicePath = join(WORK, `voice-${i + 1}.mp3`);
  await writeFile(voicePath, voiceMp3);
  const voiceSecs = probeSeconds(voicePath);
  const total = (voiceSecs + 1.9).toFixed(2);
  const outPath = join(OUT_DIR, `jingle-${i + 1}.mp3`);
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-stream_loop', '-1', '-i', bedPath,
    '-i', voicePath,
    '-filter_complex',
    `[0:a]atrim=0:${total},volume=0.15,afade=t=out:st=${(total - 1.3).toFixed(2)}:d=1.3[bed];` +
      '[1:a]adelay=500|500[voice];' +
      '[bed][voice]amix=inputs=2:duration=first:normalize=0,' +
      'alimiter=limit=0.95[out]',
    '-map', '[out]', '-ar', '24000', '-ac', '1', '-b:a', '96k', outPath,
  ]);
  const seconds = probeSeconds(outPath);
  manifest.push({ file: `/jingles/jingle-${i + 1}.mp3`, script, seconds });
  console.log(`jingle-${i + 1}.mp3: voice ${voiceSecs}s, mixed ${seconds}s`);
}

await writeFile(join(ROOT, 'lib', 'jingles.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest written: ${manifest.length} jingles`);
