'use strict';
// sync：各 integrate 子仓拉远端最新（git submodule update --remote）
// 前进后需父仓 `git add components/<dir> && git commit` 完成钉版 —— 这才是"集成"动作
const path = require('path');
const U = require('./util');
const { P } = U;

function syncCommand(bundle) {
  for (const dir of bundle.integrate) {
    const cwd = path.join(P.components, dir);
    const dirty = U.gitOut(['-C', cwd, 'status', '--porcelain'], { ok: true }) !== '';
    const before = U.gitOut(['-C', cwd, 'rev-parse', 'HEAD']);
    if (dirty) { console.log(`  [跳过] ${dir} —— 脏工作树，先 commit/stash`); continue; }
    try {
      U.git(['submodule', 'update', '--remote', `components/${dir}`]);
    } catch (e) {
      console.log(`  [失败] ${dir}: ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const after = U.gitOut(['-C', cwd, 'rev-parse', 'HEAD']);
    if (before === after) console.log(`  [无变化] ${dir} @${after.slice(0, 8)}`);
    else console.log(`  [前进] ${dir} ${before.slice(0, 8)} → ${after.slice(0, 8)}   钉版: git add components/${dir} && git commit`);
  }
  console.log('（exclude 仓不经 sync 前进；第三方升级需手工 checkout + 父仓 commit）');
}

module.exports = { syncCommand };
