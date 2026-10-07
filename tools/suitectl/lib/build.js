'use strict';
// build：core zip 校验 → 各组件规范工件（按 commit 缓存）→ assemble 组装 stage
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { P } = U;

const SUITE_TOOL_PS1 = `param([string]$Command = 'info')
# TabbySuite 随包精简工具（P3 将实现 update / rollback / doctor）
$specPath = Join-Path $PSScriptRoot '..\\data\\suite\\suite.json'
if (-not (Test-Path $specPath)) { Write-Error 'suite.json 缺失'; exit 1 }
$spec = Get-Content $specPath -Raw | ConvertFrom-Json
switch ($Command) {
  'info' {
    Write-Host "suiteVersion: $($spec.suiteVersion)"
    Write-Host "core:         $($spec.core.version)"
    foreach ($p in $spec.plugins.PSObject.Properties) { Write-Host "plugin:       $($p.Name) $($p.Value.version)" }
  }
  default { Write-Host "未知命令 $Command（当前仅 info；update/rollback/doctor 见 P3）" }
}
`;

// 规范工件 package.json 只保留安装/发现所需字段（对齐各仓库 package.js 的做法）
const SANITIZE_FIELDS = ['name', 'version', 'description', 'keywords', 'main', 'typings', 'author', 'license', 'peerDependencies'];

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
  for (const pair of bundle.rules?.mutuallyExclusive || []) {
    const hit = pair.filter(n => names.has(n));
    if (hit.length > 1) throw new Error(`互斥组件同时启用: ${hit.join(' + ')}（bundle.yaml rules）`);
  }
}

function ensureCoreZip(version) {
  const idx = U.readJson(P.vendorIndex);
  const e = idx.zips?.[version];
  if (!e) throw new Error(`vendor/index.json 未登记 core ${version}`);
  const file = path.isAbsolute(e.file) ? e.file : path.join(P.vendor, e.file);
  if (!fs.existsSync(file)) throw new Error(`core zip 不存在: ${file}${e.external ? '（外部登记路径，需手工放置）' : ''}`);
  const sha = U.sha256(file);
  if (e.sha256 && sha !== e.sha256) throw new Error(`core zip sha256 不符: ${file}`);
  return { version, file, sha256: sha, origin: e.origin };
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
  if (fs.existsSync(zipPath) && fs.existsSync(metaPath) && !st.dirty) {
    const meta = U.readJson(metaPath);
    console.log(`  [缓存] ${st.name}@${st.version} @${st.commit.slice(0, 8)}`);
    return meta;
  }
  console.log(`  [构建] ${st.name}@${st.version} @${st.commit.slice(0, 8)}${st.dirty ? '（脏工作树，绕过缓存）' : ''}`);
  if (!fs.existsSync(path.join(st.cwd, 'node_modules'))) {
    const flags = bundle.install?.[st.dir]?.flags ?? [];
    console.log(`    npm install ${flags.join(' ')}`.trimEnd());
    U.npm(['install', '--no-audit', '--no-fund', ...flags], { cwd: st.cwd });
  }
  U.npm(['run', 'build'], { cwd: st.cwd });
  // 单测/冒烟（有则必跑，多仓并行开发的第一道互不影响防线）
  for (const script of ['test', 'smoke']) {
    if (st.pkg.scripts?.[script]) {
      console.log(`    npm ${script}`);
      U.npm(['run', script], { cwd: st.cwd });
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
  U.rmrf(zipPath);
  U.ps(`Compress-Archive -Path "${stageDir}\\*" -DestinationPath "${zipPath}" -Force`);
  const meta = {
    dir: st.dir, name: st.name, version: st.version, commit: st.commit, dirty: st.dirty,
    stageDir, zip: zipPath, zipSha256: U.sha256(zipPath), builtAt: U.stamp(),
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
    U.ps(`Expand-Archive -LiteralPath "${core.file}" -DestinationPath "${cacheRoot}" -Force`);
    fs.writeFileSync(marker, core.sha256);
  }
  U.cloneTree(cacheRoot, dst);
}

function assemble(bundle, metas, core) {
  const ver = `${bundle.core.version}-s${bundle.suite.serial}`;
  const suiteDir = path.join(P.stage, 'tabby-suite');
  console.log(`\n[assemble] ${ver} → build/stage/tabby-suite/`);
  U.rmrf(P.stage);
  fs.mkdirSync(suiteDir, { recursive: true });
  ensureCoreTree(core, suiteDir);
  if (!fs.existsSync(path.join(suiteDir, 'Tabby.exe'))) throw new Error('core 解包后未见 Tabby.exe（zip 结构异常）');
  // 插件装入 data/plugins/node_modules/<pkg>（dist 必须是子目录 —— 压平会破坏 main 解析）
  const nm = path.join(suiteDir, 'data', 'plugins', 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  for (const m of metas) {
    const dst = path.join(nm, m.name);
    fs.cpSync(m.stageDir, dst, { recursive: true });
    if (!fs.existsSync(path.join(dst, 'dist', 'index.js'))) throw new Error(`安装后校验失败: ${m.name}/dist/index.js 缺失`);
  }
  // profile 种子（逐条拷入 data/）
  const profileDir = path.join(P.profiles, bundle.profile || 'base');
  const dataDir = path.join(suiteDir, 'data');
  if (fs.existsSync(profileDir)) {
    for (const f of fs.readdirSync(profileDir)) fs.cpSync(path.join(profileDir, f), path.join(dataDir, f), { recursive: true });
  }
  // suite-tools 随包精简工具
  fs.mkdirSync(path.join(suiteDir, 'suite-tools'), { recursive: true });
  fs.writeFileSync(path.join(suiteDir, 'suite-tools', 'suitectl.ps1'), SUITE_TOOL_PS1);
  // 安装态清单 + build-report
  const spec = {
    suiteVersion: ver,
    core: { version: core.version, sha256: core.sha256 },
    plugins: Object.fromEntries(metas.map(m => [m.name, { version: m.version, sha256: m.zipSha256, commit: m.commit, dirty: m.dirty }])),
    generatedAt: U.stamp(),
  };
  U.writeJson(path.join(dataDir, 'suite', 'suite.json'), spec);
  U.writeJson(P.buildReport, {
    ...spec,
    stageDir: suiteDir,
    coreFile: core.file,
    components: metas.map(m => ({ dir: m.dir, name: m.name, version: m.version, commit: m.commit, dirty: m.dirty, sha256: m.zipSha256 })),
  });
  console.log(`[assemble] 完成：${metas.length} 插件已装入 data/plugins/node_modules/`);
}

function buildCommand(bundle) {
  console.log(`[build] tabby-suite ${bundle.core.version}-s${bundle.suite.serial}`);
  const core = ensureCoreZip(bundle.core.version);
  console.log(`[core] ${core.version} sha256=${core.sha256.slice(0, 12)}…`);
  checkReference(bundle.core.version);
  const states = bundle.integrate.map(d => componentState(bundle, d));
  validateRules(bundle, states);
  const metas = states.map(st => buildComponent(bundle, st));
  assemble(bundle, metas, core);
}

module.exports = { buildCommand, componentState, buildComponent, ensureCoreZip };
