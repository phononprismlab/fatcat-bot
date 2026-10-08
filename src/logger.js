'use strict';

// 极简日志：输出到控制台，同时在内存里保留最近 N 条供管理台查看。
// 只放内存、不落盘 —— 运维看最近发生了什么足够，也不会把聊天内容写到磁盘上。

const MAX_BUFFER = 500;
const buffer = [];

function ts() {
  return new Date().toISOString();
}

function stringify(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }
  return String(v);
}

function record(level, args) {
  let msg;
  try {
    msg = args.map(stringify).join(' ');
  } catch (e) {
    msg = '(无法序列化的日志参数)';
  }
  buffer.push({ ts: Date.now(), level, msg });
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  return msg;
}

const logger = {
  info: (...a) => {
    record('info', a);
    console.log(`[${ts()}] [INFO ]`, ...a);
  },
  warn: (...a) => {
    record('warn', a);
    console.warn(`[${ts()}] [WARN ]`, ...a);
  },
  error: (...a) => {
    record('error', a);
    console.error(`[${ts()}] [ERROR]`, ...a);
  },
  debug: (...a) => {
    record('debug', a);
    if (process.env.DEBUG) console.log(`[${ts()}] [DEBUG]`, ...a);
  },
  // 管理台用：取最近日志（倒序，最新在前）
  recent(limit = 200) {
    const n = Math.max(1, Math.min(MAX_BUFFER, Number(limit) || 200));
    return buffer.slice(-n).reverse();
  },
  clear() {
    buffer.length = 0;
  },
};

module.exports = logger;
