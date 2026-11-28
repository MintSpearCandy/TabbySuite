#!/usr/bin/env node
'use strict';
// suitectl —— TabbySuite 集成发布 CLI v4（纯集成仓：插件开发在各插件独立仓，本仓只管 集成→验证→发布）
// 架构：套件 = 平台组件（Tabby core，版本可切换）+ 插件组件（components/ 子仓）+ profile 种子。
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
const { P } = U;
const build = require('./lib/build');
const release = require('./lib/release');
const sync = require('./lib/sync');
const verify = require('./lib/verify');
const env = require('./lib/env');
const platform = require('./lib/platform');
const components = require('./lib/components');
const up = require('./lib/up');

const HELP = `suitectl — TabbySuite 集成发布 CLI v4（架构见 ARCHITECTURE.md）

用法: node tools/suitectl/cli.js <命令> [flags]

── 日常（就两条）──
  up [--offline]     sync 子仓最新 + 平台查新(pin:auto 自动前进) + build + verify
  release            门禁 → 出包(tar) → 自动钉定 commit+tag → 上传 GH Releases
                     flags: --no-upload --no-verify --no-tag --no-git --allow-dirty --no-remote-check
  发布后: git push origin main --tags（子仓必须已 push——release 门禁已机器检查）

── 平台组件（Tabby core，版本可切换）──
  platform list      登记与缓存总览（platform/index.json + zip 就绪状态；标当前构建）
  platform latest    查 Tabby 官方最新版（GitHub API）
  platform use <v>|latest  前进平台（下载+sha256+登记+改 bundle+重钉源码参考）
  platform fetch [v] [--force]   仅获取 zip
  platform ref       按需检出核心源码参考（platform/reference/tabby @v<版本>，非子仓）

── 细粒度（up 的内部步骤，按需单独调用）──
  sync               各子仓拉远端最新（分支安全：只快进 .gitmodules 分支上的干净检出）
  build [--offline]  平台校验/获取 + 组件构建（含各自 test/smoke 单测）+ assemble
  verify             隔离实例四级断言（全载/无致命错/CDP 探针/回归挂钩）→ .verify-passed
  component ls       components/ 收编状态一览（角色/commit/脏否）

── 环境（换机/新克隆先跑）──
  env                本机预检（node/git/子仓/tar/curl/gh/代理/目录/端口；--json 供脚本）

目标机更新（安装目录内自带）: suite-tools/suitectl.ps1 check|apply|rollback|doctor [-Proxy http://…]

环境配置（本机怎么跑）: 默认值 ← suitectl.config.yaml（共享）← suitectl.local.yaml（本机，gitignore）
                        ← TABBYSUITE_*（路径/端口/代理/宿主工具可覆盖；内容配置仍只看 bundle.yaml）
代理: net.proxy（local.yaml）或 TABBYSUITE_PROXY=http://127.0.0.1:7892（空串=强制直连）
原则: 全浮动·发布即锁 · 绿了才能出包 · 每个边界有 hash`;

function loadBundle() {
  const b = yaml.load(fs.readFileSync(P.bundle, 'utf8'));
  if (!b?.suite?.name || !b.platform?.version || !Array.isArray(b.integrate)) {
    throw new Error('bundle.yaml 不完整（需 suite.name、platform.version、integrate 列表；serial 已废除——由 channel 派生）');
  }
  return b;
}

function parseArgs(rest) {
  const opts = { flags: {}, positional: [] };
  for (const a of rest) {
    if (a.startsWith('--')) { opts.flags[a.slice(2)] = true; continue; }
    opts.positional.push(a);
  }
  return opts;
}

async function main() {
  const [,, cmd, ...rest] = process.argv;
  const { flags, positional } = parseArgs(rest);
  const opts = {
    allowDirty: !!flags['allow-dirty'],
    noTag: !!flags['no-tag'],
    noGit: !!flags['no-git'],
    noVerify: !!flags['no-verify'],
    noRemoteCheck: !!flags['no-remote-check'],
    noUpload: !!flags['no-upload'],
    json: !!flags.json,
    offline: !!flags.offline,
    force: !!flags.force,
  };
  switch (cmd) {
    case undefined: case '-h': case '--help': case 'help':
      console.log(HELP); break;
    case 'env':
      await env.envCommand(loadBundle(), opts); break;
    case 'up':
      await up.upCommand(loadBundle(), opts); break;
    case 'sync':
      sync.syncCommand(loadBundle()); break;
    case 'platform':
      await platform.platformCommand(loadBundle(), positional, opts); break;
    case 'component': {
      const sub = positional[0];
      if (sub === 'ls') components.lsCommand(loadBundle());
      else throw new Error('component 子命令: ls（收编状态一览）');
      break;
    }
    case 'build': await build.buildCommand(loadBundle(), opts); break;
    case 'verify': await verify.verifyCommand(loadBundle()); break;
    case 'release': release.releaseCommand(loadBundle(), opts); break;
    default:
      throw new Error(`未知命令: ${cmd}\n\n${HELP}`);
  }
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
