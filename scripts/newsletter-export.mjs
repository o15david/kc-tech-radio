#!/usr/bin/env node
// ============================================================================
// NEWSLETTER EXPORT — the inbox half of the newsletter pipeline.
//
// Pulls newsletter mail out of the fairbanks@muse.ai inbox (via the
// Muse Mail connector CLI, /opt/hatch/bin/muse-mail) and writes each
// new message as a plain .eml file that scripts/newsletter-processor.mjs
// consumes. Deterministic throughout: senders are identified by the
// address/name allowlist in newsletter-processor.mjs, nothing is
// summarized or rewritten, and the raw HTML body is stored verbatim.
//
//   node scripts/newsletter-export.mjs [--days 4] [--max-pages 6]
//        [--workdir .newsletter-work]
//
// State (all inside --workdir, which is gitignored):
//   exported.json   message ids already written to disk (never re-export)
//   inbox/*.eml     one file per exported message, oldest subscriptions
//                   first by file name (date prefix)
//
// Every run also prints a per-newsletter status table (latest mail seen
// in the scan window, its date and kind) so a scheduled run can report
// which of the nine lists are flowing, quiet, or still onboarding.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KNOWN_SENDERS,
  ONBOARDING_SUBJECT_RE,
  matchKnownSenderForMail,
} from './newsletter-processor.mjs';

const MUSE_MAIL = '/opt/hatch/bin/muse-mail';
const PAGE_LIMIT = 50;

function parseArgs(argv) {
  const args = { days: 4, maxPages: 6, workdir: '.newsletter-work' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]) || args.days;
    else if (argv[i] === '--max-pages') args.maxPages = Number(argv[++i]) || args.maxPages;
    else if (argv[i] === '--workdir') args.workdir = argv[++i];
  }
  return args;
}

function listPage(cursor) {
  const cliArgs = ['messages', 'list', '--limit', String(PAGE_LIMIT)];
  if (cursor) cliArgs.push('--after', cursor);
  const out = execFileSync(MUSE_MAIL, cliArgs, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function senderEmail(message) {
  const raw = String(message.header_from || '');
  return (/<([^>]+)>/.exec(raw)?.[1] || raw).trim().toLowerCase();
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workdir = args.workdir;
  const inboxDir = join(workdir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const statePath = join(workdir, 'exported.json');
  const exported = new Set(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []);

  const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;
  const latestBySource = new Map(); // canonical name -> { dateMs, subject, kind }
  let cursor = null;
  let pages = 0;
  let scanned = 0;
  let written = 0;

  while (pages < args.maxPages) {
    const page = listPage(cursor);
    pages++;
    const messages = Array.isArray(page.data) ? page.data : [];
    if (!messages.length) break;

    let oldestOnPage = Infinity;
    for (const message of messages) {
      scanned++;
      const dateMs = Date.parse(message.date || '') || message.created_at * 1000 || 0;
      if (dateMs) oldestOnPage = Math.min(oldestOnPage, dateMs);
      if (message.direction !== 'INBOUND') continue;

      const fromEmail = senderEmail(message);
      const fromName = message.header_from_name || '';
      const subject = message.subject || '';
      const source = matchKnownSenderForMail({ fromName, fromEmail, subject });
      if (!source) continue;

      const kind = ONBOARDING_SUBJECT_RE.test(subject) ? 'onboarding' : 'issue';
      const prev = latestBySource.get(source);
      if (!prev || dateMs > prev.dateMs) latestBySource.set(source, { dateMs, subject, kind });

      if (dateMs && dateMs < cutoff) continue;
      if (exported.has(message.id)) continue;
      if (!message.html_body) {
        console.log(`skip message ${message.id} (${source}): no HTML body`);
        exported.add(message.id);
        continue;
      }

      const dateStr = dateMs ? new Date(dateMs).toISOString().slice(0, 10) : 'undated';
      const fileName = `${dateStr}-${slug(source)}-${message.id}.eml`;
      const eml = [
        `From: "${String(fromName).replace(/"/g, '')}" <${fromEmail}>`,
        `Subject: ${subject}`,
        `Date: ${message.date || new Date(dateMs).toUTCString()}`,
        `Message-ID: ${message.rfc_message_id || `<${message.id}@muse.ai>`}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        '',
        message.html_body,
        '',
      ].join('\n');
      writeFileSync(join(inboxDir, fileName), eml);
      exported.add(message.id);
      written++;
      console.log(`exported ${fileName} (${source}, ${kind})`);
    }

    cursor = page.paging?.cursors?.after || null;
    if (!cursor || oldestOnPage < cutoff) break;
  }

  writeFileSync(statePath, JSON.stringify([...exported], null, 2));
  console.log(
    `Scanned ${scanned} messages across ${pages} page(s); exported ${written} new newsletter message(s) to ${inboxDir}.`
  );
  console.log('Newsletter status (latest mail in scan window):');
  for (const name of KNOWN_SENDERS) {
    const latest = latestBySource.get(name);
    if (!latest) {
      console.log(`  ${name}: no mail seen`);
    } else {
      const when = new Date(latest.dateMs).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
      console.log(`  ${name}: ${latest.kind}, ${when}, "${latest.subject}"`);
    }
  }
}

main();
