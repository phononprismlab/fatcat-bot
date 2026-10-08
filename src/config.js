'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 极简 .env 加载（不依赖 dotenv），已存在的环境变量优先
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// PDF 导出需要一款中文字体（.ttf 或 .ttc）。优先用 FONT_PATH，否则按平台惯例探测。
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/simfang.ttf',
  'C:/Windows/Fonts/Deng.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simsun.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
];

function resolveFontPath(explicit) {
  const list = explicit ? [explicit, ...FONT_CANDIDATES] : FONT_CANDIDATES;
  for (const p of list) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
    } catch (e) {
      /* ignore */
    }
  }
  return '';
}

function loadConfig(rootDir) {
  loadEnvFile(path.join(rootDir, '.env'));
  const env = process.env;
  const dataDir = path.resolve(rootDir, env.DATA_DIR || './data');
  return {
    rootDir,
    dataDir,
    fontPath: resolveFontPath(env.FONT_PATH),
    dbPath: path.join(dataDir, 'fatcat.db'),
    exportsDir: path.join(dataDir, 'exports'),
    uploadsDir: path.join(dataDir, 'uploads'),
    onebot: {
      wsUrl: env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001',
      accessToken: env.ONEBOT_ACCESS_TOKEN || '',
      echoTimeoutMs: Number(env.ONEBOT_ECHO_TIMEOUT_MS || 15000),
    },
    commandPrefix: env.COMMAND_PREFIX || '/',
    startPhrase: env.START_PHRASE || '我要口嗨了',
    endPhrase: env.END_PHRASE || '我口嗨完了',
    llm: {
      baseUrl: env.LLM_BASE_URL || '',
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || '',
    },
    boomerangDefaultDays: Number(env.BOOMERANG_DEFAULT_DAYS || 3),
    // 单用户资料库字符上限（0 = 不限制）
    userQuotaChars: env.USER_QUOTA_CHARS === undefined ? undefined : Number(env.USER_QUOTA_CHARS),
    admin: {
      // 默认只监听本机；要对外暴露必须显式改 ADMIN_HOST，启动时会告警
      host: env.ADMIN_HOST || '127.0.0.1',
      port: Number(env.ADMIN_PORT || 8787),
      token: env.ADMIN_TOKEN || '',
      sessionTtlMs: Number(env.ADMIN_SESSION_TTL_HOURS || 12) * 3600 * 1000,
      // ADMIN_ONLY=1：只开管理台，不连 OneBot（NapCat 挂了也能进来看数据）
      only: env.ADMIN_ONLY === '1' || env.ADMIN_ONLY === 'true',
    },
  };
}

module.exports = { loadConfig };
