'use strict';
const logger = require('../logger');

// 回旋镖调度：定时把旧口嗨/资料推回给用户
function startBoomerang({ config, repo, client, intervalMs = 30 * 60 * 1000 }) {
  async function run() {
    const now = Date.now();
    const users = repo.listUsers();
    for (const u of users) {
      try {
        const days = u.boomerang_days || config.boomerangDefaultDays;
        const cutoff = now - days * 86400000;
        const cand = repo.pickBoomerangCandidate(u.qq_id, cutoff);
        if (!cand) continue;

        const body =
          cand.kind === 'snippet'
            ? cand.summary
              ? `你 ${days} 天前口嗨过：\n${cand.summary}`
              : `你 ${days} 天前口嗨过一段内容。`
            : `你之前上传的资料《${cand.summary}》，还想得起来吗？`;

        await client.sendPrivateMsg(u.qq_id, [
          { type: 'text', data: { text: `🪃 回旋镖！\n${body}\n\n…还有后续吗？` } },
        ]);

        if (cand.kind === 'snippet') repo.setSnippetSent(cand.id, now);
        else repo.setFileSent(cand.id, now);

        logger.info(`回旋镖 -> ${u.qq_id} (${cand.kind}#${cand.id})`);
      } catch (e) {
        logger.warn(`回旋镖推送失败 ${u.qq_id}: ${e.message}`);
      }
    }
  }

  const timer = setInterval(() => {
    run().catch((e) => logger.warn('回旋镖任务异常: ' + e.message));
  }, intervalMs);
  if (timer.unref) timer.unref();

  return { run, stop: () => clearInterval(timer) };
}

module.exports = { startBoomerang };
