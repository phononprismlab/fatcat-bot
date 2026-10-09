'use strict';
const path = require('node:path');
const logger = require('../logger');
const { extractText, findSegments } = require('../onebot/message');
const { buildExport } = require('./export');
const { ingestUpload } = require('./upload');
const { finalizeSession } = require('./session');
const { sendBoomerang } = require('./boomerang');
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

  // 涉及口嗨内容的回执一律走私聊，群里只留一句提示 —— 避免把"你口嗨过什么"贴在群里。
  // 私聊发不出去（未加好友等）时退回群里，并明确说明。
  async function replyPrivateFirst(userId, groupId, body, okNote) {
    if (!groupId) {
      await reply(userId, null, body);
      return;
    }
    try {
      await client.sendPrivateMsg(userId, [{ type: 'text', data: { text: body } }]);
      await reply(userId, groupId, okNote);
    } catch (e) {
      logger.warn('私聊发送失败，回退群聊: ' + e.message);
      await reply(userId, groupId, body + '\n\n（私聊发送失败，已改发到群里）');
    }
  }

  // 首次在某群开启记录前发的知情同意公告。
  // 记录窗口会捕获群内其他人的发言，托管档持有第三方数据 —— 必须明示。
  const GROUP_NOTICE = [
    '【肥肥风筝猫】本群开始记录口嗨。',
    '· 记录范围：从现在起，到喊「我口嗨完了」为止，本群所有人的发言（含其他人）',
    '· 归属：以喊口令的人为准；其他人说的话会一并存进 TA 的记录',
    '· 用途：只供记录者本人查询与导出，不会主动发到群里',
    '· 撤回：任何人都可以随时发「/撤回我的发言」，删掉自己在本群被记录的全部发言',
    '· 继续发言即视为知悉并同意以上说明',
  ].join('\n');

  // ---- 记录状态机 ----
  async function startRecording(userId, groupId, isGroup) {
    // 用合成键判断「该上下文是否已在记录」，允许群记录与私聊记录并存
    const sKey = isGroup ? groupId : ('private:' + userId);
    const existing = repo.getOpenSessionsByGroup(sKey).find((s) => s.qq_id === userId);
    if (existing) {
      await reply(userId, groupId, '【肥肥风筝猫】你已经在记录中啦，喊「我口嗨完了」结束～');
      return;
    }
    // 每个群只告知一次；私聊不弹群体知情同意公告（记录的是你自己）
    if (isGroup && !repo.hasGroupNotice(groupId)) {
      await reply(userId, groupId, GROUP_NOTICE);
      repo.markGroupNotice(groupId);
    }
    repo.createSession(userId, sKey);
    const tip = isGroup
      ? '【肥肥风筝猫】开始记录啦～大家随便聊，口嗨完喊「我口嗨完了」'
      : '【肥肥风筝猫】开始记录啦～这条私聊里的发言我都会记下来，口嗨完喊「我口嗨完了」';
    await reply(userId, groupId, tip);
  }

  async function endRecording(userId, groupId, isGroup) {
    const sKey = isGroup ? groupId : ('private:' + userId);
    const open = repo.getOpenSessionsByGroup(sKey).find((s) => s.qq_id === userId);
    if (!open) {
      await reply(userId, groupId, '【肥肥风筝猫】你现在没有在记录哦');
      return;
    }
    const user = repo.getUser(userId);
    const withSummary = !user || user.summary_on !== 0;
    const { summary } = await finalizeSession({ config, repo, session: open, withSummary });

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
  const KIND_LABEL = { snippet: '口嗨', file: '资料', summary: '总结' };

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
      const src = KIND_LABEL[h.kind] || '口嗨';
      const excerpt = String(h.content).replace(/\s+/g, ' ').slice(0, 80);
      return `${i + 1}. [${src}#${h.ref_id}] ${excerpt}…`;
    });
    const body = `【肥肥风筝猫】找到 ${hits.length} 条：\n` + lines.join('\n') +
      '\n\n（想带走全文：/导出 pdf #编号）';
    // 命中含口嗨原文摘录，走私聊，别贴群
    await replyPrivateFirst(ctx.userId, ctx.groupId, body, '【肥肥风筝猫】查询结果已发到你的私聊～');
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
    if (result && result.error) {
      await reply(ctx.userId, ctx.groupId, '【肥肥风筝猫】' + result.error);
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
      await reply(
        ctx.userId,
        ctx.groupId,
        `已导出 ${result.count} 篇（范围：${result.scopeNote || scope}），文件已发到你的私聊：${sendName}${result.note || ''}`
      );
    } catch (e) {
      await reply(ctx.userId, ctx.groupId, `导出完成（${result.count} 篇），文件在服务器：${sendPath}（发送失败：${e.message}）`);
    }
  }

  // 撤回：删掉自己在本群被记录的全部发言（真删），并重建受影响片段的检索索引
  async function cmdRedact(ctx) {
    if (!ctx.isGroup) {
      await reply(ctx.userId, ctx.groupId, '【肥肥风筝猫】这个指令要在群里用——它删的是「你在某个群被记录的发言」');
      return;
    }
    const r = repo.deleteMessagesByUserInGroup(ctx.userId, ctx.groupId);
    if (!r.removed) {
      await reply(ctx.userId, ctx.groupId, '【肥肥风筝猫】本群没有你的被记录发言，不用撤回～');
      return;
    }
    let rebuilt = 0;
    for (const sid of r.sessionIds) {
      try {
        if (repo.reindexSnippet(sid)) rebuilt++;
      } catch (e) {
        logger.warn('重建索引失败 session#' + sid + ': ' + e.message);
      }
    }
    await reply(
      ctx.userId,
      ctx.groupId,
      `【肥肥风筝猫】已删除你在本群被记录的 ${r.removed} 条发言（涉及 ${rebuilt} 篇记录）。\n` +
        '相关检索索引已同步更新，之后 /查询 不会再搜到这些内容。'
    );
  }

  async function cmdUpload(ctx) {
    await reply(
      ctx.userId,
      ctx.groupId,
      [
        '【肥肥风筝猫】直接把文件发给我就行（群聊、私聊都可以），不用指令。',
        '· 支持格式：txt / md',
        '· 单个文件上限 2MB',
        '· 收到后我会解析成文本收进你的资料库，以后 /查询 就能搜到',
      ].join('\n')
    );
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
    await sendBoomerang({ client, repo, userId: ctx.userId, cand, body });
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
    const body = `你有 ${s.snippets} 篇口嗨、${s.files} 份资料\n最近一篇：${last}`;
    await replyPrivateFirst(ctx.userId, ctx.groupId, body, '【肥肥风筝猫】统计已发到你的私聊～');
  }

  async function cmdHelp(ctx) {
    await reply(
      ctx.userId,
      ctx.groupId,
      [
        '【肥肥风筝猫】指令：',
        '我要口嗨了 / 我口嗨完了 —— 开始/结束记录（记录本群所有人的发言）',
        '直接发文件 —— 收录 txt / md 资料（或 /上传 看说明）',
        '/查询 <关键词> —— 搜自己的口嗨与资料（结果走私聊）',
        '/导出 <txt|md|pdf> [范围] —— 导出并打包',
        '    范围：all（默认）/ recent 5 / 3（最近3篇）/ #12（指定某一篇）/ 片段12 / 资料12',
        '/回旋镖 [设置 <天数>] —— 手动回旋 / 设置间隔',
        '/总结 on|off —— 开关口嗨总结',
        '/我的 —— 我的统计',
        '/撤回我的发言 —— 删掉自己在本群被记录的全部发言',
        '/帮助 —— 这条列表',
      ].join('\n')
    );
  }

  const COMMANDS = {
    查询: cmdQuery,
    导出: cmdExport,
    回旋镖: cmdBoomerang,
    总结: cmdSummary,
    我的: cmdMine,
    上传: cmdUpload,
    撤回我的发言: cmdRedact,
    帮助: cmdHelp,
    help: cmdHelp,
  };

  // ---- 文件上传 ----
  async function handleFileUpload(userId, groupId, { fileId, fileName, directUrl }) {
    try {
      const r = await ingestUpload({ config, repo, client, userId, fileId, fileName, directUrl });
      if (r.ok) {
        const enc = r.encoding && r.encoding.indexOf('gb18030') === 0 ? `，按 ${r.encoding} 解码` : '';
        await reply(userId, groupId, `【肥肥风筝猫】已收录你的资料：《${r.name}》（${r.chars} 字${enc}）\n以后用 /查询 就能搜到它`);
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

    // 私聊没有 group_id；用合成键区分「私聊会话」与「群会话」，互不串台。
    // 回复一律用真实 groupId（私聊为 null -> 走 sendPrivateMsg），保证回私聊。
    const sessionGroupId = isGroup ? groupId : ('private:' + userId);

    if (text && text.includes(config.startPhrase)) {
      await startRecording(userId, groupId, isGroup);
      return;
    }
    if (text && text.includes(config.endPhrase)) {
      await endRecording(userId, groupId, isGroup);
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

    capture(sessionGroupId, userId, name, text, ts);
  }

  return { handleEvent, COMMANDS };
}

module.exports = { createBot };
