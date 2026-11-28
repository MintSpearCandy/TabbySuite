'use strict';
// sync：各 integrate 子仓拉远端最新 —— 分支安全版
// 只快进"在 .gitmodules 声明分支上的干净检出"；其它检出（feature 分支/游离 tag/脏树）一律跳过并说明，
// 杜绝静默挪走本地检出的隐患。gitlink 漂移是浮动常态，release 时统一钉定。
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { P } = U;

// 返回变化摘要 { advanced, unchanged, skipped, failed }（up 编排与人工判断"这次拉到了什么"用）。
function syncCommand (bundle) {
  const summary = { advanced: [], unchanged: [], skipped: [], failed: [] };
  for (const dir of bundle.integrate) {
    const cwd = path.join(P.components, dir);
    const branch = U.out('git', ['-C', cwd, 'config', '-f', `${P.root}/.gitmodules`, `submodule.components/${dir}.branch`], { ok: true }) || 'main';
    const dirty = U.gitOut(['-C', cwd, 'status', '--porcelain'], { ok: true }) !== '';
    const before = U.gitOut(['-C', cwd, 'rev-parse', 'HEAD']);
    const onBranch = U.gitOut(['-C', cwd, 'symbolic-ref', '--short', '-q', 'HEAD'], { ok: true });

    if (dirty) { console.log(`  [跳过] ${dir} —— 脏工作树（开发中？），先 commit/stash`); summary.skipped.push(dir); continue; }
    if (onBranch && onBranch !== branch) {
      console.log(`  [跳过] ${dir} —— 检出在分支 ${onBranch}（sync 只快进 ${branch} 检出）`); summary.skipped.push(dir); continue;
    }
    try {
      U.git(['-C', cwd, 'fetch', 'origin', branch]);
      if (onBranch === branch) {
        U.git(['-C', cwd, 'merge', '--ff-only', `origin/${branch}`]);
      } else {
        U.git(['-C', cwd, 'checkout', '--detach', `origin/${branch}`]);
      }
    } catch (e) {
      console.log(`  [失败] ${dir}: ${String(e.message).split('\n')[0]}`);
      summary.failed.push(dir);
      continue;
    }
    const after = U.gitOut(['-C', cwd, 'rev-parse', 'HEAD']);
    if (before === after) { console.log(`  [无变化] ${dir} @${after.slice(0, 8)}`); summary.unchanged.push(dir); }
    else { console.log(`  [前进] ${dir} ${before.slice(0, 8)} → ${after.slice(0, 8)}   钉版: git add components/${dir} && git commit`); summary.advanced.push(dir); }
  }
  console.log('（平台组件不经 sync——zip/源码参考见 suitectl platform）');
  return summary;
}

module.exports = { syncCommand };
