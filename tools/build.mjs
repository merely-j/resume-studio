/**
 * 打包脚本：一套代码，两种形态
 * ------------------------------------------------------------
 *   dist/web/                     网站版（桌面优先，部署到 Netlify/Vercel 给别人用）
 *   dist/index.html               通用单文件版（双击即用，电脑上改简历）
 *   dist/mobile/index.html        手机版单文件（大按钮 + 底部操作条，专门手机填简历）
 *
 * 手机版 = 通用版 + css/mobile.css + body.mobile-build，不改任何业务逻辑，
 * 所以两个版本的数据格式、导出效果完全一致，维护成本只有一份代码。
 *
 * 用法：node tools/build.mjs
 */

import { readFile, writeFile, mkdir, rm, cp, stat, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const read = (file) => readFile(join(root, file), 'utf8');

const sizeOf = async (file) => {
  try {
    const info = await stat(file);
    return `${(info.size / 1024).toFixed(1)} KB`;
  } catch {
    return '—';
  }
};

/** 用函数做替换，避免代码里的 $& 被当成替换语法 */
const replaceOnce = (source, pattern, text) => {
  if (!pattern.test(source)) throw new Error(`没找到要替换的片段：${pattern}`);
  return source.replace(pattern, () => text);
};

/**
 * 生成单文件 HTML（CSS/JS/图标全部内联）。
 * @param {{mobile?: boolean}} options mobile=true 时额外内联手机版样式并打上 body 标记
 */
async function buildSingleFile(options = {}) {
  const { mobile = false } = options;
  let html = await read('index.html');

  const appCss = await read('css/app.css');
  const resumeCss = await read('css/resume.css');
  html = replaceOnce(
    html,
    /<link rel="stylesheet" href="\.\/css\/app\.css"[^>]*>/,
    `<style>\n${appCss}\n</style>`
  );
  html = replaceOnce(
    html,
    /<link rel="stylesheet" href="\.\/css\/resume\.css"[^>]*>/,
    `<style>\n${resumeCss}\n</style>`
  );

  // 单文件版没有独立资源：favicon 内联，manifest / 桌面图标去掉
  const svg = await read('assets/icon.svg');
  const iconUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  html = replaceOnce(
    html,
    /<link rel="icon" href="\.\/assets\/icon\.svg"[^>]*>/,
    `<link rel="icon" href="${iconUri}">`
  );
  html = html.replace(/<link rel="manifest"[^>]*>\s*/, '');
  html = html.replace(/<link rel="apple-touch-icon"[^>]*>\s*/, '');

  // 按依赖顺序内联 5 个脚本（都是 IIFE，拼在同一作用域不会互相污染）
  for (const name of ['model', 'store', 'preview', 'editor', 'app']) {
    const code = await read(`js/${name}.js`);
    html = replaceOnce(
      html,
      new RegExp(`<script src="\\./js/${name}\\.js"></script>`),
      `<script>\n${code}\n</script>`
    );
  }

  if (mobile) {
    const mobileCss = await read('css/mobile.css');
    html = html.replace('</head>', `<style>\n${mobileCss}\n</style>\n</head>`);
    html = html.replace('<body data-view="edit">', '<body data-view="edit" class="mobile-build">');
  }

  return html;
}

async function buildWeb() {
  const target = join(dist, 'web');
  for (const item of [
    'index.html',
    'manifest.webmanifest',
    'sw.js',
    'css',
    'js',
    'assets',
    'vendor',
  ]) {
    await cp(join(root, item), join(target, item), { recursive: true });
  }

  // 给 css/js 的引用加上版本号：发版后 URL 变化，浏览器/Service Worker 不会再用旧缓存，
  // 用户刷新一次就能拿到新代码（否则要刷两次）。
  const built = await readFile(join(target, 'index.html'), 'utf8');
  const version = (/<meta name="app-version" content="([^"]+)"/.exec(built) || [])[1] || 'dev';
  const stamped = built
    .replace(/href="\.\/css\/([^"]+?)\.css"/g, `href="./css/$1.css?v=${version}"`)
    .replace(/src="\.\/js\/([^"]+?)\.js"/g, `src="./js/$1.js?v=${version}"`);
  await writeFile(join(target, 'index.html'), stamped, 'utf8');

  return target;
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, 'mobile'), { recursive: true });

  // 1. 网站版（不引 mobile.css，桌面优先）
  const web = await buildWeb();

  // 2. 通用单文件版
  const single = await buildSingleFile();
  await writeFile(join(dist, 'index.html'), single, 'utf8');
  await writeFile(join(dist, '简历工坊.html'), single, 'utf8');

  // 3. 手机版单文件（加 mobile.css + body.mobile-build）
  const mobileHtml = await buildSingleFile({ mobile: true });
  await writeFile(join(dist, 'mobile', 'index.html'), mobileHtml, 'utf8');
  await writeFile(join(dist, '简历工坊-手机版.html'), mobileHtml, 'utf8');

  console.log('打包完成：\n');
  console.log(`  网站版      dist/web/                     index.html ${await sizeOf(join(web, 'index.html'))}`);
  console.log(`  通用单文件  dist/简历工坊.html            ${await sizeOf(join(dist, '简历工坊.html'))}`);
  console.log(`  手机版      dist/简历工坊-手机版.html     ${await sizeOf(join(dist, '简历工坊-手机版.html'))}`);
  console.log('\n下一步：');
  console.log('  · 线上：push 到 main，GitHub Actions 自动发布 site');
  console.log('  · 本地看效果：双击 dist/简历工坊.html');
  console.log('  · 手机上看：把 dist/简历工坊-手机版.html 发到手机，用浏览器打开\n');
}

main().catch((err) => {
  console.error('打包失败：', err.message);
  process.exit(1);
});
