'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createZip } = require('../utils/zip');
const { sanitizeFilename } = require('../utils/filenames');
const { fmtTime } = require('../utils/time');

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

// 返回 { files:[路径], zipPath, zipName, count, note }
async function buildExport({ config, repo, userId, format, scope }) {
  const owner = repo.getUser(userId) || { qq_id: userId, display_name: '' };
  let snippets = repo.listSnippets(userId);
  let files = repo.listFiles(userId);

  const recent = /^recent\s*(\d+)?$/i.exec(scope || '');
  if (recent) {
    const n = parseInt(recent[1] || '5', 10);
    snippets = snippets.slice(0, n);
    files = files.slice(0, n);
  } else if (scope && scope !== 'all') {
    const n = parseInt(scope, 10);
    if (!Number.isNaN(n)) snippets = snippets.slice(0, n);
  }

  // PDF：骨架未内置中文字体，回退为 txt
  let note = '';
  const useMd = format === 'md';
  if (format === 'pdf') note = '（PDF 需嵌入中文字体，当前版本回退为 txt）';
  const ext = useMd ? 'md' : 'txt';

  const items = [];
  for (const s of snippets) {
    const messages = repo.getMessages(s.session_id);
    const content = useMd ? buildSnippetMd(s, messages, owner) : buildSnippetText(s, messages, owner);
    items.push({ name: sanitizeFilename(`片段${s.id}_${fmtTime(s.created_at).replace(/[^\d]/g, '')}.${ext}`), content });
  }
  for (const f of files) {
    const content = useMd
      ? `## 资料 #${f.id}：${f.filename}\n\n${f.content_text}\n`
      : buildFileText(f, owner);
    items.push({ name: sanitizeFilename(`资料${f.id}_${String(f.filename).replace(/\.[^.]+$/, '')}.${ext}`), content });
  }

  fs.mkdirSync(config.exportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  const written = [];
  for (const it of items) {
    const p = path.join(config.exportsDir, it.name);
    fs.writeFileSync(p, it.content, 'utf8');
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

  return { files: written, zipPath, zipName, count: written.length, note };
}

module.exports = { buildExport };
