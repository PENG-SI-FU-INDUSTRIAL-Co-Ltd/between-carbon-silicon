import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const isGitHubPages = process.env.GITHUB_ACTIONS === "true";

export default defineConfig({
  site: isGitHubPages
    ? "https://peng-si-fu-industrial-co-ltd.github.io"
    : "https://between.ghost.io",
  base: isGitHubPages ? "/between-carbon-silicon" : "/",
  output: "static",
  integrations: [sitemap()],
});
