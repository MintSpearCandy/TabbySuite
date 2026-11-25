'use strict';
// vendor：官方 core portable zip 的解析、获取、校验与登记。
// 解耦点：index.json 只记"内容事实"（file 相对名 / sha256 / origin），不记本机绝对路径；
// v2 新增：按 GitHub API 查询官方最新版，下载后计算 sha256 并自动登记 index.json
//（信任锚 = GitHub 官方 Releases；release 钉定时 index 随父仓 commit 落库）。
const fs = require('fs');
const path = require('path');
const { cfg, P } = require('./config');
const U = require('./util');
const platform = require('./platform');

const OFFICIAL_REPO = 'Eugeny/tabby';
const ASSET_RE = /^tabby-(\d+\.\d+\.\d+)-portable-x64\.zip$/;

function loadIndex() {
  if (!fs.existsSync(P.vendorIndex)) {
    throw new Error(`vendor/index.json 缺失（${P.vendorIndex}）—— 仓库不完整？`);
  }
  return U.readJson(P.vendorIndex);
}

function entryFor(version) {
  const entry = loadIndex().zips?.[version];
  if (!entry) {
    throw new Error(`vendor/index.json 未登记 core ${version} —— 用 suitectl core use ${version} 自动下载登记`);
  }
  return entry;
}

function zipPath(version, entry = entryFor(version)) {
  const file = entry.file || `tabby-${version}-portable-x64.zip`;
  return path.isAbsolute(file) ? file : path.join(P.vendor, file);
}

// 下载地址：显式 download 优先；否则由 GitHub release tag 页地址推导资产直链
function downloadUrl(version, entry) {
  if (entry.download) return entry.download;
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/(.+)$/.exec(entry.origin || '');
  if (!m) return null;
  const asset = entry.asset || path.basename(zipPath(version, entry));
  return `https://github.com/${m[1]}/${m[2]}/releases/download/${m[3]}/${asset}`;
}

function verifySha(file, expected) {
  const sha = U.sha256(file);
  if (expected && sha !== expected) {
    throw new Error(`core zip sha256 不符: ${file}\n  期望 ${expected}\n  实得 ${sha}`);
  }
  return sha;
}

// 下载（curl，代理见环境配置 net.proxy / TABBYSUITE_PROXY）→ sha256 校验 → 原子就位
function download(url, dest, expectedSha) {
  console.log(`[vendor] 下载 ${url}${cfg.net.proxy ? `（代理 ${cfg.net.proxy}）` : ''}`);
  platform.fetchUrl(url, dest);
  const sha = verifySha(`${dest}`, expectedSha); // fetchUrl 已原子 rename 到 dest
  console.log(`[vendor] ✓ ${path.basename(dest)}（sha256 ${sha.slice(0, 12)}…）`);
  return sha;
}

// 登记新版本（自动下载路径）：index.json 保持键排序，diff 友好
function register(version, { file, sha256, origin }) {
  const idx = loadIndex();
  idx.zips = idx.zips || {};
  idx.zips[version] = { file, sha256, origin };
  idx.zips = Object.fromEntries(Object.entries(idx.zips).sort(([a], [b]) => U.cmpSemver(a, b)));
  U.writeJson(P.vendorIndex, idx);
  console.log(`[vendor] 已登记 core ${version} → vendor/index.json`);
}

// 官方最新版查询（GitHub API，只读）：{ version, url, tag } | null
async function githubLatest() {
  const rel = platform.getJson(`https://api.github.com/repos/${OFFICIAL_REPO}/releases/latest`, { timeoutSec: 30 });
  const tag = rel.tag_name || '';
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(tag);
  const asset = (rel.assets || []).find(a => ASSET_RE.test(a.name) && ASSET_RE.exec(a.name)[1] === (m ? m[1] : ''));
  if (!m || !asset) return null;
  return { version: m[1], url: asset.browser_download_url, tag: `v${m[1]}` };
}

// 官方是否有比 version 更新的版本（离线/查询失败 → null，视作"无更新"并提示）
async function officialNewerThan(version) {
  try {
    const latest = await githubLatest();
    if (!latest) return null;
    if (U.cmpSemver(latest.version, version) <= 0) return null;
    return latest;
  } catch (e) {
    console.log(`[core] ⚠ 官方最新版查询失败（${String(e.message).split('\n')[0]}）—— 保持 ${version} 继续`);
    return null;
  }
}

// 返回 { version, file, sha256, origin }；缺失且允许联网时自动下载
async function ensureCoreZip(version, opts = {}) {
  const entry = loadIndex().zips?.[version];
  const file = entry ? zipPath(version, entry) : path.join(P.vendor, `tabby-${version}-portable-x64.zip`);
  const offline = opts.offline ?? !cfg.vendor.autoDownload;

  if (entry && fs.existsSync(file) && !opts.force) {
    return { version, file, sha256: verifySha(file, entry.sha256), origin: entry.origin };
  }
  if (offline) {
    throw new Error(
      `core zip 缺失: ${file}\n  → 联网运行 node tools/suitectl/cli.js core use ${version}，或按 vendor/index.json 的 origin 手工放入该位置（--offline 可跳过自动下载）`
    );
  }
  // 未登记的版本：按官方 Releases 直链下载（tag 命名稳定），sha256 算得后登记
  const url = entry ? downloadUrl(version, entry)
    : `https://github.com/${OFFICIAL_REPO}/releases/download/v${version}/${path.basename(file)}`;
  const sha = download(url, file, entry?.sha256);
  if (!entry) register(version, { file: path.basename(file), sha256: sha, origin: `https://github.com/${OFFICIAL_REPO}/releases/tag/v${version}` });
  return { version, file, sha256: sha, origin: entry?.origin };
}

function status() {
  const idx = loadIndex();
  return Object.entries(idx.zips || {}).map(([version, entry]) => {
    const file = zipPath(version, entry);
    const present = fs.existsSync(file);
    let shaOk = null;
    if (present && entry.sha256) {
      try { shaOk = verifySha(file, entry.sha256) === entry.sha256; } catch { shaOk = false; }
    }
    return { version, file, present, shaOk, sha256: entry.sha256, origin: entry.origin, url: downloadUrl(version, entry) };
  });
}

function statusCommand() {
  const rows = status();
  if (!rows.length) return console.log('[vendor] index 无条目');
  for (const r of rows) {
    const state = !r.present ? '缺失' : r.shaOk === false ? 'sha256 不符' : '就绪';
    console.log(`  ${r.version}  ${state.padEnd(10)} ${r.file}`);
    if (!r.present) console.log(`    下载: ${r.url || '（无直链，需在 index.json 补 download）'}`);
  }
}

async function fetchCommand(version, opts = {}) {
  const hit = await ensureCoreZip(version, { force: opts.force });
  console.log(`[vendor] core ${version} 就绪: ${hit.file}`);
}

module.exports = {
  loadIndex, entryFor, zipPath, downloadUrl, register, githubLatest, officialNewerThan,
  ensureCoreZip, status, statusCommand, fetchCommand, OFFICIAL_REPO,
};
