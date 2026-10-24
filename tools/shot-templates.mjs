/**
 * 生成"带照片"的模板截图（README 用）
 * 用法：
 *   chrome --headless=new --remote-debugging-port=9340 about:blank
 *   node tools/shot-templates.mjs
 *
 * 做的事情：真实上传一张照片 -> 依次切到三套模板 -> 分别截图。
 * 这样截出来的图就是用户实际会看到的效果，不是手画的示意图。
 */

import { writeFile } from 'node:fs/promises';

const PORT = process.env.CDP_PORT || 9340;
const APP = process.env.APP_URL || 'http://localhost:8080/';
const AVATAR = decodeURIComponent(new URL('../tests/fixtures/avatar.jpg', import.meta.url).pathname).replace(/^\//, '');

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', j);
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = (expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then(
    (r) => r.result?.result?.value
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');
await send('Page.navigate', { url: APP });
await sleep(2000);

// 真实上传照片
const doc = await send('DOM.getDocument');
const node = await send('DOM.querySelector', {
  nodeId: doc.result.root.nodeId,
  selector: '[data-photo-input]',
});
await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [AVATAR] });
await sleep(1500);

// 预览态 + A4 原尺寸
await evaluate(`document.body.dataset.view = 'preview'; true`);
await send('Emulation.setDeviceMetricsOverride', {
  width: 980,
  height: 1300,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(600);

for (const template of ['classic', 'modern', 'minimal']) {
  await evaluate(`(() => {
    const s = document.getElementById('templateSelect');
    s.value = '${template}';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = `shots/tpl-${template}-photo.png`;
  await writeFile(file, Buffer.from(shot.result.data, 'base64'));
  console.log('wrote', file);
}

// 手机端编辑界面（含照片区域）
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await evaluate(`document.body.dataset.view = 'edit'; window.scrollTo(0, 0); true`);
await sleep(800);
const mobile = await send('Page.captureScreenshot', { format: 'png' });
await writeFile('shots/phone-photo.png', Buffer.from(mobile.result.data, 'base64'));
console.log('wrote shots/phone-photo.png');

// 滚到富文本编辑区，单独截一张（展示加粗/斜体工具栏）
await evaluate(
  `(() => {
     const box = document.querySelector('[data-rich-wrap]');
     if (box) box.scrollIntoView({ block: 'center' });
     return true;
   })()`
);
await sleep(600);
const richShot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile('shots/phone-rich.png', Buffer.from(richShot.result.data, 'base64'));
console.log('wrote shots/phone-rich.png');

// 再滚到"模块顺序"卡片截一张
await evaluate(
  `(() => {
     const card = document.querySelector('[data-card="order"]');
     if (card) card.scrollIntoView({ block: 'start' });
     return true;
   })()`
);
await sleep(600);
const orderShot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile('shots/phone-order.png', Buffer.from(orderShot.result.data, 'base64'));
console.log('wrote shots/phone-order.png');

// 最后演示一次"新增自定义模块"
const customId = await evaluate(
  `(() => {
     document.querySelector('[data-action="add-custom"]').click();
     const input = document.querySelector('[data-custom-meta][data-meta-key="title"]');
     if (!input) return null;
     input.value = '获奖经历';
     input.dispatchEvent(new Event('input', { bubbles: true }));
     return input.dataset.customMeta;
   })()`
);
await sleep(400);
if (customId) {
  await evaluate(
    `(() => {
       const btn = document.querySelector('[data-action="add-item"][data-section="custom:${customId}"]');
       if (btn) btn.click();
       const card = document.querySelector('[data-card="custom_${customId}"]');
       const input = card && card.querySelector('[data-field="name"]');
       if (input) {
         input.value = '全国产品设计大赛';
         input.dispatchEvent(new Event('input', { bubbles: true }));
       }
       card.scrollIntoView({ block: 'start' });
       const titleInput = card.querySelector('[data-custom-meta][data-meta-key="title"]');
       if (titleInput) titleInput.scrollIntoView({ block: 'center' });
       return true;
     })()`
  );
  await sleep(2800); // 等提示条消失再截图
  const customShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('shots/phone-custom.png', Buffer.from(customShot.result.data, 'base64'));
  console.log('wrote shots/phone-custom.png');
}

// 模块改名输入框（以工作经历为例）
await evaluate(
  `(() => {
     const input = document.querySelector('[data-section-title="experience"]');
     if (input) input.scrollIntoView({ block: 'center', behavior: 'instant' });
     return true;
   })()`
);
await sleep(700);
const sectionShot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile('shots/phone-section.png', Buffer.from(sectionShot.result.data, 'base64'));
console.log('wrote shots/phone-section.png');

ws.close();
process.exit(0);
