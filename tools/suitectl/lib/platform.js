'use strict';
// 平台能力适配层 —— tar 打包/解包、curl 下载（代理一等公民）、PowerShell 进程管理、npm、CDP 端口。
// 流水线代码只调用本层语义，不直接拼 "powershell" / "cmd.exe" / "tar" / "curl"。
//
// 打包引擎（v2 决策）：系统 tar（Windows 10+/macOS 均为 bsdtar，按扩展名写 zip），
//   替代 Compress-Archive——后者会静默丢弃隐藏文件、PS5.1 下 entry 分隔符非标。
//   Linux GNU tar 不识 zip → 回退 unzip/zip CLI，suitectl env 预检报能力。
// zip 形态统一为"带顶层目录"（-C <parent> <name>）：套件 zip 解压出 tabby-suite/，插件 zip 解压出 <pkg>/。
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { cfg } = require('./config');
const U = require('./util');

const win = process.platform === 'win32';

function exeName() {
  if (!cfg.platform.exe) {
    throw new Error(
      `当前平台 ${cfg.platform.id} 未配置可执行文件名 —— 在 suitectl.local.yaml 的 platform.exe 指定（如 Tabby.exe）`
    );
  }
  return cfg.platform.exe;
}

function exePath(dir) { return path.join(dir, exeName()); }

function hasExe(dir) {
  try { return fs.existsSync(exePath(dir)); } catch { return false; }
}

function assertExe(dir, what = 'core') {
  if (!hasExe(dir)) {
    throw new Error(
      `${what} 目录未见 ${exeName()}（${dir}）—— core zip 结构异常，或 suitectl.local.yaml 的 platform.exe 与本机包不符`
    );
  }
}

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function powershell(command, opts = {}) {
  if (!cfg.platform.powershell) {
    throw new Error(
      `当前平台 ${cfg.platform.id} 未配置 PowerShell 能力（进程管理/更新器依赖它）—— 在 suitectl.local.yaml 配置 platform.powershell`
    );
  }
  return U.run(cfg.platform.powershell, ['-NoProfile', '-Command', command], opts);
}

function npm(args, opts = {}) {
  if (win && cfg.platform.npmShell) {
    return U.run(cfg.platform.npmShell, ['/d', '/s', '/c', `npm ${args.join(' ')}`], opts);
  }
  return U.run('npm', args, opts);
}

// ---- tar 能力探测（惰性缓存）----
// Windows 显式优先 System32 的 bsdtar——PATH 前部的 Git Bash GNU tar 不识 zip
const TAR_BIN = win
  ? (fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'))
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar')
  : 'tar';
let tarFlavor; // 'bsd' | 'gnu' | null
function tarFlavorProbe() {
  if (tarFlavor !== undefined) return tarFlavor;
  const r = U.run(TAR_BIN, ['--version'], { ok: true, capture: true });
  const v = ((r.stdout || '') + (r.stderr || '')).toString();
  tarFlavor = /bsdtar|libarchive/i.test(v) ? 'bsd' : (r.status === 0 ? 'gnu' : null);
  return tarFlavor;
}

// zip：<srcDir> 以其 basename 为顶层目录压入 <zipPath>（含隐藏文件；bsdtar 通配符无关）
function zipDir(srcDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.rmSync(zipPath, { force: true });
  const name = path.basename(srcDir);
  const parent = path.dirname(srcDir);
  if (tarFlavorProbe() === 'bsd') {
    U.run(TAR_BIN, ['-a', '-c', '-f', zipPath, '-C', parent, name]);
  } else {
    // GNU tar 无 zip 能力 → 回退 zip CLI（Linux）
    if (!commandPath('zip')) {
      throw new Error('本机 tar 非 bsdtar（GNU tar 不支持 zip）且未找到 zip CLI —— Windows/macOS 自带 bsdtar；Linux 请安装 libarchive 或 zip');
    }
    U.run('zip', ['-r', '-q', zipPath, name], { cwd: parent });
  }
}

function unzip(zipPath, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  if (tarFlavorProbe() === 'bsd') {
    U.run(TAR_BIN, ['-x', '-f', zipPath, '-C', dstDir]);
  } else if (commandPath('unzip')) {
    U.run('unzip', ['-q', '-o', zipPath, '-d', dstDir]);
  } else {
    throw new Error('本机 tar 非 bsdtar（GNU tar 不能解 zip）且未找到 unzip —— 安装 libarchive 或 unzip');
  }
}

// ---- 网络（curl：-x 原生代理，绕开 Node fetch 不认 HTTP_PROXY 的限制）----
function proxyArgs() {
  return cfg.net.proxy ? ['-x', cfg.net.proxy] : [];
}

// 下载到 dest（dest.part → 校验 → rename 由调用方/或在此完成）。进度走 stderr 直通。
function fetchUrl(url, dest, opts = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  fs.rmSync(tmp, { force: true });
  U.run('curl', [
    '-L', '--fail', '--retry', '3', '--connect-timeout', '20',
    '--max-time', String(opts.timeoutSec || cfg.vendor.downloadTimeoutSec),
    ...proxyArgs(), '-o', tmp, url,
  ]);
  fs.renameSync(tmp, dest);
  return dest;
}

// GET JSON（GitHub API 等）；GitHub API 必须带 UA
function getJson(url, opts = {}) {
  const args = ['-sS', ...proxyArgs()];
  if (/api\.github\.com/.test(url)) args.push('-H', 'User-Agent: suitectl (TabbySuite)');
  if (opts.timeoutSec) args.push('--max-time', String(opts.timeoutSec));
  args.push(url);
  const out = U.out('curl', args);
  try { return JSON.parse(out); } catch {
    throw new Error(`响应不是 JSON: ${url}\n${out.slice(0, 300)}`);
  }
}

// gh CLI 调用（release 上传）——代理经 util.run 的统一环境注入（HTTPS_PROXY）生效
function gh(args, opts = {}) {
  return U.run('gh', args, opts);
}

// ---- 进程管理（按可执行文件路径前缀匹配，绝不误杀其它 Tabby 实例）----
function killUnder(dir) {
  if (win) {
    if (!cfg.platform.powershell) return;
    powershell(
      `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ${psQuote(dir + path.sep + '*')} } | Stop-Process -Force`,
      { ok: true }
    );
  } else {
    U.run('sh', ['-c', `ps -eo pid=,args= | grep -F ${JSON.stringify(dir)} | grep -v grep | awk '{print $1}' | xargs -r kill`], { ok: true });
  }
}

function countUnder(dir) {
  if (win) {
    if (!cfg.platform.powershell) return 0;
    const r = U.run(cfg.platform.powershell, ['-NoProfile', '-Command',
      `@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ${psQuote(dir + path.sep + '*')} }).Count`],
    { ok: true, capture: true });
    return parseInt((r.stdout || '').toString().trim(), 10) || 0;
  }
  const r = U.run('sh', ['-c', `ps -eo args= | grep -F ${JSON.stringify(dir)} | grep -v grep | wc -l`], { ok: true, capture: true });
  return parseInt((r.stdout || '').toString().trim(), 10) || 0;
}

function launchDetached(dir, args = []) {
  const child = spawn(exePath(dir), args, { cwd: dir, detached: true, stdio: 'ignore' });
  child.on('error', () => { /* 已由调用方的就绪探测兜底 */ });
  child.unref(); // 长驻：CLI 退出后实例继续运行
  return child;
}

function commandPath(cmd) {
  const r = win
    ? U.run('cmd.exe', ['/d', '/s', '/c', `where ${cmd}`], { ok: true, capture: true })
    : U.run('sh', ['-c', `command -v ${cmd}`], { ok: true, capture: true });
  const out = (r.stdout || '').toString().trim();
  return r.status === 0 && out ? out.split(/\r?\n/)[0] : null;
}

function cdpPorts() {
  const [a, b] = cfg.ports.cdp;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function probePort(cands) {
  return new Promise(resolve => {
    const tryNext = i => {
      if (i >= cands.length) return resolve(null);
      const s = net.createServer();
      s.once('error', () => tryNext(i + 1));
      s.listen(cands[i], '127.0.0.1', () => s.close(() => resolve(cands[i])));
    };
    tryNext(0);
  });
}

module.exports = {
  win, exeName, exePath, hasExe, assertExe, psQuote,
  powershell, npm, zipDir, unzip, tarFlavorProbe,
  fetchUrl, getJson, gh, proxyArgs,
  killUnder, countUnder, launchDetached,
  commandPath, cdpPorts, probePort,
};
