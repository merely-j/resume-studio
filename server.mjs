/**
 * 零依赖静态服务器，只为本地开发 / 手机真机预览
 * 用法：
 *   node server.mjs            # 默认 8080
 *   PORT=3000 node server.mjs  # 换端口（Windows PowerShell: $env:PORT=3000; node server.mjs）
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const ua = (req.headers['user-agent'] || '').slice(0, 70);
  let status = 500;

  // 每个请求打一行日志：排查"页面空白"时，能看出浏览器到底有没有取到 js
  const log = () => {
    const ms = Date.now() - startedAt;
    console.log(`${new Date().toLocaleTimeString('zh-CN')}  ${status}  ${req.method} ${req.url}  ${ms}ms  ${ua}`);
  };

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = resolve(join(root, normalize(pathname)));
    // 防目录穿越：只允许读 root 下的文件
    if (!filePath.startsWith(root)) {
      status = 403;
      res.writeHead(403).end('Forbidden');
      log();
      return;
    }

    const data = await readFile(filePath);
    status = 200;
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // 开发期禁用缓存，改完刷新就生效
    });
    res.end(data);
    log();
  } catch (err) {
    status = 404;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    log();
  }
});

server.listen(port, () => {
  console.log(`\n  简历工坊已启动\n`);
  console.log(`  本机:   http://localhost:${port}/`);
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  手机:   http://${net.address}:${port}/   （手机与电脑需在同一 Wi-Fi）`);
      }
    }
  }
  console.log(`\n  按 Ctrl+C 停止\n`);
});
