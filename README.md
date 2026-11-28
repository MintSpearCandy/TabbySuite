# TabbySuite

[Tabby](https://github.com/Eugeny/tabby) 集成发布仓：**只做「集成 → 验证 → 发布」**——把官方平台（Tabby core 便携版，版本可切换）+ 7 个自研插件组件组装成开箱即用的套件并发布 GitHub Releases。插件开发在各插件独立仓进行（见 `.gitmodules` 与 [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md)），本仓不含开发轨道。

- 套件模型：**平台组件（官方 zip 原样分发，一字不动）+ 插件组件（7 子仓）+ profile 种子**；定制只进 `data/`（配置种子 + 插件）与 `suite-tools/`（更新器）
- 插件子仓日常浮动跟随各仓最新，`release` 时自动钉定——任意历史版本可冷复原
- 自带目标机更新器：插件级增量 / 平台级整包、sha256 全程校验、可回滚

## 快速开始

前提：`git`、`Node ≥ 22`、`tar` / `curl`（Windows 10+ 均自带）；`gh` 仅发布上传时需要。打包目标为 Windows x64 便携版。

```bash
git clone --recursive https://github.com/MintSpearCandy/TabbySuite.git
cd TabbySuite/tools/suitectl && npm install   # 依赖仅 js-yaml
cd ../..
node tools/suitectl/cli.js env                # 环境自检（换机/新克隆先跑）
```

## 日常操作（就两条）

```bash
node tools/suitectl/cli.js up        # 拉子仓最新 + 平台查新 + 构建 + 门禁验证
node tools/suitectl/cli.js release   # 出包 → 自动钉定 commit+tag → 上传 GH Releases
git push origin main --tags          # 发布后推送（子仓必须已 push，门禁会检查）
```

平台 zip 缺失时自动按官方 Releases 直链下载 + sha256 校验并登记 `platform/index.json`。产物在 `releases/`（zip 不入库；channel / SHA256SUMS / CHANGELOG 入库）。

细粒度命令（`up` 的内部步骤，按需单独调用）：`sync` · `build` · `verify` · `platform list|latest|use|fetch|ref` · `component ls` —— 见 `suitectl help`。

## 版本纪律（一句话）

**全浮动 · 发布即锁**：日常 `up` 零 commit 跟随最新；`release` 自动钉定 gitlink + bundle + tag `suite/<平台版本>-s<serial>`——任意历史版本 `git clone --recursive && git checkout <tag>` 冷复原。serial 由 channel 派生，全自动。

## 目标机更新（已安装套件的机器）

分发 zip 解压即得独立目录 `tabby-suite/`，自带更新器：

```powershell
suite-tools/suitectl.ps1 check | apply | rollback | doctor [-Proxy http://…]
```

- 判断规则只有一条：平台变了 → 整包换名（rename dance）；平台没变 → 只换变化的插件目录
- 全程 zip sha256 + 目录 treeSha256 校验；`.old` / `.backup` 可回滚
- 更新通道走 GitHub Releases 固定 URL（`…/releases/latest/download/channel.json`），免 API 免限流

## 环境配置（换机不改仓库）

内容配置（构建什么）只有 `bundle.yaml`（平台组件版本 + 插件清单）；"本机怎么跑"归环境配置层，按优先级逐层覆盖：

```
代码默认值 ← suitectl.config.yaml（共享）← suitectl.local.yaml（本机，gitignore）← TABBYSUITE_* 环境变量
```

可覆盖：路径（platformZips / work / releases）、CDP 端口、宿主工具、代理（`net.proxy`，临时 `TABBYSUITE_PROXY`，空串 = 强制直连）。示例见 [suitectl.config.example.yaml](suitectl.config.example.yaml)。

## 目录速览（按生命周期三分）

```
bundle.yaml          内容配置（平台组件版本与 pin / integrate / probes / rules）
components/          插件组件 = 集成输入（7 子仓；开发在各插件独立仓；component ls 看收编状态）
platform/            平台组件：index.json 版本登记 + zip 缓存（可移出）+ reference/ 按需源码参考
profiles/base/       配置种子（仅首次播种，此后归用户所有）
tools/               suitectl（流水线 CLI）+ updater（目标机更新器 ps1）
.work/               全部工作状态：stage/平台解包缓存/插件工件/安装戳/verify 实例（gitignore，可整体删重建）
releases/            产物：zip（不入库）+ channel + SHA256SUMS + CHANGELOG
```

深度文档：[ARCHITECTURE.md](ARCHITECTURE.md)（设计原则 / 模块设计 / ADR）· [CLAUDE.md](CLAUDE.md)（工作手册）· [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md)（插件仓集成契约）。
