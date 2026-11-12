// Visual Streams — daily build (runs on GitHub Actions, or locally with `node build.js`)
// 1. Visits sites that haven't been checked in the last STALE_HOURS (all of them on the daily run)
// 2. Writes the website into ./site: the pages plus one data.json the pages read.
const fs = require('fs');
const path = require('path');
const { crawl, loadImages } = require('./crawler');

const ROOT = __dirname;
const SITE = path.join(ROOT, 'site');
const STALE_HOURS = +(process.env.STALE_HOURS || 20);
const PER_SITE = 40;

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

  const images = {}, status = {};
  for (const [d, s] of Object.entries(db.sites)) {
    images[d] = [...s.images]
      .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0))
      .slice(0, PER_SITE)
      .map(i => [i.src, i.page || '', i.title || '', i.firstSeen || 0]);
    status[d] = [s.images.length, s.ok ? 1 : 0, s.error || '', s.fetchedAt || 0];
  }
  const out = {
    updated: Date.now(),
    repo: process.env.GITHUB_REPOSITORY || '',
    branch: process.env.GITHUB_REF_NAME || 'main',
    tabs: sources.tabs,
    images, status,
  };

  fs.rmSync(SITE, { recursive: true, force: true });
  fs.mkdirSync(SITE, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(SITE, f));
  fs.writeFileSync(path.join(SITE, 'data.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(SITE, '.nojekyll'), '');

  const n = Object.values(images).reduce((a, l) => a + l.length, 0);
  const withImages = Object.values(images).filter(l => l.length).length;
  console.log(`Built site: ${n} images from ${withImages} of ${domains.size} sites in ${Math.round((Date.now() - t0) / 1000)}s`);
})();
