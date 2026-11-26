# TabbySuite CHANGELOG

## 1.0.238-s2 — 2026-11-26T18:16:09.186Z

- core: 1.0.238（官方 portable 原样）
- tabby-webviewer 0.4.14
  > 录制器 Network 页签：结构化 JSON 展示与请求内容搜索。
  > 
  > ## 新功能
  > 
  > - **展开请求时的结构化 JSON**：请求体 / 响应体为 JSON（对象或数组）时，自动
  >   美化缩进（2 空格）并做 token 着色——键名（青）、字符串（绿）、数字（琥珀）、
  >   true/false/null（紫）；非 JSON 内容保持原文显示
- tabby-hotkey-guard 0.2.1
- tabby-glass-theme 0.5.0
- tabby-output-filter 0.5.7
- tabby-better-configer 0.4.0
- tabby-terminal-workwench 0.2.5
  > - JS 块健壮性：异步返回值（Promise）不再静默变空，而是明确报错并中止；错误消息携带块序号与源码摘录（多块片段可定位）；同源码编译结果缓存（重复执行免重编译）。
  > - 片段编辑器新增「模板语法说明」专页（入口按钮位于插入按钮组内，替换原单行提示）：参数 / 延时 / 文件 / JS 四类块的完整语法、上下文变量与成员参考表、可复制示例（含「看输出 → 提取 → 组命令」闭环用法）。
  > - 设置页片段行的动作类型改为图标 + 悬停提示：填充（文本光标）/ 发送（播放 ▶）/ 复制（复制）/ 高危（警告三角），替代原文字徽章；悬停显示完整类型说明。
  > - 设置页场景行的「使用中」徽章改为自绘样式（着色描边 + 浅底胶囊，替代 bootstrap 实底徽章），深色主题下对比度更好。
  > - 修复侧栏目标显示不跟随焦点：补充 Split 窗格焦点切换事件（SplitTabComponent.focusChanged$）与全局 focusin 兜底（120ms 防抖）驱动目标刷新——此前同一 Split 内切换窗格或部分焦点移动不会触发刷新，目标停留在最后挂载的窗格（如新建的那个）而非当前激活窗格。
- tabby-activx-rdp-client 0.1.0
- tabby-mux 0.1.0

## 1.0.238-s1 — 2026-11-25T17:01:44.706Z

- core: 1.0.238（官方 portable 原样）
- tabby-webviewer 0.4.14
  > 录制器 Network 页签：结构化 JSON 展示与请求内容搜索。
  > 
  > ## 新功能
  > 
  > - **展开请求时的结构化 JSON**：请求体 / 响应体为 JSON（对象或数组）时，自动
  >   美化缩进（2 空格）并做 token 着色——键名（青）、字符串（绿）、数字（琥珀）、
  >   true/false/null（紫）；非 JSON 内容保持原文显示
- tabby-hotkey-guard 0.2.1
- tabby-glass-theme 0.5.0
- tabby-output-filter 0.5.7
- tabby-better-configer 0.3.0
- tabby-terminal-workwench 0.2.4
  > - 设置页改为双 Tab 分页：「片段管理」（默认页，筛选/新建工具条 + 场景树）与「面板设置」（面板开关、毛玻璃、侧栏样式、搜索分组）。
  > - 毛玻璃模糊独立开关（默认关闭）：关闭时快捷按钮不做模糊（模糊半径仅在开启时生效）；开启后显示模糊度调节行。
  > - 默认配置调整（新装/未落盘用户）：侧边栏透明遮罩默认开启（透明度 0.03、底色灰色 #808080）；默认不启用侧边命令面板；启动时默认不展开。注意：旧数据中等于旧默认而被 ConfigProxy 擦除的项将按新默认呈现。
- tabby-activx-rdp-client 0.1.0

## 1.0.237-s5 — 2026-10-14T00:36:37.811Z

- core: 1.0.237（官方 portable 原样）
- tabby-webviewer 0.4.10
- tabby-hotkey-guard 0.2.1
- tabby-glass-theme 0.5.0
- tabby-output-filter 0.5.7
- tabby-better-configer 0.2.0
- tabby-terminal-workwench 0.2.4
- tabby-activx-rdp-client 0.1.0

## 1.0.237-s4 — 2026-10-07T14:38:56.446Z

- core: 1.0.237（官方 portable 原样）
- tabby-webviewer 0.4.9 **(dirty)**
- tabby-hotkey-guard 0.2.1
- tabby-glass-theme 0.4.0
- tabby-output-filter 0.5.7
- tabby-better-configer 0.1.0 **(dirty)**
- tabby-terminal-workwench 0.2.0

## 1.0.237-s3 — 2026-10-07T13:27:53.325Z

- core: 1.0.237（官方 portable 原样）
- tabby-webviewer 0.4.9 **(dirty)**
- tabby-hotkey-guard 0.2.1
- tabby-glass-theme 0.4.0
- tabby-output-filter 0.5.7
- tabby-better-configer 0.1.0 **(dirty)**
- tabby-terminal-workwench 0.2.0

## 1.0.237-s2 — 2026-10-07T12:58:45.884Z

- core: 1.0.237（官方 portable 原样）
- tabby-webviewer 0.4.9 **(dirty)**
- tabby-hotkey-guard 0.2.1
- tabby-glass-theme 0.4.0
- tabby-output-filter 0.5.7
- tabby-better-configer 0.1.0 **(dirty)**
- tabby-terminal-workwench 0.2.0

## 1.0.237-s1 — 2026-10-07T00:48:39.760Z

- core: 1.0.237（官方 portable 原样）
- tabby-webviewer 0.4.9 **(dirty)**
- tabby-hotkey-guard 0.2.1
- tabby-glass-theme 0.4.0
- tabby-output-filter 0.5.7
- tabby-better-configer 0.1.0 **(dirty)**
- tabby-terminal-workwench 0.2.0
