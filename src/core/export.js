'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createZip } = require('../utils/zip');
const { sanitizeFilename } = require('../utils/filenames');
const { fmtTime } = require('../utils/time');
const { renderPdf } = require('../utils/pdf');

function buildSnippetText(snippet, messages, owner) {
  const head = [
    `[片段 #${snippet.id}] 记录于 ${fmtTime(snippet.created_at)}`,
    `归属：${owner.display_name || ''}(${owner.qq_id})`,
    ''.padEnd(60, '-'),
  ].join('\n');
  const body = messages.map((m) => `${m.name}(${m.qq_id}) ${fmtTime(m.ts)}\n${m.content}`).join('\n\n');
  const sum = snippet.summary ? `\n\n【总结】\n${snippet.summary}\n` : '';
  return `${head}\n${body}${sum}\n`;
}

function buildSnippetMd(snippet, messages, owner) {
  const lines = [
    `## 片段 #${snippet.id}`,
    '',
    `- 记录时间：${fmtTime(snippet.created_at)}`,
    `- 归属：${owner.display_name || ''}(${owner.qq_id})`,
    '',
  ];
  if (snippet.summary) lines.push(`> **总结**：${snippet.summary.replace(/\n/g, ' ')}`, '');
  lines.push('| 说话人 | 时间 | 内容 |', '| --- | --- | --- |');
  for (const m of messages) {
    lines.push(`| ${m.name} | ${fmtTime(m.ts)} | ${String(m.content).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildFileText(file, owner) {
  return [
    `[资料 #${file.id}] ${file.filename}`,
    `上传于 ${fmtTime(file.uploaded_at)}`,
    `归属：${owner.display_name || ''}(${owner.qq_id})`,
    ''.padEnd(60, '-'),
    file.content_text,
    '',
  ].join('\n');
}

// ---- PDF 版式（blocks 交给 renderPdf 渲染）----

function snippetBlocks(snippet, messages, owner) {
  const blocks = [
    { kind: 'title', text: `口嗨片段 #${snippet.id}` },
    { kind: 'meta', text: `记录时间：${fmtTime(snippet.created_at)}` },
    { kind: 'meta', text: `归属：${owner.display_name || ''}（${owner.qq_id}）` },
    { kind: 'meta', text: `共 ${messages.length} 条消息` },
    { kind: 'rule' },
  ];
  for (const m of messages) {
    blocks.push({ kind: 'speaker', text: `${m.name}（${m.qq_id}） · ${fmtTime(m.ts)}` });
    blocks.push({ kind: 'para', text: m.content });
  }
  if (snippet.summary) {
    blocks.push({ kind: 'rule' });
    blocks.push({ kind: 'label', text: '大模型总结' });
    blocks.push({ kind: 'quote', text: snippet.summary });
  }
  return blocks;
}

function fileBlocks(file, owner) {
  return [
    { kind: 'title', text: `上传资料 #${file.id}` },
    { kind: 'meta', text: `文件名：${file.filename}` },
    { kind: 'meta', text: `上传时间：${fmtTime(file.uploaded_at)}` },
    { kind: 'meta', text: `归属：${owner.display_name || ''}（${owner.qq_id}）` },
    { kind: 'rule' },
    { kind: 'para', text: file.content_text },
  ];
}

// 返回 { files:[路径], zipPath, zipName, count, note, scopeNote, format } 或 { error }
async function buildExport({ config, repo, userId, format, scope }) {
  const owner = repo.getUser(userId) || { qq_id: userId, display_name: '' };
  let snippets = repo.listSnippets(userId);
  let files = repo.listFiles(userId);
  let scopeNote = '全部';

  // 范围语法：
  //   all            全部（默认）
  //   recent N       最近 N 篇（N 省略时 5）
  //   N              最近 N 篇口嗨（向后兼容旧行为）
  //   #12            编号 12 的片段或资料（先匹配片段，再匹配资料）
  //   snippet:12 / 片段12   指定片段
  //   file:12 / 资料12      指定资料
  const scopeStr = String(scope || 'all').trim();
  const idOnly = /^#\s*(\d+)$/.exec(scopeStr);
  const snipRef = /^(?:snippet|片段)[:：]?\s*(\d+)$/i.exec(scopeStr);
  const fileRef = /^(?:file|资料)[:：]?\s*(\d+)$/i.exec(scopeStr);

  if (idOnly) {
    const id = parseInt(idOnly[1], 10);
    // 片段与资料各有独立的自增 ID，#N 因此有歧义 —— 约定优先片段，找不到再退到资料。
    // 想明确指定用 片段N / 资料N。
    const s = snippets.filter((x) => x.id === id);
    const f = files.filter((x) => x.id === id);
    if (!s.length && !f.length) return { error: `没有找到编号 #${id} 的口嗨或资料` };
    snippets = s;
    files = s.length ? [] : f;
    scopeNote = s.length ? `仅口嗨片段 #${id}` : `仅资料 #${id}`;
  } else if (snipRef) {
    const id = parseInt(snipRef[1], 10);
    snippets = snippets.filter((x) => x.id === id);
    files = [];
    if (!snippets.length) return { error: `没有找到编号 #${id} 的口嗨片段` };
    scopeNote = `仅口嗨片段 #${id}`;
  } else if (fileRef) {
    const id = parseInt(fileRef[1], 10);
    files = files.filter((x) => x.id === id);
    snippets = [];
    if (!files.length) return { error: `没有找到编号 #${id} 的资料` };
    scopeNote = `仅资料 #${id}`;
  } else {
    const recent = /^recent\s*(\d+)?$/i.exec(scopeStr);
    if (recent) {
      const n = parseInt(recent[1] || '5', 10);
      snippets = snippets.slice(0, n);
      files = files.slice(0, n);
      scopeNote = `最近 ${n} 篇`;
    } else if (scopeStr && scopeStr !== 'all') {
      const n = parseInt(scopeStr, 10);
      if (!Number.isNaN(n)) {
        snippets = snippets.slice(0, n);
        scopeNote = `最近 ${n} 篇口嗨`;
      }
    }
  }

  let note = '';
  let want = format === 'md' ? 'md' : format === 'pdf' ? 'pdf' : 'txt';
  if (want === 'pdf' && !config.fontPath) {
    want = 'txt';
    note = '（未找到可用的中文字体，PDF 导出已回退为 txt；可在 .env 设置 FONT_PATH 指定字体）';
  }
  const ext = want === 'md' ? 'md' : want === 'pdf' ? 'pdf' : 'txt';

  const items = [];
  for (const s of snippets) {
    const messages = repo.getMessages(s.session_id);
    const stamp = fmtTime(s.created_at).replace(/[^\d]/g, '');
    let content;
    if (want === 'pdf') {
      content = renderPdf({ fontPath: config.fontPath, blocks: snippetBlocks(s, messages, owner), title: `口嗨片段 #${s.id}` });
    } else if (want === 'md') {
      content = buildSnippetMd(s, messages, owner);
    } else {
      content = buildSnippetText(s, messages, owner);
    }
    items.push({ name: sanitizeFilename(`片段${s.id}_${stamp}.${ext}`), content });
  }
  for (const f of files) {
    let content;
    if (want === 'pdf') {
      content = renderPdf({ fontPath: config.fontPath, blocks: fileBlocks(f, owner), title: `上传资料 #${f.id}` });
    } else if (want === 'md') {
      content = `## 资料 #${f.id}：${f.filename}\n\n${f.content_text}\n`;
    } else {
      content = buildFileText(f, owner);
    }
    items.push({
      name: sanitizeFilename(`资料${f.id}_${String(f.filename).replace(/\.[^.]+$/, '')}.${ext}`, f.content_text),
      content,
    });
  }

  fs.mkdirSync(config.exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  const written = [];
  for (const it of items) {
    const p = path.join(config.exportsDir, it.name);
    if (Buffer.isBuffer(it.content)) fs.writeFileSync(p, it.content);
    else fs.writeFileSync(p, it.content, 'utf8');
    written.push(p);
  }

  let zipPath = null;
  let zipName = null;
  if (written.length > 1 || format === 'zip') {
    zipName = sanitizeFilename(`肥肥风筝猫_导出_${stamp}.zip`);
    zipPath = path.join(config.exportsDir, zipName);
    const entries = items.map((it, i) => ({ name: it.name, data: fs.readFileSync(written[i]) }));
    fs.writeFileSync(zipPath, createZip(entries));
  }

  return { files: written, zipPath, zipName, count: written.length, note, scopeNote, format: want };
}

module.exports = { buildExport };
