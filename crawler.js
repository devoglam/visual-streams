// Visual Streams — crawler
// Visits each source site, finds its images (from RSS/Atom feeds, Open Graph tags,
// <img>/<picture>/srcset, lazy-load attributes and inline background images),
// optionally follows a few project pages, and stores the results in data/images.json.
// No dependencies: needs Node 18+ (built-in fetch).

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const IMAGES_FILE = path.join(DATA, 'images.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const MAX_PER_SITE = 60;      // images kept per site
const MAX_SUBPAGES = 6;       // project pages followed when a homepage is thin
const MIN_DIM = 280;          // ignore images whose declared width/height is smaller
const CONCURRENCY = 8;

// ---------- small helpers ----------
function loadImages() {
  try { return JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf8')); } catch { return { sites: {} }; }
}
function saveImages(db) {
  const tmp = IMAGES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, IMAGES_FILE);
}

async function get(url, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'en' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    return { text: text.slice(0, 3_000_000), finalUrl: res.url || url, type };
  } finally { clearTimeout(t); }
}

const decode = s => s
  .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

function abs(u, base) {
  if (!u) return null;
  u = decode(u.trim()).replace(/^['"]|['"]$/g, '');
  if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:')) return null;
  try { return new URL(u, base).href; } catch { return null; }
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}

// largest candidate from a srcset string
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

const JUNK = /(logo|icon|favicon|sprite|avatar|badge|spinner|loader|placeholder|blank|pixel|tracking|emoji|gravatar|button|arrow|social|facebook|twitter|instagram|linkedin|pinterest|youtube|vimeo-logo|payment|flag|captcha|cookie)/i;
const BAD_EXT = /\.(svg|gif|ico|bmp)(\?|#|$)/i;
const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;

function keepImage(url, w, h) {
  if (!url) return false;
  if (BAD_EXT.test(url)) return false;
  const file = url.split('?')[0].split('/').pop() || '';
  if (JUNK.test(file)) return false;
  if ((w && +w < MIN_DIM) || (h && +h < MIN_DIM * 0.6)) return false;
  // CDNs often omit extensions (Squarespace, Cloudinary, imgix…) — allow those, but
  // require an image-like extension or an image CDN signature otherwise.
  if (IMG_EXT.test(url)) return true;
  return /(images|image|img|media|uploads|cdn|cloudinary|imgix|squarespace|wixstatic|cargocollective|format=|w=\d|width=)/i.test(url);
}

// Upgrade common CDN thumbnails to larger renditions
function upgrade(url) {
  return url
    .replace(/-\d{2,4}x\d{2,4}(\.(jpe?g|png|webp))/i, '$1')                 // WordPress thumbs
    .replace(/(\?|&)format=\d+w/i, '$1format=1500w')                         // Squarespace
    .replace(/\/w_\d+,h_\d+[^/]*\//, '/w_1400,c_limit/')                     // Cloudinary
    .replace(/(static\.wixstatic\.com\/media\/[^/]+)\/v1\/.*$/, '$1');        // Wix original
}

// ---------- extraction ----------
function extractFromHtml(html, base) {
  const out = [];
  const add = (u, w, h, title) => {
    const a = abs(u, base);
    if (a && keepImage(a, w, h)) out.push({ src: upgrade(a), title: title || null });
  };

  // Open Graph / Twitter cards (good hero images)
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const tag = m[0];
    const p = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    if (p === 'og:image' || p === 'og:image:url' || p === 'twitter:image') add(attr(tag, 'content'));
  }
  // <img> and <source> (picture)
  for (const m of html.matchAll(/<(img|source)\b[^>]*>/gi)) {
    const tag = m[0];
    const w = attr(tag, 'width'), h = attr(tag, 'height');
    const alt = attr(tag, 'alt');
    const cand =
      bestFromSrcset(attr(tag, 'data-srcset') || attr(tag, 'srcset') || attr(tag, 'data-lazy-srcset')) ||
      attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') ||
      attr(tag, 'data-image') || attr(tag, 'data-full') || attr(tag, 'data-bg') || attr(tag, 'src');
    add(cand, w, h, alt);
  }
  // inline background images
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) add(m[2]);
  for (const m of html.matchAll(/data-(?:bg|background|image-src)\s*=\s*"([^"]+)"/gi)) add(m[1]);
  return out;
}

function findFeeds(html, base) {
  const feeds = [];
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    const tag = m[0];
    const type = (attr(tag, 'type') || '').toLowerCase();
    if (/rel\s*=\s*["']?alternate/i.test(tag) && /(rss|atom)\+xml/.test(type)) {
      const a = abs(attr(tag, 'href'), base);
      if (a && !/comments/i.test(a)) feeds.push(a);
    }
  }
  return [...new Set(feeds)].slice(0, 2);
}

function extractFromFeed(xml, base) {
  const out = [];
  const items = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  for (const it of items.slice(0, 40)) {
    const title = decode(((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim());
    let link = (it.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || attr((it.match(/<link[^>]*rel=["']alternate["'][^>]*>/i) || it.match(/<link[^>]*href=[^>]*>/i) || [''])[0], 'href');
    link = abs(link, base);
    const dateStr = (it.match(/<(pubDate|published|updated|dc:date)[^>]*>([^<]+)</i) || [])[2];
    const date = dateStr ? Date.parse(dateStr) || null : null;
    const imgs = [];
    for (const m of it.matchAll(/<(media:content|media:thumbnail|enclosure)\b[^>]*>/gi)) {
      const t = m[0]; const type = attr(t, 'type') || '';
      if (!type || type.startsWith('image')) imgs.push(attr(t, 'url'));
    }
    const body = decode(it);
    for (const m of body.matchAll(/<img\b[^>]*>/gi)) imgs.push(bestFromSrcset(attr(m[0], 'srcset')) || attr(m[0], 'src'));
    for (const u of imgs.slice(0, 6)) {
      const a = abs(u, base);
      if (a && keepImage(a)) out.push({ src: upgrade(a), title: title || null, page: link, date });
    }
  }
  return out;
}

// links to project/work pages on the same site
function projectLinks(html, base) {
  const host = new URL(base).host.replace(/^www\./, '');
  const links = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    const a = abs(m[1], base);
    if (!a) continue;
    let u; try { u = new URL(a); } catch { continue; }
    if (u.host.replace(/^www\./, '') !== host) continue;
    const p = u.pathname.toLowerCase();
    if (p.split('/').filter(Boolean).length < 2) continue;
    if (!/(project|work|portfolio|case|studies|gallery|our-work|projekt|proyecto|progetti|realisations|works)/.test(p)) continue;
    if (/\.(pdf|jpe?g|png|zip)$/.test(p)) continue;
    links.add(u.origin + u.pathname);
  }
  return [...links].slice(0, MAX_SUBPAGES);
}

// ---------- crawl one site ----------
async function crawlSite(site) {
  const images = [];
  const seen = new Set();
  const push = (arr, page) => {
    for (const im of arr) {
      const key = im.src.split('?')[0].replace(/-\d{2,4}x\d{2,4}(?=\.)/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({ src: im.src, page: im.page || page, title: im.title || null, date: im.date || null });
    }
  };

  const home = await get(site.url);
  const base = home.finalUrl;

  // 1. feeds (editorial sites, blogs)
  for (const f of findFeeds(home.text, base)) {
    try { const r = await get(f, 'application/rss+xml,application/atom+xml,application/xml,text/xml'); push(extractFromFeed(r.text, r.finalUrl), base); } catch {}
  }
  // 2. homepage images
  push(extractFromHtml(home.text, base), base);

  // 3. follow project pages when the homepage is thin
  if (images.length < 12) {
    for (const link of projectLinks(home.text, base)) {
      if (images.length >= MAX_PER_SITE) break;
      try {
        const r = await get(link);
        const title = decode(((r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()).split(/\s[|–—-]\s/)[0];
        push(extractFromHtml(r.text, r.finalUrl).map(x => ({ ...x, title: x.title || title, page: r.finalUrl })), r.finalUrl);
      } catch {}
    }
  }
  return images.slice(0, MAX_PER_SITE);
}

// ---------- crawl many ----------
let running = null;
const progress = { running: false, done: 0, total: 0, startedAt: null, finishedAt: null, current: [] };

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
  Object.assign(progress, { running: true, done: 0, total: list.length, startedAt: Date.now(), finishedAt: null, current: [] });

  running = (async () => {
    const queue = [...list];
    let sinceSave = 0;
    async function worker() {
      while (queue.length) {
        const site = queue.shift();
        progress.current.push(site.domain);
        const prev = db.sites[site.domain] || { images: [] };
        const firstSeen = new Map(prev.images.map(i => [i.src, i.firstSeen]));
        try {
          const imgs = await crawlSite(site);
          const now = Date.now();
          db.sites[site.domain] = {
            fetchedAt: now, ok: true, error: null,
            images: imgs.map(i => ({ ...i, firstSeen: firstSeen.get(i.src) || i.date || now })),
          };
          // keep previously seen images that dropped off the homepage (up to cap)
          const cur = new Set(imgs.map(i => i.src));
          for (const old of prev.images) if (!cur.has(old.src) && db.sites[site.domain].images.length < MAX_PER_SITE) db.sites[site.domain].images.push(old);
        } catch (e) {
          db.sites[site.domain] = { ...prev, fetchedAt: Date.now(), ok: false, error: String(e.message || e).slice(0, 120) };
        }
        progress.current = progress.current.filter(d => d !== site.domain);
        progress.done++;
        if (++sinceSave >= 20) { saveImages(db); sinceSave = 0; }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    saveImages(db);
    Object.assign(progress, { running: false, finishedAt: Date.now() });
    running = null;
  })();
  return running;
}

module.exports = { crawl, crawlSite, progress, loadImages, extractFromHtml, extractFromFeed };

// CLI: `node crawler.js` crawls everything once
if (require.main === module) {
  const sources = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));
  const tick = setInterval(() => process.stdout.write(`\r${progress.done}/${progress.total} sites`), 1000);
  crawl(sources).then(() => { clearInterval(tick); const db = loadImages(); const n = Object.values(db.sites).reduce((a, s) => a + s.images.length, 0); console.log(`\nDone. ${n} images from ${Object.keys(db.sites).length} sites.`); });
}
