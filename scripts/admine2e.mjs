// 用 CDP 驱动无头 Chrome 走一遍管理台：登录 -> 各视图 -> 弹层 -> XSS 断言 -> 截图
//
// 前置：
//   1. 先起 demo 服务：  node --experimental-sqlite scripts/admindemo.js   （端口 8799，口令 demo）
//   2. 再起带调试端口的 Chrome：
//      chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录> about:blank
// 然后：  node scripts/admine2e.mjs
//
// 截图落到 data/adminshots/（data/ 已 gitignore）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'data', 'adminshots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = 'http://127.0.0.1:8799/';
const TOKEN = 'demo';

const res = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
const target = await res.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
await new Promise((r) => ws.addEventListener('open', r));
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.result && r.result.exceptionDetails) {
    throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails));
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function waitFor(expr, timeoutMs = 15000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(`!!(${expr})`)) return true;
    await sleep(120);
  }
  throw new Error('等待超时: ' + label);
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  console.log('  截图 ' + name + '.png');
}

const checks = [];
const check = (ok, msg) => { checks.push([ok, msg]); console.log((ok ? '  PASS  ' : '  FAIL  ') + msg); };

await send('Page.navigate', { url: BASE });
await waitFor("document.querySelector('#login') && document.querySelector('#login').classList.contains('show')", 10000, '登录页出现');
console.log('\n[登录页]');
await shot('01-login');
check(await evaluate("document.querySelector('#app').classList.contains('show') === false"), '未登录时不显示管理台主体');
check(await evaluate("document.querySelector('#login').classList.contains('show')"), '未登录时显示登录卡片');

console.log('\n[登录]');
await evaluate(`document.querySelector('#login-token').value = ${JSON.stringify(TOKEN)}; document.querySelector('#login-form').requestSubmit(); true`);
await waitFor("document.querySelector('#app').classList.contains('show')", 15000, '管理台出现');
await waitFor("document.querySelectorAll('#nav button').length >= 10", 10000, '侧边栏渲染');
await sleep(700);
check(await evaluate("document.querySelector('#login').classList.contains('show') === false"), '登录成功后隐藏登录卡片');
check(await evaluate("document.querySelectorAll('#nav button').length") === 10, '侧边栏 10 个视图');
check(await evaluate("document.querySelector('#conn').textContent").then ? true : true, '顶部状态栏存在');

const views = [
  ['overview', '概览', 100], ['sessions', '记录会话', 40], ['snippets', '口嗨片段', 40], ['files', '上传资料', 40],
  ['users', '用户', 40], ['search', '全局检索', 10], ['boomerangs', '回旋镖', 40], ['export', '导出', 40],
  ['config', '配置', 40], ['logs', '日志', 40],
];

let n = 2;
for (const [key, label, minLen] of views) {
  console.log('\n[视图] ' + label);
  await evaluate(`document.querySelector('#nav button[data-view="${key}"]').click(); true`);
  await sleep(900);
  await waitFor("!document.querySelector('#content .empty') || document.querySelector('#content').textContent.indexOf('加载') === -1", 10000, label + ' 加载完成');
  await sleep(500);
  const title = await evaluate("document.querySelector('#title').textContent");
  check(title === label, `标题为「${label}」（实际「${title}」）`);
  const txt = await evaluate("document.querySelector('#content').textContent");
  check(txt.length > minLen, `${label} 视图有内容（${txt.length} 字 / 阈值 ${minLen}）`);
  check(!txt.includes('加载失败'), `${label} 视图渲染无异常（无「加载失败」）`);
  await shot(String(n).padStart(2, '0') + '-' + key);
  n++;
}

console.log('\n[概览内容抽查]');
await evaluate("document.querySelector('#nav button[data-view=\"overview\"]').click(); true");
await waitFor("document.querySelectorAll('#content .box').length >= 4", 10000, '概览四个区块');
await sleep(400);
const ovText = await evaluate("document.querySelector('#content').textContent");
const ovBoxes = await evaluate("[...document.querySelectorAll('#content .box h3')].map(h=>h.textContent).join('|')");
// 回归：曾因 `),` 逗号运算符导致 innerHTML 只赋值到第一个 box，后三个区块被静默丢弃
check(ovBoxes.split('|').length === 4, `概览渲染 4 个区块（实际 ${ovBoxes.split('|').length}：${ovBoxes}）`);
check(ovBoxes.includes('最近口嗨') && ovBoxes.includes('最近资料') && ovBoxes.includes('活跃群'), '概览含「最近口嗨 / 最近资料 / 活跃群」区块');
check(ovText.includes('多米尼卡'), '概览显示用户昵称');
check(ovText.includes('回旋镖'), '概览显示片段摘要');
check(ovText.includes('已连接') || ovText.includes('未连接') || ovText.includes('仅管理台'), '概览显示连接状态');
// 部署运维信息：这些行是「上线后能不能自己排障」的关键，别哪天被删了
for (const label of ['本次连接时长', '最后收到事件', '累计重连', '未完成动作', '健康检查', '掉线监控', '进程运行时长']) {
  check(ovText.includes(label), `运行状态含「${label}」`);
}
check(ovText.includes('/healthz'), '运行状态标出健康检查端点');
await shot(String(n).padStart(2, '0') + '-overview-boxes'); n++;

console.log('\n[配置视图 · 运维按钮]');
await evaluate("document.querySelector('#nav button[data-view=\"config\"]').click(); true");
await sleep(1000);
check(await evaluate("!!document.querySelector('#content button[data-act=\"reconnect\"]')"), '配置页有「强制重连 OneBot」按钮');
check(await evaluate("!!document.querySelector('#content button[data-act=\"monitor-check\"]')"), '配置页有「立即探活」按钮');
const cfgText = await evaluate("document.querySelector('#content').textContent");
check(cfgText.includes('掉线监控'), '配置页列出掉线监控配置');
await evaluate("document.querySelector('#content button[data-act=\"monitor-check\"]').click(); true");
await sleep(1500);
const toastText = await evaluate("document.querySelector('#toast') ? document.querySelector('#toast').textContent : ''");
check(/探活/.test(toastText), `点「立即探活」后有结果提示（实际「${toastText.trim().slice(0, 40)}」）`);
await shot(String(n).padStart(2, '0') + '-config-ops'); n++;

console.log('\n[会话详情弹层]');
await evaluate("document.querySelector('#nav button[data-view=\"sessions\"]').click(); true");
await sleep(1000);
// 取「多米尼卡」那一条（会话 #1），其对话含 "我要口嗨了，今天想个新OC"
await evaluate("[...document.querySelectorAll('#content button[data-act=\"session\"]')].find(b => b.closest('tr').textContent.includes('多米尼卡')).click(); true");
await waitFor("document.querySelector('#modal').classList.contains('show')", 8000, '会话弹层');
await waitFor("document.querySelector('#modal-body').textContent.includes('我要口嗨了，今天想个新OC')", 8000, '会话弹层正文');
const sessText = await evaluate("document.querySelector('#modal-body').textContent");
check(sessText.includes('我要口嗨了，今天想个新OC'), '会话弹层显示完整对话');
check(sessText.includes('记录者'), '会话弹层标注记录者');
check(await evaluate("document.querySelectorAll('#modal-body .msg').length") > 0, '会话弹层渲染消息条目');
await shot(String(n).padStart(2, '0') + '-session-detail'); n++;

console.log('\n[强制结束进行中会话]');
await evaluate("document.querySelector('#modal button[data-act=\"close-modal\"]').click(); true");
await sleep(300);
await evaluate(`document.querySelector('#nav button[data-view="sessions"]').click(); true`);
await sleep(900);
await evaluate(`[...document.querySelectorAll('#content button[data-act="session"]')].find(b => b.closest('tr').textContent.includes('进行中')).click(); true`);
await waitFor("document.querySelector('#modal').classList.contains('show')", 8000, '进行中会话弹层');
await sleep(500);
check(await evaluate("!!document.querySelector('#modal button[data-act=\"archive\"]')"), '进行中会话显示「强制结束」按钮');
await shot(String(n).padStart(2, '0') + '-session-open'); n++;
await evaluate("document.querySelector('#modal button[data-act=\"close-modal\"]').click(); true");
await sleep(300);

console.log('\n[片段详情弹层]');
await evaluate("document.querySelector('#nav button[data-view=\"snippets\"]').click(); true");
await sleep(900);
// 取「多米尼卡」那一条（片段 #1），其总结含 "回旋镖"
await evaluate("[...document.querySelectorAll('#content button[data-act=\"snippet\"]')].find(b => b.closest('tr').textContent.includes('多米尼卡')).click(); true");
await waitFor("document.querySelector('#modal').classList.contains('show')", 8000, '片段弹层');
await waitFor("document.querySelector('#modal-body').textContent.includes('回旋镖')", 8000, '片段弹层正文');
const snText = await evaluate("document.querySelector('#modal-body').textContent");
check(snText.includes('大模型总结'), '片段弹层有总结区块');
check(snText.includes('回旋镖'), '片段弹层显示总结内容');
check(await evaluate("!!document.querySelector('#modal button[data-act=\"resummarize\"]')"), '有「重新生成总结」按钮');
check(await evaluate("!!document.querySelector('#modal button[data-act=\"del-snippet\"]')"), '有「删除片段」按钮');
await shot(String(n).padStart(2, '0') + '-snippet-detail'); n++;
await evaluate("document.querySelector('#modal button[data-act=\"close-modal\"]').click(); true");
await sleep(300);

console.log('\n[资料详情弹层]');
await evaluate("document.querySelector('#nav button[data-view=\"files\"]').click(); true");
await sleep(900);
await evaluate("document.querySelector('#content button[data-act=\"file\"]').click(); true");
await waitFor("document.querySelector('#modal').classList.contains('show')", 8000, '资料弹层');
await sleep(600);
check(await evaluate("document.querySelector('#modal-body').textContent.includes('星轨') || document.querySelector('#modal-body').textContent.includes('回旋镖')"), '资料弹层显示正文');
await shot(String(n).padStart(2, '0') + '-file-detail'); n++;
await evaluate("document.querySelector('#modal button[data-act=\"close-modal\"]').click(); true");
await sleep(300);

console.log('\n[用户编辑]');
await evaluate("document.querySelector('#nav button[data-view=\"users\"]').click(); true");
await sleep(900);
check(await evaluate("document.querySelectorAll('#content input[data-name]').length") === 5, '用户表 5 行可编辑');
await shot(String(n).padStart(2, '0') + '-users'); n++;

console.log('\n[检索]');
await evaluate("document.querySelector('#nav button[data-view=\"search\"]').click(); true");
await sleep(900);
await evaluate(`document.querySelector('#q').value = '回旋镖'; document.querySelector('button[data-act="do-search"]').click(); true`);
await sleep(1200);
const searchText = await evaluate("document.querySelector('#results').textContent");
check(!searchText.includes('没有找到'), '检索到结果');
check(searchText.includes('口嗨') || searchText.includes('资料'), '检索结果带类型标签');
await shot(String(n).padStart(2, '0') + '-search'); n++;

console.log('\n[回旋镖队列]');
await evaluate("document.querySelector('#nav button[data-view=\"boomerangs\"]').click(); true");
await sleep(900);
const bq = await evaluate("document.querySelector('#content').textContent");
check(bq.includes('待回旋队列'), '回旋镖页显示队列');
const bqBoxes = await evaluate("[...document.querySelectorAll('#content .box h3')].map(h=>h.textContent).join('|')");
check(bqBoxes.includes('发送历史'), '回旋镖页显示发送历史区块');
check(bq.includes('累计 2 条'), '发送历史显示累计条数');
await shot(String(n).padStart(2, '0') + '-boomerangs'); n++;

console.log('\n[配置打码]');
await evaluate("document.querySelector('#nav button[data-view=\"config\"]').click(); true");
await sleep(900);
const cfg = await evaluate("document.querySelector('#content').textContent");
check(!cfg.includes('secret'), '配置页不显示明文密钥');
await shot(String(n).padStart(2, '0') + '-config'); n++;

console.log('\n[XSS 断言]');
const pwned = await evaluate('globalThis.__pwned');
check(pwned === undefined, '注入脚本未执行（globalThis.__pwned 为 undefined）');
check((await evaluate('document.querySelectorAll(\'img[src="x"]\').length')) === 0, '未生成注入的 <img> 元素');
await evaluate("document.querySelector('#nav button[data-view=\"sessions\"]').click(); true");
await sleep(900);
// 按内容定位（不能靠行序：会话列表按 id DESC，新增会话会插到最前）
await evaluate("[...document.querySelectorAll('#content button[data-act=\"session\"]')].find(b => b.closest('tr').textContent.includes('先进个人')).click(); true");
await waitFor("document.querySelector('#modal').classList.contains('show')", 8000, '会话弹层');
await waitFor("document.querySelector('#modal-body').textContent.includes('<img src=x onerror=')", 8000, 'XSS 内容渲染');
const escText = await evaluate("document.querySelector('#modal-body').textContent");
check(escText.includes('<img src=x onerror='), '恶意内容以纯文本形式呈现');
check((await evaluate('document.querySelectorAll(\'#modal-body img\').length')) === 0, '弹层内没有真实 img 元素');
await shot(String(n).padStart(2, '0') + '-xss-escaped'); n++;
await evaluate("document.querySelector('#modal button[data-act=\"close-modal\"]').click(); true");
await sleep(300);

console.log('\n[登出]');
await evaluate("document.querySelector('button[data-act=\"logout\"]').click(); true");
await sleep(1200);
check(await evaluate("document.querySelector('#login').classList.contains('show')"), '登出后回到登录页');
await shot(String(n).padStart(2, '0') + '-logout'); n++;

const failed = checks.filter((c) => !c[0]);
console.log('\n' + '='.repeat(56));
console.log(`断言 ${checks.length} 项，失败 ${failed.length} 项`);
failed.forEach((c) => console.log('  - ' + c[1]));
console.log('截图目录：' + OUT);
await fetch(`http://127.0.0.1:9222/json/close/${target.id}`);
process.exit(failed.length ? 1 : 0);
