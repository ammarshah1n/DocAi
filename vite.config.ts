import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5199, strictPort: true },
  resolve: {
    alias: { "@getpaseo/relay/e2ee": fileURLToPath(new URL("./src/stubs/relay-e2ee.ts", import.meta.url)) },
  },
  build: { chunkSizeWarningLimit: 6000 },
});
