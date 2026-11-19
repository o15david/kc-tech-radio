// Feed roster for KC Tech Radio.
//
// Coverage runs INSIDE-OUT (David's model): Kansas City and its suburbs
// first, then Missouri/Kansas state news, then the regional Midwest, then
// national wires, with world news as the outermost ring. Categories carry
// the rings: local (metro), state (MO/KS), regional (Midwest), national,
// global (world). The tech/business/AI wires cut across the rings as
// subject pools for their own shows.
//
// Every URL below was verified live during the build or the Nov 19, 2026
// expansion (HTTP 200 + valid RSS/Atom parsed by lib/rss.js + current
// items). Dropped after verification, with reasons, are listed at the
// bottom of this file and in README.md.

export const FEEDS = [
  // ---- Ring 1: Kansas City metro (local) ----------------------------------
  {
    name: 'Startland News',
    url: 'https://www.startlandnews.com/feed/',
    category: 'local',
  },
  {
    name: 'Silicon Prairie News',
    url: 'https://siliconprairienews.com/feed/',
    category: 'local',
  },
  {
    name: 'KCUR',
    url: 'https://www.kcur.org/news.rss',
    category: 'local',
  },
  {
    name: 'Flatland KC',
    url: 'https://www.flatlandkc.org/feed/',
    category: 'local',
  },
  {
    name: 'Johnson County Post',
    url: 'https://johnsoncountypost.com/feed/',
    category: 'local',
  },
  {
    name: 'Kansas City Magazine',
    url: 'https://www.kansascitymag.com/feed/',
    category: 'local',
  },
  {
    name: 'The Pitch KC',
    url: 'https://www.thepitchkc.com/feed/',
    category: 'local',
  },

  // ---- Ring 2: Missouri & Kansas state news (state) ------------------------
  {
    name: 'Missouri Independent',
    url: 'https://missouriindependent.com/feed/',
    category: 'state',
  },
  {
    name: 'Kansas Reflector',
    url: 'https://kansasreflector.com/feed/',
    category: 'state',
  },
  {
    name: 'Missourinet',
    url: 'https://www.missourinet.com/feed/',
    category: 'state',
  },

  // ---- Ring 3: Regional Midwest (regional) ---------------------------------
  {
    name: 'Iowa Capital Dispatch',
    url: 'https://iowacapitaldispatch.com/feed/',
    category: 'regional',
  },
  {
    name: 'Nebraska Examiner',
    url: 'https://nebraskaexaminer.com/feed/',
    category: 'regional',
  },
  {
    name: 'Minnesota Reformer',
    url: 'https://minnesotareformer.com/feed/',
    category: 'regional',
  },
  {
    name: 'Oklahoma Voice',
    url: 'https://oklahomavoice.com/feed/',
    category: 'regional',
  },
  {
    name: 'Arkansas Advocate',
    url: 'https://arkansasadvocate.com/feed/',
    category: 'regional',
  },
  {
    name: 'Indiana Capital Chronicle',
    url: 'https://indianacapitalchronicle.com/feed/',
    category: 'regional',
  },
  {
    name: 'Capitol News Illinois',
    url: 'https://capitolnewsillinois.com/feed/',
    category: 'regional',
  },

  // ---- Artificial intelligence (subject pool) -------------------------------
  {
    name: 'TechCrunch AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    category: 'ai',
  },
  {
    name: 'MIT Technology Review',
    url: 'https://www.technologyreview.com/feed/',
    category: 'ai',
  },
  {
    name: 'OpenAI Blog',
    url: 'https://openai.com/blog/rss.xml',
    category: 'ai',
  },
  {
    name: 'Google DeepMind',
    url: 'https://deepmind.google/blog/rss.xml',
    category: 'ai',
  },
  {
    name: 'Google AI Blog',
    url: 'https://blog.google/technology/ai/rss/',
    category: 'ai',
  },
  {
    name: 'NVIDIA Blog',
    url: 'https://blogs.nvidia.com/feed/',
    category: 'ai',
  },
  {
    name: 'AWS Machine Learning Blog',
    url: 'https://aws.amazon.com/blogs/machine-learning/feed/',
    category: 'ai',
  },
  {
    name: 'The Decoder',
    url: 'https://the-decoder.com/feed/',
    category: 'ai',
  },
  {
    name: 'MarkTechPost',
    url: 'https://www.marktechpost.com/feed/',
    category: 'ai',
  },

  // ---- General tech (subject pool) -------------------------------------------
  {
    name: 'TechCrunch',
    url: 'https://techcrunch.com/feed/',
    category: 'tech',
  },
  {
    name: 'The Verge',
    url: 'https://www.theverge.com/rss/index.xml',
    category: 'tech',
  },
  {
    name: 'Ars Technica',
    url: 'https://feeds.arstechnica.com/arstechnica/index',
    category: 'tech',
  },
  {
    name: 'Hacker News',
    url: 'https://news.ycombinator.com/rss',
    category: 'tech',
  },
  {
    name: 'Wired',
    url: 'https://www.wired.com/feed/rss',
    category: 'tech',
  },
  {
    name: 'Engadget',
    url: 'https://www.engadget.com/rss.xml',
    category: 'tech',
  },
  {
    name: 'NYT Technology',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',
    category: 'tech',
  },
  {
    name: 'Fast Company',
    url: 'https://www.fastcompany.com/rss',
    category: 'tech',
  },
  {
    name: 'CNBC Technology',
    url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html',
    category: 'tech',
  },

  // ---- Business (subject pool) -------------------------------------------------
  {
    name: 'CNBC',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    category: 'business',
  },
  {
    name: 'MarketWatch',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
    category: 'business',
  },
  {
    name: 'Fortune',
    url: 'https://fortune.com/feed/',
    category: 'business',
  },
  {
    name: 'Bloomberg Technology',
    url: 'https://feeds.bloomberg.com/technology/news.rss',
    category: 'business',
  },

  // ---- Ring 4: National (national) ----------------------------------------------
  {
    name: 'NPR News',
    url: 'https://feeds.npr.org/1001/rss.xml',
    category: 'national',
  },
  {
    name: 'The Hill',
    url: 'https://thehill.com/feed/',
    category: 'national',
  },
  {
    name: 'PBS NewsHour',
    url: 'https://www.pbs.org/newshour/feeds/rss/headlines',
    category: 'national',
  },
  {
    name: 'CBS News',
    url: 'https://www.cbsnews.com/latest/rss/main',
    category: 'national',
  },
  {
    name: 'NBC News',
    url: 'https://feeds.nbcnews.com/nbcnews/public/news',
    category: 'national',
  },
  {
    name: 'ABC News',
    url: 'https://abcnews.go.com/abcnews/topstories',
    category: 'national',
  },
  {
    name: 'NYT Home Page',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    category: 'national',
  },
  {
    name: 'Axios',
    url: 'https://www.axios.com/feeds/feed.rss',
    category: 'national',
  },

  // ---- Ring 5: World (global) ------------------------------------------------------
  {
    name: 'BBC World',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    category: 'global',
  },
  {
    name: 'Al Jazeera',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    category: 'global',
  },
  {
    name: 'The Guardian World',
    url: 'https://www.theguardian.com/world/rss',
    category: 'global',
  },
  {
    name: 'DW News',
    url: 'https://rss.dw.com/rdf/rss-en-all',
    category: 'global',
  },
  {
    name: 'France 24',
    url: 'https://www.france24.com/en/rss',
    category: 'global',
  },
  {
    name: 'CBC World',
    url: 'https://www.cbc.ca/webfeed/rss/rss-world',
    category: 'global',
  },
  {
    name: 'Sky News World',
    url: 'https://feeds.skynews.com/feeds/rss/world.xml',
    category: 'global',
  },
  {
    name: 'UN News',
    url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml',
    category: 'global',
  },
  {
    name: 'SCMP World',
    url: 'https://www.scmp.com/rss/91/feed',
    category: 'global',
  },
];

export const CATEGORIES = [
  'local',
  'state',
  'regional',
  'ai',
  'tech',
  'business',
  'national',
  'global',
  'newsletter',
  'music',
];

// ---------------------------------------------------------------------------
// Attempted but dropped during verification (Nov 19, 2026 expansion):
//   - Kansas City Business Journal: RSS endpoint returns 403 (bot wall).
//   - AP News: no public RSS feed; apnews.com/rss returns 403.
//   - KC Star (kansascity.com /news/ and /news/local/ ?output=1): requests
//     time out; no working public RSS.
//   - Shawnee Mission Post: feed fetch fails (connection error, retried).
//   - Northeast News KC: /feed/ and /rss/ both 404.
//   - Kansas City Beacon: feed fetch fails (connection error).
//   - KCUR politics feed (kcur.org/politics.rss): 404; KCUR's main news
//     feed (above) already carries its statehouse coverage.
//   - St. Louis Post-Dispatch (stltoday.com/rss): 200 but 0 items parsed.
//   - St. Louis Public Radio (stlpr.org/rss.xml): 404.
//   - USA Today top stories RSS: requests time out.
//   - Washington Post National: parsed with current items in an isolated
//     probe, but consistently exceeds the station's 9s fetch timeout in
//     situ (two consecutive refreshes), so it is not a reliable wire.
//   - WSJ via Dow Jones (feeds.a.dj.com/rss/RSSWSJD.xml): parses, but the
//     newest item is ~22 months old; a frozen snapshot, not a live wire.
//   - Anthropic: no RSS (anthropic.com/rss.xml is 404).
//   - Meta AI blog: ai.meta.com/blog/rss/ returns HTTP 400; no feed.
//   - VentureBeat AI: HTTP 429 (rate/bot wall).
//   - AI News (artificialintelligence-news.com/feed/): 0 items parsed.
//   - Hugging Face blog: parses, but carries no usable summaries and is
//     dominated by community model-upload posts, not editorial coverage.
//   - Google Research blog: parses, but only ~4% of items carry a summary
//     and the cadence is sparse; DeepMind + Google AI blogs cover Google.
//   - arXiv cs.AI: parses, but it is a daily firehose of academic paper
//     abstracts (360+ items/day) that would flood the AI pool and crowd
//     out industry coverage. Not headline radio.
//   - Reuters top news (feeds.reuters.com): connection fails; Reuters
//     discontinued its public RSS years ago.
// Verified live but held back for scope: Wisconsin Examiner, Ohio Capital
// Journal, South Dakota Searchlight, North Dakota Monitor, and Bridge
// Michigan all parse with current items, but they sit outside the
// KC-centric Midwest ring and the States Newsroom wires already duplicate
// heavily across state sites; seven regional outlets is the right depth.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Assistant-generated JSON feeds.
//
// Two sources do not exist as public RSS: David's newsletter inbox and his
// KC show watches. Both are prepared OUTSIDE Vercel by the assistant and
// published as small JSON documents; the station fetches them exactly like
// RSS feeds (same cache, same forgiving failure handling: unreachable or
// empty means zero items, never an error).
//
// Contracts are documented in README.md ("Newsletter pipeline" and
// "Music feed"). The defaults point at the copies in this repo's data/
// folder on GitHub; override with env vars to point anywhere else.
// ---------------------------------------------------------------------------

export const NEWSLETTER_FEED = {
  name: 'Newsletters',
  category: 'newsletter',
  url:
    process.env.NEWSLETTER_FEED_URL ||
    'https://raw.githubusercontent.com/o15david/kc-tech-radio/main/data/newsletter-feed.json',
};

export const MUSIC_FEED = {
  name: 'KC Music Feed',
  category: 'music',
  url:
    process.env.MUSIC_FEED_URL ||
    'https://raw.githubusercontent.com/o15david/kc-tech-radio/main/data/music-feed.json',
};

export const JSON_FEEDS = [NEWSLETTER_FEED, MUSIC_FEED];
