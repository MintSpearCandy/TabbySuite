#!/usr/bin/env node
'use strict';
// suitectl —— TabbySuite 集成流水线 CLI（架构与规则见 ARCHITECTURE.md）
const fs = require('fs');
const yaml = require('js-yaml');
const U = require('./lib/util');
const { P } = U;
const build = require('./lib/build');
const release = require('./lib/release');
const sync = require('./lib/sync');

const HELP = `suitectl — TabbySuite 集成流水线（架构见 ARCHITECTURE.md）

用法: node tools/suitectl/cli.js <命令> [flags]

  sync      各子仓拉远端最新（脏仓自动跳过）；前进后需父仓 commit gitlink 完成钉版
  build     core zip 校验 + 全部 integrate 组件构建（按 commit 缓存）+ assemble 到 build/stage/
  verify    [P2] 隔离实例三级断言（P1 手动验收：复制 build/stage/tabby-suite 到独立目录启动核对日志）
  release   出包：zip + SHA256SUMS + update-channel + CHANGELOG + 父仓 tag（--allow-dirty / --no-tag）
  update    [P3] 目标机更新（--check / --apply / --rollback；随包精简版见 suite-tools/suitectl.ps1）
  doctor    [P3] 安装态完整性核对（suite.json hash vs 实文件）

原则: 父仓 commit/tag 即锁 · 干净才能发布 · 绿了才能出包(P2 起) · 每个边界有 hash`;

function loadBundle() {
  const b = yaml.load(fs.readFileSync(P.bundle, 'utf8'));
  if (!b?.suite?.name || b.suite.serial == null || !b.core?.version || !Array.isArray(b.integrate)) {
    throw new Error('bundle.yaml 不完整（需 suite.name/serial、core.version、integrate 列表）');
  }
  return b;
}

function main() {
  const [,, cmd, ...rest] = process.argv;
  const opts = { allowDirty: rest.includes('--allow-dirty'), noTag: rest.includes('--no-tag') };
  switch (cmd) {
    case undefined: case '-h': case '--help': case 'help':
      console.log(HELP); break;
    case 'sync': sync.syncCommand(loadBundle()); break;
    case 'build': build.buildCommand(loadBundle()); break;
    case 'verify':
      throw new Error('verify 为 P2 里程碑 —— P1 手动验收：复制 build/stage/tabby-suite 到独立目录启动，核对日志插件全载（6/6）');
    case 'release': release.releaseCommand(loadBundle(), opts); break;
    case 'update':
      throw new Error('update 为 P3 里程碑（目标机可用 suite-tools/suitectl.ps1 info 查看安装态）');
    case 'doctor':
      throw new Error('doctor 为 P3 里程碑');
    default:
      throw new Error(`未知命令: ${cmd}\n\n${HELP}`);
  }
}

try { main(); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
