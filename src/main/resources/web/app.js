'use strict';
// (Unofficial) Decent Holograms Portal: web editor for DecentHolograms holograms and displays.
// Plain JS, no build step. Served by the HoloPortal plugin.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ API

async function api(method, path, body) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-HoloPortal': '1' } : { 'X-HoloPortal': '1' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('Log in first.'); }
  if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

// ------------------------------------------------------------------ state

const S = {
  meta: null,
  kind: 'hologram',                 // which list the sidebar shows
  lists: { hologram: [], display: [] },
  edit: null,                       // { kind, current, saved, original, fingerprint }
  page: 0,                          // hologram page being edited
  openMore: new Set(),              // "page:line" keys with the details row open
  lastText: null,                   // { input, set } last text input used, for the format toolbar
  hist: [], hi: 0, lastPush: 0,     // undo history (JSON snapshots)
  tabs: { hologram: 'content', display: 'dcontent' },
};
const C = () => S.edit.current;
const isHolo = () => S.edit && S.edit.kind === 'hologram';

const TYPES = [['TEXT', 'Text'], ['ICON', 'Item'], ['HEAD', 'Head'], ['SMALLHEAD', 'Small head'], ['ENTITY', 'Entity']];
const PREFIX = { ICON: '#ICON:', HEAD: '#HEAD:', SMALLHEAD: '#SMALLHEAD:', ENTITY: '#ENTITY:' };
const CLICK_LABELS = { LEFT: 'Left click', RIGHT: 'Right click', SHIFT_LEFT: 'Shift + left click', SHIFT_RIGHT: 'Shift + right click' };
const ACTION_HELP = {
  MESSAGE: ['Hi {player}, welcome!', 'Sends the player a chat message. Color codes and {player} work.'],
  COMMAND: ['/spawn', 'Runs a command as the player, with their permissions. Start it with /.'],
  CONSOLE: ['give {player} diamond 1', 'Runs a command from the console with full permissions. No / needed.'],
  CONNECT: ['lobby', 'Sends the player to another server on a BungeeCord/Velocity network.'],
  TELEPORT: ['world:0.5:64:0.5', 'world:x:y:z, or world:x:y:z:yaw:pitch. Leave out the world to stay in theirs.'],
  SOUND: ['ENTITY_EXPERIENCE_ORB_PICKUP:1:1', 'SOUND_NAME:volume:pitch.'],
  PERMISSION: ['smp.vip', 'Stops here unless the player has this permission. Put it before the actions it guards.'],
  NEXT_PAGE: ['', 'Shows the next page of a hologram. Defaults to this one.'],
  PREV_PAGE: ['', 'Shows the previous page of a hologram. Defaults to this one.'],
  PAGE: ['', 'hologram:page number, e.g. this_hologram:2.'],
  NONE: ['', 'Does nothing.'],
};
const MC_COLORS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const isDirty = () => !!S.edit && (S.edit.original === null || JSON.stringify(C()) !== S.edit.saved);
const page = () => C().pages[S.page];
const apiBase = (kind) => (kind === 'display' ? 'displays' : 'holograms');

// ------------------------------------------------------------------ boot / login

async function boot() {
  try {
    const s = await api('GET', 'session');
    if (s.loggedIn) await showApp(); else showLogin();
  } catch { showLogin(); }
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-password').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').hidden = true;
  try {
    await api('POST', 'login', { password: $('#login-password').value });
    $('#login-password').value = '';
    await showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  if (isDirty() && !confirm('You have unsaved changes. Log out anyway?')) return;
  await api('POST', 'logout', {}).catch(() => {});
  S.edit = null;
  showLogin();
});

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  S.meta = await api('GET', 'meta');
  buildStatic();
  await refreshLists();
  const [kind, name] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (name && (kind === 'hologram' || kind === 'display')) {
    setKind(kind);
    openItem(kind, name);
  }
}

async function refreshMeta() {
  try {
    S.meta = await api('GET', 'meta');
    fillPlayerSelects();
    fillSidebarFilters();
  } catch { /* keep old */ }
}

// ------------------------------------------------------------------ sidebar

async function refreshLists() {
  const [h, d] = await Promise.all([api('GET', 'holograms'), api('GET', 'displays').catch(() => [])]);
  S.lists.hologram = h;
  S.lists.display = d;
  fillSidebarFilters();
  renderList();
}

function setKind(kind) {
  S.kind = kind;
  $$('.sidebar .seg').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  renderList();
}
$$('.sidebar .seg').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));

function fillSidebarFilters() {
  const wf = $('#world-filter'), prevW = wf.value;
  const worlds = new Set([...S.meta.worlds, ...S.lists.hologram.map((h) => h.world), ...S.lists.display.map((h) => h.world)]);
  wf.length = 1;
  for (const w of [...worlds].filter(Boolean).sort()) wf.append(new Option(w, w));
  wf.value = [...wf.options].some((o) => o.value === prevW) ? prevW : '';
  const so = $('#sort'), prevS = so.value;
  so.length = 1;
  for (const p of S.meta.players) so.append(new Option(`Nearest to ${p.name}`, 'near:' + p.name));
  so.value = [...so.options].some((o) => o.value === prevS) ? prevS : 'name';
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const world = $('#world-filter').value;
  const sort = $('#sort').value;
  const ul = $('#holo-list');
  ul.innerHTML = '';
  $('#count-hologram').textContent = S.lists.hologram.length || '';
  $('#count-display').textContent = S.lists.display.length || '';

  let items = S.lists[S.kind].filter((h) =>
    (!q || h.name.toLowerCase().includes(q) || (h.preview || '').toLowerCase().includes(q)) && (!world || h.world === world));
  if (sort.startsWith('near:')) {
    const p = S.meta.players.find((x) => x.name === sort.slice(5));
    if (p) {
      const dist = (h) => (h.world === p.world ? Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z) : Infinity);
      items = items.map((h) => ({ h, d: dist(h) })).sort((a, b) => a.d - b.d).map(({ h, d }) => ({ ...h, _dist: d }));
    }
  }

  for (const h of items) {
    const li = document.createElement('li');
    const active = S.edit && S.edit.kind === S.kind && S.edit.original === h.name;
    li.className = 'holo-item' + (h.unloaded ? ' unloaded' : '') + (active ? ' active' : '');
    const name = el('div', 'holo-name', h.name);
    if (S.kind === 'display') name.prepend(el('span', 'type-pill t-' + (h.type || '').toLowerCase(), h.type || '?'));
    if (!h.unloaded && h.enabled === false) name.append(el('span', 'pill', 'disabled'));
    if (S.kind === 'display' && h.loaded === false) name.append(el('span', 'pill warn', 'not loaded'));
    li.append(name);
    const dist = h._dist !== undefined ? (h._dist === Infinity ? ' · other world' : ` · ${Math.round(h._dist)} m away`) : '';
    li.append(el('div', 'holo-meta', h.unloaded
      ? `${h.world} isn't loaded`
      : `${h.world} · ${fmt(h.x)}, ${fmt(h.y)}, ${fmt(h.z)}` + (S.kind === 'hologram' ? ` · ${h.lines} line${h.lines === 1 ? '' : 's'}${h.pages > 1 ? ` · ${h.pages} pages` : ''}` : '') + dist));
    if (h.preview) {
      const p = el('div', 'holo-preview');
      p.append(h.preview.startsWith('Item: ') || h.preview.startsWith('Block: ') ? document.createTextNode(h.preview) : renderMc(h.preview));
      li.append(p);
    }
    if (!h.unloaded) li.addEventListener('click', () => openItem(S.kind, h.name));
    ul.append(li);
  }
  if (!items.length) {
    const none = S.lists[S.kind].length ? 'No matches.' : (S.kind === 'display'
      ? (S.meta.display && S.meta.display.available ? 'No displays yet. Click + New and pick a display type.' : 'This DecentHolograms build has no displays.')
      : 'No holograms yet.');
    ul.append(el('li', 'muted small list-empty', none));
  }
  const players = S.meta.players.length;
  $('#sidebar-foot').textContent = `${players} player${players === 1 ? '' : 's'} online`;
}

$('#search').addEventListener('input', renderList);
$('#world-filter').addEventListener('change', renderList);
$('#sort').addEventListener('change', renderList);

// ------------------------------------------------------------------ open / load / save

async function openItem(kind, name) {
  if (isDirty() && !confirm('You have unsaved changes. Discard them?')) return;
  try {
    const data = await api('GET', `${apiBase(kind)}/${encodeURIComponent(name)}`);
    load(kind, data, name);
  } catch (e) { toast(e.message, true); }
}

function load(kind, data, original, { keepTab = false } = {}) {
  const fingerprint = data.fingerprint || null;
  const prevKind = S.edit && S.edit.kind;
  const current = kind === 'hologram' ? normalizeHologram(data) : normalizeDisplay(data);
  S.edit = { kind, current, saved: JSON.stringify(current), original, fingerprint };
  if (kind === 'hologram') S.page = original === null || prevKind !== 'hologram' ? 0 : Math.min(S.page, current.pages.length - 1);
  S.openMore.clear();
  S.hist = [S.edit.saved]; S.hi = 0;
  history.replaceState(null, '', original ? `#${kind}/${encodeURIComponent(original)}` : location.pathname);
  $('#empty').hidden = true;
  $('#editor').hidden = false;
  $('#conflict').hidden = true;
  $('#conflict-load').hidden = false;
  $('#conflict-text').textContent = 'This was changed in game since you opened it.';
  if (!keepTab) $('#warnings').hidden = true;
  if (S.kind !== kind) setKind(kind);
  showTab(S.tabs[kind]);
  renderEditor();
  renderList();
}

function normalizeHologram(h) {
  h = clone(h);
  delete h.fingerprint; delete h.file;
  h.flags = h.flags || [];
  h.pages = (h.pages && h.pages.length) ? h.pages : [{ lines: [], actions: {} }];
  for (const p of h.pages) {
    p.lines = p.lines || [];
    p.actions = p.actions || {};
    for (const l of p.lines) {
      l.flags = l.flags || [];
      l.permission = l.permission || '';
      l.offsetX = l.offsetX || 0;
      l.offsetZ = l.offsetZ || 0;
      l.type = typeOf(l.content);
    }
  }
  return h;
}

function normalizeDisplay(d) {
  const loc = d.location || {};
  const st = d.settings || {};
  return {
    name: d.name,
    type: d.type || 'TEXT',
    location: { world: loc.world || S.meta.worlds[0], x: num(loc.x), y: num(loc.y), z: num(loc.z), yaw: num(loc.yaw), pitch: num(loc.pitch) },
    settings: { enabled: st.enabled !== false, 'display-range': st['display-range'] ?? 256, 'update-interval': st['update-interval'] ?? 20 },
    attributes: clone(d.attributes || {}),
    lines: d.lines ? [...d.lines] : (d.pages && d.pages[0] && d.pages[0].lines ? [...d.pages[0].lines] : []),
    item: d.item || '',
    block: d.block || '',
  };
}

function forSave() {
  const out = clone(C());
  if (isHolo()) for (const p of out.pages) for (const l of p.lines) delete l.type;
  return out;
}

async function save() {
  if (!S.edit || !isDirty()) return;
  const btn = $('#save-btn');
  btn.disabled = true;
  const { kind, original, fingerprint } = S.edit;
  try {
    const body = kind === 'hologram'
      ? { original, fingerprint, hologram: forSave() }
      : { original, fingerprint, display: forSave() };
    const res = await api('POST', apiBase(kind), body);
    load(kind, res, res.name, { keepTab: true });
    showWarnings(res.warnings);
    toast('Saved. It\'s live in game.');
    refreshLists();
  } catch (e) {
    toast(e.message, true);
  } finally {
    updateDirty();
  }
}

function showWarnings(list) {
  const w = $('#warnings');
  if (!list || !list.length) { w.hidden = true; return; }
  w.textContent = 'DecentHolograms warned: ' + list.join(' · ');
  w.hidden = false;
}

$('#save-btn').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || $('#app').hidden || !S.edit) return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    if ($('[data-body="yaml"]').hidden) save(); else saveYaml();
  } else if ((k === 'z' || k === 'y') && document.activeElement !== $('#yaml')) {
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo(); else undo();
  }
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

$('#revert-btn').addEventListener('click', () => {
  if (!S.edit || S.edit.original === null) return;
  S.edit.current = JSON.parse(S.edit.saved);
  if (isHolo()) S.page = Math.min(S.page, C().pages.length - 1);
  pushHistory();
  renderEditor();
});

$('#del-btn').addEventListener('click', async () => {
  const { kind, original } = S.edit;
  if (original === null) { closeEditor(); return; }
  if (!confirm(`Delete "${original}"? This removes it from the world and deletes its file.`)) return;
  try {
    await api('DELETE', `${apiBase(kind)}/${encodeURIComponent(original)}`);
    toast(`Deleted ${original}.`);
    closeEditor();
    refreshLists();
  } catch (e) { toast(e.message, true); }
});

function closeEditor() {
  S.edit = null;
  $('#editor').hidden = true;
  $('#empty').hidden = false;
  history.replaceState(null, '', location.pathname);
  renderList();
}

$('#dup-btn').addEventListener('click', () => {
  if (isDirty() && !confirm('Duplicate with your unsaved changes included?')) return;
  const kind = S.edit.kind;
  const copy = clone(C());
  const names = S.lists[kind].map((h) => h.name);
  let name = copy.name + '_copy', n = 2;
  while (names.includes(name)) name = `${copy.name}_copy${n++}`;
  copy.name = name;
  if (kind === 'hologram') copy.z = round(copy.z + 2); else copy.location.z = round(copy.location.z + 2);
  S.edit.saved = null;
  load(kind, copy, null);
  toast('Copy made 2 blocks south. Save to create it.');
});

$('#tp-btn').addEventListener('click', async () => {
  const player = $('#tp-player').value;
  if (!player) { toast('No players online.', true); return; }
  if (S.edit.original === null) { toast('Save it first.', true); return; }
  try {
    await api('POST', 'teleport', { player, hologram: S.edit.original, kind: S.edit.kind });
    toast(`Teleported ${player}.`);
  } catch (e) { toast(e.message, true); }
});

// ---- undo / redo

function pushHistory(coalesce) {
  if (!S.edit) return;
  const snap = JSON.stringify(C());
  if (snap === S.hist[S.hi]) return;
  const now = Date.now();
  if (coalesce && S.hi > 0 && now - S.lastPush < 900) {
    S.hist[S.hi] = snap;
  } else {
    S.hist = S.hist.slice(0, S.hi + 1);
    S.hist.push(snap);
    if (S.hist.length > 200) S.hist.shift();
    S.hi = S.hist.length - 1;
  }
  S.lastPush = coalesce ? now : 0;
  updateUndo();
}
function undo() {
  if (S.hi === 0) return;
  S.hi--;
  restoreHistory();
}
function redo() {
  if (S.hi >= S.hist.length - 1) return;
  S.hi++;
  restoreHistory();
}
function restoreHistory() {
  S.edit.current = JSON.parse(S.hist[S.hi]);
  S.lastPush = 0;
  if (isHolo()) S.page = Math.min(S.page, C().pages.length - 1);
  renderEditor();
}
function updateUndo() {
  $('#undo-btn').disabled = S.hi === 0;
  $('#redo-btn').disabled = S.hi >= S.hist.length - 1;
}
$('#undo-btn').addEventListener('click', undo);
$('#redo-btn').addEventListener('click', redo);

// ---- in-game change detection

async function checkRemote() {
  if (!S.edit || S.edit.original === null || document.hidden || $('#app').hidden) return;
  const { kind, original, fingerprint } = S.edit;
  try {
    const data = await api('GET', `${apiBase(kind)}/${encodeURIComponent(original)}`);
    if (!S.edit || S.edit.kind !== kind || S.edit.original !== original) return;
    if (data.fingerprint === fingerprint) return;
    if (!isDirty()) {
      load(kind, data, original, { keepTab: true });
      toast('Updated: it was changed in game.');
    } else {
      S.remote = data;
      $('#conflict').hidden = false;
    }
  } catch (e) {
    if (e.status === 404 && S.edit && S.edit.original === original) {
      $('#conflict-text').textContent = 'This was deleted in game. Saving will create it again.';
      $('#conflict-load').hidden = true;
      $('#conflict').hidden = false;
      S.edit.original = null;
      updateDirty();
    }
  }
}
$('#conflict-load').addEventListener('click', () => {
  if (S.remote) load(S.edit.kind, S.remote, S.edit.original, { keepTab: true });
  $('#conflict').hidden = true;
});
$('#conflict-dismiss').addEventListener('click', () => {
  // Keep my edits and let the next save overwrite theirs.
  if (S.remote) S.edit.fingerprint = S.remote.fingerprint;
  $('#conflict').hidden = true;
});

// ------------------------------------------------------------------ new

const HOLO_TEMPLATES = {
  blank: { label: 'Blank', pages: (n) => [{ lines: [tl(`&b&l${n.replace(/[_-]+/g, ' ')}`), tl('&7Edit me in the portal')], actions: {} }] },
  welcome: {
    label: 'Welcome sign',
    pages: () => [{ lines: [tl('&6&l✦ &e&lWelcome &6&l✦'), tl('&fHi &b{player}&f, glad you\'re here!'), tl(''), tl('&7Right-click for the rules')],
      actions: { RIGHT: ['MESSAGE:&e1. Be kind  &e2. No griefing  &e3. Have fun!', 'SOUND:ENTITY_EXPERIENCE_ORB_PICKUP:1:1'] } }],
  },
  warp: {
    label: 'Clickable warp',
    pages: () => [{ lines: [il('ENDER_PEARL'), tl('&d&lTeleport'), tl('&7Click to go to &fspawn')],
      actions: { RIGHT: ['COMMAND:/spawn', 'SOUND:ENTITY_ENDERMAN_TELEPORT:1:1'], LEFT: ['COMMAND:/spawn'] } }],
  },
  showcase: {
    label: 'Item showcase',
    pages: () => [{ lines: [tl('&b&lFeatured item'), il('DIAMOND_SWORD !ENCHANTED'), tl('&7Find it in the &fshop')], actions: {} }],
  },
  pages: {
    label: 'Info board (3 pages)',
    pages: (n) => [1, 2, 3].map((k) => ({
      lines: [tl(`&e&lInfo &7(${k}/3)`), tl(['&fWelcome to the server!', '&fType &b/help &fto get started', '&fJoin our Discord!'][k - 1]), tl('&8Click to turn the page')],
      actions: { RIGHT: [`NEXT_PAGE:${n}`], LEFT: [`PREV_PAGE:${n}`] },
    })),
  },
};
function tl(content) { return { content, height: S.meta.defaults.heights.TEXT, flags: [], permission: '', offsetX: 0, offsetZ: 0 }; }
function il(item) { return { content: '#ICON: ' + item, height: S.meta.defaults.heights.ICON, flags: [], permission: '', offsetX: 0, offsetZ: 0 }; }

function newKind() { return ($('#new-kind input:checked') || {}).value || 'hologram'; }
function updateNewDialog() {
  $('#template-field').hidden = newKind() !== 'hologram';
}
$('#new-kind').addEventListener('change', updateNewDialog);

$('#new-btn').addEventListener('click', async () => {
  await refreshMeta();
  const sel = $('#new-at');
  sel.innerHTML = '';
  for (const p of S.meta.players) sel.append(new Option(`${p.name}'s position (${p.world})`, 'player:' + p.name));
  for (const w of S.meta.worlds) sel.append(new Option(`${w}, near 0, 100, 0`, 'world:' + w));
  const tpl = $('#new-template');
  tpl.innerHTML = '';
  for (const [k, v] of Object.entries(HOLO_TEMPLATES)) tpl.append(new Option(v.label, k));
  const displays = S.meta.display && S.meta.display.available;
  $$('#new-kind input').forEach((r) => {
    r.disabled = r.value !== 'hologram' && !displays;
    r.checked = S.kind === 'display' && displays ? r.value === 'TEXT' : r.value === 'hologram';
  });
  updateNewDialog();
  $('#new-name').value = '';
  $('#new-dialog').showModal();
  $('#new-name').focus();
});

$('#new-form').addEventListener('submit', (e) => {
  // method="dialog" closes the dialog after this; Cancel uses formnovalidate and value="cancel".
  if (!e.submitter || e.submitter.value !== 'ok') return;
  if (isDirty() && !confirm('You have unsaved changes. Discard them?')) return;
  const name = $('#new-name').value.trim();
  const at = $('#new-at').value;
  const kind = newKind();
  const p = at.startsWith('player:') ? S.meta.players.find((x) => x.name === at.slice(7)) : null;
  const world = p ? p.world : (at.startsWith('world:') ? at.slice(6) : S.meta.worlds[0]);
  const facing = p ? facingFromYaw(p.yaw) : 0;
  if (kind === 'hologram') {
    const d = S.meta.defaults;
    load('hologram', {
      name, world, x: p ? p.x : 0.5, y: p ? round(p.y + 2.5) : 100, z: p ? p.z : 0.5,
      enabled: true, permission: '', flags: [],
      displayRange: d.displayRange, updateRange: d.updateRange, updateInterval: d.updateInterval,
      facing, downOrigin: false,
      pages: HOLO_TEMPLATES[$('#new-template').value].pages(name),
    }, null);
  } else {
    load('display', {
      name, type: kind,
      location: { world, x: p ? p.x : 0.5, y: p ? round(p.y + 1.5) : 100, z: p ? p.z : 0.5, yaw: facing, pitch: 0 },
      settings: { enabled: true, 'display-range': 64, 'update-interval': 20 },
      attributes: clone((S.meta.display.defaults || {})[kind] || {}),
      lines: kind === 'TEXT' ? ['&b&l' + name.replace(/[_-]+/g, ' '), '&7Edit me in the portal'] : [],
      item: kind === 'ITEM' ? 'minecraft:diamond' : '',
      block: kind === 'BLOCK' ? 'minecraft:amethyst_block' : '',
    }, null);
  }
});

// ------------------------------------------------------------------ static UI

function buildStatic() {
  const sw = $('#swatches');
  sw.innerHTML = '';
  for (const [code, hex] of Object.entries(MC_COLORS)) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = '&' + code;
    b.dataset.code = '&' + code;
    sw.append(b);
  }
  const anim = $('#anim-select');
  anim.length = 1;
  for (const a of S.meta.animations) anim.append(new Option(a, a));

  const hf = $('#holo-flags');
  hf.innerHTML = '';
  for (const f of S.meta.flags) {
    const lab = el('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.flag = f;
    cb.addEventListener('change', () => { toggle(C().flags, f, cb.checked); changed(); });
    lab.append(cb, flagLabel(f));
    hf.append(lab);
  }
  fillPlayerSelects();

  const lists = [['dl-materials', S.meta.materials], ['dl-entities', S.meta.entities],
    ['dl-items', S.meta.materials.map((m) => m.toLowerCase())], ['dl-blocks', (S.meta.display && S.meta.display.blocks) || []]];
  for (const [id, items] of lists) {
    let dl = document.getElementById(id);
    if (!dl) { dl = document.createElement('datalist'); dl.id = id; document.body.append(dl); }
    dl.innerHTML = '';
    for (const m of items) dl.append(new Option(m));
  }
}

function fillPlayerSelects() {
  for (const sel of [$('#tp-player'), ...$$('.loc-player')]) {
    const prev = sel.value;
    sel.innerHTML = '';
    if (!S.meta.players.length) sel.append(new Option('No players online', ''));
    for (const p of S.meta.players) sel.append(new Option(p.name, p.name));
    if (prev && S.meta.players.some((p) => p.name === prev)) sel.value = prev;
  }
}

// ------------------------------------------------------------------ editor shell

function showTab(name) {
  const kind = S.edit ? S.edit.kind : 'hologram';
  const tab = $(`.tab[data-tab="${name}"]`);
  if (!tab || (tab.dataset.for && tab.dataset.for !== kind)) name = kind === 'hologram' ? 'content' : 'dcontent';
  S.tabs[kind] = name;
  $$('.tab').forEach((x) => {
    x.hidden = !!x.dataset.for && x.dataset.for !== kind;
    x.classList.toggle('active', x.dataset.tab === name);
  });
  $$('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== name; });
  placeToolbar();
  if (name === 'yaml') loadYaml();
}
$$('.tab').forEach((tb) => tb.addEventListener('click', () => showTab(tb.dataset.tab)));

/** The format toolbar lives in whichever text editor is showing. */
function placeToolbar() {
  const tb = $('#toolbar');
  const slot = !S.edit ? null
    : isHolo() ? $('.toolbar-slot[data-slot="hologram"]')
      : (C().type === 'TEXT' ? $('#display-main .toolbar-slot') : null);
  if (slot) { slot.append(tb); tb.hidden = false; } else { tb.hidden = true; }
}

function renderEditor() {
  const kind = S.edit.kind;
  $('#f-name').value = C().name;
  $('#kind-badge').textContent = kind === 'hologram' ? 'Hologram' : `${cap(C().type)} display`;
  $('#draft').hidden = S.edit.original !== null;
  $('#dup-btn').disabled = S.edit.original === null;
  $('#del-btn').textContent = S.edit.original === null ? 'Discard' : 'Delete';
  if (kind === 'hologram') {
    renderPages();
    renderLines();
    renderActions();
    renderHoloSettings();
    renderPreview();
  } else {
    renderDisplay();
    renderDisplayPosition();
  }
  placeToolbar();
  updateDirty();
  updateUndo();
  if (!$('[data-body="yaml"]').hidden) loadYaml();
}

function updateDirty() {
  const dirty = isDirty();
  $('#dirty').hidden = !dirty || !S.edit || S.edit.original === null;
  $('#save-btn').disabled = !dirty;
  $('#revert-btn').disabled = !dirty || !S.edit || S.edit.original === null;
  $('#yaml-save').disabled = !S.edit || S.edit.original === null;
}

/** Call after any edit. Typing passes coalesce so one word isn't twenty undo steps. */
function changed({ preview = true, coalesce = false } = {}) {
  if (preview) { if (isHolo()) renderPreview(); else renderDisplayPreview(); }
  pushHistory(coalesce);
  updateDirty();
}

$('#f-name').addEventListener('input', (e) => { C().name = e.target.value.trim(); changed({ preview: false, coalesce: true }); });

// ------------------------------------------------------------------ shared: location & facing controls

function locationControls(slot, get, set, lift) {
  slot.innerHTML = '';
  const v = get();
  const worldSel = document.createElement('select');
  for (const w of S.meta.worlds) worldSel.append(new Option(w, w));
  if (!S.meta.worlds.includes(v.world)) worldSel.append(new Option(v.world + ' (not loaded)', v.world));
  worldSel.value = v.world;
  worldSel.addEventListener('change', () => { set({ world: worldSel.value }); changed({ preview: false }); });
  const wf = el('label', 'field');
  wf.append(el('span', null, 'World'), worldSel);

  const row = el('div', 'row three');
  const inputs = {};
  for (const k of ['x', 'y', 'z']) {
    const f = el('label', 'field');
    const i = document.createElement('input');
    i.type = 'number'; i.step = '0.1'; i.value = v[k];
    i.addEventListener('input', () => { const n = parseFloat(i.value); if (!isNaN(n)) { set({ [k]: n }); changed({ preview: false, coalesce: true }); } });
    inputs[k] = i;
    f.append(el('span', null, k.toUpperCase()), i);
    row.append(f);
  }

  const pr = el('div', 'row inline');
  const ps = document.createElement('select');
  ps.className = 'loc-player';
  ps.setAttribute('aria-label', 'Player');
  const use = el('button', 'btn small', 'Use their position');
  use.addEventListener('click', async () => {
    const p = await pickedPlayer(ps);
    if (!p) return;
    set({ world: p.world, x: p.x, y: round(p.y + lift), z: p.z });
    locationControls(slot, get, set, lift);
    changed({ preview: false });
    toast(`Moved to ${p.name}, ${lift} blocks above their feet. Save to apply.`);
  });
  const center = el('button', 'btn small', 'Center on block');
  center.title = 'Snap X and Z to the middle of the block';
  center.addEventListener('click', () => {
    const c = get();
    set({ x: Math.floor(c.x) + 0.5, z: Math.floor(c.z) + 0.5 });
    inputs.x.value = get().x; inputs.z.value = get().z;
    changed({ preview: false });
  });
  pr.append(ps, use, center);

  const nr = el('div', 'row inline');
  nr.append(el('span', 'muted small', 'Nudge'));
  for (const axis of ['x', 'y', 'z']) {
    for (const dd of [-0.1, 0.1]) {
      const b = el('button', 'btn small nudge', `${axis.toUpperCase()} ${dd > 0 ? '+' : '−'}0.1`);
      b.addEventListener('click', () => {
        set({ [axis]: round(get()[axis] + dd) });
        inputs[axis].value = get()[axis];
        changed({ preview: false, coalesce: true });
      });
      nr.append(b);
    }
  }
  slot.append(wf, row, pr, nr);
  fillPlayerSelects();
}

function facingControls(slot, get, set) {
  slot.innerHTML = '';
  const row = el('div', 'row inline');
  const range = document.createElement('input');
  range.type = 'range'; range.min = -180; range.max = 180; range.step = 1; range.value = get();
  const n = document.createElement('input');
  n.type = 'number'; n.min = -180; n.max = 180; n.className = 'narrow'; n.value = get();
  const apply = (v, coalesce = true) => {
    v = Math.max(-180, Math.min(180, Math.round(v)));
    set(v); range.value = v; n.value = v;
    changed({ coalesce });
  };
  range.addEventListener('input', () => apply(parseFloat(range.value)));
  n.addEventListener('input', () => { const v = parseFloat(n.value); if (!isNaN(v)) apply(v); });
  row.append(range, n);
  const dirs = el('div', 'row inline');
  for (const [label, v] of [['North', 180], ['East', -90], ['South', 0], ['West', 90]]) {
    const b = el('button', 'btn small', label);
    b.addEventListener('click', () => apply(v, false));
    dirs.append(b);
  }
  const ps = document.createElement('select');
  ps.className = 'loc-player';
  ps.setAttribute('aria-label', 'Player');
  const face = el('button', 'btn small', 'Face this player');
  face.title = 'Turn it to face where this player is looking from';
  face.addEventListener('click', async () => {
    const p = await pickedPlayer(ps);
    if (p) apply(facingFromYaw(p.yaw), false);
  });
  dirs.append(ps, face);
  slot.append(row, dirs);
  fillPlayerSelects();
}

async function pickedPlayer(sel) {
  const name = sel.value;
  await refreshMeta();
  const p = S.meta.players.find((x) => x.name === name);
  if (!p) toast('No players online.', true);
  return p;
}

// Something facing the player should face back toward where they're looking from.
const facingFromYaw = (yaw) => { let f = Math.round(yaw + 180); if (f > 180) f -= 360; return f; };

// ------------------------------------------------------------------ hologram: pages

function renderPages() {
  const wrap = $('#page-tabs');
  wrap.innerHTML = '';
  C().pages.forEach((p, i) => {
    const b = el('button', 'page-tab' + (i === S.page ? ' active' : ''), `Page ${i + 1}`);
    b.addEventListener('click', () => { S.page = i; renderPages(); renderLines(); renderActions(); renderPreview(); });
    wrap.append(b);
  });
  const add = el('button', 'page-tab', '+ Page');
  add.title = 'Add a page. Players switch pages with NEXT_PAGE / PREV_PAGE click actions.';
  add.addEventListener('click', () => {
    C().pages.push({ lines: [newLine('TEXT', '&fPage ' + (C().pages.length + 1))], actions: {} });
    S.page = C().pages.length - 1;
    renderPages(); renderLines(); renderActions(); changed();
    if (C().pages.length === 2) toast('Tip: add NEXT_PAGE click actions so players can flip pages.');
  });
  wrap.append(add);
  const n = C().pages.length;
  $('#page-left').disabled = S.page === 0;
  $('#page-right').disabled = S.page === n - 1;
  $('#page-del').disabled = n === 1;
}

$('#page-left').addEventListener('click', () => movePage(-1));
$('#page-right').addEventListener('click', () => movePage(1));
function movePage(d) {
  const pages = C().pages, j = S.page + d;
  if (j < 0 || j >= pages.length) return;
  [pages[S.page], pages[j]] = [pages[j], pages[S.page]];
  S.page = j;
  renderPages(); changed();
}
$('#page-dup').addEventListener('click', () => {
  C().pages.splice(S.page + 1, 0, clone(page()));
  S.page++;
  renderPages(); renderLines(); renderActions(); changed();
});
$('#page-del').addEventListener('click', () => {
  if (C().pages.length === 1) return;
  if (page().lines.length && !confirm(`Delete page ${S.page + 1}?`)) return;
  C().pages.splice(S.page, 1);
  S.page = Math.max(0, S.page - 1);
  renderPages(); renderLines(); renderActions(); changed();
});

// ------------------------------------------------------------------ hologram: lines

function typeOf(content) {
  const u = (content || '').toUpperCase();
  if (u.startsWith('#ICON:')) return 'ICON';
  if (u.startsWith('#SMALLHEAD:')) return 'SMALLHEAD';
  if (u.startsWith('#HEAD:')) return 'HEAD';
  if (u.startsWith('#ENTITY:')) return 'ENTITY';
  return 'TEXT';
}

/** The part of a line the user edits, without the #TYPE: prefix (and PLAYER_HEAD wrapper for heads). */
function valueOf(line) {
  if (line.type === 'TEXT') return line.content;
  let rest = line.content.slice(PREFIX[line.type].length).trim();
  if (line.type === 'HEAD' || line.type === 'SMALLHEAD') {
    const m = rest.match(/^PLAYER_HEAD\s*\((.*)\)\s*$/i);
    if (m) rest = m[1];
  }
  return rest;
}

function contentFor(type, value) {
  if (type === 'TEXT') return value;
  if (type === 'HEAD' || type === 'SMALLHEAD') {
    const v = value.trim();
    // Raw item syntax (e.g. "DIAMOND_BLOCK" or "PLAYER_HEAD (x)") is passed through.
    if (/^[A-Z_]+(\s*\(.*\))?(\s*!ENCHANTED)?$/.test(v) && v.includes('_')) return `${PREFIX[type]} ${v}`;
    return `${PREFIX[type]} PLAYER_HEAD (${v})`;
  }
  return `${PREFIX[type]} ${value.trim()}`;
}

const DEFAULT_VALUE = { TEXT: '&fNew line', ICON: 'DIAMOND', HEAD: '{player}', SMALLHEAD: '{player}', ENTITY: 'ALLAY' };
const PLACEHOLDER = {
  TEXT: '&eText with &acolors&e, {player} and %placeholders%',
  ICON: 'DIAMOND_SWORD   (add !ENCHANTED for the glint)',
  HEAD: 'Player name, {player}, or a base64 texture',
  SMALLHEAD: 'Player name, {player}, or a base64 texture',
  ENTITY: 'ZOMBIE',
};

function newLine(type, content) {
  return { content: content ?? contentFor(type, DEFAULT_VALUE[type]), height: S.meta.defaults.heights[type], flags: [], permission: '', offsetX: 0, offsetZ: 0, type };
}

$$('[data-add]').forEach((b) => b.addEventListener('click', () => {
  page().lines.push(newLine(b.dataset.add));
  renderLines(); changed();
  focusLine('#lines', page().lines.length - 1, true);
}));

function focusLine(listSel, i, select) {
  const input = $$(`${listSel} .line-content`)[i];
  if (!input) return;
  input.focus();
  if (select) input.select();
}

function renderLines() {
  const ol = $('#lines');
  ol.innerHTML = '';
  const lines = page().lines;
  if (!lines.length) ol.append(el('li', 'empty-lines', 'This page has no lines. Add one below.'));
  lines.forEach((line, i) => ol.append(lineRow(line, i, lines)));
  sortable(ol, lines, () => { renderLines(); changed(); });
}

function lineRow(line, i, lines) {
  const li = el('li', 'line');
  li.dataset.index = i;
  const key = `${S.page}:${i}`;
  const main = el('div', 'line-main');

  main.append(grip(i));

  const type = document.createElement('select');
  for (const [v, label] of TYPES) type.append(new Option(label, v));
  type.value = line.type;
  type.title = 'Line type';
  type.addEventListener('change', () => {
    const old = line.type;
    line.type = type.value;
    // Only head <-> small head keeps its value; anything else starts from a sensible default.
    const heads = ['HEAD', 'SMALLHEAD'];
    const keep = heads.includes(old) && heads.includes(line.type);
    line.content = contentFor(line.type, keep ? valueOf({ ...line, type: old }) : DEFAULT_VALUE[line.type]);
    if (Math.abs(line.height - S.meta.defaults.heights[old]) < 1e-9) line.height = S.meta.defaults.heights[line.type];
    renderLines(); changed();
  });
  main.append(type);

  const input = document.createElement('input');
  input.className = 'line-content';
  input.spellcheck = false;
  input.value = valueOf(line);
  input.placeholder = PLACEHOLDER[line.type];
  if (line.type === 'ICON') input.setAttribute('list', 'dl-materials');
  if (line.type === 'ENTITY') input.setAttribute('list', 'dl-entities');
  const set = (v) => { line.content = contentFor(line.type, v); changed({ coalesce: true }); };
  input.addEventListener('input', () => set(input.value));
  rememberText(input, li, line.type === 'TEXT' ? set : null);
  lineKeys(input, i, lines, () => renderLines(), '#lines', () => newLine('TEXT', ''));
  main.append(input);

  const height = document.createElement('input');
  height.type = 'number';
  height.step = '0.05';
  height.className = 'line-height';
  height.title = 'Line height: the gap below this line, in blocks';
  height.value = line.height;
  height.addEventListener('input', () => { const v = parseFloat(height.value); if (!isNaN(v)) { line.height = v; changed({ coalesce: true }); } });
  main.append(height);

  const btns = el('div', 'line-buttons');
  btns.append(
    iconBtn('⧉', 'Duplicate line', false, () => { lines.splice(i + 1, 0, clone(line)); renderLines(); changed(); }),
    iconBtn('⋯', 'More settings (offset, permission, flags)', false, () => {
      S.openMore.has(key) ? S.openMore.delete(key) : S.openMore.add(key);
      renderLines();
    }),
    iconBtn('✕', 'Delete line', false, () => { lines.splice(i, 1); renderLines(); changed(); }, 'danger'),
  );
  main.append(btns);
  li.append(main);

  const hint = lineHint(line);
  if (hint) li.append(el('div', 'line-hint', hint));

  if (S.openMore.has(key)) li.append(lineMore(line));
  return li;
}

/** Enter adds a line below; Alt+Up/Down moves the line. */
function lineKeys(input, i, lines, rerender, listSel, make) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      lines.splice(i + 1, 0, make());
      rerender(); changed();
      focusLine(listSel, i + 1);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (j < 0 || j >= lines.length) return;
      swap(lines, i, j);
      rerender(); changed();
      focusLine(listSel, j);
    }
  });
}

function rememberText(input, li, set) {
  const remember = () => {
    $$('.line.focused').forEach((x) => x.classList.remove('focused'));
    li.classList.add('focused');
    if (set) S.lastText = { input, set };
  };
  for (const ev of ['focus', 'click', 'keyup', 'select']) input.addEventListener(ev, remember);
}

function lineHint(line) {
  if (line.type === 'HEAD' || line.type === 'SMALLHEAD') return '{player} shows each viewer their own head.';
  if (line.type === 'ICON' && line.content && !S.meta.materials.includes(valueOf(line).split(/[\s:(!{]/)[0].toUpperCase())) return 'Not a known item name. It will show as stone.';
  if (line.type === 'ENTITY' && !S.meta.entities.includes(valueOf(line).split(/\s/)[0].toUpperCase())) return 'Not a known entity type.';
  return '';
}

function lineMore(line) {
  const more = el('div', 'line-more');
  more.append(
    numField('Offset X', line.offsetX, 0.1, (v) => { line.offsetX = v; }),
    numField('Offset Z', line.offsetZ, 0.1, (v) => { line.offsetZ = v; }),
    numField('Facing', line.facing ?? '', 1, (v) => { line.facing = v; }, 'Same as hologram', () => { delete line.facing; }),
  );
  const perm = el('label', 'field');
  perm.append(el('span', null, 'Permission'));
  const pi = document.createElement('input');
  pi.value = line.permission;
  pi.placeholder = 'Everyone';
  pi.spellcheck = false;
  pi.addEventListener('input', () => { line.permission = pi.value; changed({ preview: false, coalesce: true }); });
  perm.append(pi);
  more.append(perm);

  const flags = el('div', 'flags');
  for (const f of S.meta.flags) {
    const lab = el('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = line.flags.includes(f);
    cb.addEventListener('change', () => { toggle(line.flags, f, cb.checked); changed({ preview: false }); });
    lab.append(cb, flagLabel(f));
    flags.append(lab);
  }
  more.append(flags);
  return more;
}

function numField(label, value, step, set, placeholder, clear) {
  const f = el('label', 'field');
  f.append(el('span', null, label));
  const i = document.createElement('input');
  i.type = 'number';
  i.step = String(step);
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener('input', () => {
    if (i.value === '' && clear) { clear(); changed({ coalesce: true }); return; }
    const v = parseFloat(i.value);
    if (!isNaN(v)) { set(v); changed({ coalesce: true }); }
  });
  f.append(i);
  return f;
}

// ---- drag to reorder

function grip(i) {
  const g = el('span', 'grip', '⋮⋮');
  g.title = `Line ${i + 1}. Drag to reorder.`;
  return g;
}

/** Lets rows in `list` be dragged by their .grip to reorder `arr`. */
function sortable(list, arr, onMove) {
  let from = null;
  for (const li of list.children) {
    const g = $('.grip', li);
    if (!g) continue;
    g.addEventListener('mousedown', () => { li.draggable = true; });
    li.addEventListener('dragstart', (e) => {
      from = +li.dataset.index;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(from));
    });
    li.addEventListener('dragend', () => {
      li.draggable = false;
      li.classList.remove('dragging');
      $$('.drop-above, .drop-below', list).forEach((x) => x.classList.remove('drop-above', 'drop-below'));
    });
    li.addEventListener('dragover', (e) => {
      if (from === null) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const below = e.clientY > r.top + r.height / 2;
      li.classList.toggle('drop-below', below);
      li.classList.toggle('drop-above', !below);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-above', 'drop-below'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (from === null) return;
      const r = li.getBoundingClientRect();
      let to = +li.dataset.index + (e.clientY > r.top + r.height / 2 ? 1 : 0);
      const [item] = arr.splice(from, 1);
      if (to > from) to--;
      arr.splice(to, 0, item);
      from = null;
      onMove();
    });
  }
}

// ---- format toolbar

function insertCode(text, wrapEnd) {
  const target = S.lastText;
  if (!target || !document.body.contains(target.input)) { toast('Click into a text line first.', true); return; }
  const { input, set } = target;
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
  const v = input.value;
  if (wrapEnd !== undefined) {
    input.value = v.slice(0, s) + text + v.slice(s, e) + wrapEnd + v.slice(e);
    input.setSelectionRange(s + text.length, e + text.length);
  } else {
    // Codes go in front of the selection without replacing it.
    input.value = v.slice(0, s) + text + v.slice(s);
    input.setSelectionRange(s + text.length, e + text.length);
  }
  input.focus();
  S.lastPush = 0; // each toolbar action is its own undo step
  set(input.value);
}

$('#toolbar').addEventListener('mousedown', (e) => {
  // Keep the text selection in the line input when clicking toolbar buttons.
  if (e.target.closest('button')) e.preventDefault();
});
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-code]');
  if (b) insertCode(b.dataset.code);
});
$('#hex-color').addEventListener('change', (e) => insertCode('&' + e.target.value.toUpperCase()));
$('#grad-btn').addEventListener('click', () => insertCode(`<${$('#grad-a').value.toUpperCase()}>`, `</${$('#grad-b').value.toUpperCase()}>`));
$('#anim-select').addEventListener('change', (e) => {
  const a = e.target.value;
  e.target.value = '';
  if (!a) return;
  const args = { wave: ':&f,&b', burn: ':&f,&c', colors: '' }[a] ?? '';
  insertCode(`<#ANIM:${a}${args}>`, '</#ANIM>');
});
$('#ph-select').addEventListener('change', (e) => {
  const v = e.target.value;
  e.target.value = '';
  if (v) insertCode(v);
});

// ------------------------------------------------------------------ hologram: actions

function renderActions() {
  const wrap = $('#actions');
  wrap.innerHTML = '';
  const actions = page().actions;
  for (const click of S.meta.clickTypes) {
    const list = actions[click] || [];
    const g = el('div', 'click-group');
    const title = el('div', 'click-title');
    title.append(el('span', null, CLICK_LABELS[click] || click));
    const add = el('button', 'btn ghost small', '+ Add action');
    add.addEventListener('click', () => {
      (actions[click] = actions[click] || []).push('MESSAGE:');
      renderActions(); changed({ preview: false });
      $$(`[data-click="${click}"] input`).pop()?.focus();
    });
    title.append(add);
    g.append(title);
    const rows = el('div');
    rows.dataset.click = click;
    list.forEach((a, i) => rows.append(actionRow(actions, click, i)));
    if (!list.length) rows.append(el('div', 'muted small', 'Nothing happens.'));
    g.append(rows);
    wrap.append(g);
  }
}

function actionRow(actions, click, i) {
  const list = actions[click];
  const raw = list[i];
  const colon = raw.indexOf(':');
  let type = (colon < 0 ? raw : raw.slice(0, colon)).toUpperCase();
  const data = colon < 0 ? '' : raw.slice(colon + 1);
  const row = el('div', 'action-row');

  const sel = document.createElement('select');
  for (const tp of S.meta.actionTypes) sel.append(new Option(tp, tp));
  if (!S.meta.actionTypes.includes(type)) sel.append(new Option(type, type));
  sel.value = type;

  const input = document.createElement('input');
  input.value = data;
  input.spellcheck = false;
  const help = el('div', 'action-help');
  const describe = () => {
    const [ph, text] = ACTION_HELP[type] || ['', ''];
    input.placeholder = type === 'NEXT_PAGE' || type === 'PREV_PAGE' ? C().name : (type === 'PAGE' ? C().name + ':2' : ph);
    help.textContent = text;
  };
  const write = (coalesce) => {
    let d = input.value;
    // NEXT_PAGE / PREV_PAGE need the hologram's name; fill it in when left empty.
    if (!d && (type === 'NEXT_PAGE' || type === 'PREV_PAGE')) d = C().name;
    list[i] = d ? `${type}:${d}` : type;
    changed({ preview: false, coalesce });
  };
  sel.addEventListener('change', () => { type = sel.value; describe(); write(false); });
  input.addEventListener('input', () => write(true));
  describe();

  const btns = el('div', 'line-buttons');
  btns.append(
    iconBtn('↑', 'Run earlier', i === 0, () => { swap(list, i, i - 1); renderActions(); changed({ preview: false }); }),
    iconBtn('✕', 'Remove action', false, () => {
      list.splice(i, 1);
      if (!list.length) delete actions[click];
      renderActions(); changed({ preview: false });
    }, 'danger'),
  );
  row.append(sel, input, btns, help);
  return row;
}

// ------------------------------------------------------------------ hologram: settings

function renderHoloSettings() {
  const h = C();
  locationControls($('[data-loc="hologram"]'), () => ({ world: C().world, x: C().x, y: C().y, z: C().z }), (p) => Object.assign(C(), p), 2.5);
  facingControls($('[data-facing-slot="hologram"]'), () => C().facing, (v) => { C().facing = v; });
  for (const k of ['displayRange', 'updateRange', 'updateInterval']) $('#f-' + k).value = h[k];
  $('#f-enabled').checked = h.enabled;
  $('#f-downOrigin').checked = h.downOrigin;
  $('#f-permission').value = h.permission || '';
  $$('#holo-flags input').forEach((cb) => { cb.checked = h.flags.includes(cb.dataset.flag); });
}

for (const k of ['displayRange', 'updateRange', 'updateInterval']) {
  $('#f-' + k).addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { C()[k] = v; changed({ preview: false, coalesce: true }); } });
}
$('#f-enabled').addEventListener('change', (e) => { C().enabled = e.target.checked; changed(); });
$('#f-downOrigin').addEventListener('change', (e) => { C().downOrigin = e.target.checked; changed({ preview: false }); });
$('#f-permission').addEventListener('input', (e) => { C().permission = e.target.value; changed({ preview: false, coalesce: true }); });

// ------------------------------------------------------------------ hologram: preview

function renderPreview() {
  const box = $('#preview');
  box.innerHTML = '';
  if (!S.edit || !isHolo()) return;
  const lines = page().lines;
  box.style.opacity = C().enabled ? '1' : '.45';
  for (const line of lines) {
    const px = Math.max(4, line.height * 52); // ~52px per block at this zoom
    const row = el('div', 'mc-line');
    row.style.minHeight = px + 'px';
    if (line.type === 'TEXT') {
      const tx = el('span', 'mc-text');
      tx.append(renderMc(line.content));
      row.append(tx);
    } else {
      row.append(itemPreview(line, px));
    }
    if (line.offsetX || line.offsetZ) row.style.transform = `translateX(${(line.offsetX || 0) * 26}px)`;
    box.append(row);
  }
  if (!lines.length) box.append(el('div', 'muted small', 'Empty page'));
}

function itemPreview(line, px) {
  const v = valueOf(line);
  const size = line.type === 'SMALLHEAD' ? 26 : line.type === 'ENTITY' ? 48 : 34;
  const box = el('div', 'mc-item');
  box.style.width = size + 'px';
  box.style.height = Math.min(size, Math.max(px, 20)) + 'px';
  if ((line.type === 'HEAD' || line.type === 'SMALLHEAD') && /^[A-Za-z0-9_]{3,16}$/.test(v)) {
    const img = document.createElement('img');
    img.alt = v;
    img.src = `https://mc-heads.net/avatar/${encodeURIComponent(v)}/64`;
    img.onerror = () => { box.textContent = v; };
    box.append(img);
  } else {
    box.style.width = 'auto';
    box.style.minWidth = size + 'px';
    box.style.padding = '2px 6px';
    box.textContent = line.type === 'ENTITY' ? '🐾 ' + v : (line.type === 'ICON' ? v.split(' ')[0] : v);
  }
  return box;
}

// ------------------------------------------------------------------ displays

const ATTR_INFO = {
  billboard: ['Turning', 'How it turns toward the viewer. Center: always faces them. Vertical: turns left and right only. Horizontal: tilts up and down only. Fixed: never turns (uses Facing).'],
  scale: ['Size', 'Multiplier on each axis. 1 is normal size.'],
  translation: ['Offset', 'Shifts it from its location, in blocks. Rotates with the display.'],
  yaw: ['Spin override', 'Overrides the facing direction, in degrees (-180 to 180).'],
  pitch: ['Tilt override', 'Overrides the tilt, in degrees (-90 to 90).'],
  brightness: ['Fixed lighting', 'Ignores the light around it. 15/15 is full brightness, so it glows in the dark.'],
  'shadow-radius': ['Shadow size', 'Radius of the round shadow on the ground. 0 means no shadow.'],
  'shadow-strength': ['Shadow darkness', '1 is a normal mob shadow; higher is darker.'],
  alignment: ['Alignment', 'How lines of different lengths line up.'],
  'background-color': ['Background', 'Color and opacity of the box behind the text. 0% opacity hides it.'],
  'line-width': ['Wrap width', 'Text wraps after this many pixels (Minecraft font pixels).'],
  'text-opacity': ['Text opacity', '255 is solid. Very low values (under ~26) render solid in vanilla.'],
  'see-through': ['Visible through walls', 'Shows the text through blocks.'],
  'text-shadow': ['Text shadow', 'Drop shadow under the letters, like chat.'],
  'glow-color': ['Glow outline', 'Draws a glowing outline in this color, visible through walls.'],
  'display-type': ['Item pose', 'Which item model transform to use (GUI is flat like in an inventory, GROUND like a dropped item, HEAD like a helmet).'],
  enchanted: ['Enchant glint', 'Adds the enchanted shimmer.'],
  'leather-color': ['Leather dye', 'Dye color for leather armor and leather horse armor.'],
  'skull-texture': ['Head skin', 'For player_head: a player name, {player} (each viewer sees their own head), a base64 texture, or HEADDATABASE_<id>.'],
};
const ATTR_GROUPS = {
  TEXT: [['Text style', ['alignment', 'line-width', 'background-color', 'text-opacity', 'text-shadow', 'see-through']],
    ['Turning & size', ['billboard', 'scale', 'translation']],
    ['Light & shadow', ['brightness', 'shadow-radius', 'shadow-strength']],
    ['Rotation overrides', ['yaw', 'pitch']]],
  ITEM: [['Item', ['display-type', 'enchanted', 'skull-texture', 'leather-color', 'glow-color']],
    ['Turning & size', ['billboard', 'scale', 'translation']],
    ['Light & shadow', ['brightness', 'shadow-radius', 'shadow-strength']],
    ['Rotation overrides', ['yaw', 'pitch']]],
  BLOCK: [['Block', ['glow-color']],
    ['Turning & size', ['billboard', 'scale', 'translation']],
    ['Light & shadow', ['brightness', 'shadow-radius', 'shadow-strength']],
    ['Rotation overrides', ['yaw', 'pitch']]],
};
const ATTR_FALLBACK = {
  billboard: 'CENTER', scale: { x: 1, y: 1, z: 1 }, translation: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
  brightness: { 'block-light': 15, 'sky-light': 15 }, 'shadow-radius': 0, 'shadow-strength': 1, alignment: 'CENTER',
  'background-color': { red: 0, green: 0, blue: 0, alpha: 64 }, 'line-width': 200, 'text-opacity': 255, 'see-through': false,
  'text-shadow': false, 'glow-color': { red: 255, green: 255, blue: 255, alpha: 255 }, 'display-type': 'NONE', enchanted: false,
  'leather-color': { red: 160, green: 101, blue: 64, alpha: 255 }, 'skull-texture': '{player}',
};

function attrDefault(key) {
  const d = (S.meta.display.defaults[C().type] || {})[key];
  if (d) return clone(d);
  return { 'value-type': S.meta.display.attributes[key].valueType, value: clone(ATTR_FALLBACK[key]) };
}

function renderDisplay() {
  const d = C();
  const main = $('#display-main');
  // Keep the toolbar alive while we rebuild around it.
  document.body.append($('#toolbar'));
  main.innerHTML = '';

  // Content card
  const card = el('section', 'card');
  const head = el('div', 'row-between');
  head.append(el('h3', null, 'Content'));
  const typeSel = document.createElement('select');
  for (const tp of ['TEXT', 'ITEM', 'BLOCK']) typeSel.append(new Option(`${cap(tp)} display`, tp));
  typeSel.value = d.type;
  typeSel.title = 'Display type';
  typeSel.addEventListener('change', () => {
    d.type = typeSel.value;
    // Drop attributes the new type can't use, add its defaults for anything unset.
    for (const k of Object.keys(d.attributes)) if (!S.meta.display.attributes[k].types.includes(d.type)) delete d.attributes[k];
    for (const [k, v] of Object.entries(S.meta.display.defaults[d.type] || {})) if (!d.attributes[k]) d.attributes[k] = clone(v);
    if (d.type === 'TEXT' && !d.lines.length) d.lines = ['&fNew text'];
    if (d.type === 'ITEM' && !d.item) d.item = 'minecraft:diamond';
    if (d.type === 'BLOCK' && !d.block) d.block = 'minecraft:amethyst_block';
    renderEditor(); changed();
  });
  head.append(typeSel);
  card.append(head);

  if (d.type === 'TEXT') {
    card.append(el('div', 'toolbar-slot'));
    const ol = el('ol', 'lines');
    ol.id = 'dlines';
    const renderDLines = () => {
      ol.innerHTML = '';
      d.lines.forEach((text, i) => {
        const li = el('li', 'line');
        li.dataset.index = i;
        const row = el('div', 'dline-main');
        const input = document.createElement('input');
        input.className = 'line-content';
        input.spellcheck = false;
        input.value = text;
        input.placeholder = '&eText with &acolors&e, {player} and %placeholders%';
        const set = (v) => { d.lines[i] = v; changed({ coalesce: true }); };
        input.addEventListener('input', () => set(input.value));
        rememberText(input, li, set);
        lineKeys(input, i, d.lines, renderDLines, '#dlines', () => '');
        const btns = el('div', 'line-buttons');
        btns.append(
          iconBtn('⧉', 'Duplicate line', false, () => { d.lines.splice(i + 1, 0, text); renderDLines(); changed(); }),
          iconBtn('✕', 'Delete line', d.lines.length === 1, () => { d.lines.splice(i, 1); renderDLines(); changed(); }, 'danger'),
        );
        row.append(grip(i), input, btns);
        li.append(row);
        ol.append(li);
      });
      sortable(ol, d.lines, () => { renderDLines(); changed(); });
    };
    renderDLines();
    card.append(ol);
    const add = el('button', 'btn small', '+ Line');
    add.addEventListener('click', () => { d.lines.push(''); renderDLines(); changed(); focusLine('#dlines', d.lines.length - 1); });
    const addRow = el('div', 'add-line');
    addRow.append(add, el('span', 'muted small kbd-hint', 'Enter adds a line · Alt + ↑/↓ moves it · drag ⋮⋮ to reorder'));
    card.append(addRow);
  } else {
    const isItem = d.type === 'ITEM';
    const f = el('label', 'field');
    f.append(el('span', null, isItem ? 'Item' : 'Block'));
    const i = document.createElement('input');
    i.value = isItem ? d.item : d.block;
    i.spellcheck = false;
    i.placeholder = isItem ? 'minecraft:diamond_sword' : 'minecraft:amethyst_block';
    i.setAttribute('list', isItem ? 'dl-items' : 'dl-blocks');
    const hint = el('p', 'muted small');
    const check = () => {
      const k = i.value.trim().toLowerCase().replace(/^minecraft:/, '');
      const known = isItem ? S.meta.materials.includes(k.toUpperCase()) : (S.meta.display.blocks || []).includes(k);
      hint.textContent = !k || known ? '' : `Not a known ${isItem ? 'item' : 'block'}. Saving will fail.`;
    };
    i.addEventListener('input', () => { if (isItem) d.item = i.value.trim(); else d.block = i.value.trim(); check(); changed({ coalesce: true }); });
    check();
    f.append(i);
    card.append(f, hint);
  }
  main.append(card);

  // Look cards
  for (const [title, keys] of ATTR_GROUPS[d.type]) {
    const c = el('section', 'card attr-card');
    c.append(el('h3', null, title));
    for (const key of keys) c.append(attrRow(key));
    main.append(c);
  }
  renderDisplayPreview();
}

function attrRow(key) {
  const d = C();
  const info = ATTR_INFO[key] || [key, ''];
  const set = d.attributes[key];
  const row = el('div', 'attr-row' + (set ? '' : ' unset'));
  const top = el('div', 'attr-top');
  const lab = el('label', 'attr-toggle');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!set;
  cb.title = set ? 'Uncheck to use the Minecraft default' : 'Check to set this';
  cb.addEventListener('change', () => {
    if (cb.checked) d.attributes[key] = attrDefault(key); else delete d.attributes[key];
    row.replaceWith(attrRow(key));
    changed();
  });
  lab.append(cb, el('span', 'attr-name', info[0]));
  top.append(lab);
  if (!set) top.append(el('span', 'muted small', 'Minecraft default'));
  row.append(top);
  row.append(el('div', 'attr-help muted small', info[1]));
  if (set) row.append(attrControl(key, d.attributes[key], () => { row.replaceWith(attrRow(key)); }));
  return row;
}

function attrControl(key, attr, rerender) {
  const wrap = el('div', 'attr-control');
  const vt = attr['value-type'];
  const upd = (coalesce = true) => changed({ coalesce });

  const enumSelect = (options) => {
    const s = document.createElement('select');
    for (const o of options) s.append(new Option(o, o));
    s.value = attr.value;
    s.addEventListener('change', () => { attr.value = s.value; upd(false); });
    return s;
  };

  switch (vt) {
    case 'billboard_constraints': {
      const seg = el('div', 'segmented small');
      for (const o of S.meta.display.billboard) {
        const b = el('button', 'seg' + (attr.value === o ? ' active' : ''), cap(o));
        b.type = 'button';
        b.addEventListener('click', () => { attr.value = o; $$('.seg', seg).forEach((x) => x.classList.toggle('active', x === b)); upd(false); });
        seg.append(b);
      }
      wrap.append(seg);
      break;
    }
    case 'text_alignment': wrap.append(enumSelect(S.meta.display.alignment)); break;
    case 'item_display_type': wrap.append(enumSelect(S.meta.display.itemDisplayTypes)); break;
    case 'vector3f': {
      const v = attr.value;
      const uniform = key === 'scale';
      const lock = document.createElement('input');
      lock.type = 'checkbox';
      lock.checked = uniform && v.x === v.y && v.y === v.z;
      const inputs = {};
      const r = el('div', 'vec');
      for (const c of ['x', 'y', 'z']) {
        const f = el('label', 'mini');
        const i = document.createElement('input');
        i.type = 'number'; i.step = uniform ? '0.1' : '0.05'; i.value = v[c];
        i.addEventListener('input', () => {
          const n = parseFloat(i.value);
          if (isNaN(n)) return;
          if (lock.checked) { for (const k of ['x', 'y', 'z']) { v[k] = n; if (k !== c) inputs[k].value = n; } } else v[c] = n;
          upd();
        });
        inputs[c] = i;
        f.append(el('span', null, c.toUpperCase()), i);
        r.append(f);
      }
      wrap.append(r);
      if (uniform) {
        const presets = el('div', 'row inline');
        const ll = el('label', 'check small');
        lock.addEventListener('change', () => {
          if (lock.checked) { v.y = v.x; v.z = v.x; inputs.y.value = v.x; inputs.z.value = v.x; upd(false); }
        });
        ll.append(lock, 'Same on all axes');
        presets.append(ll);
        for (const p of [0.5, 1, 2, 3]) {
          const b = el('button', 'btn small', `${p}×`);
          b.type = 'button';
          b.addEventListener('click', () => { v.x = v.y = v.z = p; for (const k of ['x', 'y', 'z']) inputs[k].value = p; lock.checked = true; upd(false); });
          presets.append(b);
        }
        wrap.append(presets);
      }
      break;
    }
    case 'float':
    case 'integer': {
      const ranges = { yaw: [-180, 180, 1], pitch: [-90, 90, 1], 'shadow-radius': [0, 16, 0.1], 'shadow-strength': [0, 10, 0.1], 'text-opacity': [0, 255, 1], 'line-width': [20, 600, 1] };
      const [mn, mx, st] = ranges[key] || [0, 100, 1];
      const r = el('div', 'row inline');
      const range = document.createElement('input');
      range.type = 'range'; range.min = mn; range.max = mx; range.step = st; range.value = attr.value;
      const n = document.createElement('input');
      n.type = 'number'; n.step = st; n.className = 'narrow'; n.value = attr.value;
      const put = (val) => { attr.value = vt === 'integer' ? Math.round(val) : val; };
      range.addEventListener('input', () => { put(parseFloat(range.value)); n.value = attr.value; upd(); });
      n.addEventListener('input', () => { const v = parseFloat(n.value); if (!isNaN(v)) { put(v); range.value = v; upd(); } });
      r.append(range, n);
      wrap.append(r);
      break;
    }
    case 'boolean': {
      const l = el('label', 'check');
      const c = document.createElement('input');
      c.type = 'checkbox'; c.checked = !!attr.value;
      const txt = el('span', null, attr.value ? 'On' : 'Off');
      c.addEventListener('change', () => { attr.value = c.checked; txt.textContent = c.checked ? 'On' : 'Off'; upd(false); });
      l.append(c, txt);
      wrap.append(l);
      break;
    }
    case 'brightness': {
      for (const [k, label] of [['block-light', 'Block light'], ['sky-light', 'Sky light']]) {
        const r = el('div', 'row inline');
        const range = document.createElement('input');
        range.type = 'range'; range.min = 0; range.max = 15; range.step = 1; range.value = attr.value[k];
        const out = el('span', 'mono narrow-out', String(attr.value[k]));
        range.addEventListener('input', () => { attr.value[k] = +range.value; out.textContent = range.value; upd(); });
        r.append(el('span', 'small lbl', label), range, out);
        wrap.append(r);
      }
      break;
    }
    case 'string': {
      const i = document.createElement('input');
      i.value = attr.value; i.spellcheck = false;
      i.addEventListener('input', () => { attr.value = i.value; upd(); });
      wrap.append(i);
      break;
    }
    case 'rgba':
    case 'chroma': {
      const mode = el('div', 'segmented small');
      for (const [m, label] of [['rgba', 'Color'], ['chroma', 'Rainbow']]) {
        const b = el('button', 'seg' + (vt === m ? ' active' : ''), label);
        b.type = 'button';
        b.addEventListener('click', () => {
          if (attr['value-type'] === m) return;
          const alpha = attr.value.alpha ?? 255;
          attr['value-type'] = m;
          attr.value = m === 'chroma' ? { period: 100, alpha, saturation: 100, value: 100 } : { red: 255, green: 255, blue: 255, alpha };
          rerender(); upd(false);
        });
        mode.append(b);
      }
      wrap.append(mode);
      if (vt === 'rgba') {
        const v = attr.value;
        const r = el('div', 'row inline');
        const color = document.createElement('input');
        color.type = 'color';
        color.value = '#' + [v.red, v.green, v.blue].map((x) => (x | 0).toString(16).padStart(2, '0')).join('');
        color.addEventListener('input', () => { const [rr, gg, bb] = hexRgb(color.value.slice(1)); Object.assign(v, { red: rr, green: gg, blue: bb }); upd(); });
        const a = document.createElement('input');
        a.type = 'range'; a.min = 0; a.max = 255; a.value = v.alpha ?? 255;
        const out = el('span', 'mono narrow-out', `${Math.round(((v.alpha ?? 255) / 255) * 100)}%`);
        a.addEventListener('input', () => { v.alpha = +a.value; out.textContent = `${Math.round((v.alpha / 255) * 100)}%`; upd(); });
        r.append(color, el('span', 'small lbl', 'Opacity'), a, out);
        wrap.append(r);
      } else {
        const v = attr.value;
        for (const [k, label, mn, mx] of [['period', 'Cycle (ticks)', 10, 400], ['saturation', 'Saturation', 0, 100], ['value', 'Brightness', 0, 100], ['alpha', 'Opacity', 0, 255]]) {
          const r = el('div', 'row inline');
          const range = document.createElement('input');
          range.type = 'range'; range.min = mn; range.max = mx; range.value = v[k];
          const out = el('span', 'mono narrow-out', String(v[k]));
          range.addEventListener('input', () => { v[k] = +range.value; out.textContent = range.value; upd(); });
          r.append(el('span', 'small lbl', label), range, out);
          wrap.append(r);
        }
      }
      break;
    }
    default: wrap.append(el('span', 'muted small', `Edit ${vt} values in the YAML tab.`));
  }
  return wrap;
}

function renderDisplayPosition() {
  const d = C();
  locationControls($('[data-loc="display"]'), () => d.location, (p) => Object.assign(d.location, p), 1.5);
  facingControls($('[data-facing-slot="display"]'), () => d.location.yaw, (v) => { d.location.yaw = v; });
  $('#d-pitch').value = d.location.pitch;
  $('#d-pitch-range').value = d.location.pitch;
  $('#d-enabled').checked = d.settings.enabled;
  $('#d-range').value = d.settings['display-range'];
  $('#d-interval').value = d.settings['update-interval'];
}
const setPitch = (v) => {
  v = Math.max(-90, Math.min(90, Math.round(v)));
  C().location.pitch = v;
  $('#d-pitch').value = v; $('#d-pitch-range').value = v;
  changed({ coalesce: true });
};
$('#d-pitch').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setPitch(v); });
$('#d-pitch-range').addEventListener('input', (e) => setPitch(parseFloat(e.target.value)));
$('#d-enabled').addEventListener('change', (e) => { C().settings.enabled = e.target.checked; changed(); });
$('#d-range').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { C().settings['display-range'] = v; changed({ preview: false, coalesce: true }); } });
$('#d-interval').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { C().settings['update-interval'] = Math.round(v); changed({ preview: false, coalesce: true }); } });

function renderDisplayPreview() {
  const box = $('#dpreview');
  box.innerHTML = '';
  if (!S.edit || isHolo()) return;
  const d = C();
  const A = (k) => d.attributes[k] && d.attributes[k].value;
  box.style.opacity = d.settings.enabled ? '1' : '.45';
  const stage = el('div', 'd-stage');
  const scale = A('scale') || { x: 1, y: 1, z: 1 };
  const sx = Math.max(0.15, Math.min(3, scale.x)), sy = Math.max(0.15, Math.min(3, scale.y));
  const yawOverride = d.attributes.yaw ? A('yaw') : null;
  const billboard = A('billboard') || (d.type === 'TEXT' ? 'CENTER' : 'FIXED');
  const facing = yawOverride ?? d.location.yaw;
  const thing = el('div', 'd-thing');
  thing.style.transform = `scale(${sx}, ${sy})`;

  const glow = d.attributes['glow-color'];
  if (glow) thing.style.filter = glow['value-type'] === 'chroma' ? 'drop-shadow(0 0 3px #f0f) drop-shadow(0 0 3px #0ff)' : `drop-shadow(0 0 2px ${rgba(glow.value)}) drop-shadow(0 0 2px ${rgba(glow.value)})`;

  if (d.type === 'TEXT') {
    const bg = d.attributes['background-color'];
    const panel = el('div', 'd-text');
    panel.style.textAlign = (A('alignment') || 'CENTER').toLowerCase();
    panel.style.maxWidth = Math.round((A('line-width') ?? 200) * 1.6) + 'px';
    if (bg && bg['value-type'] === 'chroma') panel.classList.add('chroma-bg');
    else panel.style.background = bg ? rgba(bg.value) : 'rgba(0,0,0,.25)';
    const op = d.attributes['text-opacity'] ? A('text-opacity') : 255;
    panel.style.setProperty('--text-alpha', op < 26 ? 1 : op / 255);
    panel.classList.toggle('shadowed', !!A('text-shadow'));
    for (const line of d.lines) {
      const ln = el('div', 'd-line');
      ln.append(line ? renderMc(line) : document.createTextNode(' '));
      panel.append(ln);
    }
    thing.append(panel);
  } else {
    const name = (d.type === 'ITEM' ? d.item : d.block).replace(/^minecraft:/, '') || '?';
    const tile = el('div', d.type === 'BLOCK' ? 'd-block' : 'd-item');
    if (d.type === 'ITEM' && A('enchanted')) tile.classList.add('glint');
    tile.append(el('span', null, name.replace(/_/g, ' ')));
    thing.append(tile);
  }
  stage.append(thing);
  box.append(stage);
  const notes = [];
  notes.push(billboard === 'CENTER' ? 'Turning is Center, so it always faces the viewer.' : `Turning is ${cap(billboard)}; facing ${Math.round(facing)}°.`);
  if (A('see-through')) notes.push('Visible through walls.');
  if (d.attributes.brightness) notes.push(`Fixed light ${A('brightness')['block-light']}/${A('brightness')['sky-light']}.`);
  $('#dpreview-note').textContent = notes.join(' ');
}

const rgba = (v) => `rgba(${v.red | 0}, ${v.green | 0}, ${v.blue | 0}, ${((v.alpha ?? 255) / 255).toFixed(3)})`;

// ------------------------------------------------------------------ YAML

async function loadYaml() {
  const ta = $('#yaml');
  const kind = S.edit ? S.edit.kind : 'hologram';
  $('#yaml-help').textContent = kind === 'hologram'
    ? 'The hologram\'s file in plugins/DecentHolograms/holograms. Saving here replaces the whole file. If DecentHolograms rejects it, the old file is kept.'
    : 'The display\'s file in plugins/DecentHolograms/displays. Saving here replaces the whole file and reloads displays. If DecentHolograms rejects it, the old file is kept.';
  if (!S.edit || S.edit.original === null) { ta.value = '# Save it first to edit its file.'; ta.disabled = true; return; }
  if (isDirty()) toast('The YAML shows the saved version. Save or revert your changes in the other tabs first.', true);
  ta.disabled = false;
  try { ta.value = (await api('GET', `${apiBase(kind)}/${encodeURIComponent(S.edit.original)}/yaml`)).yaml; }
  catch (e) { toast(e.message, true); }
}
$('#yaml-reload').addEventListener('click', loadYaml);

async function saveYaml() {
  if (!S.edit || S.edit.original === null) return;
  if (isDirty() && !confirm('Saving the YAML discards your unsaved changes in the other tabs. Continue?')) return;
  const { kind, original, fingerprint } = S.edit;
  try {
    const res = await api('PUT', `${apiBase(kind)}/${encodeURIComponent(original)}/yaml`, { yaml: $('#yaml').value, fingerprint });
    load(kind, res, res.name, { keepTab: true });
    showWarnings(res.warnings);
    toast('YAML saved. It\'s live in game.');
    refreshLists();
  } catch (e) { toast(e.message, true); }
}
$('#yaml-save').addEventListener('click', saveYaml);

// ------------------------------------------------------------------ Minecraft text rendering

/** Renders Minecraft/DecentHolograms formatting: &codes, &#hex, <#hex>, {#hex}, gradients, placeholders, animations. */
function renderMc(text) {
  const frag = document.createDocumentFragment();
  const reset = () => ({ color: '#FFFFFF', b: false, i: false, u: false, s: false, k: false });
  let style = reset();
  let anim = false;

  text = text.replace(/<#([0-9a-f]{6})>(.*?)<\/#([0-9a-f]{6})>/gi, (_, a, body, b) => gradient(body, a, b));
  text = text.replace(/<RAINBOW\d*>(.*?)<\/RAINBOW>/gi, (_, body) => rainbow(body));

  const push = (s, cls) => {
    if (!s) return;
    const span = document.createElement('span');
    span.textContent = s;
    span.style.color = style.color;
    if (style.b) span.style.fontWeight = '700';
    if (style.i) span.style.fontStyle = 'italic';
    const deco = [style.u && 'underline', style.s && 'line-through'].filter(Boolean).join(' ');
    if (deco) span.style.textDecoration = deco;
    if (style.k) span.classList.add('mc-k');
    if (anim) span.classList.add('mc-anim');
    if (cls) span.classList.add(cls);
    frag.append(span);
  };

  const re = /&#([0-9a-f]{6})|\{#([0-9a-f]{6})\}|<#([0-9a-f]{6})>|[&§]([0-9a-fk-or])|(<#?ANIM:[^>]*>)|(<\/#?ANIM>)|(%[A-Za-z0-9_:.\-]+%|\{player\})/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const hex = m[1] || m[2] || m[3];
    if (hex) { style = { ...reset(), color: '#' + hex }; continue; }
    if (m[4]) {
      const c = m[4].toLowerCase();
      if (MC_COLORS[c]) style = { ...reset(), color: MC_COLORS[c] };
      else if (c === 'l') style.b = true;
      else if (c === 'o') style.i = true;
      else if (c === 'n') style.u = true;
      else if (c === 'm') style.s = true;
      else if (c === 'k') style.k = true;
      else if (c === 'r') style = reset();
      continue;
    }
    if (m[5]) { anim = true; continue; }
    if (m[6]) { anim = false; continue; }
    if (m[7]) push(m[7] === '{player}' ? 'Steve' : m[7], m[7] === '{player}' ? null : 'mc-ph');
  }
  push(text.slice(last));
  return frag;
}

function gradient(body, a, b) {
  const chars = [...body.replace(/&[0-9a-fk-or]/gi, '')];
  const ca = hexRgb(a), cb = hexRgb(b);
  return chars.map((ch, i) => {
    const tt = chars.length < 2 ? 0 : i / (chars.length - 1);
    const c = ca.map((v, k) => Math.round(v + (cb[k] - v) * tt));
    return '&#' + c.map((v) => v.toString(16).padStart(2, '0')).join('') + ch;
  }).join('');
}
function rainbow(body) {
  const chars = [...body];
  return chars.map((ch, i) => '&#' + hsl((i / Math.max(1, chars.length)) * 360) + ch).join('');
}
const hexRgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
function hsl(h) {
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function iconBtn(label, title, disabled, onClick, extra) {
  const b = el('button', 'icon-btn' + (extra ? ' ' + extra : ''), label);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}
function swap(a, i, j) { [a[i], a[j]] = [a[j], a[i]]; }
function toggle(arr, v, on) { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); }
function flagLabel(f) {
  return { DISABLE_PLACEHOLDERS: 'No placeholders', DISABLE_UPDATING: 'No updating', DISABLE_ANIMATIONS: 'No animations', DISABLE_ACTIONS: 'No click actions' }[f] || f;
}
const cap = (s) => (s ? s[0] + s.slice(1).toLowerCase() : '');
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : parseFloat(v) || 0);
const round = (v) => Math.round(v * 1000) / 1000;
const fmt = (v) => (Math.round(v * 10) / 10).toString();

let toastTimer;
function toast(msg, error) {
  const tt = $('#toast');
  tt.textContent = msg;
  tt.className = 'toast' + (error ? ' error' : '');
  tt.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { tt.hidden = true; }, error ? 6000 : 3000);
}

// Keep lists, players and the open item fresh (in-game edits, players joining).
setInterval(() => {
  if ($('#app').hidden || document.hidden || !S.meta) return;
  refreshMeta().then(() => refreshLists()).catch(() => {});
  checkRemote();
}, 10000);

boot();
