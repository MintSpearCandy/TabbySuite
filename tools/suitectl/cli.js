#!/usr/bin/env node
'use strict';
// suitectl —— TabbySuite 集成流水线 CLI v2（架构与规则见 ARCHITECTURE.md）
// 版本纪律：全浮动·发布即锁 —— up 一键拉最新并构建（零日常 commit）；release 自动钉定 gitlink+tag。
const fs = require('fs');
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('✗ 缺少依赖 js-yaml —— 全新克隆请先执行一次: cd tools/suitectl && npm install');
  process.exit(1);
}
const U = require('./lib/util');
const { P, cfg } = U;
const build = require('./lib/build');
const release = require('./lib/release');
const sync = require('./lib/sync');
const verify = require('./lib/verify');
const dev = require('./lib/dev');
const env = require('./lib/env');
const vendor = require('./lib/vendor');
const core = require('./lib/core');
const up = require('./lib/up');
const rollout = require('./lib/rollout');
const update = require('./lib/update');

const HELP = `suitectl — TabbySuite 集成流水线 v2（架构见 ARCHITECTURE.md）

用法: node tools/suitectl/cli.js <命令> [flags]

── 日常一键（拉下即可构建）──
  up [--offline]     sync 子仓最新 + core 查新(pin:auto 自动前进) + build + verify
  rollout [--release] [--force]   滚动更新（幂等，适合计划任务/cron）：core 无新版且子仓无前进 →
                    零动作退出；有变化才 build+verify；--release 连带发布（门禁链不变）
  sync               各子仓拉远端最新（分支安全：只快进 .gitmodules 分支上的干净检出）
  core latest        查 Tabby 官方最新版（GitHub API）
  core use <v>|latest  前进 core（下载+sha256+登记+改 bundle+重钉 reference/tabby）

── 构建轨道（浮动检出态 · 门禁 · 发布即锁）──
  build [--offline]  core 校验/获取 + 组件构建（含各自 test/smoke 单测）+ assemble
  verify             隔离实例四级断言（全载/无致命错/CDP 探针/回归挂钩）→ .verify-passed（绑定 stage 树 hash）
  release            门禁 → 出包(tar) → 自动钉定 commit+tag → 上传 GH Releases
                     flags: --no-upload --no-verify --no-tag --no-git --allow-dirty --no-remote-check

── 开发轨道（脏树允许 · 长驻实例 · 永不产出 releases）──
  dev up | deploy [组件…] [--restart] | restart | down | status

── 目标机更新（转调 suite-tools/suitectl.ps1，单一实现）──
  update --dest <dir> [--check|--apply|--rollback]   默认 --check
  doctor --dest <dir>                                安装态完整性核对（树 hash）

── 环境（换机/新克隆先跑）──
  env                本机预检（node/git/子仓/tar/curl/gh/代理/目录/端口；--json 供脚本）
  vendor status | fetch [版本] [--force]

环境配置（本机怎么跑）: 默认值 ← suitectl.config.yaml（共享）← suitectl.local.yaml（本机，gitignore）
                        ← TABBYSUITE_*（路径/端口/代理/平台工具可覆盖；内容配置仍只看 bundle.yaml）
代理: net.proxy（local.yaml）或 TABBYSUITE_PROXY=http://127.0.0.1:7892（空串=强制直连）
原则: 全浮动·发布即锁 · 开发与构建分离 · 绿了才能出包 · 每个边界有 hash`;

function loadBundle() {
  const b = yaml.load(fs.readFileSync(P.bundle, 'utf8'));
  if (!b?.suite?.name || !b.core?.version || !Array.isArray(b.integrate)) {
    throw new Error('bundle.yaml 不完整（需 suite.name、core.version、integrate 列表；serial 已废除——由 channel 派生）');
  }
  return b;
}

// flags 与带值参数（--dest <dir>）分离
function parseArgs(rest) {
  const opts = { flags: {}, values: {}, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dest') { opts.values.dest = rest[++i]; continue; }
    if (a.startsWith('--')) { opts.flags[a.slice(2)] = true; continue; }
    opts.positional.push(a);
  }
  return opts;
}

async function main() {
  const [,, cmd, ...rest] = process.argv;
  const { flags, values, positional } = parseArgs(rest);
  const opts = {
    allowDirty: !!flags['allow-dirty'],
    noTag: !!flags['no-tag'],
    noGit: !!flags['no-git'],
    noVerify: !!flags['no-verify'],
    noRemoteCheck: !!flags['no-remote-check'],
    noUpload: !!flags['no-upload'],
    restart: !!flags.restart,
    json: !!flags.json,
    offline: !!flags.offline,
    force: !!flags.force,
    release: !!flags.release,
    dest: values.dest,
    mode: flags.apply ? 'apply' : flags.rollback ? 'rollback' : 'check',
  };
  switch (cmd) {
    case undefined: case '-h': case '--help': case 'help':
      console.log(HELP); break;
    case 'env':
      await env.envCommand(loadBundle(), opts); break;
    case 'up':
      await up.upCommand(loadBundle(), opts); break;
    case 'rollout':
      await rollout.rolloutCommand(loadBundle(), opts); break;
    case 'sync':
      sync.syncCommand(loadBundle()); break;
    case 'core':
      await core.coreCommand(loadBundle(), positional, opts); break;
    case 'vendor': {
      const sub = positional[0];
      if (sub === 'status') vendor.statusCommand();
      else if (sub === 'fetch') await vendor.fetchCommand(positional[1] || loadBundle().core.version, opts);
      else throw new Error('vendor 子命令: status | fetch [版本] [--force]');
      break;
    }
    case 'dev': {
      const sub = positional[0];
      const subArgs = positional.slice(1);
      if (sub === 'up' || sub === 'reset') await dev.devUp(loadBundle());
      else if (sub === 'deploy') await dev.devDeploy(loadBundle(), subArgs, opts);
      else if (sub === 'restart') await dev.devRestart();
      else if (sub === 'down') await dev.devDown();
      else if (sub === 'status') await dev.devStatus();
      else throw new Error('dev 子命令: up | deploy [组件…] [--restart] | restart | down | status');
      break;
    }
    case 'build': await build.buildCommand(loadBundle(), opts); break;
    case 'verify': await verify.verifyCommand(loadBundle()); break;
    case 'release': release.releaseCommand(loadBundle(), opts); break;
    case 'update':
      if (!opts.dest) throw new Error('用法: update --dest <安装目录> [--check|--apply|--rollback]');
      update.runPs1('update', opts); break;
    case 'doctor':
      if (!opts.dest) throw new Error('用法: doctor --dest <安装目录>');
      update.runPs1('doctor', opts); break;
    default:
      throw new Error(`未知命令: ${cmd}\n\n${HELP}`);
  }
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
