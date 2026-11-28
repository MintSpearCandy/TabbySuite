'use strict';
// component：components/ 收编状态一览 —— 目录里有什么、bundle 怎么分工、git 状态如何，一张表说清。
// 「目录即清单」的可视面：接入新插件 = submodule add + bundle.integrate 加一行（契约见 PLUGIN_CONTRACT.md）。
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { P } = U;

function stateOf(dir) {
  const cwd = path.join(P.components, dir);
  if (!fs.existsSync(path.join(cwd, '.git'))) return { dir, role: '未检出', note: 'git submodule update --init' };
  const commit = U.gitOut(['-C', cwd, 'rev-parse', 'HEAD'], { ok: true });
  const dirty = U.gitOut(['-C', cwd, 'status', '--porcelain'], { ok: true }) !== '';
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch { /* 无 package.json */ }
  return { dir, role: 'integrate', commit, dirty, name: pkg?.name, version: pkg?.version };
}

function lsCommand(bundle) {
  const rows = [];
  for (const dir of fs.readdirSync(P.components, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const st = stateOf(dir.name);
    st.role = (bundle.integrate || []).includes(dir.name) ? 'integrate' : '未声明（不在 bundle）';
    rows.push(st);
  }
  if (!rows.length) return console.log('[component] components/ 为空');
  console.log('[component] components/ 收编状态：');
  for (const r of rows) {
    const at = r.commit ? `@${r.commit.slice(0, 8)}` : '';
    const ver = r.version ? ` ${r.name}@${r.version}` : '';
    const dirty = r.dirty ? '（脏）' : '';
    console.log(`  ${r.dir.padEnd(22)} ${r.role.padEnd(14)} ${at}${ver}${dirty}${r.note ? ` — ${r.note}` : ''}`);
  }
  const missing = (bundle.integrate || []).filter(d => !fs.existsSync(path.join(P.components, d)));
  for (const d of missing) console.log(`  ${d.padEnd(22)} ${'bundle 声明但目录缺失'.padEnd(14)} — git submodule add / update --init`);
  console.log('（接入新插件：git submodule add <url> components/<dir> + bundle.yaml integrate 加一行；契约见 PLUGIN_CONTRACT.md）');
}

module.exports = { lsCommand };
