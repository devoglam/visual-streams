// Visual Streams — feed
const $ = s => document.querySelector(s);
const grid = $('#grid'), statusEl = $('#status'), sub = $('#sub');

const params = new URLSearchParams(location.search);
const state = {
  tab: params.get('tab') || 'all',
  group: params.get('group') || '',
  site: params.get('site') || '',
  siteName: params.get('name') || '',
  project: params.get('project') || '',
  projectName: params.get('pname') || '',
  mode: params.get('mode') || 'mix',
  seed: +params.get('seed') || dailySeed(),
  next: 0, loading: false, gen: 0, total: 0,
};
let tabs = [];
let cards = [];       // placed cards in visual order of placement
let cols = [];
let seen = new Set();
let pending = 0;

function dailySeed() { const d = new Date(); return d.getFullYear() * 1000 + d.getMonth() * 40 + d.getDate(); }

// ---------- tabs & filters ----------
let DATA = null;
async function loadTabs() {
  DATA = await fetch('data.json', { cache: 'no-cache' }).then(r => r.json());
  tabs = DATA.tabs.map(t => ({
    id: t.id, label: t.label, sites: t.sites.length,
    groups: [...new Set(t.sites.map(s => s.group).filter(Boolean))],
  }));
  renderTabs();
}

// image files are split by tab and loaded only when needed
const tabImages = {};
function ensureImages(ids) {
  return Promise.all(ids.map(id => tabImages[id] || (tabImages[id] = fetch(`images-${id}.json`, { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})))))
    .then(list => { ids.forEach((id, k) => { tabImages[id] = list[k]; }); });
}
// a studio's complete bank lives in its own file
const siteBanks = {};
const siteFile = d => 's/' + d.replace(/[^a-z0-9.-]/gi, '_') + '.json';
function ensureSite(d) {
  if (!d || siteBanks[d]) return Promise.resolve();
  return fetch(siteFile(d), { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null).then(j => { siteBanks[d] = j || false; });
}
function neededTabs() {
  if (state.site) { const t = DATA.tabs.find(t => t.sites.some(s => s.domain === state.site)); return t ? [t.id] : []; }
  return state.tab === 'all' ? DATA.tabs.map(t => t.id) : [state.tab];
}

// ---------- feed (built in the browser from data.json) ----------
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function shuffleArr(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function roundRobin(lists, r) {
  lists = shuffleArr(lists.map(l => [...l]), r);
  const out = [];
  while (lists.length) {
    lists = lists.filter(l => { out.push(...l.splice(0, r() < 0.35 ? 2 : 1)); return l.length; });
    shuffleArr(lists, r);
  }
  return out;
}
let feedKey = '', feedList = [];
function getFeed() {
  const key = [state.tab, state.group, state.site, state.project, state.mode, state.seed].join('|');
  if (key === feedKey) return feedList;
  const ids = neededTabs();
  const pick = DATA.tabs.filter(t => ids.includes(t.id));
  const seenD = new Set(), perSite = [];
  for (const t of pick) for (const s of t.sites) {
    if (state.group && !state.site && s.group !== state.group) continue;
    if (state.site && s.domain !== state.site) continue;
    if (seenD.has(s.domain)) continue; seenD.add(s.domain);
    const rec = (state.site && siteBanks[s.domain]) || (tabImages[t.id] || {})[s.domain]; if (!rec || !rec.i.length) continue;
    const site = { name: s.name.split(' | ')[0].trim(), url: s.url, domain: s.domain, tab: t.label };
    let imgs = rec.i.map(([src, pi, ts, full]) => ({ src, full: full || src, page: rec.p[pi][0], title: rec.p[pi][1], firstSeen: ts * 1000, site }));
    if (state.project) imgs = imgs.filter(i => i.page === state.project);
    if (imgs.length) perSite.push(imgs);
  }
  const r = rng(state.seed);
  let list;
  if (state.project) list = perSite.flat();   // in the order the studio shows them
  else if (state.mode === 'newest') {
    const days = new Map();
    for (const i of perSite.flat()) { const d = Math.floor((i.firstSeen || 0) / 864e5); if (!days.has(d)) days.set(d, new Map()); const m = days.get(d); if (!m.has(i.site.domain)) m.set(i.site.domain, []); m.get(i.site.domain).push(i); }
    list = [...days.keys()].sort((a, b) => b - a).flatMap(d => roundRobin([...days.get(d).values()], r));
  } else list = roundRobin(perSite, r);
  feedKey = key; feedList = list;
  return list;
}
function renderTabs() {
  const all = { id: 'all', label: 'All' };
  $('#tabs').innerHTML = '';
  for (const t of [all, ...tabs]) {
    const b = document.createElement('button');
    b.className = 'tab'; b.role = 'tab'; b.textContent = t.label;
    b.setAttribute('aria-selected', t.id === state.tab && !state.site);
    b.onclick = () => go({ tab: t.id, group: '', site: '', siteName: '', project: '', projectName: '' });
    $('#tabs').append(b);
  }
  const sel = $('#tabs [aria-selected="true"]');
  if (sel) sel.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  renderSub();
}
function renderSub() {
  sub.innerHTML = '';
  if (state.site) {
    const c = document.createElement('button');
    c.className = 'chip studio'; c.innerHTML = `${esc(state.siteName || state.site)} <span aria-hidden="true">✕</span>`;
    c.title = 'Back to the stream'; c.onclick = () => go({ site: '', siteName: '', project: '', projectName: '' });
    sub.append(c);
    if (state.project) {
      const pc = document.createElement('button');
      pc.className = 'chip studio'; pc.innerHTML = `${esc(state.projectName || 'This project')} <span aria-hidden="true">✕</span>`;
      pc.title = 'All of this studio’s work'; pc.onclick = () => go({ project: '', projectName: '' });
      sub.append(pc);
    }
  } else {
    const t = tabs.find(t => t.id === state.tab);
    if (t && t.groups.length) {
      for (const g of ['', ...t.groups]) {
        const c = document.createElement('button');
        c.className = 'chip'; c.textContent = g || 'Everything';
        c.setAttribute('aria-pressed', state.group === g);
        c.onclick = () => go({ group: g });
        sub.append(c);
      }
    }
  }
  const meta = document.createElement('span');
  meta.className = 'meta-line'; meta.id = 'metaLine';
  sub.append(meta);
  updateMeta();
}
function updateMeta() {
  const m = $('#metaLine'); if (!m) return;
  const t = tabs.find(t => t.id === state.tab);
  const sites = state.site ? 1 : t ? t.sites : tabs.reduce((a, t) => a + t.sites, 0);
  const upd = DATA && DATA.updated ? ' · updated ' + new Date(DATA.updated).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
  m.textContent = state.total ? `${state.total.toLocaleString()} images${state.project ? '' : ` · ${sites} ${sites === 1 ? 'studio' : 'sources'}`}${upd}` : '';
}

function go(patch) {
  Object.assign(state, patch);
  const q = new URLSearchParams();
  if (state.tab !== 'all') q.set('tab', state.tab);
  if (state.group) q.set('group', state.group);
  if (state.site) { q.set('site', state.site); q.set('name', state.siteName); }
  if (state.project) { q.set('project', state.project); q.set('pname', state.projectName); }
  if (state.mode !== 'mix') q.set('mode', state.mode);
  history.replaceState(null, '', q.toString() ? '?' + q : location.pathname);
  renderTabs(); reset(); window.scrollTo({ top: 0 });
}

document.querySelectorAll('.seg button').forEach(b => {
  b.setAttribute('aria-pressed', b.dataset.mode === state.mode);
  b.onclick = () => { document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', x === b)); go({ mode: b.dataset.mode }); };
});
$('#shuffle').onclick = () => go({ seed: Math.floor(Math.random() * 1e9), mode: 'mix' });

// ---------- masonry ----------
function colCount() {
  const w = grid.clientWidth;
  return w < 520 ? 2 : w < 860 ? 3 : w < 1250 ? 4 : w < 1700 ? 5 : 6;
}
function buildCols() {
  const n = colCount();
  if (cols.length === n) return false;
  grid.innerHTML = ''; cols = [];
  for (let i = 0; i < n; i++) { const c = document.createElement('div'); c.className = 'col'; c._h = 0; grid.append(c); cols.push(c); }
  return true;
}
function place(card) {
  let best = cols[0];
  for (const c of cols) if (c._h < best._h) best = c;
  best.append(card);
  best._h += card._ratio + 0.06;   // ratio = height / width (column width is shared)
}
let resizeT;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (buildCols()) cards.forEach(c => { c.style.animation = 'none'; place(c); }); }, 150);
});

// ---------- loading ----------
function reset() {
  state.gen++; state.next = 0; state.total = 0; state.loading = false;
  cards = []; seen = new Set(); cols = []; pending = 0;
  buildCols(); statusEl.textContent = '';
  more();
}

async function more() {
  if (state.loading || state.next === null) return;
  state.loading = true;
  const gen = state.gen;
  try {
    if (!state.next) await Promise.all([ensureImages(neededTabs()), ensureSite(state.site)]);
    if (gen !== state.gen) return;
    const list = getFeed(), offset = state.next;
    const items = list.slice(offset, offset + 40);
    state.total = list.length; state.next = offset + 40 < list.length ? offset + 40 : null; updateMeta();
    if (!list.length) return showEmpty();
    for (const item of items) addItem(item, gen);
    statusEl.textContent = state.next === null ? 'You’ve reached the end of this stream.' : '';
  } catch (e) { console.error(e); statusEl.textContent = 'Something went wrong loading this stream.'; }
  finally { if (gen === state.gen) state.loading = false; }
}

function addItem(item, gen) {
  const key = item.src.split('?')[0];
  if (seen.has(key)) return; seen.add(key);
  pending++;
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.alt = item.title || item.site.name;
  img.onload = () => {
    pending--;
    if (gen !== state.gen) return;
    if (img.naturalWidth < 240 || img.naturalHeight < 160) return check();
    const card = document.createElement('a');
    card.className = 'card'; card.href = item.page || item.site.url; card.tabIndex = 0;
    card._ratio = img.naturalHeight / img.naturalWidth; card._item = item;
    card.append(img);
    const cap = document.createElement('div'); cap.className = 'cap';
    cap.innerHTML = `<b>${esc(item.site.name)}</b>${item.title && item.title !== item.site.name ? `<small>${esc(item.title)}</small>` : ''}`;
    card.append(cap);
    card.onclick = e => { e.preventDefault(); openLb(cards.indexOf(card)); };
    cards.push(card); place(card); check();
  };
  img.onerror = () => { pending--; check(); };
  img.src = item.src;
}

// keep loading while the sentinel is near the viewport
const io = new IntersectionObserver(es => { if (es[0].isIntersecting) more(); }, { rootMargin: '1600px 0px' });
io.observe($('#sentinel'));
function check() {
  if (pending < 8 && !state.loading && state.next !== null) {
    const r = $('#sentinel').getBoundingClientRect();
    if (r.top < innerHeight + 1600) more();
  }
}

function showEmpty() {
  grid.innerHTML = DATA && Object.keys(DATA.images).length
    ? `<div class="empty"><h2>Nothing here yet</h2>No images have been found for this stream so far. Check which sites are working on the <a href="manage.html">Sources</a> page.</div>`
    : `<div class="empty"><h2>Gathering images…</h2>The first daily update hasn’t finished yet. Check back in about 20 minutes.</div>`;
}

// ---------- lightbox ----------
const lb = $('#lb'); let lbIndex = -1;
function openLb(i) {
  if (i < 0 || i >= cards.length) return;
  lbIndex = i;
  const it = cards[i]._item;
  const lbImg = $('#lbImg');
  lbImg.src = cards[i].querySelector('img').src;
  $('#lbFull').href = it.full || it.src;
  if (it.full && it.full !== it.src) {
    const hi = new Image(); hi.referrerPolicy = 'no-referrer';
    hi.onload = () => { if (lbIndex === i && hi.naturalWidth >= lbImg.naturalWidth) lbImg.src = hi.src; };
    hi.src = it.full;
  }
  $('#lbImg').alt = it.title || it.site.name;
  $('#lbName').textContent = it.site.name;
  $('#lbMeta').textContent = [it.title && it.title !== it.site.name ? it.title : '', it.site.tab, it.site.domain].filter(Boolean).join(' · ');
  const page = $('#lbPage');
  page.href = it.page || it.site.url;
  page.style.display = it.page && it.page.replace(/\/$/, '') !== it.site.url.replace(/\/$/, '') ? '' : 'none';
  $('#lbSite').href = it.site.url;
  const isProject = it.page && it.page.replace(/\/$/, '') !== it.site.url.replace(/\/$/, '');
  $('#lbProject').style.display = isProject && !state.project ? '' : 'none';
  $('#lbProject').onclick = () => { closeLb(); go({ site: it.site.domain, siteName: it.site.name, project: it.page, projectName: it.title || 'Project' }); };
  $('#lbMore').style.display = state.site && !state.project ? 'none' : '';
  $('#lbMore').onclick = () => { closeLb(); go({ site: it.site.domain, siteName: it.site.name, project: '', projectName: '' }); };
  lb.classList.add('open'); document.body.style.overflow = 'hidden';
  if (i > cards.length - 6) more();
}
function closeLb() { lb.classList.remove('open'); document.body.style.overflow = ''; if (cards[lbIndex]) cards[lbIndex].focus({ preventScroll: true }); }
$('#lbClose').onclick = closeLb;
$('#lbPrev').onclick = () => openLb(lbIndex - 1);
$('#lbNext').onclick = () => openLb(lbIndex + 1);
lb.addEventListener('click', e => { if (e.target === lb || e.target.classList.contains('lb-stage')) closeLb(); });
addEventListener('keydown', e => {
  if (!lb.classList.contains('open')) return;
  if (e.key === 'Escape') closeLb();
  if (e.key === 'ArrowRight') openLb(lbIndex + 1);
  if (e.key === 'ArrowLeft') openLb(lbIndex - 1);
});
let tx = null;
lb.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
lb.addEventListener('touchend', e => { if (tx === null) return; const dx = e.changedTouches[0].clientX - tx; if (Math.abs(dx) > 50) openLb(lbIndex + (dx < 0 ? 1 : -1)); tx = null; });

addEventListener('scroll', () => $('#top').classList.toggle('scrolled', scrollY > 4), { passive: true });

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

loadTabs().then(reset);
