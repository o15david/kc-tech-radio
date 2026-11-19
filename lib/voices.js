// ============================================================================
// VOICE CONFIGURATION — the single place to change who reads the news.
//
// KC Tech Radio's primary audio is pre-rendered server-side with Microsoft
// Edge TTS neural voices (free, no API key, no AI credits) via /api/audio.
// The browser's speechSynthesis is only a fallback if an MP3 fails.
//
// To recast the station, edit the two names below. Any Edge neural voice
// ShortName works (e.g. en-US-GuyNeural, en-GB-RyanNeural).
//
// The station has two hosts:
//   - The ANCHOR (Christopher) reads the shows: KC tech & business, the AI
//     Report, tech headlines, business, music, station IDs.
//   - The CO-HOST (Aria) reads the News at the Top of the Hour block (the
//     inside-out general news block) so the hour opens with a distinct
//     read, NPR-style, and she plays host B in the two-host banter
//     exchanges inside the anchor's shows: she reacts, he counters.
// ============================================================================

/** Anchor voice (host A): the shows and everything not otherwise assigned. */
export const ANCHOR_VOICE = 'en-US-ChristopherNeural';

/** Co-host voice (host B): the top-of-hour news block + banter reactions. */
export const COHOST_VOICE = 'en-US-AriaNeural';

/** Every voice the /api/audio route is allowed to render (abuse guard). */
export const ALLOWED_VOICES = [ANCHOR_VOICE, COHOST_VOICE];

/**
 * Pick the voice for a playlist segment. A segment may carry an explicit
 * `voice` (banter exchanges set one per line: reactions are the co-host,
 * counters are the anchor); that always wins. Otherwise the top-of-hour
 * general news block (intro + its stories) uses the co-host voice, and
 * everything else uses the anchor.
 */
export function voiceForSegment(segment) {
  if (segment.voice) return segment.voice;
  if (segment.blockKey === 'general-news') return COHOST_VOICE;
  return ANCHOR_VOICE;
}
