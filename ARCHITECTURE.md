# 架构与实现说明

面向想改代码的人。产品视角请回 [README](README.md)。

---

## 一、为什么这样选

**1）PWA，而不是原生 App**

| | 本项目（PWA） | Flutter / RN | 原生 |
| --- | --- | --- | --- |
| 上手成本 | 会 HTML/JS 就行 | 要装环境、学 Dart | 两套代码 |
| 分发 | 发链接就能用 | 要打包签名 | 要打包签名 |
| 体验 | 略逊原生 | 接近原生 | 最好 |

简历这种「填表 + 看排版 + 导出」的工具，网页足够；**先有链接能发给朋友试用**，比先上架重要。

**2）结构化表单，而不是解析已有的 PDF/Word**

解析排版（尤其中文 PDF 的字体、表格、分栏）是这类产品最贵的部分，且很难做到「改一个字不破坏原版式」。先用表单把数据拿结构化，排版由我们控制，效果稳定、可继承模板。导入解析属于第二阶段。

**3）不用框架、不用构建工具、也不用 ES Module**

没有 React/Vue/Webpack。这份代码要能看懂、能改：

- 改样式只改 CSS，不用重新编译
- 打开开发者工具就能断点调试源码
- 想换框架，`preview.js` 那层纯函数可以整段搬走

不用 `import/export` 是踩坑后的选择：模块脚本在 `file://` 双击打开、以及被嵌进「沙箱 iframe」（很多 App 的内置预览缺少 `allow-same-origin`）时，会被同源策略拒绝加载，页面只剩顶部栏。改成普通脚本 + 全局命名空间 `window.RS` 后，这三种环境都能跑；代价只是失去 tree-shaking，这个体量无所谓。

---

## 二、代码结构与数据流

```
index.html          骨架 + 启动自检（脚本加载失败会在页面上显示原因）
js/model.js         数据模型、示例数据、格式化工具
js/store.js         localStorage 读写、导入导出、旧数据兼容
js/preview.js       数据 → 简历 HTML（纯函数，不碰 DOM）
js/editor.js        数据 → 表单 HTML + 事件委托
js/app.js           主控：状态、视图切换、增删、撤销、打印
css/app.css         编辑器界面
css/resume.css      A4 纸张、三套模板、打印样式
css/mobile.css      手机版专用（只在手机版构建里内联）
```

数据流是单向的：

```
用户输入 → 改 state → 防抖存 localStorage → 重绘预览
                     ↘ 结构性变化才重绘表单
```

**关键取舍**：打字时只重绘右侧预览，绝不重建 `<input>`——否则每敲一个字输入框就失焦。增删条目、切换简历这类结构变化才重绘表单，并自动聚焦到新条目。

---

## 三、几个实现要点

**A4 排版**：纸张固定 `210mm × 297mm`，屏幕放不下就 `transform: scale()`。纸张必须是 `flex: none`，否则会被容器压成手机宽度、文字换行爆炸、内容凭空多出一页。

**打印**：不引 jsPDF。`@media print` 里隐藏所有界面元素、`@page { size: A4; margin: 0 }`，页边距交给纸张自己的 `padding`。预览和 PDF 共用同一套 CSS，所见即所得。文件名在打印前临时替换 `document.title`，Chrome 的「另存为 PDF」默认名就是简历名。

**照片**：上传时用 canvas 压到 480×600、转 JPEG（质量 0.86）。手机原图 3–5MB，转 base64 更大，而 localStorage 通常只有 5MB 配额，存原图必然失败。

**字号 / 页边距 / 模块间距**：全部走 CSS 变量（`--fs`、`--page-margin`、`--gap`）。字号写成 `calc(10.5pt * var(--fs))`，改一个值整页同比缩放，不用维护多套样式。

**压缩到一页**：二分搜索缩放系数（同时缩字号、行距、页边距），找到刚好塞进一页的最大字号；压到最小仍放不下时提示精简内容。

**撤销**：每次修改前深拷贝一份快照进栈，700ms 内的连续输入合并成一步，最多 50 步。切换简历时清空历史。

**富文本**：`contenteditable` + `execCommand`，存的是白名单净化后的 HTML（只留 `b/i/u/s/br`）。渲染时再过一遍白名单，非白名单标签转义成文本。回车用 `insertLineBreak`（默认会插 `<div>`），粘贴只取纯文本。

**确认框**：不用 `window.confirm`——沙箱 iframe 里浏览器会直接忽略并返回 `false`，表现为「点删除没反应」。改用页面内 `<dialog>`。

---

## 四、测试

```bash
node tests/smoke.mjs    # 纯函数：渲染、XSS 转义、格式化、数据兼容
node tests/e2e.mjs      # 真浏览器：打字、增删、撤销、导出、打印样式
```

`smoke.mjs` 用 Node 的 `vm` 造一个最小 `window` 环境加载普通脚本，不需要浏览器。

`e2e.mjs` 走 Chrome 调试协议（CDP），不依赖 Puppeteer。默认直接测线上地址，也可以指定本地文件：

```bash
# 线上
chrome --headless=new --remote-debugging-port=9333 https://merely-j.github.io/resume-studio/
node tests/e2e.mjs

# 本地
chrome --headless=new --remote-debugging-port=9333 file:///D:/ds_workspace/resume-app/index.html
APP_URL=file:///D:/ds_workspace/resume-app/index.html node tests/e2e.mjs
```

---

## 五、路线图

**P0 打磨**

1. 分页预览：现在是一整条长纸，改成真正的分页显示
2. 撤销历史持久化（刷新后还能撤）
3. 更多模板、字号按模块单独设置
4. 手机预览的"适应宽度 / 100%"切换

**P1 产品化**

5. 账号 + 云端同步（Supabase / 自建 Node API）
6. 分享只读链接，HR 点开就能看
7. 导入 PDF/Word 提取字段（`pdf.js` + 正则，再考虑 LLM）
8. AI 润色工作内容、JD 关键词匹配

**P2 上架**

9. PWABuilder / Capacitor 打包成安装包
10. 隐私政策、备案、应用商店资质

**不建议现在做的**：用户体系、支付、社区。先发给 10 个真实求职者用，看他们卡在哪一步。

---

## 六、常见问题（技术向）

**页面空白，只有顶部栏？**
底部会有红框说明原因。常见：`file://` 打开且用了模块脚本（已修）、沙箱 iframe（已修）、缓存了旧版本（点红框里的「清除缓存并重新加载」）。如果是「脚本加载失败」，按 F12 看 Network 里哪个 404。

**在沙箱/内嵌窗口里，改了会保存吗？**
不会。这类环境禁止访问 localStorage，应用会降级为「只在当前页面有效」，底部会提示保存失败。换一个正常标签页打开，或者直接用线上版。

**导出的 PDF 里有界面元素？**
打印样式会隐藏顶栏、工具栏、编辑器、预览区顶栏和手机版底部条。e2e 里有一条用例专门守这个（模拟打印媒体后断言 `display: none`）。

**PDF 没有背景色？**
打印对话框里勾选「背景图形 / Background graphics」。

**能改成公司模板吗？**
`css/resume.css` 里加一段 `.tpl-你的名字`，`js/preview.js` 加一个模板函数，再到 `js/model.js` 的 `TEMPLATES` 注册。字段不用动。

**更新后用户还看到旧版？**
把 `sw.js` 里的 `CACHE` 版本号 +1。
