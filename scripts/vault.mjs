#!/usr/bin/env node
/**
 * vault.mjs —— piki 的落盘位置解析器
 *
 * 写卡前必须先跑这个：从「用户当前所在目录」向上找 .obsidian/，确定这次要写进哪个仓库，
 * 再由仓库自身的目录结构决定笔记该放哪。skill 里不再出现任何写死的绝对路径。
 *
 * 只读——不创建目录、不写文件，只把解析结果打印出来。
 *
 * 关键：必须在**用户的工作目录**里运行，不要先 cd 到 skill 目录。
 *   node <skill目录>/scripts/vault.mjs
 *   node <skill目录>/scripts/vault.mjs --from <dir>    # 用户明确指定仓库或其子目录
 *   node <skill目录>/scripts/vault.mjs --type 宝可梦    # 只打印该类型的目标目录（一行）
 *
 * 完整契约见 references/note-conventions.md
 */

import fs from 'node:fs';
import path from 'node:path';

// 十个类型标签，与 note-conventions.md 的「标签体系」一一对应
const TYPES = ['宝可梦', '招式', '特性', '道具', '基础', '阵容', '技巧', '状态', '天气', '场地'];
const MOC_NAME = '宝可梦对战.md';
const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.build-cache', '.stfolder']);
const MAX_DEPTH = 3;   // 类型目录的扫描深度上限，够覆盖 <vault>/笔记/阵容 这类两层结构

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const [k, inline] = a.slice(2).split('=');
  if (inline !== undefined) flags[k] = inline;
  else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
  else flags[k] = true;
}

if (flags.help) {
  process.stdout.write(`用法（在用户工作目录里运行，不要先 cd 到 skill 目录）：
  node vault.mjs                 从 cwd 向上解析仓库，打印完整 JSON
  node vault.mjs --from <dir>    改用 <dir> 作为起点
  node vault.mjs --type <类型>    只打印该类型笔记的目标目录（一行）
                                 类型取值：${TYPES.join(' ')}
找不到仓库时打印 {"ok":false,"reason":"no_vault"} 并以退出码 3 结束。
`);
  process.exit(0);
}

const start = path.resolve(flags.from && flags.from !== true ? String(flags.from) : process.cwd());

/** 从 start 逐级向上找含 .obsidian/ 的目录 */
function findVaultRoot(from) {
  const searched = [];
  let dir = from;
  for (;;) {
    searched.push(dir);
    try {
      if (fs.statSync(path.join(dir, '.obsidian')).isDirectory()) return { root: dir, searched };
    } catch { /* 不存在就继续往上 */ }
    const parent = path.dirname(dir);
    if (parent === dir) return { root: null, searched };
    dir = parent;
  }
}

const { root: vaultRoot, searched } = findVaultRoot(start);

if (!vaultRoot) {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'no_vault', cwd: start, searched }, null, 2) + '\n');
  process.exit(3);
}

/** 广度优先扫仓库，收集类型同名目录与 MOC 笔记 */
function scan(root) {
  const hits = {};   // 类型 -> [路径...]，按发现顺序（BFS 保证浅的在前）
  let moc = null;
  let queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const next = [];
    for (const { dir, depth } of queue) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          if (TYPES.includes(e.name)) (hits[e.name] ||= []).push(full);
          if (depth + 1 < MAX_DEPTH) next.push({ dir: full, depth: depth + 1 });
        } else if (!moc && e.name === MOC_NAME) {
          moc = full;
        }
      }
    }
    queue = next;
  }
  return { hits, moc };
}

const { hits, moc } = scan(vaultRoot);

const typeDirs = {};
const ambiguous = {};
for (const [type, paths] of Object.entries(hits)) {
  typeDirs[type] = paths[0];                       // BFS 顺序 = 最浅优先
  if (paths.length > 1) ambiguous[type] = paths;
}

const exists = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const inboxPath = path.join(vaultRoot, 'Inbox');
const attachPath = path.join(vaultRoot, 'Attachments');

// 类型 → 目标目录：有同名类型目录就用它，否则回退 Inbox
const destFor = type => typeDirs[type] || inboxPath;

if (flags.type && flags.type !== true) {
  const t = String(flags.type);
  if (!TYPES.includes(t)) {
    process.stderr.write(`未知类型 ${t}；可选：${TYPES.join(' ')}\n`);
    process.exit(2);
  }
  process.stdout.write(destFor(t) + '\n');
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  ok: true,
  cwd: start,
  vaultRoot,
  inbox: { path: inboxPath, exists: exists(inboxPath) },
  attachments: { path: attachPath, exists: exists(attachPath) },
  typeDirs,
  ambiguous,
  moc,
}, null, 2) + '\n');
