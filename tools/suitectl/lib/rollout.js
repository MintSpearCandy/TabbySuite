'use strict';
// rollout：滚动更新入口（无人值守友好）—— 与 up 的分工：
//   up = 人工回路，每次必 build+verify（交互确认全绿再决定是否 release）；
//   rollout = 调度回路（计划任务/cron），幂等：sync + core 查新之后，
//     集成输入无变化（core 无新版且子仓无前进）→ 零动作退出（exit 0，调度器友好）；
//     有变化（或 --force）→ build + verify →（--release）转发布，门禁链原样生效。
// 变化判定不靠猜：sync 返回子仓拉动摘要、ensureLatestCore 返回 core 是否前进。
const sync = require('./sync');
const core = require('./core');
const build = require('./build');
const verify = require('./verify');
const release = require('./release');

async function rolloutCommand(bundle, opts = {}) {
  console.log('[rollout] ① 同步子仓远端最新');
  const s = sync.syncCommand(bundle);
  console.log('\n[rollout] ② core 查新');
  const c = await core.ensureLatestCore(bundle, opts);

  const why = [
    c.advanced && `core → ${c.version}`,
    s.advanced.length > 0 && `子仓前进 ×${s.advanced.length}（${s.advanced.join(', ')}）`,
    opts.force && '强制',
  ].filter(Boolean);
  if (!why.length) {
    console.log(`\n[rollout] 无变化（core ${bundle.core.version} 已最新、子仓无前进）—— 零动作退出`);
    return { rolled: false };
  }
  console.log(`\n[rollout] ③ 滚动构建（${why.join('，')}）`);
  await build.buildCommand(bundle, opts);
  console.log('\n[rollout] ④ 门禁验证');
  await verify.verifyCommand(bundle);
  if (opts.release) {
    console.log('\n[rollout] ⑤ 发布（门禁链见 release；脏子仓/verify 红会在此拒绝）');
    release.releaseCommand(bundle, opts);
    console.log('\n[rollout] ✓ 已发布 —— 待人工 git push origin main --tags（子仓已由门禁确认推送，先子仓后父仓）');
  } else {
    console.log('\n[rollout] ✓ 滚动完成 —— suitectl release 出包（发布即锁）');
  }
  return { rolled: true };
}

module.exports = { rolloutCommand };
