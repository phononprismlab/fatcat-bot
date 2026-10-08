'use strict';
// 数据备份。
//
// 为什么不能直接 cp fatcat.db：库跑在 WAL 模式下，直接拷主文件会漏掉 -wal 里
// 尚未 checkpoint 的事务，拷出来的可能是一份「旧的、且内部不一致」的库。
// 正确做法是让 SQLite 自己导出一份一致性快照 —— 这里用 `VACUUM INTO`：
//   1. 它对**正在被写入的库**安全（读事务，不阻塞写入）
//   2. 产出的是单文件、已整理、无 WAL 依赖的完整库
//   3. 不需要 sqlite3 命令行，走 Node 内置的 node:sqlite
//
// 用法：
//   node --experimental-sqlite scripts/backup.js [--out <目录>] [--keep <份数>]
// 默认输出到 <项目根>/backups/<时间戳>/，保留最近 14 份。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { out: null, keep: 14 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === '--keep' && argv[i + 1]) out.keep = Number(argv[++i]);
  }
  if (!Number.isFinite(out.keep) || out.keep < 1) out.keep = 14;
  return out;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

// SQL 字面量里的单引号要翻倍，否则路径里有 ' 就会把语句搞坏
function sqlQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function dirSize(dir) {
  let total = 0;
  let count = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        count += 1;
        try { total += fs.statSync(full).size; } catch (err) { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { bytes: total, count };
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else if (e.isFile()) { fs.copyFileSync(s, d); n += 1; }
  }
  return n;
}

// 备份一份。返回 manifest（调用方拿它做校验，测试也用它）。
function runBackup({ config, outRoot, keep = 14, now = new Date() }) {
  const dir = path.join(outRoot, stamp(now));
  fs.mkdirSync(dir, { recursive: true });

  const dbDest = path.join(dir, 'fatcat.db');
  const dbTmp = dbDest + '.tmp';
  // 先删掉 manifest：它的存在即代表「这次跑完了」。上次残留的 manifest
  // 会让一次中途失败的备份看起来是成功的。
  fs.rmSync(path.join(dir, 'manifest.json'), { force: true });

  if (!fs.existsSync(config.dbPath)) {
    throw new Error('源数据库不存在：' + config.dbPath + '（还没跑过机器人？）');
  }

  // 1) 一致性快照
  //    VACUUM INTO 的目标文件必须不存在，所以先写临时名再改名 ——
  //    这样「同一秒内跑了两次备份」不会失败，且改名是原子的，
  //    不会出现「旧的删了、新的没写成」的空窗。
  fs.rmSync(dbTmp, { force: true });
  const db = new DatabaseSync(config.dbPath);
  try {
    db.exec('VACUUM INTO ' + sqlQuote(dbTmp));
  } finally {
    db.close();
  }
  if (!fs.existsSync(dbTmp) || fs.statSync(dbTmp).size === 0) {
    throw new Error('VACUUM INTO 未产出有效文件');
  }
  fs.renameSync(dbTmp, dbDest);

  // 2) 打开快照数一遍 —— 这一步同时证明了「这份备份是可用的」
  const snap = new DatabaseSync(dbDest, { readOnly: true });
  const counts = {};
  try {
    for (const t of ['users', 'sessions', 'messages', 'snippets', 'files', 'boomerangs', 'group_notices', 'redactions']) {
      try {
        counts[t] = snap.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      } catch (e) {
        counts[t] = null; // 老版本库可能没有这张表
      }
    }
    try {
      counts.search_index = snap.prepare('SELECT COUNT(*) AS n FROM search_index').get().n;
    } catch (e) {
      counts.search_index = null;
    }
    counts.integrity = snap.prepare('PRAGMA integrity_check').get().integrity_check;
  } finally {
    snap.close();
  }

  // 3) 上传的原始文件是用户数据，必须一起备（exports 是导出产物，可再生，跳过）
  //    先清掉目标目录，避免同一秒内重跑时残留上一次的文件
  const uploadsDest = path.join(dir, 'uploads');
  fs.rmSync(uploadsDest, { recursive: true, force: true });
  const uploadsCount = copyDir(config.uploadsDir, uploadsDest);
  const uploadsSize = dirSize(uploadsDest);

  const manifest = {
    createdAt: now.toISOString(),
    stamp: path.basename(dir),
    sourceDb: config.dbPath,
    dbBytes: fs.statSync(dbDest).size,
    uploads: { count: uploadsCount, bytes: uploadsSize.bytes },
    counts,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const removed = rotate(outRoot, keep);
  return { dir, manifest, removed };
}

// 只删 backups/ 下形如 <时间戳> 的目录，且只删超出 keep 份的最旧那些。
// 严格限定在 outRoot 内，避免任何越界删除。
function rotate(outRoot, keep) {
  if (!fs.existsSync(outRoot)) return [];
  const dirs = fs
    .readdirSync(outRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const removed = [];
  while (dirs.length > keep) {
    const name = dirs.shift();
    const full = path.join(outRoot, name);
    if (path.dirname(full) !== path.resolve(outRoot)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      // 删不掉不算致命，别让备份整体失败
    }
  }
  return removed;
}

function formatBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(ROOT);
  const outRoot = path.resolve(args.out || path.join(ROOT, 'backups'));

  const { dir, manifest, removed } = runBackup({ config, outRoot, keep: args.keep });

  console.log('备份完成');
  console.log('  目录      : ' + dir);
  console.log('  数据库    : ' + formatBytes(manifest.dbBytes) + '（完整性 ' + manifest.counts.integrity + '）');
  console.log('  上传文件  : ' + manifest.uploads.count + ' 个 / ' + formatBytes(manifest.uploads.bytes));
  console.log('  记录数    : 用户 ' + manifest.counts.users +
    ' / 会话 ' + manifest.counts.sessions +
    ' / 消息 ' + manifest.counts.messages +
    ' / 片段 ' + manifest.counts.snippets +
    ' / 资料 ' + manifest.counts.files +
    ' / 索引 ' + manifest.counts.search_index);
  if (removed.length) console.log('  已轮转清理: ' + removed.join(', '));
  console.log('  保留份数  : ' + args.keep);

  if (manifest.counts.integrity !== 'ok') {
    console.error('⚠️  完整性检查未通过：' + manifest.counts.integrity);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('备份失败：' + (e.stack || e.message));
    process.exit(1);
  }
}

module.exports = { runBackup, rotate, stamp, sqlQuote, dirSize, copyDir, parseArgs };
