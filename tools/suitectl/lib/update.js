'use strict';
// update / doctor：目标机更新 —— 转调 suite-tools/suitectl.ps1（单一实现，不写第二份逻辑）。
// 用法: suitectl update --dest <安装目录> [--check|--apply|--rollback]   默认 --check
//       suitectl doctor --dest <安装目录>
const path = require('path');
const U = require('./util');
const { cfg, P } = require('./config');

const MODE_OF = {
  update: { check: 'check', apply: 'apply', rollback: 'rollback' },
  doctor: { check: 'doctor', apply: 'doctor', rollback: 'doctor' },
};

function runPs1(kind, opts = {}) {
  if (!cfg.platform.powershell) {
    throw new Error('update/doctor 依赖 PowerShell（当前平台未配置）—— Windows 目标机自带；其它平台运行 suite-tools/suitectl.ps1 的对应实现');
  }
  const action = MODE_OF[kind][opts.mode || 'check'];
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(P.suiteTools, 'suitectl.ps1'), '-Command', action, '-Dest', opts.dest];
  if (cfg.net.proxy) args.push('-Proxy', cfg.net.proxy);
  U.run(cfg.platform.powershell, args);
}

module.exports = { runPs1 };
