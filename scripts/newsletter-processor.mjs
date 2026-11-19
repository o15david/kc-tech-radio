#!/usr/bin/env node
// ============================================================================
// NEWSLETTER PROCESSOR — turns newsletter email into the station's feed.
//
// KC Tech Radio's assistant (Fairbanks) receives AI/tech/business
// newsletters at fairbanks@muse.ai, outside Vercel. This script is the
// bridge: it reads newsletter email HTML, extracts story items with fixed
// deterministic parsing rules (NO LLM summarization, ever), dedupes
// against everything already emitted, and writes newsletter-feed.json in
// exactly the shape the station's ingestion consumes (see lib/feeds.js:
// NEWSLETTER_FEED, and README.md "Newsletter pipeline").
//
// Usage:
//   node scripts/newsletter-processor.mjs --in <file-or-folder> \
//        [--out data/newsletter-feed.json] [--state <state.json>] \
//        [--from "Display Name"] [--allow-unknown]
//
// Input: .eml files (headers + MIME body are parsed; the source name comes
// from the From display name) and .html files (source name from --from, or
// a <meta name="newsletter-from" content="..."> tag, or the file name).
// A folder is scanned non-recursively for .eml/.html files, oldest first.
//
// Output: the feed file is MERGED, not overwritten: existing items are
// kept, new items are added, the result is deduped and capped. The state
// file (default: <out>.state.json) records every link ever emitted, so
// re-processing an issue never re-airs a story.
//
// ---------------------------------------------------------------------------
// KNOWN SENDERS (the allowlist). fairbanks@muse.ai is subscribed to these
// 9 newsletters (as of Nov 19, 2026). Matching is a case-insensitive
// substring test against the From display name; a matched item's source
// attribution is the canonical name below. Senders NOT on this list are
// skipped unless --allow-unknown is passed. Edit this list as
// subscriptions change.
//
//   Cadence: most weekday mornings; Import AI and The Batch weekly;
//   Startland News 3-5x/week. The Batch (DeepLearning.AI) was subscribed
//   under the name "Fairbanks Muse" with David's approval; its mail
//   arrives under The Batch's own From name, which is what we match.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

export const KNOWN_SENDERS = [
  'TLDR Tech',
  'TLDR AI',
  'The Rundown AI',
  "Ben's Bites",
  'Morning Brew',
  'The Hustle',
  'Startland News',
  'Import AI',
  'The Batch',
];

const MAX_ITEMS_IN_FEED = 50;
const MAX_SUMMARY_CHARS = 280;
const MIN_TITLE_CHARS = 12;

// Headings that are furniture, not stories.
const TITLE_STOPLIST = [
  'unsubscribe',
  'view in browser',
  'view online',
  'advertisement',
  'sponsored',
  'share this',
  'follow us',
  'sign up',
  'subscribe',
  'privacy policy',
  'manage preferences',
  'forward to a friend',
  'together with',
  'presented by',
];

// Links that are never stories, whatever the heading says.
const LINK_SKIP_PATTERNS = [/unsubscribe/i, /preferences/i, /email-settings/i, /^mailto:/i];

// ---------------------------------------------------------------------------
// Small deterministic helpers (kept in step with lib/ingest.js conventions)
// ---------------------------------------------------------------------------

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLink(link) {
  try {
    const u = new URL(link);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return link;
  }
}

function truncateAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).replace(/[\s,;:]+$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Extraction rules (fixed; see README.md "Newsletter pipeline"):
//
//   1. Strip scripts, styles, comments, and hidden (display:none) blocks.
//   2. Walk h1-h3 headings in document order. A heading becomes an item:
//      - title: the heading's cleaned text (>= MIN_TITLE_CHARS, not on
//        the stoplist);
//      - link: the first http(s) anchor INSIDE the heading, else the
//        first http(s) anchor after it and before the next heading;
//      - summary: the cleaned text of the first <p> after the heading
//        and before the next heading, truncated to 280 chars.
//   3. Skip items whose link matches LINK_SKIP_PATTERNS or is missing.
//   4. Dedupe by normalized link (and by title within one issue).
// ---------------------------------------------------------------------------

export function extractItems(html, source, publishedAt) {
  const doc = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+style="[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/gi, ' ');

  const headings = [];
  const headingRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = headingRe.exec(doc)) !== null) {
    headings.push({ index: m.index, end: headingRe.lastIndex, inner: m[2] });
  }

  const items = [];
  const seenLinks = new Set();
  const seenTitles = new Set();

  headings.forEach((heading, i) => {
    const title = cleanText(heading.inner);
    if (title.length < MIN_TITLE_CHARS) return;
    const lower = title.toLowerCase();
    if (TITLE_STOPLIST.some((s) => lower.includes(s))) return;
    if (seenTitles.has(lower)) return;

    const regionEnd = i + 1 < headings.length ? headings[i + 1].index : doc.length;
    const region = doc.slice(heading.end, Math.min(regionEnd, heading.end + 6000));

    const anchorInHeading = /<a\b[^>]*href\s*=\s*"([^"]+)"/i.exec(heading.inner);
    const anchorInRegion = /<a\b[^>]*href\s*=\s*"([^"]+)"/i.exec(region);
    const rawLink = anchorInHeading?.[1] || anchorInRegion?.[1] || '';
    const link = normalizeLink(decodeEntities(rawLink));
    if (!/^https?:\/\//i.test(link)) return;
    if (LINK_SKIP_PATTERNS.some((re) => re.test(link))) return;
    if (seenLinks.has(link.toLowerCase())) return;

    const pMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(region);
    const summary = pMatch ? truncateAtWord(cleanText(pMatch[1]), MAX_SUMMARY_CHARS) : '';

    seenLinks.add(link.toLowerCase());
    seenTitles.add(lower);
    items.push({ id: link, title, link, summary, source, publishedAt });
  });

  return items;
}

// ---------------------------------------------------------------------------
// Input parsing: .eml (headers + MIME) and bare .html
// ---------------------------------------------------------------------------

function parseFromDisplayName(fromHeader) {
  if (!fromHeader) return '';
  const beforeBracket = fromHeader.split('<')[0].trim().replace(/^"|"$/g, '');
  if (beforeBracket) return beforeBracket;
  const email = /<([^>]+)>/.exec(fromHeader)?.[1] || fromHeader.trim();
  return email.split('@')[0] || '';
}

function decodeMimeBody(body, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

export function parseEml(raw) {
  const splitAt = raw.search(/\r?\n\r?\n/);
  const headerBlock = splitAt >= 0 ? raw.slice(0, splitAt) : '';
  const body = splitAt >= 0 ? raw.slice(splitAt).replace(/^\r?\n\r?\n/, '') : raw;
  // Unfold continuation lines, then read the headers we care about.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const header = (name) =>
    new RegExp(`^${name}:\\s*(.*)$`, 'mi').exec(unfolded)?.[1]?.trim() || '';

  let html = '';
  const boundary = /boundary="?([^";\s]+)"?/i.exec(header('Content-Type'))?.[1];
  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      if (!/content-type:\s*text\/html/i.test(part)) continue;
      const partSplit = part.search(/\r?\n\r?\n/);
      if (partSplit < 0) continue;
      const encoding = /content-transfer-encoding:\s*(\S+)/i.exec(part)?.[1] || '';
      html = decodeMimeBody(part.slice(partSplit).replace(/^\r?\n\r?\n/, ''), encoding);
      break;
    }
  } else if (/^text\/html/i.test(header('Content-Type'))) {
    html = decodeMimeBody(body, header('Content-Transfer-Encoding'));
  }

  const dateMs = Date.parse(header('Date'));
  return {
    fromName: parseFromDisplayName(header('From')),
    subject: header('Subject'),
    publishedAt: Number.isNaN(dateMs) ? null : dateMs,
    html,
  };
}

export function matchKnownSender(fromName) {
  const lower = (fromName || '').toLowerCase();
  if (!lower) return null;
  return (
    KNOWN_SENDERS.find(
      (name) => lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)
    ) || null
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const args = { in: null, out: 'newsletter-feed.json', state: null, from: null, allowUnknown: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') args.in = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--state') args.state = argv[++i];
    else if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--allow-unknown') args.allowUnknown = true;
  }
  if (!args.in) {
    console.error('Usage: node scripts/newsletter-processor.mjs --in <file-or-folder> [--out feed.json] [--state state.json] [--from "Name"] [--allow-unknown]');
    process.exit(2);
  }
  const statePath = args.state || `${args.out}.state.json`;

  // Collect input files, oldest first so later issues win title dedupe.
  const stat = statSync(args.in);
  const files = stat.isDirectory()
    ? readdirSync(args.in)
        .filter((f) => /\.(eml|html?)$/i.test(f))
        .map((f) => join(args.in, f))
        .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    : [args.in];

  const emittedLinks = new Set(
    existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []
  );
  const existingItems = existsSync(args.out)
    ? JSON.parse(readFileSync(args.out, 'utf8')).items || []
    : [];

  const newItems = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    let fromName = args.from || '';
    let html = raw;
    let publishedAt = Math.round(statSync(file).mtimeMs);

    if (/\.eml$/i.test(file)) {
      const parsed = parseEml(raw);
      fromName = parsed.fromName || fromName;
      html = parsed.html;
      if (parsed.publishedAt) publishedAt = parsed.publishedAt;
      if (!html) {
        console.log(`skip ${basename(file)}: no HTML part`);
        continue;
      }
    } else {
      const metaFrom =
        /newsletter-from[^>]*content="([^"]+)"/i.exec(raw)?.[1] ||
        /content="([^"]+)"[^>]*newsletter-from/i.exec(raw)?.[1];
      fromName = metaFrom || fromName || basename(file, extname(file));
    }

    const known = matchKnownSender(fromName);
    if (!known && !args.allowUnknown) {
      console.log(`skip ${basename(file)}: sender "${fromName}" not on the known-senders list (use --allow-unknown to force)`);
      continue;
    }
    const source = known || fromName;

    const extracted = extractItems(html, source, publishedAt);
    let added = 0;
    for (const item of extracted) {
      const key = item.link.toLowerCase();
      if (emittedLinks.has(key)) continue;
      emittedLinks.add(key);
      newItems.push(item);
      added++;
    }
    console.log(`${basename(file)}: ${extracted.length} items extracted, ${added} new (source: ${source})`);
  }

  const merged = [...newItems, ...existingItems]
    .filter((item, idx, all) => all.findIndex((x) => x.link.toLowerCase() === item.link.toLowerCase()) === idx)
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, MAX_ITEMS_IN_FEED);

  writeFileSync(
    args.out,
    JSON.stringify({ generatedAt: new Date().toISOString(), source: 'kc-tech-radio newsletter processor', items: merged }, null, 2)
  );
  writeFileSync(statePath, JSON.stringify([...emittedLinks], null, 2));
  console.log(`Wrote ${args.out}: ${merged.length} items (${newItems.length} new). State: ${statePath} (${emittedLinks.size} links ever emitted).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
