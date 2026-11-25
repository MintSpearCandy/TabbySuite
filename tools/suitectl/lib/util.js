'use strict';
// suitectl 通用原语：进程封装、hash、JSON/FS 助手、版本比较。
// 路径表与环境配置在 config.js；平台相关能力（tar/curl/PowerShell/npm/进程）在 platform.js。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ROOT, P, cfg } = require('./config');

// 代理一等公民：net.proxy 配置时对所有子进程注入标准代理环境变量——
// git（libcurl 认 HTTPS_PROXY）、curl、gh 全部生效；本地回环排除（CDP 等）。
function childEnv(override) {
  if (override) return override;
  if (!cfg.net.proxy) return process.env;
  return {
    ...process.env,
    HTTPS_PROXY: cfg.net.proxy,
    HTTP_PROXY: cfg.net.proxy,
    NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1',
  };
}

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, {
    cwd: opts.cwd || ROOT,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: childEnv(opts.env),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    // spawn 本身失败（命令不存在等）——给可行动诊断而非裸 status:null
    throw new Error(`无法执行 ${file}: ${r.error.message}（PATH 中不存在？suitectl env 可预检）`);
  }
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

function sha256Str(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

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

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 点分版本比较（1.0.238 > 1.0.237 > 1.0.237-s3 的 serial 段不在此处理）
function cmpSemver(a, b) {
  const ai = String(a).split('.').map(Number), bi = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const d = (ai[i] || 0) - (bi[i] || 0);
    if (d) return d;
  }
  return 0;
}

// 套件版本（<core>-s<serial>）比较：core 段点分比较优先，serial 数值次之
function cmpSuiteVer(a, b) {
  const [ac, as] = String(a).split('-s');
  const [bc, bs] = String(b).split('-s');
  const c = cmpSemver(ac, bc);
  if (c) return c;
  return (Number(as) || 0) - (Number(bs) || 0);
}

module.exports = {
  P, run, out, git, gitOut, sha256, sha256Str, readJson, writeJson, rmrf, stamp,
  cloneTree, escapeRe, cmpSemver, cmpSuiteVer,
};
