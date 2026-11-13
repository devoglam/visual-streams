// Visual Streams — build (runs on GitHub Actions every few hours, or locally with `node build.js`)
// 1. Visits sites due a check, plus sites with project pages still waiting, within a time budget
// 2. Writes the website into ./site:
//    data.json            tabs, sources and each site's status
//    images-<tab>.json    a selection per site for the streams (newest work + one picture per project)
//    s/<site>.json        every image found for one site — used by "More from this studio" and projects
const fs = require('fs');
const path = require('path');
// Stop starting new sites after this many minutes so the run fits GitHub's time limit;
// whatever is left over is picked up first on the next run.
process.env.TIME_BUDGET_MIN = process.env.TIME_BUDGET_MIN || '40';
const { crawl, loadImages, removeSite, progress } = require('./crawler');

const ROOT = __dirname;
const SITE = path.join(ROOT, 'site');
const STALE_HOURS = +(process.env.STALE_HOURS || 20);
const STREAM_PER_SITE = 48;

const siteFile = d => d.replace(/[^a-z0-9.-]/gi, '_') + '.json';

(async () => {
  const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sources.json'), 'utf8'));
  const t0 = Date.now();
  const tick = setInterval(() => console.log(`  ${progress.done}/${progress.total} sites checked`), 30000);
  await crawl(sources, { staleHours: STALE_HOURS });
  clearInterval(tick);

  const db = loadImages();
  const domains = new Set(sources.tabs.flatMap(t => t.sites.map(s => s.domain)));
  for (const d of Object.keys(db.sites)) if (!domains.has(d)) { removeSite(d); delete db.sites[d]; }   // removed from the list

  // pages listed once per file; images point at them: [display, pageIndex, firstSeen(sec), full or '']
  const pack = imgs => {
    const pages = [], pidx = new Map();
    const i = imgs.map(im => {
      const key = im.page || '';
      if (!pidx.has(key)) { pidx.set(key, pages.length); pages.push([key, im.title || '']); }
      return [im.src, pidx.get(key), Math.round((im.firstSeen || 0) / 1000), im.full && im.full !== im.src ? im.full : ''];
    });
    return { p: pages, i };
  };
  // the stream gets a mix: the newest pictures, plus the lead picture of as many projects as fit
  const sample = imgs => {
    const sorted = [...imgs].sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
    const pick = new Set(sorted.slice(0, STREAM_PER_SITE / 2));
    const firstOfPage = new Map();
    for (const im of sorted) if (!firstOfPage.has(im.page)) firstOfPage.set(im.page, im);
    for (const im of firstOfPage.values()) { if (pick.size >= STREAM_PER_SITE) break; pick.add(im); }
    for (const im of sorted) { if (pick.size >= STREAM_PER_SITE) break; pick.add(im); }
    return sorted.filter(im => pick.has(im));
  };

  fs.rmSync(SITE, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE, 's'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(SITE, f));

  const status = {};
  let total = 0, projects = 0, pending = 0;
  for (const [d, s] of Object.entries(db.sites)) {
    const pr = s.projects || {};
    status[d] = [s.images.length, s.ok ? 1 : 0, s.error || '', s.fetchedAt || 0, pr.visited || 0, pr.remaining || 0, s.issue || '', s.movedTo || ''];
    total += s.images.length; projects += pr.visited || 0; pending += pr.remaining || 0;
    if (s.images.length) fs.writeFileSync(path.join(SITE, 's', siteFile(d)), JSON.stringify(pack([...s.images].sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0)))));
  }
  for (const t of sources.tabs) {
    const sites = {};
    for (const s of t.sites) { const rec = db.sites[s.domain]; if (rec && rec.images.length) sites[s.domain] = pack(sample(rec.images)); }
    fs.writeFileSync(path.join(SITE, `images-${t.id}.json`), JSON.stringify(sites));
  }
  fs.writeFileSync(path.join(SITE, 'data.json'), JSON.stringify({
    updated: Date.now(),
    repo: process.env.GITHUB_REPOSITORY || '',
    branch: process.env.GITHUB_REF_NAME || 'main',
    tabs: sources.tabs,
    status,
  }));
  fs.writeFileSync(path.join(SITE, '.nojekyll'), '');

  const withImages = Object.values(db.sites).filter(s => s.images.length).length;
  console.log(`Built site: ${total} images from ${withImages} of ${domains.size} sites in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`Project pages read so far: ${projects}; still queued: ${pending}${progress.skipped ? `; ${progress.skipped} sites left for the next run` : ''}`);
})();
