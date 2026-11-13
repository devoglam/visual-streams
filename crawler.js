// Visual Streams — crawler (deep edition)
//
// For each source site it:
//   1. reads the homepage (and RSS/Atom feed, if any)
//   2. finds the site's portfolio sections — by link text ("Projects", "Our Work", "Case Studies",
//      "Hospitality", "Retail", "Offices"…) and by address (/projects, /work, /portfolio…)
//   3. walks those sections: category pages, "next page" links and project cards
//   4. visits every project page it finds (a batch per run, newest first) and collects all of
//      the project's images, recording both a screen-size version and the highest-resolution
//      version the site offers
// Everything found is remembered per site, so each run continues where the last one stopped.
// Respects robots.txt. No dependencies: needs Node 18+.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const SITES_DIR = path.join(DATA, 'sites');
const LEGACY_FILE = path.join(DATA, 'images.json');

const TIMEOUT_MS = 15000;
const MAX_IMAGES_PER_SITE = 4000;
const NEW_PROJECTS_PER_RUN = +(process.env.NEW_PROJECTS_PER_RUN || 30);
const IMAGES_PER_PROJECT = 80;
const MAX_DISCOVERY_PAGES = 25;      // index / category / pagination pages read per discovery
const MAX_CANDIDATES = 600;          // project pages remembered per site
const MIN_DIM = 280;
const DISPLAY_W = 1000;              // size used in the grid; the lightbox loads the full version
const CONCURRENCY = +(process.env.CONCURRENCY || 16);
const PAUSE_MS = 350;                // between requests to the same site
const TIME_BUDGET_MS = +(process.env.TIME_BUDGET_MIN || 0) * 60e3;   // 0 = no limit
const REDISCOVER_HOURS = +(process.env.REDISCOVER_HOURS || 20);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'user-agent': UA,
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

// ---------- words that mark portfolio sections and project links ----------
const SECTION = String.raw`(?:all\s+)?(?:of\s+)?(?:our\s+)?(?:selected\s+|recent\s+|latest\s+|featured\s+)?(?:projects?|works?|portfolio|case[\s-]*stud(?:y|ies)|retail|residential|residences|homes|hospitality|design|interiors?|interior[\s-]+design|interior[\s-]+architecture|offices?|office[\s-]+design|workplaces?|workspace|commercial|hotels?|bars?(?:\s*(?:and|&|\+)\s*restaurants?)?|restaurants?(?:\s*(?:and|&|\+)\s*bars?)?|food\s*(?:and|&)\s*beverage|f\s*&\s*b|leisure|branding|identity|architecture|exhibitions?|museums?|culture|cultural|education|healthcare|mixed[\s-]+use|landscape|installations?|events?|experiential|spaces|clients?|archive|showcase|gallery|projekte|projekty|proyectos|progetti|projets|r[ée]alisations|obras|werk|arbeiten|trabajos|lavori)`;
const SECTION_TEXT = new RegExp(`^${SECTION}$`, 'i');
const SECTION_PATH = /^(projects?|works?|our-work|selected-work|portfolio|our-portfolio|case-?stud(y|ies)|all-case-studies|retail|residential|residences|hospitality|design|interiors?|interior-design|interior-architecture|offices?|office-design|workplaces?|commercial|hotels?|bars?|bar-and-restaurant|bars-restaurants|restaurants?|food-and-beverage|f-b|leisure|branding|architecture|exhibitions?|installations?|events|experiential|spaces|archive|showcase|gallery|projekte|projekty|proyectos|progetti|projets|realisations|obras|werk|arbeiten|trabajos|lavori)$/i;
const VIEW_TEXT = /^(?:(?:view|see|explore|discover|read|open)\s+(?:the\s+|this\s+|full\s+)?(?:case[\s-]*stud(?:y|ies)|projects?|work|story|more|gallery)|view|read more|learn more|discover more|explore|see more|more|view all|view case study|full project)\s*[→›»>]*$/i;
const NEXT_TEXT = /^(?:next(?:\s+page)?|older(?:\s+(?:posts|projects|work))?|more\s+(?:projects|work)|load\s+more|show\s+more|[›»→>]|\d{1,2})\s*[›»→>]*$/i;
const PAGINATION_HREF = /(\/page\/\d+\/?$|[?&](page|paged|pg|p)=\d+)/i;
const NOT_PAGE = /(\/(tag|tags|category|categories|author|feed|wp-json|wp-admin|wp-login|cart|checkout|account|login|signin|register|privacy|terms|cookie|cookies|legal|imprint|impressum|contact|about|about-us|team|people|careers?|jobs|press|search|shop|store|products?|newsletter|subscribe)(\/|$))|\.(pdf|jpe?g|png|gif|webp|zip|mp4|mp3|xml|json|css|js|svg|ico)(\?|$)|\/(cdn-cgi|wp-content)\//i;

// ---------- small helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hostOf = u => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
const clean = u => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, ''); } catch { return u; } };
const segsOf = u => { try { const s = new URL(u).pathname.split('/').filter(Boolean); return /^[a-z]{2}(-[a-z]{2})?$/i.test(s[0] || '') ? s.slice(1) : s; } catch { return []; } };

const decode = s => String(s)
  .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const textOf = html => decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function abs(u, base) {
  if (!u) return null;
  u = decode(String(u).trim()).replace(/^['"]|['"]$/g, '');
  if (!u || /^(data|blob|javascript|mailto|tel):/i.test(u)) return null;
  try { return new URL(u, base).href; } catch { return null; }
}
function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}
// all candidates in a srcset as [{u, w}]
function parseSrcset(srcset) {
  if (!srcset) return [];
  return decode(srcset).split(/,\s+(?=\S)/).map(part => {
    const [u, d] = part.trim().split(/\s+/);
    const w = !d ? 0 : d.endsWith('x') ? parseFloat(d) * 1000 : parseFloat(d);
    return u ? { u, w: w || 0 } : null;
  }).filter(Boolean);
}

async function get(url, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { ...BROWSER_HEADERS, accept }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    const text = await res.text();
    return { text: text.slice(0, 4_000_000), finalUrl: res.url || url, type: res.headers.get('content-type') || '' };
  } finally { clearTimeout(t); }
}

// ---------- problem classification & address fallbacks ----------
function classify(e) {
  const st = e && e.status;
  if (st === 404 || st === 410) return 'moved';
  if (st === 401 || st === 403 || st === 429 || st === 503 || (st >= 520 && st <= 530)) return 'blocked';
  return 'unreachable';
}
function errText(e) {
  if (e && e.status) return 'HTTP ' + e.status;
  if (e && e.name === 'AbortError') return 'timed out';
  const c = e && e.cause && (e.cause.code || e.cause.message);
  return c ? String(c) : String((e && e.message) || e);
}
function variants(url) {
  const out = [url];
  let u; try { u = new URL(url); } catch { return out; }
  const other = u.host.startsWith('www.') ? u.host.slice(4) : 'www.' + u.host;
  const flip = u.protocol === 'https:' ? 'http:' : 'https:';
  out.push(`${u.protocol}//${u.host}/`, `${u.protocol}//${other}/`, `${flip}//${u.host}/`, `${flip}//${other}/`);
  return [...new Set(out)];
}
const isChallenge = text => /<title>\s*(Just a moment|Attention Required|Access denied)/i.test(text) || (text.length < 30000 && /cf-browser-verification|challenge-platform/i.test(text.slice(0, 6000)));
async function fetchHome(url) {
  let first = null, blocked = null;
  for (const v of variants(url)) {
    try {
      const r = await get(v);
      if (isChallenge(r.text)) { const e = new Error('HTTP 403'); e.status = 403; throw e; }
      return { r, via: v, firstError: first };
    } catch (e) {
      if (!first) first = e;
      if (!blocked && classify(e) === 'blocked') blocked = e;
      if (classify(e) === 'blocked' && classify(first) === 'blocked' && v !== url) break;
    }
  }
  throw blocked || first;
}
const FEED_PATHS = ['/feed/', '/rss', '/feed.xml', '/rss.xml', '/index.xml', '/?format=rss', '/blog?format=rss'];

// ---------- image URLs: screen size + highest resolution ----------
// whole words only, so 'flagship' or 'iconic-lobby' aren't mistaken for a flag or an icon
const JUNK = /(^|[-_.\s\d])(logos?|icons?|favicon|sprite|avatar|badge|spinner|loader|placeholder|blank|pixel|tracking|emoji|gravatar|button|arrow|social|facebook|twitter|instagram|linkedin|pinterest|youtube|payment|flags?|captcha|cookie|signature|qr-?code|logo[a-z]*)(?=$|[-_.\s\d])/i;
const BAD_EXT = /\.(svg|gif|ico|bmp)(\?|#|$)/i;
const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;
const PARAM_CDN = /(imgix\.net|cdn\.sanity\.io|images\.ctfassets\.net|images\.prismic\.io|datocms-assets\.com|cdn\.shopify\.com|storyblok\.com|twic\.pics|imagekit\.io|images\.unsplash\.com|cdn\.builder\.io|res\.cloudinary\.com\/.*\/fetch|wp\.com|kinsta|b-cdn\.net)/i;
const SIZE_PARAMS = /^(w|h|width|height|fit|crop|q|quality|dpr|auto|fm|resize|rect|ar|s|sz|size|format)$/i;

function looksLikeImage(url) {
  if (!url || BAD_EXT.test(url)) return false;
  if (IMG_EXT.test(url)) return true;
  return /(images|image|img|media|uploads|cdn|cloudinary|imgix|squarespace|wixstatic|cargo|freight|myportfolio|ctfassets|sanity|prismic|datocms|shopify|format=|[?&]w=\d|width=|_next\/image)/i.test(url);
}
function keepImage(url, w, h) {
  if (!looksLikeImage(url)) return false;
  const file = decodeURIComponent((url.split('?')[0].split('/').pop() || '')).toLowerCase();
  if (JUNK.test(file)) return false;
  if ((w && +w > 0 && +w < MIN_DIM) || (h && +h > 0 && +h < MIN_DIM * 0.6)) return false;
  return true;
}

// Given any image URL, work out the largest version the host can serve, and a ~1000px version.
function sizes(url) {
  let u; try { u = new URL(url); } catch { return { full: url, display: url }; }
  const h = u.host;
  // Next.js image optimiser: the original is in ?url=
  if (u.pathname.endsWith('/_next/image') && u.searchParams.get('url')) {
    const orig = abs(u.searchParams.get('url'), u.origin);
    const d = new URL(u.href); d.searchParams.set('w', '1080'); d.searchParams.set('q', '75');
    return { full: orig || url, display: d.href };
  }
  // Squarespace
  if (/squarespace-cdn\.com|static1\.squarespace\.com/.test(h)) {
    const base = u.origin + u.pathname;
    return { full: base + '?format=2500w', display: base + '?format=1000w' };
  }
  // Wix
  const wix = url.match(/^(https?:\/\/static\.wixstatic\.com\/media\/[^/]+)(\/v1\/.*)?$/);
  if (wix) return { full: wix[1], display: wix[2] ? url : wix[1] };
  // Cargo
  if (/freight\.cargo\.site/.test(h)) {
    return { full: url.replace(/\/(w|h)\/\d+\//, '/t/original/'), display: url.replace(/\/t\/original\//, '/w/1000/').replace(/\/(w|h)\/\d+\//, '/w/1000/') };
  }
  // Adobe Portfolio
  if (/myportfolio\.com/.test(h) && /_rw_\d+/.test(url)) {
    return { full: url.replace(/_rw_\d+/, '_rw_1920'), display: url.replace(/_rw_\d+/, '_rw_1200') };
  }
  // Cloudinary
  if (/res\.cloudinary\.com/.test(h) && /\/upload\//.test(u.pathname)) {
    const full = url.replace(/\/upload\/(?:[a-z]{1,3}_[^/]+\/)+/, '/upload/');
    return { full, display: full.replace('/upload/', '/upload/w_1000,c_limit,q_auto,f_auto/') };
  }
  // Query-string resizing CDNs (imgix, Sanity, Contentful, Shopify, Prismic…)
  if (PARAM_CDN.test(h) || [...u.searchParams.keys()].some(k => /^(w|width)$/i.test(k))) {
    const f = new URL(u.href);
    for (const k of [...f.searchParams.keys()]) if (SIZE_PARAMS.test(k)) f.searchParams.delete(k);
    let full = f.href.replace(/\?$/, '');
    if (/cdn\.shopify\.com/.test(h)) full = full.replace(/_(\d+x\d*|\d*x\d+|grande|large|medium|master)(?=\.(jpe?g|png|webp))/i, '');
    const d = new URL(full); d.searchParams.set(/ctfassets|sanity|prismic|imgix|datocms|storyblok|shopify/.test(h) ? 'w' : 'w', '1000');
    return { full, display: d.href };
  }
  // WordPress & similar: "photo-1024x683.jpg" → "photo.jpg"
  const wp = url.replace(/-\d{2,4}x\d{2,4}(?=\.(jpe?g|png|webp)(\?|$))/i, '');
  if (wp !== url) return { full: wp, display: url };
  return { full: url, display: url };
}
// one key per picture, whatever size was requested
function imgKey(url) {
  const f = sizes(url).full;
  return f.replace(/^https?:\/\/(www\.)?/, '').replace(/\?.*$/, '').replace(/-scaled(?=\.)/, '').replace(/\/(t\/original|w\/\d+)\//, '/').replace(/_rw_\d+/, '');
}

// ---------- page extraction ----------
const stripChrome = html => html.replace(/<(header|footer|nav)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, m => /^<noscript/i.test(m) ? m.replace(/<\/?noscript[^>]*>/gi, '') : ' ');

function pageTitle(html) {
  const og = (html.match(/<meta[^>]+property=["']og:title["'][^>]*>/i) || [])[0];
  let t = og ? attr(og, 'content') : (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (!t) t = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  t = textOf(t || '');
  return t.split(/\s[|–—·:-]\s/)[0].trim().slice(0, 120) || null;
}

// Every content image on a page, each as {src (screen size), full (largest), title}
function extractImages(html, base, { og = true, scripts = false } = {}) {
  const out = [];
  const seen = new Set();
  const add = (raw, w, h, title, fullHint) => {
    const a = abs(raw, base);
    if (!a || !keepImage(a, w, h)) return;
    const s = sizes(a);
    let full = s.full;
    const hint = fullHint && abs(fullHint, base);
    if (hint && looksLikeImage(hint) && !BAD_EXT.test(hint)) full = sizes(hint).full;
    const k = imgKey(full);
    if (seen.has(k)) return; seen.add(k);
    out.push({ src: s.display, full, title: title ? textOf(title).slice(0, 140) || null : null });
  };
  if (og) for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const p = (attr(m[0], 'property') || attr(m[0], 'name') || '').toLowerCase();
    if (p === 'og:image' || p === 'og:image:url' || p === 'twitter:image') add(attr(m[0], 'content'));
  }
  const body = stripChrome(html);
  // links that open a full-size image (lightboxes): remember them for the image inside
  const lightbox = new Map();
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]{0,1500}?)<\/a>/gi)) {
    const href = attr('<a ' + m[1] + '>', 'href') || attr('<a ' + m[1] + '>', 'data-href') || attr('<a ' + m[1] + '>', 'data-full');
    if (!href || !IMG_EXT.test(href.split('#')[0])) continue;
    const inner = m[2].match(/<img\b[^>]*>/i);
    if (inner) {
      const k = attr(inner[0], 'data-src') || attr(inner[0], 'src');
      if (k) lightbox.set(abs(k, base), href);
    } else add(href);
  }
  for (const m of body.matchAll(/<(img|source)\b[^>]*>/gi)) {
    const tag = m[0];
    const set = parseSrcset(attr(tag, 'data-srcset') || attr(tag, 'srcset') || attr(tag, 'data-lazy-srcset'));
    const largest = set.length ? set.reduce((a, b) => (b.w > a.w ? b : a)).u : null;
    const plain = attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') || attr(tag, 'data-image') || attr(tag, 'data-bg') || attr(tag, 'src');
    const fullAttr = attr(tag, 'data-full') || attr(tag, 'data-large') || attr(tag, 'data-large_image') || attr(tag, 'data-orig-file') || attr(tag, 'data-zoom-image') || attr(tag, 'data-hires') || attr(tag, 'data-hi-res') || attr(tag, 'data-src-large') || attr(tag, 'data-original-src');
    // grid version: the smallest srcset entry that is still ~800px+ wide
    const screen = set.length ? (set.filter(c => c.w >= 800).sort((a, b) => a.w - b.w)[0] || set.reduce((a, b) => (b.w > a.w ? b : a))).u : null;
    const pick = screen || plain;
    if (!pick) continue;
    const box = lightbox.get(abs(plain || pick, base)) || lightbox.get(abs(pick, base));
    add(pick, attr(tag, 'width'), attr(tag, 'height'), attr(tag, 'alt'), fullAttr || box || largest);
  }
  for (const m of body.matchAll(/background(?:-image)?\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) add(m[2]);
  for (const m of body.matchAll(/data-(?:bg|background|image-src|background-image)\s*=\s*"([^"]+)"/gi)) add(m[1]);
  // galleries built by scripts: image addresses inside embedded JSON (Next.js, Gatsby, JSON-LD…)
  if (scripts) {
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      const s = m[1].replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
      for (const u of s.matchAll(/https?:\/\/[^"'\s\\)<>]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s\\)<>]*)?(?=["'\s\\)<>,])/gi)) add(u[0]);
    }
  }
  return out;
}

function findFeeds(html, base) {
  const feeds = [];
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    if (/rel\s*=\s*["']?alternate/i.test(m[0]) && /(rss|atom)\+xml/i.test(attr(m[0], 'type') || '')) {
      const a = abs(attr(m[0], 'href'), base);
      if (a && !/comments/i.test(a)) feeds.push(a);
    }
  }
  return [...new Set(feeds)].slice(0, 2);
}
function extractFromFeed(xml, base) {
  const out = [];
  for (const it of xml.split(/<item[\s>]|<entry[\s>]/i).slice(1, 51)) {
    const title = textOf(((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, ''));
    let link = (it.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || attr((it.match(/<link[^>]*rel=["']alternate["'][^>]*>/i) || it.match(/<link[^>]*href=[^>]*>/i) || [''])[0], 'href');
    link = abs(link, base);
    const dateStr = (it.match(/<(pubDate|published|updated|dc:date)[^>]*>([^<]+)</i) || [])[2];
    const date = dateStr ? Date.parse(dateStr) || null : null;
    const raw = [];
    for (const m of it.matchAll(/<(media:content|media:thumbnail|enclosure)\b[^>]*>/gi)) {
      const type = attr(m[0], 'type') || '';
      if (!type || type.startsWith('image')) raw.push(attr(m[0], 'url'));
    }
    const body = decode(it.replace(/<!\[CDATA\[|\]\]>/g, ''));
    const imgs = extractImages(body, base, { og: false });
    for (const u of raw) { const a = abs(u, base); if (a && keepImage(a)) { const s = sizes(a); imgs.unshift({ src: s.display, full: s.full }); } }
    for (const im of imgs.slice(0, 12)) out.push({ ...im, title: title || null, page: link, date });
  }
  return out;
}

// ---------- links ----------
// every same-site link with its visible text and whether it wraps an image (a project "card")
function linksOf(html, base, host) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,3000}?)<\/a>/gi)) {
    const tag = '<a ' + m[1] + '>';
    const href = attr(tag, 'href');
    const u = abs(href, base);
    if (!u) continue;
    let x; try { x = new URL(u); } catch { continue; }
    if (!/^https?:$/.test(x.protocol) || x.host.replace(/^www\./, '') !== host) continue;
    if (NOT_PAGE.test(x.pathname)) continue;
    const inner = m[2];
    const text = (textOf(inner) || attr(tag, 'aria-label') || attr(tag, 'title') || '').slice(0, 80);
    const card = /<img\b|<picture\b|background(-image)?\s*:|data-(bg|src|image)/i.test(inner);
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    out.push({ url: u.split('#')[0], text, card, next: rel.includes('next') });
  }
  // <link rel="next"> for paginated archives
  for (const m of html.matchAll(/<link[^>]+rel=["']next["'][^>]*>/gi)) { const u = abs(attr(m[0], 'href'), base); if (u) out.push({ url: u, text: 'next', card: false, next: true }); }
  return out;
}
const isSectionLink = l => {
  const segs = segsOf(l.url);
  if (segs.length > 2) return false;
  if (l.text && l.text.length <= 40 && SECTION_TEXT.test(l.text.replace(/[→›»>]+$/, '').trim())) return true;
  return segs.length >= 1 && segs.every(s => SECTION_PATH.test(s));
};
const isNextLink = (l, from) => l.next || NEXT_TEXT.test(l.text || '') && PAGINATION_HREF.test(l.url) || (PAGINATION_HREF.test(l.url) && clean(l.url.replace(PAGINATION_HREF, '')).startsWith(clean(from).replace(PAGINATION_HREF, '')));

// ---------- robots.txt & sitemaps ----------
async function readRobots(origin) {
  const rules = { disallow: [], allow: [], sitemaps: [] };
  try {
    const r = await get(origin + '/robots.txt', 'text/plain');
    if (/<html/i.test(r.text)) return rules;
    let applies = false;
    for (const raw of r.text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      const i = line.indexOf(':'); if (i < 0) continue;
      const key = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
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
// project pages listed in the sitemap. Files named like project/portfolio/work/case-study
// sitemaps (WordPress post types) are trusted completely; other URLs must look like project pages.
async function sitemapProjects(origin, robots, host) {
  const found = [];
  const queue = [...new Set([...(robots.sitemaps || []), origin + '/sitemap.xml', origin + '/sitemap_index.xml', origin + '/wp-sitemap.xml'])].map(u => ({ u, trusted: false }));
  const done = new Set();
  let fetched = 0;
  const projecty = u => /(project|portfolio|work|case|stud|realis|projet|proyect|progett|referenz|gallery|interiors?|hospitality|retail|residential|commercial)/i.test(u.split('/').pop() || u);
  while (queue.length && fetched < 8) {
    const { u: sm, trusted } = queue.shift();
    if (done.has(sm)) continue; done.add(sm);
    let r; try { r = await get(sm, 'application/xml,text/xml'); fetched++; } catch { continue; }
    if (!/<(urlset|sitemapindex)/i.test(r.text)) continue;
    if (/<sitemapindex/i.test(r.text)) {
      const kids = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/gi)].map(m => decode(m[1]));
      const good = kids.filter(k => !/(tag|categor|author|image|video|product|attachment|post_tag|format|elementor|wpforms|testimonial|team|people|job|career)/i.test(k));
      good.sort((a, b) => projecty(b) - projecty(a));
      for (const k of good.slice(0, 6)) queue.push({ u: k, trusted: projecty(k) });
      continue;
    }
    const smTrusted = trusted || projecty(sm);
    for (const m of r.text.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
      const loc = decode((m[1].match(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/i) || [])[1] || '');
      const lm = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1];
      if (!loc || hostOf(loc) !== host || NOT_PAGE.test(new URL(loc).pathname)) continue;
      const segs = segsOf(loc);
      const looksProject = segs.length >= 2 && segs.slice(0, -1).some(s => SECTION_PATH.test(s));
      if ((smTrusted && segs.length >= 1 && !SECTION_PATH.test(segs[segs.length - 1])) || looksProject) found.push({ url: loc, lm: lm ? Date.parse(lm) || 0 : 0 });
    }
  }
  return found;
}

// ---------- per-site history ----------
const fileFor = domain => path.join(SITES_DIR, domain.replace(/[^a-z0-9.-]/gi, '_') + '.json');
function loadSite(domain) { try { return JSON.parse(fs.readFileSync(fileFor(domain), 'utf8')); } catch { return null; } }
// one image / one queued page per line keeps git history small
function saveSite(domain, rec) {
  fs.mkdirSync(SITES_DIR, { recursive: true });
  const { images = [], pending = [], visited = {}, ...meta } = rec;
  const lines = [
    '{',
    ` "meta": ${JSON.stringify(meta)},`,
    ` "visited": ${JSON.stringify(visited)},`,
    ' "pending": [', pending.map(p => '  ' + JSON.stringify(p)).join(',\n'), ' ],',
    ' "images": [', images.map(i => '  ' + JSON.stringify(i)).join(',\n'), ' ]',
    '}',
  ];
  const tmp = fileFor(domain) + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, fileFor(domain));
}
function readSite(domain) {
  const raw = loadSite(domain);
  if (!raw) return null;
  return { ...(raw.meta || {}), visited: raw.visited || {}, pending: raw.pending || [], images: raw.images || [] };
}
// one-time move from the old single images.json to one file per site
function migrateLegacy() {
  if (!fs.existsSync(LEGACY_FILE)) return;
  try {
    const db = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    for (const [d, s] of Object.entries(db.sites || {})) {
      if (fs.existsSync(fileFor(d))) continue;
      const imgs = (s.images || []).map(i => { const z = sizes(i.src); return { src: z.display, full: z.full, page: i.page || '', title: i.title || null, firstSeen: i.firstSeen || 0 }; });
      saveSite(d, { ...s, domain: d, images: imgs, pending: [], visited: s.visited || {} });
    }
    // the old file is left in place: if this run's new files don't get saved, the next run migrates again
  } catch (e) { console.warn('Could not migrate images.json:', e.message); }
}
function loadImages() {
  migrateLegacy();
  const db = { sites: {} };
  if (!fs.existsSync(SITES_DIR)) return db;
  for (const f of fs.readdirSync(SITES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const raw = JSON.parse(fs.readFileSync(path.join(SITES_DIR, f), 'utf8')); const d = raw.meta && raw.meta.domain; if (d) db.sites[d] = { ...raw.meta, visited: raw.visited || {}, pending: raw.pending || [], images: raw.images || [] }; } catch {}
  }
  return db;
}
function removeSite(domain) { try { fs.unlinkSync(fileFor(domain)); } catch {} }

// ---------- crawl one site ----------
async function crawlSite(site, prev = {}) {
  const now = Date.now();
  const visited = { ...(prev.visited || {}) };
  const images = [];
  const seen = new Set();
  const push = (arr, page, title, date, isProject) => {
    for (const im of arr) {
      const k = imgKey(im.full || im.src);
      if (seen.has(k)) continue;
      seen.add(k);
      images.push({ src: im.src, full: im.full || im.src, page: im.page || page, title: im.title && !isProject ? im.title : (title || im.title || null), date: im.date || date || null, project: !!isProject });
    }
  };

  // ---- 1. homepage (with address fallbacks; feed when blocked)
  let home, via, movedTo = null;
  try {
    const got = await fetchHome(site.url);
    home = got.r; via = got.via;
    const was = hostOf(site.url), is = hostOf(home.finalUrl);
    if (got.firstError || (was && is && was !== is)) movedTo = home.finalUrl;
  } catch (e) {
    if (classify(e) === 'blocked') {
      const origin = new URL(site.url).origin;
      for (const p of FEED_PATHS) {
        try {
          const r = await get(origin + p, 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8');
          if (!/<(rss|feed|channel)\b/i.test(r.text.slice(0, 2000))) continue;
          push(extractFromFeed(r.text, r.finalUrl), origin + '/');
          if (images.length) return { images, visited, pending: prev.pending || [], projects: prev.projects || {}, furniture: new Set(), via: 'feed', movedTo: null, discoveredAt: prev.discoveredAt || 0 };
        } catch {}
      }
    }
    throw e;
  }
  const base = home.finalUrl;
  const origin = new URL(base).origin;
  const host = hostOf(base);
  const robots = await readRobots(origin);
  const later = [];   // homepage / index images, credited after project pages
  for (const f of findFeeds(home.text, base)) {
    try { const r = await get(f, 'application/rss+xml,application/atom+xml,application/xml,text/xml'); later.push([extractFromFeed(r.text, r.finalUrl), base]); } catch {}
  }
  later.push([extractImages(home.text, base), base]);

  // ---- 2. discover project pages (once a day; otherwise keep working through the saved queue)
  const pending = new Map((prev.pending || []).map(p => [clean(p.url), p]));
  const addCand = (u, lm = 0, why = '') => {
    const k = clean(u);
    if (visited[k] || k === clean(base) || pending.size >= MAX_CANDIDATES) return;
    const had = pending.get(k);
    if (!had) pending.set(k, { url: u, lm, why }); else if (lm && !had.lm) had.lm = lm;
  };
  const rediscover = !prev.discoveredAt || now - prev.discoveredAt > REDISCOVER_HOURS * 3600e3;
  let discoveredAt = prev.discoveredAt || 0;
  const sections = new Set();
  if (rediscover) {
    discoveredAt = now;
    const indexQueue = [];
    const queued = new Set([clean(origin)]);
    const pageKey = u => { try { const x = new URL(u); const m = x.search.match(/[?&](page|paged|pg|p)=\d+/i); return clean(u) + (m ? m[0] : ''); } catch { return u; } };
    const enqueueIndex = (u, depth) => { const k = pageKey(u); if (queued.has(k) || !allowed(u, robots)) return; queued.add(k); indexQueue.push({ u, depth }); };
    // entry points: section links on the homepage (by text or address), and the saved link itself
    const homeLinks = linksOf(home.text, base, host);
    if (clean(site.url) !== clean(origin) && hostOf(site.url) === host) enqueueIndex(site.url, 0);
    for (const l of homeLinks) if (isSectionLink(l)) enqueueIndex(l.url, 0);
    // cards on the homepage are often projects
    for (const l of homeLinks) if ((l.card || VIEW_TEXT.test(l.text)) && segsOf(l.url).length >= 1 && !isSectionLink(l)) addCand(l.url, 0, 'home-card');
    let pagesRead = 0;
    while (indexQueue.length && pagesRead < MAX_DISCOVERY_PAGES) {
      const { u, depth } = indexQueue.shift();
      await sleep(PAUSE_MS);
      let r; try { r = await get(u); pagesRead++; } catch { continue; }
      const here = r.finalUrl;
      sections.add(clean(here));
      later.push([extractImages(r.text, here, { og: false }), here]);
      const prefix = clean(here).replace(PAGINATION_HREF, '');
      for (const l of linksOf(r.text, here, host)) {
        const k = clean(l.url);
        if (isNextLink(l, here)) { enqueueIndex(l.url, depth); continue; }               // page 2, 3…
        if (k === clean(here) || k === clean(origin)) continue;
        if (isSectionLink(l) && depth < 2) { enqueueIndex(l.url, depth + 1); continue; } // Hospitality, Retail…
        const underSection = k.startsWith(prefix + '/') && segsOf(l.url).length > segsOf(here).length;
        if (l.card || underSection || VIEW_TEXT.test(l.text)) addCand(l.url, 0, 'index');
      }
    }
    try { for (const p of await sitemapProjects(origin, robots, host)) addCand(p.url, p.lm, 'sitemap'); } catch {}
  }

  // ---- 3. visit project pages: newest first (sitemap dates), then in the order found
  const queue = [...pending.entries()]
    .filter(([k, p]) => !visited[k] && !sections.has(k) && allowed(p.url, robots))
    .sort((a, b) => (b[1].lm || 0) - (a[1].lm || 0));
  const projectPages = [];
  let budget = NEW_PROJECTS_PER_RUN;
  while (queue.length && budget-- > 0) {
    const [k, p] = queue.shift();
    pending.delete(k);
    visited[k] = now;
    await sleep(PAUSE_MS);
    let r; try { r = await get(p.url); } catch { continue; }
    const here = r.finalUrl;
    let imgs = extractImages(r.text, here, { og: true });
    if (imgs.length < 3) imgs = extractImages(r.text, here, { og: true, scripts: true });   // script-built galleries
    // a "project" that is really a listing (category page, sub-portfolio): mine its cards too
    const ls = linksOf(r.text, here, host);
    const cards = ls.filter(l => l.card && clean(l.url) !== clean(here) && segsOf(l.url).length >= 1);
    if (cards.length >= 4) for (const l of cards) addCand(l.url, 0, 'nested');
    for (const l of ls) if (isNextLink(l, here) && clean(l.url) !== clean(here)) addCand(l.url, 0, 'next');
    projectPages.push({ page: here, title: pageTitle(r.text), date: p.lm || null, imgs: imgs.slice(0, IMAGES_PER_PROJECT * 2), listing: cards.length >= 8 && imgs.length <= cards.length + 2 });
  }

  // pictures repeated across many pages are site furniture (footer art, banners) — drop them
  const freq = new Map();
  for (const p of projectPages) for (const k of new Set(p.imgs.map(i => imgKey(i.full)))) freq.set(k, (freq.get(k) || 0) + 1);
  // (remembered between runs, so a banner spotted once stays filtered out)
  const furniture = new Set([...(prev.furniture || []), ...[...freq].filter(([, n]) => n >= 3 && n >= projectPages.length * 0.4).map(([k]) => k)]);
  for (const p of projectPages) {
    if (p.listing) { later.push([p.imgs.filter(i => !furniture.has(imgKey(i.full))), p.page]); continue; }
    push(p.imgs.filter(i => !furniture.has(imgKey(i.full))).slice(0, IMAGES_PER_PROJECT).map(i => ({ ...i, page: p.page })), p.page, p.title, p.date, true);
  }
  for (const [arr, page] of later) push(arr.filter(i => !furniture.has(imgKey(i.full))), page);

  const pend = [...pending.values()].filter(p => !visited[clean(p.url)] && allowed(p.url, robots));
  return {
    images, visited, pending: pend, furniture, discoveredAt,
    projects: { found: Object.keys(visited).length + pend.length, visited: Object.keys(visited).length, remaining: pend.length },
    via: via === site.url ? 'home' : 'fallback',
    movedTo,
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
    // sites due a fresh look, plus any with project pages still waiting to be visited
    list = list.filter(s => { const r = db.sites[s.domain]; return !r || (r.fetchedAt || 0) < cutoff || (r.ok && (r.pending || []).length); });
  }
  // never checked first, then least recently checked
  list.sort((a, b) => ((db.sites[a.domain] || {}).fetchedAt || 0) - ((db.sites[b.domain] || {}).fetchedAt || 0));
  const started = Date.now();
  Object.assign(progress, { running: true, done: 0, total: list.length, startedAt: started, finishedAt: null, current: [], skipped: 0 });

  running = (async () => {
    const queue = [...list];
    async function worker() {
      while (queue.length) {
        if (TIME_BUDGET_MS && Date.now() - started > TIME_BUDGET_MS) { progress.skipped = queue.length; queue.length = 0; break; }
        const site = queue.shift();
        progress.current.push(site.domain);
        const prev = db.sites[site.domain] || { images: [] };
        const prevByKey = new Map((prev.images || []).map(i => [imgKey(i.full || i.src), i]));
        let rec;
        try {
          const r = await crawlSite(site, prev);
          const now = Date.now();
          const fresh = r.images.filter(i => !r.furniture.has(imgKey(i.full))).map(i => {
            const old = prevByKey.get(imgKey(i.full));
            const keepOld = old && !i.project && old.page && old.page !== i.page && old.title;   // keep an earlier project credit
            return { src: i.src, full: i.full, page: keepOld ? old.page : i.page, title: keepOld ? old.title : i.title, firstSeen: (old && old.firstSeen) || i.date || now };
          });
          const have = new Set(fresh.map(i => imgKey(i.full)));
          for (const old of prev.images || []) {
            const k = imgKey(old.full || old.src);
            if (!have.has(k) && !r.furniture.has(k)) { fresh.push(old); have.add(k); }
          }
          fresh.sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
          rec = { domain: site.domain, fetchedAt: now, discoveredAt: r.discoveredAt, furniture: [...r.furniture].slice(-200), ok: true, error: null, issue: r.via === 'feed' ? 'feed-only' : null, movedTo: r.movedTo, projects: r.projects, visited: r.visited, pending: r.pending, images: fresh.slice(0, MAX_IMAGES_PER_SITE) };
        } catch (e) {
          rec = { ...prev, domain: site.domain, fetchedAt: Date.now(), ok: false, error: errText(e).slice(0, 120), issue: classify(e), movedTo: null };
        }
        db.sites[site.domain] = rec;
        saveSite(site.domain, rec);
        progress.current = progress.current.filter(d => d !== site.domain);
        progress.done++;
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    Object.assign(progress, { running: false, finishedAt: Date.now() });
    running = null;
  })();
  return running;
}

module.exports = { crawl, crawlSite, progress, loadImages, removeSite, extractImages, extractFromFeed, sizes, imgKey, linksOf, isSectionLink, variants, classify };

if (require.main === module) {
  const sources = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf8'));
  const tick = setInterval(() => process.stdout.write(`\r${progress.done}/${progress.total} sites`), 1000);
  crawl(sources).then(() => { clearInterval(tick); const db = loadImages(); const n = Object.values(db.sites).reduce((a, s) => a + s.images.length, 0); console.log(`\nDone. ${n} images from ${Object.keys(db.sites).length} sites.`); });
}
