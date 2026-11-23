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
  // Local TV news wires (verified Nov 19, 2026, evening expansion). Their
  // top-stories feeds mix metro reporting with some national wire copy;
  // that is the nature of a local station's wire, and topic dedupe plus
  // the entity budget keep it from piling up.
  {
    name: 'KSHB 41',
    url: 'https://www.kshb.com/news.rss',
    category: 'local',
  },
  {
    name: 'KMBC 9',
    url: 'https://www.kmbc.com/topstories-rss',
    category: 'local',
  },
  {
    name: 'KCTV5',
    url: 'https://www.kctv5.com/arc/outboundfeeds/rss/',
    category: 'local',
  },
  {
    name: 'FOX 4 KC',
    url: 'https://fox4kc.com/feed/',
    category: 'local',
  },
  {
    name: 'Kansas City Defender',
    url: 'https://kansascitydefender.com/feed/',
    category: 'local',
  },
  {
    name: 'KC Studio',
    url: 'https://kcstudio.org/feed/',
    category: 'local',
  },
  {
    name: 'Martin City Telegraph',
    url: 'https://martincitytelegraph.com/feed/',
    category: 'local',
  },
  {
    name: 'Downtown KC',
    url: 'https://www.downtownkc.org/feed/',
    category: 'local',
  },
  {
    name: 'Dos Mundos',
    url: 'https://dosmundos.com/feed/',
    category: 'local',
  },
  // Kansas City sports: team wires plus the SB Nation community sites.
  // The Royals' MLB feed carries headlines with almost no summaries;
  // its items lean on the full-depth body extraction like every other
  // local story.
  {
    name: 'Kansas City Chiefs',
    url: 'https://www.chiefs.com/news/rss',
    category: 'local',
  },
  {
    name: 'Kansas City Royals',
    url: 'https://www.mlb.com/royals/feeds/news/rss.xml',
    category: 'local',
  },
  {
    name: 'Arrowhead Pride',
    url: 'https://www.arrowheadpride.com/rss/index.xml',
    category: 'local',
  },
  {
    name: 'Royals Review',
    url: 'https://www.royalsreview.com/rss/index.xml',
    category: 'local',
  },
  {
    name: 'KC Soccer Journal',
    url: 'https://kcsoccerjournal.com/feed/',
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
  {
    name: 'KY3 Springfield',
    url: 'https://www.ky3.com/arc/outboundfeeds/rss/',
    category: 'state',
  },
  // Missouri and Kansas college sports (SB Nation community sites).
  {
    name: 'Rock M Nation',
    url: 'https://www.rockmnation.com/rss/index.xml',
    category: 'state',
  },
  {
    name: 'Rock Chalk Talk',
    url: 'https://www.rockchalktalk.com/rss/index.xml',
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
  // Added Nov 19, 2026 (evening): regional sits in the station's
  // expanded-depth tier, so the upper Midwest gets real depth: the
  // Great Lakes States Newsroom wires, Michigan's nonprofit wire, and
  // a Chicago neighborhood newsroom (Chicago previously had no voice
  // in this ring at all).
  {
    name: 'Wisconsin Examiner',
    url: 'https://wisconsinexaminer.com/feed/',
    category: 'regional',
  },
  {
    name: 'Ohio Capital Journal',
    url: 'https://ohiocapitaljournal.com/feed/',
    category: 'regional',
  },
  {
    name: 'Michigan Advance',
    url: 'https://michiganadvance.com/feed/',
    category: 'regional',
  },
  {
    name: 'Bridge Michigan',
    url: 'https://www.bridgemi.com/feed/',
    category: 'regional',
  },
  {
    name: 'Block Club Chicago',
    url: 'https://blockclubchicago.org/feed/',
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

  // ---- Science (subject pool; counts inside the 65% band, David, Nov 21, 2026) --
  // Verified live Nov 21, 2026 (HTTP 200 + valid RSS/Atom). Science,
  // research, and discoveries sit in the tech band for the mix and in
  // the full-depth tier (lib/article.js science classifier).
  {
    name: 'ScienceDaily',
    url: 'https://www.sciencedaily.com/rss/all.xml',
    category: 'science',
  },
  {
    name: 'Phys.org',
    url: 'https://phys.org/rss-feed/',
    category: 'science',
  },
  {
    name: 'NASA',
    url: 'https://www.nasa.gov/news-release/feed/',
    category: 'science',
  },
  {
    name: 'Live Science',
    url: 'https://www.livescience.com/feeds/all',
    category: 'science',
  },
  {
    name: 'Quanta Magazine',
    url: 'https://api.quantamagazine.org/feed/',
    category: 'science',
  },
  {
    name: 'Science News',
    url: 'https://www.sciencenews.org/feed',
    category: 'science',
  },

  // ---- Harvest expansion (Nov 21, 2026, no-repeats ruling: harvest more) ------
  // Developer and security wires, verified live Nov 21, 2026 the same
  // way. Import AI is Jack Clark's research newsletter as a feed; it
  // files under ai.
  {
    name: 'GitHub Blog',
    url: 'https://github.blog/feed/',
    category: 'tech',
  },
  {
    name: 'Cloudflare Blog',
    url: 'https://blog.cloudflare.com/rss/',
    category: 'tech',
  },
  {
    name: 'InfoQ',
    url: 'https://feed.infoq.com/',
    category: 'tech',
  },
  {
    name: 'Changelog',
    url: 'https://changelog.com/feed',
    category: 'tech',
  },
  {
    name: 'Lobsters',
    url: 'https://lobste.rs/rss',
    category: 'tech',
  },
  {
    name: 'Krebs on Security',
    url: 'https://krebsonsecurity.com/feed/',
    category: 'tech',
  },
  {
    name: 'Schneier on Security',
    url: 'https://www.schneier.com/feed/',
    category: 'tech',
  },
  {
    name: 'Import AI',
    url: 'https://importai.substack.com/feed',
    category: 'ai',
  },
  // Source expansion, Nov 21, 2026: 65 feeds verified live by the expansion
  // pass and staged in data/source-expansion-2026-11-21.json, merged here
  // deduped by URL. Science counts inside the 65% band (David's ruling).
  { name: 'STAT', url: 'https://www.statnews.com/feed/', category: 'science' },
  { name: 'Nature', url: 'https://www.nature.com/nature.rss', category: 'science' },
  { name: 'ZME Science', url: 'https://www.zmescience.com/feed', category: 'science' },
  { name: 'Futurity', url: 'https://www.futurity.org/feed', category: 'science' },
  { name: 'Sci.News', url: 'https://www.sci.news/feed', category: 'science' },
  { name: 'Retraction Watch', url: 'https://retractionwatch.com/feed', category: 'science' },
  { name: 'Space.com', url: 'https://www.space.com/feeds.xml', category: 'science' },
  { name: 'EarthSky', url: 'https://earthsky.org/feed', category: 'science' },
  { name: 'Nautilus', url: 'https://nautil.us/feed', category: 'science' },
  { name: 'Undark', url: 'https://undark.org/feed', category: 'science' },
  { name: 'Physics World', url: 'https://physicsworld.com/feed', category: 'science' },
  { name: 'ScienceAlert', url: 'https://www.sciencealert.com/feed', category: 'science' },
  { name: 'Daily Galaxy', url: 'https://dailygalaxy.com/feed', category: 'science' },
  { name: 'Eos', url: 'https://eos.org/feed', category: 'science' },
  { name: 'Knowable Magazine', url: 'https://knowablemagazine.org/rss', category: 'science' },
  { name: 'NSF News', url: 'https://www.nsf.gov/rss/rss_www_news.xml', category: 'science' },
  { name: 'Columbia Climate School', url: 'https://news.climate.columbia.edu/feed', category: 'science' },
  { name: 'Lake Scientist', url: 'https://www.lakescientist.com/feed', category: 'science' },
  { name: 'CNRS News', url: 'https://news.cnrs.fr/rss', category: 'science' },
  { name: 'Society for Science', url: 'https://www.societyforscience.org/blog/feed', category: 'science' },
  { name: 'Science News Explores', url: 'https://www.snexplores.org/feed', category: 'science' },
  { name: 'MIT News', url: 'https://news.mit.edu/rss/feed', category: 'science' },
  { name: 'Yale Climate Connections', url: 'https://yaleclimateconnections.org/feed/', category: 'science' },
  { name: 'Grist', url: 'https://grist.org/feed/', category: 'science' },
  { name: 'Inside Climate News', url: 'https://insideclimatenews.org/feed/', category: 'science' },
  { name: 'Mizzou News', url: 'https://news.missouri.edu/feed/', category: 'science' },
  { name: 'WashU Source', url: 'https://source.washu.edu/feed/', category: 'science' },
  { name: 'Fermilab News', url: 'https://news.fnal.gov/feed/', category: 'science' },
  { name: 'Universe Today', url: 'https://www.universetoday.com/feed', category: 'science' },
  { name: 'Sifted', url: 'https://sifted.eu/feed', category: 'tech' },
  { name: 'Rest of World', url: 'https://restofworld.org/feed/latest/', category: 'tech' },
  { name: 'Spaceflight Now', url: 'https://spaceflightnow.com/feed/', category: 'tech' },
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/', category: 'tech' },
  { name: 'Techdirt', url: 'https://www.techdirt.com/feed', category: 'tech' },
  { name: 'The Register', url: 'https://www.theregister.com/headlines.atom', category: 'tech' },
  { name: 'Hackaday', url: 'https://hackaday.com/blog/feed/', category: 'tech' },
  { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml', category: 'tech' },
  { name: 'The New Stack', url: 'https://thenewstack.io/feed/', category: 'tech' },
  { name: '404 Media', url: 'https://www.404media.co/rss/', category: 'tech' },
  { name: 'Platformer', url: 'https://www.platformer.news/feed', category: 'tech' },
  { name: 'Stratechery', url: 'https://stratechery.com/feed/', category: 'tech' },
  { name: 'Daring Fireball', url: 'https://daringfireball.net/feeds/main', category: 'tech' },
  { name: 'EE Times', url: 'https://www.eetimes.com/feed/', category: 'tech' },
  { name: 'Semiconductor Engineering', url: 'https://semiengineering.com/feed/', category: 'tech' },
  { name: 'Electrek', url: 'https://electrek.co/feed/', category: 'tech' },
  { name: 'CleanTechnica', url: 'https://cleantechnica.com/feed/', category: 'tech' },
  { name: 'Canary Media', url: 'https://www.canarymedia.com/feed/', category: 'tech' },
  { name: 'PV Magazine', url: 'https://www.pv-magazine.com/feed/', category: 'tech' },
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', category: 'ai' },
  { name: 'Interconnects', url: 'https://www.interconnects.ai/feed', category: 'ai' },
  { name: 'Crunchbase News', url: 'https://news.crunchbase.com/feed/', category: 'business' },
  { name: 'SpaceNews', url: 'https://spacenews.com/feed/', category: 'business' },
  { name: 'PYMNTS', url: 'https://www.pymnts.com/feed/', category: 'business' },
  { name: 'Inc.', url: 'https://www.inc.com/rss', category: 'business' },
  { name: 'The Beacon (KC)', url: 'https://thebeaconnews.org/feed/', category: 'local' },
  { name: 'KC Digital Drive', url: 'https://www.kcdigitaldrive.org/feed/', category: 'local' },
  { name: 'Wichita Beacon', url: 'https://wichitabeacon.org/feed/', category: 'state' },
  { name: 'South Dakota Searchlight', url: 'https://southdakotasearchlight.com/feed/', category: 'regional' },
  { name: 'North Dakota Monitor', url: 'https://northdakotamonitor.com/feed/', category: 'regional' },
  { name: 'MinnPost', url: 'https://minnpost.com/feed', category: 'regional' },
  { name: 'Sahan Journal', url: 'https://sahanjournal.com/feed', category: 'regional' },
  { name: 'Flatwater Free Press', url: 'https://flatwaterfreepress.org/feed/', category: 'regional' },
  { name: 'Wisconsin Watch', url: 'https://wisconsinwatch.org/feed/', category: 'regional' },
  { name: 'Great Lakes Echo', url: 'https://greatlakesecho.org/feed/', category: 'regional' },
  { name: 'Oklahoma Watch', url: 'https://oklahomawatch.org/feed/', category: 'regional' },
];

export const CATEGORIES = [
  'local',
  'state',
  'regional',
  'ai',
  'tech',
  'business',
  'science',
  'national',
  'global',
  'newsletter',
  'music',
];

// ---------------------------------------------------------------------------
// Removed Nov 23, 2026 (David's ruling): how-to / tutorial class sources
// are not news wires and do not belong on the station.
//   - dev.to (https://dev.to/feed): open developer blogging platform,
//     dominated by tutorials and how-to guides. Named by David.
//   - Stack Overflow Blog (https://stackoverflow.blog/feed/): the
//     developer Q&A community's blog; its feed leans heavily on
//     how-to guides and learn-to-code tutorials, the same class.
// The rest of the roster was audited for the same class and kept:
// InfoQ, Changelog, Lobsters, and Hacker News are news/analysis and
// link aggregation, not tutorial sites; GitHub Blog and Cloudflare
// Blog are vendor engineering news; Hackaday is project news, not
// coding tutorials. Items these two removed feeds contributed in the
// past stay in the played store (append-only history is not rewritten).
//
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
// Second expansion pass (Nov 19, 2026, evening; local-first, regional in
// the expanded tier). Added above: KSHB 41, KMBC 9, KCTV5, FOX 4 KC,
// Kansas City Defender, KC Studio, Martin City Telegraph, Downtown KC,
// Dos Mundos, Kansas City Chiefs, Kansas City Royals, Arrowhead Pride,
// Royals Review, KC Soccer Journal (local); KY3 Springfield, Rock M
// Nation, Rock Chalk Talk (state); Wisconsin Examiner, Ohio Capital
// Journal, Michigan Advance, Bridge Michigan, Block Club Chicago
// (regional). Probed and NOT added, with reasons:
//   - The Kansas City Beacon (kansascitybeacon.org, www and bare):
//     connection fails from this network, repeatedly (same as the
//     first pass). Shawnee Mission Post, Thinking Bigger, Lee's Summit
//     Tribune, and the Independence Examiner fail the same way:
//     connection errors or stalls past the fetch timeout, every try.
//   - CityScene KC: the domain now redirects to Flatland KC's homepage
//     (the two merged); its coverage already arrives via Flatland KC.
//   - Ingram's Magazine: /feed/ returns 403. Riverfront Times: 403.
//   - Northeast News KC and KC Hispanic News: /feed/ 404 on bare and
//     www hosts; no public RSS found.
//   - Visit KC: /rss parses with current dates, but it is a
//     destination-marketing blog (evergreen seasonal listicles), not a
//     news wire. Not added on editorial grounds.
//   - KC Current and Sporting KC official sites: 404 on /rss, /rss.xml,
//     and /feed/ patterns; neither club exposes a public RSS feed.
//     KC Soccer Journal (added) covers both clubs.
//   - Chiefs Wire (USA Today): /feed/ 404. The Blue Testament:
//     connection fails; its writers now publish as KC Soccer Journal.
//   - KSHB /rss.xml and /rss: 404 (the working path is /news.rss).
//     KMBC /rss: returns an HTML page, 0 items (working path is
//     /topstories-rss). KCTV5 /rss/: 404 (working path is the Arc
//     outbound feed above).
//   - St. Louis Public Radio: 404 on stlpr.org/rss.xml (first pass),
//     stlpublicradio.org/rss.xml, /feeds, and the news. subdomain.
//     No working public RSS found.
//   - Columbia Missourian and St. Louis Post-Dispatch (TownNews BLOX):
//     /rss/ 404 or HTML shell, ?output=rss returns the HTML site or a
//     429, on every pattern tried. No parseable feed.
//   - Springfield News-Leader, Columbia Daily Tribune, Topeka
//     Capital-Journal (Gannett): 404 on /rss and /feed/; Gannett
//     exposes no public RSS for these papers.
//   - KSMU, KBIA, Kansas Public Radio: 404 on /rss.xml and /feed;
//     no working public RSS found.
//   - Missouri Business Alert: /feed/ 404 on www and bare hosts.
//   - Wichita Eagle (kansas.com, McClatchy ?output=1): exceeds even a
//     12s probe timeout, same failure class as the KC Star.
//   - Joplin Globe: /rss/ 404, /feed/ 429. Southeast Missourian: 404
//     on both patterns. Omaha World-Herald ?output=rss: 429.
//     Harvest Public Media: 404 on /feed/ and /rss.xml. WBEZ: 404.
//   - Kansas City Defender (added, flagged): a real feed and a real
//     KC newsroom, but a slow cadence: its 10 items span Sep 23 to
//     Nov 10, 2026. Downtown KC (added, flagged): 6 items, newest
//     3.6 days old at verification. Both are watched on the health
//     endpoint like every other source.
// Verified live but held back for scope: South Dakota Searchlight and
// North Dakota Monitor parse with current items (re-verified Nov 19
// evening), but they are the far edge of the Midwest ring and their
// wires lean heavily on the same States Newsroom national copy the
// other state wires already carry; Wisconsin Examiner, Ohio Capital
// Journal, and Bridge Michigan were promoted out of this held-back
// list in the evening pass, once regional joined the expanded tier.
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

// Social callers are NOT a story feed: their items are reactions keyed
// to stories already in the pool, so they do not join JSON_FEEDS (which
// ingestion turns into pool items). lib/social.js fetches and validates
// this feed separately; lib/format.js splices the callers into the
// queue after their stories.
export const SOCIAL_FEED = {
  name: 'Social Callers',
  url:
    process.env.SOCIAL_FEED_URL ||
    'https://raw.githubusercontent.com/o15david/kc-tech-radio/main/data/social-feed.json',
};

export const JSON_FEEDS = [NEWSLETTER_FEED, MUSIC_FEED, SOCIAL_FEED];

