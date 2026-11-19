// ============================================================================
// THE GONZO STYLE FILE — every piece of attitude on KC Tech Radio lives here.
//
// The format is TBPN's pacing and NPR's polish, produced as if Hunter S.
// Thompson were running the board: savage about hype cycles, vaporware,
// keynote theater, and press-release journalism, wired and funny, but the
// NEWS ITSELF IS NEVER TOUCHED. Story headlines, summaries, and attributions
// come straight from the RSS wires and are assembled verbatim in format.js.
// The gonzo layer exists only in these fixed, hand-written template pools:
// show opens, transitions, station IDs, the global block framing, the
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
// clock in lib/format.js. The global block has its own framing pool below.
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
    'Now, the Kansas City music scene, on KC Tech Radio. Live music is the last honest business in America: no demo, no vapor, just a room, a band, and a door count. Here is who is playing.',
    'The Kansas City music rundown. Somewhere tonight there is a drummer earning every penny the hard way. This is where, and when.',
    'Music, Kansas City style. The clubs are booked, the amps are warm, and the listings are verified at the venue, the way the good Lord and the box office intended. The rundown, now.',
    'Time to check the scene: Kansas City live music, from dive bars to the big rooms, read straight off the venue calendars.',
  ],
};

// ---------------------------------------------------------------------------
// Global block framing. NPR-ish: calm, clean, structured. The energy lives
// in the framing line only; the time/date line and the stories stay straight.
// format.js composes: <framing> It is <time> Central Time, <date>. Here are
// the global headlines.
// ---------------------------------------------------------------------------

export const GLOBAL_FRAMING = [
    'World news at the top of the hour, on KC Tech Radio. The planet, as usual, did not wait for permission.',
    'World news at the top of the hour. Beyond the metro, beyond the valley, the whole strange world on the wire.',
    'The top of the hour, and the world report, on KC Tech Radio. Calm voices, straight facts, no fog machine.',
    'World news, top of the hour. The global ledger, read plain, the way it came off the wire.',
    'It is the top of the hour on KC Tech Radio, and the world has been busy while Kansas City slept, worked, and argued about barbecue.',
];

// ---------------------------------------------------------------------------
// Transitions between stories inside a block. The first story in a block
// gets none. Selection is a hash of the segment id, as always.
// ---------------------------------------------------------------------------

export const TRANSITIONS = [
  '',
  'In other news,',
  'Meanwhile, back in the asylum,',
  'Next, and try to stay calm,',
  'Also today, because the wire never sleeps,',
  'On a related note,',
  'Here is another one off the pile.',
  'Turning to the wires,',
  'And because one absurdity deserves another,',
  'Next up, fresh off the wire,',
];

// ---------------------------------------------------------------------------
// Station IDs. format.js appends the factual time check (and weather, when
// available) right after the picked line.
// ---------------------------------------------------------------------------

export const STATION_IDS = [
  'You are listening to KC Tech Radio: Kansas City tech, business, and AI news, around the clock, no commercials, no mercy for vaporware.',
  'KC Tech Radio. Twenty four hours a day of tech, business, and AI news, broadcast from the heart of Kansas City.',
  'This is KC Tech Radio, where the hype comes to be fact-checked by the wire itself.',
  'You are on KC Tech Radio: the local ledger, the AI circus, and the world on the hour, every hour.',
  'KC Tech Radio. All signal, no keynote.',
];

// ---------------------------------------------------------------------------
// The Producer's Desk: a short recurring fixed-copy bit, once per hour.
// The producer (a Thompson-esque ghost in the control room) rants about the
// industry itself. No story facts in here, ever; this is pure production
// color, drawn from this pool by hash of the hour.
// ---------------------------------------------------------------------------

export const PRODUCERS_DESK = [
  "From the producer's desk: a reminder that a demo is not a product, a waitlist is not a business, and a valuation is not revenue. We will keep reading the wires until the industry learns the difference.",
  "From the producer's desk: somewhere right now, a founder is rehearsing the word 'revolutionary' in a mirror. The product does not exist yet. The press release does. That is the whole business model, and we are here to document it.",
  "A note from the producer's desk: when every company in a sector announces the same feature on the same day, nobody invented anything. Somebody shipped, and the rest of them panicked in public. Watch for it. We do.",
  "From the producer's desk: the term 'AI-powered' now appears on products that contain neither. Read the fine print, check the wire, and never trust a keynote that starts with a drone shot.",
  "The producer's desk, house rules: we believe in deadlines, denominators, and reading past the headline. If a story cannot survive its own second paragraph, we will still read it, but we will read it in that tone.",
  "From the producer's desk: buy the ticket, take the ride, but read the prospectus first. The tech industry runs on beautiful stories told at high speed. This station runs on the wire. The wire wins.",
  "A dispatch from the producer's desk: every era gets the bubble it deserves. Ours has better fonts. Stay skeptical, stay hydrated, and stay tuned.",
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
// Sign-offs, used by the end-of-hour station ID right before world news.
// format.js appends nothing after these except the factual time line that
// is part of the station ID script.
// ---------------------------------------------------------------------------

export const SIGN_OFFS = [
  'World news is next, at the top of the hour, right here on KC Tech Radio. Keep your head down and your skepticism up.',
  'The world report is next, top of the hour, on KC Tech Radio. Straight facts, coming in hot.',
  'World news at the top of the hour is next. Stay with KC Tech Radio; the wire does not blink.',
  'Next, the world, at the top of the hour, on KC Tech Radio. Same time, same channel, same beautiful noise.',
];
