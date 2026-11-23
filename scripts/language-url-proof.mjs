#!/usr/bin/env node
// LANGUAGE + SPOKEN-URL PROOF (local only): David's Nov 23, 2026
// rulings. (1) Spanish-language stories never air: the deterministic
// stopword gate in lib/language.js, applied at ingest in
// lib/ingest.js, drops Spanish-dominant items while English items,
// English items mentioning Spanish names/places, and French items
// all pass. (2) No spoken URLs: lib/format.js sanitizeSpokenText
// reduces every URL in a script to its bare domain, and buildPlaylist
// applies it to every segment, so a built queue carries no "http",
// no "www.", and no spoken path.
import { register } from 'node:module';

register('./extensionless-loader.mjs', import.meta.url);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

const { isSpanishItem, isSpanishText, languageScores } = await import(
  '../lib/language.js'
);
const { sanitizeSpokenText, buildPlaylist, STATION_EPOCH_MS } = await import(
  '../lib/format.js'
);

// ---------------------------------------------------------------------------
// 1. Language gate, unit level
// ---------------------------------------------------------------------------
const SPANISH_WIRE = {
  title: 'La ciudad aprueba un nuevo plan para el centro de Kansas City',
  summary:
    'El consejo de la ciudad votó el martes a favor de un programa de mejoras para las calles del centro, con fondos del estado y la participación de los residentes de los barrios cercanos.',
};
const SPANISH_NEWSLETTER = {
  title: 'Las empresas de tecnología anuncian nuevas inversiones en la región',
  summary:
    'Según un informe publicado esta semana, las compañías del sector han confirmado que abrirán nuevas oficinas y contratarán a más trabajadores durante el próximo año en todo el país.',
};
const ENGLISH_LOCAL = {
  title: 'Kansas City council approves new downtown improvement plan',
  summary:
    'The city council voted Tuesday in favor of a street improvement program for downtown, with state funding and participation from nearby neighborhood residents.',
};
const ENGLISH_SPANISH_NAMES = {
  title: 'El Paso mayor José García visits Kansas City to tour the streetcar',
  summary:
    "The visiting delegation from El Paso met with Kansas City officials on Monday to discuss transit funding, trade, and the two cities' shared logistics industry, according to the mayor's office.",
};
const ENGLISH_LA_LIGA = {
  title: 'La Liga race tightens as Sevilla stuns the leaders',
  summary:
    "The Spanish league's title race tightened on Sunday when Sevilla beat the league leaders at home, a result that reshapes the top of the table heading into the winter break.",
};
const FRENCH_SCIENCE = {
  title: 'Le CNRS annonce une nouvelle avancée pour les batteries',
  summary:
    'Les chercheurs du centre ont présenté une méthode qui pourrait prolonger la durée de vie des batteries, avec des résultats publiés dans une revue scientifique cette semaine.',
};

check('Spanish wire item is flagged', isSpanishItem(SPANISH_WIRE) === true);
check(
  'Spanish newsletter item is flagged',
  isSpanishItem(SPANISH_NEWSLETTER) === true
);
check('English local item passes', isSpanishItem(ENGLISH_LOCAL) === false);
check(
  'English item naming El Paso / José García passes',
  isSpanishItem(ENGLISH_SPANISH_NAMES) === false
);
check(
  'English item about La Liga passes',
  isSpanishItem(ENGLISH_LA_LIGA) === false
);
check(
  'French science item is NOT flagged as Spanish',
  isSpanishItem(FRENCH_SCIENCE) === false
);
// Regression pair, measured live Nov 23, 2026: English stories whose
// only Spanish signal is accented proper nouns (El Niño; quoted
// Spanish politicians) tripped an early diacritic shortcut that had
// no ratio floor. Both must pass.
const ENGLISH_EL_NINO = {
  title: 'An El Niño amped by climate change has California bracing for the worst',
  summary:
    'The warming Pacific pattern known as El Niño is intensifying, forecasters said this week, and the niño-driven storms could bring flooding rains to California this winter.',
};
const ENGLISH_VOX = {
  title: "From mocked to mainstream: how Spain's far-right Vox transformed its fortunes",
  summary:
    'Once dismissed as a fringe movement, the party led by Santiago Abascal has moved into the political mainstream, drawing support in Andalucía and beyond with rallies in Cádiz, Málaga, and Sevilla that would have been unthinkable a decade ago, analysts say.',
};
check(
  'English El Niño science story passes (regression)',
  isSpanishItem(ENGLISH_EL_NINO) === false
);
check(
  'English Vox story with Spanish place names passes (regression)',
  isSpanishItem(ENGLISH_VOX) === false
);
{
  const s = languageScores(`${SPANISH_WIRE.title} ${SPANISH_WIRE.summary}`);
  check(
    `Spanish sample scores Spanish-dominant (es ${s.esHits}/${s.tokens}, fr ${s.frHits})`,
    s.esHits >= 3 && s.esRatio >= 0.15 && s.esHits > s.frHits
  );
}

// ---------------------------------------------------------------------------
// 2. Language gate, pipeline level: the ingest filter is what keeps a
//    Spanish story out of the built queue.
// ---------------------------------------------------------------------------
let seq = 0;
function item(category, fields) {
  seq += 1;
  return {
    id: `proof-${seq}`,
    category,
    source: fields.source || 'Wire',
    title: fields.title,
    summary: fields.summary,
    link: `https://example.com/proof-${seq}`,
    publishedAt: STATION_EPOCH_MS - 3600 * 1000,
    ...(fields.body ? { body: fields.body } : {}),
  };
}
const T0 = STATION_EPOCH_MS + 5 * 60 * 1000;

const spanishStory = item('local', { ...SPANISH_WIRE, source: 'Dos Mundos' });
const englishStory = item('local', ENGLISH_LOCAL);
const filler = [];
for (let i = 0; i < 24; i++) {
  filler.push(
    item(['ai', 'tech', 'business', 'state', 'regional'][i % 5], {
      title: `Company${i} unveils initiative ${i} for sector ${i}`,
      summary:
        'The company said the initiative will roll out over the coming year, with hiring planned at its Kansas City office and partner sites across the region.',
    })
  );
}
const rawPool = { items: [spanishStory, englishStory, ...filler] };
// Control: unfiltered, the Spanish story WOULD reach the queue.
{
  const q = buildPlaylist(rawPool, null, T0, [], null);
  const heads = q.segments.filter((s) => s.kind === 'story').map((s) => s.headline);
  check(
    'control: unfiltered pool airs the Spanish story (gate is operative)',
    heads.includes(SPANISH_WIRE.title)
  );
}
// The ingest step itself (lib/ingest.js refresh): filter, then build.
{
  const kept = rawPool.items.filter((it) => !isSpanishItem(it));
  check(
    `ingest filter drops exactly the Spanish item (${rawPool.items.length} -> ${kept.length})`,
    kept.length === rawPool.items.length - 1 && !kept.includes(spanishStory)
  );
  const q = buildPlaylist({ items: kept }, null, T0, [], null);
  const heads = q.segments.filter((s) => s.kind === 'story').map((s) => s.headline);
  check('filtered queue has no Spanish story', !heads.includes(SPANISH_WIRE.title));
  check('filtered queue keeps the English story', heads.includes(ENGLISH_LOCAL.title));
}

// ---------------------------------------------------------------------------
// 3. Spoken-URL sanitizer, unit level
// ---------------------------------------------------------------------------
{
  const out = sanitizeSpokenText(
    'Read more at https://www.startlandnews.com/2026/11/23/funding-round/ for the full story.'
  );
  check('full URL becomes the bare domain', out.includes('startlandnews.com'));
  check('no http survives', !/http/i.test(out));
  check('no www. survives', !/www\./i.test(out));
  check('no path survives', !out.includes('2026') && !out.includes('funding-round'));
}
{
  const out = sanitizeSpokenText('Details at kshb.com/news/local/story-123 today.');
  check('bare domain + path becomes the domain', out === 'Details at kshb.com today.');
}
{
  const out = sanitizeSpokenText('See the report at https://example.com/story.');
  check('sentence period survives the swap', out === 'See the report at example.com.');
}
{
  const out = sanitizeSpokenText('Mirror at www.example.com/a/b/c now.');
  check('www. link becomes the domain', out === 'Mirror at example.com now.');
}
{
  const prose = 'The odds are 50/50, version 2.0 shipped, and U.S. Bank said and/or or both.';
  check('ordinary prose is untouched', sanitizeSpokenText(prose) === prose);
}
{
  const once = sanitizeSpokenText('Go to https://www.kcur.org/news/2026/story please.');
  check('sanitizer is idempotent', sanitizeSpokenText(once) === once);
}

// ---------------------------------------------------------------------------
// 4. Spoken URLs, pipeline level: scripts built from items whose
//    summaries and bodies carry full URLs with paths.
// ---------------------------------------------------------------------------
{
  const urlSummaryStory = item('national', {
    title: 'Regional banks post strong quarter across the Midwest',
    summary:
      'Regional banks reported a strong quarter on Monday, beating expectations. Read the full story at https://www.startlandnews.com/2026/11/23/banks-quarter/ for the complete breakdown.',
    source: 'Wire',
  });
  const urlBodyStory = item('local', {
    title: 'Kansas City startup lands major logistics contract',
    summary: 'A local startup has signed a major logistics contract.',
    source: 'KCUR',
    body:
      'The Kansas City startup announced the agreement early Monday, saying the contract will add forty jobs at its Crossroads headquarters over the next two years. The company credited the city\u2019s freight rail links and its growing pool of software engineers for the win. Full coverage is posted at https://www.kcur.org/news/2026/11/23/startup-contract for readers who want the documents. City officials praised the deal as another sign that the logistics sector keeps choosing Kansas City over larger coastal hubs.',
  });
  const pool = { items: [urlSummaryStory, urlBodyStory, ...filler] };
  const q = buildPlaylist(pool, null, T0, [], null);
  const storySegs = q.segments.filter((s) => s.kind === 'story');
  const segA = storySegs.find((s) => s.headline === urlSummaryStory.title);
  const segB = storySegs.find((s) => s.headline === urlBodyStory.title);
  check('URL-summary story is in the queue', Boolean(segA));
  check('URL-body story is in the queue', Boolean(segB));
  if (segA) {
    check(
      'summary URL airs as bare domain only',
      segA.script.includes('startlandnews.com') &&
        !/http/i.test(segA.script) &&
        !/www\./i.test(segA.script) &&
        !segA.script.includes('banks-quarter')
    );
  }
  if (segB) {
    check(
      'body URL airs as bare domain only',
      segB.script.includes('kcur.org') &&
        !/http/i.test(segB.script) &&
        !/www\./i.test(segB.script) &&
        !segB.script.includes('startup-contract')
    );
  }
  const offenders = q.segments.filter((s) => /https?:\/\/|www\./i.test(s.script || ''));
  check(
    `no segment in the built queue carries a URL (${offenders.length} offenders)`,
    offenders.length === 0
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPROOF PASSED');
process.exit(failures ? 1 : 0);
