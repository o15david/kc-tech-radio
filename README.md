# KC Tech Radio

A 24x7 streaming tech radio station for Kansas City: local tech and business
news, AI headlines in the spirit of TBPN, tech and business blocks, and a
general news block at the top of every hour that runs **inside-out**:
Kansas City first, then Missouri/Kansas state news, the Midwest, the
nation, and the world last. It plays in the web browser
and stays minutes ahead of the listener so the stream never breaks.

**The hard rule: no AI in the pipeline.** There are no LLM calls anywhere.
Every word broadcast is assembled from RSS summaries and fixed templates,
which makes the station deterministic, cacheable, and exactly $0 in AI
credits to run, forever.

## How it works

```
RSS/Atom feeds ──> ingest (fetch, dedupe, tag) ──> format clock ──> /api/playlist
   (58 sources)        5-min cache                   templates        queue of
                                                                        segments
Open-Meteo ────────> KC weather (or time-only fallback)                    │
                                                                           v
   Edge TTS neural voices ──> /api/audio renders each segment's MP3 once,
        (free, no key)        cached by hash of voice + script (immutable)
                                                                           │
                                                                           v
                                              Browser player: plays segment MP3s
                                              gaplessly, preloads the next one,
                                              refills the queue at <5 min buffer;
                                              speechSynthesis only as fallback
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
(listings, read only by the music block).

### 2. The format clock (`lib/format.js`)

A fixed hourly wheel, like a real station:

| Time | Block |
| --- | --- |
| :00 | **News at the Top of the Hour** (general news, inside-out: local x2, state, regional, national, global) |
| :08 | **Kansas City Tech & Business Report** (local; one story gets a two-host banter exchange) |
| :20 | **The AI Report** (ai; one story gets a two-host banter exchange) |
| :30 | Station ID + Kansas City time/weather check |
| :33 | **Tech Headlines** (tech; newsletter items are the secondary pool) |
| :37 | **Kansas City Music Scene** (tonight's shows, announcements, weekend and jazz picks; silent when the music feed is empty) |
| :45 | **Business & Markets** (business) |
| :50 | **The Producer's Desk** (fixed-copy gonzo bit, no news content) |
| :53 | **Kansas City Encore** (local, overflow falls back to other pools) |
| :57 | Station ID + tease for the top of the hour |

Each story segment's script is built from templates: an optional transition
line (picked from a fixed pool by hashing the segment id), the headline, the
cleaned RSS summary (truncated at a sentence boundary), and a spoken source
attribution ("From TechCrunch AI."). Story selection follows the no-repeat
rotation in the Format rules below, so the same request inside the same
window returns the same queue, and the queue advances as the clock advances.
If a category pool has no fresh story left, blocks fall back through the
other categories' fresh stories; if *everything* is down, the chain fills
with station material and the stream still never goes silent.

**The hour is a continuous chain with no holes.** Segments are laid end
to end from the top of the hour inside three spans pinned by *anchors*:
the segments that speak a time (the top-of-hour intro at :00, the station
ID at :30, the hour tease at :57) start at their true wall-clock minute,
exactly. Between anchors the content flexes to meet the next one: each
show block draws stories until it reaches its target length (the format
clock's `targetSeconds`; the old story counts are minimums), a span that
still runs short is filled with short deterministic station material
(station IDs, weather checks, producer's desk bits, station promos,
composed by an exact solver to land within a couple of seconds of the
anchor), and a span that would overrun has its trailing stories trimmed
back into the pool. The next hour starts on the hour regardless.

Spoken times are always the speaking segment's own chained start on the
Chicago clock, never "now plus whole hours": the top-of-hour block that
starts at 11:00 says "It is 11 AM Central Time" even when the playlist
was generated at 10:59, and a filler station ID that starts at :47 says
:47. On the hour, times are spoken radio-style without the ":00". Every
segment carries `startMs` (its chained scheduled start epoch) and
`slotEndMs` (the *next segment's* start: the chain tiles, so a segment's
window ends exactly where its successor begins) so the player can drop
stale segments instead of re-airing them.

## Format rules

**Never repeat stories. The news should be fresh.** (David's hard rule.)
Story selection rotates *without replacement* across every block instance
of every show:

- Pools are ordered newest-first and drawn freshest-first, so the freshest
  stories get the earliest slots.
- A story airs once, then it is out of rotation for the cycle. This holds
  across consecutive airings of the same show and across different shows
  drawing from the same pool; there is no mid-cycle reset.
- **The cycle is 8 hours**, anchored at 00:00, 08:00, and 16:00
  America/Chicago. A story becomes eligible again only when the pool has
  fully cycled (the next cycle window begins), or when a genuinely new
  edition of the story arrives: a new link/GUID is a new item, and it
  enters at the front of its newest-first pool, eligible immediately.
  Eight hours is sized to the wire: a cycle consumes at most ~185 story
  slots against a live pool of ~1,000 stories, so blocks do not run dry
  mid-cycle, while no story can resurface inside a single long listening
  session.
- If a block's fresh pool runs dry, the block draws a fresh story from a
  fallback category; if nothing fresh remains anywhere, the block stops
  drawing and **the span fills the shortfall with station material rather
  than recycling an aired story**. No story ever repeats to fill time.
- Station IDs, intros, time checks, the producer's desk, station promos,
  and the music block's fixed copy are not stories and are exempt.
- Implementation (stateless, deterministic): the aired set for the current
  cycle is reconstructed on every request by replaying the schedule from
  the cycle anchor to the current hour through the *same* builder the
  forward walk uses. An honesty rule applies identically in replay and in
  emission: an instance may only draw stories published by that instance's
  own start, so a story published at 10:05 AM is never retroactively
  "aired" by a 3 AM replay instance, and never drawn into the 10:00
  instance already on air. (An earlier version let the forward walk draw
  the current instance with no publication cutoff while the replay used
  the instance start; a story published mid-block could air live yet
  never be counted as aired, and air again later in the cycle. That
  asymmetry is fixed, and the cycle walk in `scripts/chain-audit.mjs`
  verifies zero duplicate story links across a full 8-hour cycle.) The
  player keeps its own session-level played sets as a backstop (see
  section 6).

**No dead air (the continuous chain).** The schedule tiles the hour end
to end: there is no minute of the day when nothing is scheduled. Blocks
sit in three spans pinned by time-speaking anchors (:00, :30, :57);
show blocks draw stories to target lengths sized to their spans; spans
that run short are padded with station material (never repeated
stories), spans that overrun are trimmed, and every hour restarts its
chain on the hour. `scripts/chain-audit.mjs` audits the result: zero
gaps over 2 seconds between consecutive segment windows across the
whole buffer, at several times of day including the thin overnight
wire, plus exactly-one-segment-on-air sampling and an anchor audit.

**Inside-out selection (the top-of-hour block).** General news runs
inside-out, because selection weight follows direct control and impact
for a KC metro listener: the closer the ring, the earlier and heavier it
draws. The :00 block deals its six story slots by ring: metro (`local`)
x2, state (`state`) x1, regional (`regional`) x1, national (`national`)
x1, world (`global`) x1, national deliberately briefest. Within a ring,
stories are freshest-first under the same no-repeat cycle rules; a dry
ring's slot falls outward through the later rings, then the general
fallback order, so the block fills without repeating and still leads as
close to home as the wire allows. Fallback order everywhere also runs
inside-out: local, state, regional, ai, tech, business, national,
global, newsletter.

**Two-host banter.** The KC Tech & Business Report and The AI Report are
two-host shows. One story per airing (picked by hash of the block
instance, so it moves around) gets a short exchange right after it: the
anchor reads the story exactly as usual, the co-host (Aria) reacts with a
line from `BANTER_REACTIONS` in `lib/gonzo.js`, and the anchor counters
from `BANTER_COUNTERS`. The exchange is three consecutive segments typed
`story` / `banter` (role `reaction`) / `banter` (role `counter`) with
alternating voices. The story counts once in the aired set; the banter
lines are framing copy and draw nothing.

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

### 3. The rolling buffer (`app/api/playlist/route.js`)

Returns the live segment plus upcoming segments covering **at least 12
minutes of wall-clock time** ahead of now (always including the rest of
the current hour and the next hour, so the top-of-hour anchor is loaded
before the hour turns). Because the schedule is a continuous chain with
no holes, `bufferSeconds` is true wall-clock coverage: seconds from now
until the end of the last returned segment, with a segment scheduled at
every instant in between. Segment durations are estimated from word
count at a fixed 155 words/minute, so timing is deterministic. Each
segment carries its scheduled window (`startMs`, plus `slotEndMs`, the
next segment's start, for the end of its window). Segments whose window
has fully passed are dropped from the response (their draws still count
in the cycle's aired set). The player refetches when the loaded schedule
runs out within 5 minutes, appends only segments it has not already
queued *or played* (see the backstop in section 6), and drops whole
blocks whose slot has fully passed rather than airing stale content.
The schedule itself is the stream: the player locks playback to these
windows on the wall clock (see section 6).

### 4. The voice: pre-rendered neural audio (`lib/voices.js`, `lib/tts.js`, `app/api/audio/route.js`)

The station does **not** sound like a browser robot. Every segment's script
is rendered server-side to MP3 with Microsoft Edge TTS neural voices (the
free read-aloud service built into Edge: no API key, no account, no AI
credits) through the `msedge-tts` client.

- **Voices** are configured in exactly one place, `lib/voices.js`. The
  anchor voice is `en-US-ChristopherNeural`; the co-host voice
  `en-US-AriaNeural` reads the News at the Top of the Hour block so the
  hour opens with a distinct read, and delivers the reaction lines in the
  two-host banter exchanges (a segment may carry an explicit voice, which
  is how banter alternates hosts). Edit those two constants to recast the station.
- Each playlist segment carries a `voice` and an `audioUrl`:
  `/api/audio?v=<voice>&t=<script>`. The URL fully determines the audio, so
  the route answers with year-long immutable cache headers; a warm instance
  also keeps an in-memory cache keyed by SHA-256 of voice + text
  (`lib/tts.js`). Deterministic segments effectively render once. The route
  also returns `X-Audio-Duration-Seconds`: the renders are
  constant-bitrate, so duration follows from the byte size
  (`mp3DurationSeconds` in `lib/tts.js`), and the player's wall-clock
  timeline is built from these real durations (see section 6).
- **Production upgrade path**: the in-memory cache resets on serverless
  cold starts, so a cold instance may re-render a segment once. If that
  ever matters, put a persistent blob store (e.g. Vercel Blob) behind
  `getSegmentMp3()` keyed by the same hash. Nothing else changes.
- The route only renders the configured voices and caps script length, so
  it cannot be used as a free general-purpose TTS endpoint.

### 5. The gonzo style layer (`lib/gonzo.js`)

The production voice is TBPN pacing and NPR polish, produced as if Hunter
S. Thompson were running the board. All of that attitude lives in one
hand-written file, `lib/gonzo.js`: show opens, story transitions, station
IDs, the top-of-hour block's framing lines, sign-offs, the two-host
banter pools (`BANTER_REACTIONS` / `BANTER_COUNTERS`), and **The Producer's
Desk**, a short fixed-copy rant at the industry that airs once an hour
(:50). No LLM writes or picks copy at runtime; pool selection is a hash of
the segment id, so hours are stable and cacheable.

The hard editorial rule: **news facts are never touched.** Headlines,
summaries, and attributions come straight from the wires. Gonzo copy is
framing only, aimed at hype cycles and press-release journalism, and it
never appears inside a story. David can retune the station's voice by
editing the pools in `lib/gonzo.js` directly.

### 6. The player (`app/Player.js`)

A radio-style page: Play/Pause/Stop, a live America/Chicago clock, Now
Playing, Up Next, a live script view showing exactly what is being read,
volume and voice-rate controls, and a status footer (last wire fetch, story
counts per category, server buffer depth).

**Playback is wall-clock-locked: one constant stream, not a personal
queue.** The pure selection logic lives in `lib/liveEdge.js` (shared with
the verification harness in `scripts/live-edge-check.mjs`). Each segment's
scheduled `startMs` anchors a timeline of *effective windows*: within a
block, segments tile back-to-back using **real MP3 durations** — learned
from the audio elements' metadata and from the `X-Audio-Duration-Seconds`
header `/api/audio` returns (the renders are constant-bitrate, so the
header's byte-size math is near-exact, and the player HEAD-warms the next
few segments, which also pre-renders them server-side) — with the
word-count estimate as fallback only. A window never crosses its
`slotEndMs` (the next segment's scheduled start): an overrunning segment
is cut by the schedule, the way the next show starts on time at a real
station, and the time it was cut by does not push its successors late —
the block resumes on schedule at the next segment.

- **Tune-in at the live edge.** Play, a return to the page, and a resume
  all find the segment whose window contains *now* and start its MP3 at
  offset `now - window start` via `currentTime`. Nobody hears the queue
  from the top, and a returning listener lands on whatever is live then —
  never on a replay of the current block.
- **Re-anchoring.** Every segment transition recomputes position from the
  wall clock, and a watchdog does the same every few seconds. If playback
  fell behind the live edge (drift, a buffering stall, background-tab
  throttling), the stale remainder is skipped and the live segment starts
  instead. At natural rate, an audio element lagging its wall-clock offset
  by more than 5 seconds is seeked forward in place.
- **The schedule has no gaps.** The server chain (see section 2) tiles
  every hour end to end, so there is always a segment on air. The
  player's wait-out-a-gap path remains only as a safety net for a
  pathological schedule: if a gap ever did appear, the player would wait
  for the next segment's true start (Now Playing shows what is on air
  next, and when) rather than starting it early, because a segment that
  announces a time is only ever heard inside its true window, so **spoken
  times are correct by construction**.
- **Pause is a deliberate hold.** It freezes the output where it is; the
  wall clock keeps moving, and resume re-anchors to the live edge — you
  rejoin the stream, you do not catch up on what aired while you were gone.
- **Audio failure is per-segment.** Playback is MP3-first, with the next
  segment's MP3 preloaded while the current one plays. Only if a segment's
  MP3 fails to load or play does that segment fall back to the browser's
  `speechSynthesis` (sentence-chunked, with a periodic `resume()` nudge for
  Chrome's long-session stalls; speech cannot seek, so the fallback reads
  its one segment from the top), and the next segment re-anchors and tries
  MP3 again. A TTS outage degrades the voice, never the stream.

The Now Playing / Up Next display always reflects the live position — what
is on air now — not where a personal queue happens to sit. Repeat
protection on this side is now a backstop to the server's no-repeat
rotation and the live-edge model: the player records every segment id it
starts and finishes and every played story's key (its link, falling back
to headline); a refill never re-queues them, finished segments are never
re-entered even if the clock is still inside their window, and whole
blocks whose slot has fully passed are pruned instead of airing stale.

**Honest framing:** on Vercel this is a *synchronized emulation* of a
constant stream — every listener hears the same segment at the same
moment, within a few seconds — not a literal always-on Icecast stream. A
literal stream would need an always-on host pushing one audio feed; the
segment/schedule contract here already carries everything such a host
would need.

### 7. Weather

Kansas City conditions come from Open-Meteo: free and keyless. If it is
unreachable or rate-limited, the :30 segment degrades gracefully to a time
check only.

### 8. Newsletter pipeline (`scripts/newsletter-processor.mjs`)

The assistant is subscribed to AI/tech/business newsletters with the
fairbanks@muse.ai address. Newsletters are a station source alongside
RSS, but the mailbox lives outside Vercel, so the pipeline has two halves:

1. **Processor (outside Vercel).** `scripts/newsletter-processor.mjs`
   reads newsletter email (`.eml` files, or `.html` files, or a folder of
   them) and writes `newsletter-feed.json`. The assistant runs it when new
   issues arrive and publishes the updated feed (the committed copy lives
   at `data/newsletter-feed.json`).
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

**Sender allowlist:** the processor only accepts mail whose From display
name matches `KNOWN_SENDERS` in the script (case-insensitive substring),
and the item's source attribution is that newsletter's name. Seeded with
the 9 actual subscriptions: **TLDR Tech, TLDR AI, The Rundown AI, Ben's
Bites, Morning Brew, The Hustle, Startland News, Import AI, The Batch**.
Edit the list in the script as subscriptions change; `--allow-unknown`
overrides for one-off tests. (The Batch, from DeepLearning.AI, is
subscribed under the name "Fairbanks Muse" with David's approval and
arrives weekly.)

**Feed contract** (what the processor emits and ingestion reads):

```json
{ "generatedAt": "2026-11-19T14:00:00.000Z",
  "items": [
    { "id": "https://example.com/story", "title": "Headline from the issue",
      "link": "https://example.com/story", "summary": "First paragraph text...",
      "source": "TLDR AI", "publishedAt": 1795100400000 }
  ] }
```

On air, newsletter items join the pool with category `newsletter`: in
The AI Report and Tech Headlines they are the secondary pool, leading
the draw on alternating story slots so they are guaranteed airtime, and
they ride last in the general fallback order, always with the spoken
attribution "From <newsletter name>."

### 9. Music feed (Kansas City Music Scene, :37)

David's KC Upcoming Shows tracking and show watches also live outside
Vercel, so music uses the same pattern: the assistant generates a small
JSON feed from the shows data and the station consumes it from
`MUSIC_FEED_URL` (default: `data/music-feed.json` in this repo, which
ships empty). Unreachable or empty means the music block is silent that
hour, never an error and never filler.

**Feed contract:**

```json
{ "generatedAt": "2026-11-19T14:00:00.000Z",
  "items": [
    { "kind": "tonight", "artist": "Example Band", "venue": "recordBar",
      "when": "tonight, doors 7:00 PM, show 8:00 PM",
      "url": "https://venue.example/events/example" }
  ] }
```

`kind` is one of `announced` (newly announced shows), `tonight` (tonight
across the tracked venues: miniBar, recordBar, Warehouse on Broadway, The
Truman, Knuckleheads, Howdy, Farewell, The RINO, Uptown Theater),
`weekend` (weekend highlights), or `jazz` (picks from David's KC jazz and
big band watch). The block airs a gonzo-framed intro (pools in
`lib/gonzo.js`) then a rundown in fixed kind order (tonight, announced,
weekend, jazz), up to 6 listings, each scripted as
`<lead-in> <artist> at <venue>, <when>.`

**Venue is the primary source (David's standing rule):** when listings
conflict, the venue's own calendar wins. The assistant therefore writes
only the venue-verified listing into this feed; conflicts are resolved
before publication, never on air. Show facts (artist, venue, date, time)
are read exactly as the feed carries them; only the intros and lead-ins
come from the gonzo pools.

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
- `/api/playlist` — the rolling segment queue (JSON); each segment carries `voice` and `audioUrl`
- `/api/audio?v=<voice>&t=<script>` — the segment MP3 (immutable-cached)
- `/api/health` — wire status: last fetch, per-category counts, buffer depth, per-feed health

No environment variables are required for the core station. Two optional
ones configure the assistant-generated JSON feeds described below:
`NEWSLETTER_FEED_URL` and `MUSIC_FEED_URL`.

## Deploying to Vercel

The repo is a standard Next.js app with zero required paid services:

1. Import the GitHub repo into Vercel (framework preset: Next.js, defaults
   everywhere). No env vars, no build settings to change.
2. Done. Feed fetches run inside the serverless functions; the in-memory
   5-minute cache is per-instance and best-effort, backed by Vercel's data
   cache.

Optional: a Vercel Cron Job hitting `/api/playlist` every 5 minutes keeps a
function instance warm so the first listener of the day gets an instant
response. Cron frequency on the Hobby plan is limited (daily), so this is a
Pro-plan nicety, not a requirement; the player works fine without it
because it refills its own queue.

## Known limitations / future work

- Playback still requires the listener's tab to stay open, and browsers
  require a user gesture (the Play button) before audio starts. The stream
  is a synchronized emulation locked to the wall clock (see section 6),
  not a literal always-on HLS/Icecast feed that any player can consume;
  that remains a possible future step, and the segment/schedule contract
  already supports it.
- Edge TTS is an unofficial free service (the one Edge's read-aloud uses).
  If it is ever unreachable, `/api/audio` returns 502 and the player falls
  back to browser speech for those segments; the stream itself never stops.
- The MP3 cache is in-memory per instance (see the blob-store upgrade path
  in section 4).
- Summaries are only as good as each feed's RSS text; some feeds (Hacker
  News) publish headlines only, so those segments are headline + attribution.
- The in-memory pool cache resets on cold starts; the first request after
  an idle period pays one round of feed fetches (~2-4s).
