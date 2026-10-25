/**
 * 编辑器层：把简历数据渲染成表单，并把用户操作翻译成回调
 * ------------------------------------------------------------
 * 关键取舍：表单只在"结构变化"时整体重绘（切换简历、增删条目、上下移动）。
 * 打字时只更新数据 + 重绘右侧预览，绝不重建 <input>，
 * 否则每敲一个字输入框就会失焦 —— 这是手写表单最常见的坑。
 *
 * 事件全部用委托（监听容器、按 data-* 分发），所以重绘后不需要重新绑定。
 */

(function () {
  'use strict';

  const RS = (window.RS = window.RS || {});
  const { normalizeSectionOrder, SECTION_LABELS, CUSTOM_LABELS, sectionTitle } = RS;

  /** 自定义模块里五个字段的"用途"说明，用于给改名字的输入框做标签 */
  const CUSTOM_FIELD_NAMES = {
    name: '名称字段',
    role: '角色字段',
    start: '开始时间字段',
    end: '结束时间字段',
    desc: '内容字段',
  };

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESC[ch]);

  /* ---------------------------- 基础控件 ---------------------------- */

  /**
   * 单行输入
   * bind  : 绑定到简历上的某个路径，如 "basics.name"、"title"
   * section/id/name : 绑定到数组里的某一条，如 experience + id + "company"
   */
  function field(opts) {
    const o = opts;
    const dataAttrs = o.metaOnly
      ? `data-custom-meta="${o.customId}" data-meta-key="${o.metaKey}"`
      : o.bind
      ? `data-bind="${o.bind}"`
      : `data-section="${o.section}" data-id="${o.id}" data-field="${o.name}"`;
    const scope = o.scope ? ` data-scope="${o.scope}"` : '';
    return `
    <label class="field"${o.span === 2 ? ' data-span="2"' : ''}>
      <span class="field-label">${esc(o.label)}${o.hint || ''}</span>
      <input class="input" type="${o.type || 'text'}" value="${esc(o.value)}"
             placeholder="${esc(o.placeholder || '')}"${scope} ${dataAttrs} />
    </label>`;
  }

  /** 英文模式下字段旁的小字中文原文（超长由 CSS 省略） */
  function srcHint(text) {
    const plain = String(text == null ? '' : text)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plain) return '';
    return `<span class="src-hint" title="${esc(plain)}">← ${esc(plain)}</span>`;
  }

  /**
   * 富文本框：contenteditable + 三个格式按钮（加粗 / 斜体 / 下划线）。
   * 为什么不用现成的编辑器库：这里只需要行内格式，
   * 引一个 100KB+ 的编辑器不值当，而且会让"纯函数渲染"那层变复杂。
   *
   * 存进数据的是净化后的 HTML（只保留白名单标签），
   * 所以导出 JSON、导入旧数据都不会带进乱七八糟的标签。
   */
  function richField(opts) {
    const o = opts;
    const dataAttrs = o.bind
      ? `data-bind="${o.bind}"`
      : `data-section="${o.section}" data-id="${o.id}" data-field="${o.name}"`;
    const scope = o.scope ? ` data-scope="${o.scope}"` : '';
    return `
    <div class="field" data-span="2">
      <span class="field-label">${esc(o.label)}${o.hint || ''}</span>
      <div class="rich" data-rich-wrap>
        <div class="rich-toolbar">
          <button type="button" class="rich-btn" data-cmd="bold" title="加粗" aria-label="加粗"><b>B</b></button>
          <button type="button" class="rich-btn" data-cmd="italic" title="斜体" aria-label="斜体"><i>I</i></button>
          <button type="button" class="rich-btn" data-cmd="underline" title="下划线" aria-label="下划线"><u>U</u></button>
        </div>
        <div class="rich-input" contenteditable="true" role="textbox" aria-multiline="true"
             data-rich ${dataAttrs}${scope}
             data-placeholder="${esc(o.placeholder || '')}">${toEditable(o.value)}</div>
      </div>
    </div>`;
  }

  /** 把存下来的内容转成可直接编辑的 HTML（换行 -> <br>，标签过白名单） */
  function toEditable(value) {
    const richText = (window.RS && window.RS.richText) || ((v) => String(v == null ? '' : v));
    return richText(value);
  }

  /** 折叠卡片外壳：用原生 <details>，零 JS 就能折叠，键盘和读屏也友好 */
  function card(opts) {
    const o = opts;
    const edit = o.edit
      ? `<button class="icon-btn card-edit" type="button" data-action="edit-title"
           data-section-id="${esc(o.edit.id)}" data-edit-lang="${o.edit.lang || 'zh'}"${
          o.edit.custom ? ' data-edit-custom="1"' : ''
        } title="修改模块名称" aria-label="修改模块名称">✏️</button>`
      : '';
    return `
    <details class="card" data-card="${o.key}" open>
      <summary class="card-head">
        <span class="card-title">${esc(o.title)}</span>
        ${edit}
        ${o.count === undefined ? '' : `<span class="card-count">${o.count}</span>`}
        ${o.hint ? `<span class="card-hint">${esc(o.hint)}</span>` : ''}
        <span class="card-chevron" aria-hidden="true"></span>
      </summary>
      <div class="card-body">${o.body}</div>
    </details>`;
  }

  /* ---------------------------- 各模块 ---------------------------- */

  /** 列表型模块的配置：加字段只改这里，渲染和绑定都不用动 */
  const ITEM_SECTIONS = [
    {
      key: 'experience',
      title: '工作经历',
      addLabel: '添加一段工作经历',
      labelOf: (item) => item.company || item.role,
      fields: [
        { name: 'company', label: '公司', placeholder: '某某科技（杭州）' },
        { name: 'role', label: '职位', placeholder: '高级产品经理' },
        { name: 'start', label: '开始时间', placeholder: '2022.03' },
        { name: 'end', label: '结束时间', placeholder: '至今' },
        {
          name: 'desc',
          label: '工作内容（每行一条，自动变项目符号）',
          type: 'textarea',
          span: 2,
          rows: 4,
          placeholder: '负责……，服务 300+ 家企业客户\n主导……，把实施周期从 3 天缩短到 4 小时',
        },
      ],
    },
    {
      key: 'projects',
      title: '项目经历',
      addLabel: '添加一个项目',
      labelOf: (item) => item.name,
      fields: [
        { name: 'name', label: '项目名称', placeholder: '企业权限中心' },
        { name: 'role', label: '担任角色', placeholder: '产品负责人' },
        { name: 'start', label: '开始时间', placeholder: '2023.04' },
        { name: 'end', label: '结束时间', placeholder: '2023.11' },
        {
          name: 'desc',
          label: '项目内容（每行一条）',
          type: 'textarea',
          span: 2,
          rows: 3,
          placeholder: '背景 / 你的动作 / 可量化结果',
        },
      ],
    },
    {
      key: 'education',
      title: '教育经历',
      addLabel: '添加一段教育经历',
      labelOf: (item) => item.school,
      fields: [
        { name: 'school', label: '学校', placeholder: '浙江大学' },
        { name: 'degree', label: '学历 / 专业', placeholder: '信息管理与信息系统 · 本科' },
        { name: 'start', label: '开始时间', placeholder: '2016.09' },
        { name: 'end', label: '结束时间', placeholder: '2020.06' },
        {
          name: 'desc',
          label: '补充（奖项、GPA、课程等，可留空）',
          type: 'textarea',
          span: 2,
          rows: 2,
        },
      ],
    },
  ];

  function titleCard(resume) {
    const updated = new Date(resume.updatedAt || Date.now()).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `
    <div class="doc-head">
      ${field({
        label: '简历名称（仅自己可见）',
        bind: 'title',
        value: resume.title,
        placeholder: '例如：陈晓 · 产品经理',
      })}
      <p class="doc-meta" id="saveStatus">最近修改 ${esc(updated)} · 修改会自动保存在本机</p>
    </div>`;
  }

  function basicsCard(resume) {
    const b = resume.basics || {};
    // 照片单独一行：左边是缩略图，右边是按钮
    const photoRow = `
    <div class="photo-row">
      <div class="photo-wrap">
        <div class="photo-thumb">${
          b.photo ? `<img src="${esc(b.photo)}" alt="照片预览" />` : '无照片'
        }</div>
        ${
          b.photo
            ? '<button class="photo-del" type="button" data-action="remove-photo" title="删除照片" aria-label="删除照片">✕</button>'
            : ''
        }
      </div>
      <div class="photo-actions">
        <button class="btn btn-sm" type="button" data-action="pick-photo">${
          b.photo ? '更换照片' : '上传照片'
        }</button>
        ${
          b.photo
            ? '<button class="btn btn-sm btn-ghost" type="button" data-action="remove-photo">移除</button>'
            : ''
        }
        <p class="card-tip">正面证件照，竖版 4:5，显示在简历右上角（会自动压缩到 480px）</p>
      </div>
      <input type="file" accept="image/*" data-photo-input hidden />
    </div>`;
    // 姓名固定在顶部（简历里它是放大居中的标题），下面两块可以调顺序
    const nameRow = `<div class="grid">
      ${field({ label: '姓名', bind: 'basics.name', value: b.name, placeholder: '陈晓' })}
    </div>`;

    const groups = {
      personal: {
        title: '身份信息',
        body: `<div class="grid">
      ${field({ label: '性别', bind: 'basics.gender', value: b.gender, placeholder: '男 / 女' })}
      ${field({ label: '生日', bind: 'basics.birthday', value: b.birthday, placeholder: '1995-08' })}
      ${field({ label: '民族', bind: 'basics.ethnicity', value: b.ethnicity, placeholder: '汉族' })}
      ${field({ label: '籍贯', bind: 'basics.hometown', value: b.hometown, placeholder: '浙江杭州' })}
      ${field({
        label: '政治面貌',
        bind: 'basics.politics',
        value: b.politics,
        placeholder: '中共党员 / 群众',
      })}
      </div>`,
      },
      contact: {
        title: '联系方式',
        body: `<div class="grid">
      ${field({
        label: '手机',
        type: 'tel',
        bind: 'basics.phone',
        value: b.phone,
        placeholder: '13800000000',
      })}
      ${field({
        label: '邮箱',
        type: 'email',
        bind: 'basics.email',
        value: b.email,
        placeholder: 'you@example.com',
      })}
      ${field({ label: '城市', bind: 'basics.city', value: b.city, placeholder: '杭州' })}
      ${field({
        label: '主页 / 作品集',
        bind: 'basics.link',
        value: b.link,
        placeholder: 'github.com/yourname',
      })}
      </div>`,
      },
    };

    const order =
      Array.isArray(b.blockOrder) && b.blockOrder.length === 2
        ? b.blockOrder
        : ['contact', 'personal'];

    const orderedGroups = order
      .map(
        (id) => `
      <div class="group" data-group="${id}">
        <div class="group-head">
          <span class="form-sub">${groups[id].title}</span>
          <span class="group-order">
            <button class="icon-btn" type="button" data-action="move-group" data-group="${id}" data-dir="-1"
                    title="上移" aria-label="上移">↑</button>
            <button class="icon-btn" type="button" data-action="move-group" data-group="${id}" data-dir="1"
                    title="下移" aria-label="下移">↓</button>
          </span>
        </div>
        ${groups[id].body}
      </div>`
      )
      .join('');

    const body =
      photoRow +
      nameRow +
      orderedGroups +
      `<p class="form-sub">求职意向</p>
      <div class="grid">
      ${field({
        label: '求职意向 / 头衔',
        bind: 'basics.headline',
        value: b.headline,
        placeholder: '高级产品经理 · 3 年 B 端经验',
        span: 2,
      })}
      </div>
      <p class="card-tip">以上全部为可选项。留空的字段不会出现在简历里；身份信息与联系方式可用 ↑↓ 调换上下顺序。</p>`;
    return card({ key: 'basics', title: '基本信息', hint: '姓名 · 联系方式', body: body });
  }

  /** 个人简介单独成卡：这样它能跟着"模块顺序"一起移动 */
  function summaryCard(resume, lang) {
    const en = lang === 'en';
    const zh = resume.basics || {};
    if (en) {
      const e = RS.syncEnglish(resume) || {};
      const eb = e.basics || {};
      return card({
        key: 'summary',
        title: '个人简介',
        hint: 'Summary',
        edit: { id: 'summary', lang: 'en' },
        body: richField({
          label: 'Summary',
          bind: 'en.basics.summary',
          value: eb.summary,
          placeholder: 'One short paragraph: who you are, what you are good at, what you shipped.',
          hint: srcHint(zh.summary),
        }),
      });
    }
    return card({
      key: 'summary',
      title: '个人简介',
      edit: { id: 'summary' },
      body: richField({
        label: '个人简介',
        bind: 'basics.summary',
        value: zh.summary,
        placeholder: '三句话：你是谁、擅长什么、做出过什么结果（可加粗/斜体）',
      }),
    });
  }

  /**
   * 模块顺序列表（现在是顶部「顺序」按钮弹出的面板，不再占左侧表单的位置）。
   * 返回纯 HTML 字符串，由 app.js 塞进弹窗里。
   */
  function renderOrderList(resume) {
    const customTitles = {};
    (resume.customSections || []).forEach((section) => {
      customTitles[section.id] = section.title;
    });
    const order = normalizeSectionOrder(resume);
    return order
      .map(
        (id, index) => `
      <div class="order-row" data-order-id="${id}">
        <span class="order-index">${index + 1}</span>
        <span class="order-name">${esc(
          SECTION_LABELS[id] ? sectionTitle(resume, id) : customTitles[id] || id
        )}</span>
        <span class="order-tools">
          <button class="icon-btn" type="button" data-action="move-section" data-section-id="${id}" data-dir="-1"
                  title="上移" aria-label="上移">↑</button>
          <button class="icon-btn" type="button" data-action="move-section" data-section-id="${id}" data-dir="1"
                  title="下移" aria-label="下移">↓</button>
        </span>
      </div>`
      )
      .join('');
  }

  function listCard(resume, meta) {
    const items = resume[meta.key] || [];
    const list = items
      .map((item) => {
        const body = meta.fields
          .map((f) =>
            f.type === 'textarea'
              ? richField({
                  label: f.label,
                  value: item[f.name] || '',
                  section: meta.key,
                  id: item.id,
                  name: f.name,
                  placeholder: f.placeholder || '',
                })
              : field({
                  label: f.label,
                  value: item[f.name] || '',
                  section: meta.key,
                  id: item.id,
                  name: f.name,
                  placeholder: f.placeholder || '',
                  span: f.span || 1,
                })
          )
          .join('');
        const label = meta.labelOf(item) || '新条目';
        return `
        <div class="item" data-item="${item.id}">
          <div class="item-bar">
            <span class="item-title">${esc(label)}</span>
            <span class="item-tools">
              <button class="icon-btn" data-action="move-item" data-section="${meta.key}" data-id="${
          item.id
        }" data-dir="-1" title="上移" aria-label="上移">↑</button>
              <button class="icon-btn" data-action="move-item" data-section="${meta.key}" data-id="${
          item.id
        }" data-dir="1" title="下移" aria-label="下移">↓</button>
              <button class="icon-btn icon-btn--danger" data-action="remove-item" data-section="${
                meta.key
              }" data-id="${item.id}" title="删除" aria-label="删除">✕</button>
            </span>
          </div>
          <div class="grid">${body}</div>
        </div>`;
      })
      .join('');

    const body = `
    <div class="items">${list || '<p class="empty-hint">还没有内容，点下面的按钮添加。</p>'}</div>
    <button class="btn btn-ghost btn-block" data-action="add-item" data-section="${meta.key}">
      ＋ ${esc(meta.addLabel)}
    </button>`;
    return card({
      key: meta.key,
      title: meta.title,
      edit: { id: meta.key },
      count: items.length || undefined,
      body: body,
    });
  }

  /** "类别 + 内容"两列条目：技能和证书共用同一套渲染 */
  function valueRows(opts) {
    const o = opts;
    const en = o.scope === 'en';
    const items = o.items || [];
    const scopeAttr = en ? ' data-scope="en"' : '';
    if (!items.length) {
      return `<p class="empty-hint">${o.emptyText || '还没有内容，点下面的按钮添加。'}</p>`;
    }
    return items
      .map((item) => {
        const body = [
          field({
            label: o.labelText || (en ? 'Label' : '类别'),
            value: item.label,
            section: o.section,
            id: item.id,
            name: 'label',
            placeholder: o.labelPlaceholder || '',
            scope: o.scope,
          }),
          field({
            label: o.valueText || (en ? 'Content' : '内容'),
            value: item.value,
            section: o.section,
            id: item.id,
            name: 'value',
            placeholder: o.valuePlaceholder || '',
            scope: o.scope,
          }),
        ].join('');
        return `
        <div class="item" data-item="${item.id}">
          <div class="item-bar">
            <span class="item-title">${esc(item.label || item.value || '新条目')}</span>
            <span class="item-tools">
              <button class="icon-btn" data-action="move-item" data-section="${o.section}" data-id="${item.id}" data-dir="-1"${scopeAttr}
                      title="上移" aria-label="上移">↑</button>
              <button class="icon-btn" data-action="move-item" data-section="${o.section}" data-id="${item.id}" data-dir="1"${scopeAttr}
                      title="下移" aria-label="下移">↓</button>
              <button class="icon-btn icon-btn--danger" data-action="remove-item" data-section="${o.section}" data-id="${item.id}"${scopeAttr}
                      title="删除" aria-label="删除">✕</button>
            </span>
          </div>
          <div class="grid">${body}</div>
        </div>`;
      })
      .join('');
  }

  /** 证书条目（原来的独立模块，现在并入"技能与证书"） */
  function extrasItems(resume, scope) {
    const en = scope === 'en';
    const source = en ? (RS.syncEnglish(resume) || {}).extras : resume.extras;
    return valueRows({
      items: source || [],
      section: 'extras',
      scope: scope,
      emptyText: `还没有${en ? '证书 / 语言' : '证书'}，点下面的按钮添加。`,
      labelText: en ? 'Label' : '类别',
      valueText: en ? 'Content' : '内容',
      labelPlaceholder: en ? 'Certificate / Language' : '证书 / 语言',
      valuePlaceholder: en ? 'PMP (2023), CET-6' : 'PMP（2023）、CET-6',
    });
  }

  /** 技能与证书：技能和证书一样，都是"类别 + 内容"，全部自己填 */
  function skillsCard(resume) {
    const skills = resume.skills || [];
    const extras = resume.extras || [];
    const body = `
    <p class="form-sub">技能</p>
    <div class="items">${valueRows({
      items: skills,
      section: 'skills',
      emptyText: '还没有技能，点下面的按钮添加。比如「编程语言 / Python、Java」。',
      labelText: '类别',
      valueText: '内容',
      labelPlaceholder: '编程语言 / 语言能力 / 设计工具',
      valuePlaceholder: 'Python、Java / 英语 CET-6',
    })}</div>
    <button class="btn btn-ghost btn-block" data-action="add-item" data-section="skills">＋ 添加技能</button>

    <p class="form-sub">证书 / 其他</p>
    <div class="items">${extrasItems(resume)}</div>
    <button class="btn btn-ghost btn-block" data-action="add-item" data-section="extras">＋ 添加证书</button>`;
    return card({
      key: 'skills',
      title: '技能与证书',
      edit: { id: 'skills' },
      count: skills.length + extras.length || undefined,
      body: body,
    });
  }

  /** 自定义模块：标题、字段名、条目全部可改 */
  function customCard(resume, custom) {
    const labels = custom.labels || {};
    const items = custom.items || [];

    const labelFields = ['name', 'role', 'start', 'end', 'desc']
      .map(
        (key) => `
        <label class="field">
          <span class="field-label">${esc(CUSTOM_FIELD_NAMES[key])}</span>
          <input class="input" data-custom-meta="${custom.id}" data-meta-key="label:${key}"
                 value="${esc(labels[key] || '')}" placeholder="${esc(CUSTOM_LABELS[key] || key)}" />
        </label>`
      )
      .join('');

    const list = items
      .map((item) => {
        const body = [
          field({
            label: labels.name,
            value: item.name,
            section: 'custom:' + custom.id,
            id: item.id,
            name: 'name',
          }),
          field({
            label: labels.role,
            value: item.role,
            section: 'custom:' + custom.id,
            id: item.id,
            name: 'role',
          }),
          field({
            label: labels.start,
            value: item.start,
            section: 'custom:' + custom.id,
            id: item.id,
            name: 'start',
          }),
          field({
            label: labels.end,
            value: item.end,
            section: 'custom:' + custom.id,
            id: item.id,
            name: 'end',
          }),
          richField({
            label: labels.desc,
            value: item.desc,
            section: 'custom:' + custom.id,
            id: item.id,
            name: 'desc',
          }),
        ].join('');
        return `
        <div class="item" data-item="${item.id}">
          <div class="item-bar">
            <span class="item-title">${esc(item.name || '新条目')}</span>
            <span class="item-tools">
              <button class="icon-btn" data-action="move-item" data-section="custom:${custom.id}" data-id="${item.id}"
                      data-dir="-1" title="上移" aria-label="上移">↑</button>
              <button class="icon-btn" data-action="move-item" data-section="custom:${custom.id}" data-id="${item.id}"
                      data-dir="1" title="下移" aria-label="下移">↓</button>
              <button class="icon-btn icon-btn--danger" data-action="remove-item" data-section="custom:${custom.id}"
                      data-id="${item.id}" title="删除" aria-label="删除">✕</button>
            </span>
          </div>
          <div class="grid">${body}</div>
        </div>`;
      })
      .join('');

    const body = `
    <p class="form-sub">字段名称（都可以改）</p>
    <div class="grid">${labelFields}</div>

    <p class="form-sub">内容</p>
    <div class="items">${list || '<p class="empty-hint">还没有内容，点下面的按钮添加。</p>'}</div>
    <button class="btn btn-ghost btn-block" data-action="add-item" data-section="custom:${custom.id}">＋ 添加一条</button>
    <button class="btn btn-ghost btn-block" data-action="remove-custom" data-custom="${custom.id}">删除这个模块</button>`;

    return card({
      key: 'custom_' + custom.id,
      title: custom.title || '自定义模块',
      edit: { id: custom.id, custom: true },
      count: items.length || undefined,
      body: body,
    });
  }

  /** 渲染整个编辑器 */
  /* ---------------------------- 英文版编辑器 ---------------------------- */

  /** 英文版：基本信息（联系方式与中文共用） */
  function enBasicsCard(resume) {
    const en = RS.syncEnglish(resume) || {};
    const b = en.basics || {};
    const zh = resume.basics || {};
    const contact = [zh.phone, zh.email, zh.city].filter(Boolean).join(' · ');
    const body = `
    <div class="grid">
      ${field({
        label: 'Name',
        value: b.name,
        bind: 'en.basics.name',
        placeholder: 'Xiao Chen',
        hint: srcHint(zh.name),
      })}
      ${field({
        label: 'Headline',
        value: b.headline,
        bind: 'en.basics.headline',
        placeholder: 'Senior Product Manager · 3 years in B2B SaaS',
        hint: srcHint(zh.headline),
      })}
      ${field({
        label: 'City',
        value: b.city,
        bind: 'en.basics.city',
        placeholder: 'Hangzhou, China',
        hint: srcHint(zh.city),
      })}
      ${field({
        label: 'Website',
        value: b.website,
        bind: 'en.basics.website',
        placeholder: 'github.com/yourname',
        hint: srcHint(zh.website),
      })}
    </div>
    <p class="form-sub">个人信息（可选，留空则英文简历里不显示这一行）</p>
    <div class="grid">
      ${field({
        label: 'Gender',
        value: b.gender,
        bind: 'en.basics.gender',
        placeholder: 'Male',
        hint: srcHint(zh.gender),
      })}
      ${field({
        label: 'Ethnicity',
        value: b.ethnicity,
        bind: 'en.basics.ethnicity',
        placeholder: 'Han Chinese',
        hint: srcHint(zh.ethnicity),
      })}
      ${field({
        label: 'Date of birth',
        value: b.birthday,
        bind: 'en.basics.birthday',
        placeholder: '1995-08',
        hint: srcHint(zh.birthday),
      })}
      ${field({
        label: 'Hometown',
        value: b.hometown,
        bind: 'en.basics.hometown',
        placeholder: 'Hangzhou, Zhejiang',
        hint: srcHint(zh.hometown),
      })}
      ${field({
        label: 'Political status',
        value: b.politics,
        bind: 'en.basics.politics',
        placeholder: 'CPC member',
        hint: srcHint(zh.politics),
      })}
    </div>
    <p class="form-sub">联系方式（与中文版共用）</p>
    <p class="en-shared">${esc(contact || '尚未填写手机号 / 邮箱')}</p>`;
    return card({ key: 'basics', title: '基本信息', hint: 'English', body });
  }

  /** 英文版：列表型模块（经历 / 项目 / 教育） */
  function enListCard(resume, meta) {
    const en = RS.syncEnglish(resume) || {};
    const zhItems = resume[meta.key] || [];
    const enItems = en[meta.key] || [];

    const items = zhItems
      .map((zhItem) => {
        const item = enItems.find((it) => it.id === zhItem.id) || { id: zhItem.id };
        const body = meta.fields
          .map((f) => {
            const opts = {
              label: RS.EN_LABELS[f.name] || f.label,
              value: item[f.name] || '',
              hint: srcHint(zhItem[f.name]),
              section: meta.key,
              id: item.id,
              name: f.name,
              scope: 'en',
              span: f.span || 1,
            };
            if (f.type === 'textarea') {
              return richField(Object.assign(opts, { placeholder: '每行一条，自动变项目符号' }));
            }
            return field(opts);
          })
          .join('');
        const label = meta.labelOf(item) || meta.labelOf(zhItem) || '新条目';
        return `
        <div class="item" data-item="${item.id}">
          <div class="item-bar">
            <span class="item-title">${esc(label)}</span>
            <span class="item-tools">
              <button class="icon-btn" data-action="translate-item" data-section="${meta.key}"
                      data-id="${item.id}" title="翻译这一条" aria-label="翻译这一条">译</button>
            </span>
          </div>
          <div class="grid">${body}</div>
        </div>`;
      })
      .join('');

    return card({
      key: meta.key,
      title: meta.title,
      hint: 'English',
      edit: { id: meta.key, lang: 'en' },
      count: zhItems.length || undefined,
      body: items || '<p class="empty-hint">中文版这一块还没有内容，先到中文版添加。</p>',
    });
  }

  /** 英文版：技能与证书（和中文版完全一样的交互） */
  function enSkillsCard(resume) {
    const en = RS.syncEnglish(resume) || {};
    const skills = en.skills || [];
    const extras = en.extras || [];
    const zhSkills = (resume.skills || [])
      .map((item) => [item.label, item.value].filter(Boolean).join('：'))
      .join(' / ');
    const body = `
    <p class="form-sub">Skills ${srcHint(zhSkills)}</p>
    <div class="items">${valueRows({
      items: skills,
      section: 'skills',
      scope: 'en',
      emptyText: 'No skills yet — click the button below to add one.',
      labelText: 'Category',
      valueText: 'Content',
      labelPlaceholder: 'Languages / Tools',
      valuePlaceholder: 'Python, Java / English CET-6',
    })}</div>
    <button class="btn btn-ghost btn-block" data-action="add-item" data-section="skills" data-scope="en">＋ Add skill</button>

    <p class="form-sub">Certificates</p>
    <div class="items">${extrasItems(resume, 'en')}</div>
    <button class="btn btn-ghost btn-block" data-action="add-item" data-section="extras" data-scope="en">＋ Add certificate</button>`;
    return card({
      key: 'skills',
      title: '技能与证书',
      edit: { id: 'skills', lang: 'en' },
      count: skills.length + extras.length || undefined,
      body: body,
    });
  }

  /** 英文版：自定义模块（标题沿用中文，条目可编辑） */
  function enCustomCard(resume, custom) {
    const en = RS.syncEnglish(resume) || {};
    const ec = (en.customSections || []).find((c) => c.id === custom.id) || { items: [] };
    const labels = Object.assign({}, RS.EN_CUSTOM_LABELS, ec.labels || {});
    const items = (custom.items || [])
      .map((zhItem) => {
        const item = (ec.items || []).find((it) => it.id === zhItem.id) || { id: zhItem.id };
        const body = ['name', 'role', 'start', 'end']
          .map((key) =>
            field({
              label: labels[key],
              value: item[key] || '',
              hint: srcHint(zhItem[key]),
              section: 'custom:' + custom.id,
              id: item.id,
              name: key,
              scope: 'en',
            })
          )
          .join('');
        return `
        <div class="item" data-item="${item.id}">
          <div class="item-bar">
            <span class="item-title">${esc(item.name || zhItem.name || '新条目')}</span>
            <span class="item-tools">
              <button class="icon-btn" data-action="translate-item" data-section="custom:${
                custom.id
              }" data-id="${item.id}" title="翻译这一条" aria-label="翻译这一条">译</button>
            </span>
          </div>
          <div class="grid">${body}</div>
          ${richField({
            label: labels.desc,
            value: item.desc || '',
            hint: srcHint(zhItem.desc),
            section: 'custom:' + custom.id,
            id: item.id,
            name: 'desc',
            scope: 'en',
          })}
        </div>`;
      })
      .join('');

    return card({
      key: 'custom_' + custom.id,
      title: custom.title,
      hint: 'English',
      count: (custom.items || []).length || undefined,
      body: items || '<p class="empty-hint">中文版这一块还没有内容。</p>',
    });
  }

  /** 顶部的一句说明：所有字段都是可选的，留空就不会出现在 PDF 里 */
  const optionalHint = (lang) =>
    lang === 'en'
      ? `<p class="optional-hint"><span class="optional-hint-icon" aria-hidden="true">ⓘ</span>Everything is optional — anything you leave blank simply won't appear in the exported PDF. Fill in only what you need.</p>`
      : `<p class="optional-hint"><span class="optional-hint-icon" aria-hidden="true">ⓘ</span>所有内容都可以不填：留空的项目不会出现在导出的 PDF 里，只写你需要的那部分就行。</p>`;

  function renderEditor(root, resume, lang) {
    const en = lang === 'en';
    const customs = resume.customSections || [];

    // 左侧卡片顺序 = 简历里的模块顺序：用户在顶部把模块挪到哪，这里就跟到哪
    const cards = {};
    normalizeSectionOrder(resume).forEach((id) => {
      if (id === 'summary') {
        cards[id] = summaryCard(resume, lang);
        return;
      }
      if (id === 'skills') {
        cards[id] = en ? enSkillsCard(resume) : skillsCard(resume);
        return;
      }
      const custom = customs.find((c) => c.id === id);
      if (custom) {
        cards[id] = en ? enCustomCard(resume, custom) : customCard(resume, custom);
        return;
      }
      const meta = ITEM_SECTIONS.find((m) => m.key === id);
      if (meta) cards[id] = en ? enListCard(resume, meta) : listCard(resume, meta);
    });

    const ordered = normalizeSectionOrder(resume)
      .map((id) => cards[id] || '')
      .join('');

    root.innerHTML =
      optionalHint(lang) +
      titleCard(resume) +
      (en ? enBasicsCard(resume) : basicsCard(resume)) +
      ordered +
      (en ? '' : '<button class="btn btn-ghost btn-block" data-action="add-custom">＋ 添加自定义模块</button>');
  }

  /* ---------------------------- 事件绑定 ---------------------------- */

  /** 把富文本框的当前内容存回数据（存的是净化后的 HTML） */
  function commitRich(field, handlers) {
    const html = toEditable(field.innerHTML);
    if (field.dataset.bind) {
      handlers.setPath(field.dataset.bind, html);
    } else {
      handlers.setField(field.dataset.section, field.dataset.id, field.dataset.field, html, field.dataset.scope);
    }
  }

  /** 卡片标题就地改名：点 ✏️ → 标题变成输入框 → 回车/失焦保存，Esc 取消 */
  function startTitleEdit(btn, handlers) {
    const cardEl = btn.closest('.card');
    if (!cardEl) return;
    const titleEl = cardEl.querySelector('.card-head .card-title');
    if (!titleEl) return;

    const id = btn.dataset.sectionId;
    const isEn = btn.dataset.editLang === 'en';
    const isCustom = btn.dataset.editCustom === '1';
    const current = titleEl.textContent;

    const input = document.createElement('input');
    input.className = 'card-title-input';
    input.value = current;
    input.setAttribute('aria-label', '模块名称');
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      const span = document.createElement('span');
      span.className = 'card-title';
      span.textContent = save && value ? value : current;
      input.replaceWith(span);
      if (!save || !value || value === current) return;
      if (isCustom) handlers.setCustomMeta(id, 'title', value);
      else if (isEn) handlers.setPath('en.sectionTitles.' + id, value);
      else handlers.setSectionTitle(id, value);
    };

    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event) => {
      // 别让空格/方向键冒泡到卡片的折叠逻辑
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
  }

  /**
   * 只绑定一次（在 app 启动时调用）。
   * handlers 里每个方法负责"改数据"，改完由 app 决定要不要重绘。
   */
  function bindEditor(root, handlers) {
    root.addEventListener('input', (event) => {
      const el = event.target;
      if (!el || !el.matches) return;
      if (el.matches('[data-rich]')) {
        commitRich(el, handlers);
        return;
      }
      if (el.matches('[data-list-lines]')) {
        handlers.setListLines(el.dataset.listLines, el.value);
        return;
      }
      if (el.matches('[data-extras-lines]')) {
        handlers.setExtrasLines(el.dataset.extrasLines, el.value);
        return;
      }
      if (el.matches('[data-bind]')) {
        handlers.setPath(el.dataset.bind, el.value);
      } else if (el.matches('[data-custom-meta]')) {
        handlers.setCustomMeta(el.dataset.customMeta, el.dataset.metaKey, el.value);
      } else if (el.matches('[data-section-title]')) {
        handlers.setSectionTitle(el.dataset.sectionTitle, el.value);
      } else if (el.matches('[data-field]')) {
        handlers.setField(el.dataset.section, el.dataset.id, el.dataset.field, el.value, el.dataset.scope);
      }
    });

    // 失焦时把 DOM 也换成净化后的版本，避免界面上留着无意义标签
    root.addEventListener(
      'focusout',
      (event) => {
        const el = event.target;
        if (!el || !el.matches || !el.matches('[data-rich]')) return;
        const clean = toEditable(el.innerHTML);
        if (clean !== el.innerHTML) el.innerHTML = clean;
      },
      true
    );

    // 格式按钮：用 mousedown 保住选区，否则点按钮时编辑区会失焦
    root.addEventListener('mousedown', (event) => {
      const btn = event.target.closest('[data-cmd]');
      if (!btn) return;
      event.preventDefault();
      const wrap = btn.closest('[data-rich-wrap]');
      const field = wrap && wrap.querySelector('[data-rich]');
      if (!field) return;

      if (document.activeElement !== field) {
        field.focus();
        const range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand(btn.dataset.cmd, false, null);
      commitRich(field, handlers);
    });

    // 回车只插入换行，不要生成 <div>（白名单里没有 div，会被转义成文字）
    root.addEventListener('keydown', (event) => {
      const el = event.target;
      if (!el || !el.matches) return;
      if (el.matches('[data-rich]') && event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        document.execCommand('insertLineBreak');
        commitRich(el, handlers);
        return;
      }
      if (el.matches('[data-chip-input]') && event.key === 'Enter') {
        event.preventDefault();
        const value = el.value.trim();
        if (value) handlers.addChip(value, el.dataset.scope);
        el.value = '';
      }
    });

    // 粘贴只取纯文本：保留格式会带进一堆 span/style，白名单挡不住"看起来乱"
    root.addEventListener('paste', (event) => {
      const el = event.target;
      if (!el || !el.matches || !el.matches('[data-rich]')) return;
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
      commitRich(el, handlers);
    });

    // 点工具栏空白或内边距时，把焦点交给编辑区（点正文时浏览器已经聚焦，这里会提前返回）
    root.addEventListener('click', (event) => {
      const wrap = event.target.closest('[data-rich-wrap]');
      if (!wrap || event.target.closest('[data-cmd]')) return;
      const field = wrap.querySelector('[data-rich]');
      if (!field || document.activeElement === field) return;
      field.focus();
      const range = document.createRange();
      range.selectNodeContents(field);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    root.addEventListener('change', (event) => {
      const el = event.target;
      if (!el || !el.matches) return;
      if (el.matches('[data-photo-input]')) {
        const file = el.files && el.files[0];
        if (file) handlers.setPhoto(file);
        el.value = '';
        return;
      }
      // 字段显示名改完后重绘一次，让下面条目的字段标题跟着变
      if (el.matches('[data-custom-meta][data-meta-key^="label:"]')) {
        handlers.refreshEditor();
      }
    });

    root.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const section = btn.dataset.section;
      const id = btn.dataset.id;
      const dir = btn.dataset.dir;
      const index = btn.dataset.index;
      const scope = btn.dataset.scope;

      if (action === 'edit-title') {
        // 铅笔在 <summary> 里，不拦住的话点一下会顺带折叠卡片
        event.preventDefault();
        event.stopPropagation();
        startTitleEdit(btn, handlers);
        return;
      }

      if (action === 'add-item') {
        handlers.addItem(section, scope);
      } else if (action === 'remove-custom') {
        handlers.removeCustomSection(btn.dataset.custom);
      } else if (action === 'add-custom') {
        handlers.addCustomSection();
      } else if (action === 'remove-item') {
        handlers.removeItem(section, id, scope);
      } else if (action === 'move-item') {
        handlers.moveItem(section, id, Number(dir), scope);
      } else if (action === 'remove-chip') {
        handlers.removeChip(Number(index), scope);
      } else if (action === 'add-chip') {
        const input = root.querySelector('[data-chip-input]');
        const value = input && input.value.trim();
        if (value) handlers.addChip(value, scope);
        if (input) input.value = '';
      } else if (action === 'pick-photo') {
        const input = root.querySelector('[data-photo-input]');
        if (input) input.click();
      } else if (action === 'remove-photo') {
        handlers.removePhoto();
      } else if (action === 'move-group') {
        handlers.moveGroup(btn.dataset.group, Number(dir));
      } else if (action === 'move-section') {
        handlers.moveSection(btn.dataset.sectionId, Number(dir));
      } else if (action === 'translate-item') {
        handlers.translateItem(section, id);
      } else if (action === 'translate-field') {
        handlers.translateField(btn.dataset.target);
      }
    });
  }

  RS.renderEditor = renderEditor;
  RS.renderOrderList = renderOrderList;
  RS.bindEditor = bindEditor;
})();
