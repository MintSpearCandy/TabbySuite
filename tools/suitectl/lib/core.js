'use strict';
// core：Tabby 官方 core 版本管理 —— latest 查询 / use 前进（下载+登记+改 bundle+重钉 reference）。
// 浮动语义（v2）：bundle.yaml core.pin: auto 时 `up` 自动调用 use latest；
//   写死 pin 版本则 up 不自动前进（想锁旧 core 时用），core use 仍可显式前进。
const fs = require('fs');
const path = require('path');
const U = require('./util');
const platform = require('./platform');
const vendor = require('./vendor');
const { P } = U;

const REF_DIR = path.join(P.root, 'reference', 'tabby');

// 只改 bundle.yaml 中 core: 下的 version 行，保留注释与其余内容（js-yaml 往返会丢注释，故行级替换）
function writeBundleCoreVersion(version) {
  const lines = fs.readFileSync(P.bundle, 'utf8').split('\n');
  let inCore = false, done = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^core:\s*$/.test(l)) { inCore = true; continue; }
    if (inCore && /^\S/.test(l)) break; // 离开 core: 块
    if (inCore && /^(\s+)version:\s*\S+/.test(l) && !done) {
      lines[i] = l.replace(/^(\s+)version:\s*\S+/, `$1version: ${version}`);
      done = true;
    }
  }
  if (!done) throw new Error('bundle.yaml 中未找到 core.version —— 结构异常');
  fs.writeFileSync(P.bundle, lines.join('\n'));
}

// reference/tabby 重钉到 v<version>（浅取 tag；未检出不阻路，仅提示）
function repinReference(version) {
  if (!fs.existsSync(path.join(REF_DIR, '.git'))) {
    console.log('[core] reference/tabby 未检出，跳过重钉（git submodule update --init reference/tabby）');
    return;
  }
  U.git(['-C', REF_DIR, 'fetch', '--depth', '1', 'origin', `tag`, `v${version}`], { ok: true });
  U.git(['-C', REF_DIR, 'checkout', '--detach', `v${version}`]);
  console.log(`[core] reference/tabby → v${version}（gitlink 漂移随 release 钉定）`);
}

// core use 的完整动作：确保 zip → 登记 → 改 bundle → 重钉 reference
async function coreUse(bundle, version, opts = {}) {
  const hit = await vendor.ensureCoreZip(version, { offline: opts.offline });
  console.log(`[core] ${version} 就绪（sha256 ${hit.sha256.slice(0, 12)}…）`);
  if (bundle.core.version !== version) {
    writeBundleCoreVersion(version);
    console.log(`[core] bundle.yaml core.version: ${bundle.core.version} → ${version}`);
    bundle.core.version = version; // 就地更新，供同进程后续使用
  }
  repinReference(version);
  console.log('[core] 下一步：suitectl up（构建+门禁）—— core 变更走整包路径，verify 必跑');
}

async function coreCommand(bundle, args, opts = {}) {
  const sub = args[0];
  const pinned = bundle.core.pin && bundle.core.pin !== 'auto';
  if (sub === 'latest' || (sub === 'use' && args[1] === 'latest')) {
    const latest = await vendor.githubLatest();
    if (!latest) throw new Error('官方 Releases 未找到 portable-x64 资产（tag 命名变化？）');
    console.log(`[core] 官方最新 ${latest.version}（${latest.tag}）`);
    console.log(`[core] 当前构建 ${bundle.core.version}${pinned ? `（pin 锁定 ${bundle.core.pin}）` : ''}`);
    if (sub === 'latest') {
      const d = U.cmpSemver(latest.version, bundle.core.version);
      console.log(`[core] ${d > 0 ? '有更新' : d === 0 ? '已最新' : '本地领先（预发布/回退?）'}${d > 0 ? ` —— suitectl core use ${latest.version} 前进` : ''}`);
      return;
    }
    await coreUse(bundle, latest.version, opts);
    return;
  }
  if (sub === 'use') {
    const version = args[1];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error('用法: core use <x.y.z>|latest');
    }
    await coreUse(bundle, version, opts);
    return;
  }
  throw new Error('core 子命令: latest（查官方最新）| use <版本>|latest（前进并登记）');
}

// up/rollout 编排用：pin:auto 且官方更新可用时自动前进；否则零动作。
// 返回 { advanced, version? }——rollout 以 advanced 作为"是否滚动构建"的判定信号之一。
async function ensureLatestCore(bundle, opts = {}) {
  if (opts.offline) {
    console.log('[core] --offline 跳过查新');
    return { advanced: false };
  }
  if (bundle.core.pin && bundle.core.pin !== 'auto') {
    console.log(`[core] pin 锁定 ${bundle.core.pin}，不自动前进（core use 可显式前进）`);
    return { advanced: false };
  }
  const newer = await vendor.officialNewerThan(bundle.core.version);
  if (!newer) { console.log(`[core] ${bundle.core.version} 已是官方最新（或查询不可用）`); return { advanced: false }; }
  console.log(`[core] 官方有新版 ${newer.version} —— 自动前进`);
  await coreUse(bundle, newer.version, opts);
  return { advanced: true, version: newer.version };
}

module.exports = { coreCommand, ensureLatestCore, writeBundleCoreVersion, repinReference };
