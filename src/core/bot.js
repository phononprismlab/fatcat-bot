'use strict';
const path = require('node:path');
const logger = require('../logger');
const { extractText, findSegments } = require('../onebot/message');
const { generateSummary } = require('./summary');
const { buildExport } = require('./export');
const { ingestUpload } = require('./upload');
const { fmtTime } = require('../utils/time');

function createBot({ config, repo, client }) {
  // ---- 工具 ----
  function parseCommand(text) {
    const t = (text || '').trim();
    if (!t.startsWith(config.commandPrefix)) return null;
    const rest = t.slice(config.commandPrefix.length).trim();
    if (!rest) return null;
    const parts = rest.split(/\s+/);
    return { name: parts[0], args: parts.slice(1) };
  }

  async function reply(userId, groupId, text) {
    const seg = [{ type: 'text', data: { text } }];
    if (groupId) return client.sendGroupMsg(groupId, seg);
    return client.sendPrivateMsg(userId, seg);
  }

  function buildTranscript(messages) {
    return messages.map((m) => `${m.name}(${m.qq_id}) ${fmtTime(m.ts)}\n${m.content}`).join('\n\n');
  }

  // ---- 记录状态机 ----
  async function startRecording(userId, groupId) {
    if (repo.getOpenSession(userId)) {
      await reply(userId, groupId, '【肥肥风筝猫】你已经在记录中啦，喊「我口嗨完了」结束～');
      return;
    }
    repo.createSession(userId, groupId);
    await reply(userId, groupId, '【肥肥风筝猫】开始记录啦～大家随便聊，口嗨完喊「我口嗨完了」');
  }

  async function endRecording(userId, groupId) {
    const open = repo.getOpenSession(userId);
    if (!open) {
      await reply(userId, groupId, '【肥肥风筝猫】你现在没有在记录哦');
      return;
    }
    repo.archiveSession(open.id);
    const messages = repo.getMessages(open.id);
    const transcript = buildTranscript(messages);

    const user = repo.getUser(userId);
    let summary = null;
    if (!user || user.summary_on !== 0) {
      try {
        summary = await generateSummary(config, transcript);
      } catch (e) {
        logger.warn('生成总结失败: ' + e.message);
      }
    }

    const sid = repo.createSnippet(open.id, userId, summary);
    repo.indexAdd(transcript, userId, 'snippet', sid);

    await reply(userId, groupId, '【肥肥风筝猫已经记录下你的口嗨。】');
    const priv = summary ? `本次口嗨总结：\n${summary}` : '（本次未生成总结，原文已存档）';
    try {
      await client.sendPrivateMsg(userId, [{ type: 'text', data: { text: priv } }]);
    } catch (e) {
      logger.warn('私聊总结发送失败: ' + e.message);
    }
  }

  // 记录窗口内，捕获本群所有人的发言（按说话者归属到每个开启中的会话）
  function capture(groupId, userId, name, text, ts) {
    if (!groupId || !text) return;
    const opens = repo.getOpenSessionsByGroup(groupId);
    for (const s of opens) {
      repo.addMessage(s.id, userId, name, text, ts, s.qq_id === userId);
    }
  }

  // ---- 指令 ----
  async function cmdQuery(ctx) {
    const kw = ctx.args.join(' ');
    if (!kw) {
      await reply(ctx.userId, ctx.groupId, '用法：/查询 <关键词>');
      return;
    }
    const hits = repo.search(ctx.userId, kw, 10);
    if (!hits.length) {
      await reply(ctx.userId, ctx.groupId, `没有找到和「${kw}」相关的口嗨`);
      return;
    }
    const lines = hits.map((h, i) => {
      const src = h.kind === 'file' ? '资料' : '口嗨';
      const excerpt = String(h.content).replace(/\s+/g, ' ').slice(0, 80);
      return `${i + 1}. [${src}#${h.ref_id}] ${excerpt}…`;
    });
    await reply(ctx.userId, ctx.groupId, `找到 ${hits.length} 条：\n` + lines.join('\n'));
  }

  async function cmdExport(ctx) {
    const fmt = (ctx.args[0] || 'txt').toLowerCase();
    const scope = ctx.args[1] || 'all';
    if (!['txt', 'md', 'pdf', 'zip'].includes(fmt)) {
      await reply(ctx.userId, ctx.groupId, '格式支持：txt / md / pdf');
      return;
    }
    let result;
    try {
      result = await buildExport({ config, repo, userId: ctx.userId, format: fmt, scope });
    } catch (e) {
      await reply(ctx.userId, ctx.groupId, '导出失败：' + e.message);
      return;
    }
    if (!result || !result.files.length) {
      await reply(ctx.userId, ctx.groupId, '你还没有可导出的口嗨或资料');
      return;
    }
    const sendPath = result.zipPath || result.files[0];
    const sendName = result.zipName || path.basename(sendPath);
    try {
      await client.uploadPrivateFile(ctx.userId, sendPath, sendName);
      await reply(ctx.userId, ctx.groupId, `已导出 ${result.count} 篇，文件已发到你的私聊：${sendName}${result.note || ''}`);
    } catch (e) {
      await reply(ctx.userId, ctx.groupId, `导出完成（${result.count} 篇），文件在服务器：${sendPath}（发送失败：${e.message}）`);
    }
  }

  async function cmdBoomerang(ctx) {
    if (ctx.args[0] === '设置' && ctx.args[1]) {
      const n = parseInt(ctx.args[1], 10);
      if (!n || n < 1) {
        await reply(ctx.userId, ctx.groupId, '用法：/回旋镖 设置 <天数>');
        return;
      }
      repo.setUserSetting(ctx.userId, 'boomerang_days', n);
      await reply(ctx.userId, ctx.groupId, `好的，回旋镖间隔已设为 ${n} 天`);
      return;
    }
    const user = repo.getUser(ctx.userId);
    const days = (user && user.boomerang_days) || config.boomerangDefaultDays;
    const cand =
      repo.pickBoomerangCandidate(ctx.userId, Date.now() - days * 86400000) ||
      repo.pickBoomerangCandidate(ctx.userId, Date.now());
    if (!cand) {
      await reply(ctx.userId, ctx.groupId, '你还没有可以回旋的口嗨哦');
      return;
    }
    const body = cand.kind === 'snippet' ? cand.summary || '（片段）' : `你上传的资料《${cand.summary}》`;
    await client.sendPrivateMsg(ctx.userId, [{ type: 'text', data: { text: `🪃 回旋镖！\n${body}\n\n…还有后续吗？` } }]);
    if (cand.kind === 'snippet') repo.setSnippetSent(cand.id, Date.now());
    else repo.setFileSent(cand.id, Date.now());
    await reply(ctx.userId, ctx.groupId, '回旋镖已私聊发给你啦～');
  }

  async function cmdSummary(ctx) {
    const v = (ctx.args[0] || '').toLowerCase();
    if (v === 'on' || v === '开') {
      repo.setUserSetting(ctx.userId, 'summary_on', 1);
      await reply(ctx.userId, ctx.groupId, '总结已开启');
      return;
    }
    if (v === 'off' || v === '关') {
      repo.setUserSetting(ctx.userId, 'summary_on', 0);
      await reply(ctx.userId, ctx.groupId, '总结已关闭');
      return;
    }
    await reply(ctx.userId, ctx.groupId, '用法：/总结 on|off');
  }

  async function cmdMine(ctx) {
    const s = repo.stats(ctx.userId);
    const last = s.lastCreatedAt ? fmtTime(s.lastCreatedAt) : '暂无';
    await reply(ctx.userId, ctx.groupId, `你有 ${s.snippets} 篇口嗨、${s.files} 份资料\n最近一篇：${last}`);
  }

  async function cmdHelp(ctx) {
    await reply(
      ctx.userId,
      ctx.groupId,
      [
        '【肥肥风筝猫】指令：',
        '我要口嗨了 / 我口嗨完了 —— 开始/结束记录（记录本群所有人的发言）',
        '/查询 <关键词> —— 搜自己的口嗨',
        '/导出 <txt|md|pdf> [all|recent N] —— 导出并打包',
        '/回旋镖 [设置 <天数>] —— 手动回旋 / 设置间隔',
        '/总结 on|off —— 开关口嗨总结',
        '/我的 —— 我的统计',
      ].join('\n')
    );
  }

  const COMMANDS = {
    查询: cmdQuery,
    导出: cmdExport,
    回旋镖: cmdBoomerang,
    总结: cmdSummary,
    我的: cmdMine,
    帮助: cmdHelp,
    help: cmdHelp,
  };

  // ---- 文件上传 ----
  async function handleFileUpload(userId, groupId, { fileId, fileName, directUrl }) {
    try {
      const r = await ingestUpload({ config, repo, client, userId, fileId, fileName, directUrl });
      if (r.ok) {
        await reply(userId, groupId, `【肥肥风筝猫】已收录你的资料：《${r.name}》（${r.chars} 字）\n以后用 /查询 就能搜到它`);
      } else {
        await reply(userId, groupId, `【肥肥风筝猫】${r.reason}`);
      }
    } catch (e) {
      logger.warn('文件收录失败: ' + e.message);
      await reply(userId, groupId, '【肥肥风筝猫】这个文件我没能收下：' + e.message);
    }
  }

  // ---- 事件入口 ----
  async function handleEvent(ev) {
    if (!ev) return;

    // 通知类事件：群文件上传 / 私聊离线文件
    if (ev.post_type === 'notice') {
      const userId = ev.user_id != null ? String(ev.user_id) : null;
      const groupId = ev.group_id != null ? String(ev.group_id) : null;
      if (ev.notice_type === 'group_upload' && ev.file && userId) {
        await handleFileUpload(userId, groupId, {
          fileId: ev.file.id || ev.file.file_id,
          fileName: ev.file.name,
        });
      } else if (ev.notice_type === 'offline_file' && ev.file && userId) {
        await handleFileUpload(userId, groupId, {
          fileId: ev.file.id || ev.file.file_id,
          fileName: ev.file.name,
          directUrl: ev.file.url,
        });
      }
      return;
    }

    if (ev.post_type !== 'message') return;
    const isGroup = ev.message_type === 'group';
    const groupId = ev.group_id != null ? String(ev.group_id) : null;
    const userId = String(ev.user_id);
    const name = (ev.sender && (ev.sender.card || ev.sender.nickname)) || '';
    const text = extractText(ev.message).trim();
    const ts = ev.time ? ev.time * 1000 : Date.now();

    repo.upsertUser(userId, name);

    // 消息里带文件段 -> 收录资料
    const fileSegs = findSegments(ev.message, 'file');
    if (fileSegs.length) {
      for (const seg of fileSegs) {
        const d = seg.data || {};
        await handleFileUpload(userId, groupId, {
          fileId: d.file_id || d.file,
          fileName: d.name || d.file_name,
          directUrl: d.url,
        });
      }
      if (!text) return;
    }

    if (isGroup && text && text.includes(config.startPhrase)) {
      await startRecording(userId, groupId);
      return;
    }
    if (text && text.includes(config.endPhrase)) {
      await endRecording(userId, groupId);
      return;
    }

    const cmd = parseCommand(text);
    if (cmd) {
      const handler = COMMANDS[cmd.name];
      if (handler) {
        await handler({ userId, groupId, isGroup, args: cmd.args, raw: text });
      }
      return;
    }

    capture(groupId, userId, name, text, ts);
  }

  return { handleEvent, COMMANDS };
}

module.exports = { createBot };
