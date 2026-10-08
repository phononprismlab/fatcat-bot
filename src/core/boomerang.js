'use strict';
const logger = require('../logger');

// 回旋镖：把旧口嗨/资料推回给用户。
// sendBoomerang 是唯一的「发出去 + 记已发」入口，机器人手动触发、定时任务、管理台都用它。

async function sendBoomerang({ client, repo, userId, cand, body }) {
  const text = `🪃 回旋镖！\n${body}\n\n…还有后续吗？`;
  await client.sendPrivateMsg(userId, [{ type: 'text', data: { text } }]);
  const ts = Date.now();
  if (cand.kind === 'snippet') repo.setSnippetSent(cand.id, ts);
  else repo.setFileSent(cand.id, ts);
  // 留一条发送历史，便于运维回答「这个用户被推了几次、推的是哪条」
  repo.addBoomerangRecord(userId, cand.id, cand.kind);
  return text;
}

function describeCandidate(cand, days) {
  if (cand.kind === 'snippet') {
    return cand.summary ? `你 ${days} 天前口嗨过：\n${cand.summary}` : `你 ${days} 天前口嗨过一段内容。`;
  }
  return `你之前上传的资料《${cand.summary}》，还想得起来吗？`;
}

// 定时调度：每隔 intervalMs 扫一遍所有用户
function startBoomerang({ config, repo, client, intervalMs = 30 * 60 * 1000 }) {
  async function run() {
    const now = Date.now();
    const users = repo.listUsers();
    let sent = 0;
    for (const u of users) {
      try {
        const days = u.boomerang_days || config.boomerangDefaultDays;
        const cand = repo.pickBoomerangCandidate(u.qq_id, now - days * 86400000);
        if (!cand) continue;
        await sendBoomerang({ client, repo, userId: u.qq_id, cand, body: describeCandidate(cand, days) });
        sent += 1;
        logger.info(`回旋镖 -> ${u.qq_id} (${cand.kind}#${cand.id})`);
      } catch (e) {
        logger.warn(`回旋镖推送失败 ${u.qq_id}: ${e.message}`);
      }
    }
    return sent;
  }

  const timer = setInterval(() => {
    run().catch((e) => logger.warn('回旋镖任务异常: ' + e.message));
  }, intervalMs);
  if (timer.unref) timer.unref();

  return { run, stop: () => clearInterval(timer) };
}

module.exports = { startBoomerang, sendBoomerang, describeCandidate };
