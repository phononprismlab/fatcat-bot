'use strict';
const path = require('node:path');
const { loadConfig } = require('./config');
const logger = require('./logger');
const { openDb } = require('./db');
const { createRepo } = require('./repo');
const { OneBotClient } = require('./onebot/client');
const { createBot } = require('./core/bot');
const { startBoomerang } = require('./core/boomerang');

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const config = loadConfig(rootDir);

  const db = openDb(config.dbPath);
  const repo = createRepo(db);

  let bot;
  const client = new OneBotClient({
    url: config.onebot.wsUrl,
    accessToken: config.onebot.accessToken,
    echoTimeoutMs: config.onebot.echoTimeoutMs,
    onEvent: (ev) => {
      bot.handleEvent(ev).catch((e) => logger.error('处理事件失败: ' + (e.stack || e.message)));
    },
  });
  bot = createBot({ config, repo, client });

  client.start();
  const boomerang = startBoomerang({ config, repo, client });

  logger.info('【肥肥风筝猫】已启动');
  logger.info(`数据目录：${config.dataDir}`);
  logger.info(`OneBot：${config.onebot.wsUrl}`);
  logger.info(`总结：${config.llm.apiKey ? '开启' : '关闭（未配置 LLM）'}`);

  const shutdown = () => {
    logger.info('退出中…');
    boomerang.stop();
    client.stop();
    try { db.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
