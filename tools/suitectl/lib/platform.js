'use strict';
// 平台组件（platform）：Tabby core 作为套件的宿主平台 —— 版本管理 + 官方 zip 获取/校验/登记 + 源码参考。
// v4 由 core.js + vendor.js 合并而成：套件 = 平台组件（官方 zip，版本可切换，原样分发）+ 插件组件（components/ 子仓）。
//   - bundle.yaml platform: { version, pin }（pin:auto 时 up 自动前进并回写；release 钉定落库）
//   - platform/index.json 只记"内容事实"（file 相对名 / sha256 / origin），不记本机绝对路径；
//     未登记版本按官方 Releases 直链下载，sha256 算得后自动登记（信任锚 = GitHub 官方 Releases）
//   - platform/reference/tabby 源码参考为**按需检出**（非子仓，gitignore）：suitectl platform ref
// 线上格式（channel.json / suite.json）仍用字段名 core —— 目标机 ps1 更新器与既有安装不受本层重命名影响。
const fs = require('fs');
const path = require('path');
const { cfg, P } = require('./config');
const U = require('./util');
const sys = require('./sys');

const OFFICIAL_REPO = 'Eugeny/tabby';
const OFFICIAL_URL = `https://github.com/${OFFICIAL_REPO}.git`;
const ASSET_RE = /^tabby-(\d+\.\d+\.\d+)-portable-x64\.zip$/;

// ---- index.json（platform/ 固定在仓库内；zip 存放目录可经 paths.platformZips 移出）----
function loadIndex() {
  if (!fs.existsSync(P.platformIndex)) {
    throw new Error(`platform/index.json 缺失（${P.platformIndex}）—— 仓库不完整？`);
  }
  return U.readJson(P.platformIndex);
}

function entryFor(version) {
  const entry = loadIndex().zips?.[version];
  if (!entry) {
    throw new Error(`platform/index.json 未登记平台版本 ${version} —— 用 suitectl platform use ${version} 自动下载登记`);
  }
  return entry;
}

function zipPath(version, entry = entryFor(version)) {
  const file = entry.file || `tabby-${version}-portable-x64.zip`;
  return path.isAbsolute(file) ? file : path.join(P.platformZips, file);
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
    throw new Error(`平台 zip sha256 不符: ${file}\n  期望 ${expected}\n  实得 ${sha}`);
  }
  return sha;
}

// 下载（curl，代理见环境配置 net.proxy / TABBYSUITE_PROXY）→ sha256 校验 → 原子就位
function download(url, dest, expectedSha) {
  console.log(`[platform] 下载 ${url}${cfg.net.proxy ? `（代理 ${cfg.net.proxy}）` : ''}`);
  sys.fetchUrl(url, dest);
  const sha = verifySha(`${dest}`, expectedSha); // fetchUrl 已原子 rename 到 dest
  console.log(`[platform] ✓ ${path.basename(dest)}（sha256 ${sha.slice(0, 12)}…）`);
  return sha;
}

// 登记新版本（自动下载路径）：index.json 保持键排序，diff 友好
function register(version, { file, sha256, origin }) {
  const idx = loadIndex();
  idx.zips = idx.zips || {};
  idx.zips[version] = { file, sha256, origin };
  idx.zips = Object.fromEntries(Object.entries(idx.zips).sort(([a], [b]) => U.cmpSemver(a, b)));
  U.writeJson(P.platformIndex, idx);
  console.log(`[platform] 已登记平台版本 ${version} → platform/index.json`);
}

// ---- 官方最新版查询（GitHub API，只读）：{ version, url, tag } | null ----
async function githubLatest() {
  const rel = sys.getJson(`https://api.github.com/repos/${OFFICIAL_REPO}/releases/latest`, { timeoutSec: 30 });
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
    console.log(`[platform] ⚠ 官方最新版查询失败（${String(e.message).split('\n')[0]}）—— 保持 ${version} 继续`);
    return null;
  }
}

// 返回 { version, file, sha256, origin }；缺失且允许联网时自动下载
async function ensureZip(version, opts = {}) {
  const entry = loadIndex().zips?.[version];
  const file = entry ? zipPath(version, entry) : path.join(P.platformZips, `tabby-${version}-portable-x64.zip`);
  const offline = opts.offline ?? !cfg.platform.autoDownload;

  if (entry && fs.existsSync(file) && !opts.force) {
    return { version, file, sha256: verifySha(file, entry.sha256), origin: entry.origin };
  }
  if (offline) {
    throw new Error(
      `平台 zip 缺失: ${file}\n  → 联网运行 node tools/suitectl/cli.js platform use ${version}，或按 platform/index.json 的 origin 手工放入该位置（--offline 可跳过自动下载）`
    );
  }
  // 未登记的版本：按官方 Releases 直链下载（tag 命名稳定），sha256 算得后登记
  const url = entry ? downloadUrl(version, entry)
    : `https://github.com/${OFFICIAL_REPO}/releases/download/v${version}/${path.basename(file)}`;
  const sha = download(url, file, entry?.sha256);
  if (!entry) register(version, { file: path.basename(file), sha256: sha, origin: `https://github.com/${OFFICIAL_REPO}/releases/tag/v${version}` });
  return { version, file, sha256: sha, origin: entry?.origin };
}

// ---- 源码参考（按需检出，非子仓）：platform/reference/tabby @ v<版本> ----
function refCommand(bundle) {
  const version = bundle.platform.version;
  const dir = P.platformReference;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    console.log(`[platform] 克隆核心源码参考 → ${path.relative(P.root, dir)}（shallow @v${version}，按需检出非子仓）`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    U.git(['clone', '--depth', '1', '--branch', `v${version}`, OFFICIAL_URL, dir]);
  } else {
    U.git(['-C', dir, 'fetch', '--depth', '1', 'origin', 'tag', `v${version}`], { ok: true });
    U.git(['-C', dir, 'checkout', '--detach', `v${version}`]);
  }
  console.log(`[platform] 源码参考 @v${version} ✓（查核心内部实现优先读它；平台前进后 platform ref 重钉）`);
}

// platform use 的完整动作：确保 zip → 登记 → 改 bundle → 重钉源码参考（如已检出）
async function platformUse(bundle, version, opts = {}) {
  const hit = await ensureZip(version, { offline: opts.offline });
  console.log(`[platform] ${version} 就绪（sha256 ${hit.sha256.slice(0, 12)}…）`);
  if (bundle.platform.version !== version) {
    writeBundlePlatformVersion(version);
    console.log(`[platform] bundle.yaml platform.version: ${bundle.platform.version} → ${version}`);
    bundle.platform.version = version; // 就地更新，供同进程后续使用
  }
  repinReference(version);
  console.log('[platform] 下一步：suitectl up（构建+门禁）—— 平台变更走整包路径，verify 必跑');
}

async function platformCommand(bundle, args, opts = {}) {
  const sub = args[0];
  const pinned = bundle.platform.pin && bundle.platform.pin !== 'auto';
  if (sub === 'list') return listCommand(bundle);
  if (sub === 'ref') return refCommand(bundle);
  if (sub === 'latest' || (sub === 'use' && args[1] === 'latest')) {
    const latest = await githubLatest();
    if (!latest) throw new Error('官方 Releases 未找到 portable-x64 资产（tag 命名变化？）');
    console.log(`[platform] 官方最新 ${latest.version}（${latest.tag}）`);
    console.log(`[platform] 当前构建 ${bundle.platform.version}${pinned ? `（pin 锁定 ${bundle.platform.pin}）` : ''}`);
    if (sub === 'latest') {
      const d = U.cmpSemver(latest.version, bundle.platform.version);
      console.log(`[platform] ${d > 0 ? '有更新' : d === 0 ? '已最新' : '本地领先（预发布/回退?）'}${d > 0 ? ` —— suitectl platform use ${latest.version} 前进` : ''}`);
      return;
    }
    await platformUse(bundle, latest.version, opts);
    return;
  }
  if (sub === 'use') {
    const version = args[1];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error('用法: platform use <x.y.z>|latest');
    }
    await platformUse(bundle, version, opts);
    return;
  }
  if (sub === 'fetch') {
    const hit = await ensureZip(args[1] || bundle.platform.version, { force: opts.force });
    console.log(`[platform] 平台 ${hit.version} 就绪: ${hit.file}`);
    return;
  }
  throw new Error('platform 子命令: list（登记与缓存状态）| latest（查官方最新）| use <版本>|latest（前进并登记）| fetch [版本] [--force] | ref（按需检出源码参考）');
}

// 只改 bundle.yaml 中 platform: 下的 version 行，保留注释与其余内容（js-yaml 往返会丢注释，故行级替换）
function writeBundlePlatformVersion(version) {
  const lines = fs.readFileSync(P.bundle, 'utf8').split('\n');
  let inBlock = false, done = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^platform:\s*$/.test(l)) { inBlock = true; continue; }
    if (inBlock && /^\S/.test(l)) break; // 离开 platform: 块
    if (inBlock && /^(\s+)version:\s*\S+/.test(l) && !done) {
      lines[i] = l.replace(/^(\s+)version:\s*\S+/, `$1version: ${version}`);
      done = true;
    }
  }
  if (!done) throw new Error('bundle.yaml 中未找到 platform.version —— 结构异常');
  fs.writeFileSync(P.bundle, lines.join('\n'));
}

// reference 重钉到 v<version>（浅取 tag；未检出不阻路，提示按需命令）
function repinReference(version) {
  if (!fs.existsSync(path.join(P.platformReference, '.git'))) {
    console.log('[platform] 源码参考未检出，跳过重钉（需要时：suitectl platform ref）');
    return;
  }
  U.git(['-C', P.platformReference, 'fetch', '--depth', '1', 'origin', `tag`, `v${version}`], { ok: true });
  U.git(['-C', P.platformReference, 'checkout', '--detach', `v${version}`]);
  console.log(`[platform] 源码参考 → v${version}（gitignore，不入库——按需检出）`);
}

// up 编排用：pin:auto 且官方更新可用时自动前进；否则零动作。
// 返回 { advanced, version? }（advanced = 平台是否前进）。
async function ensureLatestPlatform(bundle, opts = {}) {
  if (opts.offline) {
    console.log('[platform] --offline 跳过查新');
    return { advanced: false };
  }
  if (bundle.platform.pin && bundle.platform.pin !== 'auto') {
    console.log(`[platform] pin 锁定 ${bundle.platform.pin}，不自动前进（platform use 可显式前进）`);
    return { advanced: false };
  }
  const newer = await officialNewerThan(bundle.platform.version);
  if (!newer) { console.log(`[platform] ${bundle.platform.version} 已是官方最新（或查询不可用）`); return { advanced: false }; }
  console.log(`[platform] 官方有新版 ${newer.version} —— 自动前进`);
  await platformUse(bundle, newer.version, opts);
  return { advanced: true, version: newer.version };
}

// 登记与缓存总览（原 vendor status）：当前构建版本打标，缺失/损坏一目了然
function listCommand(bundle) {
  const idx = loadIndex();
  const current = bundle.platform.version;
  const rows = Object.entries(idx.zips || {});
  if (!rows.length) return console.log('[platform] index 无条目');
  for (const [version, entry] of rows) {
    const file = zipPath(version, entry);
    const present = fs.existsSync(file);
    let shaOk = null;
    if (present && entry.sha256) {
      try { shaOk = verifySha(file, entry.sha256) === entry.sha256; } catch { shaOk = false; }
    }
    const state = !present ? '缺失' : shaOk === false ? 'sha256 不符' : '就绪';
    const mark = version === current ? '  ← 当前构建' : '';
    console.log(`  ${version.padEnd(10)} ${state.padEnd(10)} ${file}${mark}`);
    if (!present) console.log(`    下载: ${downloadUrl(version, entry) || '（无直链，需在 index.json 补 download）'}`);
  }
}

module.exports = {
  loadIndex, entryFor, zipPath, downloadUrl, register, githubLatest, officialNewerThan,
  ensureZip, ensureLatestPlatform, listCommand, refCommand, platformCommand,
  writeBundlePlatformVersion, repinReference, OFFICIAL_REPO,
};
