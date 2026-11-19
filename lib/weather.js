// Kansas City weather from Open-Meteo: free, no API key, no account.
// If it is unreachable or rate-limited we return null and the format clock
// falls back to a time-check-only segment. Weather is a garnish, never a
// single point of failure.

const KC = { lat: 39.0997, lon: -94.5786 };
const WEATHER_TTL_MS = 15 * 60 * 1000;

// WMO weather codes (Open-Meteo `weather_code`) -> spoken text.
const WMO_TEXT = {
  0: 'clear skies',
  1: 'mostly clear skies',
  2: 'partly cloudy skies',
  3: 'overcast skies',
  45: 'fog',
  48: 'fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'drizzle',
  56: 'freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light rain showers',
  81: 'rain showers',
  82: 'heavy rain showers',
  85: 'snow showers',
  86: 'snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with hail',
};

const cache =
  globalThis.__kctrWeatherCache ||
  (globalThis.__kctrWeatherCache = { fetchedAt: 0, value: null });

/** -> { tempF, condition, windMph } | null */
export async function getKansasCityWeather() {
  if (Date.now() - cache.fetchedAt < WEATHER_TTL_MS && cache.fetchedAt) {
    return cache.value;
  }
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${KC.lat}&longitude=${KC.lon}` +
      '&current=temperature_2m,weather_code,wind_speed_10m' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 900 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error || !data.current) throw new Error('bad payload');
    cache.value = {
      tempF: Math.round(data.current.temperature_2m),
      condition: WMO_TEXT[data.current.weather_code] || 'fair skies',
      windMph: Math.round(data.current.wind_speed_10m),
    };
  } catch {
    cache.value = null;
  }
  cache.fetchedAt = Date.now();
  return cache.value;
}
