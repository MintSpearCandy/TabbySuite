'use strict';
// 环境配置层 —— 把"在哪构建/在哪跑、用哪个平台工具、走哪个代理"从代码与本机假设里抽出来。
//
// 分层覆盖（后者覆盖前者）：
//   1. 代码默认值（本文件 DEFAULTS）
//   2. <repo>/suitectl.config.yaml   —— 可选，随仓库共享的环境默认值（跨机通用，避免放本机绝对路径）
//   3. <repo>/suitectl.local.yaml    —— 本机覆盖，gitignore 不入库（端口/目录/代理等本机事实）
//   4. TABBYSUITE_* 环境变量          —— 临时/CI 覆盖
//
// 与 bundle.yaml 的分工：bundle.yaml 是"构建什么"（内容配置，随套件发布走）；
// 本层是"本机怎么跑"（环境配置，不随套件分发）。两者不互相污染。
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const PLATFORM_EXE = {
  win32: 'Tabby.exe',
  darwin: 'Tabby.app/Contents/MacOS/Tabby',
  linux: 'tabby',
};

const DEFAULTS = {
  paths: {
    // core zip 存放目录（可指向仓库外的机器目录；vendor/index.json 仍固定在仓库内）
    vendor: 'vendor',
    cache: 'cache',
    build: 'build',
    runtime: 'runtime',
    releases: 'releases',
  },
  platform: {
    // 可执行文件名（相对 core / 实例根）。默认按当前系统推断；非默认包可覆盖。
    exe: null,
    // 进程管理（按路径杀/数进程）在 Windows 依赖 PowerShell；非 Windows 用 ps。
    powershell: process.platform === 'win32' ? 'powershell.exe' : null,
    // Windows 上 npm 是 .cmd，需经 cmd.exe 调用
    npmShell: process.platform === 'win32' ? 'cmd.exe' : null,
  },
  ports: {
    // CDP 调试端口候选区间 [start, end]；Windows 保留段因机而异，冲突时只改这里
    cdp: [9241, 9268],
  },
  net: {
    // 外网（GitHub API / core zip / channel / gh）代理；null=直连。
    // 本机常驻代理写 suitectl.local.yaml（net.proxy: http://127.0.0.1:7892），
    // 临时切换用环境变量 TABBYSUITE_PROXY（空串=强制直连）。
    proxy: null,
  },
  dist: {
    // 分发托管仓（GitHub <owner>/<repo>）：release 上传目标 + 更新器 channel 直链推导
    repo: 'MintSpearCandy/TabbySuite',
  },
  vendor: {
    // core zip 缺失时按 vendor/index.json 的 origin 自动下载（sha256 校验）
    autoDownload: true,
    downloadTimeoutSec: 15 * 60,
  },
};

const ENV_PATHS = {
  TABBYSUITE_VENDOR: 'vendor',
  TABBYSUITE_CACHE: 'cache',
  TABBYSUITE_BUILD: 'build',
  TABBYSUITE_RUNTIME: 'runtime',
  TABBYSUITE_RELEASES: 'releases',
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function readYaml(file) {
  if (!fs.existsSync(file)) return null;
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`环境配置文件不是合法 YAML: ${file}\n  ${e.message}`);
  }
  if (doc == null) return {};
  if (!isObj(doc)) throw new Error(`环境配置文件顶层必须是映射: ${file}`);
  return doc;
}

// 只支持 "<起>-<止>" 区间（或单端口）；逗号列表语义易歧义，不再提供
function parseRange(raw, label) {
  const s = String(raw).trim();
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(s);
  if (!m) throw new Error(`无法解析 ${label}: ${raw}（期望 "9241-9268" 或 "9241"）`);
  const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
  return [a, b];
}

function resolvePath(p) {
  const v = String(p);
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(ROOT, v);
}

// ---- 装配 ----
const configPath = path.isAbsolute(process.env.TABBYSUITE_CONFIG || '')
  ? process.env.TABBYSUITE_CONFIG
  : path.join(ROOT, process.env.TABBYSUITE_CONFIG || 'suitectl.config.yaml');
const localPath = path.isAbsolute(process.env.TABBYSUITE_LOCAL_CONFIG || '')
  ? process.env.TABBYSUITE_LOCAL_CONFIG
  : path.join(ROOT, process.env.TABBYSUITE_LOCAL_CONFIG || 'suitectl.local.yaml');

const files = { config: null, local: null, env: [] };
let cfg = merge({}, DEFAULTS);

const shared = readYaml(configPath);
if (shared) { cfg = merge(cfg, shared); files.config = configPath; }
const local = fs.existsSync(localPath) ? readYaml(localPath) : null;
if (local) { cfg = merge(cfg, local); files.local = localPath; }

for (const [envName, key] of Object.entries(ENV_PATHS)) {
  if (process.env[envName]) {
    cfg.paths = { ...cfg.paths, [key]: process.env[envName] };
    files.env.push(envName);
  }
}
if (process.env.TABBYSUITE_CDP_RANGE) {
  cfg.ports = { ...cfg.ports, cdp: parseRange(process.env.TABBYSUITE_CDP_RANGE, 'TABBYSUITE_CDP_RANGE') };
  files.env.push('TABBYSUITE_CDP_RANGE');
}
for (const [envName, apply] of [
  ['TABBYSUITE_EXE', v => { cfg.platform = { ...cfg.platform, exe: v }; }],
  ['TABBYSUITE_POWERSHELL', v => { cfg.platform = { ...cfg.platform, powershell: v }; }],
  ['TABBYSUITE_NPM_SHELL', v => { cfg.platform = { ...cfg.platform, npmShell: v }; }],
  ['TABBYSUITE_PROXY', v => { cfg.net = { ...cfg.net, proxy: v || null }; }],
  ['TABBYSUITE_REPO', v => { cfg.dist = { ...cfg.dist, repo: v }; }],
  ['TABBYSUITE_OFFLINE', v => { cfg.vendor = { ...cfg.vendor, autoDownload: !/^(1|true|yes)$/i.test(v) }; }],
  ['TABBYSUITE_DOWNLOAD_TIMEOUT_SEC', v => { cfg.vendor = { ...cfg.vendor, downloadTimeoutSec: Number(v) }; }],
]) {
  if (process.env[envName] !== undefined) {
    apply(process.env[envName]);
    files.env.push(envName);
  }
}

// ---- 校验 + 归一化 ----
for (const k of Object.keys(DEFAULTS.paths)) {
  if (typeof cfg.paths[k] !== 'string' || !cfg.paths[k].trim()) {
    throw new Error(`环境配置 paths.${k} 必须是非空字符串（suitectl.config.yaml / suitectl.local.yaml）`);
  }
}
const cdp = cfg.ports?.cdp;
if (!Array.isArray(cdp) || cdp.length !== 2 || !cdp.every(n => Number.isInteger(n) && n > 0 && n < 65536) || cdp[0] > cdp[1]) {
  throw new Error(`环境配置 ports.cdp 必须是 [起始端口, 结束端口]（当前 ${JSON.stringify(cdp)}）`);
}
if (cfg.net.proxy && !/^(https?|socks5h?):\/\//i.test(String(cfg.net.proxy))) {
  throw new Error(`环境配置 net.proxy 需形如 http://127.0.0.1:7892（当前 ${JSON.stringify(cfg.net.proxy)}）`);
}
if (!Number.isInteger(cfg.vendor.downloadTimeoutSec) || cfg.vendor.downloadTimeoutSec <= 0) {
  throw new Error('环境配置 vendor.downloadTimeoutSec 必须是正整数');
}

cfg.platform = {
  ...cfg.platform,
  exe: cfg.platform.exe || PLATFORM_EXE[process.platform] || null,
  id: `${process.platform}-${process.arch}`,
};
cfg.files = files;
cfg.root = ROOT;

const P = {
  root: ROOT,
  bundle: path.join(ROOT, 'bundle.yaml'),
  components: path.join(ROOT, 'components'),
  profiles: path.join(ROOT, 'profiles'),
  suiteTools: path.join(ROOT, 'suite-tools'),
  vendor: resolvePath(cfg.paths.vendor),
  vendorIndex: path.join(ROOT, 'vendor', 'index.json'),
  cacheRoot: resolvePath(cfg.paths.cache),
  cache: path.join(resolvePath(cfg.paths.cache), 'plugins'),
  build: resolvePath(cfg.paths.build),
  stage: path.join(resolvePath(cfg.paths.build), 'stage'),
  buildReport: path.join(resolvePath(cfg.paths.build), 'build-report.json'),
  runtime: resolvePath(cfg.paths.runtime),
  releases: resolvePath(cfg.paths.releases),
  channel: path.join(resolvePath(cfg.paths.releases), 'update-channel.json'),
  configFile: configPath,
  localConfigFile: localPath,
};

module.exports = { ROOT, cfg, P, DEFAULTS };
