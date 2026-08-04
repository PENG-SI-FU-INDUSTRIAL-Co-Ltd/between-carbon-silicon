import * as cheerio from "cheerio";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const ORIGIN = "https://between.ghost.io";
const pagesPath = path.join(ROOT, "src", "data", "pages.json");
const assetsPath = path.join(ROOT, "archive", "assets.csv");
const pages = JSON.parse(await readFile(pagesPath, "utf8"));
const assetRows = (await readFile(assetsPath, "utf8")).trim().split("\n").slice(1);
const assetMap = new Map();

for (const row of assetRows) {
  const cells = row.match(/"(?:[^"]|"")*"/g);
  if (!cells?.length) continue;
  const values = cells.map(cell => cell.slice(1, -1).replaceAll('""', '"'));
  assetMap.set(values[0], values[1]);
}

function localize(raw, base) {
  if (!raw) return raw;
  try {
    const absolute = new URL(raw, base).href;
    if (assetMap.has(absolute)) return assetMap.get(absolute);
    if (absolute.startsWith(ORIGIN)) return new URL(absolute).pathname;
    return raw;
  } catch {
    return raw;
  }
}

async function fetchHtml(url) {
  const response = await fetch(url, { headers: { "user-agent": "BetweenStaticArchive/1.0" } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

for (const page of pages.filter(item => /^\/(?:tag|author)\//.test(item.route))) {
  let nextUrl = `${ORIGIN}${page.route}`;
  const items = [];
  const seen = new Set();

  while (nextUrl) {
    const html = await fetchHtml(nextUrl);
    const $ = cheerio.load(html);
    $(".gh-list-item").each((_, element) => {
      const href = new URL($(element).find("a[href]").first().attr("href") || "", nextUrl).href;
      if (!href || seen.has(href)) return;
      seen.add(href);
      const clone = $(element).clone();
      clone.find("[src], [poster], [href]").each((__, child) => {
        const node = $(child);
        for (const attr of ["src", "poster", "href"]) {
          const value = node.attr(attr);
          if (value) node.attr(attr, localize(value, nextUrl));
        }
      });
      clone.find("[srcset]").each((__, child) => {
        const node = $(child);
        const rewritten = (node.attr("srcset") || "").split(",").map(part => {
          const [url, descriptor] = part.trim().split(/\s+/, 2);
          return `${localize(url, nextUrl)}${descriptor ? ` ${descriptor}` : ""}`;
        }).join(", ");
        node.attr("srcset", rewritten);
      });
      items.push(clone.prop("outerHTML"));
    });
    const next = $('link[rel="next"]').attr("href");
    nextUrl = next ? new URL(next, nextUrl).href : "";
  }

  const local$ = cheerio.load(page.body);
  const feed = local$(".gh-list-feed").first();
  if (feed.length && items.length) {
    feed.html(items.join(""));
    page.body = local$("body").html() || local$.root().html();
    console.log(`${page.route}: ${items.length} items`);
  }
}

await writeFile(pagesPath, JSON.stringify(pages, null, 2) + "\n");
