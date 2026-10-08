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

function loadConfig(rootDir) {
  loadEnvFile(path.join(rootDir, '.env'));
  const env = process.env;
  const dataDir = path.resolve(rootDir, env.DATA_DIR || './data');
  return {
    rootDir,
    dataDir,
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
  };
}

module.exports = { loadConfig };
