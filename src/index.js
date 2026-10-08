'use strict';
const path = require('node:path');
const { loadConfig } = require('./config');
const logger = require('./logger');
const { openDb } = require('./db');
const { createRepo } = require('./repo');
const { OneBotClient } = require('./onebot/client');
const { createBot } = require('./core/bot');
const { startBoomerang } = require('./core/boomerang');
const { createMonitor } = require('./monitor');
const { createAdminServer } = require('./admin/server');

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const config = loadConfig(rootDir);
  const startedAt = Date.now();

  const db = openDb(config.dbPath);
  const repo = createRepo(db);

  let client = null;
  let bot = null;
  let boomerang = null;
  let monitor = null;

  if (config.admin.only) {
    logger.warn('ADMIN_ONLY 模式：只启动管理台，不连接 OneBot');
  } else {
    client = new OneBotClient({
      url: config.onebot.wsUrl,
      accessToken: config.onebot.accessToken,
      echoTimeoutMs: config.onebot.echoTimeoutMs,
      onEvent: (ev) => {
        bot.handleEvent(ev).catch((e) => logger.error('处理事件失败: ' + (e.stack || e.message)));
      },
    });
    bot = createBot({ config, repo, client });
    client.start();
    boomerang = startBoomerang({ config, repo, client });
  }

  // 掉线监控：进程活着但账号掉线，外部探活看不出来，只有它能发现
  monitor = createMonitor({ config, client });
  monitor.start();

  const admin = createAdminServer({ config, repo, client, boomerang, monitor, startedAt });
  let adminAddr = null;
  try {
    adminAddr = await admin.start();
  } catch (e) {
    logger.error('管理台启动失败：' + e.message + '（机器人继续运行）');
  }

  logger.info('【肥肥风筝猫】已启动');
  logger.info(`数据目录：${config.dataDir}`);
  logger.info(`OneBot：${config.admin.only ? '未连接（ADMIN_ONLY）' : config.onebot.wsUrl}`);
  logger.info(`总结：${config.llm.apiKey && config.llm.model ? '开启' : '关闭（未配置 LLM）'}`);
  logger.info(`PDF 字体：${config.fontPath || '未探测到（导出回退 txt）'}`);

  if (adminAddr) {
    const shown = isLoopback(config.admin.host) ? '127.0.0.1' : config.admin.host;
    logger.info(`管理台：http://${shown}:${adminAddr.port}/`);
    if (admin.tokenGenerated) {
      logger.warn(`本次未设置 ADMIN_TOKEN，已随机生成登录口令（重启会变）：${admin.token}`);
      logger.warn('建议在 .env 里固定 ADMIN_TOKEN=<你自己的口令>');
    }
    if (!isLoopback(config.admin.host)) {
      logger.warn(`⚠️  管理台绑定在 ${config.admin.host}，可被外部访问。请务必设置强 ADMIN_TOKEN，并优先通过内网 / SSH 隧道访问。`);
    }
  }

  const shutdown = () => {
    logger.info('退出中…');
    if (boomerang) boomerang.stop();
    if (monitor) monitor.stop();
    if (client) client.stop();
    if (adminAddr) admin.stop().catch(() => {});
    try { db.close(); } catch (e) { /* ignore */ }
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('启动失败：' + (e.stack || e.message));
  process.exit(1);
});
