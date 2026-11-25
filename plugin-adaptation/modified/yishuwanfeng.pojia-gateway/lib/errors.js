'use strict';

/**
 * 统一错误分类与响应修复。
 *
 * 各供应商抛出的错误形状不一，这里把它们收敛成 gateway 能理解的类别，
 * 并决定是否应该换账号重试——换错了会让本来正常的账号被误标冷却。
 */

/** 错误类别 → HTTP 状态码与是否可重试。 */
const KINDS = {
  token_rejected: { status: 401, retry: false, rotate: true },
  session_dead: { status: 401, retry: false, rotate: true },
  account_restricted: { status: 403, retry: false, rotate: true },
  quota: { status: 429, retry: true, rotate: true },
  rate_limit: { status: 429, retry: true, rotate: true },
  model_busy: { status: 503, retry: true, rotate: false },
  model_not_found: { status: 404, retry: false, rotate: false },
  content_blocked: { status: 400, retry: false, rotate: false },
  client: { status: 400, retry: false, rotate: false },
  upstream: { status: 502, retry: true, rotate: false },
};

/**
 * 从上游响应猜错误类别。
 *
 * 先看结构化错误码，再看文案关键词，最后按 HTTP 状态码兜底。
 * 顺序不能颠倒：「今日已签到」这类业务成功在上游常用 HTTP 400 返回，
 * 先看状态码会误判成失败。
 */
function classify(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  const lower = text.toLowerCase();

  // 明确的凭证失效信号
  if (
    /need_login|login_invalid|not_logged_in|token_expired|token_invalid|invalid_token|unauthorized|登录已过期|请重新登录/.test(
      lower,
    )
  ) {
    return { kind: 'token_rejected', status: 401, retry: false, rotate: true, message: text.slice(0, 200) };
  }

  // 额度用尽 / 限流
  if (/quota|limit_exceeded|insufficient|余额不足|额度不足|超出限制/.test(lower)) {
    return { kind: 'quota', status: 429, retry: true, rotate: true, message: text.slice(0, 200) };
  }
  if (/rate.?limit|too many|请求过于频繁/.test(lower)) {
    return { kind: 'rate_limit', status: 429, retry: true, rotate: true, message: text.slice(0, 200) };
  }

  // 内容审核
  if (/content.?blocked|sensitive|违规|审核不通过/.test(lower)) {
    return { kind: 'content_blocked', status: 400, retry: false, rotate: false, message: text.slice(0, 200) };
  }

  // 模型不存在
  if (/model_not_found|no such model|模型不存在|不支持该模型/.test(lower)) {
    return { kind: 'model_not_found', status: 404, retry: false, rotate: false, message: text.slice(0, 200) };
  }

  // 按状态码兜底
  if (status === 401) return { kind: 'token_rejected', status: 401, retry: false, rotate: true, message: text.slice(0, 200) };
  if (status === 403) return { kind: 'account_restricted', status: 403, retry: false, rotate: true, message: text.slice(0, 200) };
  if (status === 404) return { kind: 'model_not_found', status: 404, retry: false, rotate: false, message: text.slice(0, 200) };
  if (status === 429) return { kind: 'rate_limit', status: 429, retry: true, rotate: true, message: text.slice(0, 200) };
  if (status >= 500) return { kind: 'upstream', status: 502, retry: true, rotate: false, message: text.slice(0, 200) };

  return { kind: 'upstream', status: status >= 400 ? status : 502, retry: false, rotate: false, message: text.slice(0, 200) };
}

/** 判断错误是否属于「凭证失效」（该换账号）。 */
function isAuthFailure(status, body) {
  const c = classify(status, body);
  return c.rotate === true && (c.kind === 'token_rejected' || c.kind === 'session_dead');
}

/**
 * 把一段非流式 JSON 响应拆成 SSE 行。
 *
 * 有些上游（如秒悟的一次性响应）不提供流式接口，
 * 但客户端可能要求 stream:true，这里在本地补出 SSE 形状。
 */
function jsonToSseLines(text, model) {
  const lines = [];
  const push = (payload) => lines.push('data: ' + JSON.stringify(payload));

  push({
    id: 'chatcmpl-' + Date.now().toString(36),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  });
  push({
    id: 'chatcmpl-' + Date.now().toString(36),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  lines.push('data: [DONE]');
  return lines;
}

module.exports = { KINDS, classify, isAuthFailure, jsonToSseLines };
