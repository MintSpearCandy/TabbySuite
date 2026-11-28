'use strict';
// verify：stage 拷贝为隔离实例 → ELECTRON_ENABLE_LOGGING 启动 → 四级断言 → .work/.verify-passed（release 门禁）
// 断言依据 2026-10-07 实证：插件加载信号在 renderer console 的 "Loading <name>:" 行（tabby- 前缀被剥）；
// CDP 端口必须 bind 探测（Windows 保留段动态变化，实测 9249-9348 曾整段不可绑；候选区间见环境配置 ports.cdp）。
// v2：.verify-passed 记 stageTreeHash —— release 压包前复核"verify 测的树 == 将要出包的树"。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const U = require('./util');
const sys = require('./sys');
const { treeHash } = require('./hash');
const { cfg } = require('./config');
const { P } = U;
const { candidateVersion } = require('./build');

const BENIGN_ERR = [/jump_list/i]; // Windows 隐私设置花边；devtools 绑定失败不算良性（端口已探测过）

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// 最小 CDP 求值（Node 22+ 内置 WebSocket），与 TerminalWorkwench scripts/cdpEval.js 同构；
// 全链路 10s 超时——页面销毁/导航导致 evaluate 无响应时报错而非永挂
async function cdpEval (port, expr) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'));
  if (!page) throw new Error('CDP 无主窗口 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const timeout = setTimeout(() => { try { ws.close(); } catch { /* 已关 */ } }, 10000);
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP 连接超时')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('CDP 连接失败')); });
    });
    const r = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP evaluate 超时')), 10000);
      ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(t); res(m); }
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    });
    const out = r.result?.result;
    if (out?.subtype === 'error') return `ERROR: ${out.description?.slice(0, 300)}`;
    return out?.value === undefined ? JSON.stringify(out) : String(out.value);
  } finally {
    clearTimeout(timeout);
    try { ws.close(); } catch { /* 已关 */ }
  }
}

async function killInstance (instDir) {
  // 按可执行文件路径过滤，绝不误杀其它 Tabby；平台差异由 sys 适配
  sys.killUnder(instDir);
}

async function verifyCommand (bundle) {
  const ver = candidateVersion(bundle.platform.version);
  if (!fs.existsSync(P.buildReport)) throw new Error('无 build-report —— 先 suitectl build');
  const report = U.readJson(P.buildReport);
  if (report.suiteVersion !== ver) throw new Error(`build-report(${report.suiteVersion}) ≠ 候选版本(${ver}) —— stage 已过期，重新 build`);

  const instDir = P.instance;
  const errFile = P.instanceErr;
  console.log(`[verify] ${ver} → ${path.relative(P.root, instDir)}/（stage 全新实拷）`);
  U.rmrf(instDir);
  U.rmrf(errFile);
  fs.cpSync(report.stageDir, instDir, { recursive: true }); // 实拷：实例会执行，禁止硬链共享文件锁

  const [from, to] = cfg.ports.cdp;
  const port = await sys.probePort(sys.cdpPorts());
  if (!port) throw new Error(`${from}-${to} 全部不可绑定（Windows 保留段随机器漂移：netsh interface ipv4 show excludedportrange protocol=tcp；可在 suitectl.local.yaml 的 ports.cdp 改区间）`);
  console.log(`[verify] CDP 端口 ${port}（bind 探测通过）`);
  // 实例自描述元数据放实例目录内（拷走实例元数据随行）
  U.writeJson(path.join(instDir, 'instance.json'), {
    name: 'verify', port, suite: ver,
    created: new Date().toISOString(), notes: 'suitectl verify 隔离实例（自描述 instance.json）；失败保留现场',
  });

  sys.assertExe(instDir, 'verify 实例');
  const child = spawn(sys.exePath(instDir), [`--remote-debugging-port=${port}`], {
    cwd: instDir,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', e => { throw new Error(`实例启动失败: ${e.message}`); });
  child.stderr.on('data', d => fs.appendFileSync(errFile, d));

  try {
    console.log('[verify] 等待 CDP 就绪…');
    if (!(await waitCdp(port, 45000))) throw new Error('CDP 45s 未就绪（实例未起/端口被占/启动崩溃）');
    await sleep(6000); // 插件加载余量
    if (exited) throw new Error('实例进程提前退出（见 .work/instance-boot.err）');

    const log = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';

    // ① 插件全载：renderer console 每组件至少一条 "Loading <name>:"（Tabby 剥 tabby- 前缀；包名按字面匹配）
    const missing = report.components
      .filter(c => !new RegExp(`Loading ${U.escapeRe(c.name.replace(/^tabby-/, ''))}:`).test(log))
      .map(c => c.name);
    if (missing.length) throw new Error(`① 插件未加载: ${missing.join(', ')}（Loading 行缺失，现场保留于 .work/instance/）`);
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

    U.writeJson(P.verifyPassed, {
      suiteVersion: ver, stageTreeHash: report.stageTreeHash, port, at: U.stamp(),
    });
    console.log('[verify] ✓ 全部断言通过 —— .work/.verify-passed 已写（release 门禁）');
  } finally {
    await killInstance(instDir);
    await sleep(1500);
    try { child.kill(); } catch { /* 已退出 */ }
  }
}

module.exports = { verifyCommand, waitCdp, killInstance, cdpEval };
