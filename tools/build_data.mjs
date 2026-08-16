#!/usr/bin/env node
/**
 * build_data.mjs —— piki 本地数据库生成器（维护用，非运行时）
 *
 * 为什么需要它：@smogon/calc 自带的数据是「够算伤害」的，不是百科式的——
 * 它的 species 只带特性槽 0（阿罗拉九尾只有雪隐、丢了降雪），moves 没有命中/PP/优先度/说明。
 * 所以查询能力必须另有数据源。这里用 Pokémon Showdown 的原始数据（权威、竞技向、
 * 每天跟版）+ PokeAPI 的多语言名称表（中文名），生成一份精简的本地库提交入库。
 *
 * 运行时（pokedb.mjs）只读这些 JSON，不需要网络、不需要额外 npm 包。
 *
 * 用法：
 *   node tools/build_data.mjs [--out <dir>] [--cache <dir>] [--offline]
 *
 * --offline 用已下载的缓存重建（调试用，不联网）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const OUT_DIR = path.resolve(getArg('--out', path.join(SKILL_DIR, 'data')));
const CACHE_DIR = path.resolve(getArg('--cache', path.join(SKILL_DIR, '.build-cache')));
const OFFLINE = args.includes('--offline');

const PS = 'https://play.pokemonshowdown.com/data';
const POKEAPI = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv';

// PokeAPI languages.csv: 12 = zh-hans（简体）, 4 = zh-hant（繁体）, 11 = ja（日文汉字）, 9 = en
const LANG_ZH = '12';
const LANG_ZH2 = '4';   // 回退用
const LANG_JA = '11';
const LANG_EN = '9';

const SOURCES = [
  { key: 'pokedex', url: `${PS}/pokedex.json`, kind: 'json' },
  { key: 'moves', url: `${PS}/moves.json`, kind: 'json' },
  { key: 'learnsets', url: `${PS}/learnsets.json`, kind: 'json' },
  { key: 'abilities', url: `${PS}/abilities.js`, kind: 'psjs', varName: 'BattleAbilities' },
  { key: 'items', url: `${PS}/items.js`, kind: 'psjs', varName: 'BattleItems' },
  { key: 'species_names', url: `${POKEAPI}/pokemon_species_names.csv`, kind: 'csv' },
  { key: 'move_names', url: `${POKEAPI}/move_names.csv`, kind: 'csv' },
  { key: 'ability_names', url: `${POKEAPI}/ability_names.csv`, kind: 'csv' },
  { key: 'item_names', url: `${POKEAPI}/item_names.csv`, kind: 'csv' },
  { key: 'type_names', url: `${POKEAPI}/type_names.csv`, kind: 'csv' },
];

// ---------------------------------------------------------------- 工具

const log = (...m) => console.log(...m);

async function fetchCached(src) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const ext = src.kind === 'csv' ? 'csv' : src.kind === 'psjs' ? 'js' : 'json';
  const file = path.join(CACHE_DIR, `${src.key}.${ext}`);
  if (OFFLINE) return fs.readFile(file, 'utf8');
  try {
    const res = await fetch(src.url, { headers: { 'User-Agent': 'piki-build/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    await fs.writeFile(file, text, 'utf8');
    log(`  ✓ ${src.key.padEnd(16)} ${(text.length / 1024).toFixed(0)} KB`);
    return text;
  } catch (e) {
    log(`  ! ${src.key} 下载失败 (${e.message})，尝试用缓存`);
    return fs.readFile(file, 'utf8');
  }
}

/** Showdown 的 .js 数据文件形如 `exports.BattleAbilities = {...};` —— 剥出对象字面量再求值。
 *  这些文件含函数（onModifyMove 等），JSON.parse 处理不了，只能走 Function 求值。
 *  数据来自固定的官方域名，且我们只取其中的纯数据字段。 */
function parsePsJs(text, varName) {
  const marker = `exports.${varName} = `;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`找不到 exports.${varName}`);
  const body = text.slice(start + marker.length);
  return new Function(`"use strict"; return (${body.replace(/;\s*$/, '')});`)();
}

/** 最小 CSV 解析（支持带引号字段与字段内逗号）。 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter(r => r.length === header.length)
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const toId = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// ---------------------------------------------------------------- 形态中文名

/**
 * PokeAPI 只给「基础种族」的中文名（九尾），不给形态名（阿罗拉九尾）。
 * 中文玩家写形态名的方式是高度规则化的前后缀，所以在这里显式建表生成，
 * 比去 PokeAPI 的 form 表里翻要可靠得多，也更贴近实际叫法。
 */
const FORME_ZH = {
  'Alola': p => `阿罗拉${p}`,
  'Galar': p => `伽勒尔${p}`,
  'Hisui': p => `洗翠${p}`,
  'Paldea': p => `帕底亚${p}`,
  'Paldea-Combat': p => `帕底亚${p}（斗战）`,
  'Paldea-Blaze': p => `帕底亚${p}（火焰）`,
  'Paldea-Aqua': p => `帕底亚${p}（水澜）`,
  'Mega': p => `超级${p}`,
  'Mega-X': p => `超级${p}X`,
  'Mega-Y': p => `超级${p}Y`,
  'Primal': p => `原始${p}`,
  'Gmax': p => `超极巨${p}`,
  'Eternamax': p => `无极巨${p}`,
  'Origin': p => `起源形态${p}`,
  'Therian': p => `灵兽形态${p}`,
  'Incarnate': p => `化身形态${p}`,
  'Sky': p => `天空形态${p}`,
  'Attack': p => `攻击形态${p}`,
  'Defense': p => `防御形态${p}`,
  'Speed': p => `速度形态${p}`,
  'Zen': p => `达摩模式${p}`,
  'Crowned': p => `王者${p}`,
  'Hero': p => `勇士形态${p}`,
  'Rapid-Strike': p => `连击流${p}`,
  'Single-Strike': p => `一击流${p}`,
  'Ice': p => `白马${p}`,
  'Shadow': p => `黑马${p}`,
  'Dawn-Wings': p => `暮鬃${p}`,
  'Dusk-Mane': p => `黄昏之鬃${p}`,
  'Ultra': p => `究极${p}`,
  'Blade': p => `刃形态${p}`,
  'Shield': p => `盾形态${p}`,
  'Wellspring': p => `水井面具${p}`,
  'Hearthflame': p => `火灶面具${p}`,
  'Cornerstone': p => `础石面具${p}`,
  'Teal': p => `碧草面具${p}`,
  'Terastal': p => `太晶${p}`,
  'Stellar': p => `星晶${p}`,
  'Bloodmoon': p => `血月${p}`,
  'Family-Of-Three': p => `三只家族${p}`,
  'Family-Of-Four': p => `四只家族${p}`,
  'Four': p => `四只${p}`,
  'Three': p => `三只${p}`,
};

/**
 * 按「种族:形态」精确指定的中文名。
 * 需要它的原因：同一个形态词在不同种族里译法不同（Kyurem-Black 是「暗黑酋雷姆」，
 * 但 Basculin-Blue-Striped 是「蓝条纹野蛮鲈鱼」），只按形态词全局套会造出错名。
 * 只收竞技环境里真会用到的，其余走「基础名（English）」的诚实回退。
 */
const FORME_ZH_BY_SPECIES = {
  'Rotom:Heat': '加热洛托姆',
  'Rotom:Wash': '清洗洛托姆',
  'Rotom:Frost': '结冰洛托姆',
  'Rotom:Fan': '旋转洛托姆',
  'Rotom:Mow': '切割洛托姆',
  'Kyurem:Black': '暗黑酋雷姆',
  'Kyurem:White': '焰白酋雷姆',
  'Lycanroc:Midnight': '黑夜鬃岩狼人',
  'Lycanroc:Dusk': '黄昏鬃岩狼人',
  'Basculin:Blue-Striped': '蓝条纹野蛮鲈鱼',
  'Basculin:White-Striped': '白条纹野蛮鲈鱼',
  'Toxtricity:Low-Key': '低调形态颤弦蝾螈',
  'Mimikyu:Busted': '现形谜拟Q',
  'Eiscue:Noice': '解冻头冰砌鹅',
  'Morpeko:Hangry': '空腹模式莫鲁贝可',
  'Wishiwashi:School': '鱼群弱丁鱼',
  'Minior:Meteor': '陨石小陨星',
  'Cherrim:Sunshine': '阳光形态樱花儿',
  'Darmanitan:Galar-Zen': '伽勒尔达摩狒狒（达摩模式）',
  'Zygarde:10%': '10%形态基格尔德',
  'Zygarde:Complete': '完全体形态基格尔德',
  'Hoopa:Unbound': '解放形态胡帕',
  'Keldeo:Resolute': '觉悟形态凯路迪欧',
  'Meloetta:Pirouette': '舞步形态美洛耶塔',
  'Greninja:Ash': '小智版甲贺忍蛙',
  'Dudunsparce:Three-Segment': '三节坚果哑铃',
  'Gimmighoul:Roaming': '徒步形态索财灵',
  'Wormadam:Sandy': '沙土蓑衣虫',
  'Wormadam:Trash': '垃圾蓑衣虫',
};

function formeZhName(baseZh, forme, baseName) {
  if (!baseZh || !forme) return null;
  const exact = FORME_ZH_BY_SPECIES[`${baseName}:${forme}`];
  if (exact) return exact;
  const fn = FORME_ZH[forme];
  if (fn) return fn(baseZh);
  // 未建表的形态：拼成「基础名（形态英文）」，明确是回退而非编造
  return `${baseZh}（${forme}）`;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  log('piki 数据库构建\n');
  log(`来源：Pokémon Showdown + PokeAPI`);
  log(`输出：${OUT_DIR}\n`);

  log('下载：');
  const raw = {};
  for (const src of SOURCES) {
    const text = await fetchCached(src);
    raw[src.key] =
      src.kind === 'json' ? JSON.parse(text)
      : src.kind === 'psjs' ? parsePsJs(text, src.varName)
      : parseCsv(text);
  }

  // ---- 名称索引：英文名(归一化) -> {zh, ja}
  const buildNameIdx = (rows, idCol, nameCol = 'name') => {
    const byLocalId = new Map();
    for (const r of rows) {
      const key = r[idCol];
      if (!byLocalId.has(key)) byLocalId.set(key, {});
      const lang = r.local_language_id;
      if (lang === LANG_ZH) byLocalId.get(key).zh = r[nameCol];
      else if (lang === LANG_ZH2) byLocalId.get(key).zh2 = r[nameCol];
      else if (lang === LANG_JA) byLocalId.get(key).ja = r[nameCol];
      else if (lang === LANG_EN) byLocalId.get(key).en = r[nameCol];
    }
    const byEn = new Map();
    for (const v of byLocalId.values()) {
      // zh-hans 缺失时回退 zh-hant：PokeAPI 的简体表滞后于最新世代，
      // 但它的「繁体」列对新招式其实存的就是标准简体名（冰旋、盐腌、淘金潮…），
      // 不回退的话第九世代的主流招式会有 70 个查不到中文名。
      if (v.en) byEn.set(toId(v.en), { zh: v.zh || v.zh2 || null, ja: v.ja || null });
    }
    return byEn;
  };

  const spNames = buildNameIdx(raw.species_names, 'pokemon_species_id');
  const mvNames = buildNameIdx(raw.move_names, 'move_id');
  const abNames = buildNameIdx(raw.ability_names, 'ability_id');
  const itNames = buildNameIdx(raw.item_names, 'item_id');
  const tyNames = buildNameIdx(raw.type_names, 'type_id');

  const stats = { species: [0, 0], moves: [0, 0], abilities: [0, 0], items: [0, 0], types: [0, 0] };
  const track = (k, hasZh) => { stats[k][1]++; if (hasZh) stats[k][0]++; };

  // ---- species
  const species = {};
  for (const [id, s] of Object.entries(raw.pokedex)) {
    if (!s.baseStats || !s.types) continue;                 // CAP / 占位条目
    const baseName = s.baseSpecies || s.name;
    const base = spNames.get(toId(baseName));
    const zh = s.forme ? formeZhName(base?.zh, s.forme, baseName) : (base?.zh || null);
    const ja = s.forme ? (base?.ja ? `${base.ja}(${s.forme})` : null) : (base?.ja || null);
    track('species', !!zh);
    species[id] = {
      name: s.name, num: s.num, zh, ja,
      types: s.types,
      bs: [s.baseStats.hp, s.baseStats.atk, s.baseStats.def, s.baseStats.spa, s.baseStats.spd, s.baseStats.spe],
      ab: s.abilities || {},
      w: s.weightkg ?? null,
      ...(s.baseSpecies ? { baseSpecies: s.baseSpecies } : {}),
      ...(s.forme ? { forme: s.forme } : {}),
      ...(s.otherFormes ? { otherFormes: s.otherFormes } : {}),
      ...(s.prevo ? { prevo: s.prevo } : {}),
      ...(s.evos ? { evos: s.evos } : {}),
      ...(s.isNonstandard ? { nonstandard: s.isNonstandard } : {}),
      ...(s.requiredItem ? { requiredItem: s.requiredItem } : {}),
    };
  }

  // ---- moves
  const moves = {};
  for (const [id, m] of Object.entries(raw.moves)) {
    if (!m.name || m.num == null) continue;
    const n = mvNames.get(toId(m.name));
    track('moves', !!n?.zh);
    moves[id] = {
      name: m.name, num: m.num, zh: n?.zh || null, ja: n?.ja || null,
      type: m.type, cat: m.category,
      bp: m.basePower ?? 0,
      acc: m.accuracy === true ? '—' : m.accuracy,
      pp: m.pp ?? null,
      pri: m.priority ?? 0,
      target: m.target || 'normal',
      flags: Object.keys(m.flags || {}),
      desc: m.shortDesc || m.desc || '',
      ...(m.isNonstandard ? { nonstandard: m.isNonstandard } : {}),
    };
  }

  // ---- abilities
  const abilities = {};
  for (const [id, a] of Object.entries(raw.abilities)) {
    if (!a.name) continue;
    const n = abNames.get(toId(a.name));
    track('abilities', !!n?.zh);
    abilities[id] = {
      name: a.name, num: a.num ?? null, zh: n?.zh || null, ja: n?.ja || null,
      desc: a.shortDesc || a.desc || '',
      ...(a.rating != null ? { rating: a.rating } : {}),
      ...(a.isNonstandard ? { nonstandard: a.isNonstandard } : {}),
    };
  }

  // ---- items
  const items = {};
  for (const [id, it] of Object.entries(raw.items)) {
    if (!it.name) continue;
    const n = itNames.get(toId(it.name));
    track('items', !!n?.zh);
    items[id] = {
      name: it.name, num: it.num ?? null, zh: n?.zh || null, ja: n?.ja || null,
      desc: it.shortDesc || it.desc || '',
      ...(it.megaStone ? { megaStone: it.megaStone } : {}),
      ...(it.itemUser ? { itemUser: it.itemUser } : {}),
      ...(it.isNonstandard ? { nonstandard: it.isNonstandard } : {}),
    };
  }

  // ---- types（含相性表）
  // 相性表从 @smogon/calc 取——它是运行时就已经装好的依赖，且是竞技圈的权威实现。
  // 烘进 types.json 的原因：pokedb.mjs 的查询能力必须在 node_modules 缺失时依然可用。
  let effChart = null;
  try {
    const calcPath = pathToFileURL(
      path.join(SKILL_DIR, 'scripts', 'node_modules', '@smogon', 'calc', 'dist', 'index.js')
    ).href;
    const { Generations } = await import(calcPath);
    const g9 = Generations.get(9);
    effChart = {};
    for (const t of g9.types) effChart[toId(t.name)] = t.effectiveness;
    log('  ✓ 相性表来自 @smogon/calc');
  } catch (e) {
    log(`  ! 取不到 @smogon/calc 相性表 (${e.message})；types.json 将只含名称`);
  }

  const types = {};
  for (const [en, n] of tyNames.entries()) {
    if (['shadow', 'unknown'].includes(en)) continue;
    track('types', !!n.zh);
    types[en] = { name: en, zh: n.zh || null, ja: n.ja || null };
    // effectiveness[X] = 「本属性攻击 X 属性」的倍率
    if (effChart?.[en]) {
      types[en].atk = Object.fromEntries(
        Object.entries(effChart[en])
          .filter(([k]) => k && k !== '???' && k !== 'Stellar')
          .map(([k, v]) => [toId(k), v])
      );
    }
  }

  // ---- learnsets：压成 种族id -> [招式id]（跨世代并集）
  // 用途只有「这只能不能学这招」的合法性核对，不需要保留世代/来源明细，
  // 并集能把 3.2 MB 压到几百 KB。
  const learnsets = {};
  for (const [id, entry] of Object.entries(raw.learnsets)) {
    if (!entry?.learnset) continue;
    const list = Object.keys(entry.learnset).filter(mv => moves[mv]);
    if (list.length) learnsets[id] = list;
  }

  // ---- 输出
  await fs.mkdir(OUT_DIR, { recursive: true });
  const write = async (file, obj) => {
    const p = path.join(OUT_DIR, file);
    await fs.writeFile(p, JSON.stringify(obj), 'utf8');
    const kb = ((await fs.stat(p)).size / 1024).toFixed(0);
    log(`  ${file.padEnd(18)} ${String(Object.keys(obj).length).padStart(6)} 条  ${kb.padStart(6)} KB`);
    return Number(kb);
  };

  log('\n输出：');
  let total = 0;
  total += await write('species.json', species);
  total += await write('moves.json', moves);
  total += await write('abilities.json', abilities);
  total += await write('items.json', items);
  total += await write('types.json', types);
  total += await write('learnsets.json', learnsets);

  const meta = {
    generated_at: new Date().toISOString().slice(0, 10),
    sources: {
      showdown: PS,
      pokeapi: POKEAPI,
    },
    counts: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v[1]])),
    zh_coverage: Object.fromEntries(
      Object.entries(stats).map(([k, [got, all]]) => [k, `${got}/${all} (${(got / all * 100).toFixed(1)}%)`])
    ),
    note: '本库为主系列（Showdown）数据。Champions 的规则差异见 champions-rules.json；'
        + '本库查不到的条目应走 web 源，不要用近似值顶替。',
  };
  await fs.writeFile(path.join(OUT_DIR, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  log(`\n中文名覆盖率：`);
  for (const [k, [got, all]] of Object.entries(stats)) {
    const pct = (got / all * 100).toFixed(1);
    const flag = pct < 90 ? '  ← 偏低，缺失项将回退英文名' : '';
    log(`  ${k.padEnd(10)} ${String(got).padStart(5)}/${String(all).padEnd(5)} ${pct.padStart(5)}%${flag}`);
  }
  log(`\n合计 ${total} KB。完成。`);
}

main().catch(e => { console.error('构建失败：', e); process.exit(1); });
