# TabbySuite 架构设计（v0.4）

> 定位：Tabby 集成总装项目 —— 版本集成、滚动更新、便携版打包的单一事实来源。
> 形态：一个 git 仓库。7 个插件以 git submodule 收编在 `components/` 下，**开发直接在子仓内进行**（原 TabbyPlugins/ 归档退役）。
> 远端：https://github.com/MintSpearCandy/TabbySuite（private）；7 子仓各自独立远端见 `.gitmodules`，互不侵入。
> 版本纪律一句话：**父仓的 commit/tag 就是锁** —— 它钉死每个子仓的 gitlink 和 bundle.yaml，无需任何 lock 文件。

---

## 0. 设计原则（精简 · 直观 · 可靠）

1. **父仓即锁**：`git clone --recursive && git checkout <tag>` 得到完全确定的构建输入。没有 lock 文件、没有双状态、没有"漂移"问题。
2. **目录即清单**：`components/` 里有什么、`integrate:` 列了什么，就集成什么。
3. **干净才能发布**：`release` 拒绝脏子仓（本地试验走 build，发布必须落 commit）。
4. **绿了才能出包**：verify 不通过，release 拒绝执行。
5. **每个边界有 hash**：下载、缓存命中、安装、doctor 全程 SHA256 校验。
6. **更新只有一条判断规则**：core 变了 → 整包换；core 没变 → 只换插件目录。

---

## 1. 背景与问题

### 1.1 现状盘点（2026-10-06 实测）

| 层 | 现状 |
|---|---|
| 插件仓库 ×7 | `TabbyPlugins\{WebViewer, HotkeyGuard, GlassTheme, Filter, BetterConfiger, TerminalWorkwench, tabby-command-workbench}`，全部独立 git 仓库（GitHub 远端；command-workbench 为第三方 rookie0422） |
| 打包方式 ×3 | ① zip 流水线（WebViewer / Filter / BetterConfiger：`scripts/package.js`）② 无 zip（HotkeyGuard 只 stage 目录；GlassTheme 仓库根手工产物）③ npm tgz（TerminalWorkwench / command-workbench） |
| 工具链 ×2 代 | 旧代（WebViewer / Filter / HotkeyGuard：TS 4.2 + Angular 7 devDeps）与新代（其余：TS 4.9–5.4 + Angular 15）并存；tabby-core devDeps 锁定不一（exact / caret / `*`） |
| 核心来源 | 官方便携版 zip（eugeny/tabby GitHub Releases）；`D:\Env\TabbyEnv\` 已缓存 1.0.234/235/237（167–186 MB/个） |
| 调试环境 | `D:\Env\TabbyEnv\instances\{main,wv,bc,twx}`，自描述 `instance.json`（name/port/vendor），CDP 端口 9231 起分配 |
| 真实安装 | `D:\App\Tabby`（keygen/electron-updater 自动更新 core，见 `resources\app-update.yml`——与自管更新冲突，需禁用） |

### 1.2 痛点

1. 无统一版本视图："哪个 core × 哪组插件被验证过可共存"只存在于人脑记录。
2. 打包不统一：出一份全家桶便携版要手工跑 3 套流程；`package:install` 在 4 仓库行为不一致（Filter 硬编码 `~/.taby/plugins`），3 仓库缺失。
3. 更新纯手工：内置 updater 只管 core 不管插件；插件升级靠拷贝，无回滚。
4. 分发不可复现、无校验。

---

## 2. 目标与非目标

**目标**：G1 版本集成（一份清单+流水线产出可复现套件）；G2 滚动更新（自管、可回滚）；G3 便携打包（解压即用 zip + 校验）；G4 复用现有资产（TabbyEnv instance 模式、各仓库 smoke/回归脚本）。

**非目标**：不做插件市场；不改 Tabby core 本体（asar 不动）；无对外 CI/CD（本地优先）；不做插件热更新（插件双进程加载，"滚动"= 分阶段+可回滚，非热替换）。

---

## 3. 核心概念

| 概念 | 定义 |
|---|---|
| **Suite（套件）** | 一次完整分发 = 官方 core portable + 插件集 + profile 种子配置。版本号 `<core>-s<serial>`（如 `1.0.237-s1`） |
| **Component** | `components/<dir>` 的 git submodule 检出场 = 开发现场 + 集成输入，二者合一。其版本 = 父仓记录的 gitlink |
| **规范工件** | 插件的统一产物形态：`{ sanitized package.json, dist/（子目录）, README }` + 版本化 zip。三种上游打包风格统一到它 |
| **Profile** | `profiles/base/` 的 config 种子（禁用内置自动更新等），仅首次安装播种，此后归用户 |
| **Channel** | `releases/update-channel.json`：发布侧版本索引（最新套件、每版组件清单+hash） |
| **安装态** | 分发物内 `data/suite/suite.json`：已装套件版本、core/插件 hash——update/doctor/回滚的依据 |

---

## 4. 总体架构

```
外部源头（只读）                    TabbySuite 仓库（唯一事实来源）
──────────────────                ───────────────────────────────
eugeny/tabby Releases ──► zip     bundle.yaml（core 版本 / serial / integrate 列表）
components/* 各自 GitHub 远端      components/*（7 子仓，gitlink 钉版本，开发即在此）
        │                                │
        ▼                                ▼
   vendor/（zip 缓存+hash）      suitectl build ──► cache/plugins/<pkg>@<commit>/（按 commit 缓存）
                │                       │
                └───────► build/stage/<suite>/（官方 zip 原样 + 规范插件 + profile 种子 + suite.json）
                                        │
                                suitectl verify（隔离实例：boot + 插件全载断言 + 可选回归）
                                        │ 绿
                                suitectl release ──► 父仓 tag suite/<ver> + releases/
                                        │                （zip + SHA256SUMS + update-channel.json + CHANGELOG）
                                suitectl update / doctor（目标机：更新 + 回滚 + 完整性核对）
```

**日常回路（直观版）**：

```
改代码（components/X 内）→ 子仓 git commit → 父仓 git add components/X && git commit（= 完成一次集成钉版）
→ suitectl build → suitectl verify → suitectl release

拉各远端最新：suitectl sync（submodule update --remote + 变更摘要）→ 父仓 commit gitlink → build …
```

---

## 5. 目录结构

### 5.1 项目（TabbySuite 仓库）

```
TabbySuite/
├─ ARCHITECTURE.md             # 本文档
├─ bundle.yaml                 # core 版本 / serial / integrate 列表（唯一人工配置）
├─ .gitmodules                 # 7 子仓远端（统一 https；代理场景本地 url.insteadOf 覆写）
├─ components/                 # 插件子仓 = 开发现场（node_modules 等由各子仓自身 .gitignore 管）
│  ├─ WebViewer/  HotkeyGuard/  GlassTheme/  Filter/
│  ├─ BetterConfiger/  TerminalWorkwench/
│  └─ tabby-command-workbench/ # 第三方，exclude，pinned v1.2.5
├─ profiles/base/              # config 种子 + 预置资源
├─ tools/                      # suitectl CLI（Node，依赖仅 js-yaml）
├─ vendor/                     # 官方 core portable zip 缓存 + index.json（hash/origin）
├─ cache/                      # 规范工件缓存 cache/plugins/<pkg>@<commit>/（gitignore）
├─ build/                      # assemble 暂存（gitignore）
├─ runtime/                    # verify 隔离实例（instance.json 兼容 TabbyEnv；gitignore）
└─ releases/                   # 产物 zip + SHA256SUMS + update-channel.json + CHANGELOG.md
```

### 5.2 分发 zip（解压即用，flat 便携布局）

```
tabby-suite/                     # 解压到任意目录即可运行
├─ Tabby.exe / resources/ …      # 官方便携版原样，一字不动
├─ suite-tools/                  # suitectl.ps1（update / rollback / doctor 精简入口）
└─ data/                         # userData（portable 语义）
   ├─ config.yaml                # profile 种子（仅首次播种）
   ├─ suite/suite.json           # 安装态清单
   └─ plugins/node_modules/<pkg>/# 规范工件（package.json + dist/ 子目录 + README）
```

**归属规则**：updater 拥有 = `data/` 以外的全部 + `data/plugins/node_modules/<受管包>` + `data/suite/`；用户拥有 = `config.yaml`（播种后）、会话、热键等其余 userData，更新永不触碰。

---

## 6. 模块设计

### 6.1 components/：子仓即开发现场

- 收编：`git submodule add <url> components/<dir>`（7 个，含第三方 tabby-command-workbench，checkout v1.2.5 后提交 gitlink，列入 exclude）。
- **开发就在子仓里**：改码、commit、push 与普通仓库无异；父仓 `git add components/X && git commit` 即把该版本钉入套件——这就是"集成"的全部动作。
- `suitectl sync` = `git submodule update --remote`（按 .gitmodules branch 前进到远端最新）+ 打印每仓 old→new 摘要 + 提示提交 gitlink。第三方 exclude 仓不做 --remote，只手工显式升级。
- **缓存与复现**：规范工件缓存键 = `<pkg>@<gitlink commit>`；脏工作树不走缓存、直接重建，且 `release` 一律拒绝（原则 3）。
- core 不子仓化：官方 portable zip 即分发形态，自建 Electron 成本高收益为负。

### 6.2 构建与适配（唯一 adapter）

`component-build`，输入 = 子仓检出态，流程 = `npm install`（尊重各仓 `.npmrc`，如 GlassTheme 的 `legacy-peer-deps`）→ `npm run build`（webpack 或 tsc，按仓库）→ 规范化 stage（sanitize package.json，保留 `keywords:["tabby-plugin"]`）→ zip。

铁律（踩过的坑，自动校验）：
- **dist/ 必须是 package.json 旁的子目录**——压平会导致 `main` 解析失败（TWX CLAUDE.md 实证）；
- **不复用各仓库 `package:install`**（行为不一致、Filter 硬编码错路径、3 仓库缺失）——安装只是把规范工件拷进 `data/plugins/node_modules/<pkg>/`；
- assemble = 官方 zip 解包（原样）+ 拷入全部启用组件的规范工件 + 播种 profile + 写 suite.json。

互斥校验：TerminalWorkwench 与 command-workbench 互为继任（前者一次性导入后者配置），同时集成直接报错。WebViewer↔HotkeyGuard 已有显式兼容代码，默认同装（与 main 实例一致）。

### 6.3 verify：发布门禁（P2 已实现）

`suitectl verify` 把 stage 全新拷贝为 `runtime/instance/`（TabbyEnv 同构 `instance.json`；CDP 端口在 9241–9268 内 **bind 探测**分配——Windows 保留段随重启漂移，2026-10-07 实测 9249–9348 整段不可绑、9251 报 WSAEACCES），以 `ELECTRON_ENABLE_LOGGING=1` 启动并捕获 stderr，四级断言：

1. **插件全载**：renderer console 的 `Loading <name>:` 行——Tabby 会剥 `tabby-` 前缀（日志是 `Loading glass-theme:` 而非包名）；`data/log.txt` 不含插件行，不作信号源；
2. **无致命 ERROR**：过滤已知良性（Jump List 隐私设置花边；terminal-workwench 的 vm module 警告是 INFO 不拦截）；
3. **CDP 探针**（bundle.yaml `probes:`）：渲染层任意表达式 === 期望——GlassTheme 探针含 `appearance.theme === 'Glass'`（s1 "主题不加载"回归的防复发：GlassTheme 是不接管配置的常规主题，须 profile 种子 `appearance.theme: Glass` 显式选中）；
4. **回归挂钩**（bundle.yaml `regression:`，`enabled: true` 才跑）：`CDP_PORT` 注入执行仓库自带脚本（WebViewer `recorderTest.js` 依赖 wv fixture 基线，种子化前保持 disabled）。

通过写 `build/.verify-passed`（含 suiteVersion，release 校验版本匹配防过期）；**失败保留现场**（实例目录 + `runtime/instance-boot.err`），直接进 tabby-debug 流程定位。

### 6.4 release：出包即打 tag

前置：`build/.verify-passed` 版本匹配（P2 门禁已实现，`--no-verify` 显式跳过）+ 全部子仓干净 + bundle.yaml serial 递增。产出：
- `releases/tabby-suite-<core>-s<serial>-portable-x64.zip`
- `SHA256SUMS`、`update-channel.json`（见 §7）、`CHANGELOG.md`（自各仓 `RELEASE_NOTES.md` `# v<ver>` 段 / `CHANGELOG.md` `## <ver>` 段抽取对应版本段落，至多 8 行，无则从略）；
- 父仓打 annotated tag `suite/<core>-s<serial>` —— **tag 即发布记录**，日后按 tag 冷复原重建（`git clone --recursive` → checkout tag → build，产物 hash 应一致）。

### 6.5 滚动更新（G2）

**一条规则**：比对 `data/suite/suite.json` 与 channel 最新条目——core 版本变 → 路径 B；否则 → 路径 A。

**路径 A · 插件级**（多数场景）：下载变化插件的规范 zip → SHA256 校验 → 解到 `<pkg>.new` → 原子换名（旧件入 `data/suite/.backup/<ts>/`）→ 更新 suite.json → 提示重启（无热替换）。

**路径 B · core 级**：前置检测目标目录 Tabby.exe 进程已退出（按可执行文件路径匹配，占用即拒绝）→ 新 zip 解到 `<root>.staging/`（剔除 data/）→ rename dance：现有非 data 项 → `<root>.old/`，staging 项就位 → data/ 迁移（变化插件走路径 A；config.yaml 不动）→ 成功启动后 GC `<root>.old`。

**回滚 = 一条命令**：`suitectl update --rollback` 从 `.backup/`（A）或 `<root>.old`（B）恢复并回写 suite.json；备份保留至下一次成功 doctor。

**与内置 updater 的冲突**：profile 种子显式关闭 Tabby 自动更新（确切 config 键在 P3 隔离实例实证后写死，候选 `application.updateAutomatically: false`）。

### 6.6 CLI（6 个动词）

```
suitectl sync      # 子仓拉远端最新 + 变更摘要（= submodule update --remote）
suitectl build     # core zip 就位 + 全部 integrate 组件构建（按 commit 缓存）+ assemble 到 build/stage/
suitectl verify    # 隔离实例三级断言；失败保留现场
suitectl release   # verify 绿 + 子仓干净 → zip + SHA256SUMS + channel + CHANGELOG + 父仓 tag
suitectl update    # 目标机更新：--check / --apply / --rollback（随包分发精简版 suitectl.ps1）
suitectl doctor    # 安装态核对（suite.json hash vs 实文件、进程探活）；--gc 清理旧备份/缓存
```

实现：Node ≥22、Plain JS、依赖仅 `js-yaml`；zip/解压走 PowerShell `Compress-Archive` / `Expand-Archive`（与现有 package.js 同路线）；hash 用 `node:crypto`。

---

## 7. 数据模型

### 7.1 bundle.yaml（唯一人工配置，极简）

```yaml
suite:
  name: tabby-suite
  serial: 1                      # 发布序号，出包时递增
core:
  version: 1.0.237               # 官方 portable 版本（vendor 按此取 zip）
profile: base
integrate:                       # 参与集成的子仓；版本 = 各自 gitlink（父仓 commit 即锁）
  [WebViewer, HotkeyGuard, GlassTheme, Filter, BetterConfiger, TerminalWorkwench]
exclude: [tabby-command-workbench]   # 已收编不集成（第三方，与 TerminalWorkwench 互斥）
regression:                      # 可选：verify 第三级挂钩（cwd 相对 components/）
  WebViewer: { script: recorderTest.js, cwd: WebViewer/scripts }
```

### 7.2 发布侧 update-channel.json 与 安装态 suite.json

```jsonc
// releases/update-channel.json（release 时生成/追加）
{
  "latest": "1.0.237-s1",
  "releases": {
    "1.0.237-s1": {
      "core": "1.0.237",
      "zip": "tabby-suite-1.0.237-s1-portable-x64.zip",
      "sha256": "…",
      "plugins": { "tabby-webviewer": { "version": "0.4.9", "sha256": "…" } }
    }
  }
}
```

```jsonc
// 分发物 data/suite/suite.json（updater 维护）
{
  "suiteVersion": "1.0.237-s1",
  "core":    { "version": "1.0.237", "sha256": "…" },
  "plugins": { "tabby-webviewer": { "version": "0.4.9", "sha256": "…" } },
  "updatedAt": "2026-10-06T20:00:00+08:00"
}
```

---

## 8. 关键决策（ADR）

| # | 决策 | 理由 |
|---|---|---|
| 1 | **父仓 commit/tag 即锁**，无 lock 文件 | gitlink 天生版本化于父仓；消灭 lock/gitlink 双态与漂移问题；冷复原 = clone --recursive + checkout tag |
| 2 | **开发整体迁入 components/ 子仓**，TabbyPlugins/ 归档退役 | 开发现场与集成输入合一，回路最短：子仓 commit → 父仓 commit gitlink = 集成 |
| 3 | 唯一 adapter `component-build`，不复用 `package:install` | 7 仓统一从源码构建，行为一致、可复现；安装只是拷贝 |
| 4 | core 官方 zip **原样分发**，定制只进 `data/` 与 `suite-tools/` | 免 asar 维护，core 升级零成本，跟随官方分发形态 |
| 5 | flat 便携布局（不做 versions/ 并列目录） | 与官方便携版/用户习惯一致；回滚用 `.backup` / `<root>.old` 达成 |
| 6 | **自建 updater** + 种子配置禁用内置自动更新 | keygen 通道只更新 core 且不受控，与自管滚动更新冲突 |
| 7 | verify 实例 schema 兼容 TabbyEnv `instance.json` | 不污染调试环境；tabby-debug skill 与既有 CDP 脚本直接复用 |
| 8 | 更新单规则两路径（core 变→整包；否则→插件目录） | 插件更新占 95% 且实现极简；core 更新天然走完整包，无增量补丁复杂度 |
| 9 | 版本事实 = 各仓库 `package.json`；套件版本 = `<core>-s<serial>`；发布 = 父仓 tag | 尊重仓库现状；发布记录即 git 历史 |
| 10 | Node CLI + `js-yaml` + PowerShell 原语 | 与全部现有脚本同栈，零新依赖面 |
| 11 | **集成仓独立上 GitHub**（private）；子仓远端不变、各自独立维护 | 集成是消费关系而非吞并——父仓只持 gitlink；**子仓本地提交必须先推各自远端，gitlink 才全局可解析**（`clone --recursive` 完整性前置；日常推送顺序：先子仓后父仓） |

---

## 9. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 旧代工具链（TS 4.2 / NG7 / awesome-typescript-loader）在高版本 Node 下构建未实证 | build 记录每仓 Node 版本；必要时按仓固定构建 Node |
| R2 | 多数仓库无 lockfile，构建依赖可能漂移 | 缓存键含 package.json hash；逐步给各子仓补 lockfile 后即严格复现 |
| R3 | 禁用内置自动更新的确切 config 键未实证 | **部分实证（2026-10-07）**：`application.updateAutomatically: false` 键被 Tabby 重写保留、且无任何更新落盘痕迹（未自装）；但启动仍会 "Checking for updates / Update available" 日志。P3 继续找完全静默键 |
| R4 | 更新须应用完全退出（Windows 文件锁）；多实例并存 | update 前置按可执行文件路径检测进程；CDP 探活辅助 |
| R5 | 磁盘占用（每套件解压 ~250 MB × vendor/cache/releases/runtime） | `doctor --gc`（备份/缓存/旧 zip 保留 N=2） |
| R6 | 第三方 tabby-command-workbench 源安全 | gitlink 钉 tag + 产物 hash 校验；默认 exclude |
| R7 | config.yaml schema 随 core 演进，种子键可能失效 | verify 断言种子键在目标 core 生效；升 core 必跑 verify |

---

## 10. 一次性迁移（TabbyPlugins → components/）

1. **清点待迁移状态**：WebViewer / BetterConfiger 有脏文件（调试脚本为主）——有价值者先 commit+push；Filter package.json 0.5.7 领先最后 tag v0.5.5，确认是否已推送。
2. `git init` TabbySuite → 7 × `git submodule add <https 远端> components/<dir>` → command-workbench checkout `v1.2.5` → 提交 gitlink 与 `.gitmodules`。
3. **skills 随迁**：`TabbyPlugins\.claude\skills\*` → `TabbySuite\.claude\skills\`（改写内含路径）；各仓库 `.claude/`、`test-env/` 若为未入库内容则手工拷入对应子仓。
4. **更新 tabby-debug skill 的 ENVIRONMENT.md**：插件项目根 `D:\Home\Project\TabbyPlugins\…` → `D:\Home\Project\TabbySuite\components\…`；实例清单补记 `runtime/instance`（CDP 9250+）。
5. vendor 导入：把 `D:\Env\TabbyEnv\tabby-1.0.23{4,5,7}-portable-x64.zip` 登记（拷贝或登记路径）进 `vendor/index.json`。
6. `TabbyPlugins/` 改名 `TabbyPlugins.archive/` 只读保留，稳定一个迭代周期后删除。

---

## 11. 实施路线

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P1 收编+MVP 出包** | §10 迁移 1–5 + bundle.yaml + `component-build` + build/assemble + release（verify 先手动） | ✅ **2026-10-07 完成**：`tabby-suite-1.0.237-s1-portable-x64.zip` 已发布（tag `suite/1.0.237-s1`），验收实例 6/6 插件全载（renderer console `Loading` 行实证），core 文件零改动 |
| **P2 门禁自动化** | verify 实例工厂（boot/全载/回归挂钩）+ 按 commit 缓存 + CHANGELOG 汇总 + `sync` | ✅ **2026-10-07 完成**：verify 四级断言 + release 门禁 + changelog 抽取落地，s2 为首个过门禁版本（顺带修复 cmpVer 二条目比较 bug）。剩余：WebViewer 回归挂钩启用（待 wv fixture 种子化） |
| **P3 滚动更新** | update-channel + suite-tools（两路径 + rollback + doctor）+ 内置更新禁用实证（R3） | s1→s2 走插件级免重装 core；注入损坏工件能回滚；doctor 能发现篡改 |
| **P4 可选演进** | dev/stable 双通道、GitHub Releases 作 channel 源、`D:\App\Tabby` 迁移为套件实例、定时检查 | 按需定义 |

---

*更新记录：v0.1（2026-10-06）初版；v0.2 引入 components/ 子仓 + lock/gitlink 双态；v0.3（2026-10-06）简化重构——开发整体迁入子仓（TabbyPlugins 退役）、废除 lock 文件与双态（父仓 commit/tag 即锁）、ref 三语义与 resolve 阶段移除、adapter 收敛为唯一 `component-build`、CLI 收敛为 6 动词、新增一次性迁移清单；v0.3.1（2026-10-07）P1 落地实证回填——verify 信号源定为 renderer console（ELECTRON_ENABLE_LOGGING）、CDP 端口需 bind 探测、R3 部分实证、s1 发布；v0.4（2026-10-07）P2 落地——verify 四级断言实例工厂 + release 门禁 + changelog 抽取，s1 GlassTheme "主题不加载"回归定位（常规主题须 profile 种子选中，`appearance.theme: Glass`）并修复于 s2；v0.4.1（2026-10-07）集成仓上 GitHub（private）+ 子仓 lockfile 提交推送，ADR #11。*

*附：环境事实以 2026-10-06 为准，变化请同步更新 §1.1 与 §6.3。*
