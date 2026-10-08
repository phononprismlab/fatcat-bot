'use strict';
const logger = require('../logger');
const { generateSummary } = require('./summary');
const { fmtTime } = require('../utils/time');

// 把「结束一次口嗨记录」这件事收在一处：归档会话 -> 生成总结 -> 建片段 -> 建检索索引。
// 机器人（用户喊「我口嗨完了」）和管理台（强制结束）都走这里，避免两套逻辑走偏。

function buildTranscript(messages) {
  return messages.map((m) => `${m.name}(${m.qq_id}) ${fmtTime(m.ts)}\n${m.content}`).join('\n\n');
}

// 返回 { snippetId, summary, messageCount, transcript, error }
async function finalizeSession({ config, repo, session, withSummary = true }) {
  repo.archiveSession(session.id);
  const messages = repo.getMessages(session.id);
  const transcript = buildTranscript(messages);

  let summary = null;
  let error = null;
  if (withSummary) {
    try {
      summary = await generateSummary(config, transcript);
    } catch (e) {
      error = e.message;
      logger.warn('生成总结失败: ' + e.message);
    }
  }

  const snippetId = repo.createSnippet(session.id, session.qq_id, summary);
  repo.indexAdd(transcript, session.qq_id, 'snippet', snippetId);
  // 总结单独入索引：只在总结里出现、原文没有的词也要能搜到（查询结果里单独标注）
  if (summary) repo.indexAdd(summary, session.qq_id, 'summary', snippetId);

  return { snippetId, summary, messageCount: messages.length, transcript, error };
}

module.exports = { finalizeSession, buildTranscript };
