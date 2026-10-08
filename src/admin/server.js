'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../logger');
const { buildExport } = require('../core/export');
const { finalizeSession, buildTranscript } = require('../core/session');
const { generateSummary } = require('../core/summary');
const { sendBoomerang, describeCandidate } = require('../core/boomerang');
const { TEXT_EXTS, MAX_BYTES } = require('../core/upload');

// 零依赖 Web 管理台：node:http + 单文件前端。
// 安全默认：只监听 127.0.0.1；登录用 HttpOnly + SameSite=Strict 的会话 cookie。

const COOKIE = 'fatcat_admin';
const MAX_BODY = 256 * 1024;
const UI_PATH = path.join(__dirname, 'ui.html');

// ---------- 小工具 ----------

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function text(res, code, body, type = 'text/plain; charset=utf-8') {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function num(url, key, def) {
  const v = Number(url.searchParams.get(key));
  return Number.isFinite(v) && v > 0 ? v : def;
}

function dirSize(dir, depth = 0) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { bytes: 0, files: 0, exists: false };
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile()) {
      try {
        bytes += fs.statSync(p).size;
        files += 1;
      } catch (err) {
        /* ignore */
      }
    } else if (e.isDirectory() && depth < 4) {
      const sub = dirSize(p, depth + 1);
      bytes += sub.bytes;
      files += sub.files;
    }
  }
  return { bytes, files, exists: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 服务 ----------

function createAdminServer({ config, repo, client, boomerang, monitor, startedAt = Date.now() }) {
  const token = config.admin.token || crypto.randomBytes(12).toString('base64url');
  const tokenGenerated = !config.admin.token;
  const sessions = new Map(); // sid -> 过期时间
  const loginFails = new Map(); // ip -> { count, until }

  function newSession() {
    const sid = crypto.randomBytes(24).toString('base64url');
    sessions.set(sid, Date.now() + config.admin.sessionTtlMs);
    const nowMs = Date.now();
    for (const [k, exp] of sessions) if (exp < nowMs) sessions.delete(k);
    return sid;
  }

  function isAuthed(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (!sid) return false;
    const exp = sessions.get(sid);
    if (!exp || exp < Date.now()) {
      sessions.delete(sid);
      return false;
    }
    return true;
  }

  // ---------- 视图数据 ----------

  function clientStatus() {
    if (!client) return { mode: 'admin-only', connected: false };
    return Object.assign({ mode: 'bot' }, client.stats());
  }

  // 健康检查：给外部探活（systemd watchdog / Uptime Kuma / 云监控）用。
  // 故意不鉴权、也故意不含任何业务数据 —— 只回答「活着吗、QQ 连着吗」。
  function healthPayload() {
    const bot = clientStatus();
    const ok = config.admin.only ? true : !!bot.connected;
    return {
      ok,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      now: Date.now(),
      mode: config.admin.only ? 'admin-only' : 'bot',
      bot,
    };
  }

  function diskUsage() {
    let dbBytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        dbBytes += fs.statSync(config.dbPath + suffix).size;
      } catch (e) {
        /* ignore */
      }
    }
    return {
      db: dbBytes,
      exports: dirSize(config.exportsDir),
      uploads: dirSize(config.uploadsDir),
      dataDir: config.dataDir,
    };
  }

  function overviewPayload() {
    const mem = process.memoryUsage();
    return {
      bot: clientStatus(),
      process: {
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
      },
      data: repo.overview(),
      disk: diskUsage(),
      monitor: monitor ? monitor.status() : null,
      flags: {
        font: config.fontPath ? path.basename(config.fontPath) : null,
        llm: !!(config.llm.apiKey && config.llm.model),
        adminOnly: !!config.admin.only,
      },
      now: Date.now(),
    };
  }

  function configPayload() {
    return {
      runtime: {
        commandPrefix: config.commandPrefix,
        startPhrase: config.startPhrase,
        endPhrase: config.endPhrase,
        boomerangDefaultDays: config.boomerangDefaultDays,
      },
      paths: { rootDir: config.rootDir, dataDir: config.dataDir, dbPath: config.dbPath, fontPath: config.fontPath || '（未探测到，PDF 会回退 txt）' },
      onebot: {
        wsUrl: config.onebot.wsUrl,
        accessToken: config.onebot.accessToken ? '已设置（***）' : '未设置',
        echoTimeoutMs: config.onebot.echoTimeoutMs,
      },
      llm: {
        baseUrl: config.llm.baseUrl || '（未配置）',
        model: config.llm.model || '（未配置）',
        apiKey: config.llm.apiKey ? '已设置（***）' : '未设置',
      },
      admin: {
        host: config.admin.host,
        port: config.admin.port,
        tokenSource: tokenGenerated ? '本次启动随机生成（建议在 .env 里固定 ADMIN_TOKEN）' : '.env 中的 ADMIN_TOKEN',
        sessionTtlHours: Math.round(config.admin.sessionTtlMs / 3600000),
        only: !!config.admin.only,
      },
      upload: { exts: [...TEXT_EXTS], maxBytes: MAX_BYTES },
      monitor: (() => {
        // 兼容手工拼出来的 config（测试里就是），别因为少一段就 500
        const m = config.monitor || { enabled: false, intervalMs: 0, cooldownMs: 0, webhookUrl: '' };
        let webhook = '（未配置，只会写日志）';
        if (m.webhookUrl) {
          // 出口 URL 自带密钥，只回主机名
          try { webhook = new URL(m.webhookUrl).host; } catch (e) { webhook = '已设置（***）'; }
        }
        return {
          enabled: !!m.enabled,
          intervalMinutes: m.intervalMs ? Math.round(m.intervalMs / 60000 * 10) / 10 : 0,
          cooldownMinutes: m.cooldownMs ? Math.round(m.cooldownMs / 60000) : 0,
          webhook,
        };
      })(),
    };
  }

  // ---------- 路由 ----------

  async function apiLogin(req, res) {
    const ip = req.socket.remoteAddress || '?';
    const rec = loginFails.get(ip);
    if (rec && rec.count >= 8 && Date.now() < rec.until) {
      await sleep(400);
      return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
    }
    const body = await readJson(req);
    if (!body.token || !safeEqual(body.token, token)) {
      loginFails.set(ip, { count: (rec && Date.now() < rec.until ? rec.count : 0) + 1, until: Date.now() + 60000 });
      await sleep(400);
      return json(res, 401, { error: '口令不正确' });
    }
    loginFails.delete(ip);
    const sid = newSession();
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.admin.sessionTtlMs / 1000)}`
    );
    return json(res, 200, { ok: true });
  }

  function apiLogout(req, res) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return json(res, 200, { ok: true });
  }

  async function apiArchiveSession(req, res, id) {
    const session = repo.getSession(id);
    if (!session) return json(res, 404, { error: '会话不存在' });
    if (session.status !== 'open') return json(res, 400, { error: '该会话已经结束了' });
    const body = await readJson(req);
    const withSummary = body.summarize !== false;
    const r = await finalizeSession({ config, repo, session, withSummary });
    logger.info(`管理台强制结束会话 #${id}（${r.messageCount} 条，片段 #${r.snippetId}）`);
    return json(res, 200, { ok: true, snippetId: r.snippetId, messageCount: r.messageCount, summary: r.summary, error: r.error });
  }

  async function apiResummarize(req, res, id) {
    const snippet = repo.getSnippet(id);
    if (!snippet) return json(res, 404, { error: '片段不存在' });
    const transcript = buildTranscript(snippet.messages);
    if (!transcript) return json(res, 400, { error: '该片段没有内容' });
    let summary;
    try {
      summary = await generateSummary(config, transcript);
    } catch (e) {
      return json(res, 502, { error: '生成失败：' + e.message });
    }
    if (!summary) return json(res, 400, { error: '没有生成结果：请先在 .env 里配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL' });
    repo.updateSnippetSummary(id, summary);
    logger.info(`管理台重新生成总结 #${id}`);
    return json(res, 200, { ok: true, summary });
  }

  async function apiSendBoomerang(req, res, id) {
    if (!client) return json(res, 400, { error: '当前是纯管理台模式，未连接 OneBot' });
    const snippet = repo.getSnippet(id);
    if (!snippet) return json(res, 404, { error: '片段不存在' });
    const user = repo.getUser(snippet.qq_id);
    const days = (user && user.boomerang_days) || config.boomerangDefaultDays;
    const cand = { kind: 'snippet', id: snippet.id, summary: snippet.summary, created_at: snippet.created_at };
    try {
      await sendBoomerang({ client, repo, userId: snippet.qq_id, cand, body: describeCandidate(cand, days) });
    } catch (e) {
      return json(res, 502, { error: '发送失败：' + e.message });
    }
    logger.info(`管理台手动回旋镖 -> ${snippet.qq_id} (snippet#${id})`);
    return json(res, 200, { ok: true });
  }

  async function apiDeleteFile(req, res, id) {
    const row = repo.deleteFile(id);
    if (!row) return json(res, 404, { error: '资料不存在' });
    // 只删 uploads 目录内的文件，避免路径穿越误删
    let removedFile = false;
    if (row.path) {
      const abs = path.resolve(row.path);
      const root = path.resolve(config.uploadsDir);
      if (abs.startsWith(root + path.sep)) {
        try {
          fs.unlinkSync(abs);
          removedFile = true;
        } catch (e) {
          logger.warn('删除上传文件失败: ' + e.message);
        }
      }
    }
    logger.info(`管理台删除资料 #${id}（磁盘文件${removedFile ? '已' : '未'}删除）`);
    return json(res, 200, { ok: true, removedFile });
  }

  async function apiDeleteUser(req, res, qq) {
    const user = repo.getUser(qq);
    if (!user) return json(res, 404, { error: '用户不存在' });
    // 先记录文件路径，再删库
    const files = repo.listFiles(qq);
    const counts = repo.deleteUser(qq);
    const root = path.resolve(config.uploadsDir);
    let removed = 0;
    for (const f of files) {
      if (!f.path) continue;
      const abs = path.resolve(f.path);
      if (!abs.startsWith(root + path.sep)) continue;
      try {
        fs.unlinkSync(abs);
        removed += 1;
      } catch (e) {
        /* ignore */
      }
    }
    logger.warn(`管理台删除用户 ${qq}：会话 ${counts.sessions}、片段 ${counts.snippets}、资料 ${counts.files}（磁盘文件 ${removed}）`);
    return json(res, 200, { ok: true, ...counts, removedFiles: removed });
  }

  async function apiExport(req, res) {
    const body = await readJson(req);
    const qq = String(body.qq || '');
    const format = String(body.format || 'zip');
    const scope = String(body.scope || 'all');
    if (!repo.getUser(qq)) return json(res, 404, { error: '用户不存在' });
    let result;
    try {
      result = await buildExport({ config, repo, userId: qq, format, scope });
    } catch (e) {
      return json(res, 500, { error: '导出失败：' + e.message });
    }
    if (result && result.error) return json(res, 400, { error: result.error });
    if (!result.files.length) return json(res, 400, { error: '该用户没有可导出的内容' });
    const sendPath = result.zipPath || result.files[0];
    const sendName = result.zipName || path.basename(sendPath);
    const buf = fs.readFileSync(sendPath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': buf.length,
      'Content-Disposition': contentDisposition(sendName),
      'Cache-Control': 'no-store',
      'X-Export-Count': String(result.count),
      'X-Export-Note': encodeURIComponent(result.note || ''),
      'X-Export-Scope': encodeURIComponent(result.scopeNote || ''),
    });
    res.end(buf);
  }

  async function apiBoomerangRun(req, res) {
    if (!boomerang) return json(res, 400, { error: '当前是纯管理台模式，回旋镖调度未启动' });
    const sent = await boomerang.run();
    return json(res, 200, { ok: true, sent });
  }

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = req.method;

    // 不需要登录
    if (p === '/api/login' && m === 'POST') return apiLogin(req, res);
    if (p === '/api/logout' && m === 'POST') return apiLogout(req, res);
    if (p === '/api/session' && m === 'GET') return json(res, 200, { authed: isAuthed(req) });

    if (!isAuthed(req)) return json(res, 401, { error: '未登录' });

    let mm;
    if (p === '/api/overview' && m === 'GET') return json(res, 200, overviewPayload());
    if (p === '/api/config' && m === 'GET') return json(res, 200, configPayload());
    if (p === '/api/logs' && m === 'GET') return json(res, 200, { logs: logger.recent(num(url, 'limit', 200)) });

    if (p === '/api/sessions' && m === 'GET') {
      const status = url.searchParams.get('status') || null;
      return json(res, 200, { items: repo.listSessions({ status, limit: num(url, 'limit', 200) }) });
    }
    if ((mm = /^\/api\/sessions\/(\d+)$/.exec(p)) && m === 'GET') {
      const session = repo.getSession(Number(mm[1]));
      if (!session) return json(res, 404, { error: '会话不存在' });
      const messages = repo.getMessages(session.id);
      const cap = 2000;
      return json(res, 200, { session, messages: messages.slice(0, cap), truncated: messages.length > cap });
    }
    if ((mm = /^\/api\/sessions\/(\d+)\/archive$/.exec(p)) && m === 'POST') {
      return apiArchiveSession(req, res, Number(mm[1]));
    }

    if (p === '/api/snippets' && m === 'GET') {
      const qqId = url.searchParams.get('qq') || null;
      const limit = num(url, 'limit', 100);
      const offset = Number(url.searchParams.get('offset')) || 0;
      return json(res, 200, { items: repo.listSnippetsAdmin({ qqId, limit, offset }) });
    }
    if ((mm = /^\/api\/snippets\/(\d+)$/.exec(p)) && m === 'GET') {
      const s = repo.getSnippet(Number(mm[1]));
      return s ? json(res, 200, s) : json(res, 404, { error: '片段不存在' });
    }
    if ((mm = /^\/api\/snippets\/(\d+)$/.exec(p)) && m === 'DELETE') {
      const ok = repo.deleteSnippet(Number(mm[1]));
      if (!ok) return json(res, 404, { error: '片段不存在' });
      logger.info(`管理台删除片段 #${mm[1]}`);
      return json(res, 200, { ok: true });
    }
    if ((mm = /^\/api\/snippets\/(\d+)\/resummarize$/.exec(p)) && m === 'POST') {
      return apiResummarize(req, res, Number(mm[1]));
    }
    if ((mm = /^\/api\/snippets\/(\d+)\/boomerang$/.exec(p)) && m === 'POST') {
      return apiSendBoomerang(req, res, Number(mm[1]));
    }

    if (p === '/api/files' && m === 'GET') {
      const qqId = url.searchParams.get('qq') || null;
      const limit = num(url, 'limit', 100);
      const offset = Number(url.searchParams.get('offset')) || 0;
      return json(res, 200, { items: repo.listFilesAdmin({ qqId, limit, offset }) });
    }
    if ((mm = /^\/api\/files\/(\d+)$/.exec(p)) && m === 'GET') {
      const f = repo.getFile(Number(mm[1]));
      return f ? json(res, 200, f) : json(res, 404, { error: '资料不存在' });
    }
    if ((mm = /^\/api\/files\/(\d+)$/.exec(p)) && m === 'DELETE') {
      return apiDeleteFile(req, res, Number(mm[1]));
    }

    if (p === '/api/users' && m === 'GET') return json(res, 200, { items: repo.listUsersAdmin() });
    if ((mm = /^\/api\/users\/([^/]+)$/.exec(p)) && m === 'PATCH') {
      const qq = decodeURIComponent(mm[1]);
      if (!repo.getUser(qq)) return json(res, 404, { error: '用户不存在' });
      const body = await readJson(req);
      const fields = {};
      if (body.display_name !== undefined) fields.display_name = String(body.display_name).slice(0, 64);
      if (body.boomerang_days !== undefined) {
        const n = Number(body.boomerang_days);
        if (!Number.isInteger(n) || n < 1 || n > 365) return json(res, 400, { error: '回旋间隔需为 1–365 的整数' });
        fields.boomerang_days = n;
      }
      if (body.summary_on !== undefined) fields.summary_on = body.summary_on ? 1 : 0;
      repo.updateUser(qq, fields);
      logger.info(`管理台修改用户 ${qq}: ${JSON.stringify(fields)}`);
      return json(res, 200, { ok: true, user: repo.getUser(qq) });
    }
    if ((mm = /^\/api\/users\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      return apiDeleteUser(req, res, decodeURIComponent(mm[1]));
    }

    if (p === '/api/search' && m === 'GET') {
      const q = url.searchParams.get('q') || '';
      return json(res, 200, { items: repo.searchAll(q, num(url, 'limit', 50)), q });
    }

    if (p === '/api/boomerangs' && m === 'GET') {
      return json(res, 200, {
        items: repo.boomerangQueue((u) => u.boomerang_days || config.boomerangDefaultDays),
        history: repo.listBoomerangHistory({ limit: num(url, 'limit', 100) }),
        sentTotal: repo.countBoomerangSent(),
      });
    }
    if (p === '/api/boomerangs/run' && m === 'POST') return apiBoomerangRun(req, res);

    if (p === '/api/redactions' && m === 'GET') {
      return json(res, 200, { items: repo.listRedactions(num(url, 'limit', 100)) });
    }

    if (p === '/api/export' && m === 'POST') return apiExport(req, res);

    if (p === '/api/onebot/reconnect' && m === 'POST') {
      if (!client) return json(res, 400, { error: '当前是纯管理台模式' });
      client.reconnect();
      logger.info('管理台触发 OneBot 重连');
      return json(res, 200, { ok: true });
    }

    // 手动跑一次掉线探活，立刻拿到结论（不用等下一个周期）
    if (p === '/api/monitor/check' && m === 'POST') {
      if (!monitor) return json(res, 400, { error: '掉线监控未启用' });
      const st = await monitor.run();
      return json(res, 200, { ok: true, status: st });
    }

    return json(res, 404, { error: '未知接口' });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      fs.readFile(UI_PATH, (err, buf) => {
        if (err) return text(res, 500, '管理台页面缺失: ' + err.message);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const h = healthPayload();
      return json(res, h.ok ? 200 : 503, h);
    }
    if (!url.pathname.startsWith('/api/')) return text(res, 404, 'not found');
    handleApi(req, res, url).catch((e) => {
      logger.error('管理台接口异常: ' + (e.stack || e.message));
      if (!res.headersSent) json(res, 500, { error: e.message });
      else try { res.end(); } catch (err) { /* ignore */ }
    });
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.admin.port, config.admin.host, () => {
        const addr = server.address();
        resolve(addr);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, start, stop, token, tokenGenerated, isAuthed, port: () => server.address() };
}

module.exports = { createAdminServer };
