'use strict';
// verify：stage 拷贝为隔离实例 → ELECTRON_ENABLE_LOGGING 启动 → 四级断言 → build/.verify-passed（release 门禁）
// 断言依据 2026-10-07 实证：插件加载信号在 renderer console 的 "Loading <name>:" 行（tabby- 前缀被剥）；
// CDP 端口必须 bind 探测（Windows 保留段动态变化，实测 9249-9348 曾整段不可绑）。
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const U = require('./util');
const { P } = U;

const BENIGN_ERR = [/jump_list/i]; // Windows 隐私设置花边；devtools 绑定失败不算良性（端口已探测过）

const sleep = ms => new Promise(r => setTimeout(r, ms));

function probePort (cands) {
  return new Promise(resolve => {
    const tryNext = i => {
      if (i >= cands.length) return resolve(null);
      const s = net.createServer();
      s.once('error', () => tryNext(i + 1));
      s.listen(cands[i], '127.0.0.1', () => s.close(() => resolve(cands[i])));
    };
    tryNext(0);
  });
}

async function waitCdp (port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* retry */ }
    await sleep(600);
  }
  return false;
}

// 最小 CDP 求值（Node 22+ 内置 WebSocket），与 TerminalWorkwench scripts/cdpEval.js 同构
async function cdpEval (port, expr) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'));
  if (!page) throw new Error('CDP 无主窗口 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const r = await new Promise(res => {
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) res(m);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  const out = r.result?.result;
  if (out?.subtype === 'error') return `ERROR: ${out.description?.slice(0, 300)}`;
  return out?.value === undefined ? JSON.stringify(out) : String(out.value);
}

async function killInstance (instDir) {
  // PS 单引号字符串中反斜杠是字面量，无需转义；按可执行文件路径过滤，绝不误杀其它 Tabby
  U.ps(`Get-Process | Where-Object { $_.Path -like '${instDir}\\*' } | Stop-Process -Force`, { ok: true });
}

async function verifyCommand (bundle) {
  const ver = `${bundle.core.version}-s${bundle.suite.serial}`;
  if (!fs.existsSync(P.buildReport)) throw new Error('无 build-report —— 先 suitectl build');
  const report = U.readJson(P.buildReport);
  if (report.suiteVersion !== ver) throw new Error(`build-report(${report.suiteVersion}) ≠ bundle(${ver}) —— serial 已变，重新 build`);

  const instDir = path.join(P.runtime, 'instance');
  const errFile = path.join(P.runtime, 'instance-boot.err');
  console.log(`[verify] ${ver} → runtime/instance/（stage 全新拷贝）`);
  U.rmrf(instDir);
  U.rmrf(errFile);
  fs.cpSync(report.stageDir, instDir, { recursive: true });

  const port = await probePort(Array.from({ length: 28 }, (_, i) => 9241 + i));
  if (!port) throw new Error('9241-9268 全部不可绑定（netsh interface ipv4 show excludedportrange protocol=tcp 查保留段）');
  console.log(`[verify] CDP 端口 ${port}（bind 探测通过）`);
  U.writeJson(path.join(P.runtime, 'instance.json'), {
    name: 'verify', port, vendor: `suite ${ver}`,
    created: new Date().toISOString(), notes: 'suitectl verify 隔离实例（schema 同 TabbyEnv）；失败保留现场',
  });

  const child = spawn(path.join(instDir, 'Tabby.exe'), [`--remote-debugging-port=${port}`], {
    cwd: instDir,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.stderr.on('data', d => fs.appendFileSync(errFile, d));

  try {
    console.log('[verify] 等待 CDP 就绪…');
    if (!(await waitCdp(port, 45000))) throw new Error('CDP 45s 未就绪（实例未起/端口被占/启动崩溃）');
    await sleep(6000); // 插件加载余量
    if (exited) throw new Error('实例进程提前退出（见 runtime/instance-boot.err）');

    const log = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';

    // ① 插件全载：renderer console 每组件至少一条 "Loading <name>:"（Tabby 剥 tabby- 前缀）
    const missing = report.components
      .filter(c => !new RegExp(`Loading ${c.name.replace(/^tabby-/, '')}:`).test(log))
      .map(c => c.name);
    if (missing.length) throw new Error(`① 插件未加载: ${missing.join(', ')}（Loading 行缺失，现场保留于 runtime/）`);
    console.log(`[verify] ① 插件全载 ${report.components.length}/${report.components.length} ✓`);

    // ② 启动无非良性 ERROR
    const bad = log.split('\n').filter(l => /ERROR/.test(l) && !BENIGN_ERR.some(r => r.test(l)));
    if (bad.length) throw new Error(`② 非良性 ERROR ${bad.length} 条:\n  ${bad.slice(0, 4).join('\n  ')}`);
    console.log('[verify] ② 启动无致命错误 ✓');

    // ③ 渲染层 CDP 探针（bundle.probes）
    for (const [dir, list] of Object.entries(bundle.probes || {})) {
      for (const p of list) {
        const out = await cdpEval(port, p.expr);
        if (String(out) !== String(p.expect)) {
          throw new Error(`③ 探针失败 ${dir}: ${p.expr}\n  期望 ${JSON.stringify(p.expect)}，实得 ${String(out).slice(0, 200)}`);
        }
      }
      console.log(`[verify] ③ 探针 ${dir}（${list.length} 项）✓`);
    }

    // ④ 回归挂钩（bundle.regression 且 enabled: true；CDP_PORT 注入）
    for (const [dir, r] of Object.entries(bundle.regression || {})) {
      if (!r?.enabled) continue;
      console.log(`[verify] ④ 回归 ${dir}: ${r.script}`);
      U.run('node', [r.script], { cwd: path.join(P.components, r.cwd || dir), env: { ...process.env, CDP_PORT: String(port) } });
    }

    U.writeJson(path.join(P.build, '.verify-passed'), { suiteVersion: ver, port, at: U.stamp() });
    console.log('[verify] ✓ 全部断言通过 —— build/.verify-passed 已写（release 门禁）');
  } finally {
    await killInstance(instDir);
    await sleep(1500);
    try { child.kill(); } catch { /* 已退出 */ }
  }
}

module.exports = { verifyCommand, probePort, waitCdp, killInstance };
