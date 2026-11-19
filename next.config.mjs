/** @type {import('next').NextConfig} */
const nextConfig = {
  // Nothing fancy: the whole station is a handful of API routes plus one page.
  reactStrictMode: true,
  // msedge-tts drives a real WebSocket via `ws`, whose internals (dynamic
  // requires, native buffer helpers) break when webpack bundles them.
  // Keep the TTS stack external so Node loads it from node_modules as-is.
  serverExternalPackages: ['msedge-tts', 'ws', 'https-proxy-agent'],
};

export default nextConfig;
