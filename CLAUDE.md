# TabbySuite

Tabby 集成发布仓：**平台组件（Tabby core）+ 插件组件**的 构建 / 验证 / 发布。**插件开发在各插件独立仓进行**（各自 GitHub 远端，见 `.gitmodules`；须满足 [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md)），本仓是纯集成消费方，无开发轨道。先读 [ARCHITECTURE.md](ARCHITECTURE.md)（尤其 §0 设计原则）再动手。使用说明（使用者视角）维护在 [README.md](README.md)。

- 版本纪律（全浮动·发布即锁）：**日常零 commit**——`up` 一键拉最新并构建；`release` 才上锁（自动钉定 gitlink + bundle + index + tag）。serial 由 channel 派生，**不要手改**。
- 子仓 commit + push 后 `suitectl up` 即集成（gitlink 漂移是常态，release 时钉定）。

## 日常 SOP（就两条命令）

```bash
# 一键：子仓拉最新 + 平台查新（pin:auto 自动前进）+ 构建 + 门禁验证
node tools/suitectl/cli.js up

# 出包发布（发布即锁：自动钉定 gitlink+bundle+index → commit + tag suite/<ver> + 上传 GH Releases）
# 前提：verify 绿（up 已做）；gh 未登录/不想上传加 --no-upload
node tools/suitectl/cli.js release

# 推送父仓（子仓 commit 必须先 push——release 的 gitlink 门禁已机器检查）
git push origin main --tags
```

平台相关：`suitectl platform latest` 查官方最新；`suitectl platform use <版本>` 显式前进（下载+登记+改 bundle+重钉 reference/tabby）；`platform list` 看登记与缓存；`platform ref` 按需检出核心源码参考。pin:auto 时 `up` 自动做；想锁旧版把 bundle.yaml `platform.pin` 写死版本。

## 插件开发（不在本仓）

- 在插件自己的独立克隆里改代码、commit、push（远端见 `.gitmodules`，契约见 [PLUGIN_CONTRACT.md](PLUGIN_CONTRACT.md)）。
- 回本仓 `suitectl up` 即集成最新；`release` 时钉定 gitlink。
- 铁律：**先子仓后父仓**——子仓 commit 未 push 时父仓 gitlink 在别处不可解析（release 门禁机器检查）。
- 接入新插件三步：`git submodule add <url> components/<dir>` → bundle.yaml `integrate` 加一行 → `suitectl up`（`component ls` 随时看收编状态）。

## 环境与代理

- 换机/新克隆先跑：`node tools/suitectl/cli.js env`（`--json` 供脚本）。
- **内容配置与环境配置分离**：bundle.yaml 只描述构建什么（平台版本 + 插件清单）；本机路径/端口/宿主工具/代理在 `suitectl.config.yaml`（共享）→ `suitectl.local.yaml`（本机，gitignore）→ `TABBYSUITE_*` 环境变量，示例见 `suitectl.config.example.yaml`。
- **代理**：外网获取（GitHub API / 平台 zip / channel / gh 上传）统一走环境配置——`suitectl.local.yaml` 的 `net.proxy` 持久配置，或临时 `TABBYSUITE_PROXY`（空串=强制直连）；ps1 更新器用 `-Proxy`。
- 硬链铁律：platform-cache → stage 可硬链（永不执行）；会运行的实例（verify）必须实拷——硬链共享文件锁，运行锁会波及打包。

## 其他

- 核心源码参考：`platform/reference/tabby`（**按需检出非子仓**，gitignore，`suitectl platform ref` 检出/重钉到 v<平台版本>；查核心内部实现优先读它，别 grep 解包 dist）。
- 目录三分：输入（components/ platform/ profiles/ tools/）→ 状态（`.work/`，可整体删除重建）→ 产物（releases/）。
- 目标机更新：安装目录内 `suite-tools/suitectl.ps1 check|apply|rollback|doctor`（`-Proxy` 走代理）。
- 铁律：发布拒绝脏子仓；未过 verify 不出包；stage 树 hash 与 .verify-passed 不符不出包；平台官方 zip 永远原样分发。
