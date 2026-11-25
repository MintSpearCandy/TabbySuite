# TabbySuite

Tabby 集成总装仓库：core + 插件套件的构建 / 验证 / 发布 / 更新。**先读 [ARCHITECTURE.md](ARCHITECTURE.md)**（尤其 §0 设计原则与 §3 模块设计）再动手。使用说明（使用者视角）维护在 [README.md](README.md)。

- 版本纪律（v2 · 全浮动·发布即锁）：**日常零 commit**——`up` 一键拉最新并构建；`release` 才上锁（自动钉定 gitlink + bundle + tag）。serial 由 channel 派生，**不要手改**。
- 插件开发直接在 `components/<dir>` 子仓内进行（各自 GitHub 远端）；子仓 commit + push 后 `suitectl up` 即集成（gitlink 漂移是常态，release 时钉定）。
- 流水线（双轨）：**开发轨** `suitectl dev up|deploy [--restart]|restart|down|status`（脏树迭代、长驻实例、秒级单插件部署、永不产出 releases）；**构建轨** `suitectl up|rollout|build|verify|release`。
- 环境自检：`node tools/suitectl/cli.js env`（换机/新克隆先跑；`--json` 供脚本）。**内容配置与环境配置分离**：bundle.yaml 只描述构建什么；本机路径/端口/平台工具/**代理**在 `suitectl.config.yaml`（共享）→ `suitectl.local.yaml`（本机，gitignore）→ `TABBYSUITE_*` 环境变量，示例见 `suitectl.config.example.yaml`。
- **代理**：外网获取（GitHub API / core 下载 / channel / gh 上传）统一走环境配置——`suitectl.local.yaml` 的 `net.proxy` 持久配置，或临时 `TABBYSUITE_PROXY`（空串=强制直连）；ps1 更新器用 `-Proxy`。
- 硬链铁律：`core-cache → stage` 可硬链（永不执行）；**会运行的实例（dev/verify）必须实拷**——硬链共享文件锁，运行锁会波及打包。

## 日常 SOP（v2）

```bash
# 一键：子仓拉最新 + core 查新（pin:auto 自动前进）+ 构建 + 门禁验证
node tools/suitectl/cli.js up

# 滚动更新（幂等，可挂计划任务/cron）：core 无新版且子仓无前进 → 零动作退出；
# 有变化才 build+verify；--release 连带发布（门禁链原样生效），父仓推送仍人工
node tools/suitectl/cli.js rollout [--release] [--force]

# 出包发布（发布即锁：自动钉定 gitlink+bundle → commit + tag suite/<ver> + 上传 GH Releases）
# 前提：verify 绿（up 已做）；gh 未登录/不想上传加 --no-upload
node tools/suitectl/cli.js release

# 推送父仓（子仓 commit 必须先 push——release 的 gitlink 门禁已机器检查这一点）
git push origin main --tags

# dev 实例同步看效果：单插件秒级（--restart 先停后拷再启——native addon 被运行进程锁定）
node tools/suitectl/cli.js dev deploy <仓> --restart
```

core 相关：`suitectl core latest` 查官方最新；`suitectl core use <版本>` 显式前进（下载+登记+改 bundle+重钉 reference/tabby）。pin:auto 时 `up` 自动做；想锁旧版把 bundle.yaml `core.pin` 写死版本。

## 克隆与拉取

```bash
# 冷启动：父仓 + 8 插件子仓 + reference/tabby（shallow）——拉下即可构建
git clone --recursive https://github.com/MintSpearCandy/TabbySuite.git
cd TabbySuite/tools/suitectl && npm install   # 仅 js-yaml
node cli.js up                                  # 一键全绿（core zip 缺失自动下载登记）

# 已普通 clone 的补齐（幂等）：git submodule update --init
# 日常跟随：git pull && git submodule update --init（父仓钉哪版拉哪版）
# 拉各插件远端最新（开发实时）：node tools/suitectl/cli.js sync（或直接 up 一条龙）

# 自检：node tools/suitectl/cli.js env（平台能力/子仓/tar/curl/gh/代理/端口一次过）
#       git submodule status（前缀空格=与 gitlink 一致 / -=未初始化 / +=本地检出漂移[浮动常态]）
```

- vendor 包源不入 git：core zip 缺失时自动按官方 Releases 直链下载 + sha256 + 登记 `vendor/index.json`（`suitectl core use <版本>` 显式触发；离线 `--offline`）。前提：git、Node ≥22、tar（Win10+ 自带）、curl（Win10+ 自带）。
- 产物在 `releases/`（zip 不入库；channel / SHA256SUMS / CHANGELOG 入库）；发布 = 父仓 tag `suite/<core>-s<serial>` + GitHub Releases 资产（含 channel.json）。
- 目标机更新：解压全量包后 `suite-tools/suitectl.ps1 check|apply|rollback|doctor`（或构建机 `suitectl update/doctor --dest <目录>` 转调同一脚本；`-Proxy` 走代理）。
- 核心源码参考：`reference/tabby`（shallow 子仓，钉 v<core 版本>，core 前进自动重钉；查核心内部实现优先读它，别 grep 解包 dist。未检出时 `git submodule update --init reference/tabby`）。
- 远端：https://github.com/MintSpearCandy/TabbySuite（public）。**推送顺序：先子仓后父仓**——子仓 commit 未推送时父仓 gitlink 在别处不可解析（release 门禁已机器检查）。
- 铁律：发布拒绝脏子仓；未过 verify 不出包；stage 树 hash 与 .verify-passed 不符不出包；core 官方 zip 永远原样分发。
