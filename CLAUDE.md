# TabbySuite

Tabby 集成总装仓库：core + 插件套件的构建 / 验证 / 发布 / 更新。**先读 [ARCHITECTURE.md](ARCHITECTURE.md)**（尤其 §0 六原则与 §6 命令语义）再动手。

- 插件开发直接在 `components/<dir>` 子仓内进行（各自 GitHub 远端）；集成 = 子仓 commit → 父仓 commit gitlink。
- 流水线（双轨）：**开发轨** `suitectl dev up|deploy [--restart]|restart|down|status`（脏树迭代、长驻实例 runtime/dev、秒级单插件部署、永不产出 releases）；**构建轨** `suitectl sync|build|verify|release`（钉定+单测+门禁，update/doctor 为 P3）。
- 硬链铁律：`core-cache → stage` 可硬链（永不执行）；**会运行的实例（dev/verify）必须实拷**——硬链共享文件锁，运行锁会波及打包。

## 更新构建 SOP（远端插件有新版本时）

```bash
# ① 拉各子仓远端最新（脏树/feature 分支自动跳过并说明）
node tools/suitectl/cli.js sync

# ② 钉版：谁前进了 add 谁（一次多仓前进可一起），这就是"集成"动作
git add components/<前进的仓> && git commit -m "chore(components): <仓> <版本>"

# ③④ 构建 + 门禁（新 commit 重建并跑其单测，其余缓存命中；不出包可止步于此）
node tools/suitectl/cli.js build
node tools/suitectl/cli.js verify

# ⑤ 出包（可选）：先递增 bundle.yaml 的 serial，再重跑 build+verify+release
#    （serial 变了 build-report 版本要重新生成；release 三重门禁 + 打 tag suite/<ver>）
node tools/suitectl/cli.js release

# ⑥ 推送父仓（sync 拉来的子仓 commit 天然已在远端；本地开发才需先推子仓）
git push origin main --tags

# dev 实例同步看效果：单仓秒级；或 dev up 从新 stage 整体重建
node tools/suitectl/cli.js dev deploy <仓> --restart
```

要点：reference/tabby 不随 sync 动（只随 core 版本重钉）；core 升级是独立流程（vendor 登记新 zip + bundle core.version + reference checkout v<新> + 父仓 commit）；verify 用自己的全新实例断言，dev 实例 config 属用户态可能漂移，别拿它判断种子链路。

## 克隆与拉取

```bash
# 冷启动：父仓 + 7 插件子仓（完整历史，可直接开发）+ reference/tabby（shallow，仅钉定 tag 的源码参考）
git clone --recursive https://github.com/MintSpearCandy/TabbySuite.git
# 已普通 clone 的补齐（幂等，随时可跑）：
git submodule update --init

# 日常跟随父仓钉版（"父仓集成哪版就拉哪版"）：
git pull && git submodule update --init

# 拉各插件远端最新（开发实时；reference/tabby 不经此路径，只随 core 版本显式重钉）：
node tools/suitectl/cli.js sync     # 前进的仓须 git add components/<dir> && git commit 才算集成钉版

# 自检：git submodule status（前缀空格=与 gitlink 一致 / -=未初始化 / +=本地检出漂移）
#       suitectl build 的 [reference] 行校验参考源码与构建 core 同版
```

vendor 包源不入 git：全新机器首次 build 前有两步准备——① `cd tools/suitectl && npm install`（装 js-yaml）；② 按 `vendor/index.json` 的 origin 下载对应 zip 放入 `vendor/`（sha256 自动校验）。前提：git、Node ≥22。
- 产物在 `releases/`（zip 不入库；channel / SHA256SUMS / CHANGELOG 入库）；发布 = 父仓 tag `suite/<core>-s<serial>`。
- 旧工作区 `D:\Home\Project\TabbyPlugins`（已停用，待重命名为 `TabbyPlugins.archive`：重命名时被进程占用，关闭占用窗口后 `mv` 即可）。
- 核心源码参考：`reference/tabby`（shallow 子仓，钉 v<core 版本>，build 校验同版；查核心内部实现优先读它，别 grep 解包 dist。未检出时 `git submodule update --init reference/tabby`）。
- 远端：https://github.com/MintSpearCandy/TabbySuite（public）。**推送顺序：先子仓后父仓**——子仓 commit 未推送时父仓 gitlink 在别处不可解析。
- 铁律：发布拒绝脏子仓；未过 verify 不出包（P2 起自动门禁）；core 官方 zip 永远原样分发。
