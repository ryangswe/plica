import { defineConfig } from "vitest/config";

// Tauri expects a fixed dev port and serves the built files from dist/.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // `vite preview` (used by the e2e tests) sends the same CSP the desktop app uses,
  // so anything that would be blocked in the app also fails the tests.
  preview: {
    port: 1420,
    strictPort: true,
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost https: http: data: blob:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    outDir: "dist",
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts"],
  },
});
