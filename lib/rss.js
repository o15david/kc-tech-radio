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
