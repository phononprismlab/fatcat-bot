'use strict';
// 自测：不连 QQ，用假客户端跑通 记录→捕获→存档→检索→导出→回旋镖 全链路
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRepo } = require('../src/repo');
const { createBot } = require('../src/core/bot');
const { startBoomerang } = require('../src/core/boomerang');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data', '_selftest');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const config = {
  rootDir: root,
  dataDir,
  dbPath: path.join(dataDir, 't.db'),
  exportsDir: path.join(dataDir, 'exports'),
  uploadsDir: path.join(dataDir, 'uploads'),
  onebot: { wsUrl: '', accessToken: '', echoTimeoutMs: 1000 },
  commandPrefix: '/',
  startPhrase: '我要口嗨了',
  endPhrase: '我口嗨完了',
  llm: { baseUrl: '', apiKey: '', model: '' },
  boomerangDefaultDays: 3,
};

const db = openDb(config.dbPath);
const repo = createRepo(db);

const sent = [];
const client = {
  async sendGroupMsg(g, m) { sent.push({ to: 'group:' + g, m }); return {}; },
  async sendPrivateMsg(u, m) { sent.push({ to: 'private:' + u, m }); return {}; },
  async uploadPrivateFile(u, p, n) { sent.push({ to: 'file:' + u, file: p, name: n }); return {}; },
  // 模拟 NapCat get_file：把文件段解析成本地路径
  async getFile() { return { status: 'ok', retcode: 0, data: { file: path.join(dataDir, 'upload_src.txt') } }; },
};

const bot = createBot({ config, repo, client });

const A = '10001';
const B = '10002';
const G = '90001';
const ev = (uid, name, text, isGroup = true) => ({
  post_type: 'message',
  message_type: isGroup ? 'group' : 'private',
  group_id: isGroup ? Number(G) : undefined,
  user_id: Number(uid),
  sender: { nickname: name },
  time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text } }],
});

(async () => {
  // 1. 记录
  await bot.handleEvent(ev(A, '多米尼卡', '我要口嗨了！'));
  await bot.handleEvent(ev(A, '多米尼卡', '我想让罗莎穿陆行鸟衣服去旅行'));
  await bot.handleEvent(ev(B, '希斯', '然后陆行鸟把她甩进海里了'));
  await bot.handleEvent(ev(A, '多米尼卡', '我口嗨完了！'));

  const snips = repo.listSnippets(A);
  assert.equal(snips.length, 1, '应生成 1 个片段');
  const msgs = repo.getMessages(snips[0].session_id);
  assert.equal(msgs.length, 2, '应捕获 2 条发言');
  assert.equal(msgs[0].is_recorder, 1, '第一条应为记录者');
  assert.equal(msgs[1].name, '希斯', '第二条应为希斯所说（跨说话者捕获）');
  console.log('✓ 记录与多人捕获');

  // 2. 检索
  await bot.handleEvent(ev(A, '多米尼卡', '/查询 陆行鸟'));
  const q = sent[sent.length - 1];
  assert.ok(q.m[0].data.text.includes('陆行鸟'), '查询应命中陆行鸟');
  console.log('✓ 中文全文检索');

  // 3. 统计
  await bot.handleEvent(ev(A, '多米尼卡', '/我的'));
  assert.ok(sent[sent.length - 1].m[0].data.text.includes('1 篇'), '统计应显示 1 篇');
  console.log('✓ 统计');

  // 4. 文件上传解析（走 OneBot 文件段 -> get_file -> 读取 -> 入库）
  fs.writeFileSync(path.join(dataDir, 'upload_src.txt'), '罗莎是海上的旅人，与陆行鸟相依为命。', 'utf8');
  await bot.handleEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: Number(G),
    user_id: Number(A),
    sender: { nickname: '多米尼卡' },
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'file', data: { file_id: 'f1', name: '先进个人OC.txt' } }],
  });
  const filesA = repo.listFiles(A);
  assert.equal(filesA.length, 1, '应收录 1 份资料');
  assert.ok(filesA[0].content_text.includes('陆行鸟'), '资料内容应入库');
  assert.ok(fs.existsSync(filesA[0].path), '原文件应落盘');
  const hitsFile = repo.search(A, '旅人');
  assert.ok(hitsFile.some((h) => h.kind === 'file'), '资料应可被检索');
  console.log('✓ 文件上传解析 + 可检索');

  // 4b. 不支持的格式应被拒绝
  fs.writeFileSync(path.join(dataDir, 'bad.pdf'), '%PDF-1.4', 'utf8');
  const r = require('../src/core/upload').ingestBytes({
    config, repo, userId: A, filename: 'x.pdf', buffer: fs.readFileSync(path.join(dataDir, 'bad.pdf')),
  });
  assert.equal(r.ok, false, 'pdf 应被拒绝');
  console.log('✓ 非文本格式拦截');

  // 5. 导出（1 片段 + 1 资料 = 2 篇 -> zip）
  await bot.handleEvent(ev(A, '多米尼卡', '/导出 txt all'));
  const exp = sent.find((s) => s.to === 'file:' + A);
  assert.ok(exp, '应触发文件发送');
  assert.ok(exp.name.endsWith('.zip'), '多篇应打包 zip');
  assert.ok(fs.existsSync(exp.file) && fs.statSync(exp.file).size > 0, 'zip 文件应存在且非空');
  console.log('✓ 导出并打包 zip ->', path.basename(exp.file));

  // 6. 回旋镖
  const old = Date.now() - 10 * 86400000;
  db.prepare('UPDATE snippets SET created_at = ? WHERE id = ?').run(old, snips[0].id);
  const bo = startBoomerang({ config, repo, client });
  await bo.run();
  bo.stop();
  assert.ok(
    sent.some((s) => s.to === 'private:' + A && String(s.m[0].data.text).includes('回旋镖')),
    '回旋镖应私聊推送'
  );
  console.log('✓ 回旋镖推送');

  console.log('\nSELFTEST PASS');
  console.log('导出目录：', fs.readdirSync(config.exportsDir).join(', '));
  db.close();
})().catch((e) => {
  console.error('\nSELFTEST FAIL:', e.stack || e.message);
  process.exit(1);
});
