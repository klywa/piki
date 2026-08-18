#!/usr/bin/env node
/**
 * calc.mjs —— piki 唯一的伤害数字来源
 *
 * 为什么必须是脚本：伤害不是「大概七成」，而是 16 档随机数下的确定区间。
 * 口算一定会错，而错了的伤害会让整套决策跟着错。所以 piki 的铁律是：
 * 任何百分比、任何确定数，只能来自这里。
 *
 * 引擎用 @smogon/calc（竞技圈权威实现），但数值模型是我们自己的——
 * Champions 是 66 能力点 / 单项上限 32 / 无个体值，@smogon/calc 的
 * 「种族+个体+努力+性格」模型表达不了，所以面板由 lib/rules.mjs 算好后注入。
 *
 *   node calc.mjs --in <批量json> [--desc]
 *   node calc.mjs --json '{...}'      # ≤3 条时内联更省事
 *
 * 完整输入格式见 references/data-tools.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolve, disp, fmtCandidates } from './lib/data.mjs';
import {
  getFormat, calcStat, maxInvest, ruleBanner, STAT_ORDER,
  buildSpread, natureTag,   // 配置模型（预设/性格/上限校验）统一住在 rules.mjs，与 pokedb.mjs stats 共用
} from './lib/rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------ 依赖自举

function fail3(reason) {
  process.stdout.write(
    `calc_unavailable: ${reason}\n` +
    `本次拿不到任何伤害数字。上层应只做定性分析，并明确告诉用户「未做精算」，\n` +
    `绝不可用心算或记忆中的百分比顶替——那正是这个脚本存在的理由。\n`
  );
  process.exit(3);
}

/** 首次运行自动安装（沿用 fetch_video.py 里 ensure_ytdlp 的做法）。
 *  装不上不是「换个办法凑合」，而是明确退出，让上层知道这次没有精算。 */
async function ensureCalc() {
  const entry = path.join(__dirname, 'node_modules', '@smogon', 'calc', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    try {
      process.stderr.write('[calc] 首次运行，正在安装 @smogon/calc …\n');
      // Windows 上 npm 是 .cmd 批处理：不能直接 spawn（EINVAL），
      // 但也不该用 shell:true —— 那会把参数拼成命令行字符串（Node 的 DEP0190 警告）。
      // 显式走 cmd.exe /c 并把参数按数组传，两个问题都避开。
      const NPM_ARGS = ['install', '--no-audit', '--no-fund', '--silent'];
      const [bin, args] = process.platform === 'win32'
        ? ['cmd.exe', ['/c', 'npm', ...NPM_ARGS]]
        : ['npm', NPM_ARGS];
      execFileSync(bin, args, { cwd: __dirname, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      fail3(`npm install 失败：${String(e.message).slice(0, 200)}`);
    }
  }
  if (!fs.existsSync(entry)) fail3('安装后仍找不到 @smogon/calc');
  try { return await import(pathToFileURL(entry).href); }
  catch (e) { fail3(`加载 @smogon/calc 失败：${e.message}`); }
}

// ------------------------------------------------------------ 输入

const argv = process.argv.slice(2);
const getArg = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const WANT_DESC = argv.includes('--desc');
const WANT_STATS = argv.includes('--stats');   // 打印每个 set 的最终面板，便于人工核对

// ------------------------------------------------------------ 建立宝可梦

const STATUS_MAP = {
  brn: 'brn', 烧伤: 'brn', par: 'par', 麻痹: 'par', psn: 'psn', 中毒: 'psn',
  tox: 'tox', 剧毒: 'tox', slp: 'slp', 睡眠: 'slp', frz: 'frz', 冰冻: 'frz',
};

function megaName(baseEn, mega) {
  const m = String(mega);
  if (/^x$/i.test(m)) return `${baseEn}-Mega-X`;
  if (/^y$/i.test(m)) return `${baseEn}-Mega-Y`;
  if (mega === true || /^(true|1|yes|是)$/i.test(m)) return `${baseEn}-Mega`;
  return m;
}

/**
 * 把算好的面板钉死在这只宝可梦上。
 *
 * 为什么不能只赋值 rawStats/stats：@smogon/calc 的 calculate() 内部会 clone()，
 * 而 clone() 是拿 evs/ivs/性格 重新走一遍构造器——我们注入的 Champions 面板
 * 会被它悄悄算回主系列的值。表面上对象没错，算出来的伤害却是错的。
 * 所以连 clone 一起接管，保证任何一份副本都带着正确面板。
 */
function pinStats(pokemon, stats, curHP) {
  const apply = t => {
    for (const s of STAT_ORDER) { t.rawStats[s] = stats[s]; t.stats[s] = stats[s]; }
    t.originalCurHP = Math.min(curHP ?? stats.hp, stats.hp);
    const parentClone = Object.getPrototypeOf(t).clone.bind(t);
    t.clone = () => apply(parentClone());
    return t;
  };
  return apply(pokemon);
}

function makePokemon(calcLib, gen, fmt, key, spec, errs, warns) {
  const { Pokemon } = calcLib;
  const tags = [];

  // --- 种族（走本地库的中/日/英/俗称索引）
  let wanted = spec.species || spec.name;
  if (spec.mega) {
    if (!fmt.mega) {
      errs.push(`set ${key}: ${fmt.label} 不支持 Mega 进化`);
      return null;
    }
    const r0 = resolve('species', wanted);
    const baseEn = r0.ok ? (r0.rec.baseSpecies || r0.rec.name) : wanted;
    const cand = megaName(baseEn, spec.mega);
    const rm = resolve('species', cand);
    if (rm.ok) wanted = rm.rec.name;
    else tags.push(`~找不到Mega形态(${cand})`);
  }

  const r = resolve('species', wanted);
  if (!r.ok) {
    const hint = r.suggestions?.length ? ` — 是否指：${fmtCandidates(r.suggestions)}`
      : r.candidates?.length ? ` — 有歧义：${fmtCandidates(r.candidates)}` : '';
    errs.push(`set ${key}: unknown-species "${spec.species}"${hint}`);
    return null;
  }
  const rec = r.rec;

  // --- 太晶：规则下沉到脚本，比写在文档里靠模型自觉可靠得多
  if ((spec.teraType || spec.tera) && !fmt.tera) {
    errs.push(`set ${key}: tera-not-allowed-in-${fmt.id} —— ${fmt.label} 当前规则未解禁太晶化，请去掉 teraType`);
    return null;
  }

  // --- 特性
  let ability;
  if (spec.ability) {
    const ra = resolve('abilities', spec.ability);
    if (ra.ok) ability = ra.rec.name; else tags.push(`~未知特性(${spec.ability})`);
  } else {
    ability = Object.values(rec.ab)[0];
  }

  // --- 道具（含 Champions 道具池校验）
  let item;
  if (spec.item === '?' || spec.item === 'unknown' || spec.item === '未知') {
    tags.push('~道具未知(按无道具算)');
  } else if (spec.item) {
    const ri = resolve('items', spec.item);
    if (ri.ok) {
      item = ri.rec.name;
      const pool = fmt.items;
      if (pool?.unavailable?.includes(ri.id)) {
        warns.add(`道具「${disp(ri.rec)}」在 ${fmt.label}（${pool.as_of}）尚未实装——含它的配招是无效建议`);
        tags.push('~道具未实装');
      }
    } else tags.push(`~未知道具(${spec.item})`);
  }

  const spread = buildSpread(fmt, spec);
  tags.push(...spread.tags);
  const level = spec.level || fmt.level;

  let p;
  try {
    p = new Pokemon(gen, rec.name, {
      level, ability, item,
      nature: spread.natureName,
      boosts: spec.boosts || {},
      status: STATUS_MAP[String(spec.status || '').toLowerCase()] || '',
      ...(fmt.ev.system === 'classic' ? { evs: spread.evs } : {}),
      ...(spec.teraType && fmt.tera ? { teraType: spec.teraType } : {}),
      ...(spec.abilityOn ? { abilityOn: true } : {}),
    });
  } catch (e) {
    errs.push(`set ${key}: 建立失败 ${rec.name} — ${e.message}`);
    return null;
  }

  // --- Champions：面板自己算了注入，绕过 @smogon/calc 的 EV 模型
  if (fmt.ev.system !== 'classic') {
    const bsObj = p.species?.baseStats;
    const bs = bsObj
      ? [bsObj.hp, bsObj.atk, bsObj.def, bsObj.spa, bsObj.spd, bsObj.spe]
      : rec.bs;
    const pinned = {};
    STAT_ORDER.forEach((s, i) => {
      pinned[s] = calcStat(fmt, s, bs[i], {
        ev: Number(spread.evs[s]) || 0,
        nature: spread.natureMods[s] ?? 1,
        level,
      });
    });
    pinStats(p, pinned, pinned.hp);
  }

  // --- 当前血量（局面分析里几乎总是残血）
  if (spec.hpPercent != null || spec.curHP != null) {
    const cur = spec.hpPercent != null
      ? Math.max(1, Math.round(p.rawStats.hp * Number(spec.hpPercent) / 100))
      : Math.min(p.rawStats.hp, Number(spec.curHP));
    pinStats(p, { ...p.rawStats }, cur);
    if (spec.hpPercent != null) tags.push(`HP${spec.hpPercent}%`);
  }

  const boostTags = Object.entries(spec.boosts || {})
    .filter(([, v]) => v).map(([k, v]) => `${v > 0 ? '+' : ''}${v}${k}`);
  if (item) tags.unshift(disp(resolve('items', item).rec || { name: item }));

  const st = p.rawStats;
  const statLine = `STATS ${key} ${disp(rec)}|性格${natureTag(spread.up, spread.down)}|HP${st.hp} 攻${st.atk} 防${st.def} 特攻${st.spa} 特防${st.spd} 速${st.spe}`;

  return { p, rec, label: disp(rec), tags: [...tags, ...boostTags], statLine };
}

// ------------------------------------------------------------ 场地

function makeField(calcLib, fmt, f = {}) {
  const { Field } = calcLib;
  const WEATHER = {
    sun: 'Sun', 晴: 'Sun', 晴天: 'Sun', 大晴天: 'Sun',
    rain: 'Rain', 雨: 'Rain', 雨天: 'Rain', 下雨: 'Rain',
    sand: 'Sand', 沙: 'Sand', 沙暴: 'Sand',
    snow: 'Snow', 雪: 'Snow', 下雪: 'Snow', hail: 'Hail', 冰雹: 'Hail',
  };
  const TERRAIN = {
    electric: 'Electric', 电气: 'Electric', 电: 'Electric', 电气场地: 'Electric',
    grassy: 'Grassy', 青草: 'Grassy', 草: 'Grassy', 青草场地: 'Grassy',
    psychic: 'Psychic', 精神: 'Psychic', 精神场地: 'Psychic',
    misty: 'Misty', 薄雾: 'Misty', 雾: 'Misty', 薄雾场地: 'Misty',
  };
  const side = s => ({
    isTailwind: !!(s.tailwind ?? s.顺风),
    isReflect: !!(s.reflect ?? s.反射壁),
    isLightScreen: !!(s.lightscreen ?? s.光墙),
    isAuroraVeil: !!(s.auroraveil ?? s.极光幕),
    isHelpingHand: !!(s.helpinghand ?? s.帮助),
    isFriendGuard: !!(s.friendguard ?? s.友情防守),
    isProtected: !!(s.protect ?? s.守住),
    isSR: !!(s.stealthrock ?? s.隐形岩),
    spikes: Number(s.spikes ?? s.撒菱 ?? 0),
  });
  return new Field({
    gameType: fmt.doubles ? 'Doubles' : 'Singles',
    weather: WEATHER[String(f.weather ?? '').toLowerCase()] || undefined,
    terrain: TERRAIN[String(f.terrain ?? '').toLowerCase()] || undefined,
    isGravity: !!f.gravity,
    isBeadsOfRuin: !!f.beadsofruin, isSwordOfRuin: !!f.swordofruin,
    isTabletsOfRuin: !!f.tabletsofruin, isVesselOfRuin: !!f.vesselofruin,
    attackerSide: side(f.atk || f.attacker || {}),
    defenderSide: side(f.def || f.defender || {}),
  });
}

// ------------------------------------------------------------ 计算

function koText(res) {
  try {
    const k = res.kochance();
    if (!k || !k.n) return '';
    if (k.chance === undefined || k.chance === 1) return `${k.n}发确定击倒`;
    if (k.chance === 0) return '';
    return `${k.n}发击倒 ${(k.chance * 100).toFixed(1)}%`;
  } catch { return ''; }
}

function runOne(calcLib, gen, field, atk, def, spec, errs, id) {
  const { Move, calculate } = calcLib;
  const rm = resolve('moves', spec.move);
  if (!rm.ok) {
    const hint = rm.suggestions?.length ? ` — 是否指：${fmtCandidates(rm.suggestions)}` : '';
    errs.push(`${id} ERROR unknown-move "${spec.move}"${hint}`);
    return null;
  }
  const mv = rm.rec;
  let res;
  try {
    const move = new Move(gen, mv.name, {
      ...(spec.crit ? { isCrit: true } : {}),
      ...(spec.hits ? { hits: spec.hits } : {}),
    });
    res = calculate(gen, atk.p, def.p, move, field);
  } catch (e) {
    errs.push(`${id} ERROR 计算失败 ${mv.name} — ${e.message}`);
    return null;
  }
  const arr = (Array.isArray(res.damage) ? res.damage.flat() : [res.damage]).map(Number);
  const maxHP = def.p.maxHP();
  return {
    move: disp(mv),
    lo: Math.min(...arr) / maxHP * 100,
    hi: Math.max(...arr) / maxHP * 100,
    ko: koText(res),
    desc: WANT_DESC ? (() => { try { return res.desc(); } catch { return null; } })() : null,
    isSpread: mv.target === 'allAdjacentFoes' || mv.target === 'allAdjacent',
    pri: mv.pri,
  };
}

// ------------------------------------------------------------ survive 反推

/**
 * 「要堆多少才吃得住」——@smogon/calc 没有 EV 求解器，
 * 但在它外面套一个有界搜索就够了。这是组队时最常问的一类问题，
 * 也是用户点名要的「耐久线反推」。
 */
function solveSurvive(calcLib, gen, fmt, field, atkSpec, defSpec, spec, errs, warns, id) {
  const cap = maxInvest(fmt);
  const step = fmt.ev.system === 'classic' ? 4 : 1;
  const rm = resolve('moves', spec.move);
  if (!rm.ok) { errs.push(`${id} ERROR unknown-move "${spec.move}"`); return null; }
  const defStat = rm.rec.cat === 'Physical' ? 'def' : 'spd';

  const atk = makePokemon(calcLib, gen, fmt, 'A', atkSpec, errs, warns);
  if (!atk) return null;

  // 先堆 HP 再堆防，是实战通行的投资顺序；两层都以 step 为粒度扫描
  for (let hp = 0; hp <= cap; hp += step) {
    for (let d = 0; d <= cap; d += step) {
      if (fmt.ev.system !== 'classic' && hp + d > fmt.ev.total) break;
      const e2 = [];
      const def = makePokemon(calcLib, gen, fmt, 'D',
        { ...defSpec, evs: { hp, [defStat]: d }, spread: undefined }, e2, warns);
      if (!def) continue;
      const r = runOne(calcLib, gen, field, atk, def, spec, e2, id);
      if (r && r.hi < 100) {
        return { hp, d, defStat, worst: r.hi, atkLabel: atk.label, defLabel: def.label, move: r.move };
      }
    }
  }
  return { impossible: true };
}

// ------------------------------------------------------------ 主流程

const HELP = `calc.mjs —— piki 的伤害计算（唯一允许产出伤害数字的地方）

  node calc.mjs --in <input.json> [--desc]
  node calc.mjs --json '{"format":"champs-double", ...}'

输入骨架（sets 定义一次，calcs 按 key 引用——30 条计算 = 30 行短文本，一次进程调用）：
{
  "format": "champs-single|champs-double|sv-single|sv-double|vgc",
  "field": {"weather":"晴","terrain":null,
            "atk":{"tailwind":true}, "def":{"reflect":true}},
  "sets": {
    "A1": {"species":"喷火龙","mega":"X","item":"讲究围巾","spread":"物攻满"},
    "B1": {"species":"铁臂膀","spread":"unknown","hpPercent":60}
  },
  "calcs": [
    {"id":"1","atk":"A1","def":"B1","move":"逆鳞"},
    {"id":"2","atk":"A1","def":"B1","move":"热风","crit":true,"note":"最坏情况"},
    {"id":"3","mode":"survive","atk":"A1","def":"B1","move":"逆鳞"}
  ]
}

spread 预设：物攻满 / 物攻速攻 / 特攻满 / 特攻速攻 / 物耐满 / 特耐满 / 满速 / 无投入
  也可写 "unknown"：防守方会同时对「无投入」和「满耐久」各算一行，给出真实区间——
  这比假装知道对手配置诚实，而且区间本身就是猜拳分析的输入。
完整字段见 references/data-tools.md。`;

async function main() {
  const inFile = getArg('--in'), inline = getArg('--json');
  if (!inFile && !inline) { console.log(HELP); return; }
  let input;
  try {
    input = JSON.parse(inFile ? fs.readFileSync(inFile, 'utf8') : inline);
  } catch (e) {
    console.log(`ERROR 输入不是合法 JSON：${e.message}`);
    process.exit(2);
  }

  const fmt = getFormat(input.format);
  if (!fmt) {
    console.log(`ERROR 未知格式 "${input.format}" —— 可用：champs-single, champs-double, sv-single, sv-double, vgc`);
    process.exit(2);
  }
  if (input.level) fmt.level = Number(input.level);

  const calcLib = await ensureCalc();
  const gen = calcLib.Generations.get(9);
  const field = makeField(calcLib, fmt, input.field || {});

  const errs = [], lines = [], warns = new Set(), assumptions = new Set();
  let ok = 0, errCount = 0;
  const statLines = new Set();
  // 错误内联进 lines 保持与计算同序：一条打错不该把其余的顺序也搅乱

  const f = input.field || {};
  const fieldBits = [
    f.weather && `weather=${f.weather}`,
    f.terrain && `terrain=${f.terrain}`,
    f.atk?.tailwind && 'atk顺风',
    f.def?.tailwind && 'def顺风',
    f.def?.reflect && 'def反射壁',
    f.def?.lightscreen && 'def光墙',
  ].filter(Boolean);
  const header = `CALC v1 ${ruleBanner(fmt)} rolls=16${fieldBits.length ? ' ' + fieldBits.join(' ') : ''}`;

  const sets = input.sets || {};
  const built = new Map();
  const getAtk = (key, spec) => {
    if (!built.has(key)) built.set(key, makePokemon(calcLib, gen, fmt, key, spec, errs, warns));
    return built.get(key);
  };

  for (const c of input.calcs || []) {
    const id = c.id ?? String(ok + errs.length + 1);
    const atkSpec = typeof c.atk === 'object' ? c.atk : sets[c.atk];
    const defSpec = typeof c.def === 'object' ? c.def : sets[c.def];
    if (!atkSpec || !defSpec) {
      lines.push(`${id} ERROR 找不到 set：${!atkSpec ? c.atk : c.def}`);
      errCount++;
      continue;
    }

    if (c.mode === 'survive') {
      const s = solveSurvive(calcLib, gen, fmt, field, atkSpec, defSpec, c, errs, warns, id);
      if (!s) continue;
      const unit = fmt.ev.system === 'classic' ? '努力值' : fmt.ev.unit;
      lines.push(s.impossible
        ? `${id} SURVIVE 不可能 —— 即使满投入也吃不住这一发`
        : (s.hp === 0 && s.d === 0)
          ? `${id} SURVIVE ${s.defLabel} 无需任何投入即可吃住 ${s.atkLabel} 的${s.move}（最高伤害 ${s.worst.toFixed(1)}%）`
          : `${id} SURVIVE ${s.defLabel} 需 HP${s.hp}${unit} + ${s.defStat === 'def' ? '防御' : '特防'}${s.d}${unit}，才能吃住 ${s.atkLabel} 的${s.move}（最高伤害 ${s.worst.toFixed(1)}%）`);
      ok++;
      continue;
    }

    const atk = getAtk(typeof c.atk === 'object' ? JSON.stringify(c.atk) : c.atk, atkSpec);
    if (!atk) continue;

    // 招式先解析一次再进基准循环——否则一个拼错的招式名会按基准数重复报错
    const rmv = resolve('moves', c.move);
    if (!rmv.ok) {
      const hint = rmv.suggestions?.length ? ` — 是否指：${fmtCandidates(rmv.suggestions)}` : '';
      lines.push(`${id} ERROR unknown-move "${c.move}"${hint}`);
      errCount++;
      continue;
    }

    // 防守方配置未知 → 双基准。真相必在区间内，
    // 而这个区间本身就是后面猜拳分析的输入（「他堆了耐久就吃得住，裸的就吃不住」）。
    const unknown = ['unknown', '未知', '?'].includes(String(defSpec.spread));
    const isPhys = rmv.rec.cat === 'Physical';
    const benches = unknown
      ? [{ ...defSpec, spread: '无投入' }, { ...defSpec, spread: isPhys ? '物耐满' : '特耐满' }]
      : [defSpec];
    if (unknown) assumptions.add('对手耐久未知→给无投入/满耐久双基准');

    for (const bench of benches) {
      const e2 = [];
      const def = makePokemon(calcLib, gen, fmt, String(c.def), bench, e2, warns);
      if (!def) { errs.push(...e2); continue; }
      const r = runOne(calcLib, gen, field, atk, def, c, errs, id);
      if (!r) continue;
      ok++;

      const mods = [];
      if (r.isSpread && fmt.doubles) mods.push('范围x0.75');
      if (c.crit) mods.push('暴击');
      if (r.pri > 0) mods.push(`先制+${r.pri}`);

      if (WANT_STATS) { statLines.add(atk.statLine); statLines.add(def.statLine); }
      // 0 伤害要说清是「无效」——一行 0.0-0.0% 很容易被读成计算出错，
      // 而「打不到」本身是极重要的对局信息（悬浮免地面、幽灵免格斗…）
      const dmgTxt = r.hi === 0
        ? '无效（免疫/不中）'
        : `${r.lo.toFixed(1)}-${r.hi.toFixed(1)}%${r.ko ? '  ' + r.ko : ''}`;
      lines.push(
        `${id} ${atk.label}[${atk.tags.join(',') || '—'}] ${r.move}${mods.length ? `(${mods.join(',')})` : ''}` +
        ` -> ${def.label}[${def.tags.join(',') || '—'}]  ${dmgTxt}${c.note ? `  ※${c.note}` : ''}`
      );
      if (r.desc) lines.push(`    ${r.desc}`);
      for (const t of [...atk.tags, ...def.tags]) if (t.startsWith('~')) assumptions.add(t.slice(1));
    }
  }

  const tail = [`ok: ${ok}  err: ${errCount + errs.length}  backend: @smogon/calc gen9`];
  if (assumptions.size) tail.push(`假设: ${[...assumptions].join(' / ')}`);
  for (const w of warns) tail.push(`⚠ ${w}`);
  if (!fmt.verified) {
    tail.push(`⚠ ${fmt.label} 的数值规则尚未核实（见 data/champions-rules.json）——相对大小可信，绝对值请以实战为准`);
  }

  process.stdout.write([header, ...statLines, ...lines, ...errs, ...tail].join('\n') + '\n');
  if (ok === 0 && (errCount + errs.length)) process.exit(1);
}

main().catch(e => { console.log(`ERROR ${e.stack || e.message}`); process.exit(1); });
