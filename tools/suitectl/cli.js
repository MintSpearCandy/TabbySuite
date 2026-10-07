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

const HELP = `suitectl — TabbySuite 集成流水线（架构见 ARCHITECTURE.md）

用法: node tools/suitectl/cli.js <命令> [flags]

  sync      各子仓拉远端最新（脏仓自动跳过）；前进后需父仓 commit gitlink 完成钉版
  build     core zip 校验 + 全部 integrate 组件构建（按 commit 缓存）+ assemble 到 build/stage/
  verify    隔离实例四级断言：①插件全载(renderer Loading 行) ②无致命 ERROR ③CDP 探针 ④回归挂钩
            通过即写 build/.verify-passed（release 门禁）；失败保留现场于 runtime/
  release   出包：zip + SHA256SUMS + update-channel + CHANGELOG(抽取各仓 changelog) + 父仓 tag
            前置：verify 绿（--no-verify 跳过）；脏子仓拒绝（--allow-dirty 放行）；--no-tag 跳过 tag
  update    [P3] 目标机更新（--check / --apply / --rollback；随包精简版见 suite-tools/suitectl.ps1）
  doctor    [P3] 安装态完整性核对（suite.json hash vs 实文件）

原则: 父仓 commit/tag 即锁 · 干净才能发布 · 绿了才能出包 · 每个边界有 hash`;

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
  };
  switch (cmd) {
    case undefined: case '-h': case '--help': case 'help':
      console.log(HELP); break;
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
