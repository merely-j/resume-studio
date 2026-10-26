/**
 * 渲染层：把简历数据变成 A4 纸上的 HTML 字符串
 * ------------------------------------------------------------
 * 这里刻意不碰 DOM（不 querySelector、不 appendChild），
 * 只做 "数据 -> HTML 字符串" 的纯函数转换。好处：
 * 1. 可以直接在 Node 里跑测试，不用浏览器；
 * 2. 同一份数据可以同时渲染到屏幕预览和打印，不会出现两套样式；
 * 3. 以后要加"导出图片/服务端渲染 PDF"，复用这几个函数即可。
 */

(function () {
  'use strict';

  const RS = (window.RS = window.RS || {});
  const { formatRange, formatBirthday, formatPhone, normalizeSectionOrder, sectionTitle } = RS;

  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** 所有用户输入都必须转义，否则输入 <script> 就能注入 */
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);

  const has = (value) => String(value == null ? '' : value).trim().length > 0;

  /** 有值才渲染，避免简历里出现一堆空标题 */
  const section = (title, body) =>
    has(body) && String(body).replace(/<[^>]*>/g, '').trim()
      ? `<section class="r-section"><h2 class="r-section-title">${esc(title)}</h2>${body}</section>`
      : '';

  /* ---------------------------- 富文本 ---------------------------- */

  /**
   * 富文本白名单：只保留这几个行内标签，其余标签一律转义成文本。
   * 这是"允许加粗"和"防注入"之间的平衡点 ——
   * 用户能写 <b> 得到加粗，但写 <script> 只会看到字面量。
   */
  const RICH_TAGS = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', br: 'br' };

  function richText(value) {
    // 旧的纯文本用换行分段，统一转成 <br>，和富文本共存
    const raw = String(value == null ? '' : value).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
    return raw
      .split(/(<[^>]*>)/g)
      .map((part) => {
        if (part.charAt(0) === '<' && part.length > 2) {
          const match = /^<\s*(\/?)\s*([a-zA-Z0-9]+)[^>]*>$/.exec(part);
          const tag = match && RICH_TAGS[match[2].toLowerCase()];
          if (!tag) return esc(part); // 不在白名单：整个标签转义
          if (tag === 'br') return '<br>';
          // 重建标签，顺带丢掉 class/style 等所有属性
          return '<' + (match[1] ? '/' : '') + tag + '>';
        }
        return esc(part);
      })
      .join('');
  }

  /** 富文本转要点：按 <br> 或换行拆行，每行仍保留加粗/斜体 */
  function richToBullets(value) {
    const raw = String(value == null ? '' : value).replace(/\r\n/g, '\n');
    return raw
      .split(/<br\s*\/?>|\n/i)
      .map((line) =>
        richText(line)
          .replace(/^(\s|&nbsp;)+/, '')
          .replace(/^[-•*·]\s*/, '')
          .replace(/(\s|&nbsp;)+$/, '')
      )
      .filter((line) => line.replace(/<[^>]*>/g, '').trim() !== '');
  }

  const bullets = (text) => {
    const items = richToBullets(text);
    if (!items.length) return '';
    return `<ul class="r-bullets">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  };

  /** 界面文案（中英各一套）：只用于"联系方式 / 个人信息"这类固定标签 */
  const UI_LABELS = {
    zh: {
      contact: '联系方式',
      personal: '个人信息',
      phone: '电话',
      email: '邮箱',
      city: '城市',
      link: '主页',
      gender: '性别',
      ethnicity: '民族',
      birthday: '生日',
      hometown: '籍贯',
      politics: '政治面貌',
    },
    en: {
      contact: 'Contact',
      personal: 'Personal',
      phone: 'Phone',
      email: 'Email',
      city: 'City',
      link: 'Website',
      gender: 'Gender',
      ethnicity: 'Ethnicity',
      birthday: 'Date of birth',
      hometown: 'Hometown',
      politics: 'Political status',
    },
  };

  const labelsOf = (resume) => UI_LABELS[(resume && resume.lang) === 'en' ? 'en' : 'zh'];

  const contactList = (basics, labels) => {
    const L = labels || UI_LABELS.zh;
    return [
      // 手机号一律显示成纯数字，不出现短横线或空格
      [L.phone, formatPhone(basics.phone)],
      [L.email, basics.email],
      [L.city, basics.city],
      [L.link, basics.link],
    ].filter(([, value]) => has(value));
  };

  const contactHtml = (basics, sep, labels) =>
    contactList(basics, labels)
      .map(([, value]) => `<span class="r-contact-item">${esc(value)}</span>`)
      .join(`<span class="r-contact-sep">${sep || '·'}</span>`);

  /**
   * 可选的个人信息。这里的每一项都可以留空 ——
   * 留空的字段不会出现在简历里，也不会留下分隔符或空行。
   */
  const PERSONAL_FIELDS = [
    ['gender', 'gender'],
    ['ethnicity', 'ethnicity'],
    ['birthday', 'birthday'],
    ['hometown', 'hometown'],
    ['politics', 'politics'],
  ];

  const personalList = (basics, labels) => {
    const L = labels || UI_LABELS.zh;
    return PERSONAL_FIELDS.map(([labelKey, key]) => {
      // 生日统一显示成 1995-08 的横杠形式
      const value = key === 'birthday' ? formatBirthday(basics[key]) : basics[key];
      return [L[labelKey], value];
    }).filter(([, value]) => has(value));
  };

  /** 头部两块的顺序（联系方式 / 个人信息），由用户在编辑器里调 */
  const blockOrder = (basics) =>
    Array.isArray(basics.blockOrder) && basics.blockOrder.length === 2
      ? basics.blockOrder
      : ['contact', 'personal'];

  /** 经典/极简模板：按顺序拼出联系方式行和个人信息行 */
  function headBlocks(basics, sep, labels) {
    const contact = contactHtml(basics, sep, labels);
    const parts = {
      contact: contact ? `<p class="r-contact">${contact}</p>` : '',
      personal: personalLine(basics, labels),
    };
    return blockOrder(basics)
      .map((id) => parts[id] || '')
      .join('');
  }

  /** 经典/极简模板：把有值的个人信息拼成一行 */
  const personalLine = (basics, labels) => {
    const items = personalList(basics, labels);
    if (!items.length) return '';
    return `<p class="r-personal">${items
      .map(([, value]) => esc(value))
      .join('<span class="r-dot">·</span>')}</p>`;
  };

  /** 公共：条目头部（标题 + 副标题 + 右侧时间） */
  const entryHead = (title, sub, start, end) => `
    <div class="r-entry-head">
      <div class="r-entry-main">
        <span class="r-entry-title">${esc(title)}</span>
        ${has(sub) ? `<span class="r-entry-sub">${esc(sub)}</span>` : ''}
      </div>
      ${
        has(formatRange(start, end))
          ? `<span class="r-entry-date">${esc(formatRange(start, end))}</span>`
          : ''
      }
    </div>`;

  /** 工作经历 */
  function experienceHtml(resume) {
    const rows = (resume.experience || [])
      .filter((item) => has(item.company) || has(item.role))
      .map(
        (item) => `
      <article class="r-entry">
        ${entryHead(item.company, item.role, item.start, item.end)}
        ${bullets(item.desc)}
      </article>`
      )
      .join('');
    return section(sectionTitle(resume, 'experience'), rows ? `<div class="r-entries">${rows}</div>` : '');
  }

  /** 项目经历 */
  function projectsHtml(resume) {
    const rows = (resume.projects || [])
      .filter((item) => has(item.name))
      .map(
        (item) => `
      <article class="r-entry">
        ${entryHead(item.name, item.role, item.start, item.end)}
        ${bullets(item.desc)}
      </article>`
      )
      .join('');
    return section(sectionTitle(resume, 'projects'), rows ? `<div class="r-entries">${rows}</div>` : '');
  }

  /** 教育经历 */
  function educationHtml(resume) {
    const rows = (resume.education || [])
      .filter((item) => has(item.school))
      .map((item) => {
        // 专业和学历分开填，这里用 · 连起来显示在副标题里
        const subtitle = [item.major, item.degree].filter(has).join(' · ');
        return `
      <article class="r-entry">
        ${entryHead(item.school, subtitle, item.start, item.end)}
        ${bullets(item.desc)}
      </article>`;
      })
      .join('');
    return section(sectionTitle(resume, 'education'), rows ? `<div class="r-entries">${rows}</div>` : '');
  }

  /** 技能与证书：技能是"一整行"（技能 A / B / C），证书是逐条 */
  function skillsCertsHtml(resume) {
    // 技能只按内容判断：类别默认叫「技能」，内容为空时整块不显示
    const skills = (resume.skills || []).filter((item) => has(item && item.value));
    const certs = (resume.extras || []).filter((item) => has(item.label) || has(item.value));
    if (!skills.length && !certs.length) return '';

    const skillsPart = skills.length
      ? `<ul class="r-extras">${skills
          .map(
            (item) =>
              `<li><span class="r-extra-label">${esc(item.label || '技能')}</span>${esc(
                item.value
              )}</li>`
          )
          .join('')}</ul>`
      : '';

    const certsPart = certs.length
      ? `<ul class="r-extras">${certs
          .map(
            (item) =>
              `<li>${
                has(item.label) ? `<span class="r-extra-label">${esc(item.label)}</span>` : ''
              }${esc(item.value)}</li>`
          )
          .join('')}</ul>`
      : '';

    return section(sectionTitle(resume, 'skills'), skillsPart + certsPart);
  }

  /** 自定义模块：字段名由用户自己定，结构和工作经历一致 */
  function customSectionHtml(resume, custom) {
    const items = (custom.items || []).filter(
      (item) => has(item.name) || has(item.role) || has(item.desc)
    );
    if (!items.length) return '';
    const rows = items
      .map(
        (item) => `
      <article class="r-entry">
        ${entryHead(item.name, item.role, item.start, item.end)}
        ${bullets(item.desc)}
      </article>`
      )
      .join('');
    return section(custom.title || '自定义模块', `<div class="r-entries">${rows}</div>`);
  }

  /** 渲染任意一个模块（固定模块或自定义模块） */
  function renderSection(resume, id) {
    if (id === 'summary') return summaryHtml(resume);
    if (id === 'experience') return experienceHtml(resume);
    if (id === 'projects') return projectsHtml(resume);
    if (id === 'education') return educationHtml(resume);
    if (id === 'skills') return skillsCertsHtml(resume);
    const custom = (resume.customSections || []).find((section) => section.id === id);
    return custom ? customSectionHtml(resume, custom) : '';
  }

  /** 头部：照片（有才渲染）+ 姓名 + 头衔 + 联系方式 / 个人信息（顺序可调） */
  function headHtml(resume, opts) {
    const options = opts || {};
    const b = resume.basics || {};
    const photo = has(b.photo) ? `<img class="r-photo" src="${esc(b.photo)}" alt="">` : '';
    return `
    <header class="r-head ${options.center ? 'r-head--center' : ''} ${
      photo ? 'r-head--with-photo' : ''
    }">
      ${photo}
      <div class="r-head-text">
        ${has(b.name) ? `<h1 class="r-name">${esc(b.name)}</h1>` : ''}
        ${has(b.headline) ? `<p class="r-headline">${esc(b.headline)}</p>` : ''}
        ${headBlocks(b, options.contactSep, labelsOf(resume))}
      </div>
    </header>`;
  }

  const summaryHtml = (resume) => {
    const b = resume.basics || {};
    return section(
      sectionTitle(resume, 'summary'),
      has(b.summary) ? `<p class="r-summary">${richText(b.summary)}</p>` : ''
    );
  };

  /* ------------------------------------------------------------------ */
  /* 三套模板                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 按用户在"模块顺序"里设定的先后渲染大模块。
   * 自定义模块也在顺序数组里，统一由 renderSection 分发。
   * ids 用于双栏模板：只取属于某一列的那几个模块，但顺序仍按全局设定。
   */
  /** 给模块打上标记：预览区悬停出虚框、点击跳回左侧对应卡片 */
  function markSection(resume, id, html) {
    if (!html) return '';
    return html.replace(
      '<section class="r-section">',
      `<section class="r-section" data-target="${esc(id)}" data-label="${esc(sectionTitle(resume, id))}">`
    );
  }

  function orderedSections(resume, ids) {
    const order = normalizeSectionOrder(resume);
    const list = Array.isArray(ids) ? order.filter((id) => ids.indexOf(id) !== -1) : order;
    return list.map((id) => markSection(resume, id, renderSection(resume, id))).join('');
  }

  function classicTemplate(resume) {
    return `
    <div class="r-inner tpl-classic">
      ${headHtml(resume, { center: true })}
      ${orderedSections(resume)}
    </div>`;
  }

  function modernTemplate(resume) {
    const b = resume.basics || {};
    const L = labelsOf(resume);
    const contacts = contactList(b, L);
    const personals = personalList(b, L);

    const contactBlock = contacts.length
      ? `<div class="r-side-block"><h2 class="r-side-title">${esc(
          L.contact
        )}</h2><ul class="r-side-list">${contacts
          .map(([label, value]) => `<li><span>${esc(label)}</span>${esc(value)}</li>`)
          .join('')}</ul></div>`
      : '';
    const personalBlock = personals.length
      ? `<div class="r-side-block"><h2 class="r-side-title">${esc(
          L.personal
        )}</h2><ul class="r-side-list">${personals
          .map(([label, value]) => `<li><span>${esc(label)}</span>${esc(value)}</li>`)
          .join('')}</ul></div>`
      : '';

    const skillsBlock = (function () {
      const skills = (resume.skills || []).filter((item) => has(item && item.value));
      const certs = (resume.extras || []).filter((item) => has(item.label) || has(item.value));
      if (!skills.length && !certs.length) return '';
      return `<div class="r-side-block" data-target="skills" data-label="${esc(
        sectionTitle(resume, 'skills')
      )}"><h2 class="r-side-title">${esc(sectionTitle(resume, 'skills'))}</h2>
        ${
          skills.length
            ? `<ul class="r-side-list r-side-list--plain">${skills
                .map(
                  (item) =>
                    `<li><span class="r-extra-label">${esc(
                      item.label || '技能'
                    )}</span>${esc(item.value)}</li>`
                )
                .join('')}</ul>`
            : ''
        }
        ${
          certs.length
            ? `<ul class="r-side-list r-side-list--plain">${certs
                .map(
                  (item) =>
                    `<li>${
                      has(item.label)
                        ? `<span class="r-extra-label">${esc(item.label)}</span>`
                        : ''
                    }${esc(item.value)}</li>`
                )
                .join('')}</ul>`
            : ''
        }
      </div>`;
    })();

    // 侧栏只放教育经历和技能证书，其余（含自定义模块）都放主栏；
    // 两栏各自按用户设定的全局顺序排列。
    const sideRenderers = {
      education: () => markSection(resume, 'education', educationHtml(resume)),
      skills: () => skillsBlock,
    };
    const order = normalizeSectionOrder(resume);
    const sideOrdered = order
      .filter((id) => sideRenderers[id])
      .map((id) => sideRenderers[id]())
      .join('');
    const mainOrdered = order
      .filter((id) => !sideRenderers[id])
      .map((id) => markSection(resume, id, renderSection(resume, id)))
      .join('');

    return `
    <div class="r-inner tpl-modern">
      <aside class="r-side">
        <div class="r-side-head">
          ${
            has(b.photo)
              ? `<img class="r-photo r-photo--side" src="${esc(b.photo)}" alt="">`
              : ''
          }
          ${has(b.name) ? `<h1 class="r-name">${esc(b.name)}</h1>` : ''}
          ${has(b.headline) ? `<p class="r-headline">${esc(b.headline)}</p>` : ''}
        </div>
        ${blockOrder(b)
          .map((id) => (id === 'contact' ? contactBlock : personalBlock))
          .join('')}
        ${sideOrdered}
      </aside>
      <main class="r-main">
        ${mainOrdered}
      </main>
    </div>`;
  }

  function minimalTemplate(resume) {
    return `
    <div class="r-inner tpl-minimal">
      ${headHtml(resume)}
      ${orderedSections(resume)}
    </div>`;
  }

  const RENDERERS = {
    classic: classicTemplate,
    modern: modernTemplate,
    minimal: minimalTemplate,
  };

  /**
   * 主入口：渲染整份简历
   * @param {object} resume 简历数据
   * @returns {string} HTML 字符串
   */
  function renderResume(resume) {
    const render = RENDERERS[resume.template] || RENDERERS.classic;
    return render(resume);
  }

  RS.renderResume = renderResume;
  RS.richText = richText;
  RS.richToBullets = richToBullets;
})();
