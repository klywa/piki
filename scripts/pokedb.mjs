#!/usr/bin/env node
/**
 * pokedb.mjs —— piki 的离线查询工具
 *
 * 负责一切「确定性事实」：属性、种族值、特性、招式参数、相性、速度线、学习合法性。
 * 不负责伤害数字（那是 calc.mjs 的事），也不负责使用率/常见配招（那是时变数据，走 web）。
 *
 * 输出是给模型读的：每条记录一行、管道分隔、字段定长有序。这样既省 token，
 * 又让「把哪一栏看成哪一栏」这类错误不可能发生。
 *
 * 完整契约见 references/data-tools.md，或 node pokedb.mjs --help
 */

import {
  DB, resolve, resolveAll, zhType, zhTypes, zhAbility, disp, fmtCandidates,
} from './lib/data.mjs';
import { getFormat, calcStat, maxInvest } from './lib/rules.mjs';

const argv = process.argv.slice(2);
const cmd = argv.shift();

const flags = {};
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else words.push(a);
}

const out = [];
const say = s => out.push(s);
const flush = () => { if (out.length) process.stdout.write(out.join('\n') + '\n'); };

// ------------------------------------------------------------ 通用

/** 解析失败的统一出口：歧义列候选、找不到列建议，绝不静默替用户选一个。 */
function reportFail(r) {
  if (r.reason === 'ambiguous') {
    say(`AMBIGUOUS ${r.query} → ${fmtCandidates(r.candidates)}`);
  } else if (r.suggestions?.length) {
    say(`NOTFOUND ${r.query} — 是否指：${fmtCandidates(r.suggestions)}`);
  } else {
    say(`NOTFOUND ${r.query} — 本地库为主系列(Showdown)数据；可能是 Champions 新增/改名/别名，请走 web 源核实，不要用近似值顶替`);
  }
}

const pct = n => `x${n}`;

// ------------------------------------------------------------ 相性

const TYPE_IDS = Object.keys(DB.types).filter(t => t && t !== 'stellar');

/** 攻击属性 atkType 打防御属性组 defTypes 的总倍率。 */
function effectiveness(atkType, defTypes) {
  const row = DB.types[atkType]?.atk;
  if (!row) return 1;
  return defTypes.reduce((m, d) => m * (row[String(d).toLowerCase()] ?? 1), 1);
}

/**
 * 特性对「被什么属性打」的修正。
 * 这是 LLM 最容易记错、对战里又最常问的一块（悬浮免地面、厚脂肪半伤火冰、
 * 引火/储水/避雷针完全免疫），所以做进 --matchup，不留给模型自己回忆。
 * 值是乘算倍率：0 = 免疫。
 */
const ABILITY_DEF_MOD = {
  levitate:      { ground: 0 },
  flashfire:     { fire: 0 },
  wellbakedbody: { fire: 0 },
  waterabsorb:   { water: 0 },
  stormdrain:    { water: 0 },
  dryskin:       { water: 0, fire: 1.25 },
  voltabsorb:    { electric: 0 },
  lightningrod:  { electric: 0 },
  motordrive:    { electric: 0 },
  sapsipper:     { grass: 0 },
  eartheater:    { ground: 0 },
  thickfat:      { fire: 0.5, ice: 0.5 },
  heatproof:     { fire: 0.5 },
  waterbubble:   { fire: 0.5 },
  fluffy:        { fire: 2 },
  purifyingsalt: { ghost: 0.5 },
};
/** 「超效技整体减伤」类特性，不针对具体属性。 */
const ABILITY_SE_DAMP = { filter: 0.75, solidrock: 0.75, prismarmor: 0.75 };

function defensiveChart(defTypes, abilityId) {
  const mod = ABILITY_DEF_MOD[abilityId] || {};
  const damp = ABILITY_SE_DAMP[abilityId];
  const buckets = new Map();
  for (const t of TYPE_IDS) {
    let e = effectiveness(t, defTypes);
    if (t in mod) e *= mod[t];
    if (damp && e > 1) e *= damp;
    if (e === 1) continue;
    if (!buckets.has(e)) buckets.set(e, []);
    buckets.get(e).push(zhType(t));
  }
  const order = [...buckets.keys()].sort((a, b) => b - a);
  return order.map(k => `${pct(k)} ${buckets.get(k).join(',')}`).join(' | ') || '（全部 x1）';
}

// ------------------------------------------------------------ 子命令

function cmdMon() {
  for (const r of resolveAll('species', words)) {
    if (!r.ok) { reportFail(r); continue; }
    const s = r.rec;
    const abs = Object.entries(s.ab).map(([slot, name]) =>
      slot === 'H' ? `${zhAbility(name)}(隐藏)` : zhAbility(name));
    const bst = s.bs.reduce((a, b) => a + b, 0);
    say(`MON ${disp(s)}|${s.name}|${s.ja || '—'}|${zhTypes(s.types)}|${s.bs.join('.')}|种族和${bst}|${abs.join(',')}|${s.w ?? '?'}kg${s.nonstandard ? `|~${s.nonstandard}` : ''}`);
    say(`    HP${s.bs[0]} 攻${s.bs[1]} 防${s.bs[2]} 特攻${s.bs[3]} 特防${s.bs[4]} 速${s.bs[5]}`);
    if (s.otherFormes?.length) say(`    其他形态：${s.otherFormes.join(', ')}`);

    if (flags.matchup) {
      const wantAb = String(flags.ability || Object.values(s.ab)[0] || '');
      const abRes = resolve('abilities', wantAb);
      const abId = abRes.ok ? abRes.id : '';
      say(`DEF ${disp(s)} ${defensiveChart(s.types, abId)}`);
      const changed = ABILITY_DEF_MOD[abId] || ABILITY_SE_DAMP[abId];
      say(`    ${changed ? `↑已计入特性「${zhAbility(abId)}」` : `↑纯属性相性（特性「${zhAbility(wantAb)}」不改相性）`}；换特性用 --ability <名>`);
      const atk = s.types.map(t => {
        const good = TYPE_IDS.filter(d => effectiveness(String(t).toLowerCase(), [d]) === 2).map(zhType);
        return `${zhType(t)}打 ${good.join(',')}`;
      });
      say(`ATK ${disp(s)} 本系克 ${atk.join(' ｜ ')}`);
    }

    if (flags.moves) {
      const baseId = String(s.baseSpecies || s.name).toLowerCase().replace(/[^a-z0-9]/g, '');
      const ls = DB.learnsets[r.id] || DB.learnsets[baseId] || [];
      const atkMoves = ls.map(id => DB.moves[id]).filter(m => m && m.bp > 0)
        .sort((a, b) => b.bp - a.bp).slice(0, 25);
      say(`LEARN ${disp(s)} 可学 ${ls.length} 招；高威力前 25：`);
      say('    ' + atkMoves.map(m => `${m.zh || m.name}(${zhType(m.type)}${m.bp})`).join(' '));
      say(`    注：这是跨世代「能不能学」的并集，不是当前环境的常用配招——配招请查 pokechamdb`);
    }
  }
}

function cmdMove() {
  const CAT = { Physical: '物理', Special: '特殊', Status: '变化' };
  const TGT = {
    normal: '单体', self: '自身', allAdjacentFoes: '敌方全体(范围)', allAdjacent: '除自己全体(范围)',
    any: '任意单体', allySide: '我方全场', foeSide: '对方全场', all: '全场',
    adjacentAlly: '我方同伴', adjacentAllyOrSelf: '我方或自身', randomNormal: '随机单体',
    allies: '我方全体', scripted: '特殊',
  };
  const FLAG = {
    contact: '接触', protect: '可被守住', sound: '声音', punch: '拳', bite: '牙',
    bullet: '弹', powder: '粉尘', slicing: '切割', wind: '风', recharge: '需休息', charge: '需蓄力',
  };
  for (const r of resolveAll('moves', words)) {
    if (!r.ok) { reportFail(r); continue; }
    const m = r.rec;
    const fl = m.flags.map(f => FLAG[f]).filter(Boolean);
    say(`MOVE ${disp(m)}|${m.name}|${m.ja || '—'}|${zhType(m.type)}|${CAT[m.cat] || m.cat}|威力${m.bp || '—'}|命中${m.acc}|PP${m.pp}|优先${m.pri >= 0 ? '+' : ''}${m.pri}|${TGT[m.target] || m.target}${fl.length ? '|' + fl.join(',') : ''}${m.nonstandard ? `|~${m.nonstandard}` : ''}`);
    if (m.desc) say(`    ${m.desc}`);
  }
}

function cmdAbility() {
  for (const r of resolveAll('abilities', words)) {
    if (!r.ok) { reportFail(r); continue; }
    const a = r.rec;
    say(`ABI ${disp(a)}|${a.name}|${a.ja || '—'}${a.rating != null ? `|竞技评分${a.rating}` : ''}`);
    if (a.desc) say(`    ${a.desc}`);
  }
}

function cmdItem() {
  for (const r of resolveAll('items', words)) {
    if (!r.ok) { reportFail(r); continue; }
    const it = r.rec;
    say(`ITEM ${disp(it)}|${it.name}|${it.ja || '—'}${it.megaStone ? `|Mega石→${Object.values(it.megaStone).join(',')}` : ''}${it.nonstandard ? `|~${it.nonstandard}` : ''}`);
    if (it.desc) say(`    ${it.desc}`);
  }
}

function cmdType() {
  const parts = words.join(' ').split(/[\/／+·,，]/).map(s => s.trim()).filter(Boolean);
  const ids = [];
  for (const p of parts) {
    const r = resolve('types', p);
    if (!r.ok) { reportFail({ ...r, query: p }); return; }
    ids.push(r.id);
  }
  if (!ids.length) { say('用法：node pokedb.mjs type <属性> 或 <属性1/属性2>'); return; }

  const wantAtk = !!flags.atk || (!flags.atk && !flags.def && ids.length === 1);
  const wantDef = !!flags.def || (!flags.atk && !flags.def);

  if (wantAtk) {
    for (const t of ids) {
      const buckets = new Map();
      for (const [d, v] of Object.entries(DB.types[t].atk || {})) {
        if (v === 1) continue;
        if (!buckets.has(v)) buckets.set(v, []);
        buckets.get(v).push(zhType(d));
      }
      const order = [...buckets.keys()].sort((a, b) => b - a);
      say(`ATK ${zhType(t)}系攻击 ${order.map(k => `${pct(k)} ${buckets.get(k).join(',')}`).join(' | ') || '（全部 x1）'}`);
    }
  }
  if (wantDef) {
    const abId = flags.ability ? (resolve('abilities', flags.ability).id || '') : '';
    say(`DEF ${ids.map(zhType).join('/')}${abId ? `+${zhAbility(abId)}` : ''} 承受 ${defensiveChart(ids, abId)}`);
  }
}

function cmdSpeed() {
  const fmt = getFormat(flags.format);
  if (!fmt) { say(`NOTFOUND 未知格式 ${flags.format}`); return; }
  const level = Number(flags.level) || fmt.level;
  const inv = maxInvest(fmt);

  const MOD = {
    scarf: [1.5, '围巾'], 围巾: [1.5, '围巾'],
    '+1': [1.5, '+1'], '+2': [2, '+2'], '+3': [2.5, '+3'],
    tailwind: [2, '顺风'], 顺风: [2, '顺风'],
    para: [0.5, '麻痹'], 麻痹: [0.5, '麻痹'],
    swiftswim: [2, '雨天加速'], chlorophyll: [2, '晴天加速'], sandrush: [2, '沙暴加速'],
    slushrush: [2, '雪天加速'], unburden: [2, '轻装'],
    protosynthesis: [1.5, '古代活性'], quarkdrive: [1.5, '夸克充能'],
  };
  const active = String(flags.mods || '').split(/[,，]/)
    .map(s => MOD[s.trim().toLowerCase()]).filter(Boolean);

  const rows = [];
  for (const r of resolveAll('species', words)) {
    if (!r.ok) { reportFail(r); continue; }
    const s = r.rec;
    const base = s.bs[5];
    const mk = (ev, nat) => calcStat(fmt, 'spe', base, { ev, nature: nat, level });
    rows.push({
      name: disp(s), base,
      down: mk(0, fmt.nature.enabled ? fmt.nature.down : 1),
      neu: mk(0, 1),
      max: mk(inv, fmt.nature.enabled ? fmt.nature.up : 1),
    });
  }
  if (!rows.length) return;

  say(`SPEED lv${level} ${fmt.label}｜裸速=0投入中性性格　max=${inv}点投入${fmt.nature.enabled ? '+加速性格' : '（本格式无性格修正）'}`);
  for (const r of rows) {
    const cols = [`裸速 ${r.neu}`, `max ${r.max}`];
    if (fmt.nature.enabled && r.down !== r.neu) cols.splice(1, 0, `降速 ${r.down}`);
    for (const [mult, label] of active) cols.push(`${label} ${Math.floor(r.max * mult)}`);
    say(`SPD ${r.name}|种族${r.base}|${cols.join('|')}`);
  }

  const sorted = [...rows].sort((a, b) => b.max - a.max);
  say(`ORDER(满速) ${sorted.map(r => `${r.name} ${r.max}`).join(' > ')}`);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].max === sorted[i + 1].max) {
      say(`TIE ${sorted[i].name}=${sorted[i + 1].name} ${sorted[i].max}（同速，先手是 50/50 猜拳）`);
    }
  }
  if (active.length) say(`    修正列在 max 面板上叠乘；实战请先确认对手是否真的满速投入`);
}

function cmdCan() {
  if (words.length < 2) { say('用法：node pokedb.mjs can <宝可梦> <招式...>'); return; }
  const mr = resolve('species', words[0]);
  if (!mr.ok) { reportFail({ ...mr, query: words[0] }); return; }
  const s = mr.rec;
  const baseId = String(s.baseSpecies || s.name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const ls = new Set(DB.learnsets[mr.id] || DB.learnsets[baseId] || []);
  if (!ls.size) { say(`NOTFOUND 学习表 ${disp(s)} — 本地库无此形态数据，请走 web 源`); return; }
  const res = words.slice(1).map(w => {
    const r = resolve('moves', w);
    return r.ok ? `${disp(r.rec)}:${ls.has(r.id) ? 'YES' : 'NO'}` : `${w}:?`;
  });
  say(`CAN ${disp(s)} ${res.join(' ')}`);
  say(`    依据跨世代学习表并集；Champions 可学招式可能与主系列不同，关键结论请复核`);
}

function cmdSearch() {
  const q = words.join(' ').toLowerCase();
  const map = { mon: 'species', move: 'moves', ability: 'abilities', item: 'items' };
  const kinds = flags.kind ? [map[flags.kind] || flags.kind] : ['species', 'moves', 'abilities', 'items'];
  const n = Number(flags.n) || 10;
  for (const kind of kinds) {
    const hits = [];
    for (const [id, rec] of Object.entries(DB[kind] || {})) {
      if (hits.length >= n) break;
      const hay = `${id} ${rec.name} ${rec.zh || ''} ${rec.ja || ''}`.toLowerCase();
      if (hay.includes(q)) hits.push(`${rec.zh || rec.name}(${id})`);
    }
    if (hits.length) say(`SEARCH ${kind} ${hits.join(' | ')}`);
  }
  if (!out.length) say(`NOTFOUND 搜索无结果：${q}`);
}

function cmdVersion() {
  const m = DB.meta || {};
  say(`piki-db 生成于 ${m.generated_at || '?'}`);
  say(`条目数 ${JSON.stringify(m.counts || {})}`);
  say(`中文名覆盖 ${JSON.stringify(m.zh_coverage || {})}`);
  const fmt = getFormat('champs-single');
  say(fmt.verified
    ? `Champions 规则：已核实（${fmt.source || '见 data/champions-rules.json'}）`
    : `Champions 规则：⚠ 未核实——数值可能不准，详见 data/champions-rules.json`);
}

const HELP = `pokedb.mjs —— piki 离线查询（名称支持 中/日/英/俗称 混用）

  mon     <名...>  [--matchup] [--moves] [--ability <特性>] [--format champs|sv]
  move    <名...>
  ability <名...>
  item    <名...>
  type    <属性|属性1/属性2> [--atk] [--def] [--ability <特性>]
  speed   <名...>  [--format champs] [--level 50] [--mods 围巾,顺风,+1,麻痹]
  can     <宝可梦> <招式...>
  search  <关键词> [--kind mon|move|ability|item] [--n 10]
  --version

伤害数字不在这里——用 calc.mjs。
使用率/常见配招也不在这里——那是时变数据，走 web（pokechamdb）。`;

const TABLE = {
  mon: cmdMon, move: cmdMove, ability: cmdAbility, item: cmdItem,
  type: cmdType, speed: cmdSpeed, can: cmdCan, search: cmdSearch,
};

try {
  if (!cmd || cmd === '--help' || cmd === '-h') say(HELP);
  else if (cmd === '--version') cmdVersion();
  else if (TABLE[cmd]) TABLE[cmd]();
  else say(`未知子命令 ${cmd}\n\n${HELP}`);
} catch (e) {
  say(`ERROR ${e.message}`);
  flush();
  process.exit(1);
}
flush();
