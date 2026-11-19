// ============================================================================
// QUEUE AUDIT — the back-to-basics verification bar (replaces the retired
// chain audit and live-edge check, which audited the format clock).
//
//   node scripts/queue-audit.mjs
//
// Builds queues with buildPlaylist (lib/format.js) over (A) a large
// synthetic pool and (B) the real pool from getNewsPool() when the wire
// is reachable, and asserts the content rules of the continuous queue:
//
//   - no duplicate story links anywhere in the queue
//   - no duplicate headline clusters (the ingestion dedupe thresholds:
//     >= 4 shared significant tokens AND Jaccard >= 0.5 OR containment
//     >= 0.8, different links only)
//   - no same-EVENT repeats at the queue-level topic guard bar
//     (>= 3 shared significant tokens, >= 1 shared entity token,
//     Jaccard >= 0.3 OR containment >= 0.6; OR the entity+event rule:
//     >= 2 shared tokens with a shared entity token and a DIFFERENT
//     shared strong event token), plus a controls section proving the
//     guard collapses same-event pairs that ingestion dedupe would
//     keep (including the 2-shared-token production pair), while
//     genuinely different stories about the same entity, a different
//     company's same-event-type story, an earnings follow-up, a
//     no-shared-entity pair, and a high-overlap pair with no shared
//     entity token all survive
//   - no scheduled-time speech: no segment speaks a clock time or
//     announces the hour. Station-composed copy (everything but story
//     bodies and music listings, whose text is wire/feed content) is
//     scanned strictly; all segments are scanned for the station's own
//     callout shapes ("It is <time>", "top of the hour", "o'clock").
//   - every story script ends with terminal punctuation before the
//     "From <source>." sign-off
//   - no banter: zero banter segments in any built queue
//   - station material (station ID / weather / producer's desk) is a
//     small minority of segments AND of seconds; stories dominate both
//   - queue coverage meets the target (~4h) or consumes the pool
//   - no segment carries startMs / slotEndMs (nothing is scheduled)
//   - determinism within a bucket; the head rotates across buckets
//   - music: at most one rundown section, <= 6 listings, none repeated
//   - no dangling entity fragments ("&nbsp" without its semicolon) in
//     any script, and the render boundary's speechSafeText provably
//     neutralizes the synthesis poisons (bare & and <)
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

const { buildPlaylist, TARGET_QUEUE_SECONDS, headlineProfile, topicGuardMatches } = await import('../lib/format.js');
const { headlineTokens } = await import('../lib/rss.js');
const { getNewsPool } = await import('../lib/ingest.js');
const { speechSafeText } = await import('../lib/tts.js');

const WEATHER = { tempF: 54, condition: 'clear skies', windMph: 8 };

// The station's own scheduled-time callout shapes. Wire copy inside a
// story summary could in principle mention a time as NEWS content;
// that is the wire talking, not the station announcing a schedule, so
// story and music segments are exempt from the strict patterns and
// only held to these callout shapes.
const CALLOUT_PATTERNS = [
  /It is \d{1,2}(:\d{2})?\s*[AP]M/i,
  /top of the hour/i,
  /o'clock/i,
];
const STRICT_PATTERNS = [
  ...CALLOUT_PATTERNS,
  /\b\d{1,2}:\d{2}\s*[AP]M\b/,
  /\b\d{1,2}\s*[AP]M\b/,
  /Central Time/i,
];

function auditQueue(label, pool, nowMs) {
  console.log(`\n--- ${label} ---`);
  const { segments, queueSeconds, topicGuardSkipped } = buildPlaylist(pool, WEATHER, nowMs);
  console.log(`  topic guard skipped ${topicGuardSkipped} same-event item(s)`);
  const stories = segments.filter((s) => s.kind === 'story');
  const banter = segments.filter((s) => s.kind === 'banter');
  const station = segments.filter((s) =>
    ['station-id', 'weather', 'producers-desk'].includes(s.kind)
  );
  const stationSeconds = station.reduce((a, s) => a + s.estSeconds, 0);
  const storySeconds = stories.reduce((a, s) => a + s.estSeconds, 0);
  console.log(
    `  queue: ${segments.length} segments, ${(queueSeconds / 60).toFixed(1)} min ` +
      `(${stories.length} stories, ${banter.length} banter, ${station.length} station)`
  );
  check('queue is non-empty and story-led', stories.length >= 10, `${stories.length} stories`);
  check(
    'stories are the majority of segments and seconds',
    stories.length > segments.length / 2 && storySeconds > queueSeconds / 2,
    `stories ${stories.length}/${segments.length} segs, ${(storySeconds / 60).toFixed(1)}/${(queueSeconds / 60).toFixed(1)} min`
  );

  // No duplicate story links.
  const links = stories.map((s) => s.link).filter(Boolean);
  check(
    'no duplicate story links',
    new Set(links).size === links.length,
    `${links.length - new Set(links).size} duplicates`
  );
  const storyIds = stories.map((s) => s.id);
  check('no duplicate segment ids', new Set(segments.map((s) => s.id)).size === segments.length);

  // No duplicate headline clusters (dedupe thresholds, different links).
  const cands = stories
    .map((s) => ({ s, tokens: headlineTokens(s.headline, s.source) }))
    .filter((c) => c.tokens.size >= 4);
  const byToken = new Map();
  cands.forEach((c, i) => {
    for (const w of c.tokens) {
      if (!byToken.has(w)) byToken.set(w, []);
      byToken.get(w).push(i);
    }
  });
  const flagged = new Set();
  const seenPair = new Set();
  for (const idxs of byToken.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const key = `${idxs[a]}:${idxs[b]}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        const A = cands[idxs[a]];
        const B = cands[idxs[b]];
        if (A.s.link && A.s.link === B.s.link) continue;
        let inter = 0;
        for (const w of A.tokens) if (B.tokens.has(w)) inter++;
        if (inter < 4) continue;
        const jaccard = inter / (A.tokens.size + B.tokens.size - inter);
        const containment = inter / Math.min(A.tokens.size, B.tokens.size);
        if (jaccard >= 0.5 || containment >= 0.8) {
          flagged.add(`${A.s.headline}  <->  ${B.s.headline}`);
        }
      }
    }
  }
  check('no duplicate headline clusters', flagged.size === 0, [...flagged].slice(0, 3).join(' | '));

  // No same-EVENT repeats at the queue-level topic guard bar. The
  // guard enforces this during the build; asserting it here over the
  // finished queue is the regression test (a guard bug that let a
  // second version through would surface as a matching pair).
  const profiles = stories.map((s) => headlineProfile(s.headline, s.source));
  const eventHits = [];
  for (let a = 0; a < profiles.length; a++) {
    for (let b = a + 1; b < profiles.length; b++) {
      if (topicGuardMatches(profiles[a], profiles[b])) {
        eventHits.push(`${stories[a].headline}  <->  ${stories[b].headline}`);
      }
    }
  }
  check(
    'no same-event repeats in the queue (topic guard)',
    eventHits.length === 0,
    eventHits.slice(0, 3).join(' | ')
  );

  // No scheduled-time speech.
  const calloutHits = [];
  const strictHits = [];
  for (const seg of segments) {
    for (const re of CALLOUT_PATTERNS) {
      if (re.test(seg.script)) calloutHits.push(`${seg.id}: ${re}`);
    }
    if (seg.kind !== 'story' && seg.kind !== 'music') {
      for (const re of STRICT_PATTERNS) {
        if (re.test(seg.script)) strictHits.push(`${seg.id} (${seg.kind}): ${re}`);
      }
    }
  }
  check('no time callouts in any segment', calloutHits.length === 0, calloutHits.slice(0, 3).join(' | '));
  check(
    'no clock-time speech in station-composed copy',
    strictHits.length === 0,
    strictHits.slice(0, 3).join(' | ')
  );

  // No dangling entity fragments in any script. A semicolon-less
  // "&nbsp" remnant (a real UN News summary carried one on Nov 19) is
  // the visible symptom of the synthesis-poison class: bare & and <
  // make Edge TTS close the stream on every attempt. cleanText strips
  // the fragments at ingestion; speechSafeText (checked once, below)
  // is the render-boundary guarantee for the & and < themselves.
  const ENTITY_FRAGMENT = /&(?:[a-zA-Z][a-zA-Z0-9]{1,9}|#[0-9]{1,5}|#[xX][0-9a-fA-F]{1,4});?(?![\w=])/;
  const fragmentHits = segments
    .filter((seg) => ENTITY_FRAGMENT.test(seg.script))
    .map((seg) => seg.id);
  check(
    'no entity fragments in any segment script',
    fragmentHits.length === 0,
    fragmentHits.slice(0, 3).join(' | ')
  );

  // Every story script ends with terminal punctuation before the sign-off.
  const TERMINAL = /[.!?…]["'”’)\]]*$/;
  const badEndings = [];
  for (const seg of stories) {
    const suffix = ` From ${seg.source}.`;
    if (!seg.script.endsWith(suffix)) {
      badEndings.push(`${seg.id}: script does not end with its sign-off`);
      continue;
    }
    const body = seg.script.slice(0, -suffix.length).trim();
    if (!TERMINAL.test(body)) badEndings.push(`${seg.id}: ...${body.slice(-50)}`);
  }
  check('every story ends with terminal punctuation', badEndings.length === 0, badEndings.slice(0, 3).join(' | '));

  // No banter: David cut it ("just news", Nov 19). Zero banter
  // segments may appear in a built queue.
  check(
    'no banter segments in the queue',
    banter.length === 0,
    `${banter.length} banter segments`
  );

  // Station material is a small minority, by segments and by seconds.
  check(
    'station material under 15% of segments',
    station.length < segments.length * 0.15,
    `${station.length}/${segments.length}`
  );
  check(
    'station material under 15% of seconds',
    stationSeconds < queueSeconds * 0.15,
    `${stationSeconds}s/${queueSeconds}s`
  );
  // ...and never stacked: no two station segments back to back (the
  // queue head station ID is followed by a story by design).
  let stacked = 0;
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = segments[i].kind;
    const b = segments[i + 1].kind;
    if (
      ['station-id', 'weather', 'producers-desk'].includes(a) &&
      ['station-id', 'weather', 'producers-desk'].includes(b)
    ) {
      stacked++;
    }
  }
  check('station material never stacks back to back', stacked === 0, `${stacked} stacked pairs`);

  // Nothing is scheduled: no segment carries clock fields.
  check(
    'no segment carries startMs/slotEndMs',
    segments.every((s) => s.startMs === undefined && s.slotEndMs === undefined)
  );

  // Coverage: the target, or the whole pool when the pool is smaller.
  check(
    'queue coverage meets target or consumes the pool',
    queueSeconds >= TARGET_QUEUE_SECONDS * 0.95 || stories.length >= pool.items.filter((i) => i.category !== 'music').length,
    `queue ${(queueSeconds / 3600).toFixed(2)}h, target ${(TARGET_QUEUE_SECONDS / 3600).toFixed(1)}h, pool stories ${pool.items.filter((i) => i.category !== 'music').length}`
  );

  // Music discipline.
  const musicIntros = segments.filter((s) => s.kind === 'intro' && s.blockKey === 'kc-music');
  const listings = segments.filter((s) => s.kind === 'music');
  const poolListings = pool.items.filter((i) => i.category === 'music').length;
  if (poolListings > 0) {
    check('exactly one music rundown section', musicIntros.length === 1, `${musicIntros.length}`);
    check('music rundown caps at 6 listings', listings.length <= 6, `${listings.length}`);
    check(
      'no music listing repeats',
      new Set(listings.map((s) => s.id)).size === listings.length &&
        new Set(listings.map((s) => `${s.artist}|${s.venue}|${s.when}`)).size === listings.length
    );
  } else {
    check('no music section when the feed is empty', listings.length === 0 && musicIntros.length === 0);
  }

  return { segments, queueSeconds };
}

// ---------------------------------------------------------- A. synthetic
console.log('A. synthetic pool (360 stories + 8 music listings)');

const CATS = ['local', 'state', 'regional', 'ai', 'tech', 'business', 'national', 'global', 'newsletter'];
// Headlines built from unique word triples (12 x 12 x 12 = 1,728
// combos for 360 items) over a one-word constant tail, so no two
// headlines can reach the dedupe thresholds: any pair shares at most
// 3 significant tokens (two triple words + the tail word).
const WA = ['harbor', 'solar', 'rodeo', 'bakery', 'tunnel', 'river', 'airport', 'library', 'stadium', 'garden', 'highway', 'museum'];
const WB = ['analytics', 'brewing', 'logistics', 'robotics', 'textiles', 'energy', 'foods', 'motors', 'health', 'media', 'systems', 'farms'];
const WC = ['lantern', 'quarry', 'velvet', 'harvest', 'copper', 'marble', 'prairie', 'saddle', 'timber', 'orchard', 'beacon', 'summit'];
const items = [];
let n = 0;
for (const cat of CATS) {
  for (let i = 0; i < 40; i++) {
    const title = `${WA[n % 12]} ${WB[Math.floor(n / 12) % 12]} ${WC[Math.floor(n / 144) % 12]} quarterly`;
    n += 1;
    items.push({
      id: `syn-${cat}-${i}`,
      title,
      link: `https://example.com/${cat}/story-${i}`,
      summary:
        `Officials in the ${cat} bureau confirmed the decision on Tuesday after a long hearing. ` +
        `Supporters said the move would reshape the market for years, while opponents promised ` +
        `a fight on the floor that could stretch well past the holiday recess and into the new year.`,
      source: `${cat} Wire`,
      category: cat,
      publishedAt: Date.parse('2026-11-19T12:00:00Z') - n * 60000,
    });
  }
}
for (let i = 0; i < 8; i++) {
  items.push({
    id: `music:tonight:Band ${i}|Venue ${i}|tonight`,
    dedupeKey: `music:tonight:Band ${i}|Venue ${i}|tonight`,
    title: `Band ${i} at Venue ${i}`,
    link: '',
    summary: '',
    source: 'KC Music Feed',
    category: 'music',
    publishedAt: null,
    musicKind: i % 2 ? 'tonight' : 'announced',
    artist: `Band ${i}`,
    venue: `Venue ${i}`,
    when: 'tonight, doors 7 PM',
    url: '',
  });
}
const synthPool = { items, feeds: [], fetchedAt: Date.now() };
const T0 = Date.parse('2026-11-19T18:00:00Z');
const a1 = auditQueue('synthetic pool, bucket T', synthPool, T0);

// Determinism within the bucket.
const again = buildPlaylist(synthPool, WEATHER, T0 + 5 * 60000);
check(
  'determinism: same bucket, identical queue',
  JSON.stringify(again.segments) === JSON.stringify(a1.segments)
);
// Rotation across buckets: the head story changes.
const next = buildPlaylist(synthPool, WEATHER, T0 + 31 * 60000);
const headA = a1.segments.find((s) => s.kind === 'story')?.link;
const headB = next.segments.find((s) => s.kind === 'story')?.link;
check('rotation: next bucket starts at a different story', headA !== headB, `${headA} vs ${headB}`);

// Speech safety (the render-boundary guarantee in lib/tts.js): the
// transform must neutralize every proven synthesis poison — bare &
// and < fail Edge TTS on 100% of attempts (verified by direct
// synthesis tests, Nov 19) — while keeping the words speakable.
const poisoned = speechSafeText('AT&T and R&D: growth < 5 percent, Tom & Jerry');
check(
  'speechSafeText neutralizes & and <',
  !/[&<]/.test(poisoned) && poisoned.includes('AT and T') && poisoned.includes('less than 5'),
  JSON.stringify(poisoned)
);
check(
  'speechSafeText is idempotent',
  speechSafeText(poisoned) === poisoned,
  JSON.stringify(speechSafeText(poisoned))
);

// ------------------------------------- C. topic guard controls
console.log('\nC. topic guard controls (tiny dedicated pool)');

// The event pair: two outlets' differently worded versions of the
// Anthropic IPO. They share 4 significant tokens (anthropic, ipo, 1,
// trillion) at Jaccard 0.33 / containment 0.67 — BELOW the ingestion
// dedupe bar (Jaccard >= 0.5 OR containment >= 0.8), so ingestion
// keeps both; the queue guard (Jaccard >= 0.3 OR containment >= 0.6,
// >= 3 shared, >= 1 shared entity token: "ipo") must keep only one.
const EVENT_A = 'Anthropic valued at over $1 trillion in historic IPO';
const EVENT_B = 'Anthropic IPO draws huge investor demand as valuation tops $1 trillion';
// The flagship production pair for the entity+event rule: EVENT_A vs
// PROD_B share only 2 significant tokens (anthropic, ipo), below even
// the guard's 3-token bar — but anthropic is a shared entity token
// and ipo is a shared strong event token, so the pair must collapse.
const PROD_B = 'Investors scramble for a piece of AI giant Anthropic in blockbuster IPO';
// Entity+event survival controls (each must NOT match EVENT_A):
// a different company's IPO story (event token shared, entity not);
// an earnings follow-up on the same company (entity shared, event
// token not); and two unrelated outage stories (event token and 5
// tokens shared, but no shared entity token).
const CONTROL_RIVAL_IPO = 'Rivian prices IPO above range as EV demand surges';
const CONTROL_EARNINGS = 'Shares of Anthropic climb after earnings beat expectations';
const CONTROL_OUTAGE_A = 'Major outage knocks out power for thousands across Texas';
const CONTROL_OUTAGE_B = 'Outage knocks out power across Chicago suburbs';
// Distinctness control: shares {investors, ipo} with PROD_B, but the
// only shared entity token IS the event token — must NOT match.
const CONTROL_GENERIC_IPO = 'Investors cheer as Rivian files for IPO';
// Control 1: same entity, genuinely different story (a product
// launch). Shares only the entity token with the event pair, so the
// entity rule alone must not merge it: BOTH survive.
const CONTROL_PRODUCT = 'Anthropic launches Claude Opus upgrade for enterprise customers';
// Control 2: a high-overlap pair (5 shared tokens, Jaccard 0.56,
// containment 0.71) with NO shared entity token — the one shared
// capitalized word ("Regulators") is sentence-initial in both, which
// proves nothing. The entity gate must save both.
const CONTROL_GATE_A = 'Regulators open probe into data brokers over privacy practices';
const CONTROL_GATE_B = 'Regulators open probe into data brokers after complaint surge';
const UNRELATED = 'Kansas City bakery wins national award for sourdough';

const guardItems = [
  { title: EVENT_A, source: 'Axios', category: 'ai' },
  { title: EVENT_B, source: 'NPR News', category: 'national' },
  { title: PROD_B, source: 'Bloomberg', category: 'business' },
  { title: CONTROL_PRODUCT, source: 'TechCrunch', category: 'ai' },
  { title: CONTROL_RIVAL_IPO, source: 'Reuters Wire', category: 'tech' },
  { title: CONTROL_EARNINGS, source: 'CNBC', category: 'business' },
  { title: CONTROL_OUTAGE_A, source: 'State Wire', category: 'state' },
  { title: CONTROL_OUTAGE_B, source: 'Reuters Wire', category: 'national' },
  { title: CONTROL_GATE_A, source: 'Reuters Wire', category: 'national' },
  { title: CONTROL_GATE_B, source: 'State Wire', category: 'state' },
  { title: UNRELATED, source: 'KC Local Wire', category: 'local' },
].map((it, i) => ({
  id: `guard-${i}`,
  title: it.title,
  link: `https://example.com/guard-${i}`,
  summary: 'Officials confirmed the development on Tuesday and promised more detail soon.',
  source: it.source,
  category: it.category,
  publishedAt: Date.parse('2026-11-19T12:00:00Z') - i * 60000,
}));
const guardPool = { items: guardItems, feeds: [], fetchedAt: Date.now() };
const guardBuild = buildPlaylist(guardPool, null, T0);
const guardHeadlines = guardBuild.segments
  .filter((s) => s.kind === 'story')
  .map((s) => s.headline);

// Precondition: the event pair really is below the ingestion bar, or
// this section would be testing the wrong layer.
{
  const pa = headlineProfile(EVENT_A, 'Axios');
  const pb = headlineProfile(EVENT_B, 'NPR News');
  let inter = 0;
  for (const w of pa.tokens) if (pb.tokens.has(w)) inter++;
  const j = inter / (pa.tokens.size + pb.tokens.size - inter);
  const c = inter / Math.min(pa.tokens.size, pb.tokens.size);
  check(
    'control precondition: event pair is below the ingestion dedupe bar',
    inter >= 4 && j < 0.5 && c < 0.8,
    `shared ${inter}, J ${j.toFixed(2)}, C ${c.toFixed(2)}`
  );
  check('control precondition: event pair matches at the topic guard bar', topicGuardMatches(pa, pb));
}
// The entity+event rule: the production pair shares only 2 tokens,
// so the similarity bar above can never catch it; the shared entity
// (anthropic) plus a different shared event token (ipo) must.
{
  const pa = headlineProfile(EVENT_A, 'Axios');
  const pb = headlineProfile(PROD_B, 'Bloomberg');
  let inter = 0;
  for (const w of pa.tokens) if (pb.tokens.has(w)) inter++;
  check(
    'control precondition: production pair shares only 2 tokens',
    inter === 2,
    `shared ${inter}: ${[...pa.tokens].filter((w) => pb.tokens.has(w)).join(',')}`
  );
  check(
    'entity+event rule: production pair matches the topic guard',
    topicGuardMatches(pa, pb)
  );
  check(
    'entity+event rule: different company IPO story does not match',
    !topicGuardMatches(pa, headlineProfile(CONTROL_RIVAL_IPO, 'Reuters Wire'))
  );
  check(
    'entity+event rule: same company earnings story does not match',
    !topicGuardMatches(pa, headlineProfile(CONTROL_EARNINGS, 'CNBC'))
  );
  check(
    'entity+event rule: shared event token without shared entity does not match',
    !topicGuardMatches(
      headlineProfile(CONTROL_OUTAGE_A, 'State Wire'),
      headlineProfile(CONTROL_OUTAGE_B, 'Reuters Wire')
    )
  );
  check(
    'entity+event rule: entity token identical to the event token does not match',
    !topicGuardMatches(pb, headlineProfile(CONTROL_GENERIC_IPO, 'Bloomberg'))
  );
}
check(
  'topic guard: exactly one version of the event airs',
  guardHeadlines.filter((h) => h === EVENT_A || h === EVENT_B || h === PROD_B).length === 1,
  guardHeadlines.join(' | ')
);
check(
  'topic guard: different story about the same entity survives',
  guardHeadlines.includes(CONTROL_PRODUCT),
  guardHeadlines.join(' | ')
);
check(
  'topic guard: rival IPO, earnings follow-up, and both outage stories survive',
  guardHeadlines.includes(CONTROL_RIVAL_IPO) &&
    guardHeadlines.includes(CONTROL_EARNINGS) &&
    guardHeadlines.includes(CONTROL_OUTAGE_A) &&
    guardHeadlines.includes(CONTROL_OUTAGE_B),
  guardHeadlines.join(' | ')
);
check(
  'topic guard: entity gate saves the high-overlap pair (both survive)',
  guardHeadlines.includes(CONTROL_GATE_A) && guardHeadlines.includes(CONTROL_GATE_B),
  guardHeadlines.join(' | ')
);
check('topic guard: unrelated story survives', guardHeadlines.includes(UNRELATED));
check(
  'topic guard: exactly two items skipped in the controls pool (3 versions, 1 airs)',
  guardBuild.topicGuardSkipped === 2,
  `skipped ${guardBuild.topicGuardSkipped}`
);

// ---------------------------------------------------------- B. real pool
console.log('\nB. real pool (skipped if the wire is unreachable)');
try {
  const pool = await getNewsPool();
  if (pool.items.length >= 50) {
    auditQueue(`real pool (${pool.items.length} items)`, pool, Date.now());
  } else {
    console.log(`  SKIP  real pool too small (${pool.items.length} items)`);
  }
} catch (err) {
  console.log(`  SKIP  real pool fetch failed: ${err?.message || err}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
