// ============================================================================
// SENTENCE-BOUNDARY AUDIT — story scripts must never end mid-clause.
//
//   node scripts/sentence-audit.mjs
//
// A. Unit checks on trimToSentenceBoundary (lib/rss.js): the one rule
//    every trim site uses (ingest's 600-char cap, format's 480-char
//    cleanSummary). Covers: last in-budget sentence wins; first complete
//    sentence when none fits; abbreviations ("U.S.") and decimals
//    ("3.5") are not boundaries; no-boundary text returned whole.
// B. Integration: buildPlaylist over a synthetic pool of nasty
//    summaries (over-length, wire-truncated with […], abbreviation-
//    laden, one giant sentence). For every story segment, the script
//    body before the "From <source>." attribution must not end with a
//    comma/semicolon/colon or a dangling function word, and for items
//    whose raw summary was actually cut (over the cap or marker-
//    truncated) it must end with terminal punctuation.
// C. Ending polish (the dangles the live sample still had after the
//    sentence-boundary fix): source summaries with NO terminal
//    punctuation at all, headline-style fragments, and summaries with
//    residual HTML ("<p>Sen."). cleanText must strip escaped and
//    partial tags, and every composed story body, cut or not, must
//    end with terminal punctuation before the sign-off.
// ============================================================================

import { register } from 'node:module';
register('./extensionless-loader.mjs', import.meta.url);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const { trimToSentenceBoundary, lastSentenceEnd, cleanText, ensureTerminalPunctuation } = await import('../lib/rss.js');
const { buildPlaylist } = await import('../lib/format.js');

// ---------------------------------------------------------------- A. units
console.log('A. trimToSentenceBoundary unit checks');

const s1 = 'Alpha sentence one is here. Beta sentence two follows it closely. Gamma sentence three is the one that runs long and keeps going with more detail.';
const t1 = trimToSentenceBoundary(s1, 80);
check('last in-budget sentence wins', t1 === 'Alpha sentence one is here. Beta sentence two follows it closely.', JSON.stringify(t1));

const s2 = 'Short one. ' + 'This second sentence is deliberately very long and winding, '.repeat(6) + 'finally ending here.';
const t2 = trimToSentenceBoundary(s2, 100);
check('falls back to the last boundary that fits', t2 === 'Short one.', JSON.stringify(t2));

const s3 = 'A single complete sentence that is much longer than the tiny budget we give it, with clauses, and commas, and everything.';
const t3 = trimToSentenceBoundary(s3, 40);
check('no in-budget boundary: first complete sentence, whole', t3 === s3, JSON.stringify(t3));

const s4 = 'The U.S. economy grew again last quarter. Markets cheered the news loudly.';
const t4 = trimToSentenceBoundary(s4, 20);
check('"U.S." is not a sentence boundary', t4 === 'The U.S. economy grew again last quarter.', JSON.stringify(t4));

const s5 = 'Shares rose 3.5 percent after the report landed. Volume doubled by noon.';
const t5 = trimToSentenceBoundary(s5, 30);
check('decimals are not sentence boundaries', t5 === 'Shares rose 3.5 percent after the report landed.', JSON.stringify(t5));

const s6 = 'A fragment with no sentence boundary anywhere in it at all';
const t6 = trimToSentenceBoundary(s6, 20);
check('no boundary anywhere: returned whole, never severed', t6 === s6, JSON.stringify(t6));

const s7 = 'Within budget. Stays as-is.';
check('within budget: unchanged', trimToSentenceBoundary(s7, 480) === s7);
check('lastSentenceEnd finds the end', lastSentenceEnd('One. Two!') === 'One. Two!'.length);
check('lastSentenceEnd ignores abbreviations', lastSentenceEnd('In the U.S. it grew') === 0);

console.log('C. ending-polish unit checks');
check('cleanText strips escaped tags', cleanText('&lt;p&gt;Hello world') === 'Hello world', JSON.stringify(cleanText('&lt;p&gt;Hello world')));
check('cleanText strips real tags', cleanText('Normal <b>bold</b> text') === 'Normal bold text');
check('cleanText strips a trailing partial tag', cleanText('Text ends mid-tag <div class="x') === 'Text ends mid-tag', JSON.stringify(cleanText('Text ends mid-tag <div class="x')));
check(
  'cleanText leaves the Schumer remnant clean',
  cleanText('The senators spoke out. &lt;p&gt;Sen. Cantwell said she was undecided.') ===
    'The senators spoke out. Sen. Cantwell said she was undecided.',
  JSON.stringify(cleanText('The senators spoke out. &lt;p&gt;Sen. Cantwell said she was undecided.')),
);
// Entity fragments: a semicolon-less "&nbsp" (the exact remnant a UN
// News summary carried on Nov 19) and unknown entities must never
// survive cleaning — a bare & in a script kills Edge TTS synthesis on
// every attempt (see speechSafeText in lib/tts.js). Genuine prose
// ampersands (one letter after the &) must survive untouched.
check(
  'cleanText strips a dangling &nbsp fragment',
  cleanText('The situation is worse than it was in 2019.&nbsp') === 'The situation is worse than it was in 2019.',
  JSON.stringify(cleanText('The situation is worse than it was in 2019.&nbsp')),
);
check(
  'cleanText drops an unknown entity',
  cleanText('Fish &copy; Friday specials') === 'Fish Friday specials',
  JSON.stringify(cleanText('Fish &copy; Friday specials')),
);
check(
  'cleanText keeps genuine ampersands',
  cleanText('AT&T and R&D at M&M\u2019s') === 'AT&T and R&D at M&M\u2019s',
  JSON.stringify(cleanText('AT&T and R&D at M&M\u2019s')),
);
// Semicolon artifacts (live UN News summaries, Nov 19): a semicolon
// jammed against word characters is a separator artifact the TTS
// reads as a pause ("assisting;thousands;of", "weekend,;where").
// Normalize those to ", "; legitimate "; " prose survives; a lone
// URL is exempt (semicolons are legal inside links).
check(
  'cleanText normalizes jammed semicolons',
  cleanText('Crews are assisting;thousands;of residents displaced by the floods') ===
    'Crews are assisting, thousands, of residents displaced by the floods',
  JSON.stringify(cleanText('Crews are assisting;thousands;of residents displaced by the floods')),
);
check(
  'cleanText collapses a comma-semicolon jam',
  cleanText('Talks dragged on over the weekend,;where negotiators remained split') ===
    'Talks dragged on over the weekend, where negotiators remained split',
  JSON.stringify(cleanText('Talks dragged on over the weekend,;where negotiators remained split')),
);
check(
  'cleanText collapses a semicolon-comma jam',
  cleanText('The report landed late;,catching markets off guard') ===
    'The report landed late, catching markets off guard',
  JSON.stringify(cleanText('The report landed late;,catching markets off guard')),
);
check(
  'cleanText preserves legitimate semicolon usage',
  cleanText('He paused; then he spoke.') === 'He paused; then he spoke.',
  JSON.stringify(cleanText('He paused; then he spoke.')),
);
check(
  'cleanText leaves semicolons inside a lone URL alone',
  cleanText('https://example.com/story;a=1;b=2') === 'https://example.com/story;a=1;b=2',
  JSON.stringify(cleanText('https://example.com/story;a=1;b=2')),
);
check('ensureTerminalPunctuation appends a missing period', ensureTerminalPunctuation('She was denied parole again') === 'She was denied parole again.');
check('ensureTerminalPunctuation leaves a period alone', ensureTerminalPunctuation('Already done.') === 'Already done.');
check('ensureTerminalPunctuation leaves a question alone', ensureTerminalPunctuation('Really?') === 'Really?');
check('ensureTerminalPunctuation leaves punctuated quotes alone', ensureTerminalPunctuation('He said "done."') === 'He said "done."');
check('ensureTerminalPunctuation closes an unpunctuated quote', ensureTerminalPunctuation('He said "not yet"') === 'He said "not yet".');
check('ensureTerminalPunctuation replaces a dangling comma', ensureTerminalPunctuation('Ends with a comma,') === 'Ends with a comma.');

// ------------------------------------------------------- B. integration
console.log('B. buildPlaylist over a nasty synthetic pool');

const longSummary = (topic) =>
  `${topic} opened the week with a major announcement that caught the whole industry by surprise. ` +
  `Analysts said the move could reshape the market for years, with more than 10,000 GPUs, delivering ` +
  `capacity that rivals said would take them quarters to match on their own roadmaps. ` +
  `The company declined to give a timeline, but people familiar with the matter said shipments ` +
  `begin early next year, and preorders are already open for the largest customers in North America.`;

const items = [];
let n = 0;
function addItem(category, title, summary) {
  n += 1;
  items.push({
    id: `nasty-${n}`,
    title,
    link: `https://example.com/story-${n}`,
    summary,
    source: 'Wire Service',
    category,
    publishedAt: Date.parse('2026-11-19T06:00:00Z') - n * 60000,
  });
}

for (const cat of ['local', 'state', 'regional', 'national', 'global', 'ai', 'tech', 'business', 'newsletter']) {
  addItem(cat, `${cat} long-summary story`, longSummary(`The ${cat} desk`));
  addItem(cat, `${cat} truncated story`, `First complete sentence from the ${cat} desk stands on its own. Then a second thought that trails off mid-clause and keeps going […]`);
  addItem(cat, `${cat} abbreviation story`, `The U.S. Senate took up the bill on Tuesday, and the debate ran long into the evening session. Supporters in the ${cat} region said the measure would pass, while opponents promised amendments, procedural delays, and a fight on the floor that could stretch well past the holiday recess and into the new year.`);
  addItem(cat, `${cat} giant-sentence story`, `One enormous sentence about ${cat} that never seems to end because it keeps adding clause after clause, with commas, and asides, and qualifications, and references to earlier announcements, and hints about future products, and quotes from executives who spoke on background, and nods to rivals who declined to comment, and footnotes about supply chains, and caveats about currency fluctuations, until it finally stops.`);
  addItem(cat, `${cat} short story`, `A brief ${cat} item with one clean sentence.`);
  addItem(cat, `${cat} unpunctuated story`, `Officials in the ${cat} region confirmed the decision late on Tuesday after a long hearing that stretched past midnight`);
  addItem(cat, `${cat} fragment story`, `Rolling coverage of breaking news and live events across the ${cat} region`);
  addItem(cat, `${cat} html story`, `First sentence from the ${cat} desk is complete and stands on its own. <p>Sen. Another complete sentence follows here with the detail that matters.`);
}

const pool = { items, feeds: [], fetchedAt: Date.now() };
// Two builds at the very start of different cycles (08:00 CT and
// 16:00 CT on Nov 19), unioned so more of the nasty items actually
// air and get audited. Building at the cycle anchor matters twice
// over: the stateless replay has not yet "aired" anything, and the
// response still contains the whole hour's stories (a build at :23
// would find this small pool's ~15 minutes of story audio already
// past and dropped).
const stories = [];
for (const iso of ['2026-11-19T14:00:00Z', '2026-11-19T22:00:00Z']) {
  const { segments } = buildPlaylist(pool, null, Date.parse(iso));
  stories.push(...segments.filter((s) => s.kind === 'story'));
}
check('playlist built story segments', stories.length > 0, `${stories.length} stories`);

const DANGLING = /(,|;|:|\b(and|but|or|the|a|an|to|of|with|for|on|in|at|by|delivering))$/i;
const TERMINAL = /[.!?]["'”’)\]]*$/;
let dangling = [];
let unterminated = [];
let anyUnterminated = [];
let tagLeaks = [];
for (const seg of stories) {
  const suffix = ` From ${seg.source}.`;
  if (!seg.script.endsWith(suffix)) continue; // span-fill scripts share the shape; guard anyway
  const body = seg.script.slice(0, -suffix.length);
  if (DANGLING.test(body.trim())) dangling.push(`${seg.id}: ...${body.slice(-60)}`);
  if (/<\/?[a-zA-Z!][^>]*>?/.test(seg.script)) tagLeaks.push(`${seg.id}: ...${body.slice(-60)}`);
  // Ending polish: EVERY composed body ends with terminal punctuation
  // before the sign-off, whether its summary was cut or not.
  if (!TERMINAL.test(body.trim())) anyUnterminated.push(`${seg.id}: ...${body.slice(-60)}`);
  // Items whose raw summary had to be cut (over 480 chars, or wire-
  // truncated) must end on terminal punctuation, no exceptions.
  const raw = items.find((it) => it.title === seg.headline);
  const wasCut = raw && (raw.summary.length > 480 || raw.summary.includes('[…]'));
  if (wasCut && !TERMINAL.test(body.trim())) {
    unterminated.push(`${seg.id}: ...${body.slice(-60)}`);
  }
}
check('no story body ends mid-clause (dangling punctuation/function word)', dangling.length === 0, dangling.slice(0, 3).join(' | '));
check('every cut summary ends with terminal punctuation', unterminated.length === 0, unterminated.slice(0, 3).join(' | '));
check('every story body ends with terminal punctuation', anyUnterminated.length === 0, anyUnterminated.slice(0, 3).join(' | '));
check('no residual HTML tags in any story script', tagLeaks.length === 0, tagLeaks.slice(0, 3).join(' | '));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
