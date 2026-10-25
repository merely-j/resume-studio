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
    syncEnglish,
    localizedResume,
    countMissingEnglish,
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
    langZh: document.getElementById('btnLangZh'),
    langEn: document.getElementById('btnLangEn'),
    noticeBar: document.getElementById('noticeBar'),
    noticeText: document.getElementById('noticeText'),
    btnBatchTranslate: document.getElementById('btnBatchTranslate'),
    btnTranslateSettings: document.getElementById('btnTranslateSettings'),
    settingsDialog: document.getElementById('translateDialog'),
    providerSelect: document.getElementById('providerSelect'),
    baseUrlInput: document.getElementById('baseUrlInput'),
    modelInput: document.getElementById('modelInput'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    btnTestApi: document.getElementById('btnTestApi'),
    testResult: document.getElementById('testResult'),
    translateIntro: document.getElementById('translateIntro'),
    btnTranslateSave: document.getElementById('btnTranslateSave'),
    btnOrder: document.getElementById('btnOrder'),
    orderDialog: document.getElementById('orderDialog'),
    orderList: document.getElementById('orderList'),
    exportDialog: document.getElementById('exportDialog'),
    exportZh: document.getElementById('exportZh'),
    exportEn: document.getElementById('exportEn'),
    exportEnCount: document.getElementById('exportEnCount'),
    btnExportConfirm: document.getElementById('btnExportConfirm'),
    toast: document.getElementById('toast'),
  };

  let state = loadState();
  if (state.lang !== 'en') state.lang = 'zh';
  let saveTimer = null;
  let saveFailed = false;
  let previewFrame = null;
  let fontsChecked = false;
  let englishMissing = 0;

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
    // 英文模式下渲染的是"英文镜像"，结构沿用中文、文案取英文
    el.paper.innerHTML = renderResume(localizedResume(resume, state.lang));
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
    syncLangUi(resume);
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
    renderEditor(el.editor, activeResume(), state.lang);
    renderOrderDialog();
    if (o.focusSelector) {
      const target = el.editor.querySelector(o.focusSelector);
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    el.docName.textContent = activeResume().title || '未命名简历';
  }

  /* ---------------------------- 语言切换 ---------------------------- */

  function setLang(lang) {
    const next = lang === 'en' ? 'en' : 'zh';
    if (state.lang === next) return;
    const wasZh = state.lang === 'zh';
    state.lang = next;
    syncEnglish(activeResume());
    paintEditor();
    renderPreview();
    persist();
    el.editor.scrollTop = 0;

    // 第一次需要英文、又没有配翻译服务：直接把用户带到配置页，
    // 而不是把他丢在一张空白的英文表单上
    if (next === 'en' && !hasApiConfig() && !translateSettings.introSeen) {
      openTranslateSettings({ intro: true });
    } else if (next === 'en' && !hasApiConfig() && wasZh) {
      toast('配好翻译服务后，点「批量翻译」就能生成英文版');
    }
  }

  /** 顶部语言开关 + 待翻译提示条 */
  function syncLangUi(resume) {
    const isEn = state.lang === 'en';
    if (el.langZh) el.langZh.setAttribute('aria-pressed', String(!isEn));
    if (el.langEn) el.langEn.setAttribute('aria-pressed', String(isEn));
    document.body.dataset.lang = state.lang;

    const configured = hasApiConfig();
    const missing = countMissingEnglish(resume);
    englishMissing = isEn ? missing : 0;

    if (el.noticeBar) {
      if (!isEn) {
        el.noticeBar.hidden = true;
      } else if (!configured) {
        // 没配 Key：提示条本身变成入口
        el.noticeText.innerHTML = '英文版需要先配置翻译服务（用自己的 API Key，质量最好）';
        el.btnBatchTranslate.textContent = '配置翻译服务';
        el.noticeBar.hidden = false;
      } else if (missing > 0) {
        el.noticeText.innerHTML = '英文版还有 <b>' + missing + '</b> 处未翻译';
        el.btnBatchTranslate.textContent = '批量翻译';
        el.noticeBar.hidden = false;
      } else {
        el.noticeBar.hidden = true;
      }
    }
    if (el.exportEnCount) {
      el.exportEnCount.textContent = missing ? missing + ' 处待翻译' : '已完成';
    }
  }

  /* ---------------------------- 模块顺序面板 ---------------------------- */

  /** 顺序列表始终同步：弹窗没打开时也渲染，改完名字/增删模块能立刻反映 */
  function renderOrderDialog() {
    if (!el.orderList) return;
    el.orderList.innerHTML = RS.renderOrderList(activeResume());
  }

  function openOrderDialog() {
    renderOrderDialog();
    el.orderDialog.showModal();
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

  function listOf(section, scope) {
    const resume = activeResume();
    // 英文模式下改的是 resume.en 里的镜像数组
    const root = scope === 'en' ? syncEnglish(resume) : resume;
    if (section.indexOf('custom:') === 0) {
      const custom = (root.customSections || []).find((s) => s.id === section.slice(7));
      return custom ? custom.items : null;
    }
    return root[section];
  }

  function setField(section, id, name, value, scope) {
    const resume = activeResume();
    const list = listOf(section, scope);
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

  /** 英文技能 / 证书这类"每行一条"的列表 */
  function setListLines(path, text) {
    const resume = activeResume();
    syncEnglish(resume);
    const list = String(text == null ? '' : text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const keys = path.split('.');
    let node = resume;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = list;
    touch(resume);
    persist();
    schedulePreview();
  }

  /** 英文版"证书 / 语言"：每行一条，转成 extras 结构 */
  function setExtrasLines(path, text) {
    const resume = activeResume();
    const en = syncEnglish(resume);
    const lines = String(text == null ? '' : text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const existing = en.extras || [];
    en.extras = lines.map((line, i) => {
      const base = existing[i] || {};
      return {
        id: base.id || 'x' + Date.now().toString(36) + i,
        label: '',
        value: line,
      };
    });
    touch(resume);
    persist();
    schedulePreview();
  }

  /* ---------------------------- 翻译（用户自带 API Key） ---------------------------- */

  /** 预设服务商：都走 OpenAI 兼容的 /chat/completions */
  const PROVIDERS = [
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    {
      id: 'qwen',
      name: '通义千问',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
    },
    { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
  ];

  const SETTINGS_KEY = 'resume-app.translate.v1';

  function loadTranslateSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    } catch (err) {
      return {};
    }
  }

  function saveTranslateSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      /* 隐私模式下写不进去，忽略 */
    }
  }

  let translateSettings = loadTranslateSettings();
  let translating = false;

  const hasApiConfig = () =>
    Boolean(translateSettings.apiKey && translateSettings.baseUrl && translateSettings.model);

  /** 调一次 OpenAI 兼容的 chat/completions */
  async function callChat(messages, options) {
    const opts = options || {};
    const base = String(translateSettings.baseUrl || '').replace(/\/+$/, '');
    const url = base + '/chat/completions';
    const body = {
      model: translateSettings.model,
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      messages: messages,
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + translateSettings.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('接口返回 ' + res.status + (text ? '：' + text.slice(0, 160) : ''));
    }
    const data = await res.json();
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
    return String(content || '');
  }

  /** 去掉富文本标签，翻译只送纯文本 */
  const plainText = (value) =>
    String(value == null ? '' : value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .trim();

  /** 收集"需要翻译"的字段（key 里带 id，方便写回） */
  function collectTranslatable(resume) {
    const fields = [];
    const b = resume.basics || {};
    ['name', 'headline', 'city', 'website', 'summary', 'gender', 'ethnicity', 'hometown', 'politics'].forEach((key) => {
      const text = plainText(b[key]);
      if (text) fields.push({ key: 'basics.' + key, text: text });
    });

    (resume.experience || []).forEach((item) => {
      if (plainText(item.company)) fields.push({ key: 'experience:' + item.id + ':company', text: plainText(item.company) });
      if (plainText(item.role)) fields.push({ key: 'experience:' + item.id + ':role', text: plainText(item.role) });
      if (plainText(item.desc)) fields.push({ key: 'experience:' + item.id + ':desc', text: plainText(item.desc) });
    });
    (resume.projects || []).forEach((item) => {
      if (plainText(item.name)) fields.push({ key: 'projects:' + item.id + ':name', text: plainText(item.name) });
      if (plainText(item.role)) fields.push({ key: 'projects:' + item.id + ':role', text: plainText(item.role) });
      if (plainText(item.desc)) fields.push({ key: 'projects:' + item.id + ':desc', text: plainText(item.desc) });
    });
    (resume.education || []).forEach((item) => {
      if (plainText(item.school)) fields.push({ key: 'education:' + item.id + ':school', text: plainText(item.school) });
      if (plainText(item.major)) fields.push({ key: 'education:' + item.id + ':major', text: plainText(item.major) });
      if (plainText(item.degree)) fields.push({ key: 'education:' + item.id + ':degree', text: plainText(item.degree) });
      if (plainText(item.desc)) fields.push({ key: 'education:' + item.id + ':desc', text: plainText(item.desc) });
    });

    const skills = (resume.skills || []).filter(Boolean);
    if (skills.length) fields.push({ key: 'skills', text: skills.join(' / ') });

    (resume.customSections || []).forEach((custom) => {
      (custom.items || []).forEach((item) => {
        const prefix = 'custom:' + custom.id + ':' + item.id + ':';
        ['name', 'role', 'desc'].forEach((f) => {
          if (plainText(item[f])) fields.push({ key: prefix + f, text: plainText(item[f]) });
        });
      });
    });
    return fields;
  }

  /** 把一条翻译写回英文镜像 */
  function applyTranslation(key, value) {
    const resume = activeResume();
    const en = syncEnglish(resume);
    if (!value) return;

    if (key === 'skills') {
      en.skills = String(value)
        .split(/\s*\/\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      return;
    }
    if (key.indexOf('basics.') === 0) {
      en.basics[key.slice(7)] = value;
      return;
    }
    const parts = key.split(':');
    if (parts[0] === 'custom:') {
      const custom = (en.customSections || []).find((c) => c.id === parts[1]);
      const item = custom && (custom.items || []).find((it) => it.id === parts[2]);
      if (item) item[parts[3]] = value;
      return;
    }
    const list = en[parts[0]] || [];
    const item = list.find((it) => it.id === parts[1]);
    if (item) item[parts[2]] = value;
  }

  /** 按约 1200 字切批，避免单次请求过长 */
  function chunkFields(fields) {
    const batches = [];
    let current = [];
    let size = 0;
    fields.forEach((field) => {
      const len = field.text.length + 20;
      if (current.length && size + len > 1200) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(field);
      size += len;
    });
    if (current.length) batches.push(current);
    return batches;
  }

  /** 翻译一批：只发 id + 原文，要求返回 JSON */
  async function translateBatch(batch) {
    const payload = batch.map((field) => ({ id: field.key, text: field.text }));
    const prompt = [
      '把下面每条中文内容翻译成简洁、专业的英文简历用语。',
      '要求：保留数字与指标；公司名、学校名、项目名保留中文原文并在括号内给英文；不要添加原文没有的信息；',
      '输出严格的 JSON 对象：{"items":[{"id":"原 id","en":"英文"}]}，不要包含其他文字。',
      '',
      JSON.stringify(payload),
    ].join('\n');

    const content = await callChat(
      [
        { role: 'system', content: '你是专业的英文简历译者，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      { json: true }
    );

    const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error('返回内容不是合法 JSON');
    }
    const items = Array.isArray(parsed) ? parsed : parsed.items || parsed.data || [];
    if (!Array.isArray(items) || !items.length) throw new Error('返回里没有翻译结果');
    items.forEach((item) => applyTranslation(String(item.id || ''), String(item.en || '')));

    // 翻译结果是数据，必须落盘，否则刷新页面就丢了
    touch(activeResume());
    persist();
  }

  /** 批量翻译：整份简历（跳过已经翻译过的） */
  async function translateAll() {
    if (translating) return;
    if (!hasApiConfig()) {
      openTranslateSettings();
      toast('先填写翻译服务的 API Key');
      return;
    }
    const resume = activeResume();
    const fields = collectTranslatable(resume);
    if (!fields.length) {
      toast('中文版还没有可翻译的内容');
      return;
    }

    translating = true;
    const batches = chunkFields(fields);
    try {
      for (let i = 0; i < batches.length; i += 1) {
        if (el.noticeText) {
          el.noticeText.innerHTML = '正在翻译 ' + (i + 1) + ' / ' + batches.length + ' 批…';
        }
        // 串行请求：并发容易被服务商限流，而且进度看不清
        await translateBatch(batches[i]);
        renderPreview();
      }
      toast('翻译完成，英文内容可以逐条修改');
    } catch (err) {
      console.error(err);
      toast('翻译失败：' + err.message);
    } finally {
      translating = false;
      syncLangUi(activeResume());
      renderPreview();
    }
  }

  /** 只翻译某一条经历 */
  async function translateItem(section, id) {
    if (translating) return;
    if (!hasApiConfig()) {
      openTranslateSettings();
      toast('先填写翻译服务的 API Key');
      return;
    }
    const resume = activeResume();
    const fields = collectTranslatable(resume).filter((field) => field.key.indexOf(':' + id + ':') !== -1);
    if (!fields.length) {
      toast('这一条没有可翻译的文字');
      return;
    }
    translating = true;
    try {
      await translateBatch(fields);
      paintEditor();
      renderPreview();
      toast('这一条翻译好了');
    } catch (err) {
      console.error(err);
      toast('翻译失败：' + err.message);
    } finally {
      translating = false;
    }
  }

  function openTranslateSettings(options) {
    const opts = options || {};
    const provider = PROVIDERS.find((p) => p.id === translateSettings.provider) || PROVIDERS[0];
    el.providerSelect.value = provider.id;
    el.baseUrlInput.value = translateSettings.baseUrl || provider.baseUrl;
    el.modelInput.value = translateSettings.model || provider.model;
    el.apiKeyInput.value = translateSettings.apiKey || '';
    el.testResult.textContent = '';
    // 引导模式：多显示一段说明，告诉用户"为什么要填 Key"
    if (el.translateIntro) el.translateIntro.hidden = !opts.intro;
    if (el.btnTranslateSave) {
      el.btnTranslateSave.textContent = opts.intro ? '保存并翻译' : '保存';
    }
    el.settingsDialog.dataset.intro = opts.intro ? '1' : '';
    el.settingsDialog.showModal();
    if (opts.intro) {
      setTimeout(() => el.apiKeyInput.focus({ preventScroll: true }), 120);
    }
  }

  function readSettingsFromDialog() {
    return {
      provider: el.providerSelect.value,
      baseUrl: el.baseUrlInput.value.trim(),
      model: el.modelInput.value.trim(),
      apiKey: el.apiKeyInput.value.trim(),
    };
  }

  async function testConnection() {
    const candidate = readSettingsFromDialog();
    if (!candidate.apiKey || !candidate.baseUrl || !candidate.model) {
      el.testResult.textContent = '请先填完地址、模型和 Key';
      return;
    }
    const previous = translateSettings;
    translateSettings = candidate;
    el.testResult.textContent = '测试中…';
    try {
      const content = await callChat([{ role: 'user', content: '回复两个字：正常' }], { temperature: 0 });
      el.testResult.textContent = '✅ 连接正常' + (content ? '：' + content.slice(0, 20) : '');
    } catch (err) {
      el.testResult.textContent = '❌ ' + err.message;
    } finally {
      translateSettings = previous;
    }
  }

  function addItem(section, scope) {
    const resume = activeResume();
    const list = listOf(section, scope);
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

  async function removeItem(section, id, scope) {
    const list = listOf(section, scope);
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

  function moveItem(section, id, dir, scope) {
    const list = listOf(section, scope);
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

  function addChip(value, scope) {
    const resume = activeResume();
    const root = scope === 'en' ? syncEnglish(resume) : resume;
    root.skills = root.skills || [];
    if (root.skills.indexOf(value) !== -1) {
      toast('这项技能已经添加过了');
      return;
    }
    root.skills.push(value);
    touch(resume);
    persist();
    paintEditor({ focusSelector: '[data-chip-input]' });
    schedulePreview();
  }

  function removeChip(index, scope) {
    const resume = activeResume();
    const root = scope === 'en' ? syncEnglish(resume) : resume;
    root.skills.splice(index, 1);
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

    // 同步编辑器里的卡片头和"模块顺序"面板，避免整块重绘导致输入框失焦
    const label = sectionTitle(resume, sectionId);
    const head = el.editor.querySelector('[data-card="' + sectionId + '"] .card-title');
    if (head) head.textContent = label;
    const rowName = el.orderList
      ? el.orderList.querySelector('[data-order-id="' + sectionId + '"] .order-name')
      : null;
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

  function exportPdf(lang) {
    const target = lang === 'en' ? 'en' : 'zh';
    const resume = activeResume();
    const filename = safeName(resume.title) + (target === 'en' ? '-EN' : '-中文');
    const previousTitle = document.title;
    const previousLang = state.lang;

    // 打印的是"当前预览"，所以先切到要导出的语言
    if (state.lang !== target) {
      state.lang = target;
      paintEditor();
      renderPreview();
    }

    // 浏览器打印时，"另存为 PDF"的默认文件名取自 document.title，
    // 所以打印前临时把标题换成简历名，打完再换回来。
    document.title = filename;
    toast('文件名默认是「' + filename + '」，在打印窗口选「另存为 PDF」');

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      document.title = previousTitle;
      window.removeEventListener('afterprint', restore);
      if (state.lang !== previousLang) {
        state.lang = previousLang;
        paintEditor();
        renderPreview();
      }
    };
    window.addEventListener('afterprint', restore);
    // 兜底：某些环境下 afterprint 不触发
    setTimeout(restore, 60000);

    // 等 toast 画出来再调起打印，否则部分浏览器会吞掉提示
    setTimeout(() => window.print(), 250);
  }

  /** 导出前先问：中文版还是英文版 */
  function openExportDialog() {
    syncLangUi(activeResume());
    const isEn = state.lang === 'en';
    el.exportEn.checked = isEn;
    el.exportZh.checked = !isEn;
    el.exportDialog.showModal();
  }

  function confirmExport() {
    const lang = el.exportEn.checked ? 'en' : 'zh';
    if (lang === 'en') {
      const missing = countMissingEnglish(activeResume());
      if (missing > 0) {
        toast('英文版还有 ' + missing + ' 处没翻译，会以空内容导出');
      }
    }
    el.exportDialog.close();
    exportPdf(lang);
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

  /** 预览区点某个模块 → 跳到左侧对应卡片，展开并聚焦第一个输入框 */
  function jumpToSection(target) {
    if (!target) return;
    const cardKey = target.indexOf('custom:') === 0 ? 'custom_' + target.slice(7) : target;
    if (document.body.dataset.view === 'preview') setView('edit');
    const card = el.editor.querySelector('[data-card="' + cardKey + '"]');
    if (!card) return;
    if (card.tagName === 'DETAILS') card.open = true;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('is-flash');
    void card.offsetWidth;
    card.classList.add('is-flash');
    const field = card.querySelector('input, textarea, [contenteditable="true"]');
    if (field) setTimeout(() => field.focus({ preventScroll: true }), 380);
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
      setListLines: withHistory(setListLines),
      setExtrasLines: withHistory(setExtrasLines),
      translateItem: translateItem,
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
    if (el.btnQuickExport) el.btnQuickExport.addEventListener('click', openExportDialog);

    // 移动端 编辑 / 预览 切换
    document.querySelectorAll('[data-view-btn]').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.viewBtn));
    });

    document.getElementById('btnResumes').addEventListener('click', openDialog);
    document.getElementById('btnExportPdf').addEventListener('click', openExportDialog);
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

    /* ---------- 中英切换 ---------- */
    if (el.langZh) el.langZh.addEventListener('click', () => setLang('zh'));
    if (el.langEn) el.langEn.addEventListener('click', () => setLang('en'));
    // 无 Key 时提示条上的按钮是"配置翻译服务"，配好之后才是"批量翻译"
    if (el.btnBatchTranslate) {
      el.btnBatchTranslate.addEventListener('click', () => {
        if (!hasApiConfig()) openTranslateSettings({ intro: true });
        else translateAll();
      });
    }

    /* ---------- 翻译设置 ---------- */
    el.providerSelect.innerHTML = PROVIDERS.map(
      (p) => '<option value="' + p.id + '">' + p.name + '</option>'
    ).join('');
    if (el.btnTranslateSettings) {
      el.btnTranslateSettings.addEventListener('click', () => openTranslateSettings());
    }
    el.providerSelect.addEventListener('change', () => {
      const provider = PROVIDERS.find((p) => p.id === el.providerSelect.value);
      if (provider && provider.id !== 'custom') {
        el.baseUrlInput.value = provider.baseUrl;
        el.modelInput.value = provider.model;
      }
    });
    el.btnTestApi.addEventListener('click', testConnection);

    // 保存：记下"已经看过引导"，配好之后如果正停在英文页，直接开始翻译
    el.btnTranslateSave.addEventListener('click', () => {
      translateSettings = Object.assign({}, readSettingsFromDialog(), { introSeen: true });
      saveTranslateSettings(translateSettings);
      el.settingsDialog.close();
      toast('翻译设置已保存');
      syncLangUi(activeResume());
      if (state.lang === 'en' && countMissingEnglish(activeResume()) > 0) {
        translateAll();
      }
    });

    document.querySelectorAll('[data-close-translate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        translateSettings = Object.assign({}, translateSettings, { introSeen: true });
        saveTranslateSettings(translateSettings);
        el.settingsDialog.close();
      });
    });

    /* ---------- 模块顺序 ---------- */
    if (el.btnOrder) el.btnOrder.addEventListener('click', openOrderDialog);
    if (el.orderList) {
      el.orderList.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-action="move-section"]');
        if (!btn) return;
        withHistory(moveSection)(btn.dataset.sectionId, Number(btn.dataset.dir));
        renderOrderDialog();
      });
    }
    document.querySelectorAll('[data-close-order]').forEach((btn) => {
      btn.addEventListener('click', () => el.orderDialog.close());
    });
    if (el.orderDialog) {
      el.orderDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        el.orderDialog.close();
      });
    }

    /* ---------- 导出 ---------- */
    el.btnExportConfirm.addEventListener('click', confirmExport);
    el.exportDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      el.exportDialog.close();
    });
    document.querySelectorAll('[data-close-export]').forEach((btn) => {
      btn.addEventListener('click', () => el.exportDialog.close());
    });

    /* ---------- 预览区：悬停出虚框、点击跳回左侧 ---------- */
    el.paper.addEventListener('mouseover', (event) => {
      const section = event.target.closest('[data-target]');
      if (!section || !el.paper.contains(section)) return;
      el.paper.querySelectorAll('[data-target].is-hover').forEach((s) => {
        if (s !== section) s.classList.remove('is-hover');
      });
      section.classList.add('is-hover');
    });
    el.paper.addEventListener('mouseleave', () => {
      el.paper.querySelectorAll('[data-target].is-hover').forEach((s) => s.classList.remove('is-hover'));
    });
    el.paper.addEventListener('click', (event) => {
      const section = event.target.closest('[data-target]');
      if (!section || !el.paper.contains(section)) return;
      jumpToSection(section.dataset.target);
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
