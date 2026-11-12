// Visual Streams — crawler
// For each source site it:
//   1. reads the homepage (and any RSS/Atom feed) for images
//   2. finds the site's project / work / case-study pages — from the sitemap and from
//      "Work" / "Projects" index pages linked on the homepage
//   3. visits project pages it hasn't seen before (a few per site per run, newest first),
//      collecting each project's images
// Project pages are remembered, so every daily run digs a little deeper and only
// fetches what's new. Respects robots.txt. No dependencies: needs Node 18+.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const IMAGES_FILE = path.join(DATA, 'images.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 VisualStreams/2.0';
const TIMEOUT_MS = 15000;
const MAX_IMAGES_PER_SITE = 300;     // kept in history per site
const NEW_PROJECTS_PER_RUN = +(process.env.NEW_PROJECTS_PER_RUN || 12);
const IMAGES_PER_PROJECT = 8;
const MIN_DIM = 280;
const CONCURRENCY = +(process.env.CONCURRENCY || 12);
const PAUSE_MS = 250;                // between requests to the same site
const TIME_BUDGET_MS = +(process.env.TIME_BUDGET_MIN || 0) * 60e3;  // 0 = no limit

const PROJECT_WORDS = /(project|work|portfolio|case-?stud|studies|clients?|gallery|projekt|proyecto|progetti|progetto|projet|realisation|realizzazioni|obra|werk|arbeiten|interiors?|hospitality|restaurants?|retail|branding|identity|architecture|showcase|selected)/i;
const NOT_PROJECT = /(\/(tag|tags|category|categories|author|page|feed|wp-json|wp-admin|cart|checkout|account|login|privacy|terms|cookie|legal|contact|about|team|people|careers?|jobs|news|press|blog\/page|search)(\/|$))|\.(pdf|jpe?g|png|gif|webp|zip|mp4|mp3|xml|json|css|js)$/i;

// ---------- helpers ----------
function loadImages() {
  try { return JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf8')); } catch { return { sites: {} }; }
}
function saveImages(db) {
  const tmp = IMAGES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, IMAGES_FILE);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'en' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return { text: text.slice(0, 3_000_000), finalUrl: res.url || url, type: res.headers.get('content-type') || '' };
  } finally { clearTimeout(t); }
}

const decode = s => s
  .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

function abs(u, base) {
  if (!u) return null;
  u = decode(u.trim()).replace(/^['"]|['"]$/g, '');
  if (!u || /^(data|blob|javascript|mailto|tel):/i.test(u)) return null;
  try { return new URL(u, base).href; } catch { return null; }
}
function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}
function bestFromSrcset(srcset) {
  if (!srcset) return null;
  let best = null, bestW = -1;
  for (const part of decode(srcset).split(/,\s+(?=\S)/)) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
    if (w > bestW) { bestW = w; best = u; }
  }
  return best;
}
const hostOf = u => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
const clean = u => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, '') ; } catch { return u; } };

const JUNK = /(logo|icon|favicon|sprite|avatar|badge|spinner|loader|placeholder|blank|pixel|tracking|emoji|gravatar|button|arrow|social|facebook|twitter|instagram|linkedin|pinterest|youtube|vimeo-logo|payment|flag|captcha|cookie|signature|award)/i;
const BAD_EXT = /\.(svg|gif|ico|bmp)(\?|#|$)/i;
const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;
function keepImage(url, w, h) {
  if (!url || BAD_EXT.test(url)) return false;
  const file = url.split('?')[0].split('/').pop() || '';
  if (JUNK.test(file)) return false;
  if ((w && +w < MIN_DIM) || (h && +h < MIN_DIM * 0.6)) return false;
  if (IMG_EXT.test(url)) return true;
  return /(images|image|img|media|uploads|cdn|cloudinary|imgix|squarespace|wixstatic|cargocollective|format=|w=\d|width=)/i.test(url);
}
function upgrade(url) {
  return url
    .replace(/-\d{2,4}x\d{2,4}(\.(jpe?g|png|webp))/i, '$1')
    .replace(/(\?|&)format=\d+w/i, '$1format=1500w')
    .replace(/\/w_\d+,h_\d+[^/]*\//, '/w_1400,c_limit/')
    .replace(/(static\.wixstatic\.com\/media\/[^/]+)\/v1\/.*$/, '$1');
}
const imgKey = src => src.split('?')[0].replace(/-\d{2,4}x\d{2,4}(?=\.)/, '').replace(/^https?:\/\/(www\.)?/, '');

function pageTitle(html) {
  const og = (html.match(/<meta[^>]+property=["']og:title["'][^>]*>/i) || [])[0];
  let t = og ? attr(og, 'content') : (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  t = decode((t || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return t.split(/\s[|–—·:-]\s/)[0].trim().slice(0, 120) || null;
}

// ---------- extraction ----------
function extractFromHtml(html, base) {
  const out = [];
  const add = (u, w, h, title) => {
    const a = abs(u, base);
    if (a && keepImage(a, w, h)) out.push({ src: upgrade(a), title: title || null });
  };
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const tag = m[0];
    const p = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    if (p === 'og:image' || p === 'og:image:url' || p === 'twitter:image') add(attr(tag, 'content'));
  }
  // drop header/footer/nav where logos and partner badges live
  const body = html.replace(/<(header|footer|nav)\b[\s\S]*?<\/\1>/gi, ' ');
  for (const m of body.matchAll(/<(img|source)\b[^>]*>/gi)) {
    const tag = m[0];
    const cand =
      bestFromSrcset(attr(tag, 'data-srcset') || attr(tag, 'srcset') || attr(tag, 'data-lazy-srcset')) ||
      attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') ||
      attr(tag, 'data-image') || attr(tag, 'data-full') || attr(tag, 'data-bg') || attr(tag, 'src');
    add(cand, attr(tag, 'width'), attr(tag, 'height'), attr(tag, 'alt'));
  }
  for (const m of body.matchAll(/background(?:-image)?\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) add(m[2]);
  for (const m of body.matchAll(/data-(?:bg|background|image-src)\s*=\s*"([^"]+)"/gi)) add(m[1]);
  return out;
}

function findFeeds(html, base) {
  const feeds = [];
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    const tag = m[0];
    if (/rel\s*=\s*["']?alternate/i.test(tag) && /(rss|atom)\+xml/i.test(attr(tag, 'type') || '')) {
      const a = abs(attr(tag, 'href'), base);
      if (a && !/comments/i.test(a)) feeds.push(a);
    }
  }
  return [...new Set(feeds)].slice(0, 2);
}

function extractFromFeed(xml, base) {
  const out = [];
  for (const it of xml.split(/<item[\s>]|<entry[\s>]/i).slice(1, 41)) {
    const title = decode(((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim());
    let link = (it.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || attr((it.match(/<link[^>]*rel=["']alternate["'][^>]*>/i) || it.match(/<link[^>]*href=[^>]*>/i) || [''])[0], 'href');
    link = abs(link, base);
    const dateStr = (it.match(/<(pubDate|published|updated|dc:date)[^>]*>([^<]+)</i) || [])[2];
    const date = dateStr ? Date.parse(dateStr) || null : null;
    const imgs = [];
    for (const m of it.matchAll(/<(media:content|media:thumbnail|enclosure)\b[^>]*>/gi)) {
      const type = attr(m[0], 'type') || '';
      if (!type || type.startsWith('image')) imgs.push(attr(m[0], 'url'));
    }
    for (const m of decode(it).matchAll(/<img\b[^>]*>/gi)) imgs.push(bestFromSrcset(attr(m[0], 'srcset')) || attr(m[0], 'src'));
    for (const u of imgs.slice(0, 6)) {
      const a = abs(u, base);
      if (a && keepImage(a)) out.push({ src: upgrade(a), title: title || null, page: link, date });
    }
  }
  return out;
}

// ---------- finding project pages ----------
function isProjectUrl(u, host) {
  let x; try { x = new URL(u); } catch { return false; }
  if (x.host.replace(/^www\./, '') !== host) return false;
  if (NOT_PROJECT.test(x.pathname)) return false;
  const segs = x.pathname.split('/').filter(Boolean);
  if (segs.length < 2) return false;
  // skip language prefixes like /en/
  const s = /^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0]) ? segs.slice(1) : segs;
  if (s.length < 2) return false;
  return PROJECT_WORDS.test(s.slice(0, -1).join('/'));
}
function isIndexUrl(u, host) {
  let x; try { x = new URL(u); } catch { return false; }
  if (x.host.replace(/^www\./, '') !== host) return false;
  const segs = x.pathname.split('/').filter(Boolean);
  const s = /^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0] || '') ? segs.slice(1) : segs;
  return s.length === 1 && PROJECT_WORDS.test(s[0]) && !NOT_PROJECT.test(x.pathname);
}
function links(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) { const a = abs(m[1], base); if (a) out.push(a); }
  return out;
}

async function sitemapUrls(origin, robots) {
  const found = new Map();   // url -> lastmod
  const queue = [...new Set([...(robots.sitemaps || []), origin + '/sitemap.xml', origin + '/sitemap_index.xml'])];
  const done = new Set();
  let fetched = 0;
  while (queue.length && fetched < 6) {
    const sm = queue.shift();
    if (done.has(sm)) continue; done.add(sm);
    let r; try { r = await get(sm, 'application/xml,text/xml'); fetched++; } catch { continue; }
    if (!/<(urlset|sitemapindex)/i.test(r.text)) continue;
    if (/<sitemapindex/i.test(r.text)) {
      const children = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decode(m[1]));
      // prefer sitemaps that look like projects/portfolio/pages over posts, tags, images
      children.sort((a, b) => score(b) - score(a));
      for (const c of children.slice(0, 4)) if (score(c) >= 0) queue.push(c);
      continue;
    }
    for (const m of r.text.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
      const loc = (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1];
      const lm = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1];
      if (loc) found.set(decode(loc), lm ? Date.parse(lm) || 0 : 0);
    }
  }
  return found;
  function score(u) {
    if (/(tag|categor|author|image|video|product|attachment)/i.test(u)) return -1;
    if (PROJECT_WORDS.test(u)) return 2;
    if (/page/i.test(u)) return 1;
    return 0;
  }
}

async function readRobots(origin) {
  const rules = { disallow: [], allow: [], sitemaps: [] };
  try {
    const r = await get(origin + '/robots.txt', 'text/plain');
    if (/<html/i.test(r.text)) return rules;
    let applies = false;
    for (const raw of r.text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      const [k, ...rest] = line.split(':'); const v = rest.join(':').trim();
      if (!k) continue;
      const key = k.toLowerCase();
      if (key === 'user-agent') applies = v === '*';
      else if (key === 'sitemap') { const a = abs(v, origin); if (a) rules.sitemaps.push(a); }
      else if (applies && key === 'disallow' && v) rules.disallow.push(v);
      else if (applies && key === 'allow' && v) rules.allow.push(v);
    }
  } catch {}
  return rules;
}
function allowed(u, robots) {
  let p; try { p = new URL(u).pathname; } catch { return false; }
  const match = list => list.filter(r => p.startsWith(r.replace(/\*.*$/, ''))).reduce((a, r) => Math.max(a, r.length), -1);
  return match(robots.allow) >= match(robots.disallow);
}

// ---------- crawl one site ----------
async function crawlSite(site, prev = {}) {
  const now = Date.now();
  const visited = { ...(prev.visited || {}) };          // project url -> when visited
  const images = [];
  const seen = new Set();
  const push = (arr, page, fallbackTitle, date) => {
    for (const im of arr) {
      const k = imgKey(im.src);
      if (seen.has(k)) continue;
      seen.add(k);
      images.push({ src: im.src, page: im.page || page, title: im.title || fallbackTitle || null, date: im.date || date || null, project: !!im.project });
    }
  };

  const home = await get(site.url);
  const base = home.finalUrl;
  const origin = new URL(base).origin;
  const host = hostOf(base);
  const robots = await readRobots(origin);

  // 1. feeds + homepage
  for (const f of findFeeds(home.text, base)) {
    try { const r = await get(f, 'application/rss+xml,application/atom+xml,application/xml,text/xml'); push(extractFromFeed(r.text, r.finalUrl), base); } catch {}
  }
  // homepage and index images are added after project images, so a picture that appears
  // on both is credited to its project page
  const later = [];
  later.push([extractFromHtml(home.text, base), base]);

  // 2. find project pages: work index pages linked from the homepage, then the sitemap
  const candidates = new Map();   // clean url -> { url, lm } (lm 0 = unknown); insertion order = priority
  const addCand = (u, lm = 0) => { const c = clean(u); const had = candidates.get(c); if (!had) candidates.set(c, { url: u.split('#')[0], lm }); else if (lm) had.lm = lm; };
  const homeLinks = links(home.text, base);
  const indexes = [...new Set([...homeLinks.filter(u => isIndexUrl(u, host)).map(clean), ...(site.url !== base && isIndexUrl(site.url, host) ? [clean(site.url)] : [])])].slice(0, 3);
  for (const u of homeLinks) if (isProjectUrl(u, host)) addCand(u);
  for (const idx of indexes) {
    if (!allowed(idx, robots)) continue;
    await sleep(PAUSE_MS);
    try {
      const r = await get(idx);
      later.push([extractFromHtml(r.text, r.finalUrl).map(x => ({ ...x, page: r.finalUrl })), r.finalUrl]);
      for (const u of links(r.text, r.finalUrl)) {
        const c = clean(u);
        if (c !== clean(idx) && !NOT_PROJECT.test(c) && (isProjectUrl(u, host) || c.startsWith(clean(idx) + '/'))) addCand(u);
      }
    } catch {}
  }
  try {
    const sm = await sitemapUrls(origin, robots);
    const fromMap = [...sm.entries()].filter(([u]) => isProjectUrl(u, host)).sort((a, b) => b[1] - a[1]);
    for (const [u, lm] of fromMap) addCand(u, lm);
  } catch {}

  // 3. visit project pages we haven't seen before (newest first, a few per run)
  const todo = [...candidates.entries()].filter(([k, c]) => !visited[k] && allowed(c.url, robots)).slice(0, NEW_PROJECTS_PER_RUN);
  const projectImages = [];
  for (const [k, { url: u, lm }] of todo) {
    await sleep(PAUSE_MS);
    visited[k] = now;
    try {
      const r = await get(u);
      const title = pageTitle(r.text);
      const imgs = extractFromHtml(r.text, r.finalUrl).slice(0, IMAGES_PER_PROJECT * 2);
      projectImages.push({ page: r.finalUrl, title, date: lm || null, imgs });
    } catch {}
  }
  // images repeated across several project pages are site furniture (footer art, banners) — drop them
  const freq = new Map();
  for (const p of projectImages) for (const k of new Set(p.imgs.map(i => imgKey(i.src)))) freq.set(k, (freq.get(k) || 0) + 1);
  const furniture = new Set([...freq].filter(([, n]) => n >= 3 && n >= projectImages.length * 0.5).map(([k]) => k));
  for (const p of projectImages) {
    push(p.imgs.filter(i => !furniture.has(imgKey(i.src))).slice(0, IMAGES_PER_PROJECT).map(i => ({ ...i, title: p.title, page: p.page, project: true })), p.page, p.title, p.date);
  }
  for (const [arr, page] of later) push(arr.filter(i => !furniture.has(imgKey(i.src))), page);

  return {
    images,
    visited,
    projects: { found: candidates.size, visited: Object.keys(visited).length, remaining: [...candidates.entries()].filter(([k, c]) => !visited[k] && allowed(c.url, robots)).length },
    furniture,
  };
}

// ---------- crawl many ----------
let running = null;
const progress = { running: false, done: 0, total: 0, startedAt: null, finishedAt: null, current: [], skipped: 0 };

function allSites(sources) {
  const map = new Map();
  for (const t of sources.tabs) for (const s of t.sites) if (!map.has(s.domain)) map.set(s.domain, s);
  return [...map.values()];
}

async function crawl(sources, { only = null, staleHours = 0 } = {}) {
  if (running) return running;
  const db = loadImages();
  let list = allSites(sources);
  if (only) list = list.filter(s => only.includes(s.domain));
  if (staleHours) {
    const cutoff = Date.now() - staleHours * 3600e3;
    list = list.filter(s => !db.sites[s.domain] || (db.sites[s.domain].fetchedAt || 0) < cutoff);
  }
  // least recently checked first, so a time-limited run always makes progress
  list.sort((a, b) => ((db.sites[a.domain] || {}).fetchedAt || 0) - ((db.sites[b.domain] || {}).fetchedAt || 0));
  const started = Date.now();
  Object.assign(progress, { running: true, done: 0, total: list.length, startedAt: started, finishedAt: null, current: [], skipped: 0 });

  running = (async () => {
    const queue = [...list];
    let sinceSave = 0;
    async function worker() {
      while (queue.length) {
        if (TIME_BUDGET_MS && Date.now() - started > TIME_BUDGET_MS) { progress.skipped = queue.length; queue.length = 0; break; }
        const site = queue.shift();
        progress.current.push(site.domain);
        const prev = db.sites[site.domain] || { images: [] };
        const firstSeen = new Map((prev.images || []).map(i => [imgKey(i.src), i.firstSeen]));
        const prevByKey = new Map((prev.images || []).map(i => [imgKey(i.src), i]));
        try {
          const r = await crawlSite(site, prev);
          const now = Date.now();
          const fresh = r.images.map(i => {
            const old = prevByKey.get(imgKey(i.src));
            // keep the project credit from an earlier run when today's sighting is only on the homepage
            const keepOld = old && !i.project && old.page && old.page !== i.page && old.title;
            return { src: i.src, page: keepOld ? old.page : i.page, title: keepOld ? old.title : i.title, firstSeen: firstSeen.get(imgKey(i.src)) || i.date || now };
          });
          const have = new Set(fresh.map(i => imgKey(i.src)));
          // keep everything seen before (project pages are only visited once), minus site furniture
          for (const old of prev.images || []) {
            const k = imgKey(old.src);
            if (!have.has(k) && !r.furniture.has(k)) { fresh.push(old); have.add(k); }
          }
          fresh.sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
          db.sites[site.domain] = { fetchedAt: now, ok: true, error: null, visited: r.visited, projects: r.projects, images: fresh.slice(0, MAX_IMAGES_PER_SITE) };
        } catch (e) {
          db.sites[site.domain] = { ...prev, fetchedAt: Date.now(), ok: false, error: String(e.message || e).slice(0, 120) };
        }
        progress.current = progress.current.filter(d => d !== site.domain);
        progress.done++;
        if (++sinceSave >= 25) { saveImages(db); sinceSave = 0; }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    saveImages(db);
    Object.assign(progress, { running: false, finishedAt: Date.now() });
    running = null;
  })();
  return running;
}

module.exports = { crawl, crawlSite, progress, loadImages, extractFromHtml, extractFromFeed, isProjectUrl };

if (require.main === module) {
  const sources = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));
  const tick = setInterval(() => process.stdout.write(`\r${progress.done}/${progress.total} sites`), 1000);
  crawl(sources).then(() => { clearInterval(tick); const db = loadImages(); const n = Object.values(db.sites).reduce((a, s) => a + s.images.length, 0); console.log(`\nDone. ${n} images from ${Object.keys(db.sites).length} sites.`); });
}
