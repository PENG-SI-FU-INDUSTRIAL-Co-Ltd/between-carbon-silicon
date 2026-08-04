import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const ORIGIN = "https://between.ghost.io";
const archiveDir = path.join(ROOT, "archive");
const publicDir = path.join(ROOT, "public");
const assetDir = path.join(publicDir, "assets", "archive");
const pageDataDir = path.join(ROOT, "src", "data");
const pageRows = [];
const assetMap = new Map();
const failures = [];
const external = new Map();
const queue = [];
const queued = new Set();
const visited = new Set();
const assetTypes = new Set(["image", "media", "font", "stylesheet", "script"]);

await Promise.all([
  mkdir(path.join(archiveDir, "html"), { recursive: true }),
  mkdir(path.join(archiveDir, "network"), { recursive: true }),
  mkdir(path.join(archiveDir, "screenshots", "desktop"), { recursive: true }),
  mkdir(path.join(archiveDir, "screenshots", "mobile"), { recursive: true }),
  mkdir(assetDir, { recursive: true }),
  mkdir(pageDataDir, { recursive: true }),
  mkdir(path.join(publicDir, "reports"), { recursive: true }),
]);

function cleanUrl(raw, base = ORIGIN) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw, base);
    u.hash = "";
    if (u.origin !== ORIGIN) return u.href;
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref") u.searchParams.delete(key);
    }
    if (u.origin === ORIGIN && isDocumentRouteLike(u.pathname) && !u.pathname.endsWith("/")) u.pathname += "/";
    return u.href;
  } catch {
    return null;
  }
}
function isDocumentRouteLike(pathname) {
  return !/\.[a-zA-Z0-9]{1,8}$/.test(pathname);
}
function routeOf(url) {
  const u = new URL(url);
  let route = u.pathname.replace(/\/+/g, "/");
  if (!path.extname(route) && !route.endsWith("/")) route += "/";
  return route + u.search;
}
function idOf(url) {
  const u = new URL(url);
  const readable = (u.pathname === "/" ? "index" : u.pathname.replace(/^\/|\/$/g, "").replaceAll("/", "__"))
    .replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 150);
  return `${readable || "index"}-${createHash("sha1").update(url).digest("hex").slice(0, 8)}`;
}
function csvCell(value = "") {
  return `"${String(value).replaceAll('"', '""').replace(/\r?\n/g, " ")}"`;
}
function csv(headers, rows) {
  return [headers.map(csvCell).join(","), ...rows.map(r => headers.map(h => csvCell(r[h])).join(","))].join("\n") + "\n";
}
function isDocumentRoute(url) {
  const u = new URL(url);
  if (u.origin !== ORIGIN) return false;
  if (u.searchParams.has("action") || u.pathname.startsWith("/ghost/") || u.pathname.startsWith("/members/")) return false;
  return !/\.(?:png|jpe?g|gif|webp|avif|svg|css|js|mjs|woff2?|ttf|otf|mp3|m4a|wav|ogg|mp4|webm|xml|txt|json|ico)$/i.test(u.pathname);
}
function enqueue(url, source) {
  const clean = cleanUrl(url);
  if (!clean || !isDocumentRoute(clean) || queued.has(clean)) return;
  queued.add(clean);
  queue.push({ url: clean, source });
}
async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "BetweenStaticArchive/1.0" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return { text: await response.text(), contentType: response.headers.get("content-type") || "" };
}

const discoveryFiles = ["sitemap.xml", "sitemap-pages.xml", "sitemap-posts.xml", "sitemap-authors.xml", "sitemap-tags.xml", "rss/", "robots.txt", "llms.txt"];
for (const item of discoveryFiles) {
  const url = `${ORIGIN}/${item}`;
  try {
    const { text, contentType } = await fetchText(url);
    const output = item === "rss/" ? "rss.xml" : item;
    await writeFile(path.join(archiveDir, output), text);
    await writeFile(path.join(publicDir, output), text);
    if (contentType.includes("xml") || item.endsWith(".xml") || item === "rss/") {
      const matches = [...text.matchAll(/<loc>([^<]+)<\/loc>|<link>(https?:\/\/[^<]+)<\/link>/g)];
      for (const match of matches) enqueue(match[1] || match[2], item);
    }
  } catch (error) {
    failures.push({ url, source: "discovery", error: error.message });
  }
}
enqueue(ORIGIN + "/", "root");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();

async function localizeAsset(url, contentType = "") {
  if (assetMap.has(url)) return assetMap.get(url).localPath;
  const u = new URL(url);
  const extFromUrl = path.extname(u.pathname).slice(0, 10);
  const contentExt = contentType.includes("image/jpeg") ? ".jpg" : contentType.includes("image/png") ? ".png"
    : contentType.includes("image/webp") ? ".webp" : contentType.includes("audio/mpeg") ? ".mp3"
    : contentType.includes("text/css") ? ".css" : contentType.includes("javascript") ? ".js"
    : contentType.includes("font/woff2") ? ".woff2" : "";
  const ext = extFromUrl || contentExt;
  const filename = `${createHash("sha256").update(url).digest("hex").slice(0, 20)}${ext}`;
  const localPath = `/assets/archive/${filename}`;
  const row = { url, localPath, contentType, status: "pending", bytes: 0, sourceHost: u.host };
  assetMap.set(url, row);
  try {
    const response = await fetch(url, { headers: { "user-agent": "BetweenStaticArchive/1.0" } });
    row.status = response.status;
    row.contentType = response.headers.get("content-type") || contentType;
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = Buffer.from(await response.arrayBuffer());
    row.bytes = data.length;
    await writeFile(path.join(assetDir, filename), data);
  } catch (error) {
    row.error = error.message;
    failures.push({ url, source: "asset", error: error.message });
  }
  return localPath;
}

while (queue.length) {
  const { url, source } = queue.shift();
  if (visited.has(url)) continue;
  visited.add(url);
  const id = idOf(url);
  const requests = [];
  const onResponse = async response => {
    const req = response.request();
    const row = {
      url: response.url(), method: req.method(), resourceType: req.resourceType(),
      status: response.status(), contentType: response.headers()["content-type"] || "",
    };
    requests.push(row);
    const normalized = cleanUrl(response.url());
    if (!normalized || normalized.startsWith("data:") || normalized.startsWith("blob:")) return;
    const host = new URL(normalized).host;
    if (host !== new URL(ORIGIN).host && !["storage.ghost.io", "images.unsplash.com"].includes(host)) {
      const dep = external.get(host) || { host, requests: 0, examples: new Set() };
      dep.requests++;
      dep.examples.add(normalized);
      external.set(host, dep);
    }
    if (assetTypes.has(req.resourceType()) || /\.(?:png|jpe?g|gif|webp|svg|css|js|woff2?|ttf|mp3|m4a|ogg|mp4|webm)(?:\?|$)/i.test(normalized)) {
      await localizeAsset(normalized, row.contentType);
    }
  };
  page.on("response", onResponse);
  let response;
  try {
    response = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.evaluate(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      for (let y = 0; y < document.body.scrollHeight; y += Math.max(400, innerHeight * .8)) {
        scrollTo(0, y);
        await delay(80);
      }
      scrollTo(0, document.body.scrollHeight);
      await delay(500);
    });
    const status = response?.status() || 0;
    const finalUrl = page.url();
    const html = await page.content();
    const $ = cheerio.load(html);
    const title = $("title").first().text().trim();
    const description = $('meta[name="description"]').attr("content") || "";
    const canonical = $('link[rel="canonical"]').attr("href") || finalUrl;
    const og = {};
    $('meta[property^="og:"]').each((_, el) => { og[$(el).attr("property").slice(3)] = $(el).attr("content") || ""; });
    $("a[href]").each((_, el) => {
      const href = cleanUrl($(el).attr("href"), finalUrl);
      if (!href) return;
      if (href.startsWith(ORIGIN) && isDocumentRoute(href)) enqueue(href, finalUrl);
      else if (!href.startsWith(ORIGIN) && /^https?:/.test(href)) {
        const host = new URL(href).host;
        const dep = external.get(host) || { host, requests: 0, examples: new Set() };
        dep.examples.add(href);
        external.set(host, dep);
      }
    });
    const assetCandidates = new Set();
    $("[src], [poster]").each((_, el) => {
      for (const attr of ["src", "poster"]) {
        const absolute = cleanUrl($(el).attr(attr), finalUrl);
        if (absolute && /^https?:/.test(absolute) && !absolute.includes("/ghost/auth-frame")) assetCandidates.add(absolute);
      }
    });
    $("[srcset]").each((_, el) => {
      for (const part of ($(el).attr("srcset") || "").split(",")) {
        const absolute = cleanUrl(part.trim().split(/\s+/, 1)[0], finalUrl);
        if (absolute && /^https?:/.test(absolute)) assetCandidates.add(absolute);
      }
    });
    await Promise.all([...assetCandidates].map(asset => localizeAsset(asset)));
    const rewriteAttrs = ["src", "poster", "href"];
    for (const attr of rewriteAttrs) {
      $(`[${attr}]`).each((_, el) => {
        const raw = $(el).attr(attr);
        const absolute = cleanUrl(raw, finalUrl);
        if (absolute && assetMap.has(absolute)) $(el).attr(attr, assetMap.get(absolute).localPath);
        else if (absolute?.startsWith(ORIGIN) && attr === "href") $(el).attr(attr, routeOf(absolute));
      });
    }
    $("[srcset]").each((_, el) => {
      const rewritten = ($(el).attr("srcset") || "").split(",").map(part => {
        const [raw, descriptor] = part.trim().split(/\s+/, 2);
        const absolute = cleanUrl(raw, finalUrl);
        return `${assetMap.get(absolute)?.localPath || raw}${descriptor ? ` ${descriptor}` : ""}`;
      }).join(", ");
      $(el).attr("srcset", rewritten);
    });
    $("script, style, link[rel=stylesheet], iframe[src*='/ghost/auth-frame']").remove();
    $(".gh-portal-triggerbtn-wrapper, .gh-announcement-bar, [data-portal], form[data-members-form], .gh-subscribe, .footer-cta").remove();
    const body = $("body").html() || "";
    await writeFile(path.join(archiveDir, "html", `${id}.html`), html);
    await writeFile(path.join(archiveDir, "network", `${id}.json`), JSON.stringify(requests, null, 2));
    await page.screenshot({ path: path.join(archiveDir, "screenshots", "desktop", `${id}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(archiveDir, "screenshots", "mobile", `${id}.png`), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    pageRows.push({ url, route: routeOf(url), source, status, finalUrl, title, description, canonical, og, body, id });
  } catch (error) {
    failures.push({ url, source: "page", error: error.message });
  } finally {
    page.off("response", onResponse);
  }
}
await browser.close();

pageRows.sort((a, b) => a.route.localeCompare(b.route));
await writeFile(path.join(pageDataDir, "pages.json"), JSON.stringify(pageRows, null, 2));
await writeFile(path.join(archiveDir, "pages.csv"), csv(
  ["url", "route", "source", "status", "finalUrl", "title", "description", "canonical"],
  pageRows
));
await writeFile(path.join(archiveDir, "assets.csv"), csv(
  ["url", "localPath", "contentType", "status", "bytes", "sourceHost", "error"],
  [...assetMap.values()]
));
await writeFile(path.join(archiveDir, "failed-urls.csv"), csv(["url", "source", "error"], failures));
await writeFile(path.join(archiveDir, "external-dependencies.csv"), csv(
  ["host", "requests", "examples"],
  [...external.values()].map(d => ({ host: d.host, requests: d.requests, examples: [...d.examples].slice(0, 5).join(" | ") }))
));
console.log(`Archived ${pageRows.length} pages, ${assetMap.size} assets; ${failures.length} failures.`);
