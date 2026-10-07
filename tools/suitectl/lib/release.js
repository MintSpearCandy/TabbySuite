'use strict';
// release：verify 门禁(P2) → zip + SHA256SUMS + update-channel + CHANGELOG → 父仓 commit + tag
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { P } = U;

// 版本排序：1.0.237-s3 > 1.0.237-s2 > 1.0.235-s9
function cmpVer(a, b) {
  const [ac, as] = a.split('-s');
  const [bc, bs] = b.split('-s');
  const ai = ac.split('.').map(Number), bi = bc.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (ai[i] !== bi[i]) return ai[i] - bi[i];
  return Number(as) - Number(bs);
}

// 抽取组件仓库的版本 changelog：RELEASE_NOTES.md（# v<ver> 段）→ CHANGELOG.md（## <ver> 段）→ null
function extractNotes (dir, version) {
  const rn = path.join(P.components, dir, 'RELEASE_NOTES.md');
  if (fs.existsSync(rn)) {
    const sec = fs.readFileSync(rn, 'utf8').split(/^# /m).find(s => s.startsWith(`v${version}`));
    if (sec) return sec.split('\n').slice(1, 9).join('\n').trim() || null;
  }
  const cl = path.join(P.components, dir, 'CHANGELOG.md');
  if (fs.existsSync(cl)) {
    const sec = fs.readFileSync(cl, 'utf8').split(/^## /m).find(s => s.startsWith(`v${version}`) || s.startsWith(`${version}`));
    if (sec) return sec.split('\n').slice(1, 9).join('\n').trim() || null;
  }
  return null;
}

function releaseCommand(bundle, opts = {}) {
  const ver = `${bundle.core.version}-s${bundle.suite.serial}`;
  if (!fs.existsSync(P.buildReport)) throw new Error('无 build/build-report.json —— 先 suitectl build');
  const report = U.readJson(P.buildReport);
  if (report.suiteVersion !== ver) {
    throw new Error(`build-report(${report.suiteVersion}) 与 bundle.yaml(${ver}) 不一致 —— serial 已变，重新 build`);
  }
  const dirty = report.components.filter(c => c.dirty);
  if (dirty.length && !opts.allowDirty) {
    throw new Error(`脏子仓拒绝发布: ${dirty.map(c => c.dir).join(', ')}（提交后重跑 build+release，或 --allow-dirty 显式放行）`);
  }
  // verify 门禁：绿了才能出包
  if (!opts.noVerify) {
    const passedPath = path.join(P.build, '.verify-passed');
    const passed = fs.existsSync(passedPath) ? U.readJson(passedPath) : null;
    if (!passed || passed.suiteVersion !== ver) {
      throw new Error(`verify 未通过或过期（无 ${ver} 的 build/.verify-passed）—— 先 suitectl verify，或 --no-verify 显式跳过`);
    }
    console.log(`[release] verify 门禁 ✓（${passed.at}）`);
  }

  const zipName = `tabby-suite-${ver}-portable-x64.zip`;
  const zipPath = path.join(P.releases, zipName);
  console.log(`[release] 压缩 ${zipName}（约 1-2 分钟）`);
  U.rmrf(zipPath);
  U.ps(`Compress-Archive -Path "${report.stageDir}\\*" -DestinationPath "${zipPath}" -Force`);
  const sha = U.sha256(zipPath);
  fs.writeFileSync(path.join(P.releases, 'SHA256SUMS'), `${sha}  ${zipName}\n`);

  // channel 索引
  const ch = fs.existsSync(P.channel) ? U.readJson(P.channel) : { latest: null, releases: {} };
  ch.releases[ver] = {
    core: report.core.version,
    zip: zipName,
    sha256: sha,
    plugins: Object.fromEntries(report.components.map(c => [c.name, { version: c.version, sha256: c.sha256, dirty: c.dirty }])),
    notes: report.components.map(c => `${c.name} ${c.version}${c.dirty ? '(dirty)' : ''} @${c.commit.slice(0, 8)}`).join('; '),
    releasedAt: U.stamp(),
  };
  ch.latest = ver;
  U.writeJson(P.channel, ch);

  // CHANGELOG：组件清单 + 自各仓库 RELEASE_NOTES.md / CHANGELOG.md 抽取对应版本段落（至多 8 行）
  let md = '# TabbySuite CHANGELOG\n';
  for (const [v, r] of Object.entries(ch.releases).sort(([a], [b]) => cmpVer(a, b)).reverse()) {
    md += `\n## ${v} — ${r.releasedAt}\n\n- core: ${r.core}（官方 portable 原样）\n`;
    md += Object.entries(r.plugins).map(([n, p]) => {
      let line = `- ${n} ${p.version}${p.dirty ? ' **(dirty)**' : ''}`;
      const comp = report.components.find(c => c.name === n);
      const note = comp && extractNotes(comp.dir, p.version);
      if (note) line += '\n' + note.split('\n').map(l => `  > ${l}`).join('\n');
      return line;
    }).join('\n') + '\n';
  }
  fs.writeFileSync(path.join(P.releases, 'CHANGELOG.md'), md);

  // 发布 = commit + tag（--no-tag 跳过）
  if (!opts.noTag) {
    U.git(['add', 'releases/SHA256SUMS', 'releases/update-channel.json', 'releases/CHANGELOG.md']);
    try { U.git(['commit', '-m', `release: ${ver}`]); } catch { console.log('  （无待提交变更，跳过 commit）'); }
    U.git(['tag', '-a', `suite/${ver}`, '-m', `tabby-suite ${ver}`]);
    console.log(`[release] 已打 tag suite/${ver}`);
  }
  console.log(`[release] 完成: ${zipPath}`);
  console.log(`  sha256: ${sha}`);
}

module.exports = { releaseCommand };
