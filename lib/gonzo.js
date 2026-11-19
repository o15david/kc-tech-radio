// ============================================================================
// THE GONZO STYLE FILE — every piece of attitude on KC Tech Radio lives here.
//
// The format is TBPN's pacing and NPR's polish, produced as if Hunter S.
// Thompson were running the board: savage about hype cycles, vaporware,
// keynote theater, and press-release journalism, wired and funny, but the
// NEWS ITSELF IS NEVER TOUCHED. Story headlines, summaries, and attributions
// come straight from the RSS wires and are assembled verbatim in format.js.
// The gonzo layer exists only in these fixed, hand-written template pools:
// show opens, transitions, station IDs, the top-of-hour block framing, the
// producer's desk, sign-offs, and the two-host banter pools.
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
    'Now, the Kansas City music scene, on KC Tech Radio. Live music is the last honest business in America: no demo, no vapor, just a room, a band, and a door count. Here is who is playing.',
    'The Kansas City music rundown. Somewhere tonight there is a drummer earning every penny the hard way. This is where, and when.',
    'Music, Kansas City style. The clubs are booked, the amps are warm, and the listings are verified at the venue, the way the good Lord and the box office intended. The rundown, now.',
    'Time to check the scene: Kansas City live music, from dive bars to the big rooms, read straight off the venue calendars.',
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

// ---------------------------------------------------------------------------
// Two-host banter. Inside the KC Tech & Business Report and The AI Report,
// one story per airing gets a short exchange: the anchor (Christopher)
// reads the story exactly as usual, the co-host (Aria) REACTS with a line
// from BANTER_REACTIONS, and the anchor lands a COUNTER from
// BANTER_COUNTERS. The lines are written to follow ANY story, because the
// story they attach to is chosen by hash at runtime: they riff on the
// industry, the hype, and the ritual, never on the facts of the story
// itself (facts stay verbatim from the wire; see the hard rule above).
// Editorial stance, per the README: snarky and funny, self-deprecating to
// KC and tech, pro-KC, pro-tech, pro-business, anti-hype and anti-spin,
// nonpartisan equal-opportunity snark. Never a curmudgeon.
// ---------------------------------------------------------------------------

export const BANTER_REACTIONS = [
  'Bold of them to put that in a press release with a straight face.',
  'I read the fine print so you do not have to, and the fine print is doing a lot of heavy lifting there.',
  'Somewhere, a venture capitalist just felt a disturbance in the force.',
  'And the demo, I assume, worked perfectly on the first try, in front of witnesses.',
  'That is either genius or a cry for help, and the market will decide which by Friday.',
  'Notice the word "revolutionary" did not appear once. Growth.',
  'Kansas City has entered the chat.',
  'I give that roadmap eighteen months before it becomes a memoir.',
  'The engineers are nodding. The marketing department is sweating. Balance is restored.',
  'Filed under: things that were supposed to be impossible last year.',
  "Somebody's board deck just got a brand-new slide.",
  "And yet the pilot program will still be 'coming soon' in three years.",
  'That sound you hear is a thousand founders updating their pitch decks in real time.',
  'Credit where due: at least somebody shipped something.',
  'The comments section is going to be a war zone, and I, for one, brought popcorn.',
];

export const BANTER_COUNTERS = [
  'In fairness, that is more than most companies ship in a year.',
  'Say what you want, the money is rarely wrong about where it is going. Rarely.',
  'Kansas City takeaway: build the boring version that works, and eat their lunch.',
  'We will keep an eye on it. The wire always collects its debts.',
  'Around here, we call that a Tuesday.',
  'The hype is free. The product is what costs money. Watch the product.',
  'Somewhere in the Crossroads, a founder just smiled and got back to work.',
  "Noted, logged, and filed under 'prove it.' Onward.",
  'And that is why we read the second paragraph on this station.',
  'If it survives contact with actual users, it might even be news.',
  'The Midwest thanks them for the beta test. We will take the finished version.',
  'Put it on the board. We grade on shipping, not on keynote applause.',
  'Fair point. The rebuttal, as always, will be a product launch.',
  'Which is exactly why this station exists. Onward.',
];
