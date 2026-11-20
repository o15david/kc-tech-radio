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
// Voice arrangement (David's ruling, Nov 20, 2026): ALL stories are read
// by the ANCHOR (Christopher). The co-host voice (Aria) previously read
// the inside-out news section (state / regional / national / global /
// newsletter); David found her grating and ordered every story moved to
// the male voice. Aria now survives in exactly one place: the social
// caller segments, which carry her as an explicit per-segment voice so
// callers still sound like different people phoning in.
// ============================================================================

/** Anchor voice: every story and station segment. */
export const ANCHOR_VOICE = 'en-US-ChristopherNeural';

/** Caller voice: social caller segments only (explicit per segment). */
export const COHOST_VOICE = 'en-US-AriaNeural';

/** Every voice the /api/audio route is allowed to render (abuse guard). */
export const ALLOWED_VOICES = [ANCHOR_VOICE, COHOST_VOICE];

/**
 * Pick the voice for a queue segment. A segment may carry an explicit
 * `voice`; that always wins (the social callers carry Aria explicitly).
 * Everything else, every story in every category, uses the anchor.
 */
export function voiceForSegment(segment) {
  if (segment.voice) return segment.voice;
  return ANCHOR_VOICE;
}
