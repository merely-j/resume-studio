/**
 * 应用主控：把数据、编辑器、预览、持久化串起来
 * ------------------------------------------------------------
 * 单一数据流：
 *   用户输入 -> 改 state -> 存 localStorage（防抖）-> 重绘预览
 * 表单只在结构变化时重绘，所以既可以"边写边看"，又不会丢焦点。
 */

(function () {
  'use strict';

  const RS = window.RS || {};
  const {
    clone,
    emptyItem,
    emptyResume,
    emptyCustomSection,
    emptyCustomItem,
    TEMPLATES,
    FONT_SIZE,
    MARGIN_SCALES,
    normalizeFontSize,
    normalizeSectionOrder,
    sectionTitle,
    bindEditor,
    renderEditor,
    renderResume,
    loadState,
    saveState,
  } = RS;

  const MM_TO_PX = 96 / 25.4;
  const A4_WIDTH_PX = 210 * MM_TO_PX; // ≈ 793.7
  const A4_HEIGHT_PX = 297 * MM_TO_PX; // ≈ 1122.5

  const el = {
    editor: document.getElementById('editorPane'),
    paper: document.getElementById('paper'),
    paperWrap: document.getElementById('paperWrap'),
    templateSelect: document.getElementById('templateSelect'),
    fontSizeInput: document.getElementById('fontSizeInput'),
    pageMarginSelect: document.getElementById('pageMarginSelect'),
    sectionGapInput: document.getElementById('sectionGapInput'),
    overflowHint: document.getElementById('overflowHint'),
    docName: document.getElementById('docName'),
    resumeDialog: document.getElementById('resumeDialog'),
    resumeList: document.getElementById('resumeList'),
    newName: document.getElementById('newResumeName'),
    confirmDialog: document.getElementById('confirmDialog'),
    confirmText: document.getElementById('confirmText'),
    btnConfirmOk: document.getElementById('btnConfirmOk'),
    btnConfirmCancel: document.getElementById('btnConfirmCancel'),
    btnFit: document.getElementById('btnFit'),
    btnUndo: document.getElementById('btnUndo'),
    btnRedo: document.getElementById('btnRedo'),
    btnQuickView: document.getElementById('btnQuickView'),
    btnQuickExport: document.getElementById('btnQuickExport'),
    toast: document.getElementById('toast'),
  };

  let state = loadState();
  let saveTimer = null;
  let saveFailed = false;
  let previewFrame = null;
  let fontsChecked = false;

  const escHtml = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });

  const activeResume = () =>
    state.resumes.find((r) => r.id === state.activeId) || state.resumes[0];

  const touch = (resume) => {
    resume.updatedAt = Date.now();
  };

  /* ---------------------------- 保存 ---------------------------- */

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const ok = saveState(state);
      if (!ok && !saveFailed) {
        saveFailed = true;
        toast('本地保存失败（可能是隐私模式），本次修改仅在当前页面有效');
      }
    }, 250);
  }

  /* ---------------------------- 预览 ---------------------------- */

  function renderPreview() {
    const resume = activeResume();
    el.paper.innerHTML = renderResume(resume);
    el.docName.textContent = resume.title || '未命名简历';
    document.title = (resume.title || '我的简历') + ' · 简历工坊';
    if (el.fontSizeInput && document.activeElement !== el.fontSizeInput) {
      el.fontSizeInput.value = String(resume.fontSize || FONT_SIZE.base);
    }
    if (el.pageMarginSelect) el.pageMarginSelect.value = String(resume.pageMargin || 16);
    if (el.sectionGapInput && document.activeElement !== el.sectionGapInput) {
      el.sectionGapInput.value = String(resume.sectionGap == null ? 13 : resume.sectionGap);
    }
    el.paper.style.setProperty('--gap', String(resume.sectionGap == null ? 13 : resume.sectionGap));
    applyLayout(resume);
    syncFitButton(resume);
    checkOverflow();
    fitPaper();

    // 中文字体加载完成后行高会变，重新量一次，避免"页数"提示停在旧值上
    if (document.fonts && !fontsChecked) {
      fontsChecked = true;
      document.fonts.ready.then(() => {
        applyLayout(activeResume());
        checkOverflow();
        fitPaper();
      });
    }
  }

  /* ---------------------------- 版面：字号 / 页边距 / 压到一页 ---------------------------- */

  /** 按当前设置（或压缩模式）把三个 CSS 变量写到纸上 */
  function layoutVars(resume, scale) {
    const k = scale || 1;
    const base = (resume.fontSize || FONT_SIZE.base) * k;
    const margin = (resume.pageMargin || 16) * (k === 1 ? 1 : 0.65 + 0.35 * k);
    el.paper.style.setProperty('--fs', String(base / FONT_SIZE.base));
    el.paper.style.setProperty('--page-margin', String(Math.max(8, margin)));
    el.paper.style.setProperty('--lh', String(k === 1 ? 1 : 0.93 + 0.07 * k));
  }

  /**
   * "压缩到一页"：二分找一个缩放系数，让内容高度刚好落在一页内。
   * 同时缩字号、行距、页边距 —— 只缩其中一项往往不够。
   */
  function applyLayout(resume) {
    if (!resume.fitOnePage) {
      layoutVars(resume, 1);
      return;
    }
    let low = 0.55;
    let high = 1;
    let best = 0.55;
    for (let i = 0; i < 7; i += 1) {
      const mid = (low + high) / 2;
      layoutVars(resume, mid);
      if (el.paper.scrollHeight <= A4_HEIGHT_PX + 2) {
        best = mid;
        low = mid;
      } else {
        high = mid;
      }
    }
    layoutVars(resume, best);
  }

  function syncFitButton(resume) {
    if (!el.btnFit) return;
    const on = !!resume.fitOnePage;
    el.btnFit.setAttribute('aria-pressed', String(on));
    el.btnFit.classList.toggle('is-active', on);
    el.btnFit.textContent = on ? '已压缩 · 点击恢复' : '压缩到一页';
  }

  function schedulePreview() {
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = null;
      renderPreview();
    });
  }

  /** 让 A4 纸在容器里等比缩放，手机上也能看全整页 */
  function fitPaper() {
    const available = el.paperWrap.clientWidth - 32;
    if (available <= 0) return; // 移动端预览被隐藏时不计算
    const scale = Math.min(1, available / A4_WIDTH_PX);
    el.paper.style.transform = 'scale(' + scale + ')';
    el.paperWrap.style.height = el.paper.scrollHeight * scale + 32 + 'px';
  }

  /** 超过一页 A4 时提示，避免用户导出后才发现被截断 */
  function checkOverflow() {
    // 留 8px 容差：scrollHeight 是取整后的整数，内容刚好填满一页时
    // 会算出 1123 > 1122.5，被 Math.ceil 误判成 2 页。
    const height = el.paper.scrollHeight;
    const pages = Math.max(1, Math.ceil((height - 8) / A4_HEIGHT_PX));
    const resume = activeResume();

    if (resume.fitOnePage) {
      // 压缩模式：能塞进一页就不提示；实在塞不下才提示内容太多
      el.overflowHint.hidden = pages <= 1;
      el.overflowHint.textContent =
        pages > 1 ? '已压到最小字号，仍约 ' + pages + ' 页，建议再精简内容' : '';
      return;
    }

    if (pages > 1) {
      el.overflowHint.textContent = '内容约 ' + pages + ' 页 A4，可点右侧「压缩到一页」';
      el.overflowHint.hidden = false;
    } else {
      el.overflowHint.hidden = true;
    }
  }

  /* ---------------------------- 编辑器重绘 ---------------------------- */

  function paintEditor(options) {
    const o = options || {};
    renderEditor(el.editor, activeResume());
    if (o.focusSelector) {
      const target = el.editor.querySelector(o.focusSelector);
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    el.docName.textContent = activeResume().title || '未命名简历';
  }

  /* ---------------------------- 数据操作 ---------------------------- */

  function setPath(path, value) {
    const resume = activeResume();
    const keys = path.split('.');
    let node = resume;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
    touch(resume);
    if (path === 'title') el.docName.textContent = value || '未命名简历';
    persist();
    schedulePreview();
  }

  /** 自定义模块用 "custom:<id>" 作为 section 名，这里统一取到它的条目数组 */
  function findCustom(sectionId) {
    return (activeResume().customSections || []).find((s) => s.id === sectionId);
  }

  function listOf(section) {
    const resume = activeResume();
    if (section.indexOf('custom:') === 0) {
      const custom = findCustom(section.slice(7));
      return custom ? custom.items : null;
    }
    return resume[section];
  }

  function setField(section, id, name, value) {
    const resume = activeResume();
    const list = listOf(section);
    if (!list) return;
    const item = list.find((it) => it.id === id);
    if (!item) return;
    item[name] = value;
    touch(resume);
    persist();
    schedulePreview();
    // 条目标题（公司名 / 项目名 / 自定义模块的名称）实时同步到卡片头
    if (name === 'company' || name === 'name' || name === 'school' || name === 'label') {
      const titleEl = el.editor.querySelector('[data-item="' + id + '"] .item-title');
      if (titleEl) titleEl.textContent = value || '新条目';
    }
  }

  /** 自定义模块的标题 / 字段显示名 */
  function setCustomMeta(sectionId, key, value) {
    const resume = activeResume();
    const custom = findCustom(sectionId);
    if (!custom) return;
    if (key === 'title') {
      custom.title = value;
    } else if (key.indexOf('label:') === 0) {
      custom.labels[key.slice(6)] = value;
    }
    touch(resume);
    persist();
    schedulePreview();

    // 标题改了：同步卡片头和"模块顺序"里的名字，避免整块重绘导致输入框失焦
    if (key === 'title') {
      const head = el.editor.querySelector('[data-card="custom_' + sectionId + '"] .card-title');
      if (head) head.textContent = value || '自定义模块';
      const rowName = el.editor.querySelector('[data-order-id="' + sectionId + '"] .order-name');
      if (rowName) rowName.textContent = value || '自定义模块';
    }
  }

  function addItem(section) {
    const resume = activeResume();
    const list = listOf(section);
    if (!list) return;
    list.push(section.indexOf('custom:') === 0 ? emptyCustomItem() : emptyItem(section));
    touch(resume);
    persist();
    const custom = section.indexOf('custom:') === 0;
    paintEditor({
      focusSelector: custom
        ? '[data-action="add-item"][data-section="' + section + '"]'
        : '[data-card="' + section + '"] .item:last-child input',
    });
    schedulePreview();
  }

  async function removeItem(section, id) {
    const list = listOf(section);
    if (!list) return;
    const index = list.findIndex((it) => it.id === id);
    if (index === -1) return;
    if (!(await askConfirm('删除这一条内容？删除后可以用「撤销」找回。', '删除'))) return;
    const before = snapshot();
    list.splice(index, 1);
    touch(activeResume());
    persist();
    paintEditor();
    schedulePreview();
    pushHistory(before);
  }

  function moveItem(section, id, dir) {
    const list = listOf(section);
    if (!list) return;
    const index = list.findIndex((it) => it.id === id);
    const target = index + dir;
    if (index === -1 || target < 0 || target >= list.length) return;
    const tmp = list[index];
    list[index] = list[target];
    list[target] = tmp;
    touch(activeResume());
    persist();
    paintEditor();
    schedulePreview();
  }

  /** 新建一个自定义模块（标题和字段名都能改） */
  function addCustomSection() {
    const resume = activeResume();
    resume.customSections = resume.customSections || [];
    const custom = emptyCustomSection('自定义模块');
    resume.customSections.push(custom);
    resume.sectionOrder = normalizeSectionOrder(resume);
    touch(resume);
    persist();
    paintEditor({ focusSelector: '[data-custom-meta="' + custom.id + '"]' });
    schedulePreview();
    toast('已添加自定义模块，可以改名称和字段名');
  }

  async function removeCustomSection(sectionId) {
    const resume = activeResume();
    const target = findCustom(sectionId);
    if (!target) return;
    if (!(await askConfirm('删除「' + target.title + '」整个模块？删除后可以用「撤销」找回。', '删除'))) return;
    const before = snapshot();
    resume.customSections = resume.customSections.filter((s) => s.id !== sectionId);
    resume.sectionOrder = normalizeSectionOrder(resume);
    touch(resume);
    persist();
    paintEditor();
    schedulePreview();
    pushHistory(before);
  }

  function addChip(value) {
    const resume = activeResume();
    resume.skills = resume.skills || [];
    if (resume.skills.indexOf(value) !== -1) {
      toast('这项技能已经添加过了');
      return;
    }
    resume.skills.push(value);
    touch(resume);
    persist();
    paintEditor({ focusSelector: '[data-chip-input]' });
    schedulePreview();
  }

  function removeChip(index) {
    const resume = activeResume();
    resume.skills.splice(index, 1);
    touch(resume);
    persist();
    paintEditor({ focusSelector: '[data-chip-input]' });
    schedulePreview();
  }

  /* ---------------------------- 照片 ---------------------------- */

  /**
   * 把用户选的照片压到指定尺寸再存。
   * 为什么要压：手机原图动辄 3–5MB，转成 base64 会更大，
   * 而 localStorage 通常只有 5MB 额度，直接存原图必然写失败。
   */
  function resizeImage(file, maxW, maxH) {
    return new Promise((resolve, reject) => {
      if (file.type.indexOf('image/') !== 0) {
        reject(new Error('请选择图片文件'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('浏览器无法识别这个图片格式，换张 jpg/png 试试'));
        img.onload = () => {
          const scale = Math.min(1, maxW / img.width, maxH / img.height);
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          // 铺白底：PNG 透明区域转 JPEG 后不会变成黑块
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.86));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function setPhoto(file) {
    if (!file) return;
    resizeImage(file, 480, 600)
      .then((dataUrl) => {
        setPath('basics.photo', dataUrl);
        paintEditor();
        toast('照片已添加');
      })
      .catch((err) => toast('照片处理失败：' + err.message));
  }

  function removePhoto() {
    setPath('basics.photo', '');
    paintEditor();
    toast('已移除照片');
  }

  /** 调换"身份信息"和"联系方式"在简历里的上下顺序 */
  function moveGroup(groupId, dir) {
    const resume = activeResume();
    const basics = resume.basics || {};
    const order =
      Array.isArray(basics.blockOrder) && basics.blockOrder.length === 2
        ? basics.blockOrder.slice()
        : ['contact', 'personal'];
    const from = order.indexOf(groupId);
    const to = from + dir;
    if (from === -1 || to < 0 || to >= order.length) return;
    const tmp = order[from];
    order[from] = order[to];
    order[to] = tmp;
    basics.blockOrder = order;
    touch(resume);
    persist();
    paintEditor();
    schedulePreview();
  }

  /** 调整大模块（个人简介/工作经历/项目/教育/技能/证书）的先后 */
  function moveSection(sectionId, dir) {
    const resume = activeResume();
    const order = normalizeSectionOrder(resume.sectionOrder);
    const from = order.indexOf(sectionId);
    const to = from + dir;
    if (from === -1 || to < 0 || to >= order.length) return;
    const tmp = order[from];
    order[from] = order[to];
    order[to] = tmp;
    resume.sectionOrder = order;
    touch(resume);
    persist();
    paintEditor();
    schedulePreview();
  }

  /** 模块改名（基本信息除外） */
  function setSectionTitle(sectionId, value) {
    const resume = activeResume();
    resume.sectionTitles = resume.sectionTitles || {};
    const text = String(value == null ? '' : value).trim();
    if (text) resume.sectionTitles[sectionId] = text;
    else delete resume.sectionTitles[sectionId];
    touch(resume);
    persist();
    schedulePreview();

    // 同步编辑器里的卡片头和"模块顺序"列表，避免整块重绘导致输入框失焦
    const label = sectionTitle(resume, sectionId);
    const head = el.editor.querySelector('[data-card="' + sectionId + '"] .card-title');
    if (head) head.textContent = label;
    const rowName = el.editor.querySelector('[data-order-id="' + sectionId + '"] .order-name');
    if (rowName) rowName.textContent = label;
  }

  /** 一键压缩 / 恢复 */
  function toggleFitOnePage() {
    const resume = activeResume();
    resume.fitOnePage = !resume.fitOnePage;
    touch(resume);
    persist();
    renderPreview();
    toast(resume.fitOnePage ? '已压缩到一页' : '已恢复原始字号');
  }

  /** 模块间距（px，0–40） */
  function setSectionGap(value) {
    const resume = activeResume();
    const n = Number(value);
    resume.sectionGap = isFinite(n) ? Math.min(40, Math.max(0, Math.round(n))) : 13;
    touch(resume);
    persist();
    schedulePreview();
  }

  /* ---------------------------- 撤销 / 恢复 ---------------------------- */

  const HISTORY_LIMIT = 50;
  const history = { past: [], future: [], lastAt: 0 };

  const snapshot = () => clone(activeResume());

  /**
   * 每次修改前把旧状态压栈。
   * 700ms 内的连续输入合并成一步，否则每敲一个字都是一步，撤销会变成"一个字一个字退"。
   */
  function pushHistory(prev) {
    const now = Date.now();
    if (now - history.lastAt > 700) {
      history.past.push(prev);
      if (history.past.length > HISTORY_LIMIT) history.past.shift();
    }
    history.lastAt = now;
    history.future.length = 0;
    syncHistoryButtons();
  }

  /** 包一层：执行前拍快照，执行后入栈 */
  function withHistory(fn) {
    return function () {
      const before = snapshot();
      const result = fn.apply(null, arguments);
      pushHistory(before);
      return result;
    };
  }

  function applySnapshot(resume) {
    const index = state.resumes.findIndex((r) => r.id === resume.id);
    if (index === -1) return;
    state.resumes[index] = resume;
    paintEditor();
    renderPreview();
    persist();
  }

  function undo() {
    if (!history.past.length) {
      toast('没有可撤销的操作');
      return;
    }
    const prev = history.past.pop();
    history.future.push(snapshot());
    applySnapshot(prev);
    history.lastAt = 0;
    syncHistoryButtons();
    toast('已撤销');
  }

  function redo() {
    if (!history.future.length) {
      toast('没有可恢复的操作');
      return;
    }
    const next = history.future.pop();
    history.past.push(snapshot());
    applySnapshot(next);
    history.lastAt = 0;
    syncHistoryButtons();
    toast('已恢复');
  }

  function syncHistoryButtons() {
    if (el.btnUndo) el.btnUndo.disabled = history.past.length === 0;
    if (el.btnRedo) el.btnRedo.disabled = history.future.length === 0;
  }

  /** 切换简历时清空历史，避免把 A 的操作撤到 B 上 */
  function resetHistory() {
    history.past.length = 0;
    history.future.length = 0;
    history.lastAt = 0;
    syncHistoryButtons();
  }

  /* ---------------------------- 简历管理 ---------------------------- */

  function openResume(id) {
    if (!state.resumes.some((r) => r.id === id)) return;
    state.activeId = id;
    resetHistory();
    persist();
    paintEditor();
    renderPreview();
    closeDialog();
  }

  function createResume() {
    const title = (el.newName.value || '').trim() || '新简历';
    const resume = emptyResume(title);
    state.resumes.unshift(resume);
    state.activeId = resume.id;
    el.newName.value = '';
    resetHistory();
    persist();
    paintEditor({ focusSelector: '[data-bind="basics.name"]' });
    renderPreview();
    renderResumeList();
    toast('已新建简历，开始填写基本信息吧');
  }

  function duplicateResume(id) {
    const source = state.resumes.find((r) => r.id === id);
    if (!source) return;
    const copy = clone(source);
    copy.id = emptyResume().id;
    copy.title = source.title + ' 副本';
    copy.updatedAt = Date.now();
    state.resumes.unshift(copy);
    state.activeId = copy.id;
    resetHistory();
    persist();
    paintEditor();
    renderPreview();
    renderResumeList();
    toast('已复制出一份新简历');
  }

  async function deleteResume(id) {
    if (state.resumes.length <= 1) {
      toast('至少要保留一份简历');
      return;
    }
    const target = state.resumes.find((r) => r.id === id);
    if (!target) return;
    if (!(await askConfirm('删除「' + target.title + '」？', '删除'))) return;
    state.resumes = state.resumes.filter((r) => r.id !== id);
    if (state.activeId === id) state.activeId = state.resumes[0].id;
    persist();
    paintEditor();
    renderPreview();
    renderResumeList();
    toast('已删除');
  }

  function renderResumeList() {
    el.resumeList.innerHTML = state.resumes
      .map((resume) => {
        const date = new Date(resume.updatedAt || Date.now()).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        return (
          '<li class="resume-row' +
          (resume.id === state.activeId ? ' is-active' : '') +
          '">' +
          '<button class="resume-open" data-open="' +
          resume.id +
          '">' +
          '<span class="resume-title">' +
          escHtml(resume.title || '未命名简历') +
          '</span>' +
          '<span class="resume-sub">' +
          escHtml(resume.basics.name || '未填姓名') +
          ' · ' +
          escHtml(date) +
          '</span>' +
          '</button>' +
          '<span class="resume-tools">' +
          '<button class="icon-btn" data-dup="' +
          resume.id +
          '" title="复制这份简历" aria-label="复制">⧉</button>' +
          '<button class="icon-btn icon-btn--danger" data-del="' +
          resume.id +
          '" title="删除" aria-label="删除">✕</button>' +
          '</span>' +
          '</li>'
        );
      })
      .join('');
  }

  /* ---------------------------- 导出 PDF ---------------------------- */

  function safeName(text) {
    return (text || '我的简历').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  }

  function exportPdf() {
    const resume = activeResume();
    const filename = safeName(resume.title);
    const previousTitle = document.title;

    // 浏览器打印时，"另存为 PDF"的默认文件名取自 document.title，
    // 所以打印前临时把标题换成简历名，打完再换回来。
    document.title = filename;
    toast('文件名默认是「' + filename + '」，在打印窗口选「另存为 PDF」');

    let restored = false;
    const restoreTitle = () => {
      if (restored) return;
      restored = true;
      document.title = previousTitle;
      window.removeEventListener('afterprint', restoreTitle);
    };
    window.addEventListener('afterprint', restoreTitle);
    // 兜底：某些环境下 afterprint 不触发
    setTimeout(restoreTitle, 60000);

    // 等 toast 画出来再调起打印，否则部分浏览器会吞掉提示
    setTimeout(() => window.print(), 250);
  }

  /* ---------------------------- 站内确认框 ---------------------------- */

  let confirmResolve = null;

  /**
   * 沙箱 / 内嵌环境里 window.confirm 会被浏览器直接忽略（返回 false），
   * 导致"点删除没反应"。这里用自己的弹窗，行为可控。
   */
  function askConfirm(message, okLabel) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      el.confirmText.textContent = message;
      el.btnConfirmOk.textContent = okLabel || '确定';
      el.confirmDialog.showModal();
    });
  }

  function settleConfirm(result) {
    if (el.confirmDialog.open) el.confirmDialog.close();
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(result);
  }

  /* ---------------------------- 界面交互 ---------------------------- */

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-on'), 2400);
  }

  function setView(view) {
    document.body.dataset.view = view;
    document.querySelectorAll('[data-view-btn]').forEach((btn) => {
      const on = btn.dataset.viewBtn === view;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    // 手机版底部操作条的按钮文案跟着切换
    if (el.btnQuickView) {
      el.btnQuickView.textContent = view === 'preview' ? '继续编辑' : '看预览';
    }
    if (view === 'preview') requestAnimationFrame(fitPaper);
  }

  function openDialog() {
    renderResumeList();
    el.resumeDialog.showModal();
  }

  function closeDialog() {
    if (el.resumeDialog.open) el.resumeDialog.close();
  }

  /* ---------------------------- 启动 ---------------------------- */

  function init() {
    // 模板下拉
    el.templateSelect.innerHTML = TEMPLATES.map(
      (t) => '<option value="' + t.id + '">' + t.name + '</option>'
    ).join('');
    el.templateSelect.value = activeResume().template;

    el.templateSelect.addEventListener(
      'change',
      withHistory(() => {
        const resume = activeResume();
        resume.template = el.templateSelect.value;
        touch(resume);
        persist();
        renderPreview();
      })
    );

    // 字号：直接输入 pt 数字，失焦或回车时生效
    const applyFontSize = withHistory(() => {
      const resume = activeResume();
      resume.fontSize = normalizeFontSize(Number(el.fontSizeInput.value));
      el.fontSizeInput.value = String(resume.fontSize);
      touch(resume);
      persist();
      renderPreview();
    });

    el.fontSizeInput.min = String(FONT_SIZE.min);
    el.fontSizeInput.max = String(FONT_SIZE.max);
    el.fontSizeInput.step = String(FONT_SIZE.step);
    el.fontSizeInput.value = String(activeResume().fontSize || FONT_SIZE.base);
    el.fontSizeInput.addEventListener('change', applyFontSize);
    el.fontSizeInput.addEventListener('blur', applyFontSize);
    el.fontSizeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.fontSizeInput.blur();
      }
    });

    // 页边距档位
    el.pageMarginSelect.innerHTML = MARGIN_SCALES.map(
      (margin) => '<option value="' + margin.value + '">' + margin.label + '</option>'
    ).join('');
    el.pageMarginSelect.value = String(activeResume().pageMargin || 16);
    el.pageMarginSelect.addEventListener(
      'change',
      withHistory(() => {
        const resume = activeResume();
        resume.pageMargin = Number(el.pageMarginSelect.value) || 16;
        touch(resume);
        persist();
        renderPreview();
      })
    );

    // 模块间距（px）
    function applySectionGap() {
      setSectionGap(el.sectionGapInput.value);
    }
    el.sectionGapInput.min = '0';
    el.sectionGapInput.max = '40';
    el.sectionGapInput.step = '1';
    el.sectionGapInput.value = String(activeResume().sectionGap == null ? 13 : activeResume().sectionGap);
    el.sectionGapInput.addEventListener('change', withHistory(applySectionGap));
    el.sectionGapInput.addEventListener('blur', withHistory(applySectionGap));
    el.sectionGapInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.sectionGapInput.blur();
      }
    });

    bindEditor(el.editor, {
      setPath: withHistory(setPath),
      setField: withHistory(setField),
      addItem: withHistory(addItem),
      removeItem: withHistory(removeItem),
      moveItem: withHistory(moveItem),
      addChip: withHistory(addChip),
      removeChip: withHistory(removeChip),
      setPhoto: withHistory(setPhoto),
      removePhoto: withHistory(removePhoto),
      moveGroup: withHistory(moveGroup),
      moveSection: withHistory(moveSection),
      setCustomMeta: withHistory(setCustomMeta),
      addCustomSection: withHistory(addCustomSection),
      removeCustomSection: withHistory(removeCustomSection),
      setSectionTitle: withHistory(setSectionTitle),
      refreshEditor: paintEditor,
    });

    if (el.btnFit) el.btnFit.addEventListener('click', withHistory(toggleFitOnePage));
    if (el.btnUndo) el.btnUndo.addEventListener('click', undo);
    if (el.btnRedo) el.btnRedo.addEventListener('click', redo);
    syncHistoryButtons();

    // 手机版底部操作条（网页版里这两个按钮是隐藏的，绑了也不影响）
    if (el.btnQuickView) {
      el.btnQuickView.addEventListener('click', () => {
        setView(document.body.dataset.view === 'preview' ? 'edit' : 'preview');
      });
    }
    if (el.btnQuickExport) el.btnQuickExport.addEventListener('click', exportPdf);

    // 移动端 编辑 / 预览 切换
    document.querySelectorAll('[data-view-btn]').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.viewBtn));
    });

    document.getElementById('btnResumes').addEventListener('click', openDialog);
    document.getElementById('btnExportPdf').addEventListener('click', exportPdf);
    document.getElementById('btnCloseDialog').addEventListener('click', closeDialog);
    document.getElementById('btnCreateResume').addEventListener('click', createResume);

    el.newName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') createResume();
    });

    el.resumeList.addEventListener('click', (event) => {
      const open = event.target.closest('[data-open]');
      const dup = event.target.closest('[data-dup]');
      const del = event.target.closest('[data-del]');
      if (open) openResume(open.dataset.open);
      else if (dup) duplicateResume(dup.dataset.dup);
      else if (del) deleteResume(del.dataset.del);
    });

    // 站内确认框
    el.btnConfirmOk.addEventListener('click', () => settleConfirm(true));
    el.btnConfirmCancel.addEventListener('click', () => settleConfirm(false));
    el.confirmDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      settleConfirm(false);
    });
    el.confirmDialog.addEventListener('click', (event) => {
      if (event.target === el.confirmDialog) settleConfirm(false);
    });

    // 点击对话框背景关闭
    el.resumeDialog.addEventListener('click', (event) => {
      if (event.target === el.resumeDialog) closeDialog();
    });

    window.addEventListener('resize', () => {
      fitPaper();
      checkOverflow();
    });

    window.addEventListener('beforeunload', () => saveState(state));

    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();

      if (key === 's') {
        event.preventDefault();
        clearTimeout(saveTimer);
        saveState(state);
        toast('已保存');
        return;
      }

      // 撤销 / 恢复：光标在输入框里时交给浏览器做原生撤销，避免抢掉"退一个字"的直觉
      if (key === 'z' || key === 'y') {
        const active = document.activeElement;
        const inField =
          active &&
          (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
        if (inField) return;
        event.preventDefault();
        if (key === 'y' || event.shiftKey) redo();
        else undo();
      }
    });

    paintEditor();
    renderPreview();

    // 支持 ?view=preview 直接打开预览（方便分享链接 / 截图 / 手机主屏快捷方式）
    const preferredView = new URLSearchParams(location.search).get('view');
    const defaultView = window.matchMedia('(min-width: 1024px)').matches ? 'preview' : 'edit';
    setView(
      preferredView === 'preview' || preferredView === 'edit' ? preferredView : defaultView
    );

    // PWA：只在 http(s) 下注册。
    // 沙箱 iframe / file:// 里"读取" navigator.serviceWorker 就会抛 SecurityError，
    // 而且注册发生在 load 回调里，外层的 try 管不到异步代码 —— 所以必须整个函数包住。
    function registerServiceWorker() {
      try {
        if (!('serviceWorker' in navigator)) return;
        if (location.protocol.indexOf('http') !== 0) return;
        navigator.serviceWorker
          .register('./sw.js')
          .catch((err) => console.warn('[sw] 注册失败（不影响使用）', err));
      } catch (err) {
        console.warn('[sw] 当前环境不支持 Service Worker（不影响使用）', err);
      }
    }

    window.addEventListener('load', registerServiceWorker);
  }

  try {
    init();
  } catch (err) {
    console.error('[app] 启动失败', err);
    if (typeof window.__resumeBootError === 'function') {
      window.__resumeBootError('应用启动失败', (err && err.stack) || String(err));
    } else {
      throw err;
    }
  }
})();
