// Language gate (David, Nov 23, 2026): Spanish-language stories must
// not air. KC Tech Radio is an English-language station; a Spanish wire
// item in the pool (the local Spanish-language paper Dos Mundos is the
// standing example) otherwise reaches the queue and is read aloud in
// Spanish by an English voice.
//
// Detection is deterministic and dependency-light: a stopword scorer
// over the item's title + summary. Spanish function words (el, la, de,
// que, en, los, ...) make up a large, stable share of any real Spanish
// text and a tiny share of English text, so the signal is strong even
// in a headline-length sample. Two guards keep the false-positive rate
// at zero for the pool this station actually carries:
//
//   - ENGLISH WITH SPANISH NAMES passes: an English story that merely
//     mentions El Paso, La Liga, or a Spanish-named official scores
//     one or two hits at a low ratio, far under the bar.
//   - FRENCH is not Spanish: CNRS News and France 24's French copy
//     share a few function words with Spanish (de, la, en, les), so a
//     French-distinct stopword score is computed alongside; when the
//     French score beats the Spanish score the item is not flagged.
//
// The bar: at least 3 Spanish stopword hits AND at least 15% of all
// tokens, with the Spanish score strictly ahead of the French score;
// or the diacritic shortcut (at least 2 of á í ó ú ñ ¿ ¡, characters
// French essentially never uses, alongside at least 2 stopword hits
// AND a 10% stopword ratio). The ratio floor on the shortcut matters:
// measured live Nov 23, 2026, an English Science News story about
// El Niño (3 hits, 8% ratio, 3 diacritics from "niño") and an English
// Guardian story on Spain's Vox party (2 hits, 1% ratio, 4 diacritics
// from quoted Spanish names) both tripped the shortcut without it.
// English-with-Spanish-names is exactly what must keep passing.

const SPANISH_STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del',
  'en', 'y', 'o', 'que', 'es', 'son', 'está', 'están', 'con', 'por',
  'para', 'como', 'más', 'pero', 'su', 'sus', 'al', 'lo', 'le', 'les',
  'se', 'ha', 'han', 'fue', 'fueron', 'será', 'serán', 'también',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'cuando', 'donde', 'quien', 'quienes', 'sobre', 'entre', 'hasta',
  'desde', 'sin', 'tras', 'durante', 'contra', 'según', 'ante',
  'hacia', 'muy', 'ya', 'él', 'ella', 'ellos', 'ellas', 'nosotros',
  'mi', 'mis', 'tu', 'tus', 'esto', 'eso', 'aquel', 'aquella',
  'otro', 'otra', 'otros', 'otras', 'cada', 'todo', 'toda', 'todos',
  'todas', 'si', 'así', 'aunque', 'porque', 'cuando', 'mientras',
  'luego', 'después', 'antes', 'ahora', 'hoy', 'ayer', 'año', 'años',
  'día', 'días', 'vez', 'veces', 'parte', 'gobierno', 'ciudad',
  'país', 'estado', 'estados', 'nuevo', 'nueva', 'nuevos', 'nuevas',
  'mayor', 'menor', 'primer', 'primera', 'último', 'última', 'dijo',
  'dice', 'hacer', 'hace', 'hacen', 'tener', 'tiene', 'puede',
  'pueden', 'debe', 'deben', 'estar', 'están', 'ser', 'somos',
]);

// French function words, used only as the not-Spanish tiebreak
// described above. Mostly French-only; the few that are also Spanish
// (les) count for both scores.
const FRENCH_DISTINCT_STOPWORDS = new Set([
  'le', 'les', 'des', 'une', 'est', 'dans', 'pour', 'avec', 'aux',
  'du', 'ce', 'cette', 'chez', 'plus', 'sont', 'être', 'ont', 'qui',
  'au', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'leur', 'leurs',
  'par', 'pas', 'sur', 'sous', 'entre', 'aussi', 'mais', 'ou', 'où',
  'donc', 'alors', 'après', 'avant', 'chez', 'même', 'tous', 'toute',
  'toutes', 'faire', 'fait', 'ans', 'jour', 'jours', 'nouveau',
  'nouvelle', 'premier', 'première', 'état', 'ville', 'pays',
]);

const SPANISH_DIACRITICS = /[áíóúñ¿¡]/g;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Score a text sample: how Spanish (and, for the tiebreak, how
 * French) it reads. Exported for proofs and health reporting.
 */
export function languageScores(text) {
  const tokens = tokenize(text);
  let esHits = 0;
  let frHits = 0;
  // Independent counts: a handful of words (les, de, la) are function
  // words in BOTH languages and honestly count for both; the French
  // guard works because a French text also carries many French-only
  // words (le, une, est, pour, dans, ...) that Spanish never uses.
  for (const t of tokens) {
    if (SPANISH_STOPWORDS.has(t)) esHits += 1;
    if (FRENCH_DISTINCT_STOPWORDS.has(t)) frHits += 1;
  }
  const diacritics = (String(text || '').match(SPANISH_DIACRITICS) || []).length;
  return {
    tokens: tokens.length,
    esHits,
    frHits,
    diacritics,
    esRatio: tokens.length ? esHits / tokens.length : 0,
  };
}

/** True when the text is Spanish-dominant by the rule above. */
export function isSpanishText(text) {
  const s = languageScores(text);
  if (s.esHits <= s.frHits) return false;
  if (s.esHits >= 3 && s.esRatio >= 0.15) return true;
  if (s.diacritics >= 2 && s.esHits >= 2 && s.esRatio >= 0.1) return true;
  return false;
}

/**
 * True when a pool item (title + summary) is Spanish-language.
 * Music listings carry no summary prose of their own and their
 * titles are artist/venue names; they are scored the same way and
 * pass trivially (a Spanish artist name alone is one or two hits,
 * far under the bar).
 */
export function isSpanishItem(item) {
  if (!item) return false;
  return isSpanishText(`${item.title || ''} ${item.summary || ''}`);
}
