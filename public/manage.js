// Visual Streams — Manage Sources
const $ = s => document.querySelector(s);
let data = { tabs: [] }, stats = {}, progress = {};
let sel = new URLSearchParams(location.search).get('tab') || null;
let filter = '';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const domainOf = u => { try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).host.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const short = n => String(n).split(' | ')[0].trim();
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tab';

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400); }

// ---------- storage: edits are kept in this browser until published to GitHub ----------
let published = null, DATA = null;
const DRAFT_KEY = 'visual-streams-draft';
const canon = d => JSON.stringify({ tabs: d.tabs.map(t => ({ id: t.id, label: t.label, sites: t.sites.map(s => { const o = { name: s.name, url: s.url, domain: s.domain }; if (s.group) o.group = s.group; return o; }) })) }, null, 1);
function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } }
function writeDraft() { try { localStorage.setItem(DRAFT_KEY, canon(data)); } catch {} }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
const dirty = () => published && canon(data) !== published;

async function save(msg = 'Saved') {
  writeDraft(); toast(msg + ' · publish when you’re ready'); render(); renderCrawl();
}

function repoInfo() {
  if (DATA.repo) return { repo: DATA.repo, branch: DATA.branch || 'main' };
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return null;
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { repo: `${m[1]}/${seg && !seg.endsWith('.html') ? seg : m[1] + '.github.io'}`, branch: 'main' };
}

async function load() {
  DATA = await fetch('data.json', { cache: 'no-cache' }).then(r => r.json());
  published = canon({ tabs: DATA.tabs });
  const draft = readDraft();
  if (draft && canon(draft) === published) clearDraft();
  data = draft && canon(draft) !== published ? draft : JSON.parse(published);
  stats = {};
  for (const [d, [n, ok, error, at]] of Object.entries(DATA.status || {})) stats[d] = { n, ok: !!ok, error, at };
  if (!sel || !data.tabs.find(t => t.id === sel)) sel = data.tabs[0]?.id;
  render(); renderCrawl();
}

function renderCrawl() {
  const el = $('#crawl');
  const info = repoInfo();
  const last = DATA.updated ? new Date(DATA.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not yet';
  const actions = info ? `https://github.com/${info.repo}/actions` : null;
  if (dirty()) {
    el.innerHTML = `<span style="color:var(--ink)">Unpublished changes</span> <button class="btn ghost" id="discard">Discard</button> <button class="btn" id="publish">Publish changes</button>`;
    $('#discard').onclick = () => { if (confirm('Discard the changes you haven’t published?')) { clearDraft(); data = JSON.parse(published); render(); renderCrawl(); } };
    $('#publish').onclick = publish;
  } else {
    el.innerHTML = `Updated ${last}${actions ? ` <a class="btn ghost" href="${actions}" target="_blank" rel="noopener" style="text-decoration:none">Update now ↗</a>` : ''}`;
  }
}

async function publish() {
  const info = repoInfo();
  const text = canon(data) + '\n';
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch {}
  const editUrl = info ? `https://github.com/${info.repo}/edit/${info.branch}/data/sources.json` : null;
  const box = document.createElement('div');
  box.id = 'publishBox';
  box.style.cssText = 'position:fixed;inset:0;z-index:70;display:grid;place-items:center;background:rgba(0,0,0,.5)';
  box.innerHTML = `<div class="panel" style="max-width:520px;margin:16px;padding:22px;display:grid;gap:12px;font-size:14px;line-height:1.5">
    <b style="font-size:18px">Publish your changes</b>
    <ol style="margin:0;padding-left:20px;display:grid;gap:6px">
      <li>${copied ? 'Your updated list is <b>copied</b>.' : 'Click <b>Copy list</b> below.'}</li>
      <li>On the GitHub page that opens, click into the text, select all (⌘A) and paste (⌘V).</li>
      <li>Click <b>Commit changes…</b>, then <b>Commit changes</b> again.</li>
    </ol>
    <div class="muted">The site rebuilds itself within a few minutes, and new sites get their images on that run.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
      <button class="btn ghost" id="pClose">Close</button>
      <button class="btn ghost" id="pCopy">Copy list</button>
      <button class="btn ghost" id="pDl">Download file</button>
      ${editUrl ? `<a class="btn" href="${editUrl}" target="_blank" rel="noopener" style="text-decoration:none">Open GitHub ↗</a>` : ''}
    </div></div>`;
  document.body.append(box);
  box.onclick = e => { if (e.target === box) box.remove(); };
  box.querySelector('#pClose').onclick = () => box.remove();
  box.querySelector('#pCopy').onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Couldn’t copy. Use Download file instead.'); } };
  box.querySelector('#pDl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = 'sources.json'; a.click(); };
}

function render() { renderTabs(); renderMain(); }

function renderTabs() {
  const ul = $('#tlist'); ul.innerHTML = '';
  data.tabs.forEach((t, i) => {
    const li = document.createElement('li');
    if (t.id === sel) li.className = 'sel';
    li.innerHTML = `<button class="name">${esc(t.label)} <span>${t.sites.length}</span></button>
      <button class="mv" title="Move up" aria-label="Move ${esc(t.label)} up">↑</button>
      <button class="mv" title="Move down" aria-label="Move ${esc(t.label)} down">↓</button>`;
    const [name, up, down] = li.querySelectorAll('button');
    name.onclick = () => { sel = t.id; filter = ''; history.replaceState(null, '', '?tab=' + t.id); render(); };
    up.onclick = () => { if (i > 0) { [data.tabs[i - 1], data.tabs[i]] = [data.tabs[i], data.tabs[i - 1]]; save('Tab order saved'); } };
    down.onclick = () => { if (i < data.tabs.length - 1) { [data.tabs[i + 1], data.tabs[i]] = [data.tabs[i], data.tabs[i + 1]]; save('Tab order saved'); } };
    ul.append(li);
  });
}

$('#addTab').onsubmit = e => {
  e.preventDefault();
  const label = $('#newTab').value.trim(); if (!label) return;
  let id = slug(label); while (data.tabs.some(t => t.id === id)) id += '-2';
  data.tabs.push({ id, label, sites: [] }); sel = id; $('#newTab').value = '';
  save(`Added “${label}”`);
};

function where(domain) {
  for (const t of data.tabs) { const s = t.sites.find(s => s.domain === domain); if (s) return { t, s }; }
  return null;
}

// Accepts markdown links [Name](url), HTML <a href>, or plain URLs — one or many per line
function parseLinks(text) {
  const out = []; const used = [];
  for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) { out.push({ name: m[1].trim(), url: m[2] }); used.push([m.index, m.index + m[0].length]); }
  for (const m of text.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) { out.push({ name: m[2].replace(/<[^>]+>/g, '').trim(), url: m[1] }); used.push([m.index, m.index + m[0].length]); }
  for (const m of text.matchAll(/(https?:\/\/[^\s<>"')\]]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\.?[a-z]{2,}(?:\/[^\s<>"')\]]*)?)/gi)) {
    if (used.some(([a, b]) => m.index >= a && m.index < b)) continue;
    if (/^\d+(\.\d+)+$/.test(m[0])) continue;
    out.push({ name: '', url: m[0] });
  }
  return out.map(x => {
    let url = x.url.replace(/[.,;]+$/, ''); if (!/^https?:/i.test(url)) url = 'https://' + url;
    const domain = domainOf(url);
    return domain ? { name: x.name || domain.split('.')[0].replace(/^./, c => c.toUpperCase()), url: url.split('#')[0], domain } : null;
  }).filter(Boolean);
}

function renderMain() {
  const t = data.tabs.find(t => t.id === sel);
  const main = $('#main');
  if (!t) { main.innerHTML = '<p class="muted">Add a tab to get started.</p>'; return; }
  const groups = [...new Set(data.tabs.flatMap(t => t.sites.map(s => s.group)).filter(Boolean))].sort();
  $('#groups').innerHTML = groups.map(g => `<option value="${esc(g)}">`).join('');
  const imgs = t.sites.reduce((a, s) => a + (stats[s.domain]?.n || 0), 0);

  main.innerHTML = `
    <div class="head">
      <div class="title">
        <input class="tname" id="tname" value="${esc(t.label)}" aria-label="Tab name">
        <div class="muted">${t.sites.length} sites · ${imgs.toLocaleString()} images found · <a href="./?tab=${t.id}">View stream →</a></div>
      </div>
      <button class="btn danger" id="delTab">Delete tab</button>
    </div>
    <div class="panel add">
      <b style="font-size:14px">Add sites to ${esc(t.label)}</b>
      <textarea id="paste" placeholder="Paste links — one or many. Works with copied link lists like [Studio Name](https://studio.com), or plain web addresses."></textarea>
      <div class="row">
        <input id="addGroup" list="groups" placeholder="Filter group (optional)" style="width:220px">
        <button class="btn" id="addBtn">Add sites</button>
        <span class="note" id="addNote"></span>
      </div>
    </div>
    <div class="panel">
      <div class="toolbar">
        <input id="search" placeholder="Search ${t.sites.length} sites" value="${esc(filter)}">
        <span class="muted"><span class="dot g"></span>images found <span class="dot y" style="margin-left:8px"></span>none found <span class="dot r" style="margin-left:8px"></span>unreachable</span>
      </div>
      <table><thead><tr><th>Site</th><th>Images</th><th>Group</th><th>Move to</th><th></th></tr></thead><tbody id="rows"></tbody></table>
    </div>`;

  $('#tname').onchange = e => { const v = e.target.value.trim(); if (v) { t.label = v; save('Tab renamed'); } };
  $('#delTab').onclick = () => {
    if (!confirm(`Delete the “${t.label}” tab and its ${t.sites.length} sites?`)) return;
    data.tabs = data.tabs.filter(x => x !== t); sel = data.tabs[0]?.id; save('Tab deleted');
  };
  $('#search').oninput = e => { filter = e.target.value; renderRows(t); };
  $('#addBtn').onclick = () => {
    const found = parseLinks($('#paste').value);
    const group = $('#addGroup').value.trim();
    let added = 0; const dupes = []; const batch = new Set();
    for (const s of found) {
      if (batch.has(s.domain)) continue; batch.add(s.domain);
      const w = where(s.domain);
      if (w) { dupes.push(`${short(w.s.name)} (${w.t.label})`); continue; }
      if (group) s.group = group;
      t.sites.push(s); added++;
    }
    const note = $('#addNote');
    if (!found.length) { note.className = 'note warn'; note.textContent = 'No links found in what you pasted.'; return; }
    note.className = 'note ' + (added ? 'ok' : 'warn');
    note.textContent = `Added ${added}.` + (dupes.length ? ` Skipped ${dupes.length} already in your sources: ${dupes.slice(0, 6).join(', ')}${dupes.length > 6 ? '…' : ''}` : '');
    if (added) { $('#paste').value = ''; save(`Added ${added} site${added > 1 ? 's' : ''}`).then(() => { const n = $('#addNote'); if (n) { n.className = note.className; n.textContent = note.textContent; } }); }
  };
  renderRows(t);
}

function renderRows(t) {
  const tb = $('#rows'); tb.innerHTML = '';
  const f = filter.toLowerCase();
  const list = t.sites.filter(s => !f || s.name.toLowerCase().includes(f) || s.domain.includes(f) || (s.group || '').toLowerCase().includes(f));
  for (const s of list) {
    const st = stats[s.domain];
    const dot = !st ? 'n' : !st.ok ? 'r' : st.n ? 'g' : 'y';
    const label = !st ? 'checked on the next update' : !st.ok ? st.error : st.n ? st.n : 'none';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="site"><b>${esc(short(s.name))}</b><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.domain)}</a></td>
      <td title="${esc(label)}"><span class="dot ${dot}"></span>${st && st.ok ? st.n : st ? '—' : ''}</td>
      <td><input class="grp" list="groups" value="${esc(s.group || '')}" placeholder="—" aria-label="Group"></td>
      <td><select aria-label="Move to tab"><option value="">—</option>${data.tabs.filter(x => x !== t).map(x => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select></td>
      <td style="text-align:right;white-space:nowrap">
        <button class="rowbtn" data-a="view">View</button>
        <button class="rowbtn" data-a="remove">Remove</button>
      </td>`;
    tr.querySelector('.grp').onchange = e => { const v = e.target.value.trim(); if (v) s.group = v; else delete s.group; save('Group updated'); };
    tr.querySelector('select').onchange = e => {
      const dest = data.tabs.find(x => x.id === e.target.value); if (!dest) return;
      t.sites = t.sites.filter(x => x !== s); delete s.group; dest.sites.push(s);
      save(`Moved ${short(s.name)} to ${dest.label}`);
    };
    tr.querySelector('[data-a=view]').onclick = () => location.href = `./?site=${encodeURIComponent(s.domain)}&name=${encodeURIComponent(short(s.name))}`;
    tr.querySelector('[data-a=remove]').onclick = () => { t.sites = t.sites.filter(x => x !== s); save(`Removed ${short(s.name)}`); };
    tb.append(tr);
  }
  if (!list.length) tb.innerHTML = `<tr><td colspan="5" class="muted" style="padding:20px">${t.sites.length ? 'No matches.' : 'No sites yet — paste some links above.'}</td></tr>`;
}

load();
