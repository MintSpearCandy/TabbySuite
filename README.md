# TabbySuite

[Tabby](https://github.com/Eugeny/tabby) 集成总装仓库：**core + 插件套件的构建 / 验证 / 发布 / 滚动更新**——一条命令得到开箱即用的便携版 Tabby 套件。

- 官方 core zip **原样分发**（一字不动），定制只进 `data/`（配置种子 + 插件）与 `suite-tools/`（更新器）
- 8 个插件以 git submodule 收编在 `components/`：日常浮动跟随各仓最新，`release` 时自动钉定——任意历史版本可冷复原
- 自带目标机更新器：插件级增量 / core 级整包、sha256 全程校验、可回滚

深度文档：[ARCHITECTURE.md](ARCHITECTURE.md)（设计原则 / 模块设计 / ADR）· [CLAUDE.md](CLAUDE.md)（工作手册）。

## 快速开始

前提：`git`、`Node ≥ 22`、`tar` / `curl`（Windows 10+ 均自带）；`gh` 仅发布上传时需要。打包目标为 Windows x64 便携版。

```bash
git clone --recursive https://github.com/MintSpearCandy/TabbySuite.git
cd TabbySuite/tools/suitectl && npm install   # 依赖仅 js-yaml
cd ../..
node tools/suitectl/cli.js env                # 环境自检（换机/新克隆先跑）
node tools/suitectl/cli.js up                 # 一键全绿：sync + core 查新 + build + verify
```

core zip 缺失时自动按官方 Releases 直链下载 + sha256 校验并登记 `vendor/index.json`。产物在 `build/stage/`；`release` 出包到 `releases/` 并上传 GitHub Releases（含更新通道 channel.json）。

## 命令一览

`suitectl` = `node tools/suitectl/cli.js`（`suitectl help` 为准）：

| 场景 | 命令 |
|---|---|
| 一键集成（人工回路） | `up` —— sync 子仓最新 + core 查新（`pin:auto` 自动前进）+ build + verify |
| 滚动更新（调度回路） | `rollout [--release] [--force]` —— 幂等：core 无新版且子仓无前进 → 零动作退出；可挂计划任务/cron |
| 出包发布 | `release` —— 门禁 → 出包 → 自动钉定 commit + tag → 上传（`--no-upload` 跳过） |
| core 版本 | `core latest` 查官方最新；`core use <v>\|latest` 显式前进（下载 + 登记 + 重钉 reference） |
| 子仓同步 | `sync` —— 分支安全快进（只动 `.gitmodules` 分支上的干净检出） |
| 构建 / 验证 | `build` / `verify`（隔离实例四级断言；`.verify-passed` 绑定 stage 树 hash） |
| 插件开发 | `dev up \| deploy [组件…] [--restart] \| restart \| down \| status` —— 长驻实例、脏树允许、秒级单插件部署 |
| 目标机更新 | `update --dest <目录> [--check\|--apply\|--rollback]` · `doctor --dest <目录>` |
| 预检 / 缓存 | `env [--json]` · `vendor status \| fetch [版本]` |

## 环境配置（换机不改仓库）

内容配置（构建什么）只有 `bundle.yaml`；"本机怎么跑"归环境配置层，按优先级逐层覆盖：

```
代码默认值 ← suitectl.config.yaml（共享） ← suitectl.local.yaml（本机，gitignore） ← TABBYSUITE_* 环境变量
```

可覆盖：路径（vendor / cache / build / runtime / releases）、CDP 端口、平台工具（exe / powershell / npm shell）、代理（`net.proxy`，临时 `TABBYSUITE_PROXY`，空串 = 强制直连）。示例见 [suitectl.config.example.yaml](suitectl.config.example.yaml)。

## 目标机更新（已安装套件的机器）

分发 zip 解压即得独立目录 `tabby-suite/`，自带更新器：

```powershell
suite-tools/suitectl.ps1 check | apply | rollback | doctor [-Proxy http://…]
```

- 判断规则只有一条：core 变了 → 整包换名（rename dance）；core 没变 → 只换变化的插件目录
- 全程 zip sha256 + 目录 treeSha256 校验；`.old` / `.backup` 可回滚
- 更新通道走 GitHub Releases 固定 URL（`…/releases/latest/download/channel.json`），免 API 免限流

## 版本纪律（一句话）

**全浮动 · 发布即锁**：日常 `up` 零 commit 跟随最新；`release` 自动钉定 gitlink + bundle + tag `suite/<core>-s<serial>`——任意历史版本 `git clone --recursive && git checkout <tag>` 冷复原。

## 目录速览

```
bundle.yaml          内容配置（core 版本与 pin / integrate / probes / rules）
components/          8 插件子仓 = 开发现场（7 集成 + 1 exclude）
reference/tabby      Tabby 核心源码参考（shallow，与构建 core 同版）
profiles/base/       配置种子（仅首次播种，此后归用户所有）
suite-tools/         目标机更新器（ps1，单一实现；CLI 的 update/doctor 转调它）
tools/suitectl/      流水线 CLI（Node ≥ 22，依赖仅 js-yaml）
vendor/              官方 core zip 缓存 + index.json（sha256 登记；zip 不入库）
releases/            产物：zip（不入库）+ channel + SHA256SUMS + CHANGELOG
```

## 插件开发

直接在 `components/<dir>` 子仓内进行（各自独立 GitHub 远端）；子仓 commit + push 后 `suitectl up` 即集成（gitlink 漂移是常态，`release` 时钉定）。推送顺序铁律：**先子仓后父仓**——release 门禁已机器检查。
