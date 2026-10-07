#!/usr/bin/env node
'use strict';
// suitectl —— TabbySuite 集成流水线 CLI（架构与规则见 ARCHITECTURE.md）
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
const dev = require('./lib/dev');

const HELP = `suitectl — TabbySuite 集成流水线（架构见 ARCHITECTURE.md）

用法: node tools/suitectl/cli.js <命令> [flags]

── 开发轨道（脏树允许 · 长驻实例 · 永不产出 releases）──
  dev up          从 stage 重建长驻开发实例（runtime/dev/，core 硬链）并启动
  dev deploy [组件…]  单插件构建+直拷进实例（默认全部脏组件，秒级）；--restart 顺带重启
  dev restart | down | status   重启（保端口）/ 停止 / 实例·CDP·插件清单
── 构建轨道（钉定 · 干净 · 门禁）──
  sync      各子仓拉远端最新（分支安全：只快进 .gitmodules 声明分支上的干净检出）
  build     core 校验 + 组件构建（含各自 test/smoke 单测）+ assemble（core 解包缓存，硬链复用）
  verify    隔离实例四级断言（全载/无致命错/CDP 探针/回归挂钩）→ build/.verify-passed
  release   zip + SHA256SUMS + channel + CHANGELOG + 父仓 tag；门禁：verify 绿 +
            gitlink 远端可解析（先子仓后父仓的机器守门）；脏子仓拒绝（--allow-dirty 放行）
  update    [P3] 目标机更新（--check / --apply / --rollback；随包精简版见 suite-tools/suitectl.ps1）
  doctor    [P3] 安装态完整性核对

原则: 父仓 commit/tag 即锁 · 开发与构建分离 · 干净才能发布 · 绿了才能出包 · 每个边界有 hash`;

function loadBundle() {
  const b = yaml.load(fs.readFileSync(P.bundle, 'utf8'));
  if (!b?.suite?.name || b.suite.serial == null || !b.core?.version || !Array.isArray(b.integrate)) {
    throw new Error('bundle.yaml 不完整（需 suite.name/serial、core.version、integrate 列表）');
  }
  return b;
}

async function main() {
  const [,, cmd, ...rest] = process.argv;
  const opts = {
    allowDirty: rest.includes('--allow-dirty'),
    noTag: rest.includes('--no-tag'),
    noVerify: rest.includes('--no-verify'),
    noRemoteCheck: rest.includes('--no-remote-check'),
    restart: rest.includes('--restart'),
  };
  const args = rest.filter(a => !a.startsWith('--')); // 位置参数（如 dev deploy 的组件名）
  switch (cmd) {
    case undefined: case '-h': case '--help': case 'help':
      console.log(HELP); break;
    case 'dev': {
      const sub = args[0];
      const subArgs = args.slice(1);
      if (sub === 'up' || sub === 'reset') await dev.devUp(loadBundle());
      else if (sub === 'deploy') await dev.devDeploy(loadBundle(), subArgs, opts);
      else if (sub === 'restart') await dev.devRestart();
      else if (sub === 'down') await dev.devDown();
      else if (sub === 'status') await dev.devStatus();
      else throw new Error('dev 子命令: up | deploy [组件…] [--restart] | restart | down | status');
      break;
    }
    case 'sync': sync.syncCommand(loadBundle()); break;
    case 'build': build.buildCommand(loadBundle()); break;
    case 'verify': await verify.verifyCommand(loadBundle()); break;
    case 'release': release.releaseCommand(loadBundle(), opts); break;
    case 'update':
      throw new Error('update 为 P3 里程碑（目标机可用 suite-tools/suitectl.ps1 info 查看安装态）');
    case 'doctor':
      throw new Error('doctor 为 P3 里程碑');
    default:
      throw new Error(`未知命令: ${cmd}\n\n${HELP}`);
  }
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
