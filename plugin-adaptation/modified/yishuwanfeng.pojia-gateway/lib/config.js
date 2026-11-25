'use strict';

/**
 * 插件配置持久化。
 *
 * 存到 data://config.json —— 宿主提供的插件私有目录，卸载时自动清除。
 * 与账号文件分开放：账号是敏感数据，配置是用户偏好，混在一起不好单独重置。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 7864,
  apiKeys: [],
  autoStart: true,
  stripClientTrace: false,
};

let cachedDir = null;

function dataDir() {
  if (cachedDir) return cachedDir;
  const candidates = [process.env.AICODE_DATA_DIR].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      cachedDir = dir;
      return dir;
    } catch (e) {
      // 下一个候选
    }
  }
  throw new Error('Guru 插件数据目录不可用');
}

function configFile() {
  return path.join(dataDir(), 'config.json');
}

function read() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    if (!raw.trim()) return Object.assign({}, DEFAULTS);
    const obj = JSON.parse(raw);
    return Object.assign({}, DEFAULTS, obj && typeof obj === 'object' ? obj : {});
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function write(cfg) {
  const file = configFile();
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { DEFAULTS, read, write, configFile };
