/**
 * 端到端测试：通过 Chrome 调试协议（CDP）真的去操作页面
 * ------------------------------------------------------------
 * 冒烟测试只覆盖"数据 -> HTML"，这个脚本覆盖"用户操作 -> 数据 -> 界面"：
 * 打字、加一条经历、加技能、切模板、刷新后是否还在。
 *
 * 默认直接打线上地址，不需要本地服务器：
 *   chrome --headless=new --remote-debugging-port=9333 https://merely-j.github.io/resume-studio/
 *   node tests/e2e.mjs
 *
 * 想测本地文件也行：
 *   APP_URL=file:///D:/ds_workspace/resume-app/index.html node tests/e2e.mjs
 */

import { existsSync, readFileSync } from 'node:fs';

const DEBUG_PORT = process.env.CDP_PORT || 9333;
const APP_URL = process.env.APP_URL || 'https://merely-j.github.io/resume-studio/';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  // 边跑边打，崩在中间时也能看出走到哪一步了
  if (process.env.E2E_VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

async function getPageTarget() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith(APP_URL));
  if (!page) throw new Error('没找到已打开的页面，请先启动带 --remote-debugging-port 的 Chrome');
  return page;
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = (seq += 1);
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { ws, ready, send };
}

async function evaluate(client, expression) {
  const res = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(
      res.result.exceptionDetails.exception?.description || '页面执行出错'
    );
  }
  return res.result?.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等两帧：预览是用 requestAnimationFrame 批量更新的，立刻断言会读到旧 DOM */
const waitFrames = (client) =>
  evaluate(
    client,
    `new Promise((resolve) => {
       requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
     })`
  );

/** 只数编辑器里的条目卡片，不要数带 data-section 的输入框 */
const countItems = (client, section) =>
  evaluate(client, `document.querySelectorAll('#editorPane [data-item]').length`);

async function main() {
  const target = await getPageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');

  // 等页面把示例简历渲染出来
  for (let i = 0; i < 40; i += 1) {
    const ready = await evaluate(
      client,
      `!!document.querySelector('#paper .r-inner') && document.readyState === 'complete'`
    );
    if (ready) break;
    await sleep(150);
  }

  // 1. 打字：值要进预览，并且输入框不能失焦
  await evaluate(
    client,
    `(() => {
      const input = document.querySelector('[data-bind="basics.name"]');
      input.focus();
      input.value = '李雷';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  const typing = await evaluate(
    client,
    `({
      focused: document.activeElement === document.querySelector('[data-bind="basics.name"]'),
      value: document.querySelector('[data-bind="basics.name"]').value,
    })`
  );
  record('输入时输入框保持焦点', typing.focused);

  await waitFrames(client);
  const previewHasName = await evaluate(
    client,
    `document.querySelector('#paper').textContent.includes('李雷')`
  );
  record('输入姓名后预览同步更新', previewHasName);

  await sleep(400); // 等防抖保存落盘
  const saved = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       return state.resumes.find((r) => r.id === state.activeId).basics.name;
     })()`
  );
  record('自动保存到 localStorage', saved === '李雷', `实际=${saved}`);

  // 2. 添加一条工作经历，并填写公司名
  const before = await countItems(client, 'experience');
  await evaluate(
    client,
    `(() => {
      document.querySelector('[data-action="add-item"][data-section="experience"]').click();
      const fields = document.querySelectorAll('[data-field="company"]');
      const last = fields[fields.length - 1];
      last.value = '测试公司';
      last.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  const after = await countItems(client, 'experience');
  record('点按钮能新增一条经历', after === before + 1, `${before} -> ${after}`);

  await waitFrames(client);
  const addedPreview = await evaluate(
    client,
    `document.querySelector('#paper').textContent.includes('测试公司')`
  );
  record('新经历同步到预览', addedPreview);

  const focusedNew = await evaluate(
    client,
    `document.activeElement === document.querySelector('[data-field="company"]:last-of-type') ||
     document.activeElement?.dataset?.field === 'company'`
  );
  record('新增后自动聚焦到新条目', focusedNew);

  // 3. 技能是"一整行"：填一个内容框，预览里用 / 连起来显示
  const skillTyped = await evaluate(
    client,
    `(() => {
       const card = document.querySelector('[data-card="skills"]');
       const rows = card ? card.querySelectorAll('[data-section="skills"][data-field="value"]') : [];
       if (!rows.length) return { ok: false, rows: 0 };
       const value = rows[0];
       value.value = 'TypeScript / Python';
       value.dispatchEvent(new Event('input', { bubbles: true }));
       return { ok: true, rows: rows.length };
     })()`
  );
  await waitFrames(client);
  const skillView = await evaluate(
    client,
    `(() => {
       const paper = document.querySelector('#paper');
       const items = paper.querySelectorAll('.r-extras li');
       const first = items[0] ? items[0].textContent : '';
       return {
         rows: items.length,
         hasLabel: first.indexOf('技能') !== -1,
         hasValue: first.indexOf('TypeScript / Python') !== -1,
       };
     })()`
  );
  record(
    '技能合并成一行显示（加粗「技能」+ 内容）',
    skillTyped.ok && skillTyped.rows === 1 && skillView.hasLabel && skillView.hasValue,
    `编辑行数=${skillTyped.rows} 首行="${skillView.hasLabel ? '技能 ' : ''}${skillView.hasValue ? '内容' : ''}"`
  );

  // 4. 上传照片（用调试协议把文件塞进隐藏的 file input，等价于用户点选文件）
  const avatar = new URL('./fixtures/avatar.jpg', import.meta.url).pathname.replace(/^\//, '');
  await client.send('DOM.enable');
  const doc = await client.send('DOM.getDocument');
  const fileNode = await client.send('DOM.querySelector', {
    nodeId: doc.result.root.nodeId,
    selector: '[data-photo-input]',
  });
  if (fileNode.result.nodeId) {
    await client.send('DOM.setFileInputFiles', {
      nodeId: fileNode.result.nodeId,
      files: [decodeURIComponent(avatar)],
    });
  }
  await sleep(1200); // 读文件 + 缩放是异步的

  const photo = await evaluate(
    client,
    `(() => {
       const img = document.querySelector('#editorPane .photo-thumb img');
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       return {
         thumb: !!img,
         saved: (active.basics.photo || '').slice(0, 22),
         bytes: (active.basics.photo || '').length,
         inPreview: !!document.querySelector('#paper .r-photo'),
       };
     })()`
  );
  record('上传照片后编辑器出现缩略图', photo.thumb);
  record('照片被压缩成 JPEG data URL', photo.saved.indexOf('data:image/jpeg') === 0, `长度 ${photo.bytes}`);
  record('照片渲染到简历预览里', photo.inPreview);

  // 4.0.1 照片和左侧文字块的上下边界要一致（否则两侧留白不齐）
  const headerBox = await evaluate(
    client,
    `(() => {
       const box = (el) => {
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
       };
       const paper = document.getElementById('paper');
       return {
         text: box(paper.querySelector('.r-head-text')),
         photo: box(paper.querySelector('.r-photo')),
       };
     })()`
  );
  record(
    '照片与个人信息块高度一致',
    headerBox.text &&
      headerBox.photo &&
      Math.abs(headerBox.text.h - headerBox.photo.h) <= 2 &&
      Math.abs(headerBox.text.top - headerBox.photo.top) <= 2,
    `文字=${JSON.stringify(headerBox.text)} 照片=${JSON.stringify(headerBox.photo)}`
  );

  // 4.1 删除照片 → 重新上传
  await evaluate(
    client,
    `(() => { document.querySelector('[data-action="remove-photo"]').click(); return true; })()`
  );
  await waitFrames(client);
  const removedPhoto = await evaluate(
    client,
    `(() => ({
       inPreview: !!document.querySelector('#paper .r-photo'),
       inEditor: !!document.querySelector('#editorPane .photo-thumb img'),
       deleteBadge: !!document.querySelector('.photo-del'),
     }))()`
  );
  record(
    '可以删除照片',
    !removedPhoto.inPreview && !removedPhoto.inEditor && !removedPhoto.deleteBadge
  );

  const docAgain = await client.send('DOM.getDocument');
  const inputAgain = await client.send('DOM.querySelector', {
    nodeId: docAgain.result.root.nodeId,
    selector: '[data-photo-input]',
  });
  await client.send('DOM.setFileInputFiles', {
    nodeId: inputAgain.result.nodeId,
    files: [decodeURIComponent(avatar)],
  });
  await sleep(1200);
  const reuploaded = await evaluate(
    client,
    `!!document.querySelector('#paper .r-photo')`
  );
  record('删除后可以重新上传照片', reuploaded);

  // 5. 可选字段：清空后必须从简历里消失，不能留下空行
  await evaluate(
    client,
    `(() => {
      const set = (sel, v) => {
        const el = document.querySelector(sel);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('[data-bind="basics.gender"]', '');
      set('[data-bind="basics.ethnicity"]', '');
      return true;
    })()`
  );
  await waitFrames(client);
  const optional = await evaluate(
    client,
    `(() => {
      const line = document.querySelector('#paper .r-personal');
      return {
        exists: !!line,
        text: line ? line.textContent.replace(/\\s+/g, '') : '',
      };
    })()`
  );
  record('清空个人信息后不留空行', optional.exists && optional.text === '1995-08·浙江杭州·中共党员',
    `实际="${optional.text}"`);

  // 5.1 调换"身份信息"和"联系方式"的上下顺序
  const beforeOrder = await evaluate(
    client,
    `(() => {
       const html = document.querySelector('#paper').innerHTML;
       return { contact: html.indexOf('r-contact'), personal: html.indexOf('r-personal') };
     })()`
  );
  await evaluate(
    client,
    `(() => { document.querySelector('[data-action="move-group"][data-dir="1"]').click(); return true; })()`
  );
  await waitFrames(client);
  const afterOrder = await evaluate(
    client,
    `(() => {
       const html = document.querySelector('#paper').innerHTML;
       return { contact: html.indexOf('r-contact'), personal: html.indexOf('r-personal') };
     })()`
  );
  record(
    '可以调换身份信息/联系方式的顺序',
    beforeOrder.contact < beforeOrder.personal && afterOrder.personal < afterOrder.contact,
    `前 ${beforeOrder.contact}/${beforeOrder.personal} → 后 ${afterOrder.contact}/${afterOrder.personal}`
  );

  // 5.2 富文本：加粗能存进数据、渲染到预览，脚本标签被清掉
  await evaluate(
    client,
    `(() => {
      const box = document.querySelector('[data-rich][data-bind="basics.summary"]');
      box.innerHTML = '我做<b>企业服务</b>产品<script>alert(1)</script>';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );
  await waitFrames(client);
  await sleep(400); // 等防抖保存落盘，否则读到的还是旧值
  const rich = await evaluate(
    client,
    `(() => {
      const html = document.querySelector('#paper').innerHTML;
      const state = JSON.parse(localStorage.getItem('resume-app.v1'));
      const active = state.resumes.find((r) => r.id === state.activeId);
      return {
        hasBold: html.indexOf('<b>企业服务</b>') !== -1,
        hasScript: /<script/i.test(html),
        stored: active.basics.summary,
      };
    })()`
  );
  record('富文本加粗能渲染到预览', rich.hasBold);
  record(
    '富文本存进数据时已净化',
    rich.stored.indexOf('<b>企业服务</b>') !== -1 && !/<script/i.test(rich.stored),
    `存的是 ${rich.stored.slice(0, 40)}`
  );

  // 5.3 大模块（工作经历/教育经历…）上下调换
  const secBefore = await evaluate(
    client,
    `(() => {
       const text = document.querySelector('#paper').textContent;
       return {
         exp: text.indexOf('工作经历'),
         proj: text.indexOf('项目经历'),
         edu: text.indexOf('教育经历'),
       };
     })()`
  );
  await evaluate(
    client,
    `(() => {
       document.querySelector('[data-action="move-section"][data-section-id="education"][data-dir="-1"]').click();
       return true;
     })()`
  );
  await waitFrames(client);
  const secAfter = await evaluate(
    client,
    `(() => {
       const text = document.querySelector('#paper').textContent;
       return {
         exp: text.indexOf('工作经历'),
         proj: text.indexOf('项目经历'),
         edu: text.indexOf('教育经历'),
       };
     })()`
  );
  record(
    '大模块可以上下调换',
    secBefore.proj < secBefore.edu && secAfter.edu < secAfter.proj,
    `上移前 项目${secBefore.proj} < 教育${secBefore.edu}，上移后 教育${secAfter.edu} < 项目${secAfter.proj}`
  );

  // 5.4 字号：直接输入 pt 数字
  const fontBefore = await evaluate(
    client,
    `getComputedStyle(document.querySelector('#paper .r-inner')).fontSize`
  );
  await evaluate(
    client,
    `(() => {
       const input = document.getElementById('fontSizeInput');
       input.value = '12';
       input.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`
  );
  await sleep(200);
  const fontAfter = await evaluate(
    client,
    `getComputedStyle(document.querySelector('#paper .r-inner')).fontSize`
  );
  record(
    '字号可以按数字调大',
    parseFloat(fontAfter) > parseFloat(fontBefore) * 1.1,
    `${fontBefore} → ${fontAfter}`
  );

  // 5.5 页边距调节 + 顶部粗线已删除 + 模块分隔线加深
  const marginBefore = await evaluate(
    client,
    `getComputedStyle(document.querySelector('#paper')).paddingTop`
  );
  await evaluate(
    client,
    `(() => {
       const select = document.getElementById('pageMarginSelect');
       select.value = '20';
       select.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`
  );
  await sleep(200);
  const layout = await evaluate(
    client,
    `(() => {
       const paper = document.querySelector('#paper');
       const head = paper.querySelector('.r-head');
       const title = paper.querySelector('.r-section-title');
       return {
         paddingTop: getComputedStyle(paper).paddingTop,
         headBorder: getComputedStyle(head).borderBottomWidth,
         ruleColor: getComputedStyle(title).borderBottomColor,
       };
     })()`
  );
  record(
    '页边距可以调大',
    parseFloat(layout.paddingTop) > parseFloat(marginBefore) * 1.1,
    `${marginBefore} → ${layout.paddingTop}`
  );
  record('基本信息下的粗线已删除', parseFloat(layout.headBorder) === 0, `border=${layout.headBorder}`);
  record(
    '模块分隔线加深',
    layout.ruleColor === 'rgb(156, 163, 175)',
    `颜色=${layout.ruleColor}`
  );

  // 5.6 自定义模块：添加 → 用铅笔改名 → 加一条 → 进简历
  await evaluate(
    client,
    `(() => { document.querySelector('[data-action="add-custom"]').click(); return true; })()`
  );
  await sleep(300);
  const customId = await evaluate(
    client,
    `(() => {
       const cards = [...document.querySelectorAll('#editorPane [data-card^="custom_"]')];
       const card = cards[cards.length - 1];
       if (!card) return null;
       const id = card.dataset.card.replace('custom_', '');
       const pencil = card.querySelector('[data-action="edit-title"]');
       if (pencil) {
         pencil.click();
         const input = card.querySelector('.card-title-input');
         if (input) {
           input.value = '获奖经历';
           input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
         }
       }
       return id;
     })()`
  );
  record('可以添加自定义模块并改名', !!customId, `id=${customId}`);

  await evaluate(
    client,
    `(() => {
       const btn = document.querySelector('[data-action="add-item"][data-section="custom:${customId}"]');
       if (btn) btn.click();
       return true;
     })()`
  );
  await sleep(200);
  await evaluate(
    client,
    `(() => {
       const card = document.querySelector('[data-card="custom_${customId}"]');
       const input = card && card.querySelector('[data-field="name"]');
       if (!input) return false;
       input.value = '产品设计大赛';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`
  );
  await waitFrames(client);
  await sleep(350);
  const customState = await evaluate(
    client,
    `(() => {
       const html = document.querySelector('#paper').innerHTML;
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       return {
         title: html.indexOf('获奖经历') !== -1,
         item: html.indexOf('产品设计大赛') !== -1,
         saved: (active.customSections || []).length,
         orderRows: document.querySelectorAll('.order-row').length,
       };
     })()`
  );
  record('自定义模块渲染到简历', customState.title && customState.item);
  record(
    '自定义模块进入模块顺序',
    customState.orderRows >= 6 && customState.saved === 1,
    `rows=${customState.orderRows} saved=${customState.saved}`
  );

  // 5.7 点击富文本框必须能进入编辑（防回归：容器不能用 <label> 包，否则焦点会被抢到工具栏按钮上）
  await evaluate(
    client,
    `(() => {
       const box = document.querySelector('[data-card="custom_${customId}"] [data-rich]');
       box.scrollIntoView({ block: 'center', behavior: 'instant' });
       return true;
     })()`
  );
  await sleep(600);
  const boxPos = await evaluate(
    client,
    `(() => {
       const r = document.querySelector('[data-card="custom_${customId}"] [data-rich]').getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
     })()`
  );
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: boxPos.x,
    y: boxPos.y,
    button: 'left',
    clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: boxPos.x,
    y: boxPos.y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(250);
  const focusState = await evaluate(
    client,
    `(() => {
       const active = document.activeElement;
       return {
         isRich: !!(active && active.dataset && active.dataset.rich !== undefined),
         tag: active ? active.tagName + '.' + active.className : null,
       };
     })()`
  );
  record('点击富文本框能聚焦到编辑区', focusState.isRich, `焦点在 ${focusState.tag}`);

  await client.send('Input.insertText', { text: '可以编辑' });
  await sleep(300);
  const typed = await evaluate(
    client,
    `document.querySelector('[data-card="custom_${customId}"] [data-rich]').textContent.indexOf('可以编辑') !== -1`
  );
  record('富文本框能真正输入文字', typed);

  // 5.8 模块标题可以改名（点卡片标题旁的 ✏️，就地编辑）
  const pencil = await evaluate(
    client,
    `(() => {
       const btn = document.querySelector('[data-card="experience"] [data-action="edit-title"]');
       if (!btn) return { ok: false, reason: '没有铅笔按钮' };
       btn.click();
       const input = document.querySelector('[data-card="experience"] .card-title-input');
       if (!input) return { ok: false, reason: '没有进入编辑态' };
       const focused = document.activeElement === input;
       input.value = '职业经历';
       input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
       return { ok: true, focused, value: input.value };
     })()`
  );
  record('点铅笔能就地改模块标题', pencil.ok === true && pencil.focused === true, JSON.stringify(pencil));
  await waitFrames(client);
  const renamed = await evaluate(
    client,
    `(() => {
       const text = document.querySelector('#paper').textContent;
       return {
         custom: text.indexOf('职业经历') !== -1,
         original: text.indexOf('工作经历') !== -1,
         cardTitle: document.querySelector('[data-card="experience"] .card-title').textContent,
         orderName: document.querySelector('[data-order-id="experience"] .order-name').textContent,
       };
     })()`
  );
  record('模块标题改名后简历同步', renamed.custom && !renamed.original);
  record(
    '改名后卡片头与排序列表同步',
    renamed.cardTitle === '职业经历' && renamed.orderName === '职业经历',
    `卡片=${renamed.cardTitle} 排序=${renamed.orderName}`
  );

  // 5.9 压缩到一页：先把字号/边距调大制造两页，再一键压缩
  await evaluate(
    client,
    `(() => {
       const f = document.getElementById('fontSizeInput');
       f.value = '14';
       f.dispatchEvent(new Event('change', { bubbles: true }));
       const m = document.getElementById('pageMarginSelect');
       m.value = '20';
       m.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`
  );
  await sleep(350);
  const beforeFit = await evaluate(client, `document.querySelector('#paper').scrollHeight`);
  await evaluate(client, `(() => { document.getElementById('btnFit').click(); return true; })()`);
  await sleep(500);
  const afterFit = await evaluate(
    client,
    `(() => {
       const paper = document.querySelector('#paper');
       const img = paper.querySelector('.r-photo');
       return {
         height: paper.scrollHeight,
         pressed: document.getElementById('btnFit').getAttribute('aria-pressed'),
         fs: parseFloat(getComputedStyle(paper.querySelector('.r-inner')).fontSize),
         ratio: parseFloat(getComputedStyle(paper).getPropertyValue('--fs') || '1'),
         // 用 computedStyle 读 CSS 像素，不受屏幕缩放（transform）影响
         photoCssW: img ? parseFloat(getComputedStyle(img).width) : null,
       };
     })()`
  );
  record(
    '压缩到一页能把内容塞进一页',
    beforeFit > 1130 && afterFit.height <= 1130 && afterFit.pressed === 'true',
    `${beforeFit}px → ${afterFit.height}px，字号 ${afterFit.fs}px`
  );

  // 压缩时照片只轻微缩放（85%~102%），不会跟着字号一起缩成缩略图
  if (afterFit.photoCssW) {
    const mm26 = (26 * 96) / 25.4;
    const scale = Math.min(1.02, Math.max(0.85, afterFit.ratio));
    const expected = mm26 * scale;
    record(
      '压缩到一页时照片只轻微缩放',
      Math.abs(afterFit.photoCssW - expected) <= Math.max(2, expected * 0.05) &&
        afterFit.photoCssW >= mm26 * 0.84,
      `照片 CSS 宽 ${afterFit.photoCssW.toFixed(1)}px，期望 ${expected.toFixed(1)}px（--fs=${afterFit.ratio}）`
    );
  }

  // 5.10 模块间距 + 撤销 / 恢复
  await evaluate(
    client,
    `(() => {
       const input = document.getElementById('sectionGapInput');
       input.value = '26';
       input.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`
  );
  await sleep(500);
  const gapState = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       const section = document.querySelector('#paper .r-section');
       return {
         css: getComputedStyle(section).marginTop,
         stored: active.sectionGap,
         undoEnabled: !document.getElementById('btnUndo').disabled,
       };
     })()`
  );
  record(
    '模块间距可以调整',
    gapState.css === '26px' && gapState.stored === 26,
    `css=${gapState.css} stored=${gapState.stored}`
  );

  // 撤销：改一段文字后撤回（先等 700ms，让这次修改单独成一步）
  await sleep(900);
  await evaluate(
    client,
    `(() => {
       const box = document.querySelector('[data-rich][data-bind="basics.summary"]');
       box.innerHTML = '撤销测试专用内容';
       box.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`
  );
  await sleep(400);
  const edited = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       return (active.basics.summary || '').indexOf('撤销测试专用内容') !== -1;
     })()`
  );
  await evaluate(client, `(() => { document.getElementById('btnUndo').click(); return true; })()`);
  await sleep(400);
  const undone = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       return {
         gone: (active.basics.summary || '').indexOf('撤销测试专用内容') === -1,
         redoEnabled: !document.getElementById('btnRedo').disabled,
         editorText: document.querySelector('[data-rich][data-bind="basics.summary"]').textContent.slice(0, 6),
       };
     })()`
  );
  record(
    '可以撤销刚才的修改',
    edited && undone.gone && undone.redoEnabled,
    `edited=${edited} gone=${undone.gone} redo=${undone.redoEnabled} 编辑器="${undone.editorText}"`
  );

  await evaluate(client, `(() => { document.getElementById('btnRedo').click(); return true; })()`);
  await sleep(400);
  const redone = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       return (active.basics.summary || '').indexOf('撤销测试专用内容') !== -1;
     })()`
  );
  record('可以恢复被撤销的内容', redone, `恢复到=${redone}`);

  // 6. 切换模板
  const tpl = await evaluate(
    client,
    `(() => {
      const select = document.querySelector('#templateSelect');
      select.value = 'modern';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const paper = document.querySelector('#paper');
      return {
        isModern: !!paper.querySelector('.tpl-modern .r-side'),
        hasContent: paper.textContent.includes('李雷'),
        sidePhoto: !!paper.querySelector('.r-photo--side'),
      };
    })()`
  );
  record('切换模板会重新渲染成双栏', tpl.isModern && tpl.hasContent);
  record('双栏模板把照片放进侧栏', tpl.sidePhoto);

  // 6. 简历列表弹窗（顺便防回归：.sheet 的 display 别把"关闭状态"也显示出来）
  const dialog = await evaluate(
    client,
    `(() => {
      document.getElementById('btnResumes').click();
      const d = document.getElementById('resumeDialog');
      const result = {
        open: d.open,
        display: getComputedStyle(d).display,
        rows: d.querySelectorAll('.resume-row').length,
      };
      d.close();
      return result;
    })()`
  );
  record('简历列表弹窗能打开且有内容', dialog.open && dialog.display === 'flex' && dialog.rows > 0,
    `open=${dialog.open} display=${dialog.display} rows=${dialog.rows}`);

  // 6.1 新建后删除：必须走站内确认框（沙箱里 window.confirm 会被浏览器忽略）
  await evaluate(
    client,
    `(() => {
       document.getElementById('btnResumes').click();
       document.getElementById('newResumeName').value = '临时简历';
       document.getElementById('btnCreateResume').click();
       return true;
     })()`
  );
  await sleep(350);
  const afterCreate = await evaluate(
    client,
    `(() => ({
       rows: document.querySelectorAll('.resume-row').length,
       dialogOpen: document.getElementById('resumeDialog').open,
     }))()`
  );
  await evaluate(
    client,
    `(() => { document.querySelector('.resume-row [data-del]').click(); return true; })()`
  );
  await sleep(300);
  const confirmOpen = await evaluate(client, `document.getElementById('confirmDialog').open`);
  await evaluate(
    client,
    `(() => { document.getElementById('btnConfirmOk').click(); return true; })()`
  );
  await sleep(450);
  const afterDelete = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       return {
         rows: document.querySelectorAll('.resume-row').length,
         titles: state.resumes.map((r) => r.title),
       };
     })()`
  );
  record(
    '新建的简历可以删除（走站内确认框）',
    afterCreate.rows === 2 &&
      afterCreate.dialogOpen === true &&
      confirmOpen === true &&
      afterDelete.rows === 1 &&
      afterDelete.titles.indexOf('临时简历') === -1,
    `新建后 ${afterCreate.rows} 条 → 删除后 ${afterDelete.rows} 条`
  );

  // 7. 刷新后数据还在（持久化 + 恢复）
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: APP_URL });
  await sleep(1800);
  const persisted = await evaluate(
    client,
    `(() => {
       const input = document.querySelector('[data-bind="basics.name"]');
       return {
         name: input && input.value,
         template: document.querySelector('#paper .tpl-modern') ? 'modern' : 'other',
         skills: document.querySelectorAll('[data-card="skills"] .item').length,
       };
     })()`
  );
  record('刷新后姓名仍在', persisted.name === '李雷', `实际=${persisted.name}`);
  record('刷新后模板选择保留', persisted.template === 'modern');
  record('刷新后技能条目仍在', persisted.skills > 0, `条目=${persisted.skills}`);

  // 7.1 导出 PDF 的文件名 = 简历名称（直接下载，不再改 document.title）
  const expectedName = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       window.__downloadedName = null;
       const original = window.RS.pdfExport.download;
       window.RS.pdfExport.download = (paper, name) => {
         window.__downloadedName = name;
         return Promise.resolve(2048);
       };
       document.getElementById('btnExportPdf').click();
       document.getElementById('btnExportConfirm').click();
       window.RS.pdfExport.__original = original;
       return active.title;
     })()`
  );
  await sleep(800);
  const downloadedName = await evaluate(
    client,
    `(() => {
       const name = window.__downloadedName;
       if (window.RS.pdfExport.__original) {
         window.RS.pdfExport.download = window.RS.pdfExport.__original;
         delete window.RS.pdfExport.__original;
       }
       return name;
     })()`
  );
  record(
    '导出 PDF 时文件名取简历名称（带 -中文）',
    downloadedName === expectedName + '-中文.pdf',
    `文件名="${downloadedName}" 期望="${expectedName}-中文.pdf"`
  );

  // 8. 打印样式：预览区顶栏（含"压缩到一页"按钮）不能出现在 PDF 里
  await client.send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(400);
  const printState = await evaluate(
    client,
    `(() => {
       const cs = (el) => (el ? getComputedStyle(el).display : 'missing');
       return {
         previewBar: cs(document.querySelector('.preview-bar')),
         fitButton: cs(document.getElementById('btnFit')),
         editor: cs(document.querySelector('.editor-pane')),
         paper: cs(document.getElementById('paper')),
         hasButtonText: document.body.innerText.indexOf('压缩到一页') !== -1,
       };
     })()`
  );
  await client.send('Emulation.setEmulatedMedia', { media: 'screen' });
  record(
    '打印时隐藏预览区顶栏与压缩按钮',
    printState.previewBar === 'none' &&
      printState.fitButton === 'none' &&
      printState.paper !== 'none' &&
      printState.hasButtonText === false,
    JSON.stringify(printState)
  );

  // 9. 中英双语
  await evaluate(client, `(() => { document.getElementById('btnLangEn').click(); return true; })()`);
  await sleep(700);
  const enUi = await evaluate(
    client,
    `(() => {
       const dialog = document.getElementById('translateDialog');
       return {
         lang: document.body.dataset.lang,
         dialogOpen: dialog.open,
         introVisible: !document.getElementById('translateIntro').hidden,
         saveLabel: document.getElementById('btnTranslateSave').textContent.trim(),
       };
     })()`
  );
  record(
    '第一次切英文会引导配置翻译服务',
    enUi.lang === 'en' && enUi.dialogOpen === true && enUi.introVisible === true && enUi.saveLabel === '保存并翻译',
    JSON.stringify(enUi)
  );

  // 弹窗里要有一份"怎么拿到 API Key"的说明（以 DeepSeek 为例）
  const keyGuide = await evaluate(
    client,
    `(() => {
       const guide = document.querySelector('#translateDialog .key-guide');
       const steps = guide ? guide.querySelectorAll('ol li').length : 0;
       return {
         exists: !!guide,
         steps: steps,
         hasLink: guide ? !!guide.querySelector('a[href*="deepseek"]') : false,
         text: guide ? guide.textContent.replace(/\\s+/g, ' ').trim().slice(0, 30) : '',
       };
     })()`
  );
  record(
    '翻译设置里有获取 API Key 的说明',
    keyGuide.exists && keyGuide.steps >= 4 && keyGuide.hasLink,
    `${keyGuide.steps} 步，开头="${keyGuide.text}"`
  );

  await evaluate(
    client,
    `(() => { document.querySelector('#translateDialog [data-close-translate]').click(); return true; })()`
  );
  await sleep(400);
  const afterDismiss = await evaluate(
    client,
    `(() => ({
       dialogOpen: document.getElementById('translateDialog').open,
       notice: !document.getElementById('noticeBar').hidden,
       noticeText: document.getElementById('noticeText').textContent,
       buttonLabel: document.getElementById('btnBatchTranslate').textContent.trim(),
     }))()`
  );
  record(
    '关掉引导后提示条变成配置入口',
    afterDismiss.dialogOpen === false &&
      afterDismiss.notice === true &&
      afterDismiss.noticeText.indexOf('配置翻译服务') !== -1 &&
      afterDismiss.buttonLabel === '配置翻译服务',
    JSON.stringify(afterDismiss)
  );

  // 还没翻译时，英文稿里不能出现任何中文（包括个人信息行）
  await evaluate(
    client,
    `(() => {
       const dialog = document.getElementById('translateDialog');
       if (dialog.open) dialog.close();
       return true;
     })()`
  );
  await sleep(300);
  const untranslatedPaper = await evaluate(
    client,
    `(() => {
       const paper = document.getElementById('paper');
       const text = paper ? paper.textContent || '' : 'NO_PAPER';
       return {
         lang: document.body.dataset.lang,
         hasChinese: /[\u4e00-\u9fa5]/.test(text),
         sample: text.replace(/\s+/g, ' ').trim().slice(0, 60),
         html: paper ? paper.innerHTML.replace(/\\s+/g, ' ').slice(0, 160) : '',
       };
     })()`
  );
  record(
    '未翻译时英文稿不残留中文',
    untranslatedPaper.lang === 'en' && untranslatedPaper.hasChinese === false,
    `lang=${untranslatedPaper.lang} 纸面="${untranslatedPaper.sample}" html=${untranslatedPaper.html}`
  );

  // 9.1 用假的接口验证"批量翻译"整条链路
  await evaluate(
    client,
    `(() => {
       localStorage.setItem('resume-app.translate.v1', JSON.stringify({
         provider: 'deepseek',
         baseUrl: 'https://api.example.com/v1',
         model: 'test-model',
         apiKey: 'sk-test',
         introSeen: true,
       }));
       return true;
     })()`
  );
  await client.send('Page.reload');
  await sleep(1800);
  await evaluate(client, `(() => { document.getElementById('btnLangEn').click(); return true; })()`);
  await sleep(400);
  await evaluate(
    client,
    `(() => {
       const dialog = document.getElementById('translateDialog');
       if (dialog.open) dialog.close();
       return true;
     })()`
  );
  await evaluate(
    client,
    `(() => {
       window.__translateCalls = 0;
       window.__realFetch = window.__realFetch || window.fetch;
       window.fetch = async (url, init) => {
         window.__translateCalls += 1;
         const body = JSON.parse(init.body);
         const prompt = body.messages[1].content;
         // 真正的载荷是 prompt 的最后一行 JSON 数组
         const payloadLine = prompt.trim().split(String.fromCharCode(10)).pop();
         const items = JSON.parse(payloadLine);
         const mapped = items.map((it) => ({ id: it.id, en: 'EN:' + it.text.slice(0, 12) }));
         return {
           ok: true,
           status: 200,
           json: async () => ({ choices: [{ message: { content: JSON.stringify({ items: mapped }) } }] }),
         };
       };
       document.getElementById('btnBatchTranslate').click();
       return true;
     })()`
  );
  await sleep(2500);
  const translated = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       const en = active.en || {};
       return {
         calls: window.__translateCalls || 0,
         name: (en.basics || {}).name || '',
         firstCompany: ((en.experience || [])[0] || {}).company || '',
         noticeHidden: document.getElementById('noticeBar').hidden,
       };
     })()`
  );
  record(
    '批量翻译会调用接口并写回英文',
    translated.calls > 0 &&
      translated.name.indexOf('EN:') === 0 &&
      translated.firstCompany.indexOf('EN:') === 0,
    `调用 ${translated.calls} 次，name="${translated.name}"`
  );

  // 还原被替换的 fetch，避免影响后面的导出（导出要下载字体）
  await evaluate(client, `(() => { if (window.__realFetch) window.fetch = window.__realFetch; return true; })()`);

  // 9.2 导出弹窗：中文 / 英文两个选项
  const exportUi = await evaluate(
    client,
    `(() => {
       document.getElementById('btnExportPdf').click();
       const dialog = document.getElementById('exportDialog');
       const result = {
         open: dialog.open,
         hasZh: !!document.getElementById('exportZh'),
         hasEn: !!document.getElementById('exportEn'),
       };
       dialog.close();
       return result;
     })()`
  );
  record('导出弹窗可选中文或英文', exportUi.open && exportUi.hasZh && exportUi.hasEn, JSON.stringify(exportUi));

  // 9.3 预览里点模块 → 跳回左侧对应卡片
  await evaluate(client, `(() => { document.getElementById('btnLangZh').click(); return true; })()`);
  await sleep(600);
  const jumped = await evaluate(
    client,
    `(() => {
       const sections = [...document.querySelectorAll('#paper [data-target]')];
       const section = sections.find(
         (s) => s.dataset.target === 'experience' && s.getBoundingClientRect().width > 0
       );
       if (!section) {
         return {
           ok: false,
           reason: '没有找到工作经历模块',
           lang: document.body.dataset.lang,
           count: sections.length,
           targets: sections.map((s) => s.dataset.target),
         };
       }
       section.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
       const hovered = section.classList.contains('is-hover');
       section.click();
       const card = document.querySelector('#editorPane [data-card="experience"]');
       return {
         ok: !!card,
         hovered,
         flashed: card ? card.classList.contains('is-flash') : false,
         label: section.dataset.label,
       };
     })()`
  );
  record(
    '预览里点模块会跳回左侧并高亮',
    jumped.ok && jumped.hovered && jumped.flashed,
    JSON.stringify(jumped)
  );

  // 编辑区顶部要有"可不填"的说明
  const hint = await evaluate(
    client,
    `(() => {
       if (document.body.dataset.lang !== 'zh') document.getElementById('btnLangZh').click();
       const el = document.querySelector('#editorPane .optional-hint');
       return { exists: !!el, text: el ? el.textContent.replace(/\\s+/g, ' ').trim() : '' };
     })()`
  );
  record(
    '编辑区顶部说明了"留空就不显示"',
    hint.exists && hint.text.indexOf('不会出现在导出的 PDF') !== -1,
    hint.text.slice(0, 40)
  );

  // 模块顺序面板：从顶部按钮打开，能真的调整顺序
  const orderUi = await evaluate(
    client,
    `(() => {
       if (document.body.dataset.lang !== 'zh') document.getElementById('btnLangZh').click();
       document.getElementById('btnOrder').click();
       const dialog = document.getElementById('orderDialog');
       const rows = [...document.querySelectorAll('#orderList .order-row')];
       const before = rows.map((r) => r.dataset.orderId);
       const firstDown = document.querySelector('#orderList .order-row [data-dir="1"]');
       if (firstDown) firstDown.click();
       const after = [...document.querySelectorAll('#orderList .order-row')].map((r) => r.dataset.orderId);
       dialog.close();
       return { rows: rows.length, before, after };
     })()`
  );
  await sleep(500);
  const orderStored = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       return active.sectionOrder;
     })()`
  );
  record(
    '模块顺序面板在顶部，能调整顺序',
    orderUi.rows >= 5 &&
      orderUi.before[0] !== orderUi.after[0] &&
      orderStored[0] === orderUi.after[0],
    `前=${orderUi.before.slice(0, 2)} 后=${orderUi.after.slice(0, 2)} 已存=${orderStored.slice(0, 2)}`
  );

  // 自定义模块：能移动，且左侧卡片顺序跟着走
  await evaluate(
    client,
    `(() => {
       const addBtn = document.querySelector('#editorPane [data-action="add-custom"]');
       if (addBtn) addBtn.click();
       return true;
     })()`
  );
  await sleep(500);
  const customFlow = await evaluate(
    client,
    `(() => {
       const state = JSON.parse(localStorage.getItem('resume-app.v1'));
       const active = state.resumes.find((r) => r.id === state.activeId);
       const customId = (active.customSections || []).slice(-1)[0].id;
       document.getElementById('btnOrder').click();
       const rows = [...document.querySelectorAll('#orderList .order-row')];
       const before = rows.map((r) => r.dataset.orderId);
       rows.find((r) => r.dataset.orderId === customId).querySelector('[data-dir="-1"]').click();
       const after = [...document.querySelectorAll('#orderList .order-row')].map((r) => r.dataset.orderId);
       document.getElementById('orderDialog').close();
       return { customId, before, after };
     })()`
  );
  await sleep(600);
  const syncCheck = await evaluate(
    client,
    `(() => {
       // 双栏模板的侧栏在 DOM 里总是排在主栏前面，会干扰顺序比较，先切回单栏
       const select = document.getElementById('templateSelect');
       select.value = 'classic';
       select.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`
  );
  await sleep(500);
  const syncState = await evaluate(
    client,
    `(() => {
       const left = [...document.querySelectorAll('#editorPane .card')]
         .map((c) => c.dataset.card)
         .filter((k) => k !== 'basics')
         .map((k) => (k.indexOf('custom_') === 0 ? k.slice(7) : k));
       const paper = [...document.querySelectorAll('#paper [data-target]')].map((s) => s.dataset.target);
       // 空模块不会渲染到纸上，所以只比对"纸上有的模块"在左侧的相对顺序
       const leftVisible = left.filter((id) => paper.indexOf(id) !== -1);
       return { left, paper, leftVisible };
     })()`
  );
  record(
    '自定义模块可以在顺序面板里移动',
    customFlow.after.indexOf(customFlow.customId) !== customFlow.before.indexOf(customFlow.customId),
    `前=${customFlow.before.slice(-2)} 后=${customFlow.after.slice(-2)}`
  );
  record(
    '左侧填写顺序跟随模块顺序',
    syncState.leftVisible.length > 0 &&
      JSON.stringify(syncState.leftVisible) === JSON.stringify(syncState.paper),
    `左=${syncState.leftVisible.join(',')} 纸=${syncState.paper.join(',')}`
  );

  // 自定义模块也要能从预览点回左侧（用纸面上实际存在的那个自定义模块）
  const customJumpResult = await evaluate(
    client,
    `(() => {
       const builtin = ['summary', 'experience', 'projects', 'education', 'skills'];
       const section = [...document.querySelectorAll('#paper [data-target]')].find(
         (s) => builtin.indexOf(s.dataset.target) === -1
       );
       if (!section) {
         return { ok: false, reason: '纸面上没有自定义模块', targets: [...document.querySelectorAll('#paper [data-target]')].map((s) => s.dataset.target) };
       }
       const id = section.dataset.target;
       section.click();
       const card = document.querySelector('[data-card="custom_' + id + '"]');
       return { ok: !!card, id, flashed: card ? card.classList.contains('is-flash') : false };
     })()`
  );
  record(
    '预览里点自定义模块也会跳回左侧',
    customJumpResult.ok === true && customJumpResult.flashed === true,
    JSON.stringify(customJumpResult)
  );

  // 保存状态 + 历史版本
  const saveStatus = await evaluate(
    client,
    `(() => {
       const input = document.querySelector('[data-bind="basics.name"]');
       input.value = '保存状态测试';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return document.getElementById('saveStatus').textContent;
     })()`
  );
  await sleep(700);
  const savedStatus = await evaluate(client, `document.getElementById('saveStatus').textContent`);
  record('保存后顶部显示"已保存 + 时间"', /已保存/.test(savedStatus), savedStatus);

  const snapUi = await evaluate(
    client,
    `(() => {
       document.getElementById('btnResumes').click();
       const rows = [...document.querySelectorAll('#snapList .snap-row')];
       return { rows: rows.length, hasRestore: rows.length ? !!rows[0].querySelector('[data-restore]') : false };
     })()`
  );
  record('我的简历里有历史版本可恢复', snapUi.rows >= 1 && snapUi.hasRestore, `rows=${snapUi.rows}`);

  const restored = await evaluate(
    client,
    `(() => {
       const btn = document.querySelector('#snapList [data-restore]');
       const snapshotName = btn.closest('.snap-row').querySelector('.snap-title').textContent;
       btn.click();
       const confirmOpen = document.getElementById('confirmDialog').open;
       document.getElementById('btnConfirmOk').click();
       return { snapshotName, confirmOpen };
     })()`
  );
  await sleep(700);
  const afterRestore = await evaluate(
    client,
    `(() => ({
       toast: document.getElementById('toast').textContent,
       name: (document.querySelector('[data-bind="basics.name"]') || {}).value,
     }))()`
  );
  record(
    '历史版本能恢复',
    restored.confirmOpen === true && afterRestore.toast.indexOf('已恢复') !== -1,
    `确认框=${restored.confirmOpen} 提示="${afterRestore.toast}" 姓名=${afterRestore.name}`
  );

  // 导入 PDF：弹窗能打开、能塞文件解析（需要本机有示例 PDF，没有就跳过）
  const samplePdf = process.env.SAMPLE_PDF || 'D:/浏览器文件下载/张哲.pdf';
  if (existsSync(samplePdf)) {
    await evaluate(client, `document.getElementById('btnResumes').click()`);
    await sleep(300);
    await evaluate(client, `document.getElementById('btnImportPdf').click()`);
    await sleep(400);

    const importOpen = await evaluate(client, `document.getElementById('importDialog').open`);
    await client.send('DOM.enable');
    const doc = await client.send('DOM.getDocument', { depth: -1 });
    const node = await client.send('DOM.querySelector', {
      nodeId: doc.result.root.nodeId,
      selector: '#pdfFileInput',
    });
    await client.send('DOM.setFileInputFiles', {
      nodeId: node.result.nodeId,
      files: [samplePdf],
    });

    let parsed = false;
    // 线上首次要下载 pdf.js（1.5MB，GitHub Pages 慢），多等一会儿
    for (let i = 0; i < 200; i += 1) {
      await sleep(500);
      parsed = await evaluate(client, `!document.getElementById('importReview').hidden`);
      if (parsed) break;
    }

    const importReview = await evaluate(
      client,
      `(() => {
         const rows = [...document.querySelectorAll('#importSummary .import-row')];
         const nameRow = rows.find((r) => r.textContent.indexOf('姓名') === 0);
         return {
           name: nameRow ? nameRow.querySelector('span').textContent.trim() : '',
           rawLines: document.getElementById('importRaw').textContent.split(String.fromCharCode(10)).length,
           hasExp: document.getElementById('importSummary').textContent.indexOf('工作经历') !== -1,
           canImport: !document.getElementById('btnImportConfirm').disabled,
         };
       })()`
    );
    record(
      '导入 PDF：解析出姓名与经历',
      importOpen === true && parsed && importReview.name.length > 0 && importReview.hasExp && importReview.canImport,
      JSON.stringify(importReview)
    );

    await evaluate(client, `document.getElementById('btnImportConfirm').click()`);
    await sleep(900);
    const imported = await evaluate(
      client,
      `(() => {
         const s = JSON.parse(localStorage.getItem('resume-app.v1'));
         const a = s.resumes.find((r) => r.id === s.activeId);
         const paper = document.getElementById('paper').textContent;
         return {
           resumes: s.resumes.length,
           name: a.basics.name,
           exp: a.experience.length,
           paperHasName: a.basics.name ? paper.indexOf(a.basics.name) !== -1 : false,
           closed: !document.getElementById('importDialog').open,
         };
       })()`
    );
    record(
      '导入后生成新简历并渲染到纸面',
      imported.resumes >= 2 && imported.name.length > 0 && imported.exp > 0 && imported.paperHasName && imported.closed,
      JSON.stringify(imported)
    );

    // 回归：PDF 内容流顺序 ≠ 视觉顺序时，姓名仍要在最上面
    const orderedPdf = new URL('./fixtures/resume-out-of-order.pdf', import.meta.url).pathname.replace(/^\//, '');
    if (existsSync(orderedPdf)) {
      const orderBuf = readFileSync(orderedPdf);
      const orderCheck = await evaluate(
        client,
        `(async () => {
           const b64 = ${JSON.stringify(orderBuf.toString('base64'))};
           const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
           const r = await window.RS.pdfImport.parse(bytes.buffer);
           return {
             name: r.resume.basics.name,
             firstLine: r.lines[0],
             exp: r.resume.experience.length,
           };
         })()`
      );
      record(
        'PDF 绘制顺序乱掉时，姓名仍在最上面',
        orderCheck && orderCheck.name === '张小明' && orderCheck.firstLine === '张小明' && orderCheck.exp > 0,
        JSON.stringify(orderCheck)
      );
    }
  } else {
    console.log('（跳过 PDF 导入测试：本机没有示例 PDF）');
  }

  // 导出 PDF：点一下直接生成文件（不走打印对话框）
  const exportBtn = await evaluate(
    client,
    `(() => {
       document.getElementById('btnExportPdf').click();
       return {
         dialogOpen: document.getElementById('exportDialog').open,
         label: document.getElementById('btnExportConfirm').textContent.trim(),
       };
     })()`
  );
  record(
    '导出面板只提供下载（没有打印）',
    exportBtn.dialogOpen === true && exportBtn.label.indexOf('下载') !== -1,
    JSON.stringify(exportBtn)
  );

  const pdfOut = await evaluate(
    client,
    `(async () => {
       document.getElementById('exportDialog').close();
       // 先确保字体就绪（线上首次要下载 2.3MB，别把下载时间算进生成超时）
       await window.RS.pdfExport.prefetch();
       const result = await Promise.race([
         window.RS.pdfExport.toBlob(document.getElementById('paper')).then(async (blob) => {
           const buf = new Uint8Array(await blob.arrayBuffer());
           return {
             size: buf.length,
             head: String.fromCharCode.apply(null, buf.slice(0, 5)),
             stage: window.__exportStage,
           };
         }),
         new Promise((resolve) => setTimeout(() => resolve({ timeout: true, stage: window.__exportStage }), 40000)),
       ]);
       const stats = window.__pdfExportStats || {};
       return Object.assign({ runs: stats.runs, pages: stats.pages }, result);
     })()`
  );
  if (pdfOut && pdfOut.timeout) {
    record('能直接生成 PDF 文件（文字版）', false, `超时，卡在 ${pdfOut.stage}`);
  } else {
    record(
      '能直接生成 PDF 文件（文字版）',
      pdfOut.head === '%PDF-' && pdfOut.size > 20000 && pdfOut.runs > 30,
      `${Math.round(pdfOut.size / 1024)}KB，${pdfOut.runs} 行文字，${pdfOut.pages} 页`
    );
  }

  client.ws.close();

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  // 用 exitCode 而不是 process.exit：管道输出时 exit 会把还没刷出去的日志截断
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('E2E 运行失败:', err.message);
  process.exitCode = 2;
});
