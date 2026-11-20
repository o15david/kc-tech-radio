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
    // A named entity outside the table is markup, not prose: drop it
    // rather than pass it through. A surviving "&word;" (or a truncated
    // "&word" whose semicolon a wire cut) is not just ugly in a script,
    // it is poison: a bare & makes Edge TTS close the synthesis stream
    // on every attempt (see speechSafeText in lib/tts.js).
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : '',
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

/**
 * Guarantee a composed story body ends with terminal punctuation, so
 * the source sign-off never runs straight into an unpunctuated final
 * clause ("...was denied parole again From ABC News."). Appends a
 * period when the text ends in an alphanumeric character or a closing
 * quote/bracket with no terminal punctuation behind it; a dangling
 * clause punctuation mark (comma, semicolon, colon) is dropped first.
 * Text already ending in . ! ? … (optionally behind closing quotes)
 * is returned untouched: punctuation is never doubled.
 */
export function ensureTerminalPunctuation(text) {
  if (!text) return '';
  let s = String(text).trim();
  if (!s) return s;
  if (/[.!?…]["'”’)\]]*$/.test(s)) return s;
  s = s.replace(/[,;:]+$/, '');
  if (/[.!?…]["'”’)\]]*$/.test(s)) return s;
  if (/[A-Za-z0-9"'”’)\]]$/.test(s)) return `${s}.`;
  return s;
}

/**
 * Strip HTML tags and collapse whitespace; used on titles and summaries.
 * Entities are decoded FIRST: feeds that escape their markup
 * ("&lt;p&gt;") would otherwise resurrect live tags after the strip
 * and leak them into scripts ("...against Schumer. <p>Sen."). After the
 * complete-tag strip, a trailing unterminated tag fragment (a "<p" or
 * "<div class=" left by a wire that truncated mid-tag) is removed too.
 * Finally, dangling entity fragments are stripped: a wire that
 * truncates "&nbsp;" mid-entity (or typo'd it as "&nbsp.") leaves a
 * semicolon-less "&word" the decoder cannot match, and it must never
 * reach a script (see decodeEntities). The pattern requires at least
 * two characters after the &, so genuine prose ampersands survive:
 * "AT&T", "R&D", "M&M's", "Q&A" are all untouched.
 */
export function cleanText(raw) {
  if (!raw) return '';
  const cleaned = decodeEntities(String(raw))
    .replace(/<[^>]*>/g, ' ')
    .replace(/<\/?[a-zA-Z!][^>]*$/, ' ')
    .replace(/&(?:[a-zA-Z][a-zA-Z0-9]{1,9}|#[0-9]{1,5}|#[xX][0-9a-fA-F]{1,4});?(?![\w=])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Semicolon artifacts (seen live in UN News summaries, Nov 19):
  // wires that join phrases with a bare ";" and no following space
  // ("assisting;thousands;of", "weekend,;where") leave text the TTS
  // reads as a string of odd pauses. A semicolon jammed against a word
  // character on either side is a separator artifact, not punctuation:
  // normalize it to ", ". Legitimate "; " prose usage (semicolon,
  // space, word) is preserved. A lone URL is exempt: semicolons are
  // legal inside a link and links are not prose.
  if (/^https?:\/\/\S+$/i.test(cleaned)) return cleaned;
  return cleaned
    .replace(/,;|;,/g, ', ')
    .replace(/(\w);(?=\w)/g, '$1, ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Headline tokenization for topic-level dedupe (used by lib/ingest.js)
//
// The same syndicated story reaches the pool from several outlets with
// near-identical headlines (a States Newsroom story ran on four state
// sites with the same headline). Similarity is measured on significant
// tokens: lowercased, punctuation stripped, stopwords removed, and the
// source's own name tokens removed (an outlet's name in its headlines
// is branding, not story content). This is the exact normalization the
// Nov 19 repeat investigation measured the pool with.
// ---------------------------------------------------------------------------

const HEADLINE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'as',
  'at', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'this', 'that', 'after', 'over', 'under', 'into', 'about', 'says', 'say',
  'said', 'will', 'can', 'has', 'have', 'had', 'new', 'how', 'why', 'what',
  'who', 'when', 'more', 'than', 'but', 'not', 'his', 'her', 'their', 'they',
  'them', 'he', 'she', 'we', 'you', 'your', 'our', 'one', 'two', 'first',
]);

/** Significant-token set for a headline (see the note above). */
export function headlineTokens(title, source) {
  let t = String(title || '').toLowerCase().normalize('NFKD');
  t = t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  // Strip a short trailing outlet/section suffix after a spaced separator.
  for (const sep of [' | ', ' – ', ' — ', ' - ']) {
    const idx = t.lastIndexOf(sep);
    if (idx > 0) {
      const tail = t.slice(idx + sep.length).trim();
      if (tail && tail.split(/\s+/).length <= 4) { t = t.slice(0, idx); break; }
    }
  }
  const sourceTokens = new Set(
    String(source || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
  const tokens = t
    .split(/[^a-z0-9]+/)
    .filter((w) => w && (w.length >= 3 || /^\d+$/.test(w)))
    .filter((w) => !HEADLINE_STOPWORDS.has(w))
    .filter((w) => !sourceTokens.has(w));
  return new Set(tokens);
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
 * { title, link, summary, publishedAt (ms epoch | null), guid, content }
 *
 * `content` is the feed's own full-article markup when the wire
 * carries it (RSS <content:encoded>, Atom <content>), RAW (entities
 * undecoded, tags intact): lib/article.js extracts the article's
 * paragraphs from it at ingest time. It is '' when the feed carries
 * no full content, which is most wires; callers must not air it raw.
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

    // Full content, when the wire carries it (see the note above).
    // Kept raw for the article extractor; capped so one pathological
    // feed cannot park megabytes per item in the pool.
    const content = (
      tagText(raw, 'content:encoded') || (atom ? tagText(raw, 'content') : '')
    ).slice(0, 120000);

    items.push({ title, link, summary, publishedAt, guid, content });
  }
  return items;
}
