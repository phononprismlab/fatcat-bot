'use strict';

// 调大模型生成口嗨总结。三项配置任一为空则直接返回 null（不消耗 token）。
async function generateSummary(config, transcript) {
  const { baseUrl, apiKey, model } = config.llm;
  if (!baseUrl || !apiKey || !model) return null;
  if (!transcript || !transcript.trim()) return null;

  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是一个忠实的记录助手。请只根据用户提供的对话内容做简洁摘要，' +
          '概括其中出现的角色、设定与脑洞要点；不得编造原文没有的信息。用中文输出，控制在 200 字内。',
      },
      { role: 'user', content: '以下是本次口嗨的对话记录：\n\n' + transcript },
    ],
    temperature: 0.3,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`LLM ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return (content || '').trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateSummary };
