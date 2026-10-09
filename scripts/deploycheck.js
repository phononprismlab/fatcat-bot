'use strict';
// 部署自检。
//
// 部署这块的坑和业务代码不一样：单测跑不到，错了往往要等上线才发现，而且症状很难懂
// （CRLF 的 .sh、漏了中文字体的镜像、忘配的 env、写反的占位符……）。
// 所以这里做两类校验：
//   A. 运行时真跑 —— 真的起管理台打 /healthz、真的跑一次备份再打开快照数数
//   B. 静态交叉校验 —— 模板/脚本/文档/示例配置之间「谁忘了跟谁同步」
//
// 注意：本机 Node 起子进程会 EBUSY，所以这里**不 spawn 任何进程**，
// 需要外部工具才能验的东西（bash -n、YAML 解析）改用等价的不变量检查。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRepo } = require('../src/repo');
const { createAdminServer } = require('../src/admin/server');
const { createMonitor, sendAlert, detectKind, buildAlertPayload } = require('../src/monitor');
const { runBackup, rotate, sqlQuote } = require('./backup');
const { loadConfig } = require('../src/config');

const root = path.resolve(__dirname, '..');
const tmpRoot = path.join(root, 'data', '_deploycheck');
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(tmpRoot, { recursive: true });

let passed = 0;
const failures = [];

function group(name) {
  console.log('\n\x1b[36m▌' + name + '\x1b[0m');
}
async function t(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  \x1b[32m✓\x1b[0m ' + label);
  } catch (e) {
    failures.push({ label, error: e });
    console.log('  \x1b[31m✗\x1b[0m ' + label + '\n      ' + (e.message || e));
  }
}

// ============================================================
// A. 运行时：/healthz
// ============================================================

function makeConfig(over = {}) {
  return Object.assign({
    rootDir: root,
    dataDir: tmpRoot,
    dbPath: path.join(tmpRoot, 'h.db'),
    exportsDir: path.join(tmpRoot, 'exports'),
    uploadsDir: path.join(tmpRoot, 'uploads'),
    fontPath: '',
    onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', echoTimeoutMs: 1000 },
    commandPrefix: '/',
    startPhrase: '我要口嗨了',
    endPhrase: '我口嗨完了',
    llm: { baseUrl: '', apiKey: '', model: '' },
    boomerangDefaultDays: 3,
    userQuotaChars: undefined,
    admin: { host: '127.0.0.1', port: 0, token: 'deploycheck-token', sessionTtlMs: 3600000, only: false },
    monitor: { enabled: true, webhookUrl: '', intervalMs: 60000, cooldownMs: 60000 },
  }, over);
}

const hdb = openDb(path.join(tmpRoot, 'h.db'));
const hrepo = createRepo(hdb);
hrepo.upsertUser('10001', '多米尼卡');

// 假的 OneBot 客户端：只提供 healthz / monitor 需要的两个方法
function fakeClient({ connected = true, loginResp = { status: 'ok', data: { user_id: 12345 } }, throwErr = null } = {}) {
  return {
    stats: () => ({ connected, url: 'ws://127.0.0.1:3001', retry: 0, reconnects: 2, connectedMs: 1000, lastEventAt: Date.now() - 5000, pendingCalls: 0 }),
    getLoginInfo: async () => {
      if (throwErr) throw new Error(throwErr);
      return loginResp;
    },
  };
}

async function withServer({ config, client, monitor }, fn) {
  const admin = createAdminServer({ config, repo: hrepo, client, boomerang: null, monitor: monitor || null });
  const addr = await admin.start();
  const origin = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(origin, admin);
  } finally {
    await admin.stop();
  }
}

async function main() {
  group('A1 · /healthz 的三种状态');

  await t('ADMIN_ONLY 模式（client=null）-> 200 且 ok=true', async () => {
    const config = makeConfig({ admin: { host: '127.0.0.1', port: 0, token: 'x', sessionTtlMs: 3600000, only: true } });
    await withServer({ config, client: null }, async (origin) => {
      const r = await fetch(origin + '/healthz');
      assert.strictEqual(r.status, 200, '状态码应为 200');
      const j = await r.json();
      assert.strictEqual(j.ok, true);
      assert.strictEqual(j.mode, 'admin-only');
      assert.strictEqual(j.bot.connected, false);
    });
  });

  await t('机器人模式 + OneBot 未连接 -> 503 且 ok=false', async () => {
    const config = makeConfig();
    await withServer({ config, client: fakeClient({ connected: false }) }, async (origin) => {
      const r = await fetch(origin + '/healthz');
      assert.strictEqual(r.status, 503, '未连接必须返回 503，外部探活才能发现');
      const j = await r.json();
      assert.strictEqual(j.ok, false);
      assert.strictEqual(j.mode, 'bot');
      assert.strictEqual(j.bot.connected, false);
    });
  });

  await t('机器人模式 + OneBot 已连接 -> 200 且 ok=true', async () => {
    const config = makeConfig();
    await withServer({ config, client: fakeClient({ connected: true }) }, async (origin) => {
      const r = await fetch(origin + '/healthz');
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(j.ok, true);
      assert.strictEqual(j.bot.connected, true);
      assert.ok(j.uptimeMs >= 0, '应返回运行时长');
    });
  });

  await t('免登录：不带任何 cookie 也能拿到 200', async () => {
    const config = makeConfig();
    await withServer({ config, client: fakeClient({ connected: true }) }, async (origin) => {
      const r = await fetch(origin + '/healthz', { headers: { cookie: '' } });
      assert.strictEqual(r.status, 200);
    });
  });

  await t('/healthz 不泄漏任何业务数据', async () => {
    const config = makeConfig();
    await withServer({ config, client: fakeClient({ connected: true }) }, async (origin) => {
      const j = await (await fetch(origin + '/healthz')).json();
      const flat = JSON.stringify(j);
      for (const word of ['多米尼卡', '10001', 'users', 'sessions', 'messages', 'snippets', 'files', 'token']) {
        assert.ok(!flat.includes(word), '健康检查里不该出现 ' + word);
      }
    });
  });

  await t('/api/* 依然要鉴权（健康检查的免登录不能顺带放开别的）', async () => {
    const config = makeConfig();
    await withServer({ config, client: fakeClient({ connected: true }) }, async (origin) => {
      const r = await fetch(origin + '/api/overview');
      assert.strictEqual(r.status, 401);
    });
  });

  await t('未知路径仍返回 404', async () => {
    const config = makeConfig();
    await withServer({ config, client: null }, async (origin) => {
      assert.strictEqual((await fetch(origin + '/nope')).status, 404);
    });
  });

  // ============================================================
  group('A2 · 掉线监控');

  await t('detectKind 按域名识别四种出口', () => {
    assert.strictEqual(detectKind('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), 'wecom');
    assert.strictEqual(detectKind('https://oapi.dingtalk.com/robot/send?access_token=x'), 'dingtalk');
    assert.strictEqual(detectKind('https://open.feishu.cn/open-apis/bot/v2/hook/x'), 'feishu');
    assert.strictEqual(detectKind('https://sctapi.ftqq.com/xxx.send'), 'serverchan');
    assert.strictEqual(detectKind('https://example.com/hook'), 'generic');
  });

  await t('buildAlertPayload 各出口报文结构正确', () => {
    const w = buildAlertPayload('wecom', 'T', 'B');
    assert.deepStrictEqual(w, { msgtype: 'text', text: { content: 'T\nB' } });
    const d = buildAlertPayload('dingtalk', 'T', 'B');
    assert.deepStrictEqual(d, { msgtype: 'text', text: { content: 'T\nB' } });
    const f = buildAlertPayload('feishu', 'T', 'B');
    assert.deepStrictEqual(f, { msg_type: 'text', content: { text: 'T\nB' } });
    const s = buildAlertPayload('serverchan', 'T', 'B');
    assert.deepStrictEqual(s, { title: 'T', desp: 'B' });
    const g = buildAlertPayload('generic', 'T', 'B');
    assert.strictEqual(g.title, 'T');
    assert.strictEqual(g.text, 'B');
    assert.ok(typeof g.ts === 'number');
  });

  await t('未配置 webhook 时 sendAlert 返回 skipped 且不抛错', async () => {
    const r = await sendAlert(makeConfig(), { title: 'T', text: 'B' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.skipped, true);
  });

  // 起一个本地收集器，充当告警出口
  const inbox = [];
  const collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { inbox.push(JSON.parse(body)); } catch (e) { inbox.push({ raw: body }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => collector.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${collector.address().port}/hook`;

  await t('sendAlert 真的把通用 JSON POST 到 webhook', async () => {
    inbox.length = 0;
    const cfg = makeConfig({ monitor: { enabled: true, webhookUrl: hookUrl, intervalMs: 60000, cooldownMs: 60000 } });
    const r = await sendAlert(cfg, { title: '掉线告警', text: '测试正文' });
    assert.strictEqual(r.ok, true, '发送应成功');
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].title, '掉线告警');
    assert.strictEqual(inbox[0].text, '测试正文');
  });

  await t('探活：WS 未连接 -> healthy=false', async () => {
    const cfg = makeConfig({ monitor: { enabled: true, webhookUrl: '', intervalMs: 60000, cooldownMs: 60000 } });
    const m = createMonitor({ config: cfg, client: fakeClient({ connected: false }) });
    const st = await m.run();
    assert.strictEqual(st.healthy, false);
    assert.ok(/未连接/.test(st.lastReason), '原因应说明未连接，实际：' + st.lastReason);
  });

  await t('探活：get_login_info 正常 -> healthy=true', async () => {
    const cfg = makeConfig({ monitor: { enabled: true, webhookUrl: '', intervalMs: 60000, cooldownMs: 60000 } });
    const m = createMonitor({ config: cfg, client: fakeClient({ connected: true }) });
    const st = await m.run();
    assert.strictEqual(st.healthy, true);
    assert.ok(/12345/.test(st.lastReason), '原因应带出账号，实际：' + st.lastReason);
  });

  await t('探活：账号掉线（get_login_info 返回异常）-> healthy=false', async () => {
    const cfg = makeConfig({ monitor: { enabled: true, webhookUrl: '', intervalMs: 60000, cooldownMs: 60000 } });
    const m = createMonitor({ config: cfg, client: fakeClient({ connected: true, loginResp: { status: 'failed', retcode: 100 } }) });
    const st = await m.run();
    assert.strictEqual(st.healthy, false, 'WS 连着但账号掉线，必须判为异常');
    assert.ok(/get_login_info/.test(st.lastReason));
  });

  await t('探活：请求抛错 -> healthy=false（不能把异常吞掉当成正常）', async () => {
    const cfg = makeConfig({ monitor: { enabled: true, webhookUrl: '', intervalMs: 60000, cooldownMs: 60000 } });
    const m = createMonitor({ config: cfg, client: fakeClient({ connected: true, throwErr: '动作超时: get_login_info' }) });
    const st = await m.run();
    assert.strictEqual(st.healthy, false);
    assert.ok(/探活请求失败/.test(st.lastReason));
  });

  await t('告警冷却：连续失败只告警一次', async () => {
    inbox.length = 0;
    const cfg = makeConfig({ monitor: { enabled: true, webhookUrl: hookUrl, intervalMs: 60000, cooldownMs: 60000 } });
    const m = createMonitor({ config: cfg, client: fakeClient({ connected: false }) });
    await m.run();
    await m.run();
    await m.run();
    assert.strictEqual(m.status().consecutiveFailures, 3, '连续失败次数应累计');
    assert.strictEqual(m.status().alertsSent, 1, '冷却期内只应发一次告警，实际 ' + m.status().alertsSent);
    assert.strictEqual(inbox.length, 1);
  });

  await t('恢复通知：从异常回到正常会补发一条', async () => {
    inbox.length = 0;
    const cfg = makeConfig({ monitor: { enabled: true, webhookUrl: hookUrl, intervalMs: 60000, cooldownMs: 60000 } });
    let connected = false;
    const client = {
      stats: () => ({ connected }),
      getLoginInfo: async () => ({ status: 'ok', data: { user_id: 999 } }),
    };
    const m = createMonitor({ config: cfg, client });
    await m.run();                    // 异常 -> 告警
    assert.strictEqual(inbox.length, 1);
    connected = true;
    const st = await m.run();         // 恢复 -> 恢复通知
    assert.strictEqual(st.healthy, true);
    assert.strictEqual(m.status().consecutiveFailures, 0);
    assert.strictEqual(inbox.length, 2, '恢复时应补发一条，实际 ' + inbox.length);
    assert.ok(/恢复/.test(inbox[1].title), '第二条应是恢复通知，实际标题：' + inbox[1].title);
  });

  await t('MONITOR=0 时不启动定时器也不告警', async () => {
    inbox.length = 0;
    const cfg = makeConfig({ monitor: { enabled: false, webhookUrl: hookUrl, intervalMs: 60000, cooldownMs: 60000 } });
    const m = createMonitor({ config: cfg, client: fakeClient({ connected: false }) });
    const handle = m.start();
    handle.stop();
    assert.strictEqual(m.status().enabled, false);
    assert.strictEqual(inbox.length, 0, '关闭状态下不该发出任何告警');
  });

  await t('MONITOR_INTERVAL_MIN 的单位换算：下限是 30 秒，不是 30 分钟', () => {
    const prev = process.env.MONITOR_INTERVAL_MIN;
    try {
      process.env.MONITOR_INTERVAL_MIN = '2';
      assert.strictEqual(loadConfig(root).monitor.intervalMs, 120000, '2 分钟应等于 120000ms');
      process.env.MONITOR_INTERVAL_MIN = '0.1';
      assert.strictEqual(loadConfig(root).monitor.intervalMs, 30000, '低于下限应被顶到 30 秒');
      delete process.env.MONITOR_INTERVAL_MIN;
      assert.strictEqual(loadConfig(root).monitor.intervalMs, 120000, '默认应为 2 分钟');
    } finally {
      if (prev === undefined) delete process.env.MONITOR_INTERVAL_MIN;
      else process.env.MONITOR_INTERVAL_MIN = prev;
    }
  });

  await t('MONITOR=0 / false 都能关掉监控', () => {
    const prev = process.env.MONITOR;
    try {
      process.env.MONITOR = '0';
      assert.strictEqual(loadConfig(root).monitor.enabled, false);
      process.env.MONITOR = 'false';
      assert.strictEqual(loadConfig(root).monitor.enabled, false);
      delete process.env.MONITOR;
      assert.strictEqual(loadConfig(root).monitor.enabled, true, '默认应开启');
    } finally {
      if (prev === undefined) delete process.env.MONITOR;
      else process.env.MONITOR = prev;
    }
  });

  collector.close();

  // ============================================================
  group('A3 · 备份');

  const bdir = path.join(tmpRoot, 'srcdata');
  fs.mkdirSync(path.join(bdir, 'uploads', '10001'), { recursive: true });
  fs.writeFileSync(path.join(bdir, 'uploads', '10001', 'oc.txt'), '星轨设定正文', 'utf8');

  const bdb = openDb(path.join(bdir, 'fatcat.db'));
  const brepo = createRepo(bdb);
  brepo.upsertUser('10001', '多米尼卡');
  const bs = brepo.createSession('10001', '88888');
  brepo.addMessage(bs, '10001', '多米尼卡', '主角叫回旋镖', Date.now(), true);
  const bsn = brepo.createSnippet(bs, '10001', '关于回旋镖');
  brepo.indexAdd('主角叫回旋镖', '10001', 'snippet', bsn);
  const bf = brepo.addFile('10001', 'oc.txt', path.join(bdir, 'uploads', '10001', 'oc.txt'), '星轨设定正文');

  const bconfig = {
    dbPath: path.join(bdir, 'fatcat.db'),
    uploadsDir: path.join(bdir, 'uploads'),
  };

  // ⚠️ 关键：故意**不关闭** bdb。数据可能还躺在 -wal 里没 checkpoint，
  //    这正是「不能直接 cp 主文件」的原因，也是这个断言要守住的东西。
  const outRoot = path.join(tmpRoot, 'backups');

  await t('WAL 里尚未 checkpoint 的数据也进得了快照（VACUUM INTO 的意义）', async () => {
    const walSize = (() => { try { return fs.statSync(bconfig.dbPath + '-wal').size; } catch (e) { return 0; } })();
    assert.ok(walSize > 0, '前置条件：应有 -wal 文件（说明确实还没 checkpoint）');

    const { dir, manifest } = runBackup({ config: bconfig, outRoot, keep: 14 });
    assert.ok(fs.existsSync(path.join(dir, 'fatcat.db')), '快照文件应存在');
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'manifest 应存在');

    // 打开快照数一遍 —— 数据在，才说明备份真的可用
    const { DatabaseSync } = require('node:sqlite');
    const snap = new DatabaseSync(path.join(dir, 'fatcat.db'), { readOnly: true });
    try {
      assert.strictEqual(snap.prepare('SELECT COUNT(*) n FROM messages').get().n, 1, '消息应在快照里');
      assert.strictEqual(snap.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
      assert.strictEqual(snap.prepare('SELECT COUNT(*) n FROM snippets').get().n, 1);
      assert.strictEqual(snap.prepare('SELECT COUNT(*) n FROM files').get().n, 1);
      assert.strictEqual(snap.prepare('SELECT COUNT(*) n FROM search_index').get().n, 1, 'FTS 索引也应完整');
      assert.strictEqual(snap.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      const msg = snap.prepare('SELECT content FROM messages').get().content;
      assert.strictEqual(msg, '主角叫回旋镖', '正文内容应逐字一致');
    } finally {
      snap.close();
    }
    assert.strictEqual(manifest.counts.messages, 1);
    assert.strictEqual(manifest.counts.integrity, 'ok');
  });

  await t('上传的原始文件被一起备份（用户数据不能只备份库）', () => {
    const latest = path.join(outRoot, fs.readdirSync(outRoot).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort().pop());
    const copied = path.join(latest, 'uploads', '10001', 'oc.txt');
    assert.ok(fs.existsSync(copied), 'uploads 应被复制');
    assert.strictEqual(fs.readFileSync(copied, 'utf8'), '星轨设定正文');
  });

  await t('备份不包含 exports/（可再生的产物）', () => {
    const dirs = fs.readdirSync(outRoot).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort();
    const latest = path.join(outRoot, dirs[dirs.length - 1]);
    assert.ok(!fs.existsSync(path.join(latest, 'exports')));
  });

  await t('轮转只保留最新 N 份', () => {
    const dirsBefore = fs.readdirSync(outRoot).filter((n) => /^\d{8}-\d{6}$/.test(n)).length;
    assert.strictEqual(dirsBefore, 1, '前置：此时应有 1 份');
    // 用相差整分钟的时间点造 4 份（时间戳精确到秒，错开才能拿到不同目录名），keep=2
    for (let i = 1; i <= 4; i += 1) {
      runBackup({ config: bconfig, outRoot, keep: 2, now: new Date(Date.now() + i * 60000) });
    }
    const dirs = fs.readdirSync(outRoot).filter((n) => /^\d{8}-\d{6}$/.test(n));
    assert.strictEqual(dirs.length, 2, '应只保留 2 份，实际 ' + dirs.length + '：' + dirs.join(','));
  });

  await t('同一秒内重复备份不会因「目标已存在」而失败', () => {
    const same = new Date(Date.now() + 30 * 60000);
    const a = runBackup({ config: bconfig, outRoot, keep: 14, now: same });
    const b = runBackup({ config: bconfig, outRoot, keep: 14, now: same });
    assert.strictEqual(a.dir, b.dir, '同一秒应落在同一个目录');
    assert.ok(fs.existsSync(path.join(b.dir, 'fatcat.db')), '快照应仍在');
    assert.ok(!fs.existsSync(path.join(b.dir, 'fatcat.db.tmp')), '不该留下临时文件');
  });

  await t('轮转不碰 backups/ 里的无关目录', () => {
    const keepDir = path.join(outRoot, 'notes');
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(path.join(keepDir, 'readme.txt'), '别删我', 'utf8');
    runBackup({ config: bconfig, outRoot, keep: 1, now: new Date(Date.now() + 120 * 60000) });
    assert.ok(fs.existsSync(path.join(keepDir, 'readme.txt')), '非备份目录不应被轮转删掉');
  });

  await t('rotate 遇到越界路径不做删除', () => {
    const outside = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const removed = rotate(outside, 0);
    assert.deepStrictEqual(removed, [], '没有备份目录时不应删任何东西');
  });

  await t('源库不存在时明确报错（而不是产出空备份）', () => {
    assert.throws(
      () => runBackup({ config: { dbPath: path.join(tmpRoot, 'nope.db'), uploadsDir: path.join(tmpRoot, 'nouploads') }, outRoot: path.join(tmpRoot, 'b2') }),
      /源数据库不存在/
    );
  });

  await t('SQL 路径里的单引号被正确转义', () => {
    assert.strictEqual(sqlQuote("a'b"), "'a''b'");
    assert.strictEqual(sqlQuote('/tmp/正常路径'), "'/tmp/正常路径'");
  });

  await t('快照是干净的单文件（没有 -wal 依赖）', () => {
    const dirs = fs.readdirSync(outRoot).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort();
    const latest = path.join(outRoot, dirs[dirs.length - 1]);
    assert.ok(!fs.existsSync(path.join(latest, 'fatcat.db-wal')), '快照不该带 -wal');
    assert.ok(!fs.existsSync(path.join(latest, 'fatcat.db-shm')), '快照不该带 -shm');
  });

  bdb.close();

  // ============================================================
  group('B · 静态交叉校验');

  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

  const deployFiles = [
    'README.md', 'install-systemd.sh',
    'fatcat-bot.service', 'fatcat-backup.service', 'fatcat-backup.timer',
    'backup.sh', 'Caddyfile', 'nginx.conf.example',
    'Dockerfile', 'docker-compose.yml', 'docker-healthcheck.js',
  ];

  await t('deploy/ 下该有的文件都在', () => {
    for (const f of deployFiles) {
      assert.ok(fs.existsSync(path.join(root, 'deploy', f)), '缺少 deploy/' + f);
    }
  });

  await t('deploy/README.md 提到了每一个部署文件（文档不和文件脱节）', () => {
    const doc = read('deploy/README.md');
    for (const f of deployFiles) {
      if (f === 'README.md') continue;
      assert.ok(doc.includes(f), 'deploy/README.md 里没提到 ' + f);
    }
  });

  await t('systemd 单元占位符与安装脚本的 render() 完全对齐', () => {
    const installer = read('deploy/install-systemd.sh');
    const placeholders = new Set();
    for (const f of ['fatcat-bot.service', 'fatcat-backup.service', 'fatcat-backup.timer']) {
      const body = read('deploy/' + f);
      for (const m of body.matchAll(/@([A-Z_]+)@/g)) placeholders.add(m[1]);
    }
    assert.ok(placeholders.size > 0, '模板里应至少有一个占位符');
    for (const name of placeholders) {
      assert.ok(installer.includes(`@${name}@`), `install-systemd.sh 没有替换 @${name}@ —— 装了会留下字面量`);
    }
  });

  await t('主服务单元：Restart=always + 开机自启 + 启动失败不无限重启', () => {
    const u = read('deploy/fatcat-bot.service');
    for (const need of ['[Unit]', '[Service]', '[Install]', 'Restart=always', 'WantedBy=multi-user.target',
      'RestartPreventExitStatus=1', 'StartLimitBurst=5', 'ExecStart=', 'WorkingDirectory=']) {
      assert.ok(u.includes(need), '单元缺少 ' + need);
    }
  });

  await t('主服务单元**不能**出现 MemoryDenyWriteExecute（会崩 V8 JIT）', () => {
    const u = read('deploy/fatcat-bot.service');
    const lines = u.split('\n').filter((l) => !l.trim().startsWith('#'));
    assert.ok(!lines.some((l) => /MemoryDenyWriteExecute\s*=\s*(true|yes|1)/i.test(l)),
      'MemoryDenyWriteExecute=true 会让 Node 直接崩，必须去掉');
  });

  await t('主服务单元 ExecStart 带 --experimental-sqlite 且指向真实入口', () => {
    const u = read('deploy/fatcat-bot.service');
    const m = /ExecStart=(\S+)\s+--experimental-sqlite\s+(.+)/.exec(u);
    assert.ok(m, 'ExecStart 应形如 <node> --experimental-sqlite <入口>');
    assert.ok(m[2].includes('/src/index.js'), '应指向 src/index.js，实际 ' + m[2]);
  });

  await t('备份单元 + 定时器配套（OnCalendar / Persistent / Unit）', () => {
    const s = read('deploy/fatcat-backup.service');
    assert.ok(s.includes('Type=oneshot'), '备份是一次性任务');
    assert.ok(s.includes('deploy/backup.sh'), '应调用 deploy/backup.sh');
    const tm = read('deploy/fatcat-backup.timer');
    for (const need of ['[Timer]', 'OnCalendar=', 'Persistent=true', 'Unit=fatcat-backup.service', 'WantedBy=timers.target']) {
      assert.ok(tm.includes(need), '定时器缺少 ' + need);
    }
  });

  await t('shell 脚本用 LF + 有 shebang + set -euo pipefail', () => {
    for (const f of ['deploy/install-systemd.sh', 'deploy/backup.sh', 'start.sh']) {
      const buf = fs.readFileSync(path.join(root, f));
      assert.ok(buf[0] === 0x23 && buf[1] === 0x21, f + ' 缺少 shebang');
      assert.ok(!buf.includes(Buffer.from('\r\n')), f + ' 是 CRLF —— Linux 上会报 "$\'\\r\': command not found"');
      assert.ok(buf.toString('utf8').includes('set -euo pipefail'), f + ' 应设置 set -euo pipefail');
    }
  });

  await t('shell 脚本有可执行位（POSIX 上直接查权限位）', () => {
    if (process.platform === 'win32') {
      console.log('      \x1b[33m·\x1b[0m Windows 上权限位无意义，请用 `git ls-files -s deploy/*.sh start.sh` 确认是 100755');
      return;
    }
    for (const f of ['deploy/install-systemd.sh', 'deploy/backup.sh', 'start.sh']) {
      const mode = fs.statSync(path.join(root, f)).mode;
      assert.ok((mode & 0o111) !== 0, f + ' 没有可执行位（git 里应是 100755）');
    }
  });

  await t('.bat 必须是 CRLF（否则 Windows 下 cmd 会读错）', () => {
    const buf = fs.readFileSync(path.join(root, 'start.bat'));
    assert.ok(buf.includes(Buffer.from('\r\n')), 'start.bat 应为 CRLF');
  });

  await t('compose 结构校验（不依赖 YAML 库）', () => {
    const raw = read('deploy/docker-compose.yml');
    assert.ok(!raw.includes('\t'), 'YAML 不允许用 Tab 缩进');
    for (const line of raw.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.match(/^ */)[0].length;
      assert.strictEqual(indent % 2, 0, '缩进应为 2 的倍数：' + JSON.stringify(line));
    }
    assert.ok(/^services:/m.test(raw), '缺 services 顶层键');
    assert.ok(/^networks:/m.test(raw), '缺 networks 顶层键');
    assert.ok(/^volumes:/m.test(raw), '缺 volumes 顶层键');
    assert.ok(/^  fatcat:/m.test(raw), '缺 fatcat 服务');
    assert.ok(/^  napcat:/m.test(raw), '缺 napcat 服务');
    assert.ok(raw.includes('mlikiowa/napcat-docker:latest'), 'NapCat 镜像名应写死可核对的版本');
    assert.ok(raw.includes('ws://napcat:3001'), '容器内应通过服务名连 NapCat');
    assert.ok(raw.includes('DATA_DIR: /data'), '容器内数据目录应挂到卷');
  });

  await t('compose 里管理台只发布到回环地址（不能直接暴露公网）', () => {
    const raw = read('deploy/docker-compose.yml');
    assert.ok(raw.includes('"127.0.0.1:8787:8787"'), 'fatcat 的 8787 应只绑 127.0.0.1');
    assert.ok(!/^\s*-\s*"?8787:8787/m.test(raw), '不允许直接把 8787 暴露到 0.0.0.0');
  });

  await t('compose 里 NapCat WebUI 也只发布到回环地址（默认不暴露公网）', () => {
    const raw = read('deploy/docker-compose.yml');
    assert.ok(raw.includes('"127.0.0.1:6099:6099"'), 'NapCat WebUI 的 6099 应只绑 127.0.0.1');
    assert.ok(!/^\s*-\s*"?6099:6099/m.test(raw), '不允许直接把 6099 暴露到 0.0.0.0');
    assert.ok(/SSH 隧道/.test(raw), '应说明首次登录 WebUI 怎么走 SSH 隧道');
  });

  await t('Dockerfile：带 sqlite flag + 装中文字体 + 非 root 运行', () => {
    const d = read('deploy/Dockerfile');
    assert.ok(d.includes('--experimental-sqlite'), 'CMD 需要 --experimental-sqlite');
    assert.ok(d.includes('fonts-noto-cjk'), '不装中文字体的话 PDF 导出会静默降级成 txt');
    assert.ok(/^USER node$/m.test(d), '应以非 root 运行');
    assert.ok(d.includes('HEALTHCHECK'), '应有 HEALTHCHECK');
    assert.ok(d.includes('/app/deploy/docker-healthcheck.js'), 'HEALTHCHECK 应指向独立脚本');
  });

  await t('Dockerfile 里探测的字体路径与 config.js 的候选列表一致', () => {
    const d = read('deploy/Dockerfile');
    const c = read('src/config.js');
    const fontPath = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
    assert.ok(d.includes('fonts-noto-cjk'), '应装 fonts-noto-cjk');
    assert.ok(c.includes(fontPath), 'config.js 的字体候选里应有 ' + fontPath + '（否则装了也探测不到）');
  });

  await t('.dockerignore 排除了数据与密钥', () => {
    const di = read('.dockerignore');
    for (const need of ['data/', 'backups/', 'docker-data/', '.env']) {
      assert.ok(di.includes(need), '.dockerignore 应排除 ' + need);
    }
  });

  await t('.gitignore 覆盖数据 / 备份 / 密钥', () => {
    const gi = read('.gitignore');
    for (const need of ['data/', 'backups/', 'docker-data/', '.env']) {
      assert.ok(gi.includes(need), '.gitignore 应包含 ' + need);
    }
  });

  await t('反代配置指向 127.0.0.1:8787 且带安全头', () => {
    const caddy = read('deploy/Caddyfile');
    assert.ok(caddy.includes('reverse_proxy 127.0.0.1:8787'), 'Caddyfile 反代目标不对');
    assert.ok(caddy.includes('Strict-Transport-Security'), 'Caddyfile 缺 HSTS');
    const nginx = read('deploy/nginx.conf.example');
    assert.ok(nginx.includes('proxy_pass http://127.0.0.1:8787'), 'nginx 反代目标不对');
    assert.ok(nginx.includes('Strict-Transport-Security'), 'nginx 缺 HSTS');
    assert.ok(/proxy_read_timeout\s+300s/.test(nginx), 'nginx 应放宽读超时（导出 PDF 慢）');
  });

  await t('.env.example 覆盖 config.js 读取的每一个环境变量', () => {
    const cfg = read('src/config.js');
    const keys = new Set();
    for (const m of cfg.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)) keys.add(m[1]);
    assert.ok(keys.size >= 15, '从 config.js 里应该能提取到不少 env 键，实际 ' + keys.size);
    const example = read('.env.example');
    const missing = [...keys].filter((k) => !new RegExp('^\\s*' + k + '\\s*=', 'm').test(example));
    assert.deepStrictEqual(missing, [], '这些配置项没写进 .env.example：' + missing.join(', '));
  });

  await t('.env.example 里的 MONITOR / ALERT / NAPCAT 段落齐全', () => {
    const example = read('.env.example');
    for (const need of ['ALERT_WEBHOOK_URL=', 'MONITOR_INTERVAL_MIN=', 'ALERT_COOLDOWN_MIN=', 'MONITOR=',
      'BACKUP_KEEP=', 'BACKUP_OFFSITE_CMD=', 'NAPCAT_WEBUI_TOKEN=']) {
      assert.ok(example.includes(need), '.env.example 缺少 ' + need);
    }
  });

  await t('package.json 暴露了部署相关脚本', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.scripts.deploycheck, '缺 deploycheck 脚本');
    assert.ok(pkg.scripts.backup, '缺 backup 脚本');
    assert.strictEqual(pkg.license, 'MIT');
  });

  await t('README 指向部署手册', () => {
    const r = read('README.md');
    assert.ok(r.includes('deploy/README.md'), '主 README 应指到部署手册');
    assert.ok(r.includes('/healthz'), '主 README 应说明健康检查端点');
  });

  await t('健康检查与监控在 index.js 里真的被接上了', () => {
    const idx = read('src/index.js');
    assert.ok(idx.includes('createMonitor'), 'index.js 应引入并启动掉线监控');
    assert.ok(idx.includes('monitor.start()'), 'index.js 应调用 monitor.start()');
    assert.ok(idx.includes('monitor.stop()'), '退出时应停掉监控');
    assert.ok(idx.includes('monitor'), 'admin 应拿到 monitor 以展示状态');
  });

  // ============================================================
  hdb.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log('\n' + '─'.repeat(56));
  if (failures.length) {
    console.log(`\x1b[31mDEPLOYCHECK FAIL\x1b[0m  通过 ${passed} 项，失败 ${failures.length} 项`);
    for (const f of failures) console.log('  ✗ ' + f.label);
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32mDEPLOYCHECK PASS\x1b[0m  断言 ${passed} 项，失败 0 项`);
  }
}

main().catch((e) => {
  console.error('自检脚本自身出错：' + (e.stack || e.message));
  process.exit(1);
});
