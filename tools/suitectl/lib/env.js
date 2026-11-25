'use strict';
// env：本机环境预检 —— 换一台机器（或新克隆）先跑它，一次说清"缺什么、怎么补"。
// 只读检查，不构建、不改仓库内容（不创建目录——缺目录如实报告，首次构建时自动建）；--json 供脚本消费。
const fs = require('fs');
const path = require('path');
const U = require('./util');
const platform = require('./platform');
const vendor = require('./vendor');
const { ROOT, cfg, P } = require('./config');
const { candidateVersion } = require('./build');

const MIN_NODE_MAJOR = 22;

function writeProbe(dir) {
  if (!fs.existsSync(path.dirname(dir))) return `父目录缺失: ${path.dirname(dir)}`;
  if (!fs.existsSync(dir)) return null; // 目录未建不算失败——build 时自动创建
  try {
    const probe = path.join(dir, '.suitectl-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return null;
  } catch (e) {
    return e.code || e.message;
  }
}

async function collect(bundle) {
  const checks = [];
  const add = (id, ok, detail, level = 'fail') => checks.push({ id, ok, detail, level });

  // 运行时前提
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= MIN_NODE_MAJOR, `node v${process.versions.node}${nodeMajor >= MIN_NODE_MAJOR ? '' : `（需 ≥ ${MIN_NODE_MAJOR}）`}`);

  const git = platform.commandPath('git');
  const isRepo = fs.existsSync(path.join(ROOT, '.git'));
  add('git', !!(git && isRepo), git ? `${git}${isRepo ? '' : '（当前目录不是 git 仓库）'}` : '未找到 git');

  // 子仓检出
  const missingSub = (bundle.integrate || []).filter(d => !fs.existsSync(path.join(P.components, d, '.git')));
  add('submodules', missingSub.length === 0,
    missingSub.length ? `缺 ${missingSub.join(', ')}（git submodule update --init）` : `${bundle.integrate.length} 个 integrate 子仓已检出`);
  const refOk = fs.existsSync(path.join(ROOT, 'reference', 'tabby', '.git'));
  add('reference', refOk, refOk ? 'reference/tabby 已检出' : '未检出（仅影响源码参考，不影响构建；git submodule update --init reference/tabby）', 'warn');

  // 平台能力
  add('platform', !!cfg.platform.exe, cfg.platform.exe
    ? `${cfg.platform.id} → 可执行文件 ${cfg.platform.exe}`
    : `${cfg.platform.id} 未配置可执行文件名 —— suitectl.local.yaml 的 platform.exe`);
  const ps = cfg.platform.powershell ? platform.commandPath(cfg.platform.powershell) : null;
  add('powershell', !!ps, cfg.platform.powershell
    ? (ps ? `${ps}（进程管理/更新器）` : `未找到 ${cfg.platform.powershell}（进程管理/更新器依赖它；可在 suitectl.local.yaml 改 platform.powershell）`)
    : `当前平台未配置 platform.powershell（进程管理不可用）`);
  const npm = platform.commandPath('npm');
  add('npm', !!npm, npm || '未找到 npm（组件构建依赖它）');

  // 打包引擎（v2：系统 tar）与网络（curl / gh）
  const tarFlavor = platform.tarFlavorProbe();
  const unzipAlt = platform.commandPath('unzip');
  add('tar', tarFlavor === 'bsd' || !!unzipAlt, tarFlavor === 'bsd'
    ? 'bsdtar（zip 读写原生支持）'
    : tarFlavor === 'gnu'
      ? (unzipAlt ? `GNU tar + unzip 回退（zip 创建还需 zip CLI：${platform.commandPath('zip') ? '已装' : '未装'}）` : 'GNU tar 且无 unzip —— 安装 libarchive 或 unzip')
      : '未找到 tar —— Windows/macOS 系统自带，Linux 见发行版包管理');
  const curl = platform.commandPath('curl');
  add('curl', !!curl, curl ? `${curl}（下载/代理）` : '未找到 curl（core 下载与 GitHub API 依赖它）');
  const gh = platform.commandPath('gh');
  add('gh', !!gh, gh ? `${gh}（release 上传）` : '未找到 gh CLI（release 上传跳过；安装 GitHub CLI 后可用）', 'warn');

  // 网络：代理配置状态
  add('net.proxy', true, cfg.net.proxy
    ? `已配置 ${cfg.net.proxy}（GitHub API / core zip / channel / gh 走代理）`
    : '直连（需代理时：suitectl.local.yaml 的 net.proxy 或 TABBYSUITE_PROXY=http://127.0.0.1:7892）', 'info');

  // 路径可写（目录可重定向到仓库外：suitectl.local.yaml paths.*）
  for (const [key, dir] of [['vendor', P.vendor], ['cache', P.cache], ['build', P.build], ['runtime', P.runtime], ['releases', P.releases]]) {
    const err = writeProbe(dir);
    add(`path.${key}`, !err, err ? `${dir}（${err}）` : dir);
  }

  // core zip：缺失时能否自动获取
  let core = { ok: false, detail: '未知' };
  try {
    const entry = vendor.loadIndex().zips?.[bundle.core.version];
    if (entry) {
      const file = vendor.zipPath(bundle.core.version, entry);
      if (fs.existsSync(file)) {
        core.detail = `${file} ✓（sha256 校验见 vendor status）`;
        core.ok = true;
      } else {
        const url = vendor.downloadUrl(bundle.core.version, entry);
        const canFetch = cfg.vendor.autoDownload && !!url;
        core.ok = canFetch;
        core.level = canFetch ? 'warn' : 'fail';
        core.detail = canFetch
          ? `缺失，build/core use 时自动下载（离线请手工放置 ${file}）`
          : `缺失且无法自动下载 —— 手工放置 ${file}，或在 vendor/index.json 补 download`;
      }
    } else {
      core.ok = cfg.vendor.autoDownload;
      core.level = core.ok ? 'warn' : 'fail';
      core.detail = `core ${bundle.core.version} 未登记 —— suitectl core use ${bundle.core.version} 自动下载登记`;
    }
  } catch (e) {
    core = { ok: false, detail: e.message };
  }
  add('vendor.core', core.ok, core.detail, core.level || 'fail');

  // CDP 端口
  const [from, to] = cfg.ports.cdp;
  const port = await platform.probePort(platform.cdpPorts());
  add('ports.cdp', !!port, port
    ? `区间 ${from}-${to}，可用 ${port}`
    : `区间 ${from}-${to} 全部不可绑定 —— 在 suitectl.local.yaml 的 ports.cdp 换区间（netsh interface ipv4 show excludedportrange protocol=tcp 可查保留段）`);

  return checks;
}

function stateSummary() {
  const out = [];
  const report = fs.existsSync(P.buildReport) ? U.readJson(P.buildReport) : null;
  out.push(`build-report ${report ? report.suiteVersion : '无'}`);
  const passedPath = path.join(P.build, '.verify-passed');
  out.push(`verify-passed ${fs.existsSync(passedPath) ? U.readJson(passedPath).suiteVersion : '无'}`);
  out.push(`channel latest ${fs.existsSync(P.channel) ? (U.readJson(P.channel).latest || '空') : '无'}`);
  const devMeta = path.join(P.runtime, 'dev', 'instance.json');
  out.push(`dev 实例 ${fs.existsSync(devMeta) ? U.readJson(devMeta).vendor : '无'}`);
  return out;
}

async function envCommand(bundle, opts = {}) {
  const checks = await collect(bundle);
  const failed = checks.filter(c => !c.ok && c.level !== 'warn' && c.level !== 'info');
  const warned = checks.filter(c => !c.ok && c.level === 'warn');
  const ok = failed.length === 0;

  if (opts.json) {
    console.log(JSON.stringify({
      ok,
      root: ROOT,
      platform: cfg.platform,
      ports: cfg.ports,
      proxy: cfg.net.proxy,
      candidateVersion: candidateVersion(bundle.core.version),
      paths: { vendor: P.vendor, cache: P.cache, build: P.build, runtime: P.runtime, releases: P.releases },
      config: { config: cfg.files.config, local: cfg.files.local, env: cfg.files.env },
      checks,
      state: stateSummary(),
    }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  console.log(`[suitectl env] ${ROOT}`);
  const layers = ['内置默认值'];
  if (cfg.files.config) layers.push(path.relative(ROOT, cfg.files.config) || cfg.files.config);
  if (cfg.files.local) layers.push(path.relative(ROOT, cfg.files.local) || cfg.files.local);
  if (cfg.files.env.length) layers.push(`环境变量 ${cfg.files.env.join(', ')}`);
  console.log(`[config] ${layers.join(' ← ')}`);
  const mark = c => (c.ok ? '✓' : c.level === 'warn' ? '⚠' : c.level === 'info' ? '·' : '✗');
  for (const c of checks) console.log(`  ${mark(c)} ${c.id}  ${c.detail}`);
  console.log(`[state] ${stateSummary().join(' · ')}`);
  console.log(ok
    ? `[env] ✓ 就绪${warned.length ? `（${warned.length} 项提醒）` : ''}`
    : `[env] ✗ ${failed.length} 项未就绪 —— 按上面提示补齐后再跑 up/build`);
  if (!ok) process.exitCode = 1;
}

module.exports = { envCommand };
