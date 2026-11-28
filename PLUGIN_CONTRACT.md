# 插件集成契约（PLUGIN CONTRACT）

> 面向**插件独立仓**（TabbyWebViewer / TabbyHotkeyGuard / tabby-glass-theme / TabbyOutputFilter / tabby-better-configer / tabby-terminal-workwench / tabby-activx-rdp-client）。
> 本仓（TabbySuite）是纯集成消费方：你只需让自己的仓满足以下契约，集成侧零改动即可接入/升级。
> 逐条对照自查即可；每条都标注了集成侧的机器检查（不满足时 build/verify 会在哪一步拒绝你）。

## 1. 可发现、可安装（Tabby 插件机制）

| 要求 | 说明 | 机器检查 |
|---|---|---|
| `package.json` 的 `keywords` 含 `"tabby-plugin"` | Tabby 据此发现插件 | `build`：componentState 直接报错 |
| `main` 指向 `dist/index.js`（或省略，默认即是） | 唯一入口约定 | `build`：构建后校验 dist/index.js 存在 |
| **`dist/` 必须是子目录**（不得把产物压平到包根） | 压平会破坏 main 解析 | `build`：安装后校验 `<pkg>/dist/index.js` |
| 包名唯一（建议 `tabby-` 前缀） | 同名包安装相互覆盖 | `build`：同名包查重 |

## 2. 版本与发布说明（版本事实 = 你的 package.json）

| 要求 | 说明 | 机器检查 |
|---|---|---|
| 发版 = package.json `version` 递增 + commit + push | 集成侧只认 package.json 版本，没有别的版本号要维护 | `release`：gitlink 远端可解析门禁 |
| `RELEASE_NOTES.md`（可选但强烈建议）`# v<版本>` 段落 | 每段 ≤ 8 行，进套件 CHANGELOG（`CHANGELOG.md` 的 `## <版本>` 段也可） | 无——缺了只是 changelog 少一条 |

## 3. 构建脚本（集成侧只跑标准脚本）

| 要求 | 说明 | 机器检查 |
|---|---|---|
| `npm run build` 产出 `dist/` | 标准构建入口 | `build` |
| `npm run test` / `npm run smoke`（有则必跑） | 多仓并行开发的第一道互不影响防线 | `build`：脚本存在即执行，失败即构建失败 |
| 依赖能被干净安装 | 无 lockfile 时依赖漂移风险自担（建议补 lockfile） | `build`：install 基线戳按 package.json+lock+flags 感知重装 |

## 4. 与集成仓的钉定纪律（唯一一条流程纪律）

**先子仓后父仓**：commit 后必须 `git push` 到你仓库的 main，TabbySuite 才能 release（父仓 gitlink 指向的 commit 必须在远端可解析）。
这条已机器化——`release` 门禁会逐仓检查，未 push 直接拒绝。

## 5. 集成侧的加菜（按需声明在 TabbySuite 的 bundle.yaml，不在你的仓）

这些是集成配方，属于套件内容配置，**不要**搬进插件仓：

- `install.flags`：旧代工具链放宽 peer 解析（如 `--legacy-peer-deps`）
- `payload`：规范工件（package.json + dist + README）之外的附加载荷（如 native addon 二进制）
- `probes` / `regression`：verify 的渲染层探针与回归挂钩（探针表达式依赖插件内部实现，归套件维护）

## 6. 接入 / 升级 / 退出

- **接入**（在 TabbySuite 仓）：`git submodule add <url> components/<dir>` + `bundle.yaml` 的 `integrate` 加一行 → `suitectl up`。
  收编状态随时 `suitectl component ls` 可查。
- **升级**：你仓 push 后，TabbySuite `suitectl up` 自动跟随（浮动）；release 时钉定。
- **调试插件**：方法论见本仓 `.claude/skills/tabby-plugin-debug`（隔离实例 + CDP 自动化，不打扰主实例）。

---

*契约变更走 TabbySuite 仓；本文件与 `tools/suitectl/lib/build.js` 的 adapter 实现一一对应。*
