import { defineConfig } from "astro/config"

// Public marketing site for Threa. Static output — no SSR, no client
// framework. The one bit of interactivity (the hero chat animation) is
// plain CSS + a small inline <script>, so there are no hydration islands.
export default defineConfig({
  site: "https://threa.io",
  devToolbar: { enabled: false },
})
