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
