'use strict';
// 目录树规范化 hash —— 安装态完整性核对（doctor）与"verify 测的树 == release 压的树"绑定的基础。
// 算法（Node 与分发物内 suite-tools/suitectl.ps1 两侧必须严格一致；仓库侧源码在 tools/updater/）：
//   收集目录下全部文件（跳过 exclude 的顶层条目）；
//   每文件一行 "<文件sha256小写hex>  <相对路径 posix 分隔>"，按路径 ordinal 排序；
//   全部行以 "\n" 结尾连接成 utf8 文本；treeHash = sha256(该文本)。
const fs = require('fs');
const path = require('path');
const U = require('./util');

function collectFiles (dir, rel = '', acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  ))) {
    const abs = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) collectFiles(abs, r, acc);
    else if (e.isFile()) acc.push([r, U.sha256(abs)]);
    // 符号链接跳过（插件工件不含；core 便携树亦无）
  }
  return acc;
}

function treeHash (dir, opts = {}) {
  const exclude = new Set(opts.exclude || []);
  let entries = collectFiles(dir);
  if (exclude.size) entries = entries.filter(([r]) => !exclude.has(r.split('/')[0]));
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // ordinal
  const text = entries.map(([r, h]) => `${h}  ${r}\n`).join('');
  return U.sha256Str(text);
}

module.exports = { treeHash };
