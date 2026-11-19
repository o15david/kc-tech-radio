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
                                              Browser player: speechSynthesis
                                              reads the queue, refills at <5 min
```

### 1. Ingestion (`lib/feeds.js`, `lib/rss.js`, `lib/ingest.js`)

Server-side fetch of 14 public RSS/Atom feeds with a small dependency-free
parser (RSS 2.0 + Atom). Items are normalized, deduped by link/GUID
(tracking params stripped), timestamped, and tagged with one category:
`local`, `ai`, `tech`, `business`, `global`. Fetches are cached for 5
minutes in module memory and via Vercel's data cache (`revalidate: 300`),
so playlist requests are nearly free. A dead feed never breaks the station:
failures are recorded per-feed and the pool just runs smaller.

### 2. The format clock (`lib/format.js`)

A fixed hourly wheel, like a real station:

| Time | Block |
| --- | --- |
| :00 | **World News at the Top of the Hour** (global) |
| :08 | **Kansas City Tech & Business Report** (local) |
| :20 | **The AI Report** (ai) |
| :30 | Station ID + Kansas City time/weather check |
| :33 | **Tech Headlines** (tech) |
| :45 | **Business & Markets** (business) |
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

### 4. The player (`app/Player.js`)

A radio-style page: Play/Pause/Stop, a live America/Chicago clock, Now
Playing, Up Next, a live script view showing exactly what is being read,
volume and voice-rate controls, and a status footer (last wire fetch, story
counts per category, server buffer depth). Playback uses the browser's
`speechSynthesis` with an English voice, chunking each script by sentence
to avoid the long-utterance stalls/cutoffs in Chrome, plus a periodic
`resume()` nudge for long sessions.

### 5. Weather

Kansas City conditions come from Open-Meteo: free and keyless. If it is
unreachable or rate-limited, the :30 segment degrades gracefully to a time
check only.

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
- `/api/playlist` — the rolling segment queue (JSON)
- `/api/health` — wire status: last fetch, per-category counts, buffer depth, per-feed health

No environment variables are required.

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

- **Voice is the browser's `speechSynthesis`** (v1 scope). Quality and voice
  selection vary by listener device, playback requires the tab to stay open,
  and Chrome requires a user gesture (the Play button) before speaking.
- **Upgrade path**: pre-render segments server-side with a TTS engine into
  MP3s, cache them by segment id (they are deterministic, so each segment
  renders exactly once), and stream them as a true audio feed (HLS/icecast
  style) that any player can consume. The segment/queue contract in
  `/api/playlist` was designed so this can slot in without changing the
  format clock.
- Summaries are only as good as each feed's RSS text; some feeds (Hacker
  News) publish headlines only, so those segments are headline + attribution.
- The in-memory pool cache resets on cold starts; the first request after
  an idle period pays one round of feed fetches (~2-4s).
