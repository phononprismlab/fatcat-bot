'use strict';
const logger = require('./logger');

// 掉线监控。
//
// 为什么需要它：OneBot 的 WS 连接和「QQ 账号本身是否在线」是两件事。
// 账号被风控 / 被别处登录挤下线时，WS 往往还连着，机器人却已经收不到任何消息，
// 而且它自己也没法用 QQ 通知你（账号都掉线了）。所以告警必须走**带外通道**（webhook）。
//
// 外部探活（Uptime Kuma / 云监控打 /healthz）只能发现「进程挂了」，
// 发现不了「进程活着但账号掉线」—— 这一层正是本模块补的。

// 国内常见的几种群机器人 webhook 报文格式不一样，按域名自动识别。
function detectKind(url) {
  if (/qyapi\.weixin\.qq\.com/.test(url)) return 'wecom';
  if (/oapi\.dingtalk\.com/.test(url)) return 'dingtalk';
  if (/open\.feishu\.cn|open\.larksuite\.com/.test(url)) return 'feishu';
  if (/sctapi\.ftqq\.com|push\.ftqq\.com/.test(url)) return 'serverchan';
  return 'generic';
}

// 纯函数，便于单测：给定出口类型与文案，产出该出口要的 JSON。
function buildAlertPayload(kind, title, text) {
  const merged = title + '\n' + text;
  switch (kind) {
    case 'wecom':
      return { msgtype: 'text', text: { content: merged } };
    case 'dingtalk':
      return { msgtype: 'text', text: { content: merged } };
    case 'feishu':
      return { msg_type: 'text', content: { text: merged } };
    case 'serverchan':
      return { title, desp: text };
    default:
      return { title, text, level: 'error', ts: Date.now() };
  }
}

// 发一条告警。没有任何出口配置时返回 skipped，不抛错 —— 监控不该把主进程搞崩。
async function sendAlert(config, { title, text }) {
  const url = config.monitor.webhookUrl;
  if (!url) return { ok: false, skipped: true, reason: '未配置 ALERT_WEBHOOK_URL' };
  const kind = detectKind(url);
  const body = buildAlertPayload(kind, title, text);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, kind, status: resp.status, reason: t.slice(0, 200) };
    }
    return { ok: true, kind, status: resp.status };
  } catch (e) {
    return { ok: false, kind, reason: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function createMonitor({ config, client }) {
  const state = {
    enabled: config.monitor.enabled,
    webhookConfigured: !!config.monitor.webhookUrl,
    checks: 0,
    alertsSent: 0,
    consecutiveFailures: 0,
    lastCheckAt: null,
    lastOkAt: null,
    lastAlertAt: null,
    healthy: null,
    lastReason: '',
    startedAt: null,
  };

  let timer = null;

  async function checkOnce() {
    state.checks += 1;
    state.lastCheckAt = Date.now();

    let healthy = true;
    let reason = '';

    if (!client) {
      reason = '仅管理台模式，不检查 OneBot';
    } else if (!client.stats().connected) {
      healthy = false;
      reason = 'OneBot WebSocket 未连接';
    } else {
      try {
        const resp = await client.getLoginInfo();
        const uid = resp && resp.data && resp.data.user_id;
        if (resp && resp.status === 'ok' && uid) {
          reason = '账号在线（' + uid + '）';
        } else {
          healthy = false;
          reason = 'get_login_info 异常：' + JSON.stringify(resp).slice(0, 160);
        }
      } catch (e) {
        healthy = false;
        reason = '探活请求失败：' + e.message;
      }
    }

    state.lastReason = reason;
    const prev = state.healthy;
    state.healthy = healthy;

    if (healthy) {
      state.consecutiveFailures = 0;
      state.lastOkAt = Date.now();
      if (prev === false) {
        // 恢复通知 —— 故障期间你可能已经收到了告警，得给个「好了」的收尾
        const r = await sendAlert(config, {
          title: '【肥肥风筝猫】已恢复',
          text: 'OneBot 连接恢复正常。\n' + reason + '\n时间：' + new Date().toLocaleString('zh-CN'),
        });
        if (r.ok) state.alertsSent += 1;
        logger.info('监控：连接已恢复' + (r.ok ? '，已发出恢复通知' : r.skipped ? '' : '，恢复通知发送失败：' + r.reason));
      }
      return state;
    }

    state.consecutiveFailures += 1;

    // 冷却：持续故障时不刷屏，每 cooldownMs 最多再提醒一次
    const now = Date.now();
    const cooling = state.lastAlertAt && now - state.lastAlertAt < config.monitor.cooldownMs;
    if (cooling) return state;

    state.lastAlertAt = now;
    const r = await sendAlert(config, {
      title: '【肥肥风筝猫】掉线告警',
      text:
        reason + '\n' +
        '连续失败 ' + state.consecutiveFailures + ' 次\n' +
        '时间：' + new Date().toLocaleString('zh-CN') + '\n' +
        '排查：登录服务器执行 journalctl -u fatcat-bot -n 100 --no-pager',
    });
    if (r.ok) {
      state.alertsSent += 1;
      logger.warn('监控：已发出掉线告警 —— ' + reason);
    } else if (r.skipped) {
      logger.warn('监控：检测到异常但未配置 ALERT_WEBHOOK_URL，无法通知 —— ' + reason);
    } else {
      logger.warn('监控：告警发送失败（' + r.reason + '）—— 原始问题：' + reason);
    }
    return state;
  }

  function start() {
    if (!state.enabled) {
      logger.info('掉线监控：已关闭（MONITOR=0）');
      return { run: checkOnce, stop: () => {}, status: () => state };
    }
    state.startedAt = Date.now();
    // 首次延迟一小会儿，等 OneBot 首次连接有结果，避免刚启动就误报
    const firstDelay = Math.min(20000, config.monitor.intervalMs);
    const kick = setTimeout(() => {
      checkOnce().catch((e) => logger.warn('监控异常: ' + e.message));
    }, firstDelay);
    if (kick.unref) kick.unref();

    timer = setInterval(() => {
      checkOnce().catch((e) => logger.warn('监控异常: ' + e.message));
    }, config.monitor.intervalMs);
    if (timer.unref) timer.unref();

    logger.info(
      '掉线监控：每 ' + describeInterval(config.monitor.intervalMs) + '探活一次' +
      (state.webhookConfigured ? '，告警出口已配置' : '，未配置 ALERT_WEBHOOK_URL（只会写日志）')
    );
    return { run: checkOnce, stop, status: () => state };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, run: checkOnce, status: () => state, state };
}

// 30 秒这种不足一分钟的间隔，按分钟取整会显示成「每 1 分钟」，容易误导
function describeInterval(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + ' 秒';
  if (sec % 60 === 0) return sec / 60 + ' 分钟';
  return (sec / 60).toFixed(1) + ' 分钟';
}

module.exports = { createMonitor, sendAlert, detectKind, buildAlertPayload };
