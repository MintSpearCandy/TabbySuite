# TabbySuite 架构设计（v1.0 · v2 重构）

> 定位：Tabby 集成总装项目 —— 版本集成、滚动更新、便携版打包的单一事实来源。
> 形态：一个 git 仓库。8 个插件以 git submodule 收编在 `components/` 下，**开发直接在子仓内进行**。
> 远端：https://github.com/MintSpearCandy/TabbySuite（public）；子仓各自独立远端见 `.gitmodules`。
> 版本纪律一句话（v2 · 全浮动·发布即锁）：**日常零 commit——`up` 一键拉最新并构建；`release` 才上锁——自动钉定 gitlink + tag，任意历史版本可冷复原**。

---

## 0. 设计原则（精简 · 直观 · 可靠）

1. **全浮动·发布即锁**：`up` = sync 子仓最新 + core 查新 + build + verify，不要求任何 commit；serial 由 channel 派生（同 core 已发布最大 serial + 1），全自动。`release` 把当时的检出态钉进父仓 commit + tag `suite/<ver>`——可复现性由发布点保障，日常迭代零负担。
2. **目录即清单**：`components/` 里有什么、`integrate:` 列了什么，就集成什么。
3. **干净才能发布**：`release` 拒绝脏子仓（钉的是 commit，不是工作树；本地试验走 build/dev）。
4. **绿了才能出包 + 测啥压啥**：verify 不通过 release 拒绝；`.verify-passed` 记录 stage 树 hash，release 压包前复核——verify 测的树 == 将要出包的树。
5. **每个边界有 hash**：下载（zip sha256）、安装态（每插件 + core 的目录树 treeSha256）、doctor 全程校验。
6. **更新只有一条判断规则**：core 变了 → 整包换（rename dance）；core 没变 → 只换插件目录。
7. **开发与构建分离**：dev 族（长驻实例、脏树、秒级单插件部署）与 build/release 族互不越界——dev 永不产出 releases；硬链接只用于永不执行的树（core-cache→stage），会运行的实例一律实拷。
8. **内容配置与环境配置分离**：`bundle.yaml` 只描述"构建什么"；"本机怎么跑"（目录、端口、平台工具、**代理**）归环境配置层——默认值 ← `suitectl.config.yaml`（共享）← `suitectl.local.yaml`（本机，gitignore）← `TABBYSUITE_*` 环境变量。换机器不需要改仓库内容。
9. **系统工具优先，零重依赖**：打包/解包用系统 tar（Windows System32 bsdtar / macOS bsdtar；Linux 检测回退 unzip/zip），下载用系统 curl（`-x` 原生代理——Node fetch 不认 HTTP_PROXY，绕开）；依赖仅 `js-yaml`。

---

## 1. 总体架构

```
外部源头（只读）                      TabbySuite 仓库（唯一事实来源）
──────────────────                  ───────────────────────────────
Eugeny/tabby Releases ─► vendor/    bundle.yaml（core 版本与 pin / integrate 列表）
  （GitHub API 查最新，               components/*（8 子仓，gitlink；日常浮动，release 钉定）
   下载+sha256+自动登记）                   │
components/* 各自 GitHub 远端               ▼
        │                          suitectl up ──► cache/plugins/<pkg>@<commit>/（按 commit+配方 缓存）
        └── sync（分支安全快进）                    │
                                                  ▼
                                    build/stage/tabby-suite/（官方 zip 原样 + 规范插件 + profile 种子 + suite.json）
                                          │
                                  suitectl verify（隔离实例：boot + 插件全载断言 + 探针 + 回归挂钩；
                                                   .verify-passed 绑定 stage 树 hash）
                                          │ 绿
                                  suitectl release ──► 发布即锁（gitlink+bundle+releases → commit + tag）
                                          │             + releases/（zip + 插件 zip + SHA256SUMS + channel + CHANGELOG）
                                          │             + 上传 GitHub Releases（gh；资产含 channel.json）
                                          ▼
                                  目标机 suite-tools/suitectl.ps1（check / apply / rollback / doctor）
                                    插件级：下载变化插件 zip → sha256 → 原子换名（.backup 可回滚）
                                    core 级：全量 zip → .staging → rename dance（data/ 保留，.old 可回滚）
```

**日常回路（直观版）**：

```
改代码（components/X 内）→ 子仓 git commit → suitectl up（一键：sync+build+verify）→ dev deploy 看效果
发布：suitectl release（自动钉定子仓 gitlink + bundle + tag + 上传）
目标机：suitectl.ps1 check → apply → （必要时）rollback
```

---

## 2. 目录结构

### 2.1 项目（TabbySuite 仓库）

```
TabbySuite/
├─ README.md / ARCHITECTURE.md / CLAUDE.md   # 使用说明（使用者入口） / 本文档 / 工作手册
├─ bundle.yaml                   # 内容配置：core 版本与 pin / integrate / payload / probes / regression / rules
├─ suitectl.config.example.yaml  # 环境配置示例（复制为 suitectl.local.yaml；路径/端口/平台/代理）
├─ .gitmodules                   # 8 插件子仓 + reference/tabby（shallow）远端
├─ components/                   # 插件子仓 = 开发现场（8 个；7 integrate + 1 exclude）
├─ reference/tabby/              # Tabby 核心源码参考（shallow，钉 v<core 版本>；core 前进时自动重钉）
├─ profiles/base/                # config 种子 + 预置资源
├─ suite-tools/suitectl.ps1      # 目标机更新器（单一实现；CLI 的 update/doctor 转调；assemble 拷入分发物）
├─ tools/suitectl/               # CLI（Node ≥22，依赖仅 js-yaml）
│  └─ lib/（config/platform/util/hash/vendor/core/sync/build/verify/release/up/rollout/update/dev/env）
├─ vendor/                       # 官方 core zip 缓存 + index.json（file/sha256/origin；新版本自动登记）
├─ cache/                        # 工件缓存 cache/plugins/<pkg>@<commit>/ + install/ 安装基线戳（gitignore）
├─ build/                        # stage / core-cache / build-report / .verify-passed（gitignore）
├─ runtime/                      # verify（runtime/instance）与 dev（runtime/dev）隔离实例（gitignore）
└─ releases/                     # zip + 插件 zip + SHA256SUMS + update-channel.json + CHANGELOG.md
```

### 2.2 分发 zip（tar 引擎，带顶层目录）

```
tabby-suite-<core>-s<serial>-portable-x64.zip
└─ tabby-suite/                  # 解压出独立目录
   ├─ Tabby.exe / resources/ …   # 官方便携版原样，一字不动
   ├─ suite-tools/suitectl.ps1   # 更新器（check/apply/rollback/doctor）
   └─ data/                      # userData（portable 语义）
      ├─ config.yaml             # profile 种子（仅首次播种，此后归用户）
      ├─ suite/suite.json        # 安装态清单（含每插件/core 的 treeSha256——doctor 依据）
      └─ plugins/node_modules/<pkg>/   # 规范工件（package.json + dist/ 子目录 + README [+ payload]）
```

**归属规则**：updater 拥有 = `data/` 以外的全部 + `data/plugins/node_modules/<受管包>` + `data/suite/`；用户拥有 = `config.yaml`（播种后）、会话、热键等其余 userData，更新永不触碰。

---

## 3. 模块设计

### 3.1 版本策略（v2 核心：全浮动·发布即锁）

- **候选版本** = `<core>-s<serial>`，serial = 本地 channel 中该 core 已发布最大 serial + 1（无历史则 1）。build/verify/release 全用候选号；release 写 channel 后下一次 build 自然 +1。tag 冲突预检兜底 serial 回退（本地 channel 丢失时）。
- **浮动**：`sync` 后子仓 detached/分支于远端 tip，父仓 gitlink 漂移是**常态而非错误**——`build` 直接构建当前检出态，build-report 记录实际 commit。
- **钉定**：`release` 把漂移收拢成一个 commit（gitlink + bundle.yaml + releases 产物）+ tag `suite/<ver>`。`git clone --recursive && git checkout <tag>` 仍得到完全确定的构建输入。
- **core 前进**：bundle.yaml `core.pin: auto` 时 `up` 查 GitHub API（Eugeny/tabby latest release），有新版自动 `core use`：下载 portable zip → sha256 → **自动登记 vendor/index.json** → 回写 bundle.yaml core.version → 重钉 reference/tabby（fetch tag v\<新\> + checkout，同为待钉定漂移）。`pin: <版本>` 则锁定不自动前进。
- **无人值守滚动（rollout）**：`up` 是人工回路（每次必 build+verify），`rollout` 是调度回路（计划任务/cron）——sync + core 查新后，**core 无新版且子仓无前进 → 零动作退出（exit 0）**，有变化（或 --force）才 build+verify；`--release` 连带发布，门禁链原样生效（脏子仓/verify 红在此拒绝），父仓推送仍人工。变化判定靠信号不靠猜：sync 返回子仓拉动摘要、ensureLatestCore 返回 core 是否前进。定时跟进官方最新示例：`schtasks /Create /TN TabbySuite-Rollout /TR "node <repo>\tools\suitectl\cli.js rollout" /SC DAILY /ST 09:00`

### 3.2 构建与适配（唯一 adapter）

`build`，输入 = 子仓检出态，流程 = `npm install`（**按 package.json+lock+flags 的基线戳决定重装**，戳存 cache/install/ 不污染子仓）→ `npm run build` → 单测/冒烟（有则必跑，失败即 build 失败）→ 规范化 stage（sanitize package.json，保留 `keywords:["tabby-plugin"]`；dist 必须是子目录——压平破坏 main 解析）→ tar zip（带顶层 \<pkg\>/ 目录）。

- **缓存键 = commit + 配方**：`cache/plugins/<pkg>@<commit>/`，meta 记 `recipe`（payload/install flags/sanitize 字段的 hash）——bundle 配方变了同 commit 也重建；脏树构建不冒充干净构建。
- **core 解包缓存** `build/core-cache/<版本>/`（zip sha256 标记）→ 硬链接克隆进 stage（**硬链铁律**：只用于永不被执行的树；dev/verify 实例实拷）。
- **失败即失效**：assemble 中途失败会清掉 build-report 与 .verify-passed——绝不留旧凭证冒充当前 stage。
- 互斥校验：rules.mutuallyExclusive（TerminalWorkwench ↔ command-workbench）；组件同名包查重。

### 3.3 verify：发布门禁

stage 全新实拷为 `runtime/instance/`（instance.json 在实例目录内，自描述；CDP 端口 bind 探测），`ELECTRON_ENABLE_LOGGING=1` 启动捕获 stderr，四级断言：

1. **插件全载**：renderer console 的 `Loading <name>:` 行（Tabby 剥 `tabby-` 前缀；包名按字面转义匹配）；
2. **无致命 ERROR**（过滤已知良性，如 Jump List 花边）；
3. **CDP 探针**（bundle.yaml `probes:`）：渲染层表达式 === 期望（GlassTheme 探针含 `appearance.theme === 'Glass'`——s1 回归防复发）；
4. **回归挂钩**（`regression:`，enabled 才跑）：`CDP_PORT` 注入执行仓库自带脚本。

通过写 `build/.verify-passed`（**含 stageTreeHash**）；失败保留现场（实例目录 + `runtime/instance-boot.err`）。

### 3.4 release：发布即锁

门禁链（全部可显式跳过，各带 flag）：① 脏子仓拒绝（--allow-dirty）② verify 绿 + stage 树 hash 复核（--no-verify）③ tag 冲突预检 ④ gitlink 远端可解析——每个子仓 HEAD 必须 push 到其远端 main（--no-remote-check），同时列出本次将钉定的 gitlink 漂移。

产出：全量 zip（tar）→ SHA256SUMS（累积多版本）→ channel.json（v2 条目：每插件 zip/sha256/treeSha256 + **notes 原文入档**——CHANGELOG 重生成只依赖 channel 存档，不读子仓现状）→ CHANGELOG.md → **自动钉定**（git add bundle.yaml components releases/* → commit `release: <ver>` → tag）→ **上传 GitHub Releases**（gh：全量 zip + 每插件 zip + channel.json；--no-upload 跳过；代理自动注入 HTTPS_PROXY）。

releases 目录被移出仓库时拒绝钉定（--no-git 只出包+上传）。

### 3.5 滚动更新（G2 · 已实现，单一实现 ps1）

`suite-tools/suitectl.ps1`（目标机 Windows 自足；CLI 的 `update/doctor --dest` 转调同一脚本）：

- **channel 获取**：默认 `https://github.com/<repo>/releases/latest/download/channel.json`（GitHub 固定 URL，无需 API），资产 URL = channel.baseUrl + `/suite/<ver>/<file>`；`-ChannelUrl` 可指本地文件/自建源；`-Proxy http://127.0.0.1:7892` 走代理。
- **check**：比对本机 suite.json 与 channel 最新条目，列 core/插件差异。
- **apply（插件级，多数场景）**：进程占用检查（按 exe 路径，占用拒绝/-Force 杀）→ 下载变化插件 zip → sha256 校验 → 解 `.new` → 旧件入 `data/suite/.backup/<ts>/` → 原子换名 → 回写 suite.json → 提示重启。
- **apply（core 级）**：全量 zip 校验 → `.staging/` 解包 → rename dance（现有非 data 项 → `<root>.old/`，staging 就位；data/ 原地保留；旧 suite.json 快照入 `.old/_suite.json`）。
- **rollback**：`.old` 存在则 core 级回滚（反向 rename + 恢复快照），否则插件级从最新 `.backup/<ts>/` 恢复。
- **doctor**：重算每插件目录树 hash + core 树 hash（排除 data/）与 suite.json 比对，篡改/缺失逐项报告。
- **treeHash 算法**（Node `lib/hash.js` 与 ps1 `Get-TreeHash` 严格同构，已实测一致）：文件按 posix 相对路径 ordinal 排序，每行 `<文件sha256 小写>  <相对路径>` 以 `\n` 结尾，整体 utf8 文本的 sha256。

### 3.6 dev：长驻开发实例

`dev up`（stage 实拷 runtime/dev/，detached 启动长驻）/ `restart`（保端口）/ `down` / `status`；`dev deploy [组件…]`：默认脏组件，构建（复用缓存）+ 直拷进实例；**--restart 顺序为"先停 → 拷贝 → 再启动"**（运行中实例锁着已加载的 native addon，如 rdp_host.node，边跑边删必失败）。实例内 suite.json 同步记录部署态。dev 族永不产出 releases、永不写 .verify-passed。

### 3.7 环境解耦与代理（配置层 · 平台层 · vendor 获取）

- **环境配置**（`lib/config.js`）：优先级 代码默认值 ← `suitectl.config.yaml` ← `suitectl.local.yaml` ← `TABBYSUITE_*`。可覆盖 `paths.*`（vendor/cache/build/runtime/releases 可移出仓库）、`ports.cdp`、`platform.exe/powershell/npmShell`、**`net.proxy`**、`dist.repo`（GitHub 托管仓）、`vendor.autoDownload/downloadTimeoutSec`。
- **代理一等公民**：所有外网获取（GitHub API / core zip / channel / gh 上传 / ps1 更新器）统一走 `net.proxy`；临时切换 `TABBYSUITE_PROXY=http://127.0.0.1:7892`（空串=强制直连）。下载实现为系统 curl（`-x` 原生支持，绕开 Node fetch 不认 HTTP_PROXY 的限制）；gh 调用注入 HTTPS_PROXY；ps1 用 `Invoke-WebRequest -Proxy`。CDP 等 127.0.0.1 流量不经此层。
- **平台能力层**（`lib/platform.js`）：tar zip/unzip（Windows 显式优先 System32 bsdtar——PATH 前部的 Git Bash GNU tar 不识 zip）、curl fetchUrl/getJson、PowerShell 进程管理、npm、按路径杀/数进程、CDP bind 探测集中于此。
- **vendor 获取**（`lib/vendor.js`）：index.json 只记 file/sha256/origin；新版本由 `core use` 下载后**计算** sha256 自动登记（信任锚 = GitHub 官方 Releases；release 钉定时随父仓落库）。`--offline` 全局禁网。
- **预检**：`suitectl env`（--json）一次列出缺什么怎么补（node/git/子仓/tar/curl/gh/代理状态/目录/端口/core zip）。

---

## 4. 数据模型

### 4.1 bundle.yaml（唯一内容配置：构建什么）

```yaml
suite: { name: tabby-suite }
core:
  version: 1.0.237        # 当前构建 core（pin:auto 时 up 自动前进并回写；随 release 钉定落库）
  pin: auto               # auto=跟随官方最新 | 写死版本=锁定
profile: base
integrate:  [WebViewer, HotkeyGuard, GlassTheme, Filter, BetterConfiger, TerminalWorkwench, ActivxRDPClient]
exclude:    [tabby-command-workbench]   # 第三方，与 TerminalWorkwench 互斥
install:    { WebViewer: { flags: [--legacy-peer-deps] }, … }
payload:    { ActivxRDPClient: [native] }   # 规范工件之外的附加载荷
probes:     { GlassTheme: [...] }           # verify ③
regression: { WebViewer: { script: recorderTest.js, cwd: WebViewer/scripts, enabled: false } }
rules:      { mutuallyExclusive: [[tabby-terminal-workwench, tabby-command-workbench]] }
```

serial **不在本文件**——由 channel 派生（见 §3.1）。环境配置（路径/端口/代理/平台工具）不在本文件，见 §3.7。

### 4.2 channel.json（发布侧，随 GH Releases 分发）与 suite.json（安装态）

```jsonc
// releases/update-channel.json（release 时生成/追加；同时作为 release 资产上传）
{
  "latest": "1.0.238-s1",
  "baseUrl": "https://github.com/MintSpearCandy/TabbySuite/releases/download",
  "releases": {
    "1.0.238-s1": {
      "core": "1.0.238", "zip": "tabby-suite-1.0.238-s1-portable-x64.zip", "sha256": "…",
      "plugins": { "tabby-webviewer": { "version": "0.4.10", "commit": "…", "zip": "tabby-webviewer-0.4.10.zip", "sha256": "…", "treeSha256": "…" } },
      "notes": ["tabby-webviewer 0.4.10 @6b0a450c\n<RELEASE_NOTES 摘录>"],
      "releasedAt": "…"
    }
  }
}
```

```jsonc
// 分发物 data/suite/suite.json（updater 维护；doctor 的比对基准）
{
  "suiteVersion": "1.0.238-s1", "exe": "Tabby.exe",
  "channel": "https://github.com/MintSpearCandy/TabbySuite/releases/latest/download/channel.json",
  "core":    { "version": "1.0.238", "zipSha256": "…", "treeSha256": "…" },
  "plugins": { "tabby-webviewer": { "version": "0.4.10", "commit": "…", "zip": "…", "zipSha256": "…", "treeSha256": "…" } }
}
```

---

## 5. 关键决策（ADR）

| # | 决策 | 理由 |
|---|---|---|
| 1 | **发布即锁**（v2 修订）：日常浮动构建，release 自动钉定 gitlink+bundle+tag | "一键同步最新并构建"与"可复现"不冲突——复原性由发布点保障，日常零 commit 负担 |
| 2 | 开发整体迁入 components/ 子仓 | 开发现场与集成输入合一，回路最短 |
| 3 | 唯一 adapter，不复用 `package:install` | 7 仓统一从源码构建，行为一致可复现；安装只是拷贝 |
| 4 | core 官方 zip 原样分发，定制只进 `data/` 与 `suite-tools/` | 免 asar 维护，core 升级零成本 |
| 5 | flat 布局 + zip 带顶层 `tabby-suite/` 目录 | 解压即得独立目录；回滚用 `.backup` / `<root>.old` |
| 6 | 自建 updater（ps1）+ 种子禁用内置自动更新 | keygen 通道只更新 core 且不受控 |
| 7 | 更新单规则两路径（core 变→整包 rename dance；否则→插件目录换名） | 插件更新占 95% 且实现极简 |
| 8 | 版本事实 = 各仓库 package.json；套件版本 serial 由 channel 派生 | 发布记录即 git 历史；serial 全自动，杜绝手改 bundle 出错 |
| 9 | Node CLI + js-yaml + 系统工具（tar/curl/PowerShell） | 零新依赖面；tar 消除 Compress-Archive 隐藏文件/长路径隐患；curl 原生代理 |
| 10 | 子仓远端独立维护，先子仓后父仓 | 集成是消费关系；release gitlink 门禁把口头纪律变机器检查 |
| 11 | reference/tabby 浅子仓钉 v\<core\>，core 前进自动重钉 | 参考版本与构建 core 同版由 build 校验 |
| 12 | 开发/构建双轨制；硬链仅限永不执行的树 | 迭代速度与发布纪律互不妥协 |
| 13 | 内容/环境配置分离；**代理为环境配置一等公民** | 仓库跨机可复现；各机代理只进 local.yaml/环境变量，不入库 |
| 14 | channel/更新包托管 GitHub Releases；更新器用固定 URL 拉 channel | 仓库已 public 天然带 CDN；`releases/latest/download/channel.json` 免 API 免限流 |
| 15 | 更新器单一实现（ps1），CLI update/doctor 转调 | 不写第二份逻辑，分发物与构建机行为一致 |
| 16 | treeHash（Node/ps1 同构算法）作为安装态完整性基准 | doctor 可校验目录树而非仅 zip；verify 与 release 用同一指纹绑定 |
| 17 | notes 原文入 channel 存档，CHANGELOG 只从 channel 重生成 | 历史不可漂移——子仓重构 notes 不影响已发布版本的 changelog |

---

## 6. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 旧代工具链（TS 4.2 / NG7）在高版本 Node 构建未实证 | build 记录每仓 Node 版本；必要时按仓固定构建 Node |
| R2 | 多数仓库无 lockfile，构建依赖可能漂移 | 安装基线戳感知 package.json 变化；逐步补 lockfile |
| R3 | 禁用内置自动更新的静默键未完全实证 | `application.updateAutomatically: false` 已实证保留且无落盘；日志仍有 Checking for updates |
| R4 | 更新须应用完全退出（Windows 文件锁） | ps1 apply 前置按 exe 路径检测进程，占用拒绝（-Force 显式杀） |
| R5 | 磁盘占用（vendor/cache/releases/runtime × 套件） | 手工清理 + 后续 doctor --gc |
| R6 | GitHub API 限流（60 req/h 未认证） | up 每次仅 1 次查询；core use 可带版本直下 |
| R7 | GitHub 不可达（网络环境） | 代理一等公民（net.proxy / TABBYSUITE_PROXY / ps1 -Proxy）；失败给手工放置指引 |
| R8 | core 前进引入不兼容（种子键/插件 peerDeps） | up 必跑 verify 四级断言；probes 覆盖种子键生效性 |

---

## 7. 实施路线（v2）

| 阶段 | 内容 | 状态 |
|---|---|---|
| v1 P0–P2（2026-10-07~19） | 收编/MVP 出包/门禁自动化/环境解耦（详见 git 历史） | ✅ |
| **v2 重构（本版）** | 全浮动·发布即锁；core 最新自动获取登记；tar/curl 系统工具引擎；代理一等公民；GH Releases 托管 + channel v2；ps1 更新器完整闭环（check/apply 两路径/rollback/doctor）；v1 缺陷审查的修复（缓存配方键/安装基线戳/stage hash 绑定/serial 派生/latest 比较/CHANGELOG 存档化/dev deploy 顺序等） | ✅ 2026-10-20 |
| 后续 | WebViewer 回归挂钩启用（待 fixture 种子化）；doctor --gc；Linux 打包路径实证 | |

---

*更新记录：v0.1–v0.6 见 git 历史（v0.6 为环境解耦）。v1.0（2026-10-20）v2 重构落地——设计原则从"父仓 commit 即锁"演进为"全浮动·发布即锁"，新增 core 自动查新/登记、tar 打包引擎、代理层、GH Releases 托管、目标机更新器完整闭环；同步修复 v1 缺陷审查发现的全部高危项。treeHash Node/ps1 同构性、tar 往返保真（含隐藏文件）、代理/直连双模式已实测。*
