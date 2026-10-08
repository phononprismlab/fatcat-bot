'use strict';

// OneBot 11 消息段工具
function text(t) {
  return { type: 'text', data: { text: String(t) } };
}
function at(qq) {
  return { type: 'at', data: { qq: String(qq) } };
}

// 从 message（数组段或字符串）中提取纯文本
function extractText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .map((seg) => (seg && seg.type === 'text' ? (seg.data && seg.data.text) || '' : ''))
    .join('');
}

// 找出指定类型的消息段
function findSegments(message, type) {
  if (!Array.isArray(message)) return [];
  return message.filter((s) => s && s.type === type);
}

module.exports = { text, at, extractText, findSegments };
