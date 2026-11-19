// Minimal, dependency-free RSS 2.0 + Atom parser.
//
// We deliberately avoid an XML library: the station only needs five fields
// per item (title, link, summary, date, guid), feeds are well-formed in
// practice, and fewer dependencies means fewer surprises on Vercel.
// The parser is forgiving: a malformed feed yields [] rather than throwing,
// so one bad source can never take the station off the air.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text) {
  if (!text) return '';
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : m,
    );
}

function safeCodePoint(n) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Sentence boundaries (used wherever a summary is cut to length)
//
// Radio scripts must never end mid-clause: a hard character cut leaves a
// listener hearing "...with more than 10,000 GPUs, delivering" or "But
// an...". trimToSentenceBoundary() is the one rule every trim site uses:
// cut at the last complete sentence that fits the budget; if no complete
// sentence fits, take the first complete sentence of the full text (even
// though it runs past the budget); if the text has no sentence boundary
// at all, return it whole rather than severing it mid-word.
// ---------------------------------------------------------------------------

// Words whose trailing period is not a sentence end (honorifics, Latin
// abbreviations, initialisms, month names). Cutting after one of these
// would end a script mid-thought behind a period that looks like an
// ending: "...in the U.S." is not a complete sentence.
const NON_TERMINAL_WORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'jr', 'sr', 'inc', 'corp',
  'ltd', 'no', 'fig', 'approx', 'dept', 'est', 'e.g', 'i.e', 'a.m', 'p.m',
  'u.s', 'u.k', 'u.n', 'd.c', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
  'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

/**
 * End offsets (index just past the punctuation and any closing quotes)
 * of every complete sentence in `text`. A boundary is a run of terminal
 * punctuation (. ! ?), optionally followed by closing quotes/brackets,
 * followed by whitespace or the end of the text, whose preceding word
 * is not a known non-terminal abbreviation. Decimals ("3.5 percent")
 * never match: their period is followed by a digit, not whitespace.
 */
export function sentenceEndPositions(text) {
  const ends = [];
  const re = /[.!?]+["'”’)\]]*(?=\s|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const wordMatch = /([A-Za-z][A-Za-z.]*)$/.exec(text.slice(0, m.index));
    const word = wordMatch ? wordMatch[1].toLowerCase() : '';
    // A lone initial ("option A.") is not a sentence end either.
    if (word && (NON_TERMINAL_WORDS.has(word) || /^[a-z](\.[a-z])*$/.test(word))) {
      continue;
    }
    ends.push(m.index + m[0].length);
  }
  return ends;
}

/** End offset of the last complete sentence in `text`, or 0 if none. */
export function lastSentenceEnd(text) {
  const ends = sentenceEndPositions(text);
  return ends.length ? ends[ends.length - 1] : 0;
}

/** Trim `text` to at most `maxChars`, at a sentence boundary (see above). */
export function trimToSentenceBoundary(text, maxChars) {
  if (!text) return '';
  const s = String(text).trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const inBudget = lastSentenceEnd(cut);
  if (inBudget > 0) return cut.slice(0, inBudget).trim();
  const ends = sentenceEndPositions(s);
  if (ends.length) return s.slice(0, ends[0]).trim();
  return s;
}

/** Strip HTML tags and collapse whitespace; used on titles and summaries. */
export function cleanText(raw) {
  if (!raw) return '';
  return decodeEntities(String(raw).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapCdata(text) {
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(text || '');
  return m ? m[1] : text || '';
}

/** Return the inner text of the first <tag>...</tag> in a block, or ''. */
function tagText(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  return m ? unwrapCdata(m[1]) : '';
}

/** Atom links are attributes: <link rel="alternate" href="..."/>. */
function atomLink(block) {
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  for (const link of links) {
    const rel = /rel="([^"]*)"/i.exec(link)?.[1];
    if (rel && rel !== 'alternate') continue;
    const href = /href="([^"]*)"/i.exec(link)?.[1];
    if (href) return href;
  }
  return '';
}

function parseDate(text) {
  if (!text) return null;
  const t = Date.parse(text.trim());
  return Number.isNaN(t) ? null : t;
}

/**
 * Parse an RSS or Atom document into normalized items:
 * { title, link, summary, publishedAt (ms epoch | null), guid }
 */
export function parseFeed(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];

  // RSS 2.0: <item> blocks. Atom: <entry> blocks.
  const blocks = [
    ...[...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => ({
      raw: m[0],
      atom: false,
    })),
    ...[...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => ({
      raw: m[0],
      atom: true,
    })),
  ];

  for (const { raw, atom } of blocks) {
    const title = cleanText(tagText(raw, 'title'));
    const link = atom
      ? atomLink(raw)
      : cleanText(tagText(raw, 'link')) || cleanText(tagText(raw, 'guid'));
    if (!title || !link) continue;

    const summary = cleanText(
      tagText(raw, 'description') ||
        tagText(raw, 'summary') ||
        tagText(raw, 'content'),
    );
    const publishedAt = parseDate(
      tagText(raw, 'pubDate') ||
        tagText(raw, 'published') ||
        tagText(raw, 'updated') ||
        tagText(raw, 'dc:date'),
    );
    const guid =
      cleanText(tagText(raw, 'guid')) || cleanText(tagText(raw, 'id')) || link;

    items.push({ title, link, summary, publishedAt, guid });
  }
  return items;
}
