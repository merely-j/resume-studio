/**
 * 数据模型层
 * ------------------------------------------------------------
 * 一份简历就是一个普通 JS 对象，方便存到 localStorage、导出 JSON，
 * 以后换成后端接口也只需要序列化/反序列化。
 *
 * 设计要点：
 * 1. 所有"多条"的模块（经历、项目、教育、证书）统一用 { id, ...字段 } 数组，
 *    这样增删、排序、做动画都只需要操作数组。
 * 2. id 用随机串，不依赖数组下标 —— 否则删掉第 2 条后，输入框会串行。
 * 3. 时间用自由文本而不是日期控件，因为中文简历里"2021.07"、"至今"
 *    这种写法太常见，日期控件反而不好用。
 *
 * 为什么不用 ES Module：模块脚本在 file:// 和"沙箱 iframe"里会被浏览器
 * 以同源策略拒绝加载（页面直接空白）。改成普通脚本 + 全局命名空间 RS，
 * 这类受限环境也能跑。
 */

(function () {
  'use strict';

  const RS = (window.RS = window.RS || {});

  /** 生成短 id，够用且不重复 */
  function uid() {
    return 'i' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);
  }

  const TEMPLATES = [
    { id: 'classic', name: '经典单栏' },
    { id: 'modern', name: '现代双栏' },
    { id: 'minimal', name: '极简黑白' },
  ];

  /** 简历里可排序的大模块（个人简介、工作经历……）；技能和证书已合并为一个模块 */
  const RESUME_SECTIONS = ['summary', 'experience', 'projects', 'education', 'skills'];

  const SECTION_LABELS = {
    summary: '个人简介',
    experience: '工作经历',
    projects: '项目经历',
    education: '教育经历',
    skills: '技能与证书',
  };

  /**
   * 模块标题：用户改过就用改过的，没改就用默认名。
   * （基本信息固定在最上面，不算可改名模块。）
   */
  function sectionTitle(resume, id) {
    const custom = ((resume && resume.sectionTitles) || {})[id];
    return (custom && String(custom).trim()) || SECTION_LABELS[id] || id;
  }

  /** 自定义模块里每个字段的默认显示名（用户可以整套改掉） */
  const CUSTOM_LABELS = {
    name: '名称',
    role: '角色',
    start: '开始时间',
    end: '结束时间',
    desc: '内容',
  };

  /** 新建一个自定义模块 */
  function emptyCustomSection(title) {
    return {
      id: 'c_' + uid(),
      title: title || '自定义模块',
      labels: Object.assign({}, CUSTOM_LABELS),
      items: [],
    };
  }

  /** 自定义模块里的一条记录 */
  function emptyCustomItem() {
    return { id: uid(), name: '', role: '', start: '', end: '', desc: '' };
  }

  /**
   * 当前简历里所有可排序的模块 id：
   * 固定模块 + 用户自建的模块。
   */
  function allSectionIds(resume) {
    const customs = ((resume && resume.customSections) || []).map((s) => s.id);
    return RESUME_SECTIONS.concat(customs);
  }

  /**
   * 把顺序数组补全成"每一项都有"：
   * 旧简历没有这个字段、或者以后新增了模块，都按默认顺序补齐，
   * 同时保持用户已经排好的相对顺序。已删除的自定义模块会被自动剔除。
   */
  function normalizeSectionOrder(resume) {
    const valid = allSectionIds(resume);
    const list = Array.isArray(resume && resume.sectionOrder)
      ? resume.sectionOrder.filter((id) => valid.indexOf(id) !== -1)
      : [];
    valid.forEach((id) => {
      if (list.indexOf(id) === -1) list.push(id);
    });
    return list;
  }

  /** 正文字号：按 pt 数字设置，10.5pt 是基准（所有字号都以它为 1 倍） */
  const FONT_SIZE = { min: 8, max: 14, step: 0.5, base: 10.5 };

  function normalizeFontSize(value, fallbackScale) {
    // 输入框给的是字符串，先转成数字再判断
    let size = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(size) && typeof fallbackScale === 'number' && fallbackScale > 0) {
      size = FONT_SIZE.base * fallbackScale; // 兼容早期"倍率"存法
    }
    if (!isFinite(size)) size = FONT_SIZE.base;
    return Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size * 10) / 10));
  }

  /** 页边距档位（毫米），控制纸张四周留白 */
  const MARGIN_SCALES = [
    { value: 12, label: '窄' },
    { value: 16, label: '标准' },
    { value: 20, label: '宽' },
  ];

  /** 一份空白简历 */
  function emptyResume(title) {
    return {
      id: uid(),
      title: title || '未命名简历',
      updatedAt: Date.now(),
      template: 'classic',
      fontSize: FONT_SIZE.base,
      pageMargin: 16,
      sectionGap: 13, // 模块之间的垂直间距（px）
      fitOnePage: false,
      sectionOrder: RESUME_SECTIONS.slice(),
      sectionTitles: {},
      customSections: [],
      basics: {
        name: '',
        headline: '', // 求职意向 / 一句话头衔
        phone: '',
        email: '',
        city: '',
        link: '', // 个人主页 / 作品集
        summary: '',
        photo: '', // 证件照，存成 data URL（压缩后的 JPEG）
        // 以下都是可选的个人信息：留空就不会出现在简历里
        gender: '',
        birthday: '',
        ethnicity: '',
        hometown: '',
        politics: '',
        // 头部两块的显示顺序，可拖动调整；决定"联系方式"和"个人信息"谁在上面
        blockOrder: ['contact', 'personal'],
      },
      experience: [],
      projects: [],
      education: [],
      skills: [],
      extras: [],
    };
  }

  /** 新建一条经历类空记录 */
  function emptyItem(section) {
    const shapes = {
      experience: { company: '', role: '', start: '', end: '', desc: '' },
      projects: { name: '', role: '', start: '', end: '', desc: '' },
      education: { school: '', degree: '', start: '', end: '', desc: '' },
      extras: { label: '', value: '' },
    };
    return Object.assign({ id: uid() }, shapes[section] || {});
  }

  /** 首次打开时展示的示例简历，让用户一进来就能看到效果 */
  function sampleResume() {
    return {
      id: uid(),
      title: '陈晓 · 产品经理',
      updatedAt: Date.now(),
      template: 'classic',
      fontSize: FONT_SIZE.base,
      pageMargin: 16,
      sectionGap: 13,
      fitOnePage: false,
      sectionOrder: RESUME_SECTIONS.slice(),
      sectionTitles: {},
      customSections: [],
      basics: {
        name: '陈晓',
        headline: '高级产品经理 · 3 年 B 端经验',
        phone: '13800000000',
        email: 'chenxiao@example.com',
        city: '杭州',
        link: 'github.com/chenxiao',
        gender: '男',
        birthday: '1995-08',
        ethnicity: '汉族',
        hometown: '浙江杭州',
        politics: '中共党员',
        blockOrder: ['contact', 'personal'],
        summary:
          '3 年企业服务产品经验，<b>主导过 2 个从 0 到 1 的 SaaS 产品</b>，擅长把模糊的业务诉求拆成可交付的版本计划。习惯用数据验证判断，季度复盘驱动的迭代使核心功能留存提升 18%。',
      },
      experience: [
        {
          id: uid(),
          company: '某某科技（杭州）',
          role: '高级产品经理',
          start: '2022.03',
          end: '至今',
          desc:
            '负责协同办公产品线，服务 300+ 家企业客户，MAU 从 4 万增长到 11 万\n主导权限体系重构，把客户实施周期从 3 天缩短到 4 小时\n搭建需求评审与灰度发布流程，版本准时交付率从 62% 提升到 94%',
        },
        {
          id: uid(),
          company: '某某网络',
          role: '产品经理',
          start: '2020.07',
          end: '2022.02',
          desc:
            '从 0 到 1 设计内部工单系统，替代原有表格协作，年节省人力约 1600 小时\n负责数据分析模块的需求与埋点方案，推动 3 个核心指标上线',
        },
      ],
      projects: [
        {
          id: uid(),
          name: '企业权限中心',
          role: '产品负责人',
          start: '2023.04',
          end: '2023.11',
          desc:
            '抽象出「角色-资源-数据范围」三层模型，支持 6 类典型客户场景\n设计迁移工具与回滚方案，零事故完成 120 家客户割接',
        },
      ],
      education: [
        {
          id: uid(),
          school: '浙江大学',
          degree: '信息管理与信息系统 · 本科',
          start: '2016.09',
          end: '2020.06',
          desc: 'GPA 3.7/4.0，校级一等奖学金；产品设计大赛华东赛区二等奖',
        },
      ],
      skills: ['Axure / Figma', 'SQL 数据分析', 'B 端需求建模', '项目管理', '英文 CET-6'],
      extras: [
        { id: uid(), label: '证书', value: 'PMP（2023）、信息系统项目管理师' },
        { id: uid(), label: '语言', value: '英语（读写流利，可英文会议）' },
      ],
    };
  }

  /** 深拷贝，避免"复制简历"时两个对象共享同一份数组 */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /** 把一段文本按行拆成要点数组，顺手去掉用户可能输入的 - / • 前缀 */
  function toBullets(text) {
    return String(text || '')
      .split('\n')
      .map(function (line) {
        return line.trim().replace(/^[-•*·]\s*/, '');
      })
      .filter(Boolean);
  }

  /** 把开始/结束时间拼成 "2020.07 – 2022.02" */
  function formatRange(start, end) {
    const a = String(start || '').trim();
    const b = String(end || '').trim();
    if (a && b) return a + ' – ' + b;
    return a || b || '';
  }

  /**
   * 生日统一成 1995-08 的横杠形式。
   * 用户可能输入 1995.08 / 1995/8 / 1995年8月 / 1995-08-12，
   * 这里都规整成 YYYY-MM（有具体日期时保留 YYYY-MM-DD）。
   * 认不出来的写法原样返回，不硬改用户的内容。
   */
  function formatBirthday(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    const match = raw.match(/^(\d{4})\s*[-./年]?\s*(\d{1,2})?\s*[-./月]?\s*(\d{1,2})?\s*日?$/);
    if (!match) return raw;
    const year = match[1];
    const month = match[2];
    const day = match[3];
    if (!month) return year;
    const mm = month.length === 1 ? '0' + month : month;
    if (!day) return year + '-' + mm;
    const dd = day.length === 1 ? '0' + day : day;
    return year + '-' + mm + '-' + dd;
  }

  /**
   * 手机号统一成纯数字。
   * 用户可能填 138-0000-0000 / 138 0000 0000 / (138)00000000，
   * 展示时都还原成 13800000000；带国际区号的保留开头的 +。
   */
  function formatPhone(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    const plus = raw.charAt(0) === '+';
    const digits = raw.replace(/[^\d]/g, '');
    return plus ? '+' + digits : digits;
  }

  /* ---------------------------- 英文版 ---------------------------- */

  /** 英文版默认的模块标题（用户改名后以改名为准） */
  const EN_SECTION_TITLES = {
    summary: 'Summary',
    experience: 'Experience',
    projects: 'Projects',
    education: 'Education',
    skills: 'Skills & Certificates',
    basics: 'Basics',
  };

  /** 英文版字段名（编辑器里显示） */
  const EN_LABELS = {
    name: 'Name',
    headline: 'Headline',
    city: 'City',
    website: 'Website',
    summary: 'Summary',
    company: 'Company',
    role: 'Title',
    start: 'Start',
    end: 'End',
    desc: 'Description',
    school: 'School',
    major: 'Major',
    degree: 'Degree',
    skills: 'Skills',
    certs: 'Certificates',
    languages: 'Languages',
  };

  const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * 日期转英文写法：2022.03 -> Mar 2022，至今 -> Present。
   * 认不出来的（已经是英文）原样返回。
   */
  function enDate(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    if (/至今|现在|now|present/i.test(raw)) return 'Present';
    const m = /^(\d{4})\s*[.\-/年]\s*(\d{1,2})/.exec(raw);
    if (m) {
      const month = Math.min(12, Math.max(1, parseInt(m[2], 10)));
      return EN_MONTHS[month - 1] + ' ' + m[1];
    }
    const yearOnly = /^(\d{4})$/.exec(raw);
    if (yearOnly) return yearOnly[1];
    return raw;
  }

  /** 空英文镜像：结构与中文一一对应，id 相同 */
  function emptyEnglish() {
    return {
      basics: { name: '', headline: '', city: '', website: '', summary: '' },
      experience: [],
      projects: [],
      education: [],
      skills: [],
      certs: [],
      languages: [],
      sectionTitles: {},
      customSections: [],
    };
  }

  /** 按 id 对齐：中文有、英文没有的补一条空记录；中文删掉的，英文也删 */
  function syncList(zhList, enList, empty) {
    const en = Array.isArray(enList) ? enList : [];
    return (zhList || []).map((item) => {
      const found = en.find((it) => it.id === item.id);
      return found || empty(item.id);
    });
  }

  /**
   * 确保 resume.en 存在且与中文结构对齐。
   * 每次切换语言、增删条目、打开简历时调用一次，代价很小。
   */
  function syncEnglish(resume) {
    if (!resume) return null;
    const zh = resume;
    const en = zh.en && typeof zh.en === 'object' ? zh.en : emptyEnglish();
    zh.en = en;

    en.basics = Object.assign(
      { name: '', headline: '', city: '', website: '', summary: '', gender: '', ethnicity: '', hometown: '', politics: '' },
      en.basics || {}
    );

    en.experience = syncList(zh.experience, en.experience, (id) => ({
      id,
      company: '',
      role: '',
      start: '',
      end: '',
      desc: '',
    }));
    en.projects = syncList(zh.projects, en.projects, (id) => ({
      id,
      name: '',
      role: '',
      start: '',
      end: '',
      desc: '',
    }));
    en.education = syncList(zh.education, en.education, (id) => ({
      id,
      school: '',
      major: '',
      degree: '',
      start: '',
      end: '',
      desc: '',
    }));

    en.customSections = (zh.customSections || []).map((cs) => {
      en.customSections = en.customSections || [];
      const found = en.customSections.find((c) => c.id === cs.id);
      const target = found || { id: cs.id, title: '', labels: {}, items: [] };
      target.items = syncList(cs.items, target.items, (id) => ({
        id,
        name: '',
        role: '',
        start: '',
        end: '',
        desc: '',
      }));
      return target;
    });

    en.sectionTitles = en.sectionTitles || {};
    en.skills = Array.isArray(en.skills) ? en.skills : [];
    en.certs = Array.isArray(en.certs) ? en.certs : [];
    en.languages = Array.isArray(en.languages) ? en.languages : [];
    en.extras = syncList(zh.extras, en.extras, (id) => ({ id, label: '', value: '' }));
    return en;
  }

  /** 英文模块标题（默认给英文名，用户改过以改名为准） */
  function englishSectionTitle(resume, id) {
    const en = (resume && resume.en) || {};
    const custom = (en.sectionTitles || {})[id];
    if (custom && String(custom).trim()) return String(custom).trim();
    if (id.indexOf('custom:') === 0) {
      const cs = (en.customSections || []).find((s) => 'custom:' + s.id === id);
      return (cs && cs.title) || 'Section';
    }
    return EN_SECTION_TITLES[id] || id;
  }

  /**
   * 生成"英文版简历"对象：结构、id、排版设置都沿用中文，
   * 文案全部取自 en，缺失的就是空（宁可空着也不显示中文）。
   */
  function localizedResume(resume, lang) {
    if (lang !== 'en') return resume;
    const zh = resume;
    const en = syncEnglish(zh) || emptyEnglish();
    const b = zh.basics || {};
    const eb = en.basics || {};

    const sectionTitles = {};
    allSectionIds(zh).forEach((id) => {
      sectionTitles[id] = englishSectionTitle(zh, id);
    });

    /**
     * 版式必须和中文稿完全一致：英文没填的字段一律回退到中文原文，
     * 这样模块不会因为"还没翻译"而整段消失。翻译过的字段用英文。
     */
    const pick = (enValue, zhValue) => {
      const enText = String(enValue == null ? '' : enValue).trim();
      return enText || zhValue || '';
    };

    const customSections = (zh.customSections || []).map((cs) => {
      const ec = (en.customSections || []).find((c) => c.id === cs.id) || { items: [] };
      return {
        id: cs.id,
        title: (ec.title && String(ec.title).trim()) || cs.title,
        labels: Object.assign({}, EN_CUSTOM_LABELS, ec.labels || {}),
        items: (cs.items || []).map((item) => {
          const ei = (ec.items || []).find((it) => it.id === item.id) || {};
          return {
            id: item.id,
            name: pick(ei.name, item.name),
            role: pick(ei.role, item.role),
            start: pick(ei.start, enDate(item.start) || item.start),
            end: pick(ei.end, enDate(item.end) || item.end),
            desc: pick(ei.desc, item.desc),
          };
        }),
      };
    });

    const enExtras = (en.extras || []).filter((item) => item.label || item.value);
    const zhExtras = (zh.extras || []).filter((item) => item.label || item.value);

    return Object.assign({}, zh, {
      lang: 'en',
      basics: Object.assign({}, b, {
        name: pick(eb.name, b.name),
        headline: pick(eb.headline, b.headline),
        city: pick(eb.city, b.city),
        website: pick(eb.website, b.website),
        summary: pick(eb.summary, b.summary),
        // 个人信息行也要保留：英文没翻就用中文，行数和中文稿一致
        gender: pick(eb.gender, b.gender),
        ethnicity: pick(eb.ethnicity, b.ethnicity),
        birthday: b.birthday,
        hometown: pick(eb.hometown, b.hometown),
        politics: pick(eb.politics, b.politics),
        // 联系方式沿用中文里填的
        phone: b.phone,
        email: b.email,
      }),
      experience: (zh.experience || []).map((item) => {
        const ei = (en.experience || []).find((it) => it.id === item.id) || {};
        return {
          id: item.id,
          company: pick(ei.company, item.company),
          role: pick(ei.role, item.role),
          start: pick(ei.start, enDate(item.start) || item.start),
          end: pick(ei.end, enDate(item.end) || item.end),
          desc: pick(ei.desc, item.desc),
        };
      }),
      projects: (zh.projects || []).map((item) => {
        const ei = (en.projects || []).find((it) => it.id === item.id) || {};
        return {
          id: item.id,
          name: pick(ei.name, item.name),
          role: pick(ei.role, item.role),
          start: pick(ei.start, enDate(item.start) || item.start),
          end: pick(ei.end, enDate(item.end) || item.end),
          desc: pick(ei.desc, item.desc),
        };
      }),
      education: (zh.education || []).map((item) => {
        const ei = (en.education || []).find((it) => it.id === item.id) || {};
        return {
          id: item.id,
          school: pick(ei.school, item.school),
          major: pick(ei.major, item.major),
          degree: pick(ei.degree, item.degree),
          start: pick(ei.start, enDate(item.start) || item.start),
          end: pick(ei.end, enDate(item.end) || item.end),
          desc: pick(ei.desc, item.desc),
        };
      }),
      // 技能 / 证书：英文填了就替换，没填保留中文，模块不会消失
      skills: (en.skills || []).length ? en.skills : zh.skills || [],
      certs: (en.certs || []).length ? en.certs : zh.certs || [],
      languages: (en.languages || []).length ? en.languages : zh.languages || [],
      extras: enExtras.length ? enExtras : zhExtras,
      sectionTitles: sectionTitles,
      customSections: customSections,
    });
  }

  /** 自定义模块在英文版里的默认字段名 */
  const EN_CUSTOM_LABELS = {
    name: 'Name',
    role: 'Role',
    start: 'Start',
    end: 'End',
    desc: 'Description',
  };

  /** 统计英文版还有多少字段没填（用于"还有 N 处待翻译"） */
  function countMissingEnglish(resume) {
    const en = syncEnglish(resume);
    let missing = 0;
    const check = (value) => {
      if (!String(value == null ? '' : value).trim()) missing += 1;
    };
    const eb = en.basics || {};
    ['name', 'headline', 'summary'].forEach((k) => check(eb[k]));
    (en.experience || []).forEach((it) => {
      check(it.company);
      check(it.role);
      check(it.desc);
    });
    (en.projects || []).forEach((it) => {
      check(it.name);
      check(it.desc);
    });
    (en.education || []).forEach((it) => {
      check(it.school);
      check(it.major);
    });
    if (!(en.skills || []).length) missing += 1;
    (en.customSections || []).forEach((cs) => {
      if (!String(cs.title || '').trim()) missing += 1;
      (cs.items || []).forEach((it) => check(it.name));
    });
    return missing;
  }

  RS.uid = uid;
  RS.TEMPLATES = TEMPLATES;
  RS.RESUME_SECTIONS = RESUME_SECTIONS;
  RS.SECTION_LABELS = SECTION_LABELS;
  RS.sectionTitle = sectionTitle;
  RS.CUSTOM_LABELS = CUSTOM_LABELS;
  RS.emptyCustomSection = emptyCustomSection;
  RS.emptyCustomItem = emptyCustomItem;
  RS.allSectionIds = allSectionIds;
  RS.FONT_SIZE = FONT_SIZE;
  RS.normalizeFontSize = normalizeFontSize;
  RS.MARGIN_SCALES = MARGIN_SCALES;
  RS.formatPhone = formatPhone;
  RS.normalizeSectionOrder = normalizeSectionOrder;
  RS.emptyResume = emptyResume;
  RS.emptyItem = emptyItem;
  RS.sampleResume = sampleResume;
  RS.clone = clone;
  RS.toBullets = toBullets;
  RS.formatRange = formatRange;
  RS.formatBirthday = formatBirthday;
  RS.englishSectionTitle = englishSectionTitle;
  RS.syncEnglish = syncEnglish;
  RS.localizedResume = localizedResume;
  RS.emptyEnglish = emptyEnglish;
  RS.countMissingEnglish = countMissingEnglish;
  RS.EN_SECTION_TITLES = EN_SECTION_TITLES;
  RS.EN_LABELS = EN_LABELS;
  RS.enDate = enDate;
})();
