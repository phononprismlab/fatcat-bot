'use strict';
const logger = require('../logger');

// OneBot 11 客户端（反向 WS：本程序主动连 NapCat）
// 用 Node 内置全局 WebSocket，无需 ws 依赖
class OneBotClient {
  constructor({ url, accessToken, echoTimeoutMs, onEvent }) {
    this.url = url;
    this.token = accessToken || '';
    this.echoTimeoutMs = echoTimeoutMs || 15000;
    this.onEvent = onEvent;
    this.ws = null;
    this.pending = new Map();
    this.echoSeq = 0;
    this.closed = false;
    this.retry = 0;
    // 运维观测用：连接时刻、最后一次收到事件的时刻、累计重连次数
    this.connectedAt = 0;
    this.lastEventAt = 0;
    this.reconnects = 0;
  }

  // 管理台 / 健康检查用：一眼看出「连着没、多久没消息了」
  stats() {
    const ws = this.ws;
    const connected = !!(ws && ws.readyState === 1);
    const now = Date.now();
    return {
      connected,
      url: String(this.url).replace(/access_token=[^&]*/, 'access_token=***'),
      retry: this.retry,
      reconnects: this.reconnects,
      connectedAt: this.connectedAt || null,
      connectedMs: connected && this.connectedAt ? now - this.connectedAt : 0,
      lastEventAt: this.lastEventAt || null,
      silentMs: this.lastEventAt ? now - this.lastEventAt : null,
      pendingCalls: this.pending.size,
      hasToken: !!this.token,
    };
  }

  start() {
    this._connect();
  }

  stop() {
    this.closed = true;
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
  }

  // 管理台用：立刻断开重连（不等退避计时）
  reconnect() {
    this.closed = false;
    this.retry = 0;
    const old = this.ws;
    this.ws = null;
    if (old) {
      // 摘掉回调，避免触发 _scheduleReconnect 造成双连接
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      try { old.close(); } catch (e) { /* ignore */ }
    }
    this._connect();
  }

  _buildUrl() {
    if (!this.token) return this.url;
    const u = new URL(this.url);
    u.searchParams.set('access_token', this.token);
    return u.toString();
  }

  _connect() {
    if (this.closed) return;
    const url = this._buildUrl();
    logger.info('连接 OneBot:', url.replace(/access_token=[^&]*/, 'access_token=***'));
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.connectedAt) this.reconnects += 1;
      this.connectedAt = Date.now();
      this.retry = 0;
      logger.info('OneBot 已连接');
    };
    ws.onmessage = (ev) => {
      this.lastEventAt = Date.now();
      this._onMessage(ev.data);
    };
    ws.onclose = () => {
      this.connectedAt = 0;
      logger.warn('OneBot 连接关闭');
      this._scheduleReconnect();
    };
    ws.onerror = (e) => {
      logger.warn('OneBot 连接错误:', (e && e.message) || '');
    };
  }

  _scheduleReconnect() {
    if (this.closed) return;
    this.retry += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retry, 5));
    logger.info(`${delay}ms 后重连（第 ${this.retry} 次）`);
    setTimeout(() => this._connect(), delay);
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch (e) {
      logger.warn('无法解析 OneBot 消息:', e.message);
      return;
    }
    // 有 echo 的是我们发出的动作的响应
    if (msg && msg.echo && this.pending.has(msg.echo)) {
      const { resolve, timer } = this.pending.get(msg.echo);
      clearTimeout(timer);
      this.pending.delete(msg.echo);
      resolve(msg);
      return;
    }
    // 其余是事件
    try {
      if (this.onEvent) this.onEvent(msg);
    } catch (e) {
      logger.error('处理事件出错:', e.stack || e.message);
    }
  }

  call(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('OneBot 未连接'));
        return;
      }
      const echo = `e${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`动作超时: ${action}`));
      }, this.echoTimeoutMs);
      this.pending.set(echo, { resolve, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }
  sendPrivateMsg(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }
  // NapCat 支持的 OneBot 扩展：上传私聊文件
  uploadPrivateFile(userId, file, name) {
    return this.call('upload_private_file', { user_id: Number(userId), file, name });
  }
  // 获取文件（NapCat 返回本地路径或 url）
  getFile(fileId) {
    return this.call('get_file', { file_id: fileId, file: fileId });
  }
  // 探活：账号若被风控 / 挤下线，WS 可能还连着但这个动作会失败或返回空
  getLoginInfo() {
    return this.call('get_login_info', {});
  }
}

module.exports = { OneBotClient };
