// Tailwind needs a PostCSS plugin under webpack (`next dev --webpack`). Turbopack handles Tailwind
// through the loader in next.config.ts instead, so the plugin is left out there to avoid running twice.
const usesWebpack = process.argv.includes("--webpack") || !!process.env.LIFESYNC_WEBPACK;
const config = { plugins: usesWebpack ? { "@tailwindcss/postcss": {} } : {} };
export default config;
