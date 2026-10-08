'use strict';
// 起一个带样例数据的管理台，方便先看看长什么样（不连 QQ、不动真实数据）
// 用法：node --experimental-sqlite scripts/admindemo.js
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createRepo } = require('../src/repo');
const { createAdminServer } = require('../src/admin/server');
const { createMonitor } = require('../src/monitor');
const { loadConfig } = require('../src/config');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data', '_demo');
const PORT = Number(process.env.DEMO_PORT || 8799);
const TOKEN = process.env.DEMO_TOKEN || 'demo';

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const base = loadConfig(root);
const config = {
  rootDir: root,
  dataDir,
  dbPath: path.join(dataDir, 'demo.db'),
  exportsDir: path.join(dataDir, 'exports'),
  uploadsDir: path.join(dataDir, 'uploads'),
  fontPath: base.fontPath,
  onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', echoTimeoutMs: 15000 },
  commandPrefix: '/',
  startPhrase: '我要口嗨了',
  endPhrase: '我口嗨完了',
  llm: { baseUrl: '', apiKey: '', model: '' },
  boomerangDefaultDays: 3,
  admin: { host: '127.0.0.1', port: PORT, token: TOKEN, sessionTtlMs: 12 * 3600000, only: true },
  monitor: { enabled: true, webhookUrl: '', intervalMs: 120000, cooldownMs: 1800000 },
};

const db = openDb(config.dbPath);
const repo = createRepo(db);
const DAY = 86400000;
const now = Date.now();

const U = {
  dom: '10001',
  shuo: '10002',
  xian: '10003',
  xi: '10004',
  evil: '10005',
};
repo.upsertUser(U.dom, '多米尼卡');
repo.upsertUser(U.shuo, '朔子');
repo.upsertUser(U.xian, '先进个人');
repo.upsertUser(U.xi, '希斯');
// 故意塞 XSS 载荷，用来验证管理台的转义是否到位
repo.upsertUser(U.evil, '<img src=x onerror="globalThis.__pwned=1">');

const GROUP = '887766554';

// ---- 会话 1：已归档 ----
const s1 = repo.createSession(U.dom, GROUP);
db.prepare('UPDATE sessions SET start_time = ?, end_time = ?, status = ? WHERE id = ?')
  .run(now - 9 * DAY, now - 9 * DAY + 3600000, 'archived', s1);
const chat1 = [
  [U.dom, '多米尼卡', '我要口嗨了，今天想个新OC', 0],
  [U.shuo, '朔子', '什么设定', 40000],
  [U.dom, '多米尼卡', '叫「回旋镖」，本体是一只被时间扔出去又扔回来的水母，每次回来都会忘记一件事', 90000],
  [U.xian, '先进个人', '那她的记忆是怎么留下来的', 150000],
  [U.dom, '多米尼卡', '靠别人替她记。所以她在每个停留过的地方都会留一个信物', 200000],
  [U.xi, '希斯', '这个设定好适合写成那种一段一段的短篇', 260000],
  [U.shuo, '朔子', '而且她忘记的应该是「最重要的事」，不是随便忘', 320000],
  [U.dom, '多米尼卡', '对，就是这样。我口嗨完了', 380000],
];
for (const [qq, name, content, off] of chat1) {
  repo.addMessage(s1, qq, name, content, now - 9 * DAY + off, qq === U.dom);
}
const sn1 = repo.createSnippet(s1, U.dom,
  '多米尼卡提出新 OC「回旋镖」：本体是一只被时间抛出又抛回的水母，每次回归都会遗忘一件事，' +
  '但遗忘的总是最重要的事。她靠沿途留下的信物、由他人替她保管记忆。' +
  '朔子补充「遗忘的必须是最重要的」，希斯认为适合写成短篇。');
repo.indexAdd(chat1.map((m) => m[2]).join('\n'), U.dom, 'snippet', sn1);
repo.indexAdd('多米尼卡提出新 OC「回旋镖」：本体是一只被时间抛出又抛回的水母', U.dom, 'summary', sn1);
db.prepare('UPDATE snippets SET created_at = ?, last_sent = ? WHERE id = ?').run(now - 9 * DAY, now - 4 * DAY, sn1);
// 回旋镖发送历史
repo.addBoomerangRecord(U.dom, sn1, 'snippet');
repo.addBoomerangRecord(U.dom, sn1, 'snippet');

// ---- 会话 2：已归档 ----
const s2 = repo.createSession(U.shuo, GROUP);
db.prepare('UPDATE sessions SET start_time = ?, end_time = ?, status = ? WHERE id = ?')
  .run(now - 2 * DAY, now - 2 * DAY + 1800000, 'archived', s2);
const chat2 = [
  [U.shuo, '朔子', '我要口嗨了', 0],
  [U.shuo, '朔子', '想写一个「店还开着，但鱼缸空了一半」的场景', 30000],
  [U.dom, '多米尼卡', '为什么是空了一半', 70000],
  [U.shuo, '朔子', '因为老板年纪大了，观赏鱼的生意做不动了，但店舍不得关', 120000],
  [U.xi, '希斯', '那这个店其实是个据点，不是生意', 170000],
];
for (const [qq, name, content, off] of chat2) {
  repo.addMessage(s2, qq, name, content, now - 2 * DAY + off, qq === U.shuo);
}
const sn2 = repo.createSnippet(s2, U.shuo,
  '朔子提出场景：老水族店还开着但鱼缸空了一半——老板做不动观赏鱼生意却舍不得关门。' +
  '希斯点出这家店本质是「据点」而非生意。');
repo.indexAdd(chat2.map((m) => m[2]).join('\n'), U.shuo, 'snippet', sn2);
repo.indexAdd('朔子提出场景：老水族店还开着但鱼缸空了一半', U.shuo, 'summary', sn2);
db.prepare('UPDATE snippets SET created_at = ? WHERE id = ?').run(now - 2 * DAY, sn2);

// ---- 会话 3：进行中 ----
const s3 = repo.createSession(U.xian, GROUP);
repo.addMessage(s3, U.xian, '先进个人', '我要口嗨了，接着上次那个星轨的设定', now - 300000, true);
repo.addMessage(s3, U.dom, '多米尼卡', '上次讲到她第一次看到星轨', now - 240000, false);
repo.addMessage(s3, U.xian, '先进个人', '对，我这次想让她发现星轨其实是别人留下的信物', now - 120000, true);

// ---- 资料 ----
const files = [
  [U.xian, '先进个人', '回旋镖设定集.txt', 'OC「回旋镖」完整设定：\n\n本体：被时间抛出又抛回的水母。\n能力：每次回归会遗忘一件最重要的事。\n信物：沿途留下的小物件，由他人保管。\n主题：记忆需要有人替你收着。\n'],
  [U.dom, '多米尼卡', '2026-09 群口嗨合集.txt', '九月群口嗨节选：\n\n· 星轨其实是别人留下的信物\n· 老水族店是个据点\n· 水母每次回来都会忘一件事\n'],
];
for (const [qq, name, filename, text] of files) {
  const dir = path.join(config.uploadsDir, qq);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, filename);
  fs.writeFileSync(p, text, 'utf8');
  const id = repo.addFile(qq, filename, p, text);
  repo.indexAdd(text, qq, 'file', id);
  db.prepare('UPDATE files SET uploaded_at = ? WHERE id = ?').run(now - 6 * DAY, id);
}

// ---- 一条带 XSS 的消息（验证渲染转义）----
repo.addMessage(s3, U.evil, '<img src=x onerror="globalThis.__pwned=1">',
  '<script>globalThis.__pwned=2</script> <img src=x onerror="globalThis.__pwned=3">', now - 60000, false);

// ---- 会话 4：另一个群，用于演示「撤回我的发言」（希斯撤回自己在那个群的发言）----
const GROUP2 = '887766555';
const s4 = repo.createSession(U.shuo, GROUP2);
db.prepare('UPDATE sessions SET start_time = ?, end_time = ?, status = ? WHERE id = ?')
  .run(now - 5 * DAY, now - 5 * DAY + 600000, 'archived', s4);
repo.addMessage(s4, U.shuo, '朔子', '我再补一句关于夜胧月的设定', now - 5 * DAY, true);
repo.addMessage(s4, U.xi, '希斯', '这句我后来觉得不太好，想删掉', now - 5 * DAY + 60000, false);
repo.deleteMessagesByUserInGroup(U.xi, GROUP2);

(async () => {
  const admin = createAdminServer({ config, repo, client: null, boomerang: null, monitor: createMonitor({ config, client: null }), startedAt: now - 3 * 3600000 });
  const addr = await admin.start();
  console.log('样例管理台已启动');
  console.log(`  地址：http://127.0.0.1:${addr.port}/`);
  console.log(`  口令：${TOKEN}`);
  console.log('  数据：5 位用户 / 4 个会话 / 2 个片段 / 2 份资料 / 1 个进行中会话 / 2 条回旋镖历史 / 1 条撤回审计');
  console.log('  按 Ctrl+C 结束');
  const stop = () => { admin.stop().then(() => { try { db.close(); } catch (e) {} process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => {
  console.error('启动失败：' + (e.stack || e.message));
  process.exit(1);
});
