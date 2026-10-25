/**
 * 持久化层：用 localStorage 存整个"工作台"状态
 * ------------------------------------------------------------
 * 存的是 { version, resumes: [...], activeId }。
 * 为什么不用 IndexedDB？v1 的数据量只有几十 KB，localStorage 够用且同步读写简单。
 * 等以后照片/附件变大，再换 IndexedDB（接口都包在这一个文件里，改造范围可控）。
 *
 * 注意：在"沙箱 iframe"或隐私模式里，访问 localStorage 本身就可能抛异常，
 * 所以读写都包在 try/catch 里，失败时降级为"仅内存"，页面依然能正常用。
 */

(function () {
  'use strict';

  const RS = (window.RS = window.RS || {});
  const {
    sampleResume,
    normalizeSectionOrder,
    normalizeFontSize,
    CUSTOM_LABELS,
    RESUME_SECTIONS,
    uid,
  } = RS;

  const KEY = 'resume-app.v1';
  const VERSION = 1;

  /** 模块自定义标题：只保留固定模块的、非空的字符串 */
  function normalizeTitles(titles) {
    const out = {};
    if (!titles || typeof titles !== 'object') return out;
    RESUME_SECTIONS.forEach((id) => {
      const value = titles[id];
      if (typeof value === 'string' && value.trim()) out[id] = value;
    });
    return out;
  }

  /** 自定义模块：补齐标题、字段名和条目 */
  function normalizeCustom(section) {
    if (!section || typeof section !== 'object') return null;
    return {
      id: section.id || 'c_' + uid(),
      title: section.title || '自定义模块',
      labels: Object.assign({}, CUSTOM_LABELS, section.labels || {}),
      items: (Array.isArray(section.items) ? section.items : []).map((item) =>
        Object.assign(
          { id: (item && item.id) || uid(), name: '', role: '', start: '', end: '', desc: '' },
          item || {}
        )
      ),
    };
  }

  /** 补齐缺字段，避免旧数据或缺字段数据让渲染层报错 */
  function normalize(resume) {
    const basics = Object.assign(
      {
        name: '',
        headline: '',
        phone: '',
        email: '',
        city: '',
        link: '',
        summary: '',
        photo: '',
        gender: '',
        birthday: '',
        ethnicity: '',
        hometown: '',
        politics: '',
        blockOrder: ['contact', 'personal'],
      },
      resume.basics || {}
    );

    // 顺序数组只接受这两个块；旧数据没有这个字段、或者写坏了，就回退到默认顺序
    const order = Array.isArray(basics.blockOrder)
      ? basics.blockOrder.filter((id) => id === 'contact' || id === 'personal')
      : [];
    basics.blockOrder = order.length === 2 ? order : ['contact', 'personal'];

    const normalized = Object.assign({}, resume, {
      title: resume.title || '未命名简历',
      template: resume.template || 'classic',
      // 字号（pt），老数据里存的是倍率，这里一并换算过来
      fontSize: normalizeFontSize(resume.fontSize, resume.fontScale),
      // 页边距（毫米），限制在合理区间
      pageMargin:
        typeof resume.pageMargin === 'number' && resume.pageMargin >= 6 && resume.pageMargin <= 32
          ? resume.pageMargin
          : 16,
      fitOnePage: resume.fitOnePage === true,
      // 模块间距（px），0–40 之间，默认 13
      sectionGap:
        typeof resume.sectionGap === 'number' && resume.sectionGap >= 0 && resume.sectionGap <= 40
          ? Math.round(resume.sectionGap)
          : 13,
      sectionTitles: normalizeTitles(resume.sectionTitles),
      updatedAt: resume.updatedAt || Date.now(),
      basics: basics,
      experience: Array.isArray(resume.experience) ? resume.experience : [],
      projects: Array.isArray(resume.projects) ? resume.projects : [],
      education: Array.isArray(resume.education) ? resume.education : [],
      skills: Array.isArray(resume.skills) ? resume.skills : [],
      extras: Array.isArray(resume.extras) ? resume.extras : [],
      customSections: (Array.isArray(resume.customSections) ? resume.customSections : [])
        .map(normalizeCustom)
        .filter(Boolean),
    });

    // 顺序要在 customSections 归一化之后再算，否则自定义模块会被当成非法 id 丢掉
    normalized.sectionOrder = normalizeSectionOrder(normalized);
    return normalized;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data.resumes) && data.resumes.length) {
          const resumes = data.resumes.map(normalize);
          const activeId = resumes.some((r) => r.id === data.activeId)
            ? data.activeId
            : resumes[0].id;
          return { version: VERSION, resumes: resumes, activeId: activeId };
        }
      }
    } catch (err) {
      // 隐私模式 / 存储被禁用：降级为内存态
      console.warn('[store] 读取本地数据失败，使用示例数据', err);
    }
    const first = sampleResume();
    return { version: VERSION, resumes: [first], activeId: first.id };
  }

  function saveState(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.assign({}, state, { version: VERSION })));
      return true;
    } catch (err) {
      console.warn('[store] 保存失败', err);
      return false;
    }
  }

  /** 导出成可下载的 JSON 文本 */
  function exportJson(resume) {
    return JSON.stringify({ app: 'resume-app', version: VERSION, resume: resume }, null, 2);
  }

  /** 从 JSON 文本恢复一份简历，字段缺失时自动补齐 */
  function importJson(text) {
    const data = JSON.parse(text);
    const resume = data.resume || data; // 兼容直接导出单个简历对象的情况
    if (!resume || typeof resume !== 'object' || !resume.basics) {
      throw new Error('文件格式不正确：缺少简历内容');
    }
    return normalize(resume);
  }

  /* ---------------------------- 本机历史版本（快照） ---------------------------- */

  const SNAP_KEY = 'resume-app.snapshots.v1';
  const SNAP_LIMIT = 6;
  const SNAP_MAX_BYTES = 2.5 * 1024 * 1024; // 照片会让快照变大，超了就丢最旧的

  function listSnapshots() {
    try {
      const raw = localStorage.getItem(SNAP_KEY);
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (err) {
      return [];
    }
  }

  function writeSnapshots(list) {
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify(list));
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 给当前简历存一份快照；和上一份完全相同就不重复存 */
  function saveSnapshot(state) {
    const active = (state.resumes || []).find((r) => r.id === state.activeId);
    if (!active) return null;

    const resume = JSON.parse(JSON.stringify(active));
    const list = listSnapshots();
    if (list[0] && JSON.stringify(list[0].resume) === JSON.stringify(resume)) return null;

    const snap = {
      // 同一毫秒内连续存多份时，单靠时间戳会撞 id，加随机后缀
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: Date.now(),
      title: active.title || '未命名简历',
      resume: resume,
    };
    list.unshift(snap);

    while (list.length > SNAP_LIMIT) list.pop();
    let ok = writeSnapshots(list);
    while (!ok && list.length > 1) {
      list.pop();
      ok = writeSnapshots(list);
    }
    void SNAP_MAX_BYTES;
    return ok ? snap : null;
  }

  function deleteSnapshot(id) {
    const list = listSnapshots().filter((s) => s.id !== id);
    writeSnapshots(list);
    return list;
  }

  function clearSnapshots() {
    try {
      localStorage.removeItem(SNAP_KEY);
    } catch (err) {
      /* ignore */
    }
  }

  RS.loadState = loadState;
  RS.saveState = saveState;
  RS.exportJson = exportJson;
  RS.importJson = importJson;
  RS.normalizeResume = normalize;
  RS.listSnapshots = listSnapshots;
  RS.saveSnapshot = saveSnapshot;
  RS.deleteSnapshot = deleteSnapshot;
  RS.clearSnapshots = clearSnapshots;
})();
