// Feed roster for KC Tech Radio.
//
// Every URL below was verified live during the build (HTTP 200 + real items).
// Dropped after verification:
//   - Kansas City Business Journal RSS: returns 403 (bot wall) to non-browser clients.
//   - AP News: no public RSS feed; apnews.com/rss returns 403.
// Categories drive the format clock: local, ai, tech, business, global.

export const FEEDS = [
  // ---- Kansas City / regional: local tech & business -----------------------
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

  // ---- Artificial intelligence ---------------------------------------------
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

  // ---- General tech ----------------------------------------------------------
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

  // ---- Business ---------------------------------------------------------------
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

  // ---- Global / world -----------------------------------------------------------
  {
    name: 'BBC World',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    category: 'global',
  },
  {
    name: 'NPR News',
    url: 'https://feeds.npr.org/1001/rss.xml',
    category: 'global',
  },
  {
    name: 'Al Jazeera',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    category: 'global',
  },
];

export const CATEGORIES = ['local', 'ai', 'tech', 'business', 'global'];
