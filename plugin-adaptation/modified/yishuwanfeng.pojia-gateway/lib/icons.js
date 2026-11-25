'use strict';

/**
 * 供应商图标：与 App 版 supplierIcon() 完全一致的几何定义。
 *
 * App 里用 Android Canvas 绘制，这里改成 SVG。尺寸统一按 36×36 视口，
 * 所有坐标直接沿用 Kotlin 版的比例（pad = 36 * 0.24 = 8.64），
 * 这样两边看起来是同一套图形。
 *
 * 字色（fg）在深色背景上要可读，所以每家单独指定，不用统一白色。
 */

const SIZE = 36;
const PAD = SIZE * 0.24;

/** 14 家的配色（与 MainActivity.supplierIcon 的 when 分支逐行对齐）。 */
const PALETTE = {
  codebuddy: { bg: '#5B8DEF', fg: '#FFFFFF' },
  trae: { bg: '#00C9A7', fg: '#00332B' },
  raccoon: { bg: '#FF6B6B', fg: '#7F1A1A' },
  loomy: { bg: '#9B59B6', fg: '#E8D5F5' },
  catpaw: { bg: '#F5A623', fg: '#4A2600' },
  deepseek: { bg: '#4D6BFE', fg: '#FFFFFF' },
  zhipu: { bg: '#3D5AFE', fg: '#FFFFFF' },
  agentmore: { bg: '#6B4EFF', fg: '#FFFFFF' },
  dangbei: { bg: '#00A0E9', fg: '#FFFFFF' },
  meoo: { bg: '#5B4BE0', fg: '#FFFFFF' },
  tabbit: { bg: '#14B8A6', fg: '#FFFFFF' },
  wenxin: { bg: '#2932E1', fg: '#FFFFFF' },
  qoder: { bg: '#6E56CF', fg: '#FFFFFF' },
  astudio: { bg: '#0B6BCB', fg: '#FFFFFF' },
  default: { bg: '#878B95', fg: '#FFFFFF' },
};

function color(providerId) {
  return PALETTE[providerId] || PALETTE.default;
}

// ── 图形路径 ──────────────────────────────────────────────────
//
// 每个函数返回该图形的 SVG 片段（不含外层 svg 标签），
// 只用 fg 一个颜色；描边类的用 stroke，填充类的用 fill。

/** 三条横线：CodeBuddy 的命令行意象。 */
function codebuddy(fg) {
  const w = SIZE * 0.11;
  const y1 = PAD * 1.6;
  const y2 = SIZE / 2;
  const y3 = SIZE - PAD * 1.6;
  const line = (y) =>
    `<line x1="${PAD}" y1="${y}" x2="${SIZE - PAD}" y2="${y}" stroke="${fg}" stroke-width="${w}" stroke-linecap="round"/>`;
  return line(y1) + line(y2) + line(y3);
}

/** 闪电：Trae 的速度感。 */
function trae(fg) {
  const cx = SIZE / 2;
  const pts = [
    [SIZE * 0.62, PAD],
    [cx - PAD * 0.3, SIZE / 2 - PAD * 0.2],
    [cx + PAD * 0.3, SIZE / 2 - PAD * 0.2],
    [SIZE * 0.38, SIZE - PAD],
    [cx + PAD * 0.3, SIZE / 2 + PAD * 0.2],
    [cx - PAD * 0.3, SIZE / 2 + PAD * 0.2],
  ];
  return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fg}"/>`;
}

/** 五角星：小浣熊。 */
function raccoon(fg) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = SIZE / 2 - PAD;
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a1 = ((i * 72 - 90) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a1), cy + r * Math.sin(a1)]);
    const a2 = ((i * 72 - 90 + 36) * Math.PI) / 180;
    pts.push([cx + r * 0.38 * Math.cos(a2), cy + r * 0.38 * Math.sin(a2)]);
  }
  return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fg}"/>`;
}

/** 菱形描边：Loomy。 */
function loomy(fg) {
  const w = SIZE * 0.13;
  const pts = [
    [SIZE / 2, PAD],
    [SIZE - PAD, SIZE / 2],
    [SIZE / 2, SIZE - PAD],
    [PAD, SIZE / 2],
  ];
  return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${fg}" stroke-width="${w}" stroke-linejoin="round"/>`;
}

/** 「美」字：美团猫爪。 */
function catpaw(fg) {
  return `<text x="${SIZE / 2}" y="${SIZE * 0.68}" font-size="${SIZE * 0.52}" text-anchor="middle" fill="${fg}" font-family="sans-serif">美</text>`;
}

/** 鲸鱼简笔：DeepSeek。 */
function deepseek(fg) {
  const head = `<circle cx="${SIZE * 0.42}" cy="${SIZE * 0.48}" r="${SIZE * 0.22}" fill="${fg}"/>`;
  const tail = `<polygon points="${SIZE * 0.62},${SIZE * 0.34} ${SIZE * 0.82},${SIZE * 0.22} ${SIZE * 0.8},${SIZE * 0.5}" fill="${fg}"/>`;
  return head + tail;
}

/** 六边形：智谱。 */
function zhipu(fg) {
  const cx = SIZE / 2;
  const r = SIZE * 0.28;
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = ((i * 60 - 90) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cx + r * Math.sin(a)]);
  }
  return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${fg}" stroke-width="${SIZE * 0.11}" stroke-linejoin="round"/>`;
}

/** 对话气泡：智谱清言（多 Agent）。 */
function agentmore(fg) {
  const left = SIZE * 0.22;
  const top = SIZE * 0.26;
  const right = SIZE * 0.78;
  const bottom = SIZE * 0.66;
  const radius = SIZE * 0.12;
  const rect = `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="${radius}" ry="${radius}" fill="${fg}"/>`;
  const tail = `<polygon points="${SIZE * 0.34},${bottom} ${SIZE * 0.3},${SIZE * 0.8} ${SIZE * 0.46},${bottom}" fill="${fg}"/>`;
  return rect + tail;
}

/** 电视屏：当贝。 */
function dangbei(fg) {
  const w = SIZE * 0.1;
  const screen = `<rect x="${SIZE * 0.2}" y="${SIZE * 0.24}" width="${SIZE * 0.6}" height="${SIZE * 0.38}" rx="${SIZE * 0.08}" ry="${SIZE * 0.08}" fill="none" stroke="${fg}" stroke-width="${w}"/>`;
  const neck = `<rect x="${SIZE * 0.44}" y="${SIZE * 0.64}" width="${SIZE * 0.12}" height="${SIZE * 0.08}" fill="${fg}"/>`;
  const base = `<rect x="${SIZE * 0.32}" y="${SIZE * 0.72}" width="${SIZE * 0.36}" height="${SIZE * 0.06}" fill="${fg}"/>`;
  return screen + neck + base;
}

/** 四角星芒：秒悟。 */
function meoo(fg) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const outer = SIZE * 0.3;
  const inner = SIZE * 0.1;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const angle = ((i * 45 - 90) * Math.PI) / 180;
    const r = i % 2 === 0 ? outer : inner;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fg}"/>`;
}

/** 标签页 + 书签：Tabbit。 */
function tabbit(fg) {
  const w = SIZE * 0.1;
  const rect = `<rect x="${SIZE * 0.18}" y="${SIZE * 0.3}" width="${SIZE * 0.64}" height="${SIZE * 0.42}" rx="${SIZE * 0.08}" ry="${SIZE * 0.08}" fill="none" stroke="${fg}" stroke-width="${w}"/>`;
  const bookmark = `<polygon points="${SIZE * 0.34},${SIZE * 0.3} ${SIZE * 0.34},${SIZE * 0.14} ${SIZE * 0.54},${SIZE * 0.14} ${SIZE * 0.54},${SIZE * 0.3}" fill="${fg}"/>`;
  return rect + bookmark;
}

/** 三点：文心。 */
function wenxin(fg) {
  const r = SIZE * 0.075;
  return [0.32, 0.5, 0.68]
    .map((x) => `<circle cx="${SIZE * x}" cy="${SIZE * 0.5}" r="${r}" fill="${fg}"/>`)
    .join('');
}

/** 圆环带缺口 + 尾巴：Qoder 的 Q。 */
function qoder(fg) {
  const w = SIZE * 0.11;
  // 用 path 画 290 度的弧，起点 40 度
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = SIZE * 0.26;
  const start = (40 * Math.PI) / 180;
  const end = (330 * Math.PI) / 180;
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  const arc = `<path d="M ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2}" fill="none" stroke="${fg}" stroke-width="${w}" stroke-linecap="round"/>`;
  const tail = `<polygon points="${SIZE * 0.58},${SIZE * 0.58} ${SIZE * 0.78},${SIZE * 0.78} ${SIZE * 0.66},${SIZE * 0.8}" fill="${fg}"/>`;
  return arc + tail;
}

/** 星芒（十字 + 斜十字）：讯飞星辰。 */
function astudio(fg) {
  const w = SIZE * 0.1;
  const cx = SIZE * 0.5;
  const cy = SIZE * 0.5;
  const r = SIZE * 0.26;
  const d = r * 0.62;
  const line = (x1, y1, x2, y2) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${fg}" stroke-width="${w}" stroke-linecap="round"/>`;
  return (
    line(cx, cy - r, cx, cy + r) +
    line(cx - r, cy, cx + r, cy) +
    line(cx - d, cy - d, cx + d, cy + d) +
    line(cx + d, cy - d, cx - d, cy + d)
  );
}

const DRAWERS = {
  codebuddy,
  trae,
  raccoon,
  loomy,
  catpaw,
  deepseek,
  zhipu,
  agentmore,
  dangbei,
  meoo,
  tabbit,
  wenxin,
  qoder,
  astudio,
};

/**
 * 生成一个供应商图标的 SVG 字符串。
 *
 * 外层圆角矩形用 rx = SIZE/2 得到正圆底，与 Android 的 drawRoundRect 一致。
 */
function svg(providerId, size) {
  const s = Number(size) || SIZE;
  const { bg, fg } = color(providerId);
  const draw = DRAWERS[providerId];
  const inner = draw ? draw(fg) : `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE * 0.24}" fill="${fg}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${s}" height="${s}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${SIZE / 2}" ry="${SIZE / 2}" fill="${bg}"/>` +
    inner +
    `</svg>`
  );
}

/** data URI，直接塞进 <img src>。 */
function dataUri(providerId) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(providerId));
}

module.exports = { PALETTE, color, svg, dataUri, DRAWERS };
