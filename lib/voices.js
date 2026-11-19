// ============================================================================
// VOICE CONFIGURATION — the single place to change who reads the news.
//
// KC Tech Radio's primary audio is pre-rendered server-side with Microsoft
// Edge TTS neural voices (free, no API key, no AI credits) via /api/audio.
// The browser's speechSynthesis is only a fallback if an MP3 fails.
//
// To recast the station, edit the two names below. Any Edge neural voice
// ShortName works (e.g. en-US-GuyNeural, en-GB-RyanNeural). The global news
// block gets its own voice so the top of the hour sounds distinct, NPR-style.
// ============================================================================

/** Default anchor voice for everything except the global news block. */
export const ANCHOR_VOICE = 'en-US-ChristopherNeural';

/** Voice for the World News block at the top of every hour. */
export const GLOBAL_NEWS_VOICE = 'en-US-AriaNeural';

/** Every voice the /api/audio route is allowed to render (abuse guard). */
export const ALLOWED_VOICES = [ANCHOR_VOICE, GLOBAL_NEWS_VOICE];

/**
 * Pick the voice for a playlist segment. Segments carry their blockKey from
 * the format clock; the global-news block (intro + its stories) uses the
 * global voice, everything else uses the anchor.
 */
export function voiceForSegment(segment) {
  if (segment.blockKey === 'global-news') return GLOBAL_NEWS_VOICE;
  return ANCHOR_VOICE;
}
