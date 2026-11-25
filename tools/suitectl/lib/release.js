'use strict';
// release：门禁 → 出包（tar）→ SHA256SUMS/channel/CHANGELOG → 发布即锁（自动钉定 gitlink+bundle → commit+tag）→ 上传 GH Releases。
// v2 版本纪律：候选版本 serial 由 channel 派生；浮动构建的 gitlink 漂移在 release 一并钉定——
//   "日常零 commit，发布即上锁"：任意历史版本仍可 clone --recursive + checkout tag 冷复原。
const fs = require('fs');
const path = require('path');
const U = require('./util');
const platform = require('./platform');
const { treeHash } = require('./hash');
const { cfg, P } = require('./config');
const { candidateVersion } = require('./build');

// 抽取组件仓库的版本 changelog：RELEASE_NOTES.md（# v<ver> 段）→ CHANGELOG.md（## <ver> 段）→ null
// 版本号按边界匹配（防 0.4.1 命中 0.4.10 段）
function sectionMatch (sec, version) {
  const re = new RegExp(`^v?${U.escapeRe(version)}(\\s|$|\\))`);
  return re.test(sec);
}
function extractNotes (dir, version) {
  const rn = path.join(P.components, dir, 'RELEASE_NOTES.md');
  if (fs.existsSync(rn)) {
    const sec = fs.readFileSync(rn, 'utf8').split(/^# /m).find(s => sectionMatch(s, version));
    if (sec) return sec.split('\n').slice(1, 9).join('\n').trim() || null;
  }
  const cl = path.join(P.components, dir, 'CHANGELOG.md');
  if (fs.existsSync(cl)) {
    const sec = fs.readFileSync(cl, 'utf8').split(/^## /m).find(s => sectionMatch(s, version));
    if (sec) return sec.split('\n').slice(1, 9).join('\n').trim() || null;
  }
  return null;
}

function releaseCommand(bundle, opts = {}) {
  const ver = candidateVersion(bundle.core.version);
  if (!fs.existsSync(P.buildReport)) throw new Error('无 build/build-report.json —— 先 suitectl build');
  const report = U.readJson(P.buildReport);
  if (report.suiteVersion !== ver) {
    throw new Error(`build-report(${report.suiteVersion}) 与候选版本(${ver}) 不一致 —— 重新 build`);
  }

  // git 前置：releases 目录若被移出仓库，产物无法随 commit 入库 → 显式 --no-git 才放行（跳过钉定/tag）
  const relDir = path.relative(P.root, P.releases);
  const releasesExternal = relDir.startsWith('..') || path.isAbsolute(relDir);
  if (releasesExternal && !opts.noGit && !opts.noTag) {
    throw new Error(`releases 目录在仓库外（${P.releases}），channel/SUMS 无法随父仓 commit 入库 —— 归位后重试，或 --no-git（只出包+上传，不钉定不打 tag）`);
  }

  // 门禁 1：脏子仓拒绝（浮动钉定的前提是子仓干净——钉的是 commit，不是工作树）
  const dirty = report.components.filter(c => c.dirty);
  if (dirty.length && !opts.allowDirty) {
    throw new Error(`脏子仓拒绝发布: ${dirty.map(c => c.dir).join(', ')}（提交后重跑 build+release，或 --allow-dirty 显式放行）`);
  }

  // 门禁 2：verify 绿 + 测的树 == 将要压的树（stageTreeHash 绑定）
  if (!opts.noVerify) {
    const passedPath = path.join(P.build, '.verify-passed');
    const passed = fs.existsSync(passedPath) ? U.readJson(passedPath) : null;
    if (!passed || passed.suiteVersion !== ver) {
      throw new Error(`verify 未通过或过期（无 ${ver} 的 build/.verify-passed）—— 先 suitectl verify，或 --no-verify 显式跳过`);
    }
    const current = treeHash(report.stageDir);
    if (passed.stageTreeHash && passed.stageTreeHash !== current) {
      throw new Error(`stage 自 verify 后已变化（树 hash 不符）—— 重新 build + verify（当前 ${current.slice(0, 12)}…）`);
    }
    console.log(`[release] verify 门禁 ✓（${passed.at}，stageTreeHash ${current.slice(0, 12)}…）`);
  }

  // 门禁 3：tag 冲突预检（serial 派生依赖本地 channel 完整性，冲突=serial 已被占用）
  if (!opts.noTag) {
    const exists = U.gitOut(['rev-parse', '-q', '--verify', `refs/tags/suite/${ver}`], { ok: true });
    if (exists) throw new Error(`tag suite/${ver} 已存在 —— 同版本重发请先处理（本地 channel 丢失会使 serial 回退，从远端 channel.json 恢复）`);
  }

  // 门禁 4：gitlink 远端可解析（"先子仓后父仓"的机器守门）+ 漂移清单（本次 release 将钉定的内容）
  const pinning = [];
  if (!opts.noRemoteCheck) {
    for (const c of report.components) {
      const cwd = path.join(P.components, c.dir);
      const head = U.gitOut(['-C', cwd, 'rev-parse', 'HEAD']);
      const pinned = U.gitOut(['rev-parse', `HEAD:components/${c.dir}`], { ok: true });
      if (head !== pinned) pinning.push(`${c.dir} ${pinned ? pinned.slice(0, 8) : '∅'} → ${head.slice(0, 8)}`);
      try { U.git(['-C', cwd, 'fetch', 'origin', 'main']); } catch { /* 离线时按本地远端引用判断 */ }
      const anc = U.run('git', ['-C', cwd, 'merge-base', '--is-ancestor', head, 'origin/main'], { ok: true });
      if (anc.status !== 0) {
        throw new Error(`${c.dir} 检出的 ${head.slice(0, 8)} 尚未推送至其远端 main —— 推送顺序：先子仓后父仓（--no-remote-check 可跳过检查）`);
      }
    }
    console.log(`[release] gitlink 门禁 ✓（${report.components.length} 组件远端可解析${pinning.length ? `；本次钉定漂移 ${pinning.length} 项` : ''}）`);
    for (const p of pinning) console.log(`  [钉定] ${p}`);
  }

  // 出包（tar 引擎：zip 内带顶层 tabby-suite/ 目录）
  const zipName = `tabby-suite-${ver}-portable-x64.zip`;
  const zipPath = path.join(P.releases, zipName);
  console.log(`[release] 压缩 ${zipName}`);
  platform.zipDir(report.stageDir, zipPath);
  const sha = U.sha256(zipPath);

  // SHA256SUMS：累积多版本（按文件名排序），重发同版本则覆盖该行
  const sumsPath = path.join(P.releases, 'SHA256SUMS');
  const sums = {};
  if (fs.existsSync(sumsPath)) {
    for (const l of fs.readFileSync(sumsPath, 'utf8').split('\n')) {
      const m = /^([0-9a-f]{64})  (.+)$/.exec(l.trim());
      if (m) sums[m[2]] = m[1];
    }
  }
  sums[zipName] = sha;
  fs.writeFileSync(sumsPath, Object.entries(sums).sort(([a], [b]) => a.localeCompare(b)).map(([f, h]) => `${h}  ${f}`).join('\n') + '\n');

  // channel 索引（v2 条目：含每插件 zip/treeSha256 + notes 原文——CHANGELOG 重生成只依赖 channel 存档）
  const ch = fs.existsSync(P.channel) ? U.readJson(P.channel) : { latest: null, releases: {} };
  ch.baseUrl = `https://github.com/${cfg.dist.repo}/releases/download`;
  ch.releases[ver] = {
    core: report.core.version,
    zip: zipName,
    sha256: sha,
    plugins: Object.fromEntries(report.components.map(c => [c.name, {
      version: c.version, commit: c.commit, dirty: !!c.dirty,
      zip: c.zipName, sha256: c.sha256, treeSha256: report.plugins[c.name]?.treeSha256,
    }])),
    notes: report.components.map(c => {
      const note = extractNotes(c.dir, c.version);
      return `${c.name} ${c.version}${c.dirty ? '(dirty)' : ''} @${c.commit.slice(0, 8)}` + (note ? `\n${note}` : '');
    }),
    releasedAt: U.stamp(),
  };
  if (!ch.latest || U.cmpSuiteVer(ver, ch.latest) > 0) ch.latest = ver; // 重发旧版不回拉 latest
  U.writeJson(P.channel, ch);

  // CHANGELOG：以 channel 存档为唯一来源（不再读子仓现状——历史不可漂移）
  let md = '# TabbySuite CHANGELOG\n';
  for (const [v, r] of Object.entries(ch.releases).sort(([a], [b]) => U.cmpSuiteVer(a, b)).reverse()) {
    md += `\n## ${v} — ${r.releasedAt}\n\n- core: ${r.core}（官方 portable 原样）\n`;
    md += Object.entries(r.plugins || {}).map(([n, p]) => {
      const note = Array.isArray(r.notes) ? r.notes.find(x => x.startsWith(`${n} `)) : null;
      const body = note ? note.split('\n').slice(1).join('\n').trim() : null;
      return `- ${n} ${p.version}${p.dirty ? ' **(dirty)**' : ''}` + (body ? '\n' + body.split('\n').map(l => `  > ${l}`).join('\n') : '');
    }).join('\n') + '\n';
  }
  fs.writeFileSync(path.join(P.releases, 'CHANGELOG.md'), md);

  // 发布即锁：gitlink 漂移（components + reference/tabby）+ bundle + releases 产物 → 一个 commit + tag
  if (!opts.noTag && !opts.noGit) {
    U.git(['add', 'bundle.yaml', 'components', 'reference/tabby',
      path.join(relDir, 'SHA256SUMS'), path.join(relDir, 'update-channel.json'), path.join(relDir, 'CHANGELOG.md')]);
    const staged = U.gitOut(['diff', '--cached', '--name-only'], { ok: true });
    if (staged) U.git(['commit', '-m', `release: ${ver}`]);
    else console.log('  （无待提交变更，跳过 commit）');
    U.git(['tag', '-a', `suite/${ver}`, '-m', `tabby-suite ${ver}`]);
    console.log(`[release] 已钉定并打 tag suite/${ver}`);
  }

  // 上传 GH Releases（gh CLI；代理注入 HTTPS_PROXY）。资产：全量 zip + 每插件 zip + channel.json
  if (!opts.noUpload) {
    if (!platform.commandPath('gh')) {
      console.log('[release] ⚠ 未找到 gh CLI，跳过上传（本地产物已就绪）—— 安装 GitHub CLI 后可 gh release upload 补传');
    } else {
      const files = [zipPath, P.channel, ...report.components.map(c => c.zip)];
      const title = `tabby-suite ${ver}`;
      const notes = report.components.map(c => `- ${c.name} ${c.version} @${c.commit.slice(0, 8)}`).join('\n');
      console.log(`[release] 上传 ${files.length} 个资产到 GitHub Releases…`);
      try {
        platform.gh(['release', 'create', `suite/${ver}`, '--title', title, '--notes', notes, ...files]);
        console.log(`[release] ✓ https://github.com/${cfg.dist.repo}/releases/tag/suite/${ver}`);
      } catch (e) {
        throw new Error(`上传失败：${String(e.message).split('\n')[0]}\n  → release 若已存在可补传: gh release upload suite/${ver} ${files.map(f => `"${f}"`).join(' ')} --clobber`);
      }
    }
  }

  console.log(`[release] 完成: ${zipPath}`);
  console.log(`  sha256: ${sha}`);
}

module.exports = { releaseCommand };
