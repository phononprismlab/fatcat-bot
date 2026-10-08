'use strict';
// 管理台自测：起一个临时端口 + 临时库，把 /api/* 全跑一遍（不连 QQ）
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRepo } = require('../src/repo');
const { createAdminServer } = require('../src/admin/server');
const { loadConfig } = require('../src/config');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data', '_admintest');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const base = loadConfig(root);
const config = {
  rootDir: root,
  dataDir,
  dbPath: path.join(dataDir, 't.db'),
  exportsDir: path.join(dataDir, 'exports'),
  uploadsDir: path.join(dataDir, 'uploads'),
  fontPath: base.fontPath,
  onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'secret-token', echoTimeoutMs: 1000 },
  commandPrefix: '/',
  startPhrase: '我要口嗨了',
  endPhrase: '我口嗨完了',
  llm: { baseUrl: '', apiKey: '', model: '' },
  boomerangDefaultDays: 3,
  admin: { host: '127.0.0.1', port: 0, token: 'test-token-123', sessionTtlMs: 3600000, only: true },
};

const TOKEN = 'test-token-123';
const A = '10001';
const B = '10002';
const XSS = '<img src=x onerror="globalThis.__pwned=1">';

const db = openDb(config.dbPath);
const repo = createRepo(db);

// ---- 造数据 ----
repo.upsertUser(A, '多米尼卡');
repo.upsertUser(B, XSS); // 昵称里塞 XSS 载荷，供浏览器端验收用

const s1 = repo.createSession(A, '88888');
repo.addMessage(s1, A, '多米尼卡', '我要开始口嗨了，主角叫回旋镖', Date.now() - 300000, true);
repo.addMessage(s1, B, XSS, '那我接一句 <script>globalThis.__pwned=2</script>', Date.now() - 290000, false);
repo.addMessage(s1, A, '多米尼卡', '设定是能穿越时间的水母', Date.now() - 280000, true);

const s2 = repo.createSession(B, '88888'); // 故意留一个进行中的会话
repo.addMessage(s2, B, '希斯', '另一个进行中的记录', Date.now() - 1000, true);

const sn1 = repo.createSnippet(s1, A, '关于回旋镖与水母的脑洞');
repo.indexAdd('多米尼卡(10001) 我要开始口嗨了，主角叫回旋镖', A, 'snippet', sn1);

const uploadPath = path.join(config.uploadsDir, A, 'oc.txt');
fs.mkdirSync(path.dirname(uploadPath), { recursive: true });
fs.writeFileSync(uploadPath, '先进个人的OC设定正文，包含关键词：星轨', 'utf8');
const f1 = repo.addFile(A, 'oc设定.txt', uploadPath, '先进个人的OC设定正文，包含关键词：星轨');
repo.indexAdd('先进个人的OC设定正文，包含关键词：星轨', A, 'file', f1);

// 回旋镖只挑「够旧」的内容，把种子数据做旧 10 天
const OLD = Date.now() - 10 * 86400000;
db.prepare('UPDATE snippets SET created_at = ? WHERE id = ?').run(OLD, sn1);
db.prepare('UPDATE files SET uploaded_at = ? WHERE id = ?').run(OLD, f1);

// 预置一条回旋镖发送历史，供管理台接口断言
repo.addBoomerangRecord(A, sn1, 'snippet');

// ---- HTTP 客户端（手动管 cookie）----
let cookie = '';
let origin = '';

async function req(p, opts = {}) {
  const res = await fetch(origin + p, Object.assign({}, opts, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}, opts.headers || {}),
    redirect: 'manual',
  }));
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res;
}
const getJson = async (p) => {
  const r = await req(p);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const sendJson = async (p, method, body) => {
  const r = await req(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const admin = createAdminServer({ config, repo, client: null, boomerang: null, startedAt: Date.now() - 61000 });
  const addr = await admin.start();
  origin = `http://127.0.0.1:${addr.port}`;
  console.log(`管理台测试服务：${origin}\n`);

  // 1. 未登录
  let r = await getJson('/api/overview');
  assert.equal(r.status, 401, '未登录应 401');
  console.log('✓ 未登录访问受保护接口 -> 401');

  r = await getJson('/api/session');
  assert.equal(r.body.authed, false, '未登录 authed=false');
  console.log('✓ /api/session 未登录返回 authed=false');

  // 2. 前端页面可访问
  const ui = await req('/');
  assert.equal(ui.status, 200, '首页应 200');
  assert.ok((ui.headers.get('content-type') || '').includes('text/html'), '首页应是 html');
  const uiText = await ui.text();
  assert.ok(uiText.includes('管理台') && uiText.includes('id="login-form"'), '首页应包含登录与管理台标记');
  assert.ok(uiText.includes("api('/login'"), '首页应包含登录调用');
  assert.ok(!/document\.write/.test(uiText), '页面不应有 document.write');
  assert.ok(uiText.includes('const esc ='), '首页应内置转义函数');
  console.log(`✓ 首页可访问（${(uiText.length / 1024).toFixed(1)} KB html）`);

  // 3. 错误口令
  r = await sendJson('/api/login', 'POST', { token: 'wrong' });
  assert.equal(r.status, 401, '错误口令应 401');
  assert.ok(!cookie || cookie === 'fatcat_admin=', '错误口令不应下发有效 cookie');
  console.log('✓ 错误口令 -> 401，不下发 cookie');

  // 4. 正确口令
  r = await sendJson('/api/login', 'POST', { token: TOKEN });
  assert.equal(r.status, 200, '正确口令应 200');
  assert.ok(cookie.startsWith('fatcat_admin='), '应下发会话 cookie');
  console.log('✓ 正确口令 -> 200 + 会话 cookie');

  r = await getJson('/api/session');
  assert.equal(r.body.authed, true, '登录后 authed=true');
  console.log('✓ 登录后 /api/session authed=true');

  // 5. 概览
  r = await getJson('/api/overview');
  assert.equal(r.status, 200, '概览应 200');
  const ov = r.body;
  assert.equal(ov.data.users, 2, '用户数');
  assert.equal(ov.data.sessions, 2, '会话数');
  assert.equal(ov.data.openSessions, 2, '进行中会话数');
  assert.equal(ov.data.messages, 4, '消息数');
  assert.equal(ov.data.snippets, 1, '片段数');
  assert.equal(ov.data.files, 1, '资料数');
  assert.equal(ov.bot.mode, 'admin-only', '纯管理台模式');
  assert.ok(ov.disk.db > 0, '应统计数据库体积');
  assert.ok(ov.process.uptimeMs >= 60000, '运行时长');
  console.log(`✓ 概览统计正确（用户 2 / 会话 2 / 消息 4 / 片段 1 / 资料 1，DB ${(ov.disk.db / 1024).toFixed(0)}KB）`);

  // 6. 配置（敏感字段必须打码）
  r = await getJson('/api/config');
  assert.equal(r.status, 200, '配置应 200');
  const cfgText = JSON.stringify(r.body);
  assert.ok(!cfgText.includes('secret-token'), 'OneBot access token 不应明文返回');
  assert.ok(!cfgText.includes(TOKEN), '管理台口令不应返回');
  assert.ok(r.body.onebot.accessToken.includes('已设置'), 'token 应显示为已设置');
  console.log('✓ 配置接口不泄漏明文密钥');

  // 7. 日志
  r = await getJson('/api/logs?limit=10');
  assert.equal(r.status, 200, '日志应 200');
  assert.ok(Array.isArray(r.body.logs), 'logs 应为数组');
  console.log(`✓ 日志接口返回 ${r.body.logs.length} 条（内存环形缓冲）`);

  // 8. 会话列表 / 详情 / 筛选
  r = await getJson('/api/sessions');
  assert.equal(r.body.items.length, 2, '会话列表');
  assert.equal(r.body.items[0].message_count, 1, '会话消息数');

  r = await getJson('/api/sessions?status=open');
  assert.equal(r.body.items.length, 2, '按 open 筛选');
  assert.equal(r.body.items[0].id, s2, '最新一条在前');
  console.log('✓ 会话列表 / 状态筛选正确');

  r = await getJson(`/api/sessions/${s1}`);
  assert.equal(r.status, 200, '会话详情应 200');
  assert.equal(r.body.messages.length, 3, '会话消息数');
  assert.equal(r.body.messages[0].content, '我要开始口嗨了，主角叫回旋镖', '消息内容原样返回');
  assert.equal(r.body.truncated, false, '未截断');
  console.log('✓ 会话详情含完整消息');

  // 9. 强制结束会话 -> 生成片段（不调大模型）
  r = await sendJson(`/api/sessions/${s2}/archive`, 'POST', { summarize: false });
  assert.equal(r.status, 200, '结束会话应 200');
  assert.ok(r.body.snippetId > 0, '应生成片段');
  assert.equal(r.body.messageCount, 1, '片段消息数');
  const newSnippet = r.body.snippetId;

  r = await sendJson(`/api/sessions/${s2}/archive`, 'POST', { summarize: false });
  assert.equal(r.status, 400, '重复结束应 400');
  console.log('✓ 强制结束会话 -> 生成片段，重复结束被拒');

  // 10. 片段列表 / 详情
  r = await getJson('/api/snippets');
  assert.equal(r.body.items.length, 2, '片段列表');
  assert.ok(r.body.items.some((s) => s.summary_head.includes('回旋镖')), '列表带总结摘要');
  console.log('✓ 片段列表带摘要');

  r = await getJson(`/api/snippets/${sn1}`);
  assert.equal(r.body.messages.length, 3, '片段详情含消息');
  assert.equal(r.body.summary, '关于回旋镖与水母的脑洞', '片段详情含总结');
  console.log('✓ 片段详情含消息与总结');

  // 11. 重新生成总结（未配置 LLM 应明确报错而不是清空）
  r = await sendJson(`/api/snippets/${sn1}/resummarize`, 'POST');
  assert.equal(r.status, 400, '未配置 LLM 应 400');
  assert.ok(r.body.error.includes('LLM'), '错误信息应提示配置 LLM');
  r = await getJson(`/api/snippets/${sn1}`);
  assert.equal(r.body.summary, '关于回旋镖与水母的脑洞', '原总结不应被清空');
  console.log('✓ 未配置 LLM 时重新生成总结被拒且不清空原总结');

  // 12. 检索（含删除后索引清理）
  r = await getJson('/api/search?q=' + encodeURIComponent('回旋镖'));
  assert.ok(r.body.items.length >= 1, '应能搜到片段');
  assert.ok(r.body.items.some((h) => h.kind === 'snippet'), '命中类型为片段');

  r = await getJson('/api/search?q=' + encodeURIComponent('星轨'));
  assert.equal(r.body.items.length, 1, '应能搜到资料');
  assert.equal(r.body.items[0].kind, 'file', '命中类型为资料');
  console.log('✓ 全局检索命中片段与资料');

  // 13. 用户列表 / 修改
  r = await getJson('/api/users');
  assert.equal(r.body.items.length, 2, '用户列表');
  const ua = r.body.items.find((u) => u.qq_id === A);
  assert.equal(ua.snippet_count, 1, '用户片段数');
  assert.equal(ua.file_count, 1, '用户资料数');
  assert.equal(ua.open_count, 1, '用户进行中会话数');

  r = await sendJson(`/api/users/${A}`, 'PATCH', { display_name: '多米尼卡2', boomerang_days: 7, summary_on: false });
  assert.equal(r.status, 200, '修改用户应 200');
  assert.equal(r.body.user.boomerang_days, 7, '回旋间隔已改');
  assert.equal(r.body.user.summary_on, 0, '总结开关已关');
  assert.equal(r.body.user.display_name, '多米尼卡2', '昵称已改');

  r = await sendJson(`/api/users/${A}`, 'PATCH', { boomerang_days: 0 });
  assert.equal(r.status, 400, '非法天数应 400');
  console.log('✓ 用户列表 / 修改 / 参数校验正确');

  // 14. 回旋镖队列
  r = await getJson('/api/boomerangs');
  assert.equal(r.status, 200, '回旋镖队列应 200');
  assert.ok(Array.isArray(r.body.items), 'items 应为数组');
  assert.ok(r.body.items.some((b) => b.kind === 'snippet'), '队列应含可回旋片段');
  assert.ok(r.body.items.some((b) => b.kind === 'file'), '队列应含可回旋资料');
  assert.ok(Array.isArray(r.body.history), '应返回发送历史数组');
  assert.equal(r.body.history.length, 1, '发送历史应含预置的 1 条');
  assert.equal(r.body.history[0].target_type, 'snippet', '历史应记录目标类型');
  assert.equal(r.body.sentTotal, 1, '累计发送数应为 1');
  console.log(`✓ 回旋镖队列预览（${r.body.items.length} 条待回旋 / ${r.body.sentTotal} 条已发）`);

  r = await sendJson('/api/boomerangs/run', 'POST');
  assert.equal(r.status, 400, '纯管理台模式不应能跑回旋镖');
  console.log('✓ 纯管理台模式下回旋镖执行被拒');

  // 15. 手动回旋（无 OneBot 应明确报错）
  r = await sendJson(`/api/snippets/${sn1}/boomerang`, 'POST');
  assert.equal(r.status, 400, '无 OneBot 应 400');
  console.log('✓ 无 OneBot 时手动回旋被拒');

  // 16. 导出（二进制 zip）
  let res = await req('/api/export', { method: 'POST', body: JSON.stringify({ qq: A, format: 'pdf', scope: 'all' }) });
  assert.equal(res.status, 200, '导出应 200');
  const expBuf = Buffer.from(await res.arrayBuffer());
  assert.equal(expBuf[0], 0x50, 'zip 魔数 P');
  assert.equal(expBuf[1], 0x4b, 'zip 魔数 K');
  assert.ok(res.headers.get('content-disposition').includes('attachment'), '应带 attachment');
  assert.equal(res.headers.get('x-export-count'), '2', '导出 2 篇');
  console.log(`✓ 导出下载 zip（${(expBuf.length / 1024).toFixed(1)}KB，2 篇）`);

  res = await req('/api/export', { method: 'POST', body: JSON.stringify({ qq: '99999', format: 'pdf' }) });
  assert.equal(res.status, 404, '不存在的用户应 404');
  console.log('✓ 导出不存在的用户 -> 404');

  // 16b. 按编号导出（#N）
  res = await req('/api/export', { method: 'POST', body: JSON.stringify({ qq: A, format: 'txt', scope: '#' + sn1 }) });
  assert.equal(res.status, 200, '按编号导出应 200');
  assert.equal(res.headers.get('x-export-count'), '1', '按编号应只导出 1 篇');
  assert.ok(decodeURIComponent(res.headers.get('x-export-scope')).includes('片段'), '应回报导出范围');
  await res.arrayBuffer();
  console.log('✓ 按编号导出（#N）');

  res = await req('/api/export', { method: 'POST', body: JSON.stringify({ qq: A, format: 'txt', scope: '#999999' }) });
  assert.equal(res.status, 400, '不存在的编号应 400');
  console.log('✓ 导出不存在的编号 -> 400');

  // 16c. 撤回审计接口
  repo.deleteMessagesByUserInGroup(B, '88888');
  r = await getJson('/api/redactions');
  assert.equal(r.status, 200, '撤回审计应 200');
  assert.ok(r.body.items.some((x) => x.qq_id === B && x.removed_count >= 1), '应记录撤回审计');
  console.log('✓ 撤回审计接口');

  // 17. 资料详情 / 删除（含磁盘文件）
  r = await getJson(`/api/files/${f1}`);
  assert.ok(r.body.content_text.includes('星轨'), '资料详情含正文');

  r = await sendJson(`/api/files/${f1}`, 'DELETE');
  assert.equal(r.status, 200, '删除资料应 200');
  assert.equal(r.body.removedFile, true, '应删除磁盘文件');
  assert.ok(!fs.existsSync(uploadPath), '磁盘文件应已删除');

  r = await getJson(`/api/files/${f1}`);
  assert.equal(r.status, 404, '删除后详情应 404');
  r = await getJson('/api/search?q=' + encodeURIComponent('星轨'));
  assert.equal(r.body.items.length, 0, '删除后检索索引应清理');
  console.log('✓ 删除资料：库 + 索引 + 磁盘文件都清理干净');

  // 18. 删除片段
  r = await sendJson(`/api/snippets/${newSnippet}`, 'DELETE');
  assert.equal(r.status, 200, '删除片段应 200');
  r = await sendJson(`/api/snippets/${newSnippet}`, 'DELETE');
  assert.equal(r.status, 404, '重复删除应 404');
  console.log('✓ 删除片段，重复删除 -> 404');

  // 19. 删除用户（级联）
  r = await sendJson(`/api/users/${A}`, 'DELETE');
  assert.equal(r.status, 200, '删除用户应 200');
  assert.equal(r.body.snippets, 1, '应级联删掉 1 个片段');
  assert.equal(r.body.sessions, 1, '应级联删掉 1 个会话');

  r = await getJson('/api/users');
  assert.equal(r.body.items.length, 1, '只剩 1 个用户');
  r = await getJson('/api/search?q=' + encodeURIComponent('回旋镖'));
  assert.equal(r.body.items.length, 0, '用户删除后索引应清空');
  r = await getJson(`/api/sessions/${s1}`);
  assert.equal(r.status, 404, '会话应已删除');
  console.log('✓ 删除用户：会话 / 消息 / 片段 / 资料 / 索引 全部级联清理');

  // 20. 未知接口
  r = await getJson('/api/nope');
  assert.equal(r.status, 404, '未知接口应 404');
  console.log('✓ 未知接口 -> 404');

  // 21. 登出
  r = await sendJson('/api/logout', 'POST');
  assert.equal(r.status, 200, '登出应 200');
  r = await getJson('/api/overview');
  assert.equal(r.status, 401, '登出后应 401');
  console.log('✓ 登出后会话失效 -> 401');

  // 22. 登录限速（放最后，因为会锁本机 IP 60 秒）
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const rr = await sendJson('/api/login', 'POST', { token: 'bad-' + i });
    if (rr.status === 429) { limited = true; break; }
  }
  assert.ok(limited, '连续错误口令应触发限速 429');
  console.log('✓ 连续错误口令触发登录限速 -> 429');

  await admin.stop();
  db.close();

  console.log('\nADMINTEST PASS');
})().catch((e) => {
  console.error('\nADMINTEST FAIL:', e.stack || e.message);
  process.exit(1);
});
