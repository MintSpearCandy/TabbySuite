'use strict';
// dev：长驻开发实例 —— 与构建流水线分离的快速迭代轨道（架构 §6.8，开发/构建分离）
// 纪律：dev 族允许脏树、秒级单插件重部署、永不产出 releases/、永不写 .verify-passed；
//       出包仍走 build（钉定+单测）→ verify（门禁）→ release（gitlink 远端守门）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const U = require('./util');
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
  if (preferred && (await verify.probePort([preferred])) === preferred) return preferred;
  const port = await verify.probePort(Array.from({ length: 28 }, (_, i) => 9241 + i));
  if (!port) throw new Error('9241-9268 无可绑定端口（Windows 保留段漂移，netsh 查 excludedportrange）');
  return port;
}

function launchDetached (port) {
  const child = spawn(path.join(DEV, 'Tabby.exe'), [`--remote-debugging-port=${port}`], {
    cwd: DEV, detached: true, stdio: 'ignore',
  });
  child.unref(); // 长驻：CLI 退出后实例继续运行
}

async function devUp (bundle) {
  const stage = path.join(P.stage, 'tabby-suite');
  if (!fs.existsSync(path.join(stage, 'Tabby.exe'))) throw new Error('无组装产物 —— 先 suitectl build（dev 实例以 stage 为母本）');
  console.log('[dev] 重建实例 → runtime/dev/（全量实拷——dev 的 exe 会被执行，硬链会与 stage 共享文件锁，禁止）');
  await verify.killInstance(DEV); // 运行中的实例持有 exe 锁，先停再清
  await sleep(1500);
  U.rmrf(DEV);
  fs.cpSync(stage, DEV, { recursive: true });
  const port = await pickPort();
  U.writeJson(path.join(DEV, 'instance.json'), {
    name: 'dev', port, vendor: `suite ${bundle.core.version}-s${bundle.suite.serial}`,
    created: U.stamp(), notes: 'suitectl dev 长驻开发实例（脏树迭代轨道；TabbyEnv instance.json 同构）',
  });
  console.log(`[dev] 启动 CDP :${port}`);
  launchDetached(port);
  if (!(await verify.waitCdp(port, 45000))) throw new Error('CDP 45s 未就绪（实例启动失败？）');
  await sleep(4000); // 渲染层 Angular 引导（pluginModules/__glassConfig）慢于 CDP 端点
  console.log(`[dev] ✓ 就绪 —— CDP http://127.0.0.1:${port}`);
  console.log(`[dev] 探针示例: CDP_PORT=${port} node components/TerminalWorkwench/scripts/cdpEval.js "<expr>"`);
}

async function devDeploy (bundle, dirs, opts = {}) {
  if (!fs.existsSync(path.join(DEV, 'Tabby.exe'))) throw new Error('dev 实例不存在 —— 先 suitectl dev up');
  const targets = dirs?.length
    ? dirs
    : bundle.integrate.filter(d => U.gitOut(['-C', path.join(P.components, d), 'status', '--porcelain'], { ok: true }) !== '');
  if (!targets.length) { console.log('[dev] 无脏组件（显式指定组件名可强制部署）'); return; }
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
  if (opts.restart) await devRestart();
  else console.log('[dev] 插件于启动时加载 —— suitectl dev restart 生效（或 deploy --restart）');
}

async function devRestart () {
  const meta = instanceMeta();
  if (!meta) throw new Error('无 dev 实例 —— 先 suitectl dev up');
  await verify.killInstance(DEV);
  await sleep(2000);
  fs.rmSync(path.join(DEV, 'data', 'lockfile'), { force: true });
  const port = await pickPort(meta.port);
  if (port !== meta.port) { meta.port = port; U.writeJson(path.join(DEV, 'instance.json'), meta); }
  launchDetached(port);
  if (!(await verify.waitCdp(port, 45000))) throw new Error('CDP 45s 未就绪');
  await sleep(4000); // 渲染层就绪余量
  console.log(`[dev] ✓ 已重启 CDP :${port}`);
}

async function devDown () {
  await verify.killInstance(DEV);
  console.log('[dev] 已停止（目录保留，suitectl dev up 可重建）');
}

async function devStatus () {
  const meta = instanceMeta();
  if (!meta) { console.log('[dev] 无实例（suitectl dev up）'); return; }
  const r = U.run('powershell', ['-NoProfile', '-Command',
    `@(Get-Process | Where-Object { $_.Path -like '${DEV}\\*' }).Count`], { ok: true, capture: true });
  const alive = parseInt((r.stdout || '').toString().trim()) || 0;
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
