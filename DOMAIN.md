# 用自己的域名上线

目标是：`https://你的名字.com` 打开就能用，别人扫码/点链接即可访问。

整件事分三步：**买域名 → 托管静态站 → 把域名指过去**。全程不需要买服务器、不需要写后端。

---

## 第 0 步：先想清楚走哪条路线

| | 海外托管（推荐新手） | 国内托管 |
| --- | --- | --- |
| 托管 | Netlify / Vercel / Cloudflare Pages（免费） | 阿里云 OSS + CDN、腾讯云 COS |
| 备案 | **不需要** | **必须 ICP 备案**（个人可办，约 7–20 天，需身份证+人脸核验） |
| 国内访问速度 | 一般（能打开，首屏 1–3 秒） | 快 |
| 成本 | 域名 60–90 元/年，托管 0 元 | 域名 + 存储/CDN 几元/月起，备案免费 |
| 适合 | 先上线给朋友用、快速验证 | 长期正式运营、面向国内用户 |

**建议**：先走海外托管 → 绑定域名 → 有人用了再考虑备案迁回国内。

---

## 第 1 步：买域名

### 在哪儿买

| 服务商 | 优点 | 注意 |
| --- | --- | --- |
| **Cloudflare Registrar** | 按成本价卖（.com 约 10 美元/年），送免费 CDN/DNS | 需要先有一个域名转入或新注册，支持支付宝？仅信用卡/PayPal |
| **Namecheap / Porkbun** | 便宜、界面简单 | 信用卡/PayPal |
| **阿里云（万网）/ 腾讯云** | 支持支付宝微信，中文客服 | 域名要**实名认证**；用国内服务器还需备案 |

### 怎么选名字

- `.com` 最通用；`.cn` 便宜但要实名+备案（用海外托管则不必备案）
- 短、好念、不含连字符：`jianli.com` 这类多半被注册了，可以试 `jianligongfang.com`、`myresume.cn`
- 别用别人的商标（比如含 "boss"、"51job"）

**价格参考**：`.com` 首年 60–90 元，续费 80–110 元/年；`.cn` 约 30 元/年。

> 买完先别急着解析，等第 2 步站点起来再绑，避免出现"域名打不开"的空窗。

---

## 第 2 步：把站点托管起来

```bash
node tools/build.mjs     # 生成 dist/web/
```

**Netlify Drop**（最快）：

1. 打开 <https://app.netlify.com/drop>，把 `dist/web` 文件夹拖进去
2. 得到一个 `https://xxx.netlify.app`，先确认能打开
3. 注册/登录 Netlify（免费），在 Site settings → Change site name 改成好记的名字

> 也可以用 Vercel、Cloudflare Pages、GitHub Pages，见 [DEPLOY.md](DEPLOY.md)。

---

## 第 3 步：把域名指过去

以 Netlify 为例：

1. Netlify 站点 → **Domain management → Add a domain** → 输入你的域名
2. Netlify 会告诉你两种接法，**选改 DNS（推荐）**：
   - 到域名商后台，把 **Nameservers** 改成 Netlify 给的两条，例如
     ```
     dns1.p0x.nsone.net
     dns2.p0x.nsone.net
     ```
   - 或者保留原 DNS，只加一条 **CNAME** 记录：
     ```
     类型: CNAME    主机记录: www     记录值: xxx.netlify.app
     类型: CNAME    主机记录: @       记录值: xxx.netlify.app   （部分域名商支持根域 CNAME）
     ```
3. 保存后等 **10 分钟 – 24 小时**（通常几分钟），Netlify 会自动签发 HTTPS 证书
4. 在 Netlify 里把主域名设为 `你的域名`，开启 **Force HTTPS**

**验证**：

```bash
nslookup 你的域名
curl -I https://你的域名
```

看到 `200` 且证书正常就成功了。

> Cloudflare 用户更简单：把域名的 NS 指向 Cloudflare，在 Cloudflare DNS 里加 CNAME 指向 Netlify，并把 SSL/TLS 模式设为 **Full (strict)**。

---

## 第 4 步：上线前检查

- [ ] `https://你的域名` 能打开，地址栏有小锁
- [ ] 手机打开 → 浏览器菜单 → 能"添加到主屏幕"
- [ ] 编辑、预览、导出 PDF 都试一遍
- [ ] 把 `index.html` 里的 `og:url` / `og:image` 换成你的绝对地址（分享到微信才有卡片）
- [ ] `manifest.webmanifest` 里的 `name`/`short_name` 改成你的品牌
- [ ] 每次发版把 `sw.js` 的 `CACHE` 版本号 +1

---

## 国内备案（只有用国内服务器才需要）

如果后续要迁到阿里云/腾讯云：

1. 买一台国内服务器或对象存储（需实名）
2. 在服务商备案系统提交：主体信息、网站信息、身份证、人脸核验
3. 管局审核 7–20 天，期间网站不能对外提供访问
4. 备案号下来后，在网站底部放 `京ICP备xxxxxxxx号` 并链接到 beian.miit.gov.cn
5. 域名注册商也要做**域名实名认证**（个人身份证即可）

---

## 费用汇总（第一年）

| 项目 | 金额 |
| --- | --- |
| 域名 `.com` | 60–90 元 |
| 静态托管（Netlify/Vercel 免费额度） | 0 元 |
| HTTPS 证书（Let's Encrypt 自动） | 0 元 |
| **合计** | **约 100 元/年** |

---

## 常见坑

**域名解析了但打不开？**
DNS 生效有延迟；确认记录值没写错（不要带 `https://`）；Netlify 里域名状态要变成 "Netlify DNS" 或 "Verified"。

**HTTPS 证书一直"等待中"？**
通常是 DNS 还没生效。`nslookup 你的域名` 能看到 Netlify 的 IP 才说明生效了。

**国内打开很慢？**
海外托管的正常现象。要快就迁国内 + 备案，或者套一层国内 CDN（需备案域名）。

**能不能用自己的域名发邮件？**
可以，但和网站无关，需要单独配置 MX 记录（阿里云邮箱/腾讯企业邮免费版）。
