# TabbySuite

Tabby 集成总装仓库：core + 插件套件的构建 / 验证 / 发布 / 更新。**先读 [ARCHITECTURE.md](ARCHITECTURE.md)**（尤其 §0 六原则与 §6 命令语义）再动手。

- 插件开发直接在 `components/<dir>` 子仓内进行（各自 GitHub 远端）；集成 = 子仓 commit → 父仓 commit gitlink。
- 流水线：`node tools/suitectl/cli.js sync|build|verify|release`（verify/update/doctor 按 P2/P3 逐步落地）。
- 产物在 `releases/`（zip 不入库；channel / SHA256SUMS / CHANGELOG 入库）；发布 = 父仓 tag `suite/<core>-s<serial>`。
- 旧工作区已归档：`D:\Home\Project\TabbyPlugins.archive`（只读，稳定后删除）。
- 铁律：发布拒绝脏子仓；未过 verify 不出包（P2 起自动门禁）；core 官方 zip 永远原样分发。
