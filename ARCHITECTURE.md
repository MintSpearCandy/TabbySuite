# TabbySuite 架构设计（v4 · 平台组件架构 · 纯集成发布仓）

> 定位：Tabby 集成发布仓 —— 版本集成、验证、发布的单一事实来源。**插件开发在各插件独立仓进行**，本仓是纯集成消费方，无开发轨道。
> 形态：一个 git 仓库。7 个插件以 git submodule 收编在 `components/` 下（各自独立远端，见 `.gitmodules`）。
> 套件模型：**套件 = 平台组件（Tabby core，官方 zip，版本可切换）+ 插件组件（components/ 子仓）+ profile 种子**。
> 远端：https://github.com/MintSpearCandy/TabbySuite（public）。
> 版本纪律一句话：**日常零 commit——`up` 一键拉最新并构建；`release` 才上锁——自动钉定 gitlink + tag，任意历史版本可冷复原**。

---

## 0. 设计原则（精简 · 直观 · 可靠）

1. **全浮动·发布即锁**：`up` = sync 子仓最新 + 平台查新 + build + verify，不要求任何 commit；serial 由 channel 派生（同平台版本已发布最大 serial + 1），全自动。`release` 把当时的检出态钉进父仓 commit + tag `suite/<ver>`——可复现性由发布点保障，日常迭代零负担。
2. **目录即清单，且按生命周期分区**：输入（`components/` + `platform/index.json` + `profiles/` + `tools/`）→ 状态（`.work/`，整体 gitignore、可整体删除重建）→ 产物（`releases/`）。`components/` 里有什么、`integrate:` 列了什么，就集成什么。
3. **干净才能发布**：`release` 拒绝脏子仓（钉的是 commit，不是工作树；本地试验走 build）。
4. **绿了才能出包 + 测啥压啥**：verify 不通过 release 拒绝；`.verify-passed` 记录 stage 树 hash，release 压包前复核——verify 测的树 == 将要出包的树。
5. **每个边界有 hash**：下载（zip sha256）、安装态（每插件 + 平台的目录树 treeSha256）、doctor 全程校验。
6. **更新只有一条判断规则**：平台变了 → 整包换（rename dance）；平台没变 → 只换插件目录。
7. **内容配置与环境配置分离**：`bundle.yaml` 只描述"构建什么"（平台组件版本 + 插件清单）；"本机怎么跑"（目录、端口、宿主工具、**代理**）归环境配置层——默认值 ← `suitectl.config.yaml`（共享）← `suitectl.local.yaml`（本机，gitignore）← `TABBYSUITE_*` 环境变量。换机器不需要改仓库内容。
8. **系统工具优先，零重依赖**：打包/解包用系统 tar（Windows System32 bsdtar / macOS bsdtar；Linux 检测回退 unzip/zip），下载用系统 curl（`-x` 原生代理——Node fetch 不认 HTTP_PROXY，绕开）；依赖仅 `js-yaml`。

---

## 1. 总体架构

```
外部源头（只读）                      TabbySuite 仓库（唯一事实来源）
──────────────────                  ───────────────────────────────
Eugeny/tabby Releases ─► platform/  bundle.yaml（平台组件版本与 pin / integrate 列表）
  （GitHub API 查最新，               components/*（7 子仓，gitlink；日常浮动，release 钉定）
   下载+sha256+自动登记）                   │
各插件独立仓（开发现场）                      ▼
        │                          suitectl up ──► .work/plugins/<pkg>@<commit>/（按 commit+配方 缓存）
        └── sync（分支安全快进）              │
                                            ▼
                              .work/stage/tabby-suite/（官方 zip 原样 + 规范插件 + profile 种子 + suite.json）
                                            │
                                  suitectl verify（隔离实例：boot + 插件全载断言 + 探针 + 回归挂钩；
                                                   .verify-passed 绑定 stage 树 hash）
                                            │ 绿
                                  suitectl release ──► 发布即锁（gitlink+bundle+index → commit + tag）
                                            │        + releases/（zip + 插件 zip + SHA256SUMS + channel + CHANGELOG）
                                            │        + 上传 GitHub Releases（gh；资产含 channel.json）
                                            ▼
                                  目标机 suite-tools/suitectl.ps1（check / apply / rollback / doctor）
                                    插件级：下载变化插件 zip → sha256 → 原子换名（.backup 可回滚）
                                    平台级：全量 zip → .staging → rename dance（data/ 保留，.old 可回滚）
```

**日常回路（直观版）**：

```
插件独立仓改代码 → commit → push → 本仓 suitectl up（一键：sync+平台查新+build+verify 全绿）
→ suitectl release（自动钉定 gitlink + bundle + tag + 上传）→ git push origin main --tags
目标机：suitectl.ps1 check → apply → （必要时）rollback
```

---

## 2. 目录结构

### 2.1 项目（TabbySuite 仓库）—— 按生命周期三分

```
TabbySuite/
├─ README.md / ARCHITECTURE.md / CLAUDE.md / PLUGIN_CONTRACT.md   # 使用说明 / 本文档 / 工作手册 / 插件集成契约
├─ bundle.yaml                   # 内容配置（唯一）：平台组件版本与 pin / integrate / payload / probes / regression
├─ suitectl.config.example.yaml  # 环境配置示例（复制为 suitectl.local.yaml；路径/端口/宿主工具/代理）
├─ .gitmodules                   # 7 插件子仓远端（核心源码参考已非子仓——按需检出，见 platform ref）
│
│ ── 输入（tracked）──
├─ components/                   # 插件组件 = 集成输入（7 个子仓；开发不在本仓；suitectl component ls 看收编状态）
├─ platform/                     # 平台组件区：index.json（版本登记，tracked）+ *.zip（gitignore，可 paths.platformZips 移出）
│  └─ reference/tabby/           # 核心源码参考（按需检出非子仓，gitignore；suitectl platform ref 重钉 @v<版本>）
├─ profiles/base/                # config 种子 + 预置资源
├─ tools/                        # 工具区：suitectl/（流水线 CLI）+ updater/（目标机更新器 ps1，assemble 拷入分发物）
│
│ ── 状态（gitignore，可整体删除重建）──
├─ .work/                        # stage/ + platform-cache/ + plugins/（工件缓存）+ install/（安装基线戳）
│                                #   + instance/（verify 隔离实例）+ build-report.json + .verify-passed
│
│ ── 产物（zip 不入库；channel/SUMS/CHANGELOG 入库）──
└─ releases/                     # zip + 插件 zip + SHA256SUMS + update-channel.json + CHANGELOG.md
```

### 2.2 分发 zip（tar 引擎，带顶层目录）

```
tabby-suite-<平台版本>-s<serial>-portable-x64.zip
└─ tabby-suite/                  # 解压出独立目录
   ├─ Tabby.exe / resources/ …   # 官方便携版原样，一字不动
   ├─ suite-tools/suitectl.ps1   # 更新器（check/apply/rollback/doctor；仓库侧源码在 tools/updater/）
   └─ data/                      # userData（portable 语义）
      ├─ config.yaml             # profile 种子（仅首次播种，此后归用户）
      ├─ suite/suite.json        # 安装态清单（含每插件/平台的目录树 treeSha256——doctor 依据）
      └─ plugins/node_modules/<pkg>/   # 规范工件（package.json + dist/ 子目录 + README [+ payload]）
```

**归属规则**：updater 拥有 = `data/` 以外的全部 + `data/plugins/node_modules/<受管包>` + `data/suite/`；用户拥有 = `config.yaml`（播种后）、会话、热键等其余 userData，更新永不触碰。

---

## 3. 模块设计

### 3.1 版本策略（全浮动·发布即锁）

- **候选版本** = `<平台版本>-s<serial>`，serial = 本地 channel 中该平台版本已发布最大 serial + 1（无历史则 1）。build/verify/release 全用候选号；release 写 channel 后下一次 build 自然 +1。tag 冲突预检兜底 serial 回退（本地 channel 丢失时）。
- **浮动**：`sync` 后子仓 detached/分支于远端 tip，父仓 gitlink 漂移是**常态而非错误**——`build` 直接构建当前检出态，build-report 记录实际 commit。
- **钉定**：`release` 把漂移收拢成一个 commit（gitlink + bundle.yaml + platform/index.json + releases 产物）+ tag `suite/<ver>`。`git clone --recursive && git checkout <tag>` 仍得到完全确定的构建输入。
- **平台前进**：bundle.yaml `platform.pin: auto` 时 `up` 查 GitHub API（Eugeny/tabby latest release），有新版自动 `platform use`：下载 portable zip → sha256 → **自动登记 platform/index.json** → 回写 bundle.yaml platform.version → 重钉源码参考（已检出时）。`pin: <版本>` 则锁定不自动前进。
- **平台组件命令面**：`platform list`（登记与缓存总览，标当前构建）· `latest`（查官方最新）· `use <v>|latest`（前进）· `fetch`（仅获取 zip）· `ref`（按需检出源码参考）。

### 3.2 构建与适配（唯一 adapter）

`build`，输入 = 子仓检出态，流程 = `npm install`（**按 package.json+lock+flags 的基线戳决定重装**，戳存 .work/install/ 不污染子仓）→ `npm run build` → 单测/冒烟（有则必跑，失败即 build 失败）→ 规范化 stage（sanitize package.json，保留 `keywords:["tabby-plugin"]`；dist 必须是子目录——压平破坏 main 解析）→ tar zip（带顶层 \<pkg\>/ 目录）。插件仓须满足的完整约定见 [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md)。

- **缓存键 = commit + 配方**：`.work/plugins/<pkg>@<commit>/`，meta 记 `recipe`（payload/install flags/sanitize 字段的 hash）——bundle 配方变了同 commit 也重建；脏树构建不冒充干净构建。
- **平台解包缓存** `.work/platform-cache/<版本>/`（zip sha256 标记）→ 硬链接克隆进 stage（**硬链铁律**：只用于永不被执行的树；verify 实例实拷）。
- **失败即失效**：assemble 中途失败会清掉 build-report 与 .verify-passed——绝不留旧凭证冒充当前 stage。
- 互斥校验：rules.mutuallyExclusive；组件同名包查重。

### 3.3 verify：发布门禁

stage 全新实拷为 `.work/instance/`（instance.json 在实例目录内，自描述；CDP 端口 bind 探测），`ELECTRON_ENABLE_LOGGING=1` 启动捕获 stderr，四级断言：

1. **插件全载**：renderer console 的 `Loading <name>:` 行（Tabby 剥 `tabby-` 前缀；包名按字面转义匹配）；
2. **无致命 ERROR**（过滤已知良性，如 Jump List 花边）；
3. **CDP 探针**（bundle.yaml `probes:`）：渲染层表达式 === 期望（GlassTheme 探针含 `appearance.theme === 'Glass'`——s1 回归防复发）；
4. **回归挂钩**（`regression:`，enabled 才跑）：`CDP_PORT` 注入执行仓库自带脚本。

通过写 `.work/.verify-passed`（**含 stageTreeHash**）；失败保留现场（实例目录 + `.work/instance-boot.err`）。

### 3.4 release：发布即锁

门禁链（全部可显式跳过，各带 flag）：① 脏子仓拒绝（--allow-dirty）② verify 绿 + stage 树 hash 复核（--no-verify）③ tag 冲突预检 ④ gitlink 远端可解析——每个子仓 HEAD 必须 push 到其远端 main（--no-remote-check），同时列出本次将钉定的 gitlink 漂移。

产出：全量 zip（tar）→ SHA256SUMS（累积多版本）→ channel.json（v2 条目：每插件 zip/sha256/treeSha256 + **notes 原文入档**——CHANGELOG 重生成只依赖 channel 存档，不读子仓现状）→ CHANGELOG.md → **自动钉定**（git add bundle.yaml + components + platform/index.json + releases/* → commit `release: <ver>` → tag）→ **上传 GitHub Releases**（gh：全量 zip + 每插件 zip + channel.json；--no-upload 跳过；代理自动注入 HTTPS_PROXY）。

> platform/index.json 必须在钉定清单里：`up` 自动前进平台时会改写它（登记新版本），不随 release 落库则 tag 上的登记残缺——冷复原退化为依赖网络自动下载（v4 修复的 v2 遗漏）。

releases 目录被移出仓库时拒绝钉定（--no-git 只出包+上传）。

### 3.5 滚动更新（目标机 · 单一实现 ps1）

`suite-tools/suitectl.ps1`（分发物内自带；仓库侧源码 `tools/updater/suitectl.ps1`，目标机 Windows 自足）：

- **channel 获取**：默认 `https://github.com/<repo>/releases/latest/download/channel.json`（GitHub 固定 URL，无需 API），资产 URL = channel.baseUrl + `/suite/<ver>/<file>`；`-ChannelUrl` 可指本地文件/自建源；`-Proxy http://127.0.0.1:7892` 走代理。
- **check**：比对本机 suite.json 与 channel 最新条目，列平台/插件差异。
- **apply（插件级，多数场景）**：进程占用检查（按 exe 路径，占用拒绝/-Force 杀）→ 下载变化插件 zip → sha256 校验 → 解 `.new` → 旧件入 `data/suite/.backup/<ts>/` → 原子换名 → 回写 suite.json → 提示重启。
- **apply（平台级）**：全量 zip 校验 → `.staging/` 解包 → rename dance（现有非 data 项 → `<root>.old/`，staging 就位；data/ 原地保留；旧 suite.json 快照入 `.old/_suite.json`）。
- **rollback**：`.old` 存在则平台级回滚（反向 rename + 恢复快照），否则插件级从最新 `.backup/<ts>/` 恢复。
- **doctor**：重算每插件目录树 hash + 平台树 hash（排除 data/）与 suite.json 比对，篡改/缺失逐项报告。
- **treeHash 算法**（Node `lib/hash.js` 与 ps1 `Get-TreeHash` 严格同构，已实测一致）：文件按 posix 相对路径 ordinal 排序，每行 `<文件sha256 小写>  <相对路径>` 以 `\n` 结尾，整体 utf8 文本的 sha256。

### 3.6 环境解耦与代理（配置层 · 系统能力层 · 平台获取）

- **环境配置**（`lib/config.js`）：优先级 代码默认值 ← `suitectl.config.yaml` ← `suitectl.local.yaml` ← `TABBYSUITE_*`。可覆盖 `paths.*`（platformZips/work/releases 可移出仓库）、`ports.cdp`、`host.exe/powershell/npmShell`（宿主机器工具）、**`net.proxy`**、`dist.repo`（GitHub 托管仓）、`platform.autoDownload/downloadTimeoutSec`（平台 zip 获取策略）。
- **代理一等公民**：所有外网获取（GitHub API / 平台 zip / channel / gh 上传 / ps1 更新器）统一走 `net.proxy`；临时切换 `TABBYSUITE_PROXY=http://127.0.0.1:7892`（空串=强制直连）。下载实现为系统 curl（`-x` 原生支持，绕开 Node fetch 不认 HTTP_PROXY 的限制）；gh 调用注入 HTTPS_PROXY；ps1 用 `Invoke-WebRequest -Proxy`。CDP 等 127.0.0.1 流量不经此层。
- **系统能力层**（`lib/sys.js`，v4 前名 platform.js）：tar zip/unzip（Windows 显式优先 System32 bsdtar——PATH 前部的 Git Bash GNU tar 不识 zip）、curl fetchUrl/getJson、PowerShell 进程管理、npm、按路径杀/数进程、CDP bind 探测集中于此。
- **平台组件域**（`lib/platform.js`，v4 由 core.js+vendor.js 合并）：index.json 只记 file/sha256/origin；新版本由 `platform use` 下载后**计算** sha256 自动登记（信任锚 = GitHub 官方 Releases；release 钉定时随父仓落库）。`--offline` 全局禁网。
- **预检**：`suitectl env`（--json）一次列出缺什么怎么补（node/git/子仓/tar/curl/gh/代理状态/目录/端口/平台 zip）。

---

## 4. 数据模型

### 4.1 bundle.yaml（唯一内容配置：构建什么）

```yaml
suite: { name: tabby-suite }
platform:
  version: 1.0.238        # 当前构建平台版本（pin:auto 时 up 自动前进并回写；随 release 钉定落库）
  pin: auto               # auto=跟随官方最新 | 写死版本=锁定
profile: base
integrate:  [WebViewer, HotkeyGuard, GlassTheme, Filter, BetterConfiger, TerminalWorkwench, ActivxRDPClient]
install:    { WebViewer: { flags: [--legacy-peer-deps] }, … }
payload:    { ActivxRDPClient: [native] }   # 规范工件之外的附加载荷
probes:     { GlassTheme: [...] }           # verify ③
regression: { WebViewer: { script: recorderTest.js, cwd: WebViewer/scripts, enabled: false } }
rules:      { mutuallyExclusive: [[…, …]] } # 互斥组（当前无——workbench 已移除收编）
```

serial **不在本文件**——由 channel 派生（见 §3.1）。环境配置（路径/端口/代理/宿主工具）不在本文件，见 §3.6。

### 4.2 channel.json（发布侧，随 GH Releases 分发）与 suite.json（安装态）

> 线上格式字段名沿用 `core`（目标机 ps1 与既有安装依赖它）——**仓库内部概念正名 platform，线上 wire 不变**。

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
| 1 | **发布即锁**：日常浮动构建，release 自动钉定 gitlink+bundle+tag | "一键同步最新并构建"与"可复现"不冲突——复原性由发布点保障，日常零 commit 负担 |
| 2 | **（v3）开发移出本仓，回归纯集成发布** | 集成仓保持极简消费方；插件在各自独立仓长期演进，职责单一 |
| 3 | 唯一 adapter，不复用 `package:install` | 7 仓统一从源码构建，行为一致可复现；安装只是拷贝 |
| 4 | 平台官方 zip 原样分发，定制只进 `data/` 与 `suite-tools/` | 免 asar 维护，平台升级零成本 |
| 5 | flat 布局 + zip 带顶层 `tabby-suite/` 目录 | 解压即得独立目录；回滚用 `.backup` / `<root>.old` |
| 6 | 自建 updater（ps1）+ 种子禁用内置自动更新 | keygen 通道只更新平台且不受控 |
| 7 | 更新单规则两路径（平台变→整包 rename dance；否则→插件目录换名） | 插件更新占 95% 且实现极简 |
| 8 | 版本事实 = 各仓库 package.json；套件版本 serial 由 channel 派生 | 发布记录即 git 历史；serial 全自动，杜绝手改 bundle 出错 |
| 9 | Node CLI + js-yaml + 系统工具（tar/curl/PowerShell） | 零新依赖面；tar 消除 Compress-Archive 隐藏文件/长路径隐患；curl 原生代理 |
| 10 | 子仓远端独立维护，先子仓后父仓 | 集成是消费关系；release gitlink 门禁把口头纪律变机器检查 |
| 11 | **（v4 修订）核心源码参考按需检出**（`platform ref`，gitignore，非子仓） | 参考非构建输入，不值得每个克隆背负完整 tabby 源码；参考一致性由 build 警告 + 重钉命令保障 |
| 12 | 内容/环境配置分离；**代理为环境配置一等公民** | 仓库跨机可复现；各机代理只进 local.yaml/环境变量，不入库 |
| 13 | channel/更新包托管 GitHub Releases；更新器用固定 URL 拉 channel | 仓库已 public 天然带 CDN；`releases/latest/download/channel.json` 免 API 免限流 |
| 14 | 更新器单一实现（ps1） | 不写第二份逻辑，分发物内自足 |
| 15 | treeHash（Node/ps1 同构算法）作为安装态完整性基准 | doctor 可校验目录树而非仅 zip；verify 与 release 用同一指纹绑定 |
| 16 | notes 原文入 channel 存档，CHANGELOG 只从 channel 重生成 | 历史不可漂移——子仓重构 notes 不影响已发布版本的 changelog |
| 17 | **（v4）平台组件正名**：core→platform（bundle/CLI/目录/模块），线上 wire 字段 `core` 不动 | Tabby 本体是套件的宿主平台，版本可切换是一等能力；命名统一后概念单一（宿主工具=host，系统能力=sys） |
| 18 | **（v4）工作状态合一 `.work/`**（build/cache/runtime 归一） | 状态可整体删除重建；根目录只剩有生命周期语义的分区；gitignore 与配置面同步精简 |
| 19 | **（v4）release 钉定清单含 platform/index.json** | 修复 v2 遗漏：平台前进改写 index 却未随 release 落库，tag 自含性被破坏 |
| 20 | **（v4）排除的第三方仓（tabby-command-workbench）移除收编** | 不集成的 submodule 是克隆死重；互斥知识留 bundle 注释，需要时 re-add |
| 21 | **（v4）插件集成契约显式化**（PLUGIN_CONTRACT.md + `component ls`） | adapter 对插件仓的约束从代码里浮出为文档，插件仓可逐条自查；接入 SOP 三步说清 |

---

## 6. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 旧代工具链（TS 4.2 / NG7）在高版本 Node 构建未实证 | build 记录每仓 Node 版本；必要时按仓固定构建 Node |
| R2 | 多数仓库无 lockfile，构建依赖可能漂移 | 安装基线戳感知 package.json 变化；逐步补 lockfile（契约建议项） |
| R3 | 禁用内置自动更新的静默键未完全实证 | `application.updateAutomatically: false` 已实证保留且无落盘；日志仍有 Checking for updates |
| R4 | 更新须应用完全退出（Windows 文件锁） | ps1 apply 前置按 exe 路径检测进程，占用拒绝（-Force 显式杀） |
| R5 | GitHub API 限流（60 req/h 未认证） | up 每次仅 1 次查询；platform use 可带版本直下 |
| R6 | GitHub 不可达（网络环境） | 代理一等公民（net.proxy / TABBYSUITE_PROXY / ps1 -Proxy）；失败给手工放置指引 |
| R7 | 平台前进引入不兼容（种子键/插件 peerDeps） | up 必跑 verify 四级断言；probes 覆盖种子键生效性 |
| R8 | （v4）reference 非子仓后，克隆里无核心源码可查 | `suitectl platform ref` 一键按需检出 @v<当前平台版本>；build 对不一致仅警告不阻路 |

---

## 7. 实施路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| v1（2026-10-07~19） | 收编/MVP 出包/门禁自动化/环境解耦（详见 git 历史） | ✅ |
| v2（2026-10-20） | 全浮动·发布即锁；平台自动获取登记；tar/curl 引擎；代理层；GH Releases 托管；ps1 更新器完整闭环 | ✅ |
| v3（2026-11-28） | 回归纯集成发布仓：删除 dev 开发轨道与 rollout 调度回路；命令面收窄为 `up` + `release`；插件开发正式移至各插件独立仓 | ✅ |
| **v4（2026-11-28）** | **平台组件架构**：core 正名 platform（bundle/CLI `platform list|latest|use|fetch|ref`/目录/模块 core+vendor→platform，宿主工具→host，系统能力→sys）；**目录按生命周期分区**（vendor→platform、build+cache+runtime→`.work/`、suite-tools→tools/updater，根目录 10→5）；reference 子仓改按需检出；移除 workbench 收编；PLUGIN_CONTRACT.md + `component ls`；修复 release 钉定遗漏 index.json | ✅ |
| 后续 | WebViewer 回归挂钩启用（待 fixture 种子化）；doctor --gc；Linux 打包路径实证；平台 channel（stable/pre-release）与多 arch 变体（结构已留位，按需实现） | |

---

*更新记录：v0.1–v0.6 见 git 历史。v1/v2 详情见 git 历史（6d122b6）。v3 删除开发轨道与调度回路。v4（2026-11-28）平台组件正名 + 目录分区 + 契约显式化；线上格式（channel/suite.json/zip 布局）与 ps1 更新器零改动，既有安装不受影响。*
