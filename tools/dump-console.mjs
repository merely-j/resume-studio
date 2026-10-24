/**
 * 诊断工具：抓 iframe（含沙箱）里的异常、404 和页面状态
 * 用法：
 *   chrome --headless=new --remote-debugging-port=9337 about:blank
 *   node tools/dump-console.mjs file:///D:/ds_workspace/resume-app/tools/sandbox-test.html
 */

const PORT = process.env.CDP_PORT || 9337;
const url =
  process.argv[2] ||
  new URL('../tools/sandbox-test.html', import.meta.url).href;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('没有找到页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

let seq = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    const text = [d.text, d.exception?.description].filter(Boolean).join(' ');
    problems.push('EXCEPTION ' + text.slice(0, 400));
    if (d.stackTrace) {
      d.stackTrace.callFrames.slice(0, 3).forEach((f) => {
        problems.push(`   at ${f.functionName || '(anonymous)'} ${f.url}:${f.lineNumber + 1}`);
      });
    }
  }
  if (msg.method === 'Network.responseReceived') {
    const r = msg.params.response;
    if (r.status >= 400) problems.push(`HTTP ${r.status} ${r.url}`);
  }
  if (msg.method === 'Network.loadingFailed') {
    problems.push(`LOAD FAILED ${msg.params.errorText} ${msg.params.type}`);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = (seq += 1);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(4500);

// 找到 iframe 的 frameId，并在它里面建一个隔离环境读 DOM
const tree = await send('Page.getFrameTree');
const frames = [];
(function walk(node) {
  frames.push(node.frame);
  (node.childFrames || []).forEach(walk);
})(tree.result.frameTree);

console.log('frames:');
frames.forEach((f) => console.log('  ', f.id.slice(0, 8), f.url));

for (const frame of frames) {
  const world = await send('Page.createIsolatedWorld', {
    frameId: frame.id,
    worldName: 'dsh-debug',
  });
  const ctxId = world.result?.executionContextId;
  if (!ctxId) continue;

  const res = await send('Runtime.evaluate', {
    contextId: ctxId,
    returnByValue: true,
    expression: `(() => {
      const box = document.getElementById('bootError');
      const cards = document.querySelectorAll('#editorPane .card').length;
      const paper = document.getElementById('paper');
      return {
        title: document.title,
        bootVisible: box ? !box.hidden : null,
        bootTitle: box ? document.getElementById('bootErrorTitle').textContent : null,
        bootDetail: box ? document.getElementById('bootErrorDetail').textContent : null,
        cards,
        paperChars: paper ? paper.textContent.trim().length : null,
      };
    })()`,
  });
  console.log(`\n[frame ${frame.url}]`);
  console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 2));
}

console.log('\nproblems:');
console.log(problems.length ? problems.join('\n') : '  (none)');

ws.close();
process.exit(0);
