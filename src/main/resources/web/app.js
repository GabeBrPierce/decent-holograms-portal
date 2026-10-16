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
  lists: { hologram: [], display: [], animation: [] },
  edit: null,                       // { kind, current, saved, original, fingerprint }
  page: 0,                          // hologram page being edited
  openMore: new Set(),              // "page:line" keys with the details row open
  lastText: null,                   // { input, set } last text input used, for the format toolbar
  hist: [], hi: 0, lastPush: 0,     // undo history (JSON snapshots)
  tabs: { hologram: 'content', display: 'dcontent', animation: 'aframes' },
};
const C = () => S.edit.current;
const isHolo = () => S.edit && S.edit.kind === 'hologram';
const isAnim = () => S.edit && S.edit.kind === 'animation';
const KINDS = ['hologram', 'display', 'animation'];

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
const apiBase = (kind) => ({ display: 'displays', animation: 'animations' }[kind] || 'holograms');

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
  if (name && KINDS.includes(kind)) {
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
  const [h, d, a] = await Promise.all([api('GET', 'holograms'), api('GET', 'displays').catch(() => []), api('GET', 'animations').catch(() => [])]);
  S.lists.hologram = h;
  S.lists.display = d;
  S.lists.animation = a;
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
  $('#count-animation').textContent = S.lists.animation.length || '';
  $('.sidebar-filters').hidden = S.kind === 'animation';

  let items = S.lists[S.kind].filter((h) =>
    (!q || h.name.toLowerCase().includes(q) || (h.preview || '').toLowerCase().includes(q)) && (!world || S.kind === 'animation' || h.world === world));
  if (sort.startsWith('near:') && S.kind !== 'animation') {
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
    if (S.kind === 'animation' && h.loaded === false) name.append(el('span', 'pill warn', 'not loaded'));
    li.append(el('div', 'holo-meta', S.kind === 'animation'
      ? `${h.frames} frame${h.frames === 1 ? '' : 's'} · ${loopText(h)}`
      : h.unloaded
      ? `${h.world} isn't loaded`
      : `${h.world} · ${fmt(h.x)}, ${fmt(h.y)}, ${fmt(h.z)}` + (S.kind === 'hologram' ? ` · ${h.lines} line${h.lines === 1 ? '' : 's'}${h.pages > 1 ? ` · ${h.pages} pages` : ''}` : '') + dist));
    if (h.preview) {
      const p = el('div', 'holo-preview');
      if (h.preview.startsWith('Item: ') || h.preview.startsWith('Block: ')) p.textContent = h.preview;
      else if (S.kind === 'animation') mcLive(p, `<#ANIM:${h.name}>Text</#ANIM>`);
      else mcLive(p, h.preview);
      li.append(p);
    }
    if (!h.unloaded) li.addEventListener('click', () => openItem(S.kind, h.name));
    ul.append(li);
  }
  if (!items.length) {
    const none = S.lists[S.kind].length ? 'No matches.' : S.kind === 'animation' ? 'No custom animations yet. Click + New and pick Custom animation.' : (S.kind === 'display'
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
  const current = kind === 'hologram' ? normalizeHologram(data) : kind === 'display' ? normalizeDisplay(data) : normalizeAnimation(data);
  S.edit = { kind, current, saved: JSON.stringify(current), original, fingerprint, usedIn: data.usedIn || [] };
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

function normalizeAnimation(a) {
  return { name: a.name, speed: a.speed ?? 2, pause: a.pause ?? 0, steps: [...(a.steps || ['{text}'])] };
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
  if (kind === 'animation' && original && original !== C().name && S.edit.usedIn.length
    && !confirm(`${S.edit.usedIn.length} hologram(s) or display(s) use <#ANIM:${original}>. After renaming, they'll show the tag as plain text until you update them. Rename anyway?`)) {
    updateDirty();
    return;
  }
  try {
    const res = await api('POST', apiBase(kind), { original, fingerprint, [kind]: forSave() });
    if (kind === 'animation') await refreshMeta(); // previews everywhere use the new frames
    load(kind, res, res.name, { keepTab: true });
    showWarnings(res.warnings);
    toast(kind === 'animation' ? 'Saved. DecentHolograms reloaded its animations.' : 'Saved. It\'s live in game.');
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
    if (kind === 'animation') await refreshMeta();
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
  if (kind === 'hologram') copy.z = round(copy.z + 2); else if (kind === 'display') copy.location.z = round(copy.location.z + 2);
  S.edit.saved = null;
  load(kind, copy, null);
  toast(kind === 'animation' ? 'Copy made. Save to create it.' : 'Copy made 2 blocks south. Save to create it.');
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
const ANIM_TEMPLATES = {
  blank: { label: 'Blank', speed: 2, pause: 0, steps: () => ['{text}'] },
  cycle: { label: 'Color cycle', speed: 4, pause: 0, steps: () => ['&c', '&6', '&e', '&a', '&b', '&d'].map((c) => c + '{text}') },
  blink: { label: 'Blink', speed: 10, pause: 0, steps: () => ['&f{text}', '&8{text}'] },
  sparkle: { label: 'Sparkle', speed: 5, pause: 0, steps: () => ['&e✦ &f{text} &e✦', '&6✧ &f{text} &6✧', '&e⋆ &f{text} &e⋆', '&6✧ &f{text} &6✧'] },
  arrows: { label: 'Arrows', speed: 4, pause: 0, steps: () => ['&a»  &f{text}  &a«', '&a »&f{text}&a« ', '&a  »&f{text}&a«  ', '&a »&f{text}&a« '] },
  shine: { label: 'Gradient shine', speed: 2, pause: 30, steps: () => shineFrames('#55FFFF', '#FFFFFF', 12) },
};
function updateNewDialog() {
  const kind = newKind();
  $('#template-field').hidden = kind !== 'hologram' && kind !== 'animation';
  $('#at-field').hidden = kind === 'animation';
  const tpl = $('#new-template');
  const want = kind === 'animation' ? 'anim' : 'holo';
  if (tpl.dataset.for !== want) {
    tpl.innerHTML = '';
    for (const [k, v] of Object.entries(kind === 'animation' ? ANIM_TEMPLATES : HOLO_TEMPLATES)) tpl.append(new Option(v.label, k));
    tpl.dataset.for = want;
  }
}
$('#new-kind').addEventListener('change', updateNewDialog);

$('#new-btn').addEventListener('click', () => openNew());

async function openNew(prefer) {
  await refreshMeta();
  const sel = $('#new-at');
  sel.innerHTML = '';
  for (const p of S.meta.players) sel.append(new Option(`${p.name}'s position (${p.world})`, 'player:' + p.name));
  for (const w of S.meta.worlds) sel.append(new Option(`${w}, near 0, 100, 0`, 'world:' + w));
  $('#new-template').dataset.for = '';
  const displays = S.meta.display && S.meta.display.available;
  const preferred = prefer || (S.kind === 'animation' ? 'animation' : S.kind === 'display' && displays ? 'TEXT' : 'hologram');
  $$('#new-kind input').forEach((r) => {
    r.disabled = !['hologram', 'animation'].includes(r.value) && !displays;
    r.checked = r.value === preferred;
  });
  updateNewDialog();
  $('#new-name').value = '';
  $('#new-dialog').showModal();
  $('#new-name').focus();
}

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
  if (kind === 'animation') {
    const tp = ANIM_TEMPLATES[$('#new-template').value] || ANIM_TEMPLATES.blank;
    load('animation', { name, speed: tp.speed, pause: tp.pause, steps: tp.steps() }, null);
  } else if (kind === 'hologram') {
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
  if (!tab || (tab.dataset.for && tab.dataset.for !== kind)) name = { hologram: 'content', display: 'dcontent', animation: 'aframes' }[kind];
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
      : isAnim() ? $('#anim-main .toolbar-slot')
        : (C().type === 'TEXT' ? $('#display-main .toolbar-slot') : null);
  if (slot) { slot.append(tb); tb.hidden = false; } else { tb.hidden = true; }
}

function renderEditor() {
  const kind = S.edit.kind;
  $('#f-name').value = C().name;
  $('#kind-badge').textContent = kind === 'hologram' ? 'Hologram' : kind === 'animation' ? 'Animation' : `${cap(C().type)} display`;
  $('.tp').hidden = kind === 'animation';
  $('#draft').hidden = S.edit.original !== null;
  $('#dup-btn').disabled = S.edit.original === null;
  $('#del-btn').textContent = S.edit.original === null ? 'Discard' : 'Delete';
  if (kind === 'hologram') {
    renderPages();
    renderLines();
    renderActions();
    renderHoloSettings();
    renderPreview();
  } else if (kind === 'display') {
    renderDisplay();
    renderDisplayPosition();
  } else {
    renderAnimation();
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
  if (preview) { if (isHolo()) renderPreview(); else if (isAnim()) renderAnimPreview(); else renderDisplayPreview(); }
  pushHistory(coalesce);
  updateDirty();
}

$('#f-name').addEventListener('input', (e) => {
  C().name = e.target.value.trim();
  if (isAnim()) renderUsage();
  changed({ preview: false, coalesce: true });
});

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
  if (line.type === 'TEXT') return animHint(line.content);
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
      mcLive(tx, line.content);
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
      if (line) mcLive(ln, line); else ln.textContent = '\u00a0';
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

// ------------------------------------------------------------------ animations: engine
// A port of DecentHolograms' text animations, so previews play exactly as they do in game.

const ANIM_RE = /[<{]#?ANIM:(\w+)(:\S+)?[}>](.*?)[<{]\/#?ANIM[}>]/g;
const PREVIEW_ANIM = '__portal_preview';
const BUILTIN_INFO = {
  typewriter: ['Types the text out letter by letter, then holds it.', []],
  wave: ['A bright band sweeps across the text.', ['Base color', 'Highlight color'], ['&f', '&b']],
  burn: ['The text changes color left to right, like a burning fuse.', ['Color before', 'Color after'], ['&7', '&c']],
  scroll: ['Scrolls the text sideways like a marquee.', []],
  colors: ['Cycles the whole text through colors. Leave the list empty for a rainbow.', []],
};
const tickNow = () => Math.floor(performance.now() / 50); // 20 ticks per second, like the server
const stripLegacy = (s) => s.replace(/[&§][0-9a-fk-orA-FK-OR]/g, '');
const specialFmt = (s) => (s.match(/[&§][k-oK-O]/g) || []).join('');

/** DecentHolograms' Animation.getCurrentStep. */
function stepOf(step, maxSteps, speed, pause) {
  if (maxSteps <= 0) return 0;
  speed = Math.max(1, speed | 0);
  const actual = Math.floor(step / speed);
  const actualPause = pause <= 0 ? 0 : Math.floor(pause / speed);
  return Math.min(actual % (maxSteps + actualPause), maxSteps);
}

const BUILTIN_ANIM = {
  typewriter(t, step, a, d) {
    const st = stripLegacy(t);
    return specialFmt(t) + st.slice(0, stepOf(step, st.length, d.speed, d.pause));
  },
  wave(t, step, a, d) {
    if (!a || !a[0]) return null; // DH errors without colors
    const sp = specialFmt(t), st = stripLegacy(t), len = st.length, size = Math.floor(len / 4);
    const cur = stepOf(step, len + size, d.speed, d.pause);
    const i1 = cur > size ? cur - size : 0;
    const i2 = cur < size ? size - (size - cur) : cur;
    const c1 = a[0], c2 = a.length === 1 ? '&f' : a[1];
    const start = i1 !== 0 ? st.slice(0, i1) : '';
    const mid = len > i2 ? st.slice(i1, i2) : st.slice(i1);
    const end = len > i2 ? st.slice(i2) : '';
    return c1 + sp + start + c2 + sp + mid + c1 + sp + end;
  },
  burn(t, step, a, d) {
    if (!a || a.length < 2) return null;
    const sp = specialFmt(t), st = stripLegacy(t);
    const cur = stepOf(step, st.length, d.speed, d.pause);
    return a[1] + sp + st.slice(0, cur) + a[0] + sp + st.slice(cur);
  },
  scroll(t, step, a, d) {
    const sp = specialFmt(t), st = stripLegacy(t), len = st.length, size = Math.floor(len / 3) * 2;
    const cur = stepOf(step, len, d.speed, d.pause);
    const i2 = cur + size;
    if (i2 > len) return sp + st.slice(cur) + ' ' + sp + st.slice(0, i2 - len);
    return sp + st.slice(cur, i2);
  },
  colors(t, step, a, d) {
    const colors = a && a.length && a[0] ? a : ['&c', '&6', '&e', '&a', '&b', '&d'];
    return colors[stepOf(step, colors.length, d.speed, d.pause)] + t;
  },
};

function animDefs() {
  const m = {};
  for (const d of (S.meta && S.meta.animationDefs) || []) m[d.name] = d;
  if (S.animOverride) m[PREVIEW_ANIM] = S.animOverride;
  return m;
}

function runAnim(def, text, step, args) {
  if (def.builtin) return (BUILTIN_ANIM[def.name] || (() => null))(text, step, args, def);
  const steps = def.steps || [];
  if (!steps.length) return '';
  return steps[stepOf(step, steps.length - 1, def.speed, def.pause)].split('{text}').join(text);
}

/** DecentHolograms' AnimationManager.parseTextAnimations: unknown or broken tags stay as written. */
function applyAnimations(text, step) {
  const defs = animDefs();
  let out = text.replace(ANIM_RE, (all, name, args, body) => {
    const d = defs[name];
    if (!d) return all;
    const r = runAnim(d, body, step, args ? args.slice(1).split(',') : null);
    return r === null ? all : r;
  });
  if (out.includes('&u')) out = out.split('&u').join(runAnim({ builtin: true, name: 'colors', speed: 4, pause: 0 }, '', step, null));
  return out;
}

const hasAnim = (t) => t.includes('&u') || /[<{]#?ANIM:\w+/.test(t);

// Elements showing animated text; redrawn every tick while they're on the page.
const LIVE = new Set();
const TICKERS = new Set();
function mcLive(target, text) {
  const entry = { el: target, text, last: null };
  drawLive(entry);
  if (hasAnim(text)) LIVE.add(entry);
}
function drawLive(e) {
  const out = hasAnim(e.text) ? applyAnimations(e.text, tickNow()) : e.text;
  if (out === e.last) return;
  e.last = out;
  e.el.textContent = '';
  e.el.append(renderMc(out));
}
setInterval(() => {
  for (const e of LIVE) {
    if (!e.el.isConnected) LIVE.delete(e); else drawLive(e);
  }
  for (const f of TICKERS) f();
}, 50);

/** One loop of a custom animation, in ticks (DH never shows the last frame unless pause >= speed). */
function loopTicks(a) {
  const n = (a.steps ? a.steps.length : a.frames) || 0;
  const speed = Math.max(1, a.speed | 0);
  return (Math.max(0, n - 1) + (a.pause <= 0 ? 0 : Math.floor(a.pause / speed))) * speed;
}
function loopText(a) {
  const t = loopTicks(a);
  return t ? `loops every ${(t / 20).toFixed(t % 20 ? 2 : 0)}s` : 'static';
}

/** Gradient frames where the bright end slides across the text. */
function shineFrames(a, b, n) {
  const A = hexRgb(a.slice(1)), B = hexRgb(b.slice(1));
  const mix = (x, y, t) => '#' + x.map((v, k) => Math.round(v + (y[k] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    frames.push(`<${mix(A, B, t)}>{text}</${mix(B, A, t)}>`);
  }
  return frames;
}

/** Problems with animation tags in a line, as a hint. */
function animHint(content) {
  const defs = animDefs();
  ANIM_RE.lastIndex = 0;
  let m, found = false;
  while ((m = ANIM_RE.exec(content))) {
    found = true;
    const [, name, args, body] = m;
    if (!defs[name]) return `There's no animation called "${name}", so players see the tag as text.`;
    if (['typewriter', 'wave', 'burn', 'scroll'].includes(name) && /[&§][0-9a-f]|&#|<#[0-9a-f]|\{#/i.test(body)) {
      return `${name} drops colors inside the tag. Put the color before the tag instead, e.g. &e<#ANIM:${name}>text</#ANIM>.`;
    }
    const parts = args ? args.slice(1).split(',') : [];
    if (name === 'wave' && !parts[0]) return 'wave needs colors, e.g. <#ANIM:wave:&f,&b>text</#ANIM>.';
    if (name === 'burn' && parts.length < 2) return 'burn needs two colors, e.g. <#ANIM:burn:&7,&c>text</#ANIM>.';
  }
  if (!found && /[<{]#?ANIM:/.test(content)) return 'An animation tag isn\'t closed. Add </#ANIM> after the text.';
  return '';
}

// ------------------------------------------------------------------ animations: picker dialog

const COLOR_CODES = Object.keys(MC_COLORS).map((c) => '&' + c);
let pick = { name: 'typewriter', args: {} };

$('#anim-btn').addEventListener('click', () => {
  const target = S.lastText;
  if (!target || !document.body.contains(target.input)) { toast('Click into a text line first.', true); return; }
  const { input } = target;
  const sel = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
  pick.sample = stripTags(sel) || 'Sample text';
  pick.selection = { start: input.selectionStart, end: input.selectionEnd };
  renderAnimPicker();
  $('#anim-dialog').showModal();
});

const stripTags = (s) => s.replace(ANIM_RE, '$3');

function pickTag(name, args) {
  const info = BUILTIN_INFO[name];
  let a = '';
  if (info && info[2]) a = ':' + (args[name] || info[2]).join(',');
  if (name === 'colors' && args.colors && args.colors.length) a = ':' + args.colors.join(',');
  return `<#ANIM:${name}${a}>`;
}

function renderAnimPicker() {
  const list = $('#anim-choices');
  list.innerHTML = '';
  const defs = (S.meta.animationDefs || []);
  for (const d of defs) {
    const lab = el('label', 'anim-choice' + (pick.name === d.name ? ' active' : ''));
    const r = document.createElement('input');
    r.type = 'radio'; r.name = 'anim'; r.value = d.name; r.checked = pick.name === d.name;
    r.addEventListener('change', () => { pick.name = d.name; renderAnimPicker(); });
    const body = el('span', 'anim-choice-body');
    const title = el('b', null, d.name);
    if (!d.builtin) title.append(el('span', 'pill', 'custom'));
    body.append(title, el('small', 'muted', d.builtin ? BUILTIN_INFO[d.name][0] : `${(d.steps || []).length} frames · ${loopText(d)}`));
    const prev = el('span', 'anim-choice-preview');
    mcLive(prev, `${pickTag(d.name, pick.args)}${pick.sample}</#ANIM>`);
    lab.append(r, body, prev);
    list.append(lab);
  }
  const opts = $('#anim-options');
  opts.innerHTML = '';
  const info = BUILTIN_INFO[pick.name];
  if (info && info[2]) {
    const vals = pick.args[pick.name] || [...info[2]];
    pick.args[pick.name] = vals;
    info[1].forEach((label, i) => {
      const f = el('label', 'field inline-field');
      f.append(el('span', null, label));
      f.append(colorCodeSelect(vals[i], (v) => { vals[i] = v; renderAnimPicker(); }));
      opts.append(f);
    });
  } else if (pick.name === 'colors') {
    const f = el('label', 'field');
    f.append(el('span', null, 'Colors (comma-separated codes)'));
    const i = document.createElement('input');
    i.placeholder = '&c,&6,&e,&a,&b,&d';
    i.value = (pick.args.colors || []).join(',');
    i.addEventListener('change', () => { pick.args.colors = i.value.split(',').map((x) => x.trim()).filter(Boolean); renderAnimPicker(); });
    f.append(i);
    opts.append(f);
  }
}

function colorCodeSelect(value, onChange) {
  const s = document.createElement('select');
  const names = { '&0': 'Black', '&1': 'Dark blue', '&2': 'Dark green', '&3': 'Dark aqua', '&4': 'Dark red', '&5': 'Purple', '&6': 'Gold', '&7': 'Gray', '&8': 'Dark gray', '&9': 'Blue', '&a': 'Green', '&b': 'Aqua', '&c': 'Red', '&d': 'Pink', '&e': 'Yellow', '&f': 'White' };
  for (const c of COLOR_CODES) {
    const o = new Option(`${names[c]} (${c})`, c);
    o.style.color = MC_COLORS[c[1]];
    s.append(o);
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

$('#anim-form').addEventListener('submit', (e) => {
  const v = e.submitter && e.submitter.value;
  if (v === 'custom') {
    setTimeout(() => openNew('animation'), 0);
    return;
  }
  if (v !== 'ok') return;
  const { input } = S.lastText;
  input.setSelectionRange(pick.selection.start, pick.selection.end);
  const empty = pick.selection.start === pick.selection.end;
  insertCode(pickTag(pick.name, pick.args) + (empty ? 'Text' : ''), '</#ANIM>');
});

// ------------------------------------------------------------------ animations: editor

S.animSample = 'Hello world';

function renderAnimation() {
  const a = C();
  const main = $('#anim-main');
  document.body.append($('#toolbar'));
  main.innerHTML = '';

  // Timing
  const timing = el('section', 'card');
  timing.append(el('h3', null, 'Timing'));
  const speedRow = numberSlider('Speed', 'Ticks each frame shows (20 ticks = 1 second). Lower is faster.', a.speed, 1, 40, (v) => { a.speed = Math.max(1, Math.round(v)); timingNote(); });
  const pauseRow = numberSlider('Hold last frame', 'Extra ticks the last frame stays before the loop restarts.', a.pause, 0, 200, (v) => { a.pause = Math.max(0, Math.round(v)); timingNote(); });
  const note = el('div', 'timing-note');
  const timingNote = () => {
    note.innerHTML = '';
    if (a.steps.length > 1 && a.pause < a.speed) {
      note.className = 'timing-note warn';
      note.append(document.createTextNode('DecentHolograms skips the last frame unless Hold is at least Speed. '));
      const fix = el('button', 'btn small', 'Show every frame evenly');
      fix.type = 'button';
      fix.addEventListener('click', () => { a.pause = a.speed; renderAnimation(); changed(); });
      note.append(fix);
    } else {
      note.className = 'timing-note muted small';
      note.textContent = a.steps.length > 1 ? `One loop takes ${(loopTicks(a) / 20).toFixed(2)} seconds.` : 'One frame: the text never changes.';
    }
    $('#anim-loop').textContent = loopText(a);
  };
  timing.append(speedRow, pauseRow, note);
  main.append(timing);

  // Frames
  const card = el('section', 'card');
  const head = el('div', 'row-between');
  head.append(el('h3', null, 'Frames'));
  const sample = el('label', 'field inline-field');
  sample.append(el('span', null, 'Preview text'));
  const si = document.createElement('input');
  si.value = S.animSample;
  si.title = 'What {text} becomes in the preview';
  si.addEventListener('input', () => { S.animSample = si.value; renderAnimPreview(); });
  sample.append(si);
  head.append(sample);
  card.append(head);
  card.append(el('p', 'muted small', '{text} is replaced by whatever is inside the tag. A frame without {text} ignores it, so you can also animate fixed text.'));
  card.append(el('div', 'toolbar-slot'));
  const ins = el('button', 'btn small', 'Insert {text}');
  ins.type = 'button';
  ins.addEventListener('mousedown', (e) => e.preventDefault());
  ins.addEventListener('click', () => insertCode('{text}'));

  const ol = el('ol', 'lines');
  ol.id = 'aframes';
  const renderFrames = () => {
    ol.innerHTML = '';
    a.steps.forEach((text, i) => {
      const li = el('li', 'line');
      li.dataset.index = i;
      const row = el('div', 'dline-main');
      const input = document.createElement('input');
      input.className = 'line-content';
      input.spellcheck = false;
      input.value = text;
      input.placeholder = '&b{text}';
      const set = (v) => { a.steps[i] = v; changed({ coalesce: true }); };
      input.addEventListener('input', () => set(input.value));
      rememberText(input, li, set);
      lineKeys(input, i, a.steps, () => { renderFrames(); timingNote(); }, '#aframes', () => a.steps[i]);
      const btns = el('div', 'line-buttons');
      btns.append(
        iconBtn('⧉', 'Duplicate frame', false, () => { a.steps.splice(i + 1, 0, text); renderFrames(); timingNote(); changed(); }),
        iconBtn('✕', 'Delete frame', a.steps.length === 1, () => { a.steps.splice(i, 1); renderFrames(); timingNote(); changed(); }, 'danger'),
      );
      const g = grip(i);
      g.title = `Frame ${i + 1}. Drag to reorder.`;
      row.append(g, input, btns);
      li.append(row);
      ol.append(li);
    });
    sortable(ol, a.steps, () => { renderFrames(); changed(); });
  };
  renderFrames();
  card.append(ol);
  const addRow = el('div', 'add-line');
  const add = el('button', 'btn small', '+ Frame');
  add.type = 'button';
  add.addEventListener('click', () => { a.steps.push(a.steps[a.steps.length - 1] ?? '{text}'); renderFrames(); timingNote(); changed(); focusLine('#aframes', a.steps.length - 1); });
  addRow.append(add, ins, el('span', 'muted small kbd-hint', 'Enter adds a frame · Alt + ↑/↓ moves it · drag ⋮⋮ to reorder'));
  card.append(addRow);
  main.append(card);

  // Presets
  const presets = el('section', 'card');
  presets.append(el('h3', null, 'Start from a preset'));
  presets.append(el('p', 'muted small', 'Replaces the frames and timing. You can undo it.'));
  const pr = el('div', 'row inline');
  const ps = document.createElement('select');
  for (const [k, v] of Object.entries(ANIM_TEMPLATES)) if (k !== 'blank') ps.append(new Option(v.label, k));
  const apply = el('button', 'btn small', 'Apply');
  apply.type = 'button';
  apply.addEventListener('click', () => {
    const tp = ANIM_TEMPLATES[ps.value];
    a.steps = tp.steps(); a.speed = tp.speed; a.pause = tp.pause;
    renderAnimation(); changed();
  });
  pr.append(ps, apply);
  presets.append(pr);
  main.append(presets);

  timingNote();
  renderAnimPreview();
  renderUsage();
}

function numberSlider(label, help, value, min, max, set) {
  const wrap = el('div', 'num-slider');
  const top = el('div', 'row-between');
  top.append(el('span', 'attr-name', label));
  const r = el('div', 'row inline');
  const range = document.createElement('input');
  range.type = 'range'; range.min = min; range.max = max; range.value = value;
  const n = document.createElement('input');
  n.type = 'number'; n.min = min; n.className = 'narrow'; n.value = value;
  range.addEventListener('input', () => { n.value = range.value; set(+range.value); changed({ coalesce: true }); });
  n.addEventListener('input', () => { const v = parseFloat(n.value); if (!isNaN(v)) { range.value = v; set(v); changed({ coalesce: true }); } });
  r.append(range, n);
  wrap.append(top, el('div', 'muted small', help), r);
  return wrap;
}

function renderAnimPreview() {
  if (!isAnim()) return;
  const a = C();
  S.animOverride = { name: PREVIEW_ANIM, builtin: false, speed: a.speed, pause: a.pause, steps: a.steps };
  const box = $('#apreview');
  box.innerHTML = '';
  const line = el('span', 'mc-text big');
  mcLive(line, `<#ANIM:${PREVIEW_ANIM}>${S.animSample}</#ANIM>`);
  box.append(line);

  const strip = $('#aframes-strip');
  strip.innerHTML = '';
  const cells = a.steps.map((f, i) => {
    const c = el('div', 'frame-cell');
    c.append(el('span', 'frame-no', String(i + 1)));
    const t = el('span', 'mc-text');
    t.append(renderMc(f.split('{text}').join(S.animSample)));
    c.append(t);
    strip.append(c);
    return c;
  });
  TICKERS.clear();
  TICKERS.add(() => {
    if (!isAnim() || !strip.isConnected) { TICKERS.clear(); return; }
    const cur = stepOf(tickNow(), a.steps.length - 1, a.speed, a.pause);
    cells.forEach((c, i) => c.classList.toggle('on', i === cur));
  });
  $('#anim-loop').textContent = loopText(a);
}

function renderUsage() {
  const name = C().name || 'name';
  $('#anim-snippet').textContent = `<#ANIM:${name}>Your text</#ANIM>`;
  const used = $('#anim-used');
  used.innerHTML = '';
  if (S.edit.original === null) { used.append(el('p', 'muted small', 'Save it to use it in game.')); return; }
  if (!S.edit.usedIn.length) { used.append(el('p', 'muted small', 'Not used in any hologram or display yet.')); return; }
  used.append(el('p', 'muted small', 'Used in:'));
  const ul = el('ul', 'used-list');
  for (const u of S.edit.usedIn) {
    const li = el('li');
    const b = el('button', 'linkish', `${u.name}`);
    b.type = 'button';
    b.prepend(el('span', 'type-pill', u.kind === 'hologram' ? 'HOLO' : 'DISPLAY'));
    b.addEventListener('click', () => openItem(u.kind, u.name));
    li.append(b);
    ul.append(li);
  }
  used.append(ul);
}

$('#anim-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#anim-snippet').textContent); toast('Copied.'); }
  catch { toast('Couldn\'t copy. Select the text and copy it yourself.', true); }
});

// ------------------------------------------------------------------ YAML

async function loadYaml() {
  const ta = $('#yaml');
  const kind = S.edit ? S.edit.kind : 'hologram';
  $('#yaml-help').textContent = {
    hologram: 'The hologram\'s file in plugins/DecentHolograms/holograms. Saving here replaces the whole file. If DecentHolograms rejects it, the old file is kept.',
    display: 'The display\'s file in plugins/DecentHolograms/displays. Saving here replaces the whole file and reloads displays. If DecentHolograms rejects it, the old file is kept.',
    animation: 'The animation\'s file in plugins/DecentHolograms/animations: speed, pause and steps (the frames). Saving here replaces the whole file and reloads animations.',
  }[kind];
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

/** Renders Minecraft/DecentHolograms formatting: &codes, &#hex, <#hex>, {#hex}, gradients and placeholders. */
function renderMc(text) {
  const frag = document.createDocumentFragment();
  const reset = () => ({ color: '#FFFFFF', b: false, i: false, u: false, s: false, k: false });
  let style = reset();

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
    if (cls) span.classList.add(cls);
    frag.append(span);
  };

  const re = /&#([0-9a-f]{6})|\{#([0-9a-f]{6})\}|<#([0-9a-f]{6})>|[&§]([0-9a-fk-or])|(%[A-Za-z0-9_:.\-]+%|\{player\}|\{text\})/gi;
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
    if (m[5]) push(m[5] === '{player}' ? 'Steve' : m[5], m[5] === '{player}' ? null : 'mc-ph');
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
