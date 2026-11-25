'use strict';
// up：一键回路 —— sync 子仓最新 → core 查新（pin:auto 时自动前进）→ build → verify。
// "拉下即可构建"的日常入口；浮动检出态直接构建，无需任何 git commit（发布即锁：钉定发生在 release）。
const U = require('./util');
const sync = require('./sync');
const core = require('./core');
const build = require('./build');
const verify = require('./verify');

async function upCommand(bundle, opts = {}) {
  console.log('[up] ① 同步子仓远端最新');
  sync.syncCommand(bundle);
  console.log('\n[up] ② core 查新');
  await core.ensureLatestCore(bundle, opts);
  console.log('\n[up] ③ 构建');
  await build.buildCommand(bundle, opts);
  console.log('\n[up] ④ 门禁验证');
  await verify.verifyCommand(bundle);
  console.log('\n[up] ✓ 全绿 —— suitectl release 出包（发布即锁：自动钉定 + tag + 上传）');
}

module.exports = { upCommand };
