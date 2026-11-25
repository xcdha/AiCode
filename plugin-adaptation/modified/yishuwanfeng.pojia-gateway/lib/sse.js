'use strict';

/**
 * SSE 工具：逐行解析、翻译、聚合。
 *
 * 各家的流式帧形状不同：
 *   OpenAI 原生   : data: {"choices":[{"delta":{"content":"x"}}]}
 *   小浣熊/智谱系  : data: {"status":{"code":0},"data":{"choices":[...]}}
 *   讯飞星辰      : data: {"choices":[{"delta":{"reasoning_content":"x"}}]}
 *
 * 这里把它们统一成 OpenAI 形状再吐给客户端。
 */

let seq = 0;

function newId(prefix) {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix || 'chatcmpl'}-${Date.now().toString(36)}${seq.toString(36)}${rand}`;
}

/**
 * 按 SSE 规范切分数据块。
 *
 * 返回完整的行（以 \n 结尾）；残行留在 buffer 里等下一次。
 */
function createLineSplitter(onLine) {
  let buffer = '';
  return function feed(chunk) {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  };
}

/** 解析 `data: xxx` 行，返回 payload 字符串；非 data 行返回 null。 */
function dataPayload(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;
  return trimmed.slice(5).trim();
}

/**
 * 创建翻译器：把上游帧统一成 OpenAI chunk。
 *
 * @param {object} opts
 *   model   最终回给客户端的模型名
 *   unwrap  是否剥掉 `{status, data}` 外层
 *   id      帧 id（不给就自动生成）
 */
function createTranslator(opts) {
  const o = opts || {};
  const model = o.model || 'unknown';
  const unwrap = o.unwrap !== false;
  let id = o.id || newId();
  let created = Math.floor(Date.now() / 1000);
  let finished = false;
  let roleEmitted = false;

  /** 把一行翻译成若干待发帧（不含 `data: ` 前缀）。 */
  function translate(line) {
    const payload = dataPayload(line);
    if (payload === null) return [];
    if (payload === '[DONE]') {
      finished = true;
      return ['[DONE]'];
    }
    const obj = safeJson(payload);
    if (!obj) return [];

    // 错误帧：上游把错误包在 status 里
    const status = obj.status;
    if (status && typeof status === 'object') {
      const code = Number(status.code || 0);
      if (code !== 0) {
        finished = true;
        return [JSON.stringify(errorFrame(code, status.message || `上游流内错误 code=${code}`)), '[DONE]'];
      }
    }

    let data = obj;
    if (unwrap && obj.data && typeof obj.data === 'object') {
      data = obj.data;
      if (obj.data.id) id = String(obj.data.id);
    }
    if (data.id) id = String(data.id);
    if (data.created) created = Number(data.created) || created;

    const choices = Array.isArray(data.choices) ? data.choices : null;
    if (!choices) return [];

    const frames = [];
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const index = Number(choice.index || 0);

      // delta 可能是对象，也可能直接是字符串（小浣熊 web 通道）
      let delta = choice.delta;
      if (typeof delta === 'string') {
        delta = { content: delta };
      } else if (!delta || typeof delta !== 'object') {
        delta = {};
      }

      const outDelta = {};
      if (!roleEmitted) {
        outDelta.role = 'assistant';
        roleEmitted = true;
      }
      if (delta.content !== undefined && delta.content !== null) {
        outDelta.content = delta.content;
      }
      if (delta.reasoning_content !== undefined) {
        outDelta.reasoning_content = delta.reasoning_content;
      }
      if (delta.tool_calls) outDelta.tool_calls = delta.tool_calls;

      const frame = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index,
            delta: outDelta,
            finish_reason: choice.finish_reason === undefined ? null : choice.finish_reason,
          },
        ],
      };
      frames.push(JSON.stringify(frame));
      if (choice.finish_reason) finished = true;
    }
    return frames;
  }

  return {
    translate,
    isFinished: () => finished,
    id: () => id,
  };
}

function errorFrame(code, message) {
  return JSON.stringify({
    error: {
      message: String(message || '上游错误'),
      type: 'upstream_error',
      code,
    },
  });
}

/**
 * 把翻译后的帧聚合成一个完整 completion。
 *
 * 客户端要非流式（stream:false）时用：上游只给流，本地拼成一段 JSON。
 */
function createAggregator(model) {
  const id = newId();
  const created = Math.floor(Date.now() / 1000);
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  const toolCalls = [];

  function push(frames) {
    for (const raw of frames) {
      if (raw === '[DONE]') continue;
      const obj = safeJson(raw);
      if (!obj || !Array.isArray(obj.choices)) continue;
      for (const choice of obj.choices) {
        const delta = choice.delta || {};
        if (typeof delta.content === 'string') content += delta.content;
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number(tc.index || 0);
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || newId('call'),
                type: 'function',
                function: { name: '', arguments: '' },
              };
            }
            const slot = toolCalls[idx];
            if (tc.id) slot.id = tc.id;
            if (tc.function) {
              if (tc.function.name) slot.function.name += tc.function.name;
              if (tc.function.arguments) slot.function.arguments += tc.function.arguments;
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  function result() {
    const message = { role: 'assistant', content };
    if (reasoning) message.reasoning_content = reasoning;
    const filled = toolCalls.filter(Boolean);
    if (filled.length > 0) message.tool_calls = filled;

    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: filled.length > 0 ? 'tool_calls' : finishReason,
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  return { push, result, isEmpty: () => !content && !reasoning && toolCalls.filter(Boolean).length === 0 };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

module.exports = {
  newId,
  createLineSplitter,
  dataPayload,
  createTranslator,
  createAggregator,
  errorFrame,
  safeJson,
};
