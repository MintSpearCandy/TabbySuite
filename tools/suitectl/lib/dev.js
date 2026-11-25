'use strict';
// dev：长驻开发实例 —— 与构建流水线分离的快速迭代轨道（开发/构建分离）
// 纪律：dev 族允许脏树、秒级单插件重部署、永不产出 releases/、永不写 .verify-passed；
//       出包仍走 build（钉定+单测）→ verify（门禁）→ release（发布即锁）。
// v2 修复：deploy --restart 的顺序为"先停 → 拷贝 → 再启动"——运行中的实例锁着已加载的
//   native addon（如 ActivxRDPClient 的 rdp_host.node），边跑边删必失败。
const fs = require('fs');
const path = require('path');
const U = require('./util');
const platform = require('./platform');
const { cfg } = require('./config');
const { P } = U;
const build = require('./build');
const verify = require('./verify');

const DEV = path.join(P.runtime, 'dev');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function instanceMeta () {
  const f = path.join(DEV, 'instance.json');
  return fs.existsSync(f) ? U.readJson(f) : null;
}

async function pickPort (preferred) {
  if (preferred && (await platform.probePort([preferred])) === preferred) return preferred;
  const port = await platform.probePort(platform.cdpPorts());
  if (!port) {
    const [from, to] = cfg.ports.cdp;
    throw new Error(`${from}-${to} 无可绑定端口（Windows 保留段随机器漂移；可在 suitectl.local.yaml 的 ports.cdp 改区间）`);
  }
  return port;
}

async function startInstance (preferredPort) {
  fs.rmSync(path.join(DEV, 'data', 'lockfile'), { force: true });
  const port = await pickPort(preferredPort);
  if (preferredPort && port !== preferredPort) {
    const meta = instanceMeta();
    if (meta) { meta.port = port; U.writeJson(path.join(DEV, 'instance.json'), meta); }
  }
  platform.launchDetached(DEV, [`--remote-debugging-port=${port}`]);
  if (!(await verify.waitCdp(port, 45000))) throw new Error('CDP 45s 未就绪（实例启动失败？）');
  await sleep(4000); // 渲染层 Angular 引导（pluginModules/__glassConfig）慢于 CDP 端点
  console.log(`[dev] ✓ 运行中 —— CDP http://127.0.0.1:${port}`);
  return port;
}

async function devUp (bundle) {
  const stage = path.join(P.stage, 'tabby-suite');
  if (!platform.hasExe(stage)) throw new Error('无组装产物 —— 先 suitectl build / up（dev 实例以 stage 为母本）');
  console.log(`[dev] 重建实例 → ${path.relative(P.root, DEV)}/（全量实拷——dev 的 exe 会被执行，硬链会与 stage 共享文件锁，禁止）`);
  platform.killUnder(DEV); // 运行中的实例持有 exe 锁，先停再清
  await sleep(1500);
  U.rmrf(DEV);
  fs.cpSync(stage, DEV, { recursive: true });
  const port = await pickPort();
  U.writeJson(path.join(DEV, 'instance.json'), {
    name: 'dev', port, vendor: `suite ${bundle.core.version}（浮动检出）`,
    created: U.stamp(), notes: 'suitectl dev 长驻开发实例（脏树迭代轨道；自描述 instance.json）',
  });
  console.log(`[dev] 启动 CDP :${port}`);
  await startInstance(port);
  console.log(`[dev] 探针示例: CDP_PORT=${port} node components/TerminalWorkwench/scripts/cdpEval.js "<expr>"`);
}

async function devDeploy (bundle, dirs, opts = {}) {
  if (!platform.hasExe(DEV)) throw new Error('dev 实例不存在 —— 先 suitectl dev up');
  const targets = dirs?.length
    ? dirs
    : bundle.integrate.filter(d => U.gitOut(['-C', path.join(P.components, d), 'status', '--porcelain'], { ok: true }) !== '');
  if (!targets.length) { console.log('[dev] 无脏组件（显式指定组件名可强制部署）'); return; }
  // --restart：先停实例再拷贝（native addon 被运行进程锁定，边跑边删必失败），拷完统一重启
  if (opts.restart) {
    console.log('[dev] --restart：先停止实例（native 载荷被运行进程锁定）');
    platform.killUnder(DEV);
    await sleep(1500);
  } else if (platform.countUnder(DEV) > 0) {
    console.log('[dev] ⚠ 实例运行中：纯 JS 插件可热拷，native 载荷（rdp_host.node 等）会被锁 —— 建议 deploy --restart');
  }
  const nm = path.join(DEV, 'data', 'plugins', 'node_modules');
  const specPath = path.join(DEV, 'data', 'suite', 'suite.json');
  const spec = fs.existsSync(specPath) ? U.readJson(specPath) : { plugins: {} };
  spec.plugins = spec.plugins || {};
  for (const dir of targets) {
    const st = build.componentState(bundle, dir);
    const m = build.buildComponent(bundle, st); // 复用构建缓存；脏树强制重建
    const dst = path.join(nm, st.name);
    U.rmrf(dst);
    fs.cpSync(m.stageDir, dst, { recursive: true });
    spec.plugins[st.name] = { version: st.version, commit: st.commit, dirty: st.dirty, sha256: m.zipSha256, deployedAt: U.stamp() };
    console.log(`[dev] 已部署 ${st.name}@${st.version}${st.dirty ? '（脏树）' : ''}`);
  }
  U.writeJson(specPath, spec);
  if (opts.restart) await startInstance(instanceMeta()?.port);
  else console.log('[dev] 插件于启动时加载 —— suitectl dev restart 生效（或 deploy --restart）');
}

async function devRestart () {
  const meta = instanceMeta();
  if (!meta) throw new Error('无 dev 实例 —— 先 suitectl dev up');
  platform.killUnder(DEV);
  await sleep(2000);
  await startInstance(meta.port);
}

async function devDown () {
  platform.killUnder(DEV);
  console.log('[dev] 已停止（目录保留，suitectl dev up 可重建）');
}

async function devStatus () {
  const meta = instanceMeta();
  if (!meta) { console.log('[dev] 无实例（suitectl dev up）'); return; }
  const alive = platform.countUnder(DEV);
  let cdp = `:${meta.port} 无响应`;
  try {
    const res = await fetch(`http://127.0.0.1:${meta.port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) cdp = `:${meta.port} 在线`;
  } catch { /* keep 无响应 */ }
  console.log(`[dev] runtime/dev/  进程 ${alive}  CDP ${cdp}  母本 ${meta.vendor}`);
  const specPath = path.join(DEV, 'data', 'suite', 'suite.json');
  if (fs.existsSync(specPath)) {
    const spec = U.readJson(specPath);
    for (const [n, p] of Object.entries(spec.plugins || {})) {
      console.log(`  - ${n} ${p.version}${p.dirty ? '（脏）' : ''} @${(p.commit || '').slice(0, 8)}${p.deployedAt ? '  部署于 ' + p.deployedAt.slice(0, 19) : ''}`);
    }
  }
}

module.exports = { devUp, devDeploy, devRestart, devDown, devStatus };
