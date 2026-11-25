'use strict';

/**
 * HTTP 客户端。
 *
 * 全部基于 node 的 http/https，不引第三方库——插件包里不能带 node_modules，
 * 而宿主也不会替我们装依赖。
 *
 * 关键点：
 * - 自动 gzip/deflate/br 解压（上游模型目录常带图标，未解压时能到几百 KB）
 * - 支持读取流式响应（SSE），供 chat 转发用
 * - 超时用 signal 之外的双保险：socket 超时 + 总时长定时器
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 60000;

/**
 * 发一个请求，拿到完整响应体。
 *
 * @param {object} opts
 *   method, url, headers, body (string|Buffer), timeout, signal
 * @returns {Promise<{status:number, headers:object, text:string, raw:Buffer}>}
 */
function request(opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(o.url);
    } catch (e) {
      reject(new Error(`URL 非法：${o.url}`));
      return;
    }

    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = Object.assign({}, o.headers || {});
    // 上游普遍按 Accept-Encoding 决定是否压缩；不声明也能拿到明文，
    // 但带图标的目录接口能省不少流量，所以主动要 gzip。
    if (!headers['Accept-Encoding']) {
      headers['Accept-Encoding'] = 'gzip, deflate';
    }

    let bodyBuf = null;
    if (o.body !== undefined && o.body !== null) {
      bodyBuf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8');
      if (!headers['Content-Length']) headers['Content-Length'] = bodyBuf.length;
    }

    const timeout = o.timeout || DEFAULT_TIMEOUT;
    const req = lib.request(
      {
        method: o.method || (bodyBuf ? 'POST' : 'GET'),
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        headers,
      },
      (res) => {
        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > 32 * 1024 * 1024) {
            req.destroy(new Error('响应体超过 32MB，已中止'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timer);
          let raw = Buffer.concat(chunks);
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (encoding === 'gzip') raw = zlib.gunzipSync(raw);
            else if (encoding === 'deflate') raw = zlib.inflateSync(raw);
            else if (encoding === 'br') raw = zlib.brotliDecompressSync(raw);
          } catch (e) {
            // 解压失败就用原始字节，至少能暴露上游的真实错误
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            raw,
            text: raw.toString('utf8'),
          });
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy(new Error(`请求超时（${timeout}ms）`));
    }, timeout);

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (o.signal && typeof o.signal.addEventListener === 'function') {
      o.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        req.destroy(new Error('已取消'));
      });
    }

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** GET 便捷方法。 */
function get(url, headers, timeout) {
  return request({ method: 'GET', url, headers, timeout });
}

/** POST JSON 便捷方法。 */
function postJson(url, payload, headers, timeout) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const merged = Object.assign(
    { 'Content-Type': 'application/json', Accept: 'application/json' },
    headers || {},
  );
  return request({ method: 'POST', url, headers: merged, body, timeout });
}

/**
 * 打开流式响应，把上游 SSE 逐块交给回调。
 *
 * 与 request 的区别：不缓冲，收到 data 就回调，用于把上游 SSE 直接转给客户端。
 *
 * 返回的 `done` 在流结束时 resolve——调用方要聚合成完整响应时必须等它，
 * 否则会在还没收到任何数据时就去读结果（实测会误判成「上游返回空内容」）。
 *
 * @param {object} opts  method/url/headers/body/timeout
 * @param {(chunk: Buffer) => void} onData
 * @returns {Promise<{status:number, headers:object, done:Promise<void>}>}
 */
function stream(opts, onData) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(o.url);
    } catch (e) {
      reject(new Error(`URL 非法：${o.url}`));
      return;
    }

    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = Object.assign({}, o.headers || {});
    headers['Accept-Encoding'] = 'identity';

    let bodyBuf = null;
    if (o.body !== undefined && o.body !== null) {
      bodyBuf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8');
      if (!headers['Content-Length']) headers['Content-Length'] = bodyBuf.length;
    }

    const timeout = o.timeout || 300000;

    // 流结束的信号：拿不到响应头前失败也要能 resolve，避免调用方永久挂起
    let finishDone;
    const done = new Promise((r) => (finishDone = r));

    const req = lib.request(
      {
        method: o.method || 'POST',
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        headers,
      },
      (res) => {
        resolve({ status: res.statusCode || 0, headers: res.headers, done });
        res.on('data', (chunk) => {
          try {
            onData(chunk);
          } catch (e) {
            req.destroy(e);
          }
        });
        res.on('end', () => finishDone());
        res.on('error', () => finishDone());
      },
    );

    const timer = setTimeout(() => req.destroy(new Error(`流式请求超时（${timeout}ms）`)), timeout);

    req.on('error', (err) => {
      clearTimeout(timer);
      finishDone();
      reject(err);
    });
    req.on('close', () => {
      clearTimeout(timer);
      finishDone();
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

module.exports = { request, get, postJson, stream };
