---
name: tabby-plugin-debug
description: 调试 Tabby 终端插件（tabby-webviewer / tabby-output-filter 等）的方法论：隔离实例 + CDP 自动化实验、已验证的平台事实清单、常见坑与定位手段。当插件加载失败、窗格显示异常、热键/焦点/遮挡行为不符合预期、或需要在不打扰用户主实例的情况下复现问题时使用。
---

# Tabby 插件调试方法论

本 skill 沉淀自 tabby-webviewer 插件的完整调试过程（2026-09），所有事实均在 Tabby 1.0.235 / Electron 43 (Chromium 140) / Windows 上实证验证。工具脚本在 `WebViewer/scripts/` 下。

## 一、已验证的平台事实（勿重复踩坑）

### 插件加载链
- 插件目录：`%APPDATA%\tabby\plugins\node_modules\<包名>`；**目录存在即被发现**（扫描 `tabby-*` 前缀 + package.json `keywords: ["tabby-plugin"]`），无需注册
- Settings → Plugins 列表来自"发现"阶段，**与加载是否成功无关**；加载失败只打在 DevTools Console（`Could not load <name>: ...`）
- `window.pluginModules`（数组）= 真正加载进 Angular 的插件，`m.pluginName` 为名。**这是判断"到底加载没"的金标准**
- 自定义 profile 显示：Profiles 面板会**过滤 `isTemplate: true` 的条目**（模板只进"新建 profile"流）。要直接出现在面板，用 `isBuiltin: true` 且不带 isTemplate（tabby-local 的 PowerShell 就是这样）

### @electron/remote（本机 Tabby 的三大铁律）
1. **必须 CJS require**：`const remote = require('@electron/remote')`。ES 默认导入（`import remote from`）经 webpack interop 得 `undefined`（包设 `__esModule` 但无 default）
2. **禁用 `remote.require('electron')`**：主进程端依赖 `process.mainModule`，Electron 43 (Node 22) 已移除 → 必然抛 `process.mainModule.require is not a function`。**一切主进程模块走 `remote.getBuiltin(name)`**（session/Menu/clipboard/shell/app/WebContentsView）
3. `getCurrentWindow()/getCurrentWebContents()/getBuiltin()` 正常可用

### WebContentsView overlay
- 视图坐标：`context-menu` 事件的 `params.x/y` 是**视图内坐标**；`Menu.popup` 要屏幕坐标 = `win.getContentBounds() + view.getBounds() + params`；`inspectElement` 用原始值
- 分屏的拖拽条（`split-tab-spanner`）**向两侧窗格各叠入约 5px**——遮挡检测必须豁免它，视图 bounds 需内缩 ~6px（在 rAF 里轮询 isSplit，勿依赖 Angular CD）
- **隐藏的视图（setVisible(false) 或停靠到屏幕外）不再接收输入**——`before-input-event` 停止触发。这是"以 Ctrl+Shift 开头的组合键断裂"的根因
- 窗口 `location.reload()` 后 @electron/remote 的事件订阅全部失效（主进程没重启，指向已死 renderer）——**reload 不能用于测试，必须完整重启进程**

### 热键引擎（tabby-core HotkeysService）
- 和弦在**最后一个键的 keyDown 时**触发（pressedKeys 集合 → `getKeystrokeName` → `matchActiveHotkey`）
- 修饰键自身的 keyUp 不带任何 modifier 标志——转发合成事件时**修饰键事件必须无条件转发**，否则引擎认为修饰键卡住
- 合成事件 `timeStamp` 必须用 `performance.now()` 真实时钟（引擎按时间戳判和弦/过期）+ 微量自增防去重（`pushKeyEvent` 按 timeStamp 精确去重）
- **`Ctrl+Shift` 长按 = rearrange-panes**；若插件在 rearrange 触发时停靠/隐藏网页视图 → 和弦的后续键被丢弃。**rearrange 不得触发停靠**

### 其他
- Electron `<webview>` 不可用（Tabby 未开 webviewTag）；Tabby 渲染进程 `nodeIntegration: true, contextIsolation: false`
- 宿主 Angular 实为 **15.2.10**（2026-09-20 页面内 `require('@angular/core').VERSION.full` 实证；早前"Angular 7 + ViewEngine"记录有误，但下面的 interop 坑仍成立）：`import x from '无default的CJS包'` 会踩 interop 坑；`#ref` 模板引用变量与 `[(ngModel)]='同名'` 冲突（模板变量只读）
- webpack externals 必须含 `'@electron/remote'` 与 `/^tabby-/`

### 主题/DI 提供者插件（2026-09-20 GlassTheme 实证）
- **`{ provide: Token, useExisting: X, multi: true }` 是引导期炸弹**（官方 tabby-theme-hype 模板就是这写法）：X 未单独注册时抛 `NullInjectorError: No provider for e`（压缩类名），**整个 Angular 引导崩溃**——症状是所有用户插件从 `window.pluginModules` 消失、内置插件与默认主题照常。必须用 `useClass`（与内置 tabby-community-color-schemes 一致）
- 引导错误只打在渲染进程 console（主进程 log.txt 无记录）。诊断：启动前轮询 attach CDP + `Runtime.enable` 收集 `consoleAPICalled`，可看到 `Found <name> in <dir>`（发现成功）与 `Angular bootstrapping error`（引导失败）——参考 `GlassTheme/scripts/cdpConsole.js`
- 主题 CSS 经 `<style id="theme">` **整体替换**，必须自带 Bootstrap；自定义主题（followsColorScheme=false）运行时**没有任何 --theme-*/--bs-* 变量注入**（仅 --body-bg/--spaciness），样式须完全自足
- **ThemesService 会清掉 documentElement 的后设 inline CSS 变量**（每次 config.changed$ 时把 `cssText` 恢复为引导期备份，症状：变量写入成功后"莫名"消失，时序竞争导致偶现）。插件要在运行时注入 CSS 变量，必须用自有 `<style>` 元素而非 inline style（ThemesService 只动 inline 和它自己的 style#theme）
- **ConfigProvider defaults 覆盖不了已有内置默认键**（CoreConfigProvider 恒在注入数组末位，deepmerge 后到者覆盖其 yaml 值必胜）；要改这类键须在配置就绪后做一次性迁移。且 **ConfigProvider 构造器里同步 `injector.get(ConfigService)` 是 DI 环会炸引导**——必须 `setTimeout` 延迟 + `ready$.subscribe`（AsyncSubject 完成后立即回调）。成品参考 GlassTheme/src/index.ts。另注意 Windows 盘符 `D:` 会被 `^[a-z]+:` 式正则误判为协议（漏加 file:/// 导致 url() 失效）
- 宿主 app 有 `body{background:rgba(0,0,0,0)}`（vibrancy 预留）会压掉主题 body 底色 → 全窗底色放 `app-root`；OS 级窗口效果（setOpacity/亚克力）CDP 截图不可见，用 `getCurrentWindow().getOpacity()` 验证

### 焦点操作的铁律（事件风暴教训，2026-09-19 实证）
- **绝不要订阅 `focused$`/`blurred$` 后做程序化焦点转移**（`webContents.focus()`/`currentWebContents().focus()`）：SplitTab.focus 会向全部兄弟窗格广播 emitBlurred/emitFocused，多窗格下任何"失焦归还键盘 + 得焦接管键盘"的组合都会形成 ~100ms 周期的焦点乒乓风暴，最终挂死渲染器
- 需要让顶层 SplitTab 的 `hasFocus` 为真（其热键动作的门槛）时，**直接属性赋值** `topmostParent.hasFocus = true`（无事件），勿用 `emitFocused()`（会触发事件链）
- 修饰键自身事件的 flags 全为 false（Control↓ 时 ctrl=false）——转发逻辑须无条件转发修饰键
- 键盘注入测试：CDP `Input.dispatchKeyEvent` 在多 webContents 窗口不可靠（鼠标可、键盘丢）；用 `webContents.sendInputEvent()`（真实输入管线，before-input-event 必触发）
- **合成事件必须是 DOM 规范形态**：`type` 用小写 `keydown`/`keyup` 且与传给 `pushKeyEvent` 的 eventName 一致。第三方插件（如 tabby-hotkey-guard）会包装 `pushKeyEvent` 并把 `type` 与 eventName 不符的事件"重标签"——Electron 的 `keyDown`/`keyUp` 大写形态会被重推成引擎不认识的类型，转发和弦全灭（症状：终端热键正常、网页聚焦全失效）
- 热键引擎对同一热键无防重触发：auto-repeat 须在转发层过滤（`input.isAutoRepeat`）

## 二、隔离实例 + CDP 自动化（不打扰用户主实例）

**集中调试环境（2026-09-28 起）**：`D:\Env\TabbyEnv\`——`instances\{main@9231, wv@9232, bc@9233}`（宿本 1.0.237）+ `tools\tabby.ps1` 管理器 + `tools\cdp.js`/`cdp-lib.js` 探针 + `fixtures\` 基线 + `work\` 输出区。布局/用法/铁律见该目录 README.md；实例清单与版本见用户级 tabby-debug skill 的 ENVIRONMENT.md。

```powershell
# 实例全生命周期走管理器（手杀也只允许按 ExecutablePath 路径过滤）
powershell D:\Env\TabbyEnv\tools\tabby.ps1 status
powershell D:\Env\TabbyEnv\tools\tabby.ps1 start wv -WaitCdp     # 启动并等 CDP
powershell D:\Env\TabbyEnv\tools\tabby.ps1 deploy <项目目录|release.zip> wv
powershell D:\Env\TabbyEnv\tools\tabby.ps1 fixture save main     # 基线快照
powershell D:\Env\TabbyEnv\tools\tabby.ps1 reset main -Full      # 一键重置+重播种
powershell D:\Env\TabbyEnv\tools\tabby.ps1 stop wv
powershell D:\Env\TabbyEnv\tools\tabby.ps1 new scratch 1.0.235 -Port 9245   # 从任意 vendor 版本建实例
```

```bash
# CDP 探针（--instance 按名解析端口，或直接给端口/用 %CDP_PORT%）
node D:/Env/TabbyEnv/tools/cdp.js eval   --instance wv "<expr>"
node D:/Env/TabbyEnv/tools/cdp.js console --instance wv 8000 "Found |Loading "   # reload+收 console
node D:/Env/TabbyEnv/tools/cdp.js hotkey --instance wv b 3                        # F13 牺牲键+和弦
# 新写探针脚本 require D:/Env/TabbyEnv/tools/cdp-lib.js（共享样板，勿再内联）
```

**历史机制事实（为何实例必须是完整 exe 副本）**：便携模式强制 userData = exe 旁 `data\`（启动日志 `reset user data to ...`，**`--user-data-dir` 被忽略**），单实例锁在共享 userData 上——主实例开着时同目录新实例只做参数转发然后 exit 0。`TABBY_CONFIG_DIRECTORY` 只隔离配置与锁，插件目录仍共用——均不可靠；**唯一共存隔离法 = 每实例完整拷贝 + 各自 data\**（tabby.ps1 new 自动做）。

**启动方式注意**（实证）：
- `bash 内 & + sleep 保活` 有效；bash 命令结束后子进程**有时**被一起回收——同命令多试或换端口
- `PowerShell Start-Process` 会**丢 --ArgumentList 与环境变量**（得到无参实例），勿用
- `cmd start` 在沙箱内"拒绝访问"；`nohup` 无效
- 反复 kill 实例后会出现**进程活着但调试端口永不绑定**的状态（疑似 crashpad/共享 userData 残留锁），清理全部孤儿 Tabby 进程（保留用户主实例：无参 main + 其 gpu/utility 子进程）后重试；仍失败则只能重启机器或交由用户手工验证

关键手法：
1. **播种窗格**：不点 UI，直接 `localStorage.tabsRecovery = JSON.stringify([{type:'webviewer-tab', url:'https://example.com', partitionId:'p-e2e', ignoreCertErrors:false}])` → 完整重启 → 窗格自动恢复（bare token 即可，不必包 split-tab）
2. **读视图真实状态**（一行定位显示层问题）：
   ```js
   const w = require('@electron/remote').getCurrentWindow()
   ;(w.contentView.children||[]).map(v => ({bounds: v.getBounds(), visible: v.getVisible(), url: v.webContents?.getURL()}))
   ```
   bounds.x 大负数 = 被停靠；0×0 = 边界同步没跑；visible false = 可见性订阅问题；url 空 = 导航没发
3. **注入键盘**：对页面 target 的 CDP 会话 `Input.dispatchKeyEvent`（修饰键 bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8；先 rawKeyDown 修饰键再 keyDown 主键，keyUp 成对）。主窗口 console 用 `Runtime.consoleAPICalled` 收集
4. **CDP 响应解包是两层**：`r.result.result.value`（写错会静默拿到 undefined）
5. 噪音插件（TabbySpaces 等会劫持会话恢复）在隔离 config.yaml 加 `pluginBlacklist: [tabbyspaces, ...]`
6. 缩放窗口用 `window.resizeTo(1400,900)`（evaluate 里）；`Browser.setWindowBounds` 不可用

## 三、冒烟加载（不发 GUI 就能抓模块级崩溃）

```bash
cd WebViewer && node scripts/smokeLoad.js
```
用 stub 宿主模块（tabby-core/@angular/@electron/remote）执行 `dist/index.js` 的模块级求值。配合：`npx tsc --noEmit`（类型）、`npm test`（纯函数）、`npm run package:install`（装进 %APPDATA%\tabby\plugins）。

## 四、分层排查顺序（症状 → 层）

| 症状 | 先查 |
|---|---|
| 插件"安装了"但无任何效果 | `window.pluginModules` 含不含？不含 → DevTools Console 找 `Could not load` 栈 → 多为模块级崩溃（interop/getBuiltin/顶层副作用） |
| Profile 不显示 | isTemplate 被 UI 过滤（见事实清单） |
| 窗格开了但页面不渲染 | 探针查 contentView.children 的 bounds/visible/url（表格见上） |
| 页面渲染但位置/遮挡错 | 宿主 div getBoundingClientRect 是否塌缩（flex 链）；spanner 叠入；遮挡物识别 |
| 网页聚焦时热键失灵 | before-input-event 是否到达（裸监听器测）；停靠是否吞输入；修饰键转发配对；timeStamp 真实性 |
| 右键菜单位置错 | 视图内坐标 → 屏幕坐标换算 |

## 五、本机环境备忘

- **集中调试环境 `D:\Env\TabbyEnv\`**（2026-09-28 起；实例/工具/母本/基线都在这里，详见其 README 与 tabby-debug skill 的 ENVIRONMENT.md）
- Tabby 安装于 `D:\App\Tabby\`（真实使用实例，**portable 模式**：`D:\App\Tabby\data\` 是 userData，插件目录 `data\plugins\node_modules`；`%APPDATA%\tabby\plugins` 已不被读取）；asar 可直接 node 解析（用 `D:\Env\TabbyEnv\tools\asar.js`，默认指向最新 vendor 母本）
- 用户热键：split-right=`Ctrl+Shift+D`、split-bottom=`Ctrl+Shift+S`、pane-nav=`Ctrl+Alt+方向`、rearrange=长按 `Ctrl+Shift`
- 源码获取：GitHub API/jsdelivr（WebFetch 被拦）；本地权威源 = `D:\App\Tabby\resources\builtin-plugins\<包>\dist\index.js`（tabby-core 等的未压缩 dist，可直接 grep）
