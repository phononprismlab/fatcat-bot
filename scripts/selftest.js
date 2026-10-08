'use strict';
// 自测：不连 QQ，用假客户端跑通 记录→捕获→存档→检索→导出→回旋镖 全链路
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRepo } = require('../src/repo');
const { createBot } = require('../src/core/bot');
const { startBoomerang } = require('../src/core/boomerang');
const { loadConfig } = require('../src/config');

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
  fontPath: loadConfig(root).fontPath,
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

  // 1b. 首次在某群开启记录前，应发一次知情同意公告
  const notice = sent.find((s) => s.to === 'group:' + G && s.m[0].data.text.includes('本群开始记录口嗨'));
  assert.ok(notice, '首次开记录应发知情同意公告');
  assert.ok(notice.m[0].data.text.includes('含其他人'), '公告应说明会捕获他人发言');
  assert.ok(notice.m[0].data.text.includes('/撤回我的发言'), '公告应告知撤回方式');
  assert.ok(repo.hasGroupNotice(G), '应记录该群已告知');
  console.log('✓ 群内知情同意公告');

  // 2. 检索（结果走私聊，群里只留一句提示）
  await bot.handleEvent(ev(A, '多米尼卡', '/查询 陆行鸟'));
  const qPriv = sent.filter((s) => s.to === 'private:' + A).pop();
  assert.ok(qPriv.m[0].data.text.includes('陆行鸟'), '查询结果应私聊发回');
  assert.ok(qPriv.m[0].data.text.includes('[口嗨#'), '查询结果应带类型与编号');
  const qGroup = sent.filter((s) => s.to === 'group:' + G).pop();
  assert.ok(!qGroup.m[0].data.text.includes('陆行鸟'), '查询结果不应贴到群里');
  assert.ok(qGroup.m[0].data.text.includes('私聊'), '群里应提示已发私聊');
  console.log('✓ 中文全文检索（结果走私聊，群内不泄漏）');

  // 2b. 总结也要能被搜到（kind=summary 单独入索引）
  db.prepare('UPDATE snippets SET summary = ? WHERE id = ?').run('独特词汇：鲸落灯塔', snips[0].id);
  repo.indexAdd('独特词汇：鲸落灯塔', A, 'summary', snips[0].id);
  const hitsSummary = repo.search(A, '鲸落灯塔');
  assert.ok(hitsSummary.some((h) => h.kind === 'summary'), '总结内容应可被检索且标注为 summary');
  console.log('✓ 总结单独入索引');

  // 3. 统计（同样走私聊）
  await bot.handleEvent(ev(A, '多米尼卡', '/我的'));
  const minePriv = sent.filter((s) => s.to === 'private:' + A).pop();
  assert.ok(minePriv.m[0].data.text.includes('1 篇'), '统计应显示 1 篇');
  console.log('✓ 统计');

  // 3b. 帮助文案要列全指令
  await bot.handleEvent(ev(A, '多米尼卡', '/帮助'));
  const help = sent.filter((s) => s.to === 'group:' + G).pop().m[0].data.text;
  ['/查询', '/导出', '/回旋镖', '/总结', '/我的', '/撤回我的发言', '/帮助'].forEach((c) =>
    assert.ok(help.includes(c), `帮助应列出 ${c}`)
  );
  console.log('✓ 帮助列出全部指令');

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

  // 4c. 编码回退：GBK/GB18030 的中文 txt 不能变乱码
  const { ingestBytes, decodeText } = require('../src/core/upload');
  const gbkBuf = Buffer.from([0xc2, 0xde, 0xc9, 0xaf, 0xca, 0xc7]); // "罗莎是" 的 GBK 字节
  const dec = decodeText(gbkBuf);
  assert.equal(dec.encoding, 'gb18030', '非法 UTF-8 应回退 gb18030');
  assert.ok(dec.text.startsWith('罗莎'), `GBK 应正确解码（实际「${dec.text}」）`);
  const rGbk = ingestBytes({ config, repo, userId: A, filename: 'gbk资料.txt', buffer: gbkBuf });
  assert.equal(rGbk.ok, true, 'GBK 文件应被收录');
  assert.equal(rGbk.encoding, 'gb18030', '回执应说明用了 gb18030');
  assert.ok(repo.listFiles(A).some((f) => f.content_text.startsWith('罗莎')), 'GBK 正文应正确入库');
  // UTF-8 BOM 应被剥掉
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM的正文', 'utf8')]);
  assert.equal(decodeText(bom).text, '带BOM的正文', 'UTF-8 BOM 应被剥离');
  console.log('✓ 编码回退（GBK/GB18030 + BOM）');

  // 4d. 单用户配额
  const rQuota = ingestBytes({
    config: { ...config, userQuotaChars: 5 }, repo, userId: A,
    filename: 'too-big.txt', buffer: Buffer.from('这是一段远超五个字的正文', 'utf8'),
  });
  assert.equal(rQuota.ok, false, '超出配额应被拒绝');
  assert.ok(rQuota.reason.includes('资料库已满'), '拒绝理由应说明配额');
  console.log('✓ 单用户存储配额');

  // 5. 导出（1 片段 + 2 资料 = 3 篇 -> zip）
  await bot.handleEvent(ev(A, '多米尼卡', '/导出 txt all'));
  const exp = sent.find((s) => s.to === 'file:' + A);
  assert.ok(exp, '应触发文件发送');
  assert.ok(exp.name.endsWith('.zip'), '多篇应打包 zip');
  assert.ok(fs.existsSync(exp.file) && fs.statSync(exp.file).size > 0, 'zip 文件应存在且非空');
  console.log('✓ 导出并打包 zip ->', path.basename(exp.file));

  // 5b. PDF 导出（走同一条 buildExport 路径）
  const { buildExport } = require('../src/core/export');
  const pdfRes = await buildExport({ config, repo, userId: A, format: 'pdf', scope: 'all' });
  if (config.fontPath) {
    assert.equal(pdfRes.format, 'pdf', '探测到字体时应产出 pdf');
    assert.ok(pdfRes.files.every((f) => f.endsWith('.pdf')), '导出文件应为 .pdf');
    const buf = fs.readFileSync(pdfRes.files[0]);
    assert.equal(buf.subarray(0, 8).toString('latin1'), '%PDF-1.7', 'PDF 文件头');
    assert.ok(buf.toString('latin1').trimEnd().endsWith('%%EOF'), 'PDF 文件尾');
    assert.ok(buf.includes(Buffer.from('/CIDFontType2')), 'PDF 内嵌 CID 字体');
    assert.ok(buf.includes(Buffer.from('/ToUnicode')), 'PDF 带 ToUnicode');
    assert.ok(buf.includes(Buffer.from('/Kids [')), 'PDF 有页面树');
    const kb = fs.statSync(pdfRes.files[0]).size / 1024;
    assert.ok(kb < 400, `单篇 PDF 体积应远小于原字体（实际 ${kb.toFixed(1)}KB）`);
    // 说话者着色：同一份文档内不同说话者应拿到不同颜色（按出现顺序分配，不靠哈希）
    const zlib = require('node:zlib');
    const raw = buf.toString('latin1');
    const colors = new Set();
    for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      let txt;
      try { txt = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (e) { continue; }
      for (const c of txt.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)) colors.add(`${c[1]},${c[2]},${c[3]}`);
    }
    assert.ok(colors.size >= 3, `应有多种填充色（正文 + 至少两个说话者色），实际 ${colors.size}`);
    console.log(`✓ PDF 导出（子集化生效，${kb.toFixed(1)}KB，${colors.size} 种填充色）->`, pdfRes.files.map((f) => path.basename(f)).join(', '));
  } else {
    assert.equal(pdfRes.format, 'txt', '未探测到字体时应回退 txt');
    assert.ok(pdfRes.note.includes('回退'), '回退应带说明');
    console.log('✓ PDF 无字体时回退 txt（本机未探测到中文字体）');
  }

  // 5c. 按编号导出（范围语法 #N / 片段N / 资料N）
  const byId = await buildExport({ config, repo, userId: A, format: 'txt', scope: '#' + snips[0].id });
  assert.ok(!byId.error, '按编号导出不应报错');
  assert.equal(byId.count, 1, '按编号应只导出 1 篇');
  assert.equal(byId.scopeNote, '仅口嗨片段 #' + snips[0].id, '片段与资料 ID 同号时应优先片段');
  assert.ok(byId.files[0].includes('片段' + snips[0].id + '_'), '文件名应含片段编号');

  const bySnip = await buildExport({ config, repo, userId: A, format: 'txt', scope: '片段' + snips[0].id });
  assert.equal(bySnip.count, 1, '片段N 应只导出该片段');
  const byFile = await buildExport({ config, repo, userId: A, format: 'txt', scope: '资料' + filesA[0].id });
  assert.equal(byFile.count, 1, '资料N 应只导出该资料');

  const missing = await buildExport({ config, repo, userId: A, format: 'txt', scope: '#999999' });
  assert.ok(missing.error && missing.error.includes('999999'), '不存在的编号应返回可读错误');
  console.log('✓ 按编号导出（#N / 片段N / 资料N / 不存在编号）');

  // 5d. 超长文件名不应撞名（截断后附加内容哈希，且保留扩展名）
  const { sanitizeFilename } = require('../src/utils/filenames');
  const longA = '同名前缀'.repeat(60) + 'A.txt';
  const longB = '同名前缀'.repeat(60) + 'B.txt';
  const nA = sanitizeFilename(longA, '内容A');
  const nB = sanitizeFilename(longB, '内容B');
  assert.notEqual(nA, nB, '前缀相同的长名不应撞名');
  assert.ok(nA.endsWith('.txt'), '截断后应保留扩展名');
  assert.ok(Buffer.byteLength(nA, 'utf8') <= 200, '净化后不应超过 200 字节');
  assert.equal(sanitizeFilename(longA, '内容A'), nA, '同一输入应稳定');
  console.log('✓ 超长文件名哈希兜底');

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

  // 6b. 回旋镖应留发送历史（boomerangs 表）
  const hist = repo.listBoomerangHistory({ qqId: A });
  assert.ok(hist.length >= 1, '回旋镖应写入发送历史');
  assert.equal(hist[0].target_type, 'snippet', '历史应记录目标类型');
  assert.equal(repo.countBoomerangSent() >= 1, true, '应能统计累计发送数');
  console.log('✓ 回旋镖发送历史');

  // 6c. 回旋镖不应饿死资料：片段与资料按最早未推送时间统一排序
  const oldTs = Date.now() - 30 * 86400000;
  db.prepare('UPDATE snippets SET created_at = ?, last_sent = NULL WHERE id = ?').run(Date.now(), snips[0].id);
  db.prepare('UPDATE files SET uploaded_at = ?, last_sent = NULL WHERE id = ?').run(oldTs, filesA[0].id);
  const cand = repo.pickBoomerangCandidate(A, Date.now() - 86400000);
  assert.ok(cand && cand.kind === 'file', `更早的资料应优先于较新的片段（实际 ${cand && cand.kind}）`);
  console.log('✓ 回旋镖跨类型统一排序（资料不再被饿死）');

  // 7. 撤回：群里的第三方可以删掉自己在本群被记录的发言（真删 + 重建索引）
  await bot.handleEvent(ev(B, '希斯', '/撤回我的发言'));
  const afterRedact = repo.getMessages(snips[0].session_id);
  assert.ok(!afterRedact.some((m) => m.qq_id === B), '希斯自己的发言应被删除');
  assert.ok(afterRedact.some((m) => m.qq_id === A), '记录者的发言应保留');
  assert.ok(!repo.search(A, '甩进海里').some((h) => h.kind === 'snippet'), '被删内容不应还能被检索到');
  assert.ok(repo.listRedactions().length >= 1, '应留撤回审计记录');
  console.log('✓ 第三方撤回自己的发言（真删 + 索引重建 + 审计）');

  // 7b. 记录者本人也能撤回自己的发言
  await bot.handleEvent(ev(A, '多米尼卡', '/撤回我的发言'));
  const afterRedact2 = repo.getMessages(snips[0].session_id);
  assert.ok(!afterRedact2.some((m) => m.qq_id === A), '记录者撤回后自己的发言也应删除');
  assert.ok(!repo.search(A, '旅行').some((h) => h.kind === 'snippet'), '记录者被删内容也不应可检索');
  console.log('✓ 记录者撤回自己的发言');

  // 7c. 没有可撤回内容时应给出友好提示
  await bot.handleEvent(ev(A, '多米尼卡', '/撤回我的发言'));
  assert.ok(sent.filter((s) => s.to === 'group:' + G).pop().m[0].data.text.includes('没有你的被记录发言'), '无内容时应提示');
  console.log('✓ 无内容时撤回提示');

  // 7d. 撤回指令只在群里可用
  await bot.handleEvent(ev(A, '多米尼卡', '/撤回我的发言', false));
  assert.ok(sent.filter((s) => s.to === 'private:' + A).pop().m[0].data.text.includes('要在群里用'), '私聊使用应被引导');
  console.log('✓ 撤回指令限定群聊');

  // 7e. /上传 引导
  await bot.handleEvent(ev(A, '多米尼卡', '/上传'));
  const upHelp = sent.filter((s) => s.to === 'group:' + G).pop().m[0].data.text;
  assert.ok(upHelp.includes('txt') && upHelp.includes('2MB'), '/上传 应给出格式与大小说明');
  console.log('✓ /上传 引导');

  // 7f. 同一群不重复发知情同意公告
  const noticeBefore = sent.filter((s) => s.to === 'group:' + G && s.m[0].data.text.includes('本群开始记录口嗨')).length;
  await bot.handleEvent(ev(A, '多米尼卡', '我要口嗨了！'));
  await bot.handleEvent(ev(A, '多米尼卡', '我口嗨完了！'));
  const noticeAfter = sent.filter((s) => s.to === 'group:' + G && s.m[0].data.text.includes('本群开始记录口嗨')).length;
  assert.equal(noticeAfter, noticeBefore, '同一群不应重复发公告');
  console.log('✓ 知情同意公告每群只发一次');

  console.log('\nSELFTEST PASS');
  console.log('导出目录：', fs.readdirSync(config.exportsDir).join(', '));
  db.close();
})().catch((e) => {
  console.error('\nSELFTEST FAIL:', e.stack || e.message);
  process.exit(1);
});
