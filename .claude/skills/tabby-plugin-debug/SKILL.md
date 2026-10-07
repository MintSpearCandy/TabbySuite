---
name: tabby-plugin-debug
description: 调试 Tabby 终端插件（tabby-webviewer / tabby-output-filter / tabby-glass-theme 等，源码在本仓 components/ 子仓）的方法论：隔离实例 + CDP 自动化实验、启动诊断信号（ELECTRON_ENABLE_LOGGING）、已验证的平台事实清单、常见坑与定位手段。当插件加载失败、窗格显示异常、热键/焦点/遮挡行为不符合预期、或需要在不打扰用户主实例的情况下复现问题时使用。
---

# Tabby 插件调试方法论

本 skill 沉淀自 tabby-webviewer / tabby-glass-theme / tabby-terminal-workwench 的完整调试过程与 TabbySuite 集成实践（2026-09/10）。事实在 Tabby 1.0.235–1.0.237 / Electron 43 (Node 22) / Chrome 140–150 / Windows 实证。

**分工**：本文件只保留可移植的方法论与项目内相对路径；**易变环境事实（实例清单/端口占用/绝对路径/用户热键）一律不进本文件**——本机权威快照在用户级 tabby-debug skill 的 `ENVIRONMENT.md`。插件源码 = 本仓 `components/<dir>/`，工具脚本在各组件 `scripts/`（WebViewer 最全；TerminalWorkwench 有 `cdpEval.js`/`cdpConsole.js` 可作 CDP 样板）。

## 一、已验证的平台事实（勿重复踩坑）

### 插件加载链
- 插件目录：`<userData>/plugins/node_modules/<包名>`（portable = exe 旁 `data\`，安装版 = `%APPDATA%\tabby`）；**目录存在即被发现**（扫描 `tabby-*` 前缀 + package.json `keywords: ["tabby-plugin"]`），无需注册；`dist/` 必须是 package.json 旁的**子目录**（压平会破坏 `main` 解析）
- Settings → Plugins 列表来自"发现"阶段，**与加载是否成功无关**；加载失败只打在渲染进程 console（`Could not load <name>: ...`），主进程 log.txt **没有插件行**
- `window.pluginModules`（数组）= 真正加载进 Angular 的插件，`m.pluginName` 为名。**这是判断"到底加载没"的金标准**
- 自定义 profile 显示：Profiles 面板会**过滤 `isTemplate: true` 的条目**。要直接出现在面板，用 `isBuiltin: true` 且不带 isTemplate（tabby-local 的 PowerShell 就是这样）

### 启动诊断信号（2026-10-07 实证，verify 门禁的依据）
- 以 `ELECTRON_ENABLE_LOGGING=1` 启动并捕获 **stderr**：渲染层 console 逐条转发 `Found <name> in <dir>`（发现）与 `Loading <name>:`（加载，**Tabby 会剥 `tabby-` 前缀**——日志是 `Loading glass-theme:` 不是包名）
- 已知良性噪音：Jump List 隐私设置 ERROR（Windows 花边）；terminal-workwench 的 vm-module 警告是 INFO
- 引导期崩溃（如 DI 炸弹）只打在渲染 console——CDP 早 attach 收 `consoleAPICalled` 或直接读上述 stderr

### @electron/remote（三大铁律）
1. **必须 CJS require**：`const remote = require('@electron/remote')`。ES 默认导入经 webpack interop 得 `undefined`（包设 `__esModule` 但无 default）
2. **禁用 `remote.require('electron')`**：主进程端依赖 `process.mainModule`，Electron 43 (Node 22) 已移除 → 必然抛错。**一切主进程模块走 `remote.getBuiltin(name)`**（session/Menu/clipboard/shell/app/WebContentsView）
3. `getCurrentWindow()/getCurrentWebContents()/getBuiltin()` 正常可用

### WebContentsView overlay
- 视图坐标：`context-menu` 事件的 `params.x/y` 是**视图内坐标**；`Menu.popup` 要屏幕坐标 = `win.getContentBounds() + view.getBounds() + params`；`inspectElement` 用原始值
- 分屏拖拽条（`split-tab-spanner`）**向两侧窗格各叠入约 5px**——遮挡检测必须豁免它，视图 bounds 需内缩 ~6px（在 rAF 里轮询 isSplit，勿依赖 Angular CD）
- **隐藏的视图（setVisible(false) 或停靠到屏幕外）不再接收输入**——`before-input-event` 停止触发。这是"以 Ctrl+Shift 开头的组合键断裂"的根因
- 窗口 `location.reload()` 后 @electron/remote 的事件订阅全部失效——**reload 不能用于测试，必须完整重启进程**

### 热键引擎（tabby-core HotkeysService）
- 和弦在**最后一个键的 keyDown 时**触发（pressedKeys 集合 → `getKeystrokeName` → `matchActiveHotkey`）
- 修饰键自身的 keyUp 不带任何 modifier 标志——转发合成事件时**修饰键事件必须无条件转发**，否则引擎认为修饰键卡住
- 合成事件 `timeStamp` 必须用 `performance.now()` 真实时钟 + 微量自增防去重（`pushKeyEvent` 按 timeStamp 精确去重）
- **`Ctrl+Shift` 长按 = rearrange-panes**；rearrange 触发时若插件停靠/隐藏网页视图 → 和弦后续键被丢弃。**rearrange 不得触发停靠**
- 热键引擎对同一热键无防重触发：auto-repeat 须在转发层过滤（`input.isAutoRepeat`）

### 主题/DI 提供者插件（GlassTheme 实证）
- **`{ provide: Token, useExisting: X, multi: true }` 是引导期炸弹**（官方模板就是这写法）：X 未单独注册时抛 `NullInjectorError` 炸掉整个 Angular 引导——症状是所有用户插件从 `window.pluginModules` 消失、内置插件照常。必须用 `useClass`
- 主题插件注册的是**常规主题，不自动生效**——须在外观设置选中（config `appearance.theme`）；TabbySuite 由 profile 种子直接选定，verify 探针断言防回归（2026-10-07 s1"主题不加载"即此因，非插件缺陷）
- 主题 CSS 经 `<style id="theme">` **整体替换**，必须自带 Bootstrap；自定义主题运行时**没有任何 --theme-*/--bs-* 变量注入**，样式须完全自足
- **ThemesService 会清掉 documentElement 的后设 inline CSS 变量**（每次 config.changed$ 恢复引导期备份）。插件要运行时注入 CSS 变量，必须用自有 `<style>` 元素（如 `style#glass-vars`），勿用 inline style
- **ConfigProvider defaults 覆盖不了已有内置默认键**（CoreConfigProvider 恒在末位，deepmerge 后到者必胜）；要改这类键须配置就绪后一次性迁移。**ConfigProvider 构造器里同步 `injector.get(ConfigService)` 是 DI 环会炸引导**——必须 `setTimeout` 延迟 + `ready$.subscribe`。成品参考 `components/GlassTheme/src/index.ts`。Windows 盘符 `D:` 会被 `^[a-z]+:` 式正则误判为协议（漏加 file:/// 导致 url() 失效）
- 宿主 app 有 `body{background:rgba(0,0,0,0)}`（vibrancy 预留）会压掉主题 body 底色 → 全窗底色放 `app-root`；OS 级窗口效果（setOpacity/亚克力）CDP 截图不可见，用 `getCurrentWindow().getOpacity()` 验证

### 焦点操作的铁律（事件风暴教训）
- **绝不要订阅 `focused$`/`blurred$` 后做程序化焦点转移**：SplitTab.focus 向全部兄弟窗格广播 emitBlurred/emitFocused，多窗格下任何"失焦归还 + 得焦接管"组合都会形成 ~100ms 焦点乒乓风暴，最终挂死渲染器
- 要让顶层 SplitTab 的 `hasFocus` 为真，**直接属性赋值** `topmostParent.hasFocus = true`（无事件），勿用 `emitFocused()`
- 键盘注入测试：CDP `Input.dispatchKeyEvent` 在多 webContents 窗口不可靠（鼠标可、键盘丢）；用 `webContents.sendInputEvent()`（真实输入管线，before-input-event 必触发）
- **合成事件必须是 DOM 规范形态**：`type` 用小写 `keydown`/`keyup` 且与 eventName 一致。第三方插件（tabby-hotkey-guard）会包装 `pushKeyEvent` 并重标签 `type` 不符的事件——Electron 大写 `keyDown` 形态会被重推成引擎不认识的类型，转发和弦全灭（症状：终端热键正常、网页聚焦全失效）

### 其他
- Electron `<webview>` 不可用（Tabby 未开 webviewTag）；渲染进程 `nodeIntegration: true, contextIsolation: false`
- 宿主 Angular 实为 **15.2.10**（页面内 `require('@angular/core').VERSION.full` 实证）：`import x from '无default的CJS包'` 踩 interop 坑；`#ref` 模板引用变量与 `[(ngModel)]='同名'` 冲突（模板变量只读）
- webpack externals 必须含 `'@electron/remote'` 与 `/^tabby-/`

## 二、隔离实例 + CDP（不打扰用户主实例）

**为何实例必须是完整 exe 副本**（实证）：便携模式强制 userData = exe 旁 `data\`（`--user-data-dir` 不改变 Tabby 的 portable 判定），单实例锁在共享 userData 上——已有实例运行时，新启动只做参数转发然后退出（log `secondInstance: true`）。**唯一共存隔离法 = 每实例完整拷贝 + 各自 data\**。

### 入口：suitectl verify（本仓标准路径）
`node tools/suitectl/cli.js build && node tools/suitectl/cli.js verify` —— 自动拷贝 stage 到 `runtime/instance/`、bind 探测端口、带日志启动、断言插件全载/探针；**失败保留现场**（实例目录 + `runtime/instance-boot.err`），按 §四 进现场定位。

### 手工启动配方（verify 之外的自由实验）
1. 完整拷贝一份 core（vendor zip 解包或既有实例复制）到独立目录
2. **端口先 bind 探测再使用**：Windows 保留段随重启漂移（实证见过 9249–9348 整段不可绑），bind 报 `WSAEACCES (0x271D)`；Node 一行探测：
   ```js
   const s=require('net').createServer();s.once('error',()=>/*换一个*/);s.listen(PORT,'127.0.0.1',()=>s.close(()=>/*可用*/))
   ```
3. 启动：`ELECTRON_ENABLE_LOGGING=1 <dir>/Tabby.exe --remote-debugging-port=<port>`，stderr 落文件（启动诊断信号见 §一）。参数经 Start-Process / spawn 均可正常透传（旧记录"Start-Process 丢参数"系端口保留段误诊，已证伪）
4. CDP 求值样板：`components/TerminalWorkwench/scripts/cdpEval.js`（`CDP_PORT` 环境变量覆盖；`/json/list` 里选 `type:'page'` 且 url 含 `index` 的 target）
5. 关闭：**按可执行文件路径过滤杀进程**（`Get-Process | ? { $_.Path -like '<dir>*' } | Stop-Process -Force`），勿按进程名全局杀（会误杀用户主实例）
6. 反复启停后若"进程活着但端口永不绑定"：清理该目录全部孤儿进程、删 `data\lockfile` 后重试

关键手法：
1. **播种窗格**：不点 UI，直接 `localStorage.tabsRecovery = JSON.stringify([{type:'webviewer-tab', url:'https://example.com?run<ts>', partitionId:'p-e2e', ignoreCertErrors:false}])` → 完整重启 → 窗格自动恢复（URL 加唯一标记，防实例恢复旧 tab 后按前缀选错 target）
2. **读视图真实状态**（一行定位显示层问题）：
   ```js
   const w = require('@electron/remote').getCurrentWindow()
   ;(w.contentView.children||[]).map(v => ({bounds: v.getBounds(), visible: v.getVisible(), url: v.webContents?.getURL()}))
   ```
   bounds.x 大负数 = 被停靠；0×0 = 边界同步没跑；visible false = 可见性订阅问题；url 空 = 导航没发
3. **注入键盘**：CDP `Input.dispatchKeyEvent`（修饰键 bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8；先 rawKeyDown 修饰键再 keyDown 主键，keyUp 成对）；主窗口 console 用 `Runtime.consoleAPICalled` 收集。注入后必查捕获日志里有无 `Matched hotkey`
4. **CDP 响应解包是两层**：`r.result.result.value`（写错会静默拿到 undefined）
5. 噪音插件在隔离 config.yaml 加 `pluginBlacklist: [tabbyspaces, ...]`
6. 缩放窗口用 `window.resizeTo(1400,900)`（evaluate 里）；`Browser.setWindowBounds` 不可用
7. 截图伪影（Chrome 150 实测）：`Page.captureScreenshot` 与 `capturePage()` 都会把暗部灰（≤rgb(41)）坍缩成纯黑——像素取证只信亮色，深色对比改用布局断言（rect/offsetHeight）

## 三、冒烟加载（不发 GUI 就能抓模块级崩溃）

```bash
cd components/<dir> && node scripts/smokeLoad.js   # WebViewer / HotkeyGuard / BetterConfiger 有
```
用 stub 宿主模块（tabby-core/@angular/@electron/remote）执行 `dist/index.js` 的模块级求值。配合：`npx tsc --noEmit`（类型）、`npm test`（纯函数）。装进实例做真实验证 = 拷贝规范工件到 `<instance>/data/plugins/node_modules/<pkg>/`（或走 suitectl build/verify 全链路）。

## 四、分层排查顺序（症状 → 层）

| 症状 | 先查 |
|---|---|
| 插件"安装了"但无任何效果 | `window.pluginModules` 含不含？不含 → console 找 `Could not load` 栈 → 多为模块级崩溃（interop/getBuiltin/顶层副作用）；含但不生效 → 属配置/选中问题，往下看 |
| 主题插件不生效 | 是否**常规主题未选中**（`appearance.theme`）——先 CDP 查 `__glassConfig.store.appearance.theme` 再怀疑插件本身（2026-10-07 教训） |
| Profile 不显示 | isTemplate 被 UI 过滤（见 §一） |
| 窗格开了但页面不渲染 | 探针查 contentView.children 的 bounds/visible/url（§二 手法 2） |
| 页面渲染但位置/遮挡错 | 宿主 div getBoundingClientRect 是否塌缩（flex 链）；spanner 叠入；遮挡物识别 |
| 网页聚焦时热键失灵 | before-input-event 是否到达（裸监听器测）；停靠是否吞输入；修饰键转发配对；timeStamp 真实性 |
| CDP 端口连不上 | 先 bind 探测（保留段！），再看 stderr 有无 `Cannot start http server for devtools`；进程是否实为 secondInstance 转发后退出 |
| 右键菜单位置错 | 视图内坐标 → 屏幕坐标换算 |

## 五、环境事实入口

本机实例清单/端口现状/绝对路径/用户热键 → 用户级 tabby-debug skill 的 `ENVIRONMENT.md`（易变层，环境变化只更新它）。本仓相关：插件源码 `components/<dir>`、**Tabby 核心源码 `reference/tabby`（shallow 子仓，与构建 core 同版——查核心实现的第一入口，`.ts` 原文可读）**、core 构建原件 `vendor/*.zip`（hash 见 `vendor/index.json`）、运行时形态参考 = 任意解包实例内 `resources/builtin-plugins/<包>/dist/index.js`（未压缩 dist，可 grep）。
