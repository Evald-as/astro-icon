import { defineConfig } from "astro/config";
import icon from "../packages/core/src/index.js";

// https://astro.build/config
export default defineConfig({
  integrations: [
    icon({
      iconDir: ["src/icons", "src/assets/icons"],
    }),
  ],
});


