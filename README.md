# KC Tech Radio

A 24x7 streaming tech radio station for Kansas City: local tech and business
news, AI headlines in the spirit of TBPN, tech and business blocks, and
general global news at the top of every hour. It plays in the web browser
and stays minutes ahead of the listener so the stream never breaks.

**The hard rule: no AI in the pipeline.** There are no LLM calls anywhere.
Every word broadcast is assembled from RSS summaries and fixed templates,
which makes the station deterministic, cacheable, and exactly $0 in AI
credits to run, forever.

## How it works

```
RSS/Atom feeds ──> ingest (fetch, dedupe, tag) ──> format clock ──> /api/playlist
   (14 sources)        5-min cache                   templates        queue of
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

Server-side fetch of 14 public RSS/Atom feeds with a small dependency-free
parser (RSS 2.0 + Atom). Items are normalized, deduped by link/GUID
(tracking params stripped), timestamped, and tagged with one category:
`local`, `ai`, `tech`, `business`, `global`. Fetches are cached for 5
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
| :00 | **World News at the Top of the Hour** (global) |
| :08 | **Kansas City Tech & Business Report** (local) |
| :20 | **The AI Report** (ai) |
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
attribution ("From TechCrunch AI."). Headline selection uses a deterministic
per-category cursor derived from the absolute block-instance number, so the
same request inside the same window returns the same queue, and the queue
advances as the clock advances. If a category pool runs dry, blocks fall
back through the other categories; if *everything* is down, a station-note
filler segment keeps the stream alive.

### 3. The rolling buffer (`app/api/playlist/route.js`)

Returns the current segment plus upcoming segments totaling **at least 12
minutes** of airtime. Segment durations are estimated from word count at a
fixed 155 words/minute, so timing is deterministic. The player refetches
when its unplayed tail drops below 5 minutes and appends only segments it
has not already queued (segment ids are deterministic per airing).

### 4. The voice: pre-rendered neural audio (`lib/voices.js`, `lib/tts.js`, `app/api/audio/route.js`)

The station does **not** sound like a browser robot. Every segment's script
is rendered server-side to MP3 with Microsoft Edge TTS neural voices (the
free read-aloud service built into Edge: no API key, no account, no AI
credits) through the `msedge-tts` client.

- **Voices** are configured in exactly one place, `lib/voices.js`. The
  anchor voice is `en-US-ChristopherNeural`; the World News block at the
  top of the hour uses `en-US-AriaNeural` so the hour opens with a distinct
  read. Edit those two constants to recast the station.
- Each playlist segment carries a `voice` and an `audioUrl`:
  `/api/audio?v=<voice>&t=<script>`. The URL fully determines the audio, so
  the route answers with year-long immutable cache headers; a warm instance
  also keeps an in-memory cache keyed by SHA-256 of voice + text
  (`lib/tts.js`). Deterministic segments effectively render once.
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
IDs, the global block's framing lines, sign-offs, and **The Producer's
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
counts per category, server buffer depth). Playback is MP3-first: the
player plays each segment's `audioUrl` and **preloads the next segment's
MP3 while the current one plays**, so the stream rolls gaplessly and stays
minutes ahead. Only if an MP3 fails to load or play does it fall back to
the browser's `speechSynthesis` for that segment (sentence-chunked, with a
periodic `resume()` nudge for Chrome's long-session stalls), then tries
MP3 again on the next segment. A TTS outage degrades the voice, never the
stream.

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

Verified live at build time (Nov 19, 2026):

- **local**: Startland News, Silicon Prairie News, KCUR (`kcur.org/news.rss`)
- **ai**: TechCrunch AI, MIT Technology Review
- **tech**: TechCrunch, The Verge, Ars Technica, Hacker News
- **business**: CNBC, MarketWatch Top Stories
- **global**: BBC World, NPR News, Al Jazeera

Dropped after verification: Kansas City Business Journal (RSS endpoint
returns 403 to non-browser clients) and AP (no public RSS feed). Startland
and Silicon Prairie sit behind Cloudflare and occasionally challenge rapid
repeat requests; the 5-minute cache keeps request volume low enough that
this has not been a problem.

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
  require a user gesture (the Play button) before audio starts. A true
  HLS/Icecast-style stream that any player can consume remains a possible
  future step; the segment/queue contract already supports it.
- Edge TTS is an unofficial free service (the one Edge's read-aloud uses).
  If it is ever unreachable, `/api/audio` returns 502 and the player falls
  back to browser speech for those segments; the stream itself never stops.
- The MP3 cache is in-memory per instance (see the blob-store upgrade path
  in section 4).
- Summaries are only as good as each feed's RSS text; some feeds (Hacker
  News) publish headlines only, so those segments are headline + attribution.
- The in-memory pool cache resets on cold starts; the first request after
  an idle period pays one round of feed fetches (~2-4s).
