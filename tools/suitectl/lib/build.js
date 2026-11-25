'use strict';
// build：core zip 校验/获取 → 各组件规范工件（按 commit+配方 缓存）→ assemble 组装 stage。
// v2 版本语义：serial 不再手维护 —— 候选版本 = <core>-s<该 core 在 channel 的最大 serial + 1>，
//   release 落 channel 后下一次 build 自然 +1（"全浮动·发布即锁"）。
const fs = require('fs');
const path = require('path');
const U = require('./util');
const platform = require('./platform');
const vendor = require('./vendor');
const { treeHash } = require('./hash');
const { P, cfg } = require('./config');

// 规范工件 package.json 只保留安装/发现所需字段（对齐各仓库 package.js 的做法）
const SANITIZE_FIELDS = ['name', 'version', 'description', 'keywords', 'main', 'typings', 'author', 'license', 'peerDependencies'];

// 候选套件版本：同 core 已发布过的最大 serial + 1（无历史则 s1）
function candidateVersion(coreVersion) {
  const ch = fs.existsSync(P.channel) ? U.readJson(P.channel) : null;
  let max = 0;
  for (const [v, r] of Object.entries(ch?.releases || {})) {
    if (r?.core !== coreVersion) continue;
    const m = /-s(\d+)$/.exec(v);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${coreVersion}-s${max + 1}`;
}

// 缓存配方：bundle 中会影响产物的段落变了 → 同 commit 也必须重建（防陈旧缓存冒充）
function recipeOf(bundle, st) {
  return U.sha256Str(JSON.stringify({
    payload: bundle.payload?.[st.dir] || [],
    installFlags: bundle.install?.[st.dir]?.flags || [],
    sanitize: SANITIZE_FIELDS,
  }));
}

function componentState(bundle, dir) {
  const cwd = path.join(P.components, dir);
  if (!fs.existsSync(path.join(cwd, '.git'))) throw new Error(`components/${dir} 不是 git 子仓（先 git submodule add）`);
  const commit = U.gitOut(['-C', cwd, 'rev-parse', 'HEAD']);
  const dirty = U.gitOut(['-C', cwd, 'status', '--porcelain'], { ok: true }) !== '';
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  if (!(pkg.keywords || []).includes('tabby-plugin')) {
    throw new Error(`${dir}: package.json keywords 缺 "tabby-plugin"，Tabby 无法发现该插件`);
  }
  return { dir, cwd, commit, dirty, pkg, name: pkg.name, version: pkg.version };
}

function validateRules(bundle, states) {
  const names = new Set(states.map(s => s.name));
  if (names.size !== states.length) throw new Error('integrate 中存在同名包（package.json name 冲突）——安装会相互覆盖');
  for (const pair of bundle.rules?.mutuallyExclusive || []) {
    const hit = pair.filter(n => names.has(n));
    if (hit.length > 1) throw new Error(`互斥组件同时启用: ${hit.join(' + ')}（bundle.yaml rules）`);
  }
}

// npm install 感知依赖变化：安装基线戳存 cache/install/<pkg>.json（不能放子仓内——会污染工作树致其"脏"）
function ensureInstalled(bundle, st) {
  const nm = path.join(st.cwd, 'node_modules');
  const stampDir = path.join(P.cacheRoot, 'install');
  const stampPath = path.join(stampDir, `${st.name}.json`);
  const lock = path.join(st.cwd, 'package-lock.json');
  const basis = U.sha256Str(JSON.stringify({
    pkg: fs.readFileSync(path.join(st.cwd, 'package.json'), 'utf8'),
    lock: fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null,
    flags: bundle.install?.[st.dir]?.flags || [],
  }));
  const fresh = (() => { try { return U.readJson(stampPath).basis === basis; } catch { return false; } })();
  if (fs.existsSync(nm) && fresh) return;
  const flags = bundle.install?.[st.dir]?.flags ?? [];
  console.log(`    npm install ${flags.join(' ')}`.trimEnd() + (fs.existsSync(nm) ? '（依赖基线已变）' : ''));
  platform.npm(['install', '--no-audit', '--no-fund', ...flags], { cwd: st.cwd });
  U.writeJson(stampPath, { basis, at: U.stamp() });
}

// 参考源码一致性：reference/tabby 子仓应钉在与构建 core 相同的版本（开发参考，非构建输入——不一致仅警告）
function checkReference (coreVersion) {
  const refDir = path.join(P.root, 'reference', 'tabby');
  if (!fs.existsSync(path.join(refDir, '.git'))) {
    console.log('[reference] tabby 源码参考未检出（git submodule update --init reference/tabby）——不影响构建');
    return;
  }
  const tag = U.gitOut(['-C', refDir, 'describe', '--tags', '--exact-match', 'HEAD'], { ok: true });
  if (!tag) {
    console.log('[reference] ⚠ reference/tabby 不在 tag 上（detached 漂移）——建议 checkout v' + coreVersion + ' 后父仓 commit');
  } else if (tag !== `v${coreVersion}`) {
    console.log(`[reference] ⚠ 参考源码钉在 ${tag}，构建 core 为 v${coreVersion}——建议重钉保持同版`);
  } else {
    console.log(`[reference] tabby 源码参考 @${tag} ✓`);
  }
}

function buildComponent(bundle, st) {
  const cacheDir = path.join(P.cache, `${st.name}@${st.commit}`);
  const zipPath = path.join(cacheDir, `${st.name}-${st.version}.zip`);
  const metaPath = path.join(cacheDir, 'meta.json');
  const recipe = recipeOf(bundle, st);
  if (fs.existsSync(zipPath) && fs.existsSync(metaPath) && !st.dirty) {
    const meta = U.readJson(metaPath);
    // 同 commit 两种树/两种配方不得互冒：脏构建不冒充干净，旧配方不冒充新配方
    if (meta.dirty === false && meta.recipe === recipe) {
      console.log(`  [缓存] ${st.name}@${st.version} @${st.commit.slice(0, 8)}`);
      return meta;
    }
    console.log(`  [重建] ${st.name}：缓存来自${meta.dirty ? '脏树' : '旧配方'}构建，按当前状态重建`);
  }
  console.log(`  [构建] ${st.name}@${st.version} @${st.commit.slice(0, 8)}${st.dirty ? '（脏工作树，绕过缓存）' : ''}`);
  ensureInstalled(bundle, st);
  platform.npm(['run', 'build'], { cwd: st.cwd });
  // 单测/冒烟（有则必跑，多仓并行开发的第一道互不影响防线）
  for (const script of ['test', 'smoke']) {
    if (st.pkg.scripts?.[script]) {
      console.log(`    npm run ${script}`);
      platform.npm(['run', script], { cwd: st.cwd });
    }
  }
  // 规范化工件：{package.json, dist/(子目录！), README}
  const dist = path.join(st.cwd, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.js'))) throw new Error(`${st.dir}: dist/index.js 缺失（构建未产出 main 入口）`);
  const stageDir = path.join(cacheDir, st.name);
  U.rmrf(stageDir);
  fs.mkdirSync(stageDir, { recursive: true });
  const sanitized = {};
  for (const k of SANITIZE_FIELDS) if (st.pkg[k] !== undefined) sanitized[k] = st.pkg[k];
  sanitized.main = st.pkg.main || 'dist/index.js';
  fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(sanitized, null, 2) + '\n');
  fs.cpSync(dist, path.join(stageDir, 'dist'), { recursive: true });
  for (const rd of ['README.md', 'README']) {
    if (fs.existsSync(path.join(st.cwd, rd))) {
      fs.copyFileSync(path.join(st.cwd, rd), path.join(stageDir, rd));
      break;
    }
  }
  // bundle.payload.<dir>：规范工件之外的附加载荷（目录或文件，如 native 二进制）
  for (const rel of bundle.payload?.[st.dir] || []) {
    const src = path.join(st.cwd, rel);
    if (!fs.existsSync(src)) throw new Error(`${st.dir}: bundle.payload 路径不存在：${rel}`);
    const dst = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }
  U.rmrf(zipPath);
  platform.zipDir(stageDir, zipPath); // zip 内带顶层 <pkg>/ 目录（更新器解包后取内层）
  const meta = {
    dir: st.dir, name: st.name, version: st.version, commit: st.commit, dirty: st.dirty, recipe,
    stageDir, zip: zipPath, zipName: path.basename(zipPath), zipSha256: U.sha256(zipPath), builtAt: U.stamp(),
  };
  U.writeJson(metaPath, meta);
  return meta;
}

// core 解包缓存：同版本 zip（hash 一致）只解一次，之后硬链接克隆进 stage（内环提速的关键）
function ensureCoreTree (core, dst) {
  const cacheRoot = path.join(P.build, 'core-cache', core.version);
  const marker = path.join(cacheRoot, '.zip-sha256');
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8').trim() !== core.sha256) {
    console.log(`[core-cache] 解包 ${core.version}（zip sha256 ${core.sha256.slice(0, 12)}…）`);
    U.rmrf(cacheRoot);
    fs.mkdirSync(cacheRoot, { recursive: true });
    platform.unzip(core.file, cacheRoot);
    fs.writeFileSync(marker, core.sha256);
  }
  U.cloneTree(cacheRoot, dst);
}

// 构建态失效：assemble 半途而废时绝不能留旧的 build-report/.verify-passed 冒充"当前 stage 已构建/已验证"
function invalidateBuildState() {
  for (const f of [P.buildReport, path.join(P.build, '.verify-passed')]) {
    try { fs.rmSync(f, { force: true }); } catch { /* 尽力 */ }
  }
}

function assemble(bundle, ver, metas, core) {
  const suiteDir = path.join(P.stage, 'tabby-suite');
  console.log(`\n[assemble] ${ver} → ${path.relative(P.root, P.stage)}/tabby-suite/`);
  try {
    U.rmrf(P.stage);
    fs.mkdirSync(suiteDir, { recursive: true });
    ensureCoreTree(core, suiteDir);
    platform.assertExe(suiteDir, 'core');
    // 插件装入 data/plugins/node_modules/<pkg>（dist 必须是子目录 —— 压平会破坏 main 解析）
    const nm = path.join(suiteDir, 'data', 'plugins', 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    for (const m of metas) {
      const dst = path.join(nm, m.name);
      fs.cpSync(m.stageDir, dst, { recursive: true }); // 实拷：会被执行的树不硬链
      if (!fs.existsSync(path.join(dst, 'dist', 'index.js'))) throw new Error(`安装后校验失败: ${m.name}/dist/index.js 缺失`);
    }
    // profile 种子（逐条拷入 data/）
    const profileDir = path.join(P.profiles, bundle.profile || 'base');
    if (!fs.existsSync(profileDir)) throw new Error(`profile 种子目录不存在: ${profileDir}（bundle.yaml profile）`);
    const dataDir = path.join(suiteDir, 'data');
    for (const f of fs.readdirSync(profileDir)) fs.cpSync(path.join(profileDir, f), path.join(dataDir, f), { recursive: true });
    // suite-tools 随包更新器（仓库内单一实现，CLI 的 update/doctor 也转调它）
    fs.mkdirSync(path.join(suiteDir, 'suite-tools'), { recursive: true });
    fs.copyFileSync(path.join(P.suiteTools, 'suitectl.ps1'), path.join(suiteDir, 'suite-tools', 'suitectl.ps1'));
    // 安装态清单（更新器/doctor 的依据）+ build-report
    const pluginSpec = {};
    for (const m of metas) {
      const dst = path.join(nm, m.name);
      pluginSpec[m.name] = {
        version: m.version, commit: m.commit, dirty: m.dirty,
        zip: m.zipName, zipSha256: m.zipSha256, treeSha256: treeHash(dst),
      };
    }
    const spec = {
      suiteVersion: ver,
      exe: platform.exeName(),
      channel: `https://github.com/${cfg.dist.repo}/releases/latest/download/channel.json`,
      core: { version: core.version, zipSha256: core.sha256, treeSha256: treeHash(suiteDir, { exclude: ['data'] }) },
      plugins: pluginSpec,
      generatedAt: U.stamp(),
    };
    U.writeJson(path.join(dataDir, 'suite', 'suite.json'), spec);
    const stageTreeHash = treeHash(suiteDir);
    U.writeJson(P.buildReport, {
      ...spec,
      stageDir: suiteDir,
      stageTreeHash,
      coreFile: core.file,
      components: metas.map(m => ({ dir: m.dir, name: m.name, version: m.version, commit: m.commit, dirty: m.dirty, sha256: m.zipSha256, zip: m.zip, zipName: m.zipName })),
    });
    console.log(`[assemble] 完成：${metas.length} 插件已装入 data/plugins/node_modules/`);
  } catch (e) {
    invalidateBuildState();
    throw e;
  }
}

async function buildCommand(bundle, opts = {}) {
  const ver = candidateVersion(bundle.core.version);
  console.log(`[build] tabby-suite ${ver}（候选版本：serial 由 channel 派生）`);
  const core = await vendor.ensureCoreZip(bundle.core.version, { offline: opts.offline });
  console.log(`[core] ${core.version} sha256=${core.sha256.slice(0, 12)}…`);
  checkReference(bundle.core.version);
  const states = bundle.integrate.map(d => componentState(bundle, d));
  validateRules(bundle, states);
  const metas = states.map(st => buildComponent(bundle, st));
  assemble(bundle, ver, metas, core);
}

module.exports = { buildCommand, componentState, buildComponent, candidateVersion, invalidateBuildState };
