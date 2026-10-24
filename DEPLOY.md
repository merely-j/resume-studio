# 打包与分发

一条命令产出两个版本（同一套代码，只有样式差异）：

```bash
node tools/build.mjs
```

| 版本 | 产物 | 给谁用 | 特点 |
| --- | --- | --- | --- |
| **网站版** | `dist/web/` | 别人开链接用 | 桌面双栏布局，可托管成 PWA（添加到主屏幕） |
| **手机版** | `dist/简历工坊-手机版.html` | 自己在手机上填简历 | 单文件、大按钮、底部固定「看预览 / 导出 PDF」 |
| 通用单文件 | `dist/简历工坊.html` | 电脑上双击用 | 单文件，发谁都能开 |

> 两个版本的数据格式、导出效果完全一致；手机版只是多了 `css/mobile.css`（触屏尺寸 + 底部操作条），逻辑一份。

---

## 一、网站版（在线给别人用）

纯静态站点，没有任何后端，拖拽上传就能上线。

### Netlify Drop（最快，约 1 分钟）

1. 打开 <https://app.netlify.com/drop>
2. 把 `dist/web` **整个文件夹**拖进页面
3. 等几秒，得到一个 `https://随机名.netlify.app` 网址
4. 手机打开这个网址 → 浏览器菜单 → **添加到主屏幕**，就成了一个"App"

不用注册也能先试；登录后可以改站点名、绑自己的域名。

### Vercel

```bash
npm i -g vercel
cd dist/web
vercel --prod
```

### Cloudflare Pages

控制台 → Pages → 上传资源（或连 Git 仓库），构建命令留空，输出目录填 `dist/web`。

### GitHub Pages

```bash
cd dist/web
git init && git add -A && git commit -m "deploy"
git branch -M gh-pages
git remote add origin <你的仓库>
git push -u origin gh-pages
```

然后在仓库 Settings → Pages 里选择 `gh-pages` 分支。

> 国内访问提示：Netlify / Vercel 有时较慢。要稳定国内访问，用国内对象存储（OSS/COS）+ CDN，但需要域名备案。

---

## 二、手机版（自己手机上填简历）

产物 `dist/简历工坊-手机版.html`（约 139 KB），CSS/JS 全内联，**单文件**。

和网站版的区别：

- 底部固定一条操作条：**看预览 / 导出 PDF**，拇指够得着
- 输入框、卡片头部、按钮都放大到 46–48px，点按更准
- 其余功能完全一样（模板、字号、页边距、压缩到一页、撤销…）

### 怎么发到手机

- **微信/QQ 发给自己**：拖文件进"文件传输助手"→ 手机端保存 → 用浏览器打开
- **网盘 / AirDrop / 数据线**：同理，落地后用 Chrome / Safari 打开
- **也想给别人用手机打开**：把 `dist/mobile/index.html` 上传到网站根目录的 `m/` 下（如 `https://你的站/m/index.html`）

⚠️ 手机版是单文件，数据存在手机浏览器里；换手机/清缓存会丢，重要简历记得导出 PDF。

---

## 三、通用单文件（电脑上双击用）

产物 `dist/简历工坊.html`，CSS、JS、图标全部内联，**双击就能用**，不需要服务器、不需要联网。

- 发微信：直接拖文件进聊天窗口（对方用浏览器打开；微信内置打开可能受限，建议"在浏览器中打开"）
- 发邮件 / 网盘：同理

⚠️ 数据存在**那台电脑的浏览器**里，换设备/清缓存就没了。

---

## 四、打包成手机 App 上架（暂不做）

托管上线后，用 [PWABuilder](https://www.pwabuilder.com/) 输入你的网址，可以直接生成：

- **Android**：.apk / .aab（可上架 Google Play，或直接发给用户安装）
- **iOS**：Xcode 工程（需 Apple 开发者账号，99 美元/年）

也可以用 Capacitor 自己包：

```bash
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init "简历工坊" com.yourname.resume --web-dir=dist/web
npx cap add android
npx cap sync
npx cap open android   # 在 Android Studio 里签名打包
```

上架前需要准备：

- 隐私政策（简历含个人信息，应用商店强制要求）
- 应用图标 / 截图
- 中国区上架：App 备案、软著、主体资质

---

## 上线前检查清单

- [ ] **HTTPS**：PWA 安装、Service Worker 都要求 https（Netlify/Vercel 默认给）
- [ ] **图标**：`manifest.webmanifest` 里的名称、`assets/icon-192.png`、`icon-512.png` 已替换成你的品牌
- [ ] **缓存版本**：改完代码，把 `sw.js` 里的 `CACHE = 'resume-app-vX.Y.Z'` 升个版本号，否则老用户会一直看到旧版
- [ ] **手机实测**：编辑、预览、压缩到一页、导出 PDF 都走一遍
- [ ] **数据说明**：告诉用户数据只存在本机浏览器，换设备不会同步

## 更新已部署的站点

```bash
node tools/build.mjs
# 把新的 dist/web 重新拖到 Netlify（会覆盖旧文件）
# 记得同时改 sw.js 的 CACHE 版本号
```

## 常见问题

**打开是空白页？**
托管时确认 `index.html` 在根目录（拖的是 `dist/web` 里的内容，不是它的父目录）。单文件版请用浏览器打开，不要用记事本之类的程序。

**手机上"添加到主屏幕"没反应？**
必须是 https 网址（`http://` 局域网地址不行），iOS 用 Safari，Android 用 Chrome。

**导出 PDF 没有背景色？**
打印对话框里勾选「背景图形 / Background graphics」。

**能多人协作 / 云端同步吗？**
目前不能。数据存在各自浏览器里。要做账号体系需要加后端（Supabase 或自建 Node API），工作量约 1–2 周。
