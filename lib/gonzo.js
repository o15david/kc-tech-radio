// ============================================================================
// THE GONZO STYLE FILE — every piece of attitude on KC Tech Radio lives here.
//
// The format is TBPN's pacing and NPR's polish, produced as if Hunter S.
// Thompson were running the board: savage about hype cycles, vaporware,
// keynote theater, and press-release journalism, wired and funny, but the
// NEWS ITSELF IS NEVER TOUCHED. Story headlines, summaries, and attributions
// come straight from the RSS wires and are assembled verbatim in format.js.
// The gonzo layer exists only in these fixed, hand-written template pools:
// show opens, station IDs, the top-of-hour block framing, the
// producer's desk, and sign-offs.
//
// Every line here was written by a human hand (David's station, David can
// edit). There is NO LLM generation anywhere. Pool picks are deterministic:
// format.js hashes the segment id into the pool, so the same hour always
// sounds the same and every line is cacheable.
//
// HOW TO TWEAK THE STATION'S VOICE: edit lines, add lines, delete lines.
// Keep each pool stocked (4+ lines) so consecutive hours do not repeat
// verbatim. Keep it broadcast-clean; the savagery is aimed at the industry,
// never at the listener, and never inside a news story.
// ============================================================================

// ---------------------------------------------------------------------------
// Show opens. One is picked per block airing. {block} keys match the format
// clock in lib/format.js. The top-of-hour block has its own framing pool below.
// ---------------------------------------------------------------------------

export const SHOW_OPENS = {
  'kc-local': [
    'From the Crossroads to the Northland, this is the Kansas City Tech and Business Report, on KC Tech Radio. Real companies, real payrolls, none of the coastal cosplay. Here is what is happening in the local tech scene.',
    'Kansas City Tech and Business, on KC Tech Radio. While Silicon Valley burns money on espresso machines and destiny, people here are quietly building things that work. The local wires, now.',
    'This is the Kansas City Tech and Business Report. No hype imports, no venture tourists, just the hometown ledger: who is building, who is hiring, and who is actually shipping. Here is the latest.',
    'Back to the heartland wire. Kansas City tech and business, where a term sheet still has to survive contact with reality. Here is what is moving in the metro.',
  ],
  'ai-news': [
    'Now, the AI Report. Another day, another model launch wrapped in a press release written like a hostage note from the future. We read them so you do not have to. Here is the latest in AI.',
    'The AI Report, on KC Tech Radio. Somewhere out there a demo is being applauded that will never survive a real user. Meanwhile, actual news happened. Here it is.',
    'Now the AI Report: new models, big funding, and the business of artificial intelligence, stripped of the keynote fog and read at street level. Here is the latest.',
    'Time for the AI Report. The hype machine is running at full scream, the GPUs are hot, and the truth is in here somewhere. We dug it out of the pile. The latest in AI, now.',
  ],
  'tech-headlines': [
    'Tech headlines: the biggest stories in technology right now, on KC Tech Radio, with the marketing varnish scraped off.',
    'Tech headlines. Big platforms, bigger promises, and the occasional product that actually exists. Here is what is on the wire.',
    'Now, tech headlines, read plain. The industry will supply its own adjectives; it always does. The stories, now.',
    'Tech headlines on KC Tech Radio. Somewhere a roadmap just became fiction. Here is what actually happened.',
  ],
  'business-headlines': [
    'Business and markets: here is the latest from the business wires, where the money says the quiet part out loud.',
    'Business and markets, on KC Tech Radio. Earnings, deals, and the fine print nobody reads until it is too late. We read it. Here is the latest.',
    'Now, business and markets. The suits have filed their paperwork and the numbers are what they are. Straight from the wires.',
    'Business headlines: follow the money, because the money never bothers to lie about where it is going. The latest, now.',
  ],
  'kc-encore': [
    'More from Kansas City: another look at local tech and business, on KC Tech Radio, because the hometown story never fits in one pass.',
    'The Kansas City encore. The first pass was the headlines; this is the stuff still warm on the wire. More local tech and business, now.',
    'Back around the metro one more time. Kansas City encore, on KC Tech Radio.',
    'One more lap around Kansas City tech and business before the hour turns. Here is what else is out there.',
  ],
  'kc-music': [
    'Now, the Wasteland Jukebox, on KC Tech Radio. Live music is the last honest business in America: no demo, no vapor, just a room, a band, and a door count. Here is who is playing.',
    'The Wasteland Jukebox. Somewhere tonight there is a drummer earning every penny the hard way. This is where, and when.',
    'The Wasteland Jukebox, Kansas City style. The clubs are booked, the amps are warm, and the listings are verified at the venue, the way the good Lord and the box office intended. The rundown, now.',
    'Time to feed the Wasteland Jukebox: Kansas City live music, from dive bars to the big rooms, read straight off the venue calendars.',
  ],
};

// ---------------------------------------------------------------------------
// Top-of-hour general news framing. NPR-ish: calm, clean, structured. The
// block runs INSIDE-OUT (Kansas City first, the world last), and the
// framing says so. The energy lives in the framing line only; the
// time/date line and the stories stay straight. format.js composes:
// <framing> It is <time> Central Time, <date>. Here are the headlines.
// ---------------------------------------------------------------------------

export const GENERAL_FRAMING = [
    'News at the top of the hour, on KC Tech Radio. We start closest to home and work outward, the way the news actually reaches Kansas City.',
    'The top of the hour, and the news, on KC Tech Radio. Kansas City first, then the statehouse, the region, the nation, and the world, in that order.',
    'News at the top of the hour. Home first: the metro, Missouri and Kansas, the Midwest, and then the wider world.',
    'It is the top of the hour on KC Tech Radio. The headlines, inside-out: what touches Kansas City leads, and the planet follows.',
    'Top of the hour, KC Tech Radio. Calm voices, straight facts, starting in our own backyard.',
];

// ---------------------------------------------------------------------------
// Station IDs. format.js appends the factual time check (and weather, when
// available) right after the picked line.
// ---------------------------------------------------------------------------

export const STATION_IDS = [
  'You are listening to K-B-U-N-K-C, the Bunker: KC Tech Radio, the last clear signal in the Midwest. If your dial found us through the static, congratulations, your set still works and so does your judgment.',
  'K-B-U-N-K-C, KC Tech Radio. A friendly reminder from the Bunker: in the event of a hype emergency, remain calm, keep your hands off the pre-order button, and wait for the wire to confirm. It almost never does.',
  'K-B-U-N-K-C. Civil defense for the information age: we check the fallout on every press release so your brain does not have to wear the lead apron.',
  'KC Tech Radio, the last clear signal in the Midwest. Somewhere above us a keynote is promising the future. Down here in the Bunker, we read the fine print out loud.',
  'This is K-B-U-N-K-C, broadcasting from the Bunker beneath Union Station. Duck and cover was lousy advice for the atomic age and worse for the AI age. We suggest a third option: stay informed, stay skeptical, and stay tuned.',
  'K-B-U-N-K-C, broadcasting on pure vacuum-tube nerve from beneath Union Station. No commercials, no sponsored segments, no mercy for vaporware. The tubes are warm and the coffee is terrible.',
  'You have reached KC Tech Radio. If this were an actual emergency, we would interrupt the tech news. It is not. It is a product launch. There is a difference, and this station exists to enforce it.',
  'KC Tech Radio. Fallout report: the only thing raining down today is press releases. Exposure is harmless if you keep a working set and a raised eyebrow between you and the blast.',
  'This is the Bunker beneath Union Station, K-B-U-N-K-C, KC Tech Radio. We monitor the wires so you can monitor your life. Signal strong, coffee weak, facts straight.',
  'KC Tech Radio: the last clear signal in the Midwest, where the hype comes to be fact-checked by the wire itself, one glowing tube at a time.',
];

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Jingles (Route 1, approved by David Nov 20, 2026): half-chanted spoken
// IDs over a verified public-domain music bed (Tiger Rag, Original
// Dixieland Jass Band, 1918, public domain via Wikimedia Commons),
// mixed at render time by scripts/render-jingles.mjs into finished MP3s
// under public/jingles/, with the manifest in lib/jingles.json. The
// lines are hand-written, short, and rhythmic: the chant is in the
// copy. They rotate through the station ID slots and open the
// Wasteland Jukebox. Route 3 (AI-sung jingles) is approved in
// principle as the step-up if these underwhelm; it is NOT built.
// ---------------------------------------------------------------------------

export const JINGLES = [
  'K-B-U-N-K-C! The Bunker! KC Tech Radio, the last clear signal in the Midwest!',
  'From under Union Station, up through the static: K-B-U-N-K-C, KC Tech Radio!',
  'Turn that dial and lock it in: K-B-U-N-K-C, the last clear signal in the Midwest!',
  'No fallout, just the facts: K-B-U-N-K-C, KC Tech Radio!',
  'Tubes are warm and the signal is strong: K-B-U-N-K-C, the Bunker, KC Tech Radio!',
  'Kay-Bun, Kay-Cee! K-B-U-N-K-C! Kansas City\u2019s own, KC Tech Radio!',
];

// Dispatches from the Bunker (the Producer's Desk bit, renamed in-world
// Nov 20, 2026): a short recurring fixed-copy bit, once per hour.
// The producer (a Thompson-esque ghost in the control room) rants about the
// industry itself. No story facts in here, ever; this is pure production
// color, drawn from this pool by hash of the hour.
// ---------------------------------------------------------------------------

export const PRODUCERS_DESK = [
  "Dispatch from the Bunker: a reminder that a demo is not a product, a waitlist is not a business, and a valuation is not revenue. We will keep reading the wires until the industry learns the difference.",
  "Dispatch from the Bunker: somewhere right now, a founder is rehearsing the word 'revolutionary' in a mirror. The product does not exist yet. The press release does. That is the whole business model, and we are here to document it.",
  "A note from the Bunker: when every company in a sector announces the same feature on the same day, nobody invented anything. Somebody shipped, and the rest of them panicked in public. Watch for it. We do.",
  "Dispatch from the Bunker: the term 'AI-powered' now appears on products that contain neither. Read the fine print, check the wire, and never trust a keynote that starts with a drone shot.",
  "The Bunker, house rules: we believe in deadlines, denominators, and reading past the headline. If a story cannot survive its own second paragraph, we will still read it, but we will read it in that tone.",
  "Dispatch from the Bunker: buy the ticket, take the ride, but read the prospectus first. The tech industry runs on beautiful stories told at high speed. This station runs on the wire. The wire wins.",
  "A dispatch from the Bunker: every era gets the bubble it deserves. Ours has better fonts. Stay skeptical, stay hydrated, and stay tuned.",
];

// ---------------------------------------------------------------------------
// Music block lead-ins, by listing kind. format.js composes:
//   <lead> <artist> at <venue>, <when>.
// Artist, venue, and date/time come from the music feed untouched (the
// listings are venue-verified); only these lead-ins carry the attitude.
// ---------------------------------------------------------------------------

export const MUSIC_LEADS = {
  tonight: [
    'Tonight:',
    'On stage tonight:',
    'If you leave the house for one thing tonight:',
    'Tonight, live:',
  ],
  announced: [
    'Just announced:',
    'New on the calendar:',
    'Fresh ink on the booking sheet:',
    'Just added:',
  ],
  weekend: [
    'This weekend:',
    'Weekend pick:',
    'For the weekend warriors:',
    'Coming up this weekend:',
  ],
  jazz: [
    'Jazz pick:',
    'For the jazz heads:',
    'From the jazz watch:',
    'And for the big band faithful:',
  ],
};

// ---------------------------------------------------------------------------
// Station promos. Short station-material bits the format clock uses to
// fill the chain between anchors (see lib/format.js: the hour is one
// continuous chain, and when the wires run short of a span's target the
// gap is filled with station material, never with silence and never with
// a repeated story). Written at varied lengths on purpose: the filler
// solver composes them (with station IDs, weather checks, and desk bits)
// to land within a couple of seconds of the next anchor. No story facts
// in here, ever; this is the station talking about itself.
// ---------------------------------------------------------------------------

export const STATION_PROMOS = [
  'KC Tech Radio. Kansas City\'s tech wire, read out loud, around the clock.',
  'You are listening to KC Tech Radio: Kansas City tech and business, the AI report, and the world on the hour, every hour.',
  'No commercials, no hype, no vaporware. KC Tech Radio reads the wires so you do not have to.',
  'At the top of every hour, the news runs inside-out on KC Tech Radio: Kansas City first, then the statehouse, the region, the nation, and the world last, in that order.',
  'The Kansas City Tech and Business Report: who is building, who is hiring, and who is actually shipping, right here in the metro.',
  'The AI Report, on KC Tech Radio: new models, big funding, and the business of artificial intelligence, with the keynote fog scraped off.',
  'Kansas City music, verified at the venue: the clubs, the big rooms, and the jazz joints, on KC Tech Radio.',
  'KC Tech Radio never repeats a story. The wire is deep, the cycle is long, and the news stays fresh, twenty four hours a day.',
  'From the Crossroads to the Northland, from Overland Park to Independence: if it ships in Kansas City, it is on KC Tech Radio.',
  'This is KC Tech Radio, where the hype comes to be fact-checked by the wire itself. Builders over bloviators, products over press releases, Kansas City over everybody.',
  'A word about how this station works: every headline you hear comes straight off the news wires, read around the clock. No story airs twice, the clock never lies, and the news starts where you live: Kansas City first, the world after. That is the whole format, and we think it is the right way up.',
  'Stay with KC Tech Radio through the hour: local tech and business, the AI report, business and markets, and the producer\'s desk, all before the news comes back around at the top.',
];

// ---------------------------------------------------------------------------
// Sign-offs, used by the end-of-hour station ID right before world news.
// format.js appends nothing after these except the factual time line that
// is part of the station ID script.
// ---------------------------------------------------------------------------

export const SIGN_OFFS = [
  'The top of the hour is next, right here on KC Tech Radio. Kansas City first, the world after. Keep your head down and your skepticism up.',
  'News at the top of the hour is next, on KC Tech Radio. Straight facts, coming in hot, starting close to home.',
  'Top of the hour news is next. Stay with KC Tech Radio; the wire does not blink.',
  'Next, the news at the top of the hour, on KC Tech Radio. Same time, same channel, same beautiful noise.',
];
