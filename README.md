# KC Tech Radio

A 24x7 streaming tech radio station for Kansas City: local tech and business
news, AI headlines in the spirit of TBPN, tech and business coverage, and
general news that runs **inside-out**: Kansas City first, then
Missouri/Kansas state news, the Midwest, the nation, and the world last.
It plays in the web browser as one continuous queue of full stories,
back to back.

**The hard rule: no AI in the pipeline.** There are no LLM calls anywhere.
Every word broadcast is assembled from RSS summaries and fixed templates,
which makes the station deterministic, cacheable, and exactly $0 in AI
credits to run, forever.

**Back to basics (Nov 19, 2026).** The station used to run on a fixed
hourly format clock with pinned anchors and wall-clock-synced playback.
David scrapped it: get the content locked down first. There is no clock
anymore — no top-of-hour block, no anchors, no scheduled time callouts,
no sync. `/api/playlist` returns an ordered queue; the player plays it
head to tail, each segment to its natural end. Listeners are not synced
to a clock or to each other, and nothing anywhere claims otherwise.

## How it works

```
RSS/Atom feeds ──> ingest (fetch, dedupe, tag) ──> queue builder ──> /api/playlist
   (58 sources)        5-min cache                   templates        ordered queue
                                                                        of segments
Open-Meteo ────────> KC weather (current conditions)                      │
                                                                           v
   Edge TTS neural voices ──> /api/audio renders each segment's MP3 once,
        (free, no key)        cached by hash of voice + script (immutable);
                              synthesis is limiter-capped and retried
                                                                           │
                                                                           v
                                              Browser player: plays the queue
                                              sequentially, preloads ahead,
                                              refills before the queue runs
                                              out; speechSynthesis only as
                                              a per-segment fallback
```

### 1. Ingestion (`lib/feeds.js`, `lib/rss.js`, `lib/ingest.js`)

Server-side fetch of 56 public RSS/Atom feeds with a small dependency-free
parser (RSS 2.0 + Atom). Items are normalized, deduped by link/GUID
(tracking params stripped), timestamped, and tagged with one category.
The general-news categories are the inside-out rings: `local` (KC metro),
`state` (Missouri/Kansas), `regional` (Midwest), `national`, and `global`
(world); the subject pools are `ai`, `tech`, and `business`. Fetches are cached for 5
minutes in module memory and via Vercel's data cache (`revalidate: 300`),
so playlist requests are nearly free. A dead feed never breaks the station:
failures are recorded per-feed and the pool just runs smaller.

Two more categories come from assistant-generated JSON feeds (below):
`newsletter` (story-shaped, joins the pool like any wire) and `music`
(listings, read only by the music rundown).

Summaries are trimmed at ingestion (600 chars) and again when a script
is composed (480 chars), always at a sentence boundary, never
mid-clause: the shared rule in `lib/rss.js` cuts at the last complete
sentence that fits the budget, takes the first complete sentence when
none fits, and never treats an abbreviation ("U.S.") or a decimal
("3.5") as a sentence end. A story can therefore no longer trail off
like "...with more than 10,000 GPUs, delivering" (verified by
`scripts/sentence-audit.mjs`). Composition additionally guarantees
every story body ends with terminal punctuation before the source
sign-off (`ensureTerminalPunctuation` in `lib/rss.js`): some wires
publish summaries with no final period at all, and the sign-off
otherwise runs straight into the dangling clause ("...was denied
parole again From ABC News."). Summary cleaning strips all residual
HTML, including escaped tags ("&lt;p&gt;") and partial tag fragments
left by mid-tag truncation, and it strips dangling entity fragments:
a wire that truncates "&nbsp;" mid-entity (one UN News summary arrived
as "...in 2019.&nbsp") leaves a semicolon-less fragment the decoder
cannot match. Genuine prose ampersands survive ("AT&T", "R&D": the
strip requires at least two characters after the &). This is not
cosmetic: a bare & in a script is synthesis poison (section 4).

**Topic dedupe.** Exact-link dedupe cannot catch syndication, and the
same story must never air twice: on Nov 19, 2026 the repeat
investigation found a States Newsroom story carried by Minnesota
Reformer, Arkansas Advocate, Missouri Independent, and Iowa Capital
Dispatch under identical headlines (four links, one story), a Myanmar
ICJ story on CBC World, BBC World, and France 24, and roughly 200 such
near-duplicate pairs in a ~1,040-item pool. Ingestion therefore runs a
headline-similarity pass (`dedupeByHeadline` in `lib/ingest.js`) after
exact dedupe: headlines are normalized to significant tokens
(`headlineTokens` in `lib/rss.js`: lowercased, punctuation and
stopwords stripped, the source's own name tokens removed), and two
items with different links are the same story when they share at
least 4 tokens and score Jaccard >= 0.5 or containment >= 0.8.
Flagged items are clustered, and each cluster keeps exactly one item:
the higher-priority source wins, priority by the inside-out ring
order (`local` > `state` > `regional` > `national` > `global` > the
`ai`/`tech`/`business`/`newsletter` subject pools), feed roster order
within a ring, then the newest item. Losers are dropped from the pool
entirely, so they can never air. The threshold is deliberately
conservative: different outlets' own reporting on the same event
(Jaccard around 0.3) is NOT merged, only near-identical headlines are.
Music listings are exempt (keyed by artist/venue/when, not headlines).
Per-refresh counts are recorded on the pool and surfaced as `dedupe`
by `/api/health`; `scripts/dedupe-check.mjs` verifies the rule against
the live wire (every raw cluster collapses to one survivor, no flagged
pairs remain, below-threshold control stories survive).

**Wire resilience.** A collapsed refresh never replaces the last good
pool. On Nov 19, 2026 at 12:22 PM CT one refresh timed out on 57 of 58
feeds and swapped a healthy ~1,045-item pool for 5 items; the station
aired marked filler until the next refresh happened to restore it. Now
a refresh whose item count falls under 25% of the pool being served is
treated as failed and rejected: the last good pool (and its per-feed
status) keeps serving untouched, the attempt is recorded in
`lastRefresh` (surfaced by `/api/health` alongside `wireDegraded`, so
an outage reads as an outage, not as the station quietly shrinking),
and the next retry is due after 60 seconds instead of the full
5-minute TTL, with retries gated to at most one a minute under traffic.
The guard is not a pin: if collapses keep coming for 30 minutes of
wall clock, the newest pool is accepted as the wire's new reality (a
wire can genuinely shrink), and any healthy refresh clears the streak
immediately. Verified end to end with a stubbed wire by
`scripts/wire-resilience-check.mjs`. One limit, stated plainly: the
pool and the collapse state live in module memory, so the guard
protects warm instances (the normal case under constant playlist
traffic); a cold instance's first refresh is simply its pool.

**Article bodies (longer stories).** Story scripts for the
full-depth categories are built from article substance, not the
wire's summary: `lib/article.js` extracts the article's own
paragraphs (bylines, photo credits, subscription and cookie
boilerplate stripped) from the feed's full content
(`content:encoded` / Atom `content`, captured by `lib/rss.js`) or,
failing that, from the article page, fetched by a bounded
background pass in `lib/ingest.js` (per-pass attempt cap, small
concurrency, negative cache; bodies cached by link across
refreshes). Depth is tiered by relevance (David's rule: "the more
local and relevant the more info"): ai, tech, business, local,
state, and regional get the full treatment (scripts target roughly
60-90 seconds); national and global stay in the summarized
headline+summary form, and any story whose extraction failed falls
back to that form rather than being padded. One cross-category
addition (David, later Nov 19): startup stories are expanded
wherever they appear. A deterministic classifier
(`classifyStartup` in `lib/article.js`, rules documented there)
promotes a national, global, or newsletter story to full depth
when its source is a startup-focused outlet (Startland News,
Silicon Prairie News) or its headline/summary carries a funding,
founder/accelerator, or launch-with-startup-context signal. No text is generated:
scripts are the article's own words, trimmed at sentence
boundaries. Coverage of the served pool is surfaced as `articles`
by `/api/health`. Measured on the live wire at build time (Nov 19):
86% of full-depth stories carried a body; the full-depth queue
average rose from ~19s to ~66s per story and blended consumption
fell from ~171 to ~71 stories per hour.

### 2. The continuous queue (`lib/format.js`)

There is no format clock. `buildPlaylist` deals the deduped pool into
one ordered queue of segments:

- **Stories, dealt freshest-first in a weighted inside-out rotation.**
  A 16-slot dealing pattern cycles through the category pools —
  `local` x3, `ai` x3, `state` x2, `regional` x2, `tech` x2,
  `business` x1, `national` x1, `global` x1, `newsletter` x1,
  interleaved so no category clumps — taking the next freshest item
  from each named pool and skipping dry ones, until every pool is
  dealt exactly once. The close rings and the hometown subject pools
  lead; the far rings ride lightest. Inside-out is a soft rotation
  preference now, not a set of pinned blocks.
- **Rotation across fetches.** The dealt list is rotated by a
  deterministic offset that changes every 30-minute bucket, so
  consecutive queue fetches start at different points of the rotation.
  Within a bucket the build is a pure function of (pool snapshot,
  weather): identical inputs, identical queue.
- **Length.** A queue targets about **4 hours** of audio
  (`TARGET_QUEUE_SECONDS`), or the whole pool rotation when the pool
  holds less than that. Segments carry word-count duration estimates
  at a calibrated 136 words/minute (a 38-render sample measured the
  true rate at ~138 wpm); estimates shape queue composition only —
  playback is sequential and never cuts on an estimate.
- **No banter, no canned transitions.** Stories run back to back and
  start directly with the headline. (David cut the two-host banter
  exchanges and the story transition phrases on Nov 19: repetitive.)
- **Social callers.** When the social feed (section 10) carries a
  real public reaction to a story in the queue, one caller segment
  airs immediately after that story, read by the co-host voice in a
  single fixed attribution format. At most one caller per story, at
  most 16 per queue; callers are not stories and count toward no
  cadence. An empty social feed changes nothing.
- **Station material, as seasoning.** The queue opens with a station
  ID, then station material recurs at natural intervals measured in
  queue audio — a station ID about every 20 minutes, a Kansas City
  weather check about every 35 (when weather is available), a
  Producer's Desk bit about every 50 — at most one piece per story
  step, never stacked back to back. None of it speaks a time: the
  weather gives current conditions as natural content ("currently 54
  degrees with clear skies"), the way a person would say it. In the
  Nov 19 audit over the real pool, station material was 22 of 787
  segments (about 3%).
- **Music.** When the music feed has listings, one Kansas City Music
  Scene rundown lands about 45 minutes into the queue (at the end of a
  short queue): a gonzo intro, then up to 6 listings in fixed kind
  order (tonight, announced, weekend, jazz). An empty feed means no
  rundown, never filler.
- **Empty pool.** If the wire ever delivers no stories at all, the
  queue is a station ID plus a fixed station note saying the wires are
  momentarily quiet — never a repeated story.

Each story segment's script starts directly with the headline (no
canned intro or transition phrases), followed by the cleaned RSS
summary (truncated at a sentence
boundary, guaranteed to end with terminal punctuation), and a spoken
source attribution ("From TechCrunch AI.").

## Format rules

**Never repeat stories. The news should be fresh.** (David's hard rule.)
Inside one queue this holds by construction, three ways:

- The rotation draws **without replacement**: an item dealt once is
  never re-slotted at any length, and there are no trimmed fragment
  versions of stories anywhere in the design (the retired span-fill
  machinery that once re-aired a story at shrinking lengths is gone).
- Ingestion's **topic dedupe** (section 1) has already collapsed
  syndicated copies of the same story to a single item, so the same
  story cannot enter the queue twice under two outlets' links. The
  queue audit re-checks the built queue itself for duplicate links
  and duplicate headline clusters.
- A **queue-level topic guard** (`topicGuardMatches` in
  `lib/format.js`) holds out a second outlet's differently worded
  version of the same event within a single queue build (the pool
  keeps every version for later queues). Two stories are the same
  event when any of three paths fires: (1) their headlines share
  >= 3 significant tokens including an entity token (capitalized in
  the headline; a headline-initial name counts too, unless it is a
  generic opener like "Investors" or "Regulators") at Jaccard
  >= 0.3 or containment >= 0.6; (2) at as few as 2 shared headline
  tokens, one shared token is an entity token and a *different*
  shared token is a strong event token from a fixed list: ipo,
  merger(s), acquires/acquired/acquisition, bankruptcy,
  resigns/resigned, dies/died, verdict, guilty, shooting,
  earthquake, recall(s), lawsuit, indictment, charged,
  arrest/arrested, explosion(s), crash(es), outage(s), summit(s),
  trial(s), hearing(s), strike(s); or (3) the v3 summary path: the
  headlines share a dominant entity (the first entity token) and
  their cleaned summaries share >= 4 significant tokens at
  containment >= 0.5, which catches developing-story updates
  ("prices its IPO", "debuts", "shares pare gains") whose headlines
  share almost nothing. The entity anchor is what keeps a product
  launch, an earnings story, or a rival company's IPO from being
  merged into the event. On top of the guard, an **entity budget**
  caps any one dominant entity at 3 stories per queue, however
  distinct their events are. The playlist response reports both
  counts as `topicGuardSkipped` and `entityBudgetSkipped`.
- Across queues, the 30-minute **rotation bucket** moves the starting
  point, and the player keeps session-level backstops (section 6): a
  refill never re-queues a segment id or a story key (link, falling
  back to headline) already queued or played this session.

**No dead air.** Playback is sequential: a segment plays to its natural
end and the next starts immediately. The failure that used to produce
silence — a slow or failed MP3 render at the playhead — is handled by
the synthesis reliability design (section 4) and the player's
retry/degrade/skip ladder (section 6). There is no schedule to fall
behind, so there is nothing to catch up to and nothing to cut.

**Story-led mix.** Stories dominate by design: station material and
social callers are the only non-story content in the queue.
`scripts/queue-audit.mjs`
asserts the mix, zero banter segments, the no-repeat rules, the
terminal punctuation rule, the absence of scheduled-time speech in
every segment, and queue coverage, over both a synthetic pool and
the real wire.

**Inside-out selection.** Selection weight follows direct control and
impact for a KC metro listener: the closer the ring, the heavier it
deals. Within a category, stories are freshest-first. Fallback order
from the clock era is gone — the dealing pattern IS the order, and a
dry pool is simply skipped.

**Editorial stance.** "Snarky and funny, self-deprecating to KC and tech,
but should not be a tech curmudgeon. This is a pro-KC, pro-tech radio
station, but not just agreeing with the mainstream, politicians, etc."
And pro-business. The gloss: jokes punch at hype, press releases, and
official spin, including KC boosterism and tech's self-importance; KC and
tech are roasted lovingly from the inside. The station is fundamentally
*for* Kansas City, *for* technology, and *for* business: builders over
bloviators, no curmudgeon decline-of-everything energy, no reflexive
agreement with mainstream narratives or politicians of any stripe. The
station is **not biased to any political party**: in the model of Bill
Maher and Jon Stewart, everyone is fair game. It is nonpartisan,
equal-opportunity snark: politicians, parties, media, and tech royalty
all get roasted on the same terms, and the comedy follows the absurdity
rather than a party line. Independent, skeptical, amused, on the home
team's side. (This stance governs the framing copy in `lib/gonzo.js`;
news facts are never touched.)

### 3. The queue endpoint (`app/api/playlist/route.js`)

Returns the current queue: the ordered segment list (about 4 hours of
estimated audio, or the whole pool rotation when smaller), plus
`queueSeconds` (total estimated audio) and `bufferSeconds` (the same
number, kept for the health route and the player's queue-depth
display). Segments carry NO timing fields — there is no `startMs` or
`slotEndMs`, because nothing is scheduled. Each segment carries its
`voice` and `audioUrl`. The player fetches a fresh queue when the
loaded one runs low (under 12 segments or under 10 minutes remaining)
and appends only what it has not already queued or played this
session, so a long session flows across bucket rotations without
repeats and without a gap.

### 4. The voice: pre-rendered neural audio (`lib/voices.js`, `lib/tts.js`, `app/api/audio/route.js`)

The station does **not** sound like a browser robot. Every segment's script
is rendered server-side to MP3 with Microsoft Edge TTS neural voices (the
free read-aloud service built into Edge: no API key, no account, no AI
credits) through the `msedge-tts` client.

- **Voices** are configured in exactly one place, `lib/voices.js`. The
  anchor voice is `en-US-ChristopherNeural`; the co-host voice
  `en-US-AriaNeural` reads the inside-out news section (state,
  regional, national, global, and newsletter stories) so the straight
  news carries a distinct read. Edit those two constants to
  recast the station.
- Each queue segment carries a `voice` and an `audioUrl`:
  `/api/audio?v=<voice>&t=<script>`. The URL fully determines the audio, so
  the route answers with year-long immutable cache headers; a warm instance
  also keeps an in-memory cache keyed by SHA-256 of voice + text
  (`lib/tts.js`). Deterministic segments effectively render once. The route
  also returns `X-Audio-Duration-Seconds`: the renders are
  constant-bitrate, so duration follows from the byte size
  (`mp3DurationSeconds` in `lib/tts.js`); it is reported for diagnostics
  and sampling audits — playback never times on it.
- **Synthesis reliability.** Edge TTS fails intermittently in
  production ("Stream closed before the synthesis completed", route
  502s), and the failures get worse under concurrency pressure — the
  warmer plus several listeners' preloads can stampede the service.
  So every synthesis on an instance flows through ONE global limiter
  (at most 3 concurrent, FIFO), each render retries up to 3 attempts
  with jittered backoff (0.5s, 1.5s, 4s), a render whose real duration
  is under half its word-count estimate is rejected as truncated and
  retried, and a failure is NEVER cached (a later request runs the
  ladder again). The route returns 502 only after the whole ladder is
  exhausted; the player then retries the segment, degrades to browser
  speech for that segment, or skips it. Verified by
  `scripts/audio-sample.mjs`, which starts the production server,
  fetches the queue, and requests a broad sample of audio URLs spread
  across the whole queue (bar: zero failures).
- **Speech safety (the deterministic 502 root cause).** Sampling the
  Nov 19 queue locally found exactly one segment that 502'd through
  the whole retry ladder, repeatedly — and direct synthesis tests
  proved why: a bare `&` or `<` anywhere in a script makes Edge TTS
  close the stream on EVERY attempt. "AT&T", "R&D", "Tom & Jerry",
  "growth < 5 percent", and one UN News summary's dangling "&nbsp"
  fragment all failed 100% of the time while the same texts cleaned
  rendered in seconds (the client embeds the script in an XML
  envelope; the raw metacharacters break it). No retry ladder fixes a
  poisoned script — under the old code such a segment was a permanent
  hole at its queue position, one concrete source of the cutoffs and
  dead air David reported. So every render passes through
  `speechSafeText` in `lib/tts.js` (& is spoken as "and", < as "less
  than"), the cache key hashes the safe text so cache, in-flight, and
  warmer bookkeeping agree, and ingestion strips dangling entity
  fragments before they ever reach a script (section 1). The queue
  audit asserts both halves. In the Nov 19 local verification, a
  broad sample of 48 audio URLs across the queue (taken before this
  fix, under sustained sampler-plus-warmer load through the local
  proxy) returned 47 successes; the single 502 was a UN News segment
  carrying the same "&nbsp" fragment, and the poisoned antibiotics
  script with the fragment removed rendered in about 2 seconds.
  After the fix, both previously poisoned segments render (HTTP 200),
  and a fresh broad sample of 48 audio URLs across the queue returned
  **48 successes, zero failures** (cold renders through the local
  proxy: median about 13 seconds; a warmed segment serves in
  milliseconds).
- **Server-side pre-rendering**: a cold render costs seconds (measured
  1.8-7.9s per segment in production), so the cache is warmed ahead of
  the listener: every `/api/playlist` build (and every `/api/health`
  build) queues background renders for the nearest unrendered segments
  at the head of the queue, up to 24 new renders covering roughly the
  first 45 minutes, deduped against the render cache and in-flight map
  (`warmSegmentAudio` in `lib/tts.js`), all flowing through the same
  global limiter. The playlist route hands the pass's completion
  promise to Next's `after()`, which keeps the Vercel invocation alive
  for it up to the route's `maxDuration`; the warming is a pure side
  effect and never alters the playlist response. Limits, honestly:
  work after a response can still be cut off if the platform freezes
  the invocation early, and a cold instance starts with an empty
  cache, so the design is deliberately incremental: each build warms
  the head of the queue first, and regular player traffic walks
  coverage forward pass by pass. A failed warm render is swallowed:
  the segment stays unrendered and the player's retry ladder handles
  it when it reaches the playhead.
- **Production upgrade path**: the in-memory cache resets on serverless
  cold starts, so a cold instance may re-render a segment once; the
  pre-render warmer above absorbs most of that for the queue head.
  If latency ever still matters, put a persistent blob store (e.g.
  Vercel Blob) behind `getSegmentMp3()` keyed by the same hash.
  Nothing else changes.
- The route only renders the configured voices and caps script length, so
  it cannot be used as a free general-purpose TTS endpoint.

### 5. The gonzo style layer (`lib/gonzo.js`)

The production voice is TBPN pacing and NPR polish, produced as if Hunter
S. Thompson were running the board. All of that attitude lives in one
hand-written file, `lib/gonzo.js`: show opens, station
IDs, music lead-ins, and **The Producer's Desk**, a short fixed-copy rant
at the industry that recurs about every 50 minutes of queue audio. No LLM
writes or picks copy at runtime; pool selection is a hash of the segment
id, so queues are stable and cacheable. (Three pools from the format-clock
era — the top-of-hour framing lines, the sign-offs, and the station
promos — are no longer used by the queue and remain in the file for
reference; the station ID pool is filtered at composition time to drop
lines that still advertise the retired clock.)

The hard editorial rule: **news facts are never touched.** Headlines,
summaries, and attributions come straight from the wires. Gonzo copy is
framing only, aimed at hype cycles and press-release journalism, and it
never appears inside a story. David can retune the station's voice by
editing the pools in `lib/gonzo.js` directly.

### 6. The player (`app/Player.js`)

A radio-style page: Play/Pause/Stop, a live America/Chicago clock (page
furniture only — nothing on air speaks the time), Now Playing, Up Next,
a live script view showing exactly what is being read, volume and
voice-rate controls, and a status footer (last wire fetch, story
counts per category, server queue depth).

**A simple sequential queue player.** Pressing Play starts the loaded
queue at its head; each segment plays to its natural end and the next
starts immediately, butt-joined. There is no tune-in offset, no
re-anchoring, no drift to absorb: a long story simply takes its time.
When the loaded queue runs low, the player refills from
`/api/playlist` and appends only segments it has not already queued or
played this session (segment ids plus story keys), so the stream
continues across queue rotations without repeats; if a refill ever
brings nothing new, the stream stops cleanly rather than replaying
anything.

- **Preload runs minutes ahead.** The next segment's MP3 downloads
  while the current one plays, and the player HEAD-warms further
  segments until at least 300 seconds of audio ahead is rendering or
  rendered (up to 24 segments), because a cold Edge TTS render is slow
  and flaky.
- **A failure is never silence.** If a segment's MP3 errors (the route
  502s only after its server-side retry ladder) the player reloads it
  up to 2 times with a short pause — the first attempt usually
  triggered the server render, so the reload is often a cache hit. A
  stall watchdog covers the silent case (a stalled fetch fires no
  `error` and no `ended`): 8 seconds without progress nudges `play()`,
  then hands the segment to the same reload ladder. After the ladder,
  the browser's speechSynthesis reads that one segment
  (sentence-chunked, with a periodic `resume()` nudge for Chrome's
  long-session stalls); if even that is unavailable, the segment is
  skipped. A TTS outage degrades the voice, never the stream.
- **Pause is a deliberate hold.** It freezes the current segment where
  it is; resume continues that same segment. Stop halts and rewinds to
  the start of the current segment.

**Honest framing:** listeners are not synced. Two people pressing Play
in the same half-hour bucket get the same queue from the same head,
each at their own pace — that is the whole model, chosen deliberately
so the content could be locked down first. A literal always-on
Icecast/HLS stream would need an always-on host pushing one audio
feed; the segment/queue contract here already carries everything such
a host would need.

### 7. Weather

Kansas City conditions come from Open-Meteo: free and keyless. The
weather segment recurs about every 35 minutes of queue audio and
speaks the current conditions naturally ("currently 54 degrees with
clear skies, and winds around 8 miles per hour"). If Open-Meteo is
unreachable or rate-limited, weather segments are simply omitted;
nothing else changes.

### 8. Newsletter pipeline (`scripts/newsletter-processor.mjs`)

The assistant is subscribed to AI/tech/business newsletters with the
fairbanks@muse.ai address. Newsletters are a station source alongside
RSS, but the mailbox lives outside Vercel, so the pipeline has two halves:

1. **Export + processor (outside Vercel).** `scripts/newsletter-export.mjs`
   pulls new newsletter mail from the fairbanks@muse.ai inbox (Muse Mail
   CLI) into `.eml` files under `.newsletter-work/inbox/` (gitignored,
   along with the pipeline's state files). `scripts/newsletter-processor.mjs`
   then reads those files (`.eml`, `.html`, or a folder of them) and writes
   `newsletter-feed.json`. A scheduled job (`kc-tech-radio-newsletter-pipeline`,
   early morning and mid-afternoon CT) runs both, commits the updated feed
   (the committed copy lives at `data/newsletter-feed.json`), and uploads
   it to GitHub, which is where the station reads it from.
2. **Station (on Vercel).** Ingestion fetches the feed from
   `NEWSLETTER_FEED_URL` (default: that file's raw GitHub URL) with the
   same caching and forgiving failure handling as RSS: unreachable or
   empty means zero newsletter items, never an error.

**Parsing rules (fixed and deterministic; no LLM summarization):** strip
scripts/styles/hidden blocks; walk `h1`-`h3` headings in document order;
a heading becomes an item whose link is the first http(s) anchor inside
the heading, else the first anchor before the next heading, and whose
summary is the first `<p>` after the heading (280 chars max). Headings
shorter than 12 chars or matching a furniture stoplist (unsubscribe,
sponsored, share this, ...) and links matching skip patterns
(unsubscribe/preferences/mailto) are dropped. **Dedupe:** tracking params
are stripped and links are deduped against a persistent state file of
every link ever emitted, so re-processing an issue never re-airs a story;
the feed itself is merged, newest first, capped at 50 items.

**Sender allowlist:** the processor only accepts mail from the 9 actual
subscriptions: **TLDR Tech, TLDR AI, The Rundown AI, Ben's Bites, Morning
Brew, The Hustle, Startland News, Import AI, The Batch**. Matching tries
the sender address first (`KNOWN_SENDER_ADDRESSES` in the script:
display names proved unreliable, e.g. Startland issues arrive as "Tommy
Felts" and both TLDR lists share dan@tldrnewsletter.com, with the
subject line deciding between them), then the From display name against
`KNOWN_SENDERS` (case-insensitive substring). The item's source
attribution is the canonical newsletter name. Welcome and
confirm-your-subscription mail is onboarding, never an issue: subjects
matching `ONBOARDING_SUBJECT_RE` are skipped. Edit the lists in the
script as subscriptions change; `--allow-unknown` overrides for one-off
tests. (The Batch, from DeepLearning.AI, is subscribed under the name
"Fairbanks Muse" with David's approval and arrives weekly.)

**Feed contract** (what the processor emits and ingestion reads):

```json
{ "generatedAt": "2026-11-19T14:00:00.000Z",
  "items": [
    { "id": "https://example.com/story", "title": "Headline from the issue",
      "link": "https://example.com/story", "summary": "First paragraph text...",
      "source": "TLDR AI", "publishedAt": 1795100400000 }
  ] }
```

On air, newsletter items join the pool with category `newsletter`: they
deal in the queue's rotation like any other story (one slot per dealing
pass) and are read by the co-host as part of the inside-out news
section, always with the spoken attribution "From <newsletter name>."

### 9. Music feed (Kansas City Music Scene)

David's KC Upcoming Shows tracking and show watches also live outside
Vercel, so music uses the same pattern: the assistant generates a small
JSON feed from the shows data and the station consumes it from
`MUSIC_FEED_URL` (default: `data/music-feed.json` in this repo, which
ships empty). Unreachable or empty means no music rundown in the queue,
never an error and never filler.

**Feed contract:**

```json
{ "generatedAt": "2026-11-19T14:00:00.000Z",
  "items": [
    { "kind": "tonight", "artist": "Example Band", "venue": "recordBar",
      "when": "tonight, doors 7:00 PM, show 8:00 PM",
      "url": "https://venue.example/events/example",
      "date": "2026-11-19" }
  ] }
```

`kind` is one of `announced` (newly announced shows), `tonight` (tonight
across the tracked venues: miniBar, recordBar, Warehouse on Broadway, The
Truman, Knuckleheads, Howdy, Farewell, The RINO, Uptown Theater),
`weekend` (weekend highlights), or `jazz` (picks from David's KC jazz and
big band watch). `date` is the show's calendar date (YYYY-MM-DD); feeds
built before it existed are dated by parsing `when` at ingest. The
rundown airs a gonzo-framed intro (pools in `lib/gonzo.js`) then the
listings soonest first (kind order breaks same-date ties), up to 6, each
scripted as `<lead-in> <artist> at <venue>, <when>.`

**Event dates are enforced at queue build (David's rule, Nov 20, 2026):**
a dated listing whose date is before today (America/Chicago) never
airs, however stale the feed file is, and "tonight" copy airs only for
a listing dated today. The feed itself is rebuilt daily so the
`tonight` classification stays same-day.

**Venue is the primary source (David's standing rule):** when listings
conflict, the venue's own calendar wins. The assistant therefore writes
only the venue-verified listing into this feed; conflicts are resolved
before publication, never on air. Show facts (artist, venue, date, time)
are read exactly as the feed carries them; only the intros and lead-ins
come from the gonzo pools.

### 10. Social callers (listener reaction feed)

David's chosen personality layer (Nov 19, after the canned transitions
and banter were cut): real public reactions to real stories, presented
like callers phoning in. The reactions are **real public posts,
attributed by platform and username, framed on air as listener
reaction, never as news**. Nothing about a caller is generated: the
text is the post, verbatim, and the story facts stay with the story
segment that precedes it.

Like the newsletter and music feeds, the social feed is prepared
outside Vercel and consumed as a small JSON document from
`SOCIAL_FEED_URL` (default: `data/social-feed.json` in this repo).
`lib/social.js` fetches it with the same caching and forgiving failure
handling as RSS: unreachable, malformed, or empty means zero callers,
never an error and never filler.

**Feed contract:**

```json
{ "generatedAt": "2026-11-19T14:00:00.000Z",
  "items": [
    { "storyLink": "https://example.com/the-story",
      "platform": "Reddit",
      "username": "some_redditor",
      "text": "The reaction, verbatim from the public post.",
      "engagement": 128,
      "sourceUrl": "https://www.reddit.com/r/technology/comments/...",
      "capturedAt": "2026-11-19T13:55:00.000Z" }
  ] }
```

`platform` is one of `Reddit`, `X`, `Facebook`, `Bluesky`, `Hacker News`; `engagement` is the
post's public score/like count where the platform exposes one, else
`null`; `storyLink` is the pool story the reaction answers (tracking
parameters are stripped before matching, the way ingestion normalizes
story links).

**Ingest filters (deterministic, `lib/social.js`):** an item is
dropped when its text (after cleaning) is under 20 or over 280
characters, contains a URL, or contains a word from a basic profanity
blocklist; when its story link is not a plausible http(s) URL; when
its platform is not one of the five above; or when its text
duplicates an earlier item's. Usernames face the same URL/blocklist
rules.

**Placement rules (queue builder, `lib/format.js`):** a caller airs
**immediately after its story**, before any station material, so the
reaction is never separated from the story it answers. At most **one
caller per story** (the feed's first item for a story wins) and at
most **16 callers per queue**. Callers do not count as stories for
any cadence. The script is a **single fixed attribution format, not
a template pool**: `Caller on <platform>, <username>: <text>`, read
by the **co-host voice (Aria)** so callers sound distinct from the
anchor.

**Building the feed:** `scripts/social-feed-builder.mjs` pulls the
live pool, searches Reddit's public JSON endpoints for threads
matching the ~40 freshest stories (a thread whose link is the story
itself, or whose title shares significant tokens with the headline;
category subreddits r/kansascity, r/artificial, r/technology,
r/business included), and takes the highest-scoring qualifying
comment per story. X and Facebook reactions arrive by the same
assistant-pass pattern as the newsletter and music feeds. Note:
Reddit's public JSON endpoints bot-wall many datacenter networks
(HTTP 403); the builder detects the wall, stops early, and writes
whatever it genuinely found, possibly an empty feed. An honest empty
feed beats a fabricated full one, and the station airs zero callers
until a feed with real reactions is published.

Two more channels are wired into the same harvest (Nov 19, David's
pick to diversify beyond Reddit). `scripts/bluesky-harvest.mjs`
searches Bluesky's public searchPosts API for the ~15 most
discussable stories in the live playlist (discussability-scored,
local first) and keeps only genuine reactions: a post must embed the
story URL or share at least 3 significant tokens and a headline
phrase with it, name a distinctive proper noun from the headline,
and add words of its own (headline restatements, crosspost mirrors,
commerce spam, bot accounts, and the story outlet's own posts are
all filtered out before the station validator runs). Channel fact:
the documented public host public.api.bsky.com is walled from this
network (TLS completes, then the connection is cut), so the script
calls the same XRPC method on api.bsky.app, which answers.
`scripts/hn-harvest.mjs` covers tech stories through the Hacker
News Algolia API, matched by URL only (a story qualifies when an HN
submission's URL is the story's URL; top-level comments only;
engagement is null because Algolia exposes no comment scores).
Each writes a candidates file, and `scripts/social-feed-merge.mjs`
merges them into the feed under the harvest rule: existing callers
stay only while their story is still in the live playlist, new
items first, dedupe by text, cap 16.

## Feeds

56 RSS feeds plus the 2 assistant-generated JSON feeds, every one
verified live (fetched and parsed with the station's own parser, current
items confirmed) at build time or in the Nov 19, 2026 inside-out
expansion. The roster is also listed, with per-feed notes, in
`lib/feeds.js`.

- **local** (KC metro): Startland News, Silicon Prairie News, KCUR
  (`kcur.org/news.rss`), Flatland KC, Johnson County Post, Kansas City
  Magazine, The Pitch KC
- **state** (MO/KS): Missouri Independent, Kansas Reflector, Missourinet
- **regional** (Midwest): Iowa Capital Dispatch, Nebraska Examiner,
  Minnesota Reformer, Oklahoma Voice, Arkansas Advocate, Indiana Capital
  Chronicle, Capitol News Illinois
- **ai**: TechCrunch AI, MIT Technology Review, OpenAI Blog, Google
  DeepMind, Google AI Blog, NVIDIA Blog, AWS Machine Learning Blog,
  The Decoder, MarkTechPost
- **tech**: TechCrunch, The Verge, Ars Technica, Hacker News, Wired,
  Engadget, NYT Technology, Fast Company, CNBC Technology
- **business**: CNBC, MarketWatch Top Stories, Fortune, Bloomberg
  Technology
- **national**: NPR News, The Hill, PBS NewsHour, CBS News, NBC News,
  ABC News, NYT Home Page, Axios
- **global**: BBC World, Al Jazeera, The Guardian World, DW News,
  France 24, CBC World, Sky News World, UN News, SCMP World

Attempted but dropped after verification (details in `lib/feeds.js`):
Kansas City Business Journal (403 bot wall), AP (no public RSS), KC Star
(feed requests time out), Shawnee Mission Post (fetch fails), Northeast
News KC (404), Kansas City Beacon (fetch fails), KCUR politics feed
(404; the main KCUR feed carries its statehouse coverage), St. Louis
Post-Dispatch (0 items parsed), St. Louis Public Radio (404), USA Today
(timeouts), Washington Post National (parses in isolation but
consistently exceeds the station's 9s fetch timeout), WSJ via Dow Jones
(feed is a frozen snapshot, newest item ~22 months old), Anthropic and
Meta AI (no public RSS), VentureBeat AI (429), AI News (0 items),
Hugging Face blog (no usable summaries; community upload firehose),
Google Research blog (almost no summaries, sparse), arXiv cs.AI (daily
abstract firehose that would flood the AI pool), Reuters (public RSS
discontinued). Verified live but held back for scope: Wisconsin
Examiner, Ohio Capital Journal, South Dakota Searchlight, North Dakota
Monitor, Bridge Michigan (outside the KC-centric regional ring).

Startland and Silicon Prairie sit behind Cloudflare and occasionally
challenge rapid repeat requests; the 5-minute cache keeps request volume
low enough that this has not been a problem.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:3000
# or production:
npm run build && npm run start
```

Useful endpoints:

- `/` — the player
- `/api/playlist` — the segment queue (JSON); each segment carries `voice` and `audioUrl`
- `/api/audio?v=<voice>&t=<script>` — the segment MP3 (immutable-cached)
- `/api/health` — wire status: last fetch, per-category counts, queue depth, per-feed health, dedupe and wire-resilience state

Verification harnesses (plain Node, no test framework):

- `node scripts/queue-audit.mjs` — the queue rules: no duplicate links
  or headline clusters, no scheduled-time speech, terminal punctuation,
  zero banter, social caller placement and ingest filters,
  station-material share, coverage, determinism and
  rotation, over a synthetic pool and the real wire
- `node scripts/audio-sample.mjs` — starts the production server and
  samples audio URLs across the queue (bar: zero failures)
- `node scripts/sentence-audit.mjs` — sentence-boundary and
  ending-punctuation rules
- `node scripts/dedupe-check.mjs` — topic dedupe against the live wire
- `node scripts/wire-resilience-check.mjs` — the collapsed-refresh
  guard, end to end with a stubbed wire

No environment variables are required for the core station. Three optional
ones configure the assistant-generated JSON feeds described below:
`NEWSLETTER_FEED_URL`, `MUSIC_FEED_URL`, and `SOCIAL_FEED_URL`.

## Deploying to Vercel

The repo is a standard Next.js app with zero required paid services:

1. Import the GitHub repo into Vercel (framework preset: Next.js, defaults
   everywhere). No env vars, no build settings to change.
2. Done. Feed fetches run inside the serverless functions; the in-memory
   5-minute cache is per-instance and best-effort, backed by Vercel's data
   cache.

Optional: a Vercel Cron Job hitting `/api/playlist` every 5 minutes keeps a
function instance warm and the head of the queue pre-rendered, so the first
listener of the day gets an instant response. Cron frequency on the Hobby
plan is limited (daily), so this is a Pro-plan nicety, not a requirement;
the player works fine without it because it refills its own queue.

## Known limitations / future work

- Playback still requires the listener's tab to stay open, and browsers
  require a user gesture (the Play button) before audio starts.
- Listeners are not synced to each other or to a clock, by deliberate
  design (see section 6). A literal always-on HLS/Icecast feed that any
  player can consume remains a possible future step, and the
  segment/queue contract already supports it.
- Edge TTS is an unofficial free service (the one Edge's read-aloud uses).
  It fails intermittently even with the limiter and retry ladder; when a
  segment ultimately 502s, the player degrades to browser speech for that
  segment or skips it, and the stream itself never stops.
- The MP3 cache is in-memory per instance (see the blob-store upgrade path
  in section 4).
- Summaries are only as good as each feed's RSS text; some feeds (Hacker
  News) publish headlines only, so those segments are headline + attribution.
- The in-memory pool cache resets on cold starts; the first request after
  an idle period pays one round of feed fetches (~2-4s).
