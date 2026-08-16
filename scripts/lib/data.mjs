/**
 * data.mjs —— 本地库加载 + 中/日/英名称解析
 *
 * pokedb.mjs 与 calc.mjs 共用这一层。名称解析是每一次查询的第一步，
 * 而用户全程用中文、形近名极多（九尾/阿罗拉九尾、超级喷火龙X/Y、
 * 一击流/连击流武道熊师），所以这里宁可返回「有歧义」也不擅自替用户选一个。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(SKILL_DIR, 'data');

function load(file, optional = false) {
  const p = path.join(DATA_DIR, file);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (optional) return {};
    console.error(`FATAL 读不到 ${p} —— 请先运行 node tools/build_data.mjs 生成本地库`);
    process.exit(4);
  }
}

export const DB = {
  species: load('species.json'),
  moves: load('moves.json'),
  abilities: load('abilities.json'),
  items: load('items.json'),
  types: load('types.json'),
  learnsets: load('learnsets.json'),
  meta: load('_meta.json', true),
  aliases: load('aliases.zh.json', true),
};

export const KINDS = ['species', 'moves', 'abilities', 'items', 'types'];

// 显示名覆盖：PokeAPI 的中文名有缺漏也偶有争议，
// 让用户能在 aliases.zh.json 里直接改名字，而不必重建整个数据库。
// 必须在建索引之前应用，覆盖后的名字才能被搜到。
for (const [kind, table] of Object.entries(DB.aliases.zh_names || {})) {
  if (!DB[kind]) continue;
  for (const [id, zh] of Object.entries(table)) {
    if (DB[kind][id]) DB[kind][id].zh = zh;
  }
}

// ------------------------------------------------------------ 归一化

/** 全角 → 半角，并去掉中文常见的装饰性符号。 */
function toHalfWidth(s) {
  return s.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
          .replace(/　/g, ' ');
}

/**
 * 少量繁→简映射：只收竞技场景里真会被打出来的字。
 * 全量繁简转换需要额外依赖，收益不成比例；漏掉的走模糊匹配兜底。
 */
const T2S = {
  '龍':'龙','獸':'兽','燄':'焰','劍':'剑','鋼':'钢','電':'电','靈':'灵','夢':'梦','寶':'宝',
  '陽':'阳','風':'风','蟲':'虫','葉':'叶','樹':'树','鳥':'鸟','馬':'马','魚':'鱼','貓':'猫',
  '獅':'狮','蝦':'虾','蟹':'蟹','蛺':'蛱','壺':'壶','鐵':'铁','銀':'银','鑽':'钻','雞':'鸡',
  '狽':'狈','鴉':'鸦','蠍':'蝎','鱷':'鳄','鯊':'鲨','鰭':'鳍','驢':'驴','駝':'驼','蘭':'兰',
  '藥':'药','絲':'丝','線':'线','紋':'纹','綠':'绿','紅':'红','藍':'蓝','聖':'圣','戰':'战',
  '擊':'击','術':'术','護':'护','衛':'卫','鬥':'斗','門':'门','關':'关','開':'开','間':'间',
  '雙':'双','單':'单','種':'种','類':'类','體':'体','數':'数','發':'发','導':'导','爆':'爆',
  '氷':'冰','歸':'归','來':'来','個':'个','過':'过','蓮':'莲','薔':'蔷','薇':'薇','鬃':'鬃',
};

function t2s(s) {
  let out = '';
  for (const c of s) out += T2S[c] || c;
  return out;
}

/** 拉丁文本归一化到 Showdown id 风格；CJK 保留字符本身。 */
export function norm(s) {
  const x = t2s(toHalfWidth(String(s || '')).trim().toLowerCase());
  // 去掉分隔符与装饰括号，但保留 CJK / 拉丁 / 数字
  return x.replace(/[\s\-_.·・'’"“”()（）[\]【】,，、：:]/g, '');
}

// ------------------------------------------------------------ 索引

/** kind -> Map(归一化名 -> Set(id))，同名多义时保留全部候选。 */
const INDEX = {};

function addKey(map, key, id) {
  if (!key) return;
  const k = norm(key);
  if (!k) return;
  if (!map.has(k)) map.set(k, new Set());
  map.get(k).add(id);
}

for (const kind of KINDS) {
  const map = new Map();
  for (const [id, rec] of Object.entries(DB[kind])) {
    addKey(map, id, id);
    addKey(map, rec.name, id);
    addKey(map, rec.zh, id);
    addKey(map, rec.ja, id);
  }
  // 手工别名（俗称/缩写）优先级最高，直接注入同一张表
  for (const [alias, target] of Object.entries(DB.aliases[kind] || {})) {
    if (DB[kind][target]) addKey(map, alias, target);
  }
  INDEX[kind] = map;
}

// ------------------------------------------------------------ 模糊匹配

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 0..1 相似度。
 *
 * 单靠编辑距离对中文很差：中文名字短，错一个字就掉一大截分
 * （「喷射火尤」vs「喷火龙」编辑距离相似度只有 0.25，会直接查不到）。
 * 所以再算一个字符重合度（Dice 系数）并取两者较大值——中文靠重合度，
 * 英文靠编辑距离，各自发挥所长。
 */
function similarity(a, b) {
  const m = Math.max(a.length, b.length);
  if (m === 0) return 1;
  const lev = 1 - levenshtein(a, b) / m;

  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter++;
  const dice = (2 * inter) / (sa.size + sb.size);

  return Math.max(lev, dice);
}

// ------------------------------------------------------------ 解析

/**
 * 解析一个名字到 id。
 * 返回 {ok:true, id, rec} | {ok:false, reason:'ambiguous', candidates} | {ok:false, reason:'notfound', suggestions}
 *
 * 阶梯：精确 → 唯一前缀 → 唯一子串 → 模糊。
 * 任何一档出现多个势均力敌的候选就报 ambiguous，交给调用方（Claude）消歧——
 * 静默选第一个正是「阿罗拉九尾被当成九尾」这类错误的来源。
 */
export function resolve(kind, raw) {
  const map = INDEX[kind];
  const q = norm(raw);
  if (!q) return { ok: false, reason: 'notfound', query: raw, suggestions: [] };

  const pack = ids => [...ids].map(id => ({ id, rec: DB[kind][id] }));

  // 1) 精确
  if (map.has(q)) {
    const hit = pack(map.get(q));
    if (hit.length === 1) return { ok: true, ...hit[0] };
    return { ok: false, reason: 'ambiguous', query: raw, candidates: hit };
  }

  // 2) 唯一前缀
  const pre = [];
  for (const [k, ids] of map) if (k.startsWith(q)) pre.push(...pack(ids));
  const dedup = arr => {
    const seen = new Set();
    return arr.filter(c => !seen.has(c.id) && seen.add(c.id));
  };
  const preU = dedup(pre);
  if (preU.length === 1) return { ok: true, ...preU[0] };
  if (preU.length > 1 && preU.length <= 8) {
    return { ok: false, reason: 'ambiguous', query: raw, candidates: preU };
  }

  // 3) 唯一子串
  const sub = [];
  for (const [k, ids] of map) if (k.includes(q)) sub.push(...pack(ids));
  const subU = dedup(sub);
  if (subU.length === 1) return { ok: true, ...subU[0] };
  if (subU.length > 1 && subU.length <= 8) {
    return { ok: false, reason: 'ambiguous', query: raw, candidates: subU };
  }

  // 4) 模糊
  const scored = [];
  for (const [k, ids] of map) {
    const s = similarity(q, k);
    if (s >= 0.55) for (const id of ids) scored.push({ id, rec: DB[kind][id], score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = dedup(scored).slice(0, 6);
  if (!best.length) return { ok: false, reason: 'notfound', query: raw, suggestions: [] };
  // 头名明显领先才自动采纳；否则让调用方选
  if (best.length === 1 || best[0].score - best[1].score > 0.12) {
    if (best[0].score >= 0.8) return { ok: true, id: best[0].id, rec: best[0].rec, fuzzy: true };
  }
  return { ok: false, reason: 'notfound', query: raw, suggestions: best };
}

/** 把多个 argv 词按「能整体解析就整体，否则逐词」拆成实体列表。
 *  支持 `node pokedb.mjs mon Flutter Mane` 这种带空格的英文名。 */
export function resolveAll(kind, words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    let matched = null;
    // 贪心：先试最长的组合，让「Flutter Mane」这类带空格的英文名能整体命中。
    // 但多词短语只认精确/前缀/子串命中——若允许模糊命中，
    // 「威吓 古代活性」会被整体模糊匹配成「古代活性」，把前一个词悄悄吃掉。
    for (let j = Math.min(words.length, i + 4); j > i + 1; j--) {
      const phrase = words.slice(i, j).join(' ');
      const r = resolve(kind, phrase);
      if (r.ok && !r.fuzzy) { matched = { r, next: j }; break; }
    }
    if (matched) { out.push({ query: words.slice(i, matched.next).join(' '), ...matched.r }); i = matched.next; }
    else { out.push({ query: words[i], ...resolve(kind, words[i]) }); i++; }
  }
  return out;
}

// ------------------------------------------------------------ 展示helper

export const zhType = en => DB.types[String(en || '').toLowerCase()]?.zh || en;
export const zhTypes = arr => (arr || []).map(zhType).join('/');

export function zhAbility(enName) {
  const r = resolve('abilities', enName);
  return r.ok ? (r.rec.zh || r.rec.name) : enName;
}

export function zhMove(enNameOrId) {
  const r = resolve('moves', enNameOrId);
  return r.ok ? (r.rec.zh || r.rec.name) : enNameOrId;
}

export function zhItem(enName) {
  const r = resolve('items', enName);
  return r.ok ? (r.rec.zh || r.rec.name) : enName;
}

/** 统一的显示名：有中文用中文，没有就退英文并标注。 */
export const disp = rec => rec.zh || `${rec.name}(无中文名)`;

/** 候选列表格式化，用于 AMBIGUOUS / NOTFOUND 行。 */
export const fmtCandidates = list =>
  list.map(c => `${c.id}(${c.rec.zh || c.rec.name})`).join(' | ');

export const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_ZH = { hp: 'HP', atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度' };
