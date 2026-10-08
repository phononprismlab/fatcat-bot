'use strict';
// 容器 HEALTHCHECK 用的探活脚本。
//
// 为什么单独写成文件而不是写在 Dockerfile 的 HEALTHCHECK 里：
// HEALTHCHECK 的 shell 形式会先经过 Dockerfile 的变量展开，`$` 和引号很容易被吃掉，
// 报错还很难懂。独立脚本没有这层转义问题。
//
// 退出码：0 健康 / 1 不健康。容器状态因此能真实反映「QQ 连着没」，
// 而不是仅仅「进程还在不在」。

const port = process.env.ADMIN_PORT || 8787;
const host = process.env.ADMIN_HEALTH_HOST || '127.0.0.1';
const url = `http://${host}:${port}/healthz`;

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 4000);

fetch(url, { signal: ctrl.signal })
  .then(async (resp) => {
    clearTimeout(timer);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`不健康：HTTP ${resp.status} ${body.slice(0, 200)}`);
      process.exit(1);
    }
    const data = await resp.json().catch(() => ({}));
    console.log(`健康：mode=${data.mode} connected=${data.bot && data.bot.connected}`);
    process.exit(0);
  })
  .catch((e) => {
    clearTimeout(timer);
    console.error('不健康：' + e.message);
    process.exit(1);
  });
