// Visual Streams — daily build (runs on GitHub Actions, or locally with `node build.js`)
// 1. Visits sites that haven't been checked in the last STALE_HOURS (all of them on the daily run)
// 2. Writes the website into ./site: the pages plus one data.json the pages read.
const fs = require('fs');
const path = require('path');
// Stop starting new sites after this many minutes so the run fits GitHub's time limit;
// whatever is left over is picked up first on the next run.
process.env.TIME_BUDGET_MIN = process.env.TIME_BUDGET_MIN || '40';
const { crawl, loadImages } = require('./crawler');

const ROOT = __dirname;
const SITE = path.join(ROOT, 'site');
const STALE_HOURS = +(process.env.STALE_HOURS || 20);
const PER_SITE = 120;   // images per site published to the website

(async () => {
  const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sources.json'), 'utf8'));
  const t0 = Date.now();
  const tick = setInterval(() => {
    const { progress } = require('./crawler');
    console.log(`  ${progress.done}/${progress.total} sites checked`);
  }, 30000);
  await crawl(sources, { staleHours: STALE_HOURS });
  clearInterval(tick);

  const db = loadImages();
  const domains = new Set(sources.tabs.flatMap(t => t.sites.map(s => s.domain)));
  // forget sites that were removed from the list
  for (const d of Object.keys(db.sites)) if (!domains.has(d)) delete db.sites[d];
  // one value per line keeps the daily history small in git
  fs.writeFileSync(path.join(ROOT, 'data/images.json'), JSON.stringify(db, null, 1));

  // compact per-site record: pages listed once, images point at them
  const pack = rec => {
    const pages = [], pidx = new Map();
    const imgs = [...rec.images].sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0)).slice(0, PER_SITE).map(i => {
      const key = i.page || '';
      if (!pidx.has(key)) { pidx.set(key, pages.length); pages.push([key, i.title || '']); }
      return [i.src, pidx.get(key), Math.round((i.firstSeen || 0) / 1000)];
    });
    return { p: pages, i: imgs };
  };
  const status = {};
  for (const [d, s] of Object.entries(db.sites)) {
    const pr = s.projects || {};
    status[d] = [s.images.length, s.ok ? 1 : 0, s.error || '', s.fetchedAt || 0, pr.visited || 0, pr.remaining || 0];
  }
  const tabFiles = {};
  for (const t of sources.tabs) {
    const sites = {};
    for (const s of t.sites) { const rec = db.sites[s.domain]; if (rec && rec.images.length) sites[s.domain] = pack(rec); }
    tabFiles[t.id] = sites;
  }
  const out = {
    updated: Date.now(),
    repo: process.env.GITHUB_REPOSITORY || '',
    branch: process.env.GITHUB_REF_NAME || 'main',
    tabs: sources.tabs,
    status,
  };

  fs.rmSync(SITE, { recursive: true, force: true });
  fs.mkdirSync(SITE, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(SITE, f));
  fs.writeFileSync(path.join(SITE, 'data.json'), JSON.stringify(out));
  for (const [id, sites] of Object.entries(tabFiles)) fs.writeFileSync(path.join(SITE, `images-${id}.json`), JSON.stringify(sites));
  fs.writeFileSync(path.join(SITE, '.nojekyll'), '');

  const n = Object.values(db.sites).reduce((a, s) => a + Math.min(s.images.length, PER_SITE), 0);
  const withImages = Object.values(db.sites).filter(s => s.images.length).length;
  const projects = Object.values(db.sites).reduce((a, s) => a + ((s.projects || {}).visited || 0), 0);
  console.log(`Project pages visited so far: ${projects}`);
  console.log(`Built site: ${n} images from ${withImages} of ${domains.size} sites in ${Math.round((Date.now() - t0) / 1000)}s`);
})();
