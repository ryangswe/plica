import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1200, height: 820 },
  },
  projects: [
    // Chromium is what WebView2 uses on Windows; WebKit is close to WKWebView (macOS) and WebKitGTK (Linux).
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1200, height: 820 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1200, height: 820 } } },
  ],
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
