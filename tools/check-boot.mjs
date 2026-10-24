/**
 * 验证"启动自检"真的能兜住脚本加载失败
 * ------------------------------------------------------------
 * 做法：用 Chrome 调试协议把 js/app.js 拦掉（模拟文件 404 / CDN 挂了 / 被扩展拦截），
 * 再看页面有没有出现提示框。这类问题在用户那里就表现为"只有顶部栏，下面是空的"。
 *
 * 用法：
 *   chrome --headless=new --remote-debugging-port=9335 file:///D:/ds_workspace/resume-app/index.html
 *   node tools/check-boot.mjs
 */

import { writeFile } from 'node:fs/promises';

const PORT = process.env.CDP_PORT || 9335;
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8080/';

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('没有找到页面，请先启动带调试端口的 Chrome');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = (seq += 1);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable');
await send('Page.enable');

// 拦掉 JS 入口，模拟"脚本没加载成功"
await send('Network.setBlockedURLs', { urls: ['*js/app.js*'] });
await send('Page.navigate', { url: `${APP_URL}?boottest=1` });
await sleep(3000);

const state = await evaluate(`(() => {
  const box = document.getElementById('bootError');
  return {
    visible: box && !box.hidden,
    title: document.getElementById('bootErrorTitle').textContent,
    detail: document.getElementById('bootErrorDetail').textContent,
    editorCards: document.querySelectorAll('#editorPane .card').length,
  };
})()`);

console.log('提示框可见:', state.visible);
console.log('标题:', state.title);
console.log('内容:', state.detail.replace(/\n/g, ' | '));
console.log('编辑区卡片数:', state.editorCards);

if (state.visible && state.editorCards === 0) {
  console.log('\nPASS 脚本加载失败时，页面显示了可读的错误，而不是一片空白');
} else {
  console.log('\nFAIL 自检没有兜住这种情况');
}

// 截图存证
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  await writeFile('shots/boot-error.png', Buffer.from(shot.result.data, 'base64'));
  console.log('截图: shots/boot-error.png');
}

ws.close();
