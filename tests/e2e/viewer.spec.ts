import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const FIX = path.resolve("tests/fixtures");
const SHOTS = path.resolve("test-results/screens");
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page, name: string) {
  await page.locator("#file-picker").setInputFiles(path.join(FIX, name));
  await expect(page.locator(".file-name")).toHaveText(name);
}

let cspViolations: string[] = [];
test.beforeEach(async ({ page }) => {
  cspViolations = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text());
  });
  await page.goto("/");
});
test.afterEach(() => {
  expect(cspViolations, "CSP violations").toEqual([]);
});

test("empty state", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Unfold" })).toBeVisible();
  await expect(page.locator(".mode-switch")).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/00-empty.png` });
});

test("markdown: preview, toggle to raw with button and keyboard", async ({ page }) => {
  await open(page, "sample.md");
  const body = page.locator(".markdown-body");
  await expect(body.locator("h1")).toContainText("Unfold sample");
  await expect(body.locator("table")).toBeVisible();
  await expect(body.locator(".alert-note")).toBeVisible();
  await expect(body.locator(".mermaid-diagram svg")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".toc")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-markdown.png` });

  await page.getByRole("tab", { name: "Raw" }).click();
  await expect(page.locator(".raw .ln").first()).toContainText("---");
  await expect(page.locator(".markdown-body")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/02-markdown-raw.png` });

  await page.keyboard.press(`${mod}+Slash`);
  await expect(page.locator(".markdown-body h1")).toBeVisible();
  await page.keyboard.press(`${mod}+Slash`);
  await expect(page.locator(".raw")).toBeVisible();
});

test("markdown: in-page anchor links scroll instead of navigating", async ({ page }) => {
  await open(page, "sample.md");
  await page.locator(".markdown-body a", { hasText: "jump to the table" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#tables")).toBeInViewport();
});

test("hostile markdown cannot run scripts or restyle the app", async ({ page }) => {
  await open(page, "xss.md");
  await expect(page.locator(".markdown-body")).toContainText("Safe text after.");
  await page.locator(".markdown-body a", { hasText: "click me" }).click();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  await expect(page.locator(".markdown-body iframe, .markdown-body script, .markdown-body style")).toHaveCount(0);
  await expect(page.locator("body")).toBeVisible();
  await expect(page.locator(".topbar")).toBeVisible();
});

test("json tree expands and collapses; jsonc is accepted", async ({ page }) => {
  await open(page, "package.json");
  await expect(page.locator(".j-key").first()).toHaveText('"name"');
  await expect(page.getByText('"deep"')).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.getByText('"deep"')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-json.png` });
  await open(page, "tsconfig.json");
  await expect(page.getByText("comments / trailing commas ignored")).toBeVisible();
});

test("csv: sort and filter", async ({ page }) => {
  await open(page, "data.csv");
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page.locator("th", { hasText: "stars" }).click();
  await page.locator("th", { hasText: "stars" }).click(); // descending
  await expect(page.locator("tbody tr").first().locator("td").nth(2)).toHaveText("tauri");
  await page.screenshot({ path: `${SHOTS}/04-csv.png` });
  await page.getByPlaceholder("Filter rows…").fill("rust");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByText("2 of 6 rows")).toBeVisible();
});

test("notebook renders cells and outputs", async ({ page }) => {
  await open(page, "notebook.ipynb");
  await expect(page.locator(".nb-md h1")).toHaveText(/Notebook demo/);
  await expect(page.locator(".nb-html table")).toBeVisible();
  await expect(page.locator("img.nb-image")).toBeVisible();
  expect(await page.locator("img.nb-image").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(160);
  await expect(page.locator(".nb-error")).toContainText("ZeroDivisionError");
  await page.screenshot({ path: `${SHOTS}/05-notebook.png` });
});

test("diff renders files with add/delete rows", async ({ page }) => {
  await open(page, "change.diff");
  await expect(page.locator(".diff-file")).toHaveCount(2);
  await expect(page.locator(".diff-add").first()).toContainText('"""Say hello."""');
  await page.screenshot({ path: `${SHOTS}/06-diff.png` });
});

test("log: level chips and filter", async ({ page }) => {
  await open(page, "app.log");
  await expect(page.locator(".log-lines .ln")).toHaveCount(10);
  await page.locator(".chip-info").click();
  await expect(page.locator(".log-lines .ln:visible")).toHaveCount(7);
  await page.getByPlaceholder("Filter lines…").fill("job 42");
  await expect(page.locator(".log-lines .ln:visible")).toHaveCount(1);
  await page.getByPlaceholder("Filter lines…").fill("");
  await page.locator(".chip-info").click();
  await page.screenshot({ path: `${SHOTS}/07-log.png` });
});

test("mermaid file renders a diagram", async ({ page }) => {
  await open(page, "flow.mmd");
  await expect(page.locator(".mermaid-diagram svg")).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/08-mermaid.png` });
});

test("html preview is sandboxed (scripts don't run)", async ({ page }) => {
  await open(page, "page.html");
  const frame = page.frameLocator("iframe.html-preview");
  await expect(frame.locator("h1")).toHaveText("Static HTML preview");
  await expect(frame.locator("body")).not.toContainText("SCRIPT RAN");
});

test("code files show highlighted source with no toggle", async ({ page }) => {
  await open(page, "hello.py");
  await expect(page.locator(".mode-switch")).toBeHidden();
  await expect(page.locator(".raw .hljs-keyword").first()).toBeVisible();
  await expect(page.locator(".raw .ln")).toHaveCount(10);
  await page.screenshot({ path: `${SHOTS}/09-code.png` });
});

test("find highlights matches and opens collapsed sections", async ({ page }) => {
  await open(page, "sample.md");
  await page.keyboard.press(`${mod}+KeyF`);
  await page.getByPlaceholder("Find…").fill("hidden until");
  await expect(page.locator("mark.find-hit")).toHaveCount(1);
  await expect(page.locator("mark.find-hit.current")).toBeVisible();
  await expect(page.locator(".find-count")).toHaveText("1 / 1");
  await page.keyboard.press("Escape");
  await expect(page.locator("mark.find-hit")).toHaveCount(0);
});

test("dark mode", async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1200, height: 820 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await open(page, "sample.md");
  await expect(page.locator(".mermaid-diagram svg")).toBeVisible({ timeout: 15000 });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(13, 17, 23)");
  await page.screenshot({ path: `${SHOTS}/10-markdown-dark.png` });
  await open(page, "app.log");
  await page.screenshot({ path: `${SHOTS}/11-log-dark.png` });
  await ctx.close();
});

test("narrow window stays usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await open(page, "sample.md");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${SHOTS}/12-narrow.png` });
});
