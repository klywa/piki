/**
 * rules.mjs —— 各格式的数值模型（努力值 / 个体值 / 性格 / 等级）
 *
 * 为什么要单独一层：Champions 的数值规则和主系列不一样（无个体值、固定 66 点努力值、
 * 有 Mega 无太晶），而这些规则还没有完全被公开资料确认。把它们放进 data/champions-rules.json，
 * 用户发现算得不对时改那个 JSON 就行，不用碰代码；而且每次计算的输出头部都会打印
 * 采用的规则集和它是否已核实，结论因此始终可审计。
 */

import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './data.mjs';

const RULES_PATH = path.join(SKILL_DIR, 'data', 'champions-rules.json');

let CHAMPS;
try {
  CHAMPS = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
} catch {
  CHAMPS = null;
}

/** 主系列（朱紫）模型：508 点努力值、单项上限 252、个体值 0-31、性格 ±10%。 */
const GEN9 = {
  id: 'sv',
  label: '主系列第九世代',
  level: 50,
  iv: { fixed: null, max: 31 },
  ev: { system: 'classic', total: 508, perStatMax: 252 },
  nature: { enabled: true, up: 1.1, down: 0.9 },
  tera: true,
  mega: false,
  verified: true,
  source: 'Pokémon Scarlet/Violet 已知机制',
};

export const FORMATS = {
  'sv-single': { ...GEN9, id: 'sv-single', doubles: false },
  'sv-double': { ...GEN9, id: 'sv-double', doubles: true },
  'vgc': { ...GEN9, id: 'vgc', doubles: true, label: 'VGC 双打' },
  'champs-single': null, // 下面按 champions-rules.json 填充
  'champs-double': null,
};

function buildChampions(doubles) {
  const c = CHAMPS || {};
  const ev = c.ev || {};
  const g = c.gimmicks || {};
  return {
    id: doubles ? 'champs-double' : 'champs-single',
    label: `Pokémon Champions ${doubles ? '双打' : '单打'}`,
    doubles,
    level: c.level?.value ?? 50,
    iv: { fixed: c.ivs?.effective_value ?? 31, max: c.ivs?.effective_value ?? 31 },
    ev: {
      system: ev.system || 'points',
      total: ev.total_points ?? 66,
      perStatMax: ev.per_stat_cap ?? 32,
      pointMode: ev.point_mode || 'champions',
      unit: ev.unit_name || '能力点',
    },
    nature: {
      enabled: c.nature?.exists ?? true,
      up: c.nature?.modifier?.[0] ?? 1.1,
      down: c.nature?.modifier?.[1] ?? 0.9,
    },
    tera: !!g.tera,
    mega: g.mega !== false,
    items: c.items || null,
    statusTweaks: c.status_tweaks || null,
    selection: c.selection || null,
    verified: !!c.verified,
    source: Array.isArray(c.source) ? c.source[0] : c.source || null,
  };
}

FORMATS['champs-single'] = buildChampions(false);
FORMATS['champs-double'] = buildChampions(true);

export const DEFAULT_FORMAT = 'champs-single';

/** 接受 champs / champs-double / sv / vgc / double / single 等写法。 */
export function getFormat(name) {
  if (!name) return FORMATS[DEFAULT_FORMAT];
  const n = String(name).toLowerCase().replace(/[\s_]/g, '-');
  if (FORMATS[n]) return FORMATS[n];
  const alias = {
    'champs': 'champs-single', 'champions': 'champs-single',
    'champs-singles': 'champs-single', 'champs-doubles': 'champs-double',
    'sv': 'sv-single', 'svs': 'sv-single', 'sv-singles': 'sv-single',
    'sv-doubles': 'sv-double', 'vgc-double': 'vgc', 'doubles': 'vgc',
    'singles': 'sv-single', 'single': 'champs-single', 'double': 'champs-double',
  };
  return FORMATS[alias[n]] || null;
}

// ------------------------------------------------------------ 面板计算

const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/**
 * 计算一项能力的最终面板值。
 *
 * @param fmt   getFormat() 的返回
 * @param stat  'hp'|'atk'|...
 * @param base  种族值
 * @param opts  {ev, iv, nature: 1.1|1|0.9, level}
 */
export function calcStat(fmt, stat, base, opts = {}) {
  const level = opts.level ?? fmt.level;
  const iv = fmt.iv.fixed != null ? fmt.iv.fixed : (opts.iv ?? 31);
  const natureMod = fmt.nature.enabled ? (opts.nature ?? 1) : 1;
  const points = opts.ev ?? 0;

  if (fmt.ev.system === 'classic') {
    const evTerm = Math.floor(points / 4);
    if (stat === 'hp') {
      if (base === 1) return 1; // 脱壳忍者
      return Math.floor((2 * base + iv + evTerm) * level / 100) + level + 10;
    }
    return Math.floor((Math.floor((2 * base + iv + evTerm) * level / 100) + 5) * natureMod);
  }

  // Champions 的能力点制（已核实，见 data/champions-rules.json）
  //   HP  ：floor((2*Base + 31) * L/100) + L + 10 + P
  //   其他：floor( (floor((2*Base + 31 + 2*P) * L/100) + 5) * 性格 )
  //
  // 注意点数在括号内以 2P 参与、性格在最后才乘并取整。
  // 若图省事先按性格修正再加点数，几乎每一项加成能力都会差 1~3 ——
  // 而对战里差 1 点面板就可能翻转先手或确定数。
  if (stat === 'hp') {
    if (base === 1) return 1; // 脱壳忍者
    return Math.floor((2 * base + iv) * level / 100) + level + 10 + points;
  }
  return Math.floor((Math.floor((2 * base + iv + 2 * points) * level / 100) + 5) * natureMod);
}

/** 六项一次算完。bs 为 [hp,atk,def,spa,spd,spe]。 */
export function calcAllStats(fmt, bs, spread = {}) {
  const out = {};
  STAT_ORDER.forEach((s, i) => {
    out[s] = calcStat(fmt, s, bs[i], {
      ev: spread.evs?.[s] ?? 0,
      iv: spread.ivs?.[s] ?? 31,
      nature: spread.natureMods?.[s] ?? 1,
      level: spread.level,
    });
  });
  return out;
}

/** 该格式下某项能力的「最大投入」点数（用于 min/max 速度线等）。 */
export function maxInvest(fmt) {
  if (fmt.ev.system === 'classic') return fmt.ev.perStatMax ?? 252;
  return fmt.ev.perStatMax ?? fmt.ev.total;
}

/** 输出头部用的一行规则摘要——让每个数字都能被追溯到它依据的规则。 */
export function ruleBanner(fmt) {
  const parts = [`fmt=${fmt.id}`, `lv=${fmt.level}`];
  if (fmt.ev.system === 'classic') {
    parts.push(`ev=经典508/单项${fmt.ev.perStatMax}`);
  } else {
    parts.push(`ev=${fmt.ev.total}${fmt.ev.unit || '点'}/单项上限${fmt.ev.perStatMax}(1点=+1面板)`);
  }
  parts.push(`iv=${fmt.iv.fixed != null ? `固定${fmt.iv.fixed}` : '0-31'}`);
  parts.push(`性格=${fmt.nature.enabled ? '有' : '无'}`);
  parts.push(`太晶=${fmt.tera ? 'ON' : 'DISABLED'}`);
  if (fmt.mega) parts.push('mega=ON');
  if (fmt.verified === false) parts.push('~规则未核实');
  return parts.join(' ');
}

export { STAT_ORDER };

// ------------------------------------------------------------ 性格

/**
 * 性格表：加成项 → { 下降项: [英文名, 中文名, 日文名] }。
 *
 * 放在 rules.mjs 而不是 calc.mjs，是因为 pokedb.mjs 的面板查询和 calc.mjs 的伤害
 * 必须共用同一份性格/预设定义——两边各存一份迟早会漂移，而漂移出来的是
 * 「同一只宝可梦在两个脚本里速度差 1」这种最难发现的错。
 */
export const NATURE_TABLE = {
  atk: {
    def: ['Lonely', '怕寂寞', 'さみしがり'],
    spa: ['Adamant', '固执', 'いじっぱり'],
    spd: ['Naughty', '顽皮', 'やんちゃ'],
    spe: ['Brave', '勇敢', 'ゆうかん'],
  },
  def: {
    atk: ['Bold', '大胆', 'ずぶとい'],
    spa: ['Impish', '淘气', 'わんぱく'],
    spd: ['Lax', '乐天', 'のうてんき'],
    spe: ['Relaxed', '悠闲', 'のんき'],
  },
  spa: {
    atk: ['Modest', '内敛', 'ひかえめ'],
    def: ['Mild', '慢吞吞', 'おっとり'],
    spd: ['Rash', '马虎', 'うっかりや'],
    spe: ['Quiet', '冷静', 'れいせい'],
  },
  spd: {
    atk: ['Calm', '温和', 'おだやか'],
    def: ['Gentle', '温顺', 'おとなしい'],
    spa: ['Careful', '慎重', 'しんちょう'],
    spe: ['Sassy', '自大', 'なまいき'],
  },
  spe: {
    atk: ['Timid', '胆小', 'おくびょう'],
    def: ['Hasty', '急躁', 'せっかち'],
    spa: ['Jolly', '开朗', 'ようき'],
    spd: ['Naive', '天真', 'むじゃき'],
  },
};

/** 5 个无修正性格。写全，是为了「用户报了个真实存在的性格名、脚本却说不认识」不会发生。 */
const NATURE_NEUTRAL = [
  ['Hardy', '勤奋', 'がんばりや'],
  ['Docile', '坦率', 'すなお'],
  ['Serious', '认真', 'まじめ'],
  ['Bashful', '害羞', 'てれや'],
  ['Quirky', '浮躁', 'きまぐれ'],
];

/** 常见异译/俗称 → 官方中文名。认不出某个叫法时在这里加一行。 */
const NATURE_ALIAS = {
  '孤僻': '怕寂寞', '寂寞': '怕寂寞', '保守': '内敛', '沉着': '冷静',
  '胆怯': '胆小', '爽朗': '开朗', '顽固': '固执', '悠然': '悠闲',
};

/** 名称(小写去空格) → {up, down, en, zh, ja}；中/英/日/俗称全部指向同一条。 */
const NATURE_INDEX = (() => {
  const idx = {};
  const put = (k, v) => { if (k) idx[String(k).toLowerCase().replace(/\s/g, '')] = v; };
  for (const [up, row] of Object.entries(NATURE_TABLE)) {
    for (const [down, [en, zh, ja]] of Object.entries(row)) {
      const v = { up, down, en, zh, ja };
      put(en, v); put(zh, v); put(ja, v);
    }
  }
  for (const [en, zh, ja] of NATURE_NEUTRAL) {
    const v = { up: null, down: null, en, zh, ja };
    put(en, v); put(zh, v); put(ja, v);
  }
  for (const [alias, zh] of Object.entries(NATURE_ALIAS)) {
    const v = idx[zh.toLowerCase()];
    if (v) put(alias, v);
  }
  return idx;
})();

/**
 * 解析性格名（中 / 英 / 日 / 常见俗称皆可）。
 *
 * 解析不了返回 null——**不静默按无修正算**。悄悄当中性会让面板差 1~3 点，
 * 而 1 点足以翻转先手或确定数；宁可让上层看见「这个名字我不认识」。
 */
export function parseNature(name, fmt = null) {
  if (!name) return null;
  const hit = NATURE_INDEX[String(name).toLowerCase().replace(/\s/g, '')];
  if (!hit) return null;
  const enabled = !fmt || fmt.nature.enabled;
  const up = enabled ? hit.up : null;
  const down = enabled ? hit.down : null;
  const mods = {};
  if (up && down) {
    mods[up] = fmt ? fmt.nature.up : 1.1;
    mods[down] = fmt ? fmt.nature.down : 0.9;
  }
  return { ...hit, up, down, mods };
}

/** 六项能力的中文短名。输出面板的地方都用它，避免各脚本各写一份。 */
export const STAT_ZH = { hp: 'HP', atk: '攻', def: '防', spa: '特攻', spd: '特防', spe: '速' };

/** {up, down} → 性格名，供反查（预设只给了加/降项，没给名字）。 */
export function natureName(up, down, lang = 'en') {
  const row = up && down ? NATURE_TABLE[up]?.[down] : null;
  if (!row) return lang === 'zh' ? '认真' : 'Serious';
  return lang === 'zh' ? row[1] : row[0];
}

// ------------------------------------------------------------ 投入预设

/**
 * 努力值/能力点预设。
 *
 * 之所以要预设：实战里对手的配置几乎永远未知，逐条手填既慢又是假精确。
 * 具名预设让每条计算的假设一眼可见，也让「未知」被显式表达出来。
 *
 * 'max' 会按格式展开——主系列是 252，Champions 是单项上限 32。
 * 这样 champions-rules.json 改了上限，预设自动跟着走。
 */
export const PRESETS = {
  '物攻满':   { ev: { atk: 'max', spe: 'max' }, up: 'atk', down: 'spa' },
  '物攻速攻': { ev: { atk: 'max', spe: 'max' }, up: 'spe', down: 'spa' },
  '特攻满':   { ev: { spa: 'max', spe: 'max' }, up: 'spa', down: 'atk' },
  '特攻速攻': { ev: { spa: 'max', spe: 'max' }, up: 'spe', down: 'atk' },
  '物耐满':   { ev: { hp: 'max', def: 'max' }, up: 'def', down: 'spa' },
  '特耐满':   { ev: { hp: 'max', spd: 'max' }, up: 'spd', down: 'atk' },
  '满速':     { ev: { spe: 'max' }, up: 'spe', down: 'spa' },
  '无投入':   { ev: {}, up: null, down: null },
};

export const PRESET_ALIAS = {
  'offense-phys': '物攻满', 'fast-phys': '物攻速攻',
  'offense-spec': '特攻满', 'fast-spec': '特攻速攻',
  'bulky-phys': '物耐满', 'bulky-spec': '特耐满',
  'frail': '无投入', 'none': '无投入', '0': '无投入',
  '满耐久': '物耐满', '满物耐': '物耐满', '满特耐': '特耐满',
  '满攻': '物攻满', '满特攻': '特攻满', '裸': '无投入',
};

export const presetName = n => {
  if (!n) return null;
  const s = String(n);
  return PRESETS[s] ? s : (PRESET_ALIAS[s.toLowerCase()] || PRESET_ALIAS[s] || null);
};

/**
 * 把预设或显式投入展开成一份完整的配置描述。
 * natureMods 是给我们自己的 calcStat 用的（Champions 路径）；
 * natureName 是给 @smogon/calc 用的（主系列路径）。
 *
 * 超上限一律以 `~标记` 出现在 tags 里，不静默截断——假精确比报错危险得多。
 */
export function buildSpread(fmt, spec) {
  const tags = [];
  const cap = maxInvest(fmt);
  let evs = {}, up = null, down = null;

  const applyNature = (name, soft) => {
    const nat = parseNature(name, fmt);
    if (nat) { up = nat.up; down = nat.down; return true; }
    tags.push(`~未知性格名(${name})${soft ? '' : '→按无修正算'}`);
    return false;
  };

  if (spec.evs) {
    evs = { ...spec.evs };
    if (spec.nature) applyNature(spec.nature, false);
  } else {
    const key = presetName(spec.spread) || '无投入';
    const p = PRESETS[key];
    for (const [s, v] of Object.entries(p.ev)) evs[s] = v === 'max' ? cap : v;
    up = p.up; down = p.down;
    tags.push(key);
    // 预设自带加/降项，但用户显式写了性格就以用户为准
    if (spec.nature) applyNature(spec.nature, true);
  }

  // 总量校验：超了就明说，不静默截断
  const total = Object.values(evs).reduce((a, b) => a + (Number(b) || 0), 0);
  if (total > fmt.ev.total) tags.push(`~超出总量上限(${total}/${fmt.ev.total})`);
  for (const [s, v] of Object.entries(evs)) {
    if (v > cap) tags.push(`~${s}超出单项上限(${v}/${cap})`);
  }

  const hasNature = fmt.nature.enabled && up && down;
  const natureMods = {};
  if (hasNature) {
    natureMods[up] = fmt.nature.up;
    natureMods[down] = fmt.nature.down;
  }
  return {
    evs, up, down, total, tags, natureMods,
    natureName: hasNature ? natureName(up, down) : 'Serious',
    natureZh: hasNature ? natureName(up, down, 'zh') : '认真',
  };
}

/**
 * 配置未知时每一项面板「真实可达的上下界」。
 *   lo = 0 投入 + 降性格   hi = 单项上限投入 + 加性格
 *
 * 这是**逐项独立**的包络，六项不可能同时取上界（总点数根本不够）。
 * 调用方必须把这句话一起打出来，否则上界会被读成某个真实存在的配置。
 */
export function statsEnvelope(fmt, bs, level) {
  const cap = maxInvest(fmt);
  const out = {};
  STAT_ORDER.forEach((s, i) => {
    out[s] = {
      lo: calcStat(fmt, s, bs[i], { ev: 0, nature: fmt.nature.enabled ? fmt.nature.down : 1, level }),
      hi: calcStat(fmt, s, bs[i], { ev: cap, nature: fmt.nature.enabled ? fmt.nature.up : 1, level }),
    };
  });
  return out;
}

/** 面板行里的性格标签：`胆小(+速-攻)` / `认真(无修正)`——一眼看出修正落在哪两项。 */
export function natureTag(up, down) {
  if (!up || !down) return `${natureName(null, null, 'zh')}(无修正)`;
  return `${natureName(up, down, 'zh')}(+${STAT_ZH[up]}-${STAT_ZH[down]})`;
}
