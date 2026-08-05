import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const ORIGINAL = "https://between.ghost.io";
const LOCAL = "http://127.0.0.1:4321";
const reportDir = path.join(ROOT, "verification");
const selectedRoutes = new Set((process.env.VERIFY_ROUTES || "").split(",").filter(Boolean));
const pages = [...new Map(JSON.parse(await readFile(path.join(ROOT, "src/data/pages.json"), "utf8"))
  .map(page => [page.route, page])).values()].filter(page => !selectedRoutes.size || selectedRoutes.has(page.route));
await Promise.all(["original/desktop", "original/mobile", "local/desktop", "local/mobile", "diff/desktop", "diff/mobile"]
  .map(dir => mkdir(path.join(reportDir, dir), { recursive: true })));

const server = spawn(path.join(ROOT, "node_modules/.bin/astro"), ["preview", "--host", "127.0.0.1", "--port", "4321"], {
  cwd: ROOT, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(LOCAL);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Local preview did not start");
}
function safeId(route) {
  return route === "/" ? "index" : route.replace(/^\/|\/$/g, "").replaceAll("/", "__");
}
function csvCell(value = "") {
  return `"${String(value).replaceAll('"', '""').replace(/\r?\n/g, " ")}"`;
}
function pad(png, width, height) {
  const output = new PNG({ width, height });
  output.data.fill(255);
  PNG.bitblt(png, output, 0, 0, png.width, png.height, 0, 0);
  return output;
}
async function compareImages(originalPath, localPath, diffPath) {
  const a = PNG.sync.read(await readFile(originalPath));
  const b = PNG.sync.read(await readFile(localPath));
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pa = pad(a, width, height);
  const pb = pad(b, width, height);
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(pa.data, pb.data, diff.data, width, height, { threshold: 0.12 });
  await writeFile(diffPath, PNG.sync.write(diff));
  return { pixels, ratio: pixels / (width * height), originalSize: `${a.width}x${a.height}`, localSize: `${b.width}x${b.height}` };
}

await waitForServer();
const browser = await chromium.launch({ headless: true });
const rows = [];
for (const item of pages) {
  const id = safeId(item.route);
  const row = { route: item.route };
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const originalPage = await context.newPage();
    const localPage = await context.newPage();
    const originalResponse = await originalPage.goto(ORIGINAL + item.route, { waitUntil: "networkidle", timeout: 60000 });
    const localResponse = await localPage.goto(LOCAL + item.route, { waitUntil: "networkidle", timeout: 60000 });
    for (const p of [originalPage, localPage]) {
      await p.evaluate(async () => {
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        let stablePasses = 0;
        let previousHeight = 0;
        while (stablePasses < 3) {
          for (let y = 0; y < document.body.scrollHeight; y += Math.max(400, innerHeight * .8)) {
            scrollTo(0, y);
            await delay(80);
          }
          scrollTo(0, document.body.scrollHeight);
          await delay(500);
          const currentHeight = document.body.scrollHeight;
          stablePasses = currentHeight === previousHeight ? stablePasses + 1 : 0;
          previousHeight = currentHeight;
        }
        await Promise.race([
          Promise.all([...document.images].filter(image => !image.complete).map(image =>
            new Promise(resolve => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            })
          )),
          delay(5000),
        ]);
      });
    }
    const originalPath = path.join(reportDir, "original", viewport.name, `${id}.png`);
    const localPath = path.join(reportDir, "local", viewport.name, `${id}.png`);
    const diffPath = path.join(reportDir, "diff", viewport.name, `${id}.png`);
    await originalPage.screenshot({ path: originalPath, fullPage: true });
    await localPage.screenshot({ path: localPath, fullPage: true });
    const media = await localPage.evaluate(() => [...document.querySelectorAll("img, audio, video")].map(el => ({
      url: el.currentSrc || el.src,
      ok: !el.getAttribute("src") || el.classList.contains("kg-audio-hide")
        || (el.tagName === "IMG" ? el.complete && el.naturalWidth > 0 : el.readyState > 0),
    })));
    const internalLinks = await localPage.evaluate(() => [...document.querySelectorAll("a[href]")]
      .map(a => new URL(a.href, location.href)).filter(u => u.origin === location.origin).map(u => u.pathname));
    const brokenLinks = [];
    for (const target of [...new Set(internalLinks)]) {
      const response = await context.request.get(LOCAL + target);
      if (response.status() >= 400) brokenLinks.push(`${target}:${response.status()}`);
    }
    const comparison = await compareImages(originalPath, localPath, diffPath);
    row[`${viewport.name}OriginalStatus`] = originalResponse?.status() || 0;
    row[`${viewport.name}LocalStatus`] = localResponse?.status() || 0;
    row[`${viewport.name}BrokenMedia`] = media.filter(m => !m.ok).map(m => m.url).join(" | ");
    row[`${viewport.name}BrokenLinks`] = brokenLinks.join(" | ");
    row[`${viewport.name}DiffRatio`] = comparison.ratio.toFixed(6);
    row[`${viewport.name}OriginalSize`] = comparison.originalSize;
    row[`${viewport.name}LocalSize`] = comparison.localSize;
    await context.close();
  }
  rows.push(row);
}
await browser.close();
server.kill("SIGTERM");

const headers = Object.keys(rows[0]);
await writeFile(path.join(reportDir, "verification.csv"),
  [headers.map(csvCell).join(","), ...rows.map(row => headers.map(h => csvCell(row[h])).join(","))].join("\n") + "\n");
const htmlRows = rows.map(row => `<tr><td><a href="${LOCAL}${row.route}">${row.route}</a></td><td>${row.desktopLocalStatus}</td><td>${(Number(row.desktopDiffRatio) * 100).toFixed(2)}%</td><td>${(Number(row.mobileDiffRatio) * 100).toFixed(2)}%</td><td>${row.desktopBrokenMedia || row.mobileBrokenMedia || "—"}</td><td>${row.desktopBrokenLinks || row.mobileBrokenLinks || "—"}</td><td><a href="diff/desktop/${safeId(row.route)}.png">desktop</a> · <a href="diff/mobile/${safeId(row.route)}.png">mobile</a></td></tr>`).join("\n");
await writeFile(path.join(reportDir, "index.html"), `<!doctype html><meta charset="utf-8"><title>Between migration verification</title><style>body{font:14px system-ui;margin:32px}table{border-collapse:collapse;width:100%}th,td{padding:8px;border:1px solid #ccc;text-align:left;vertical-align:top}td:first-child{max-width:360px;overflow-wrap:anywhere}</style><h1>Visual verification</h1><p>Pixel ratios include intentional removal of Ghost membership, newsletter, comments, and admin UI.</p><table><thead><tr><th>Route</th><th>Status</th><th>Desktop diff</th><th>Mobile diff</th><th>Broken media</th><th>Broken links</th><th>Diff images</th></tr></thead><tbody>${htmlRows}</tbody></table>`);
console.log(`Verified ${rows.length} routes.`);
