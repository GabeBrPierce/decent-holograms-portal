#!/usr/bin/env node
// Builds src/main/resources/web/icons.json: how to draw every Minecraft item in the asset picker.
//
//   node tools/gen-icons.mjs [minecraftVersion]      (default 26.3)
//
// Reads the vanilla assets from https://github.com/InventivetalentDev/minecraft-assets (the data behind
// mcasset.cloud), follows each item's model chain and records either a flat sprite (most items) or the
// three visible faces of a cube (most blocks). Textures are loaded at runtime from assets.mcasset.cloud.
// Re-run it when the server moves to a new Minecraft version.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const version = process.argv[2] || '26.3';
const RAW = `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${version}/assets/minecraft`;
const get = async (p) => {
  const res = await fetch(`${RAW}/${p}`);
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return res.json();
};

const [items, blockModels, itemModels, itemTex, blockTex, lang] = await Promise.all([
  get('items/_all.json'), get('models/block/_all.json'), get('models/item/_all.json'),
  get('textures/item/_list.json'), get('textures/block/_list.json'), get('lang/en_us.json'),
]);
const textures = new Set([
  ...itemTex.files.filter((f) => f.endsWith('.png')).map((f) => 'item/' + f.slice(0, -4)),
  ...blockTex.files.filter((f) => f.endsWith('.png')).map((f) => 'block/' + f.slice(0, -4)),
]);

// Newer models can give a texture as { sprite: "..." } instead of a plain string.
const strip = (ref) => (ref && typeof ref === 'object' ? ref.sprite || '' : ref || '').replace(/^minecraft:/, '');
function model(ref) {
  const r = strip(ref);
  if (r.startsWith('block/')) return blockModels[r.slice(6)];
  if (r.startsWith('item/')) return itemModels[r.slice(5)];
  return null;
}

/** Follows parents; returns the merged textures and the chain of model names. */
function resolve(ref) {
  const chain = [];
  const tex = {};
  let r = strip(ref);
  for (let i = 0; r && i < 20; i++) {
    chain.push(r);
    const m = model(r);
    if (!m) break;
    for (const [k, v] of Object.entries(m.textures || {})) if (!(k in tex)) tex[k] = v;
    r = strip(m.parent);
  }
  // Resolve "#name" references.
  const look = (v, depth = 0) => (typeof v === 'string' && v.startsWith('#') && depth < 10 ? look(tex[v.slice(1)], depth + 1) : v);
  const out = {};
  for (const k of Object.keys(tex)) {
    const v = strip(look(tex[k]));
    if (v && !v.startsWith('#')) out[k] = v;
  }
  return { chain, tex: out };
}

/** The model an item definition shows by default (skipping select/condition/range cases). */
function baseModel(node) {
  if (!node || typeof node !== 'object') return null;
  switch (strip(node.type)) {
    case 'model': return { ref: node.model };
    case 'special': return { ref: node.base, special: strip(node.model && node.model.type) };
    case 'select': return baseModel(node.fallback) || baseModel(node.cases && node.cases[0] && node.cases[0].model);
    case 'condition': return baseModel(node.on_false) || baseModel(node.on_true);
    case 'range_dispatch': return baseModel(node.fallback) || baseModel(node.entries && node.entries[0] && node.entries[0].model);
    case 'composite': return baseModel(node.models && node.models[0]);
    case 'bundle/selected_item': return null;
    default: return null;
  }
}

const has = (t) => t && textures.has(t);
const first = (...c) => c.find(has);

const out = {};
let flat = 0, cube = 0, none = 0;
for (const [id, def] of Object.entries(items)) {
  const name = lang[`item.minecraft.${id}`] || lang[`block.minecraft.${id}`] || id;
  const base = baseModel(def.model);
  let icon = { n: name };
  const SKULLS = { player_head: 'MHF_Steve', creeper_head: 'MHF_Creeper', zombie_head: 'MHF_Zombie', skeleton_skull: 'MHF_Skeleton', wither_skeleton_skull: 'MHF_WSkeleton', piglin_head: 'MHF_Pig', dragon_head: 'MHF_Enderman' };
  const bed = id.match(/^(\w+)_bed$/);
  if (base && base.special) {
    // Special models (chests, heads, shields, tridents...) have no textures of their own to resolve.
    if (SKULLS[id]) { icon.h = SKULLS[id]; out[id] = icon; flat++; continue; }
    if (has('item/' + id)) { icon.f = 'item/' + id; out[id] = icon; flat++; continue; }
    if (bed && has(`block/${bed[1]}_wool`)) { icon.c = Array(3).fill(`block/${bed[1]}_wool`); out[id] = icon; cube++; continue; }
  }
  if (base && base.ref) {
    const { chain, tex } = resolve(base.ref);
    const isItem = chain.some((c) => c === 'item/generated' || c.startsWith('item/handheld') || c === 'builtin/generated');
    if (isItem && has(tex.layer0)) {
      icon.f = tex.layer0;                          // flat sprite
      flat++;
    } else if (!isItem && Object.keys(tex).length) {
      const top = first(tex.up, tex.top, tex.end, tex.all, tex.texture, tex.wall, tex.cross, tex.plant, tex.particle);
      const side = first(tex.east, tex.side, tex.all, tex.texture, tex.wall, tex.cross, tex.plant, tex.particle, top);
      const front = first(tex.north, tex.front, tex.south, tex.side, tex.all, tex.texture, tex.wall, tex.cross, tex.particle, side);
      const crossy = chain.some((c) => /cross|tinted_cross|flower_pot_cross|seagrass|crop/.test(c));
      if (crossy && has(tex.cross || tex.plant)) { icon.f = tex.cross || tex.plant; flat++; }
      else if (top || side) { icon.c = [top || side, side || top, front || side || top]; cube++; } // top, left, right
      else none++;
    } else {
      none++;
    }
    if (!icon.f && !icon.c && has(tex.particle)) { icon.c = [tex.particle, tex.particle, tex.particle]; cube++; none--; }
  } else {
    none++;
  }
  // A plain item texture with the item's own name beats anything odd we resolved (e.g. special models).
  if (!icon.f && !icon.c && has('item/' + id)) { icon.f = 'item/' + id; flat++; none--; }
  // A "cube" made of item textures is really a 3D item model: show it flat.
  if (icon.c && icon.c.every((t) => t.startsWith('item/'))) { icon.f = has('item/' + id) ? 'item/' + id : icon.c[0]; delete icon.c; }
  const banner = id.match(/^(\w+)_(wall_)?banner$/);
  if (banner && has(`block/${banner[1]}_wool`)) { delete icon.f; icon.c = Array(3).fill(`block/${banner[1]}_wool`); }
  out[id] = icon;
}

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'resources', 'web', 'icons.json');
await writeFile(dest, JSON.stringify({ version, base: `https://assets.mcasset.cloud/${version}/assets/minecraft/textures/`, items: out }));
console.log(`${Object.keys(out).length} items: ${flat} flat, ${cube} cubes, ${none} without an icon -> ${dest}`);
