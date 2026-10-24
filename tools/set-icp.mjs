/**
 * 备案号注入工具（国内托管用）
 * ------------------------------------------------------------
 * 在中国大陆托管网站，页脚必须展示 ICP 备案号并链接到工信部。
 * 这个脚本把备案号写进 dist/web/index.html，并带上"打印时隐藏"的样式——
 * 免得备案号出现在导出的 PDF 里。
 *
 * 用法：
 *   node tools/set-icp.mjs "京ICP备2025000000号-1"
 *   node tools/set-icp.mjs --remove        # 去掉备案号
 *
 * 注意：每次重新 build 都会覆盖 dist，所以改完备案号要最后再跑一次这个脚本。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'web', 'index.html');
const MARKER = '<!-- ICP_FOOTER：国内备案后，用 node tools/set-icp.mjs "京ICP备xxxx号" 在这里注入备案号 -->';

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function footerHtml(icp) {
  return `<style>
  /* 备案号：固定在底部，屏幕显示、打印隐藏（不会进 PDF） */
  body { padding-bottom: 30px; }
  .site-icp {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 45;
    padding: 6px 12px; text-align: center;
    font-size: 11px; line-height: 1.4; color: #6b7280;
    background: rgba(255, 255, 255, 0.92);
    border-top: 1px solid #e2e8f0;
    backdrop-filter: blur(6px);
  }
  .site-icp a { color: inherit; text-decoration: none; }
  .site-icp a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    .site-icp { background: rgba(18, 24, 38, 0.92); border-top-color: #232c3d; color: #93a1b8; }
  }
  @media print { .site-icp { display: none !important; } body { padding-bottom: 0 !important; } }
</style>
<div class="site-icp">
  <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${escapeHtml(icp)}</a>
</div>`;
}

const arg = process.argv[2];

if (!arg) {
  console.error('用法: node tools/set-icp.mjs "京ICP备2025000000号-1"  或  node tools/set-icp.mjs --remove');
  process.exit(1);
}

const html = await readFile(target, 'utf8').catch(() => {
  console.error('找不到 dist/web/index.html，先运行 node tools/build.mjs');
  process.exit(1);
});

// 先清掉上一次注入的内容（从 MARKER 到 </body> 之间）
const cleaned = html.replace(
  new RegExp(`${MARKER}[\\s\\S]*?(?=</body>)`),
  MARKER + (arg === '--remove' ? '\n  ' : '\n  ')
);

const next =
  arg === '--remove'
    ? cleaned
    : cleaned.replace(MARKER, `${MARKER}\n  ${footerHtml(arg)}`);

await writeFile(target, next, 'utf8');

if (arg === '--remove') {
  console.log('已移除备案号');
} else {
  console.log(`已写入备案号：${arg}`);
  console.log('提示：页面其余部分不变；每次重新 build 后需要重跑本命令。');
}
