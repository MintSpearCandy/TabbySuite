'use strict';
// suitectl 通用原语：路径表、进程封装、hash、JSON/FS 助手
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const P = {
  root: ROOT,
  bundle: path.join(ROOT, 'bundle.yaml'),
  components: path.join(ROOT, 'components'),
  profiles: path.join(ROOT, 'profiles'),
  vendor: path.join(ROOT, 'vendor'),
  vendorIndex: path.join(ROOT, 'vendor', 'index.json'),
  cache: path.join(ROOT, 'cache', 'plugins'),
  build: path.join(ROOT, 'build'),
  stage: path.join(ROOT, 'build', 'stage'),
  buildReport: path.join(ROOT, 'build', 'build-report.json'),
  runtime: path.join(ROOT, 'runtime'),
  releases: path.join(ROOT, 'releases'),
  channel: path.join(ROOT, 'releases', 'update-channel.json'),
};

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, {
    cwd: opts.cwd || ROOT,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: opts.env || process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !opts.ok) {
    const err = (r.stderr && r.stderr.toString()) || '';
    throw new Error(`命令失败(${r.status}): ${file} ${args.join(' ')}\n${err.trim()}`);
  }
  return r;
}

function out(file, args, opts = {}) {
  const r = run(file, args, { ...opts, capture: true });
  return (r.stdout || '').toString().trim();
}

// Windows 上 npm 是 .cmd，不能直接 spawn
function npm(args, opts = {}) {
  if (process.platform === 'win32') return run('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], opts);
  return run('npm', args, opts);
}

function ps(command, opts = {}) { return run('powershell', ['-NoProfile', '-Command', command], opts); }
function git(args, opts = {}) { return run('git', args, opts); }
function gitOut(args, opts = {}) { return out('git', args, opts); }

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
}
// Windows 现实加固：CWD 句柄/杀毒扫描会造成瞬时 EPERM/EBUSY/ENOTEMPTY——退避重试，
// 最终失败给出可行动诊断（而非裸 code）
function rmrf (p) {
  for (let i = 1; ; i++) {
    try { fs.rmSync(p, { recursive: true, force: true }); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(e.code) || i >= 5) {
        throw new Error(`无法删除 ${p}（${e.code}）—— 目录被占用：检查是否有终端/资源管理器停在该目录、Tabby 是否从中运行、或杀毒软件瞬时扫描，排除后重试`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * i); // 同步退避
    }
  }
}
function stamp() { return new Date().toISOString(); }

// 同卷树克隆：优先硬链接（零拷贝省盘），失败退化为复制。
// ⚠ 铁律：硬链共享 inode 与文件锁——只用于"永不被执行/写入"的树（core-cache → stage）；
//   会被执行的副本（dev 实例、verify 实例）必须 fs.cpSync 实拷。
function cloneTree (src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cloneTree(s, d);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else { try { fs.linkSync(s, d); } catch { fs.copyFileSync(s, d); } }
  }
}

module.exports = { P, run, out, npm, ps, git, gitOut, sha256, readJson, writeJson, rmrf, stamp, cloneTree };
