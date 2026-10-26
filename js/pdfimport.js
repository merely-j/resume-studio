/**
 * PDF 导入：把一份简历 PDF 拆成我们的结构化数据
 * ------------------------------------------------------------
 * 关键认知：PDF 里没有"公司/职位"这种结构，只有一堆带坐标的文字。
 * 所以这里做的是"切分与归类"，不是"改写"：
 *   · 用户写的是什么就保留什么（列表符号、换行、日期写法都不动）
 *   · 认不出归属的内容，放进"其他"模块，绝不丢弃
 *
 * pdf.js 体积约 1.5MB，只在用户点「导入 PDF」时才按需加载。
 */

(function () {
  'use strict';

  const RS = (window.RS = window.RS || {});

  const PDFJS_SRC = './vendor/pdfjs/pdf.min.js';
  const PDFJS_WORKER = './vendor/pdfjs/pdf.worker.min.js';

  let pdfjsLoading = null;

  /** 按需加载 pdf.js（只加载一次） */
  function loadPdfjs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsLoading) return pdfjsLoading;

    pdfjsLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PDFJS_SRC;
      script.onload = () => {
        if (!window.pdfjsLib) {
          reject(new Error('pdf.js 加载后没有初始化'));
          return;
        }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error('pdf.js 加载失败（可能是离线且未缓存）'));
      document.head.appendChild(script);
    });
    return pdfjsLoading;
  }

  /* ---------------------------- 文本归一化 ---------------------------- */

  /**
   * 很多 PDF 用"部首字符"来编码汉字：⼯(U+2F2F)、⽤(U+2F64)、⻓(U+2ED3)…
   * 它们看着和「工/用/长」一模一样，但码位不同，用户复制出来是怪字符，
   * 标题匹配也会失败。NFKC 能修好康熙部首区（U+2F00–2FDF），
   * 但部首补充区（U+2E80–2EFF）不在标准分解里，得自己补一张表。
   */
  const SIMPLIFIED_RADICAL = {
    '\u2E9F': '母', // 部首「母」的写法，PDF 里常出现在"⺟语"
    '\u2EA6': '丬', // 爿
    '\u2EB0': '纟', // 糸
    '\u2EC5': '见',
    '\u2EC6': '角',
    '\u2EC8': '讠', // 言
    '\u2EC9': '贝',
    '\u2ECB': '车',
    '\u2ECC': '辶',
    '\u2ED0': '钅', // 金
    '\u2ED3': '长',
    '\u2ED4': '门',
    '\u2ED9': '韦',
    '\u2EDA': '页',
    '\u2EDB': '风',
    '\u2EDC': '飞',
    '\u2EE0': '饣', // 食
    '\u2EE2': '马',
    '\u2EE5': '鱼',
    '\u2EE6': '鸟',
    '\u2EE7': '卤',
    '\u2EE8': '麦',
    '\u2EE9': '黄',
    '\u2EEA': '黾',
    '\u2EEB': '斉',
    '\u2EEC': '齐',
    '\u2EED': '歯',
    '\u2EEE': '齿',
    '\u2EEF': '竜',
    '\u2EF0': '龙',
    '\u2EF2': '亀',
    '\u2EF3': '龟',
  };

  /** NFKC 之后仍有少数会还原成繁体（如「戶」），按简体修一下 */
  const TRADITIONAL_FIX = {
    戶: '户',
    見: '见',
    頁: '页',
    長: '长',
    風: '风',
    門: '门',
    馬: '马',
    車: '车',
    貝: '贝',
    魚: '鱼',
    鳥: '鸟',
    龍: '龙',
    齊: '齐',
    齒: '齿',
    黃: '黄',
  };

  function normalizeText(value) {
    const src = String(value == null ? '' : value);
    let out = '';
    for (const ch of src) {
      const code = ch.codePointAt(0);
      if (code >= 0x2e80 && code <= 0x2eff) {
        // 部首补充区：NFKC 覆盖不到，只替换"已确认的简体部首"，
        // 认不出的一律原样保留（后面会给出提示，而不是乱猜一个字）
        out += SIMPLIFIED_RADICAL[ch] || ch;
      } else if (code >= 0x2f00 && code <= 0x2fdf) {
        // 康熙部首区：NFKC 能修，但它会顺手把全角标点改成半角，
        // 所以只对"部首字符"逐个做 NFKC
        const fixed = ch.normalize('NFKC');
        out += TRADITIONAL_FIX[fixed] || fixed;
      } else {
        // 正文里的字一律不动（繁体用户写的繁体也保留）
        out += ch;
      }
    }
    return out;
  }

  /** 归一化之后还剩非标准部首字符 → 这份 PDF 的字体编码不正常，给用户提个醒 */
  function hasBrokenGlyphs(text) {
    return /[\u2E80-\u2FDF]/.test(text);
  }

  /* ---------------------------- 文本提取 ---------------------------- */

  /**
   * 把 PDF 拆成"行"：同一基线上的文字片段拼成一行。
   * 顺便做 NFKC 归一化 —— 很多 PDF 用康熙部首编码（⼯/⻓/⽤），
   * 看着一样但不是同一个字，不归一化会让用户复制出来都是怪字符。
   */
  async function extractLines(buffer) {
    const pdfjsLib = await loadPdfjs();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const lines = [];
    const pages = [];

    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pageLines = [];
      let current = null;

      content.items.forEach((item) => {
        if (!item.str) return;
        const y = Math.round(item.transform[5]);
        const x = Math.round(item.transform[4]);
        const size = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 10) / 10;
        const right = x + (item.width || 0);

        if (current && Math.abs(current.y - y) <= 3) {
          current.spans.push({ x, str: item.str, size });
          current.text += item.str;
          current.right = Math.max(current.right, right);
        } else {
          current = {
            y,
            x,
            right,
            size,
            text: item.str,
            spans: [{ x, str: item.str, size }],
          };
          pageLines.push(current);
        }
      });

      pageLines.forEach((line) => {
        const text = normalizeText(line.text).replace(/\s+/g, ' ').trim();
        if (!text) return;
        lines.push({
          text,
          x: line.x,
          right: line.right,
          y: line.y,
          size: line.size,
          page: p,
        });
      });
      pages.push({ page: p, width: page.view[2], height: page.view[3] });
    }

    // 关键：PDF 内容流顺序 ≠ 视觉顺序。有些生成器先画正文、最后才画姓名，
    // 不按坐标重排就会出现"名字跑到最下面""工作经历变成姓名"。
    const ordered = orderByLayout(lines, pages, doc.numPages);
    return { lines: ordered, pages, numPages: doc.numPages };
  }

  /* ---------------------------- 阅读顺序 ---------------------------- */

  /** 按页处理：先找栏，再从上到下、从左到右 */
  function orderByLayout(lines, pages, numPages) {
    const sizeOf = {};
    pages.forEach((p) => {
      sizeOf[p.page] = { width: p.width || 595, height: p.height || 842 };
    });

    const out = [];
    for (let page = 1; page <= numPages; page += 1) {
      const pageLines = lines.filter((l) => l.page === page);
      if (!pageLines.length) continue;
      const info = sizeOf[page] || { width: 595, height: 842 };
      out.push(...orderPage(pageLines, info, 0));
    }
    return out;
  }

  function orderPage(lines, pageInfo, depth) {
    if (lines.length <= 1 || depth > 2) return sortTopDown(lines);

    const split = findColumnSplit(lines, pageInfo);
    if (!split) return sortTopDown(lines);

    const left = lines.filter((l) => (l.right || l.x) <= split.end + 1);
    const right = lines.filter((l) => l.x >= split.end - 1);
    const rest = lines.filter(
      (l) => !((l.right || l.x) <= split.end + 1) && !(l.x >= split.end - 1)
    );

    return [
      ...orderPage(left, pageInfo, depth + 1),
      ...orderPage(rest, pageInfo, depth + 1),
      ...orderPage(right, pageInfo, depth + 1),
    ];
  }

  function sortTopDown(lines) {
    // y 越大越靠上；同一行内按 x 从左到右
    return lines.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  }

  /**
   * 找出一段"没有任何文字跨越"的竖向空白带，把页面分成左右两栏。
   * 只认足够宽、两侧都够多、且右侧纵向覆盖也够大的空隙，
   * 否则单栏简历里右对齐的日期会被误判成第二栏。
   */
  function findColumnSplit(lines, pageInfo) {
    const width = pageInfo.width || 595;
    const sorted = lines.slice().sort((a, b) => a.x - b.x);
    let maxRight = -Infinity;
    let best = null;

    sorted.forEach((line) => {
      const right = line.right || line.x;
      if (maxRight !== -Infinity) {
        const gap = line.x - maxRight;
        if (gap > width * 0.06) {
          const leftCount = sorted.filter((l) => (l.right || l.x) <= maxRight + 1).length;
          const rightCount = sorted.filter((l) => l.x >= line.x - 1).length;
          const total = sorted.length;
          if (
            leftCount >= 3 &&
            rightCount >= 3 &&
            leftCount / total >= 0.15 &&
            rightCount / total >= 0.15
          ) {
            const rightSpan = verticalSpan(sorted.filter((l) => l.x >= line.x - 1));
            const allSpan = verticalSpan(sorted) || 1;
            if (!best || gap > best.gap) {
              best = {
                start: maxRight,
                end: line.x,
                gap,
                ratio: rightSpan / allSpan,
              };
            }
          }
        }
      }
      maxRight = Math.max(maxRight, right);
    });

    if (best && best.ratio >= 0.35) return { start: best.start, end: best.end };
    return null;
  }

  function verticalSpan(lines) {
    if (!lines.length) return 0;
    const top = Math.max(...lines.map((l) => l.y));
    const bottom = Math.min(...lines.map((l) => l.y));
    return Math.max(0, top - bottom);
  }

  /** 视觉上连续的两行合并成一段（同字号、同缩进、上一行没以句号结尾） */
  function mergeParagraphs(lines) {
    const out = [];
    if (!lines.length) return out;
    const bodySize = median(lines.map((l) => l.size)) || 10;

    // 左边距出现最多的那个 x，就是正文的左边界；
    // 缩进更多的一般是项目符号，绝不能和上一行合并，否则两条要点会粘成一句
    const counts = {};
    lines.forEach((l) => {
      counts[l.x] = (counts[l.x] || 0) + 1;
    });
    const leftMargin = Number(
      Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || lines[0].x
    );

    lines.forEach((line) => {
      const prev = out[out.length - 1];
      const canMerge =
        prev &&
        prev.x === leftMargin &&
        line.x === leftMargin &&
        !/\d{4}\s*[-./年]/.test(prev.text) &&
        Math.abs(prev.size - line.size) < 0.6 &&
        prev.size <= bodySize + 0.4 &&
        line.size <= bodySize + 0.4 &&
        !/[。！？：:；;.]$/.test(prev.text) &&
        prev.y - line.y > 0 &&
        prev.y - line.y < line.size * 1.7;
      if (canMerge) {
        prev.text += line.text;
      } else {
        out.push(Object.assign({}, line));
      }
    });
    return out;
  }

  function median(nums) {
    if (!nums.length) return 0;
    const sorted = nums.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /* ---------------------------- 规则表 ---------------------------- */

  const SECTION_PATTERNS = [
    { id: 'summary', re: /^(个人简介|自我评价|个人总结|个人优势|简介|Summary|Profile|About Me|Objective)$/i },
    { id: 'experience', re: /^(工作经历|工作经验|职业经历|实习经历|Experience|Work Experience|Employment|Work History)$/i },
    { id: 'projects', re: /^(项目经历|项目经验|主要项目|Projects|Project Experience)$/i },
    { id: 'education', re: /^(教育背景|教育经历|学历背景|Education|Education Background)$/i },
    { id: 'skills', re: /^(技能|技能与特长|专业技能|技术技能|Skills|Technical Skills)$/i },
    { id: 'certs', re: /^(资格证书|证书|认证|资质|Certifications?|Certificates?)$/i },
    { id: 'awards', re: /^(荣誉|获奖经历|奖项|Awards|Honors)$/i },
    { id: 'other', re: /^(其它|其他|语言|语言能力|兴趣爱好|Other|Others|Languages|Interests)$/i },
  ];

  const DATE_RANGE =
    /((?:19|20)\d{2}\s*[-./年]\s*\d{1,2}\s*月?)\s*[-–—~～至到]\s*((?:19|20)\d{2}\s*[-./年]\s*\d{1,2}\s*月?|至今|现在|目前|今|Present|present|Now)/;

  const ROLE_WORDS =
    /(经理|总监|主管|专员|工程师|设计师|开发|运营|产品|架构师|分析师|顾问|助理|实习生|负责人|创始人|合伙人|Leader|Manager|Engineer|Designer|Analyst|Director|Lead|Intern|Consultant|Specialist)/i;

  const DEGREE_WORDS = /(本科|硕士|博士|大专|专科|高中|MBA|B\.?S\.?|M\.S\.?|Ph\.?D|Bachelor|Master|Doctor)/i;

  /* ---------------------------- 解析主体 ---------------------------- */

  function splitTokens(text) {
    return String(text || '')
      .split(/[\s、,，;；|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 有些词内部带空格（Google Analytics / A/B 测试），拆开后要合回去 */
  const BRAND_WORDS = /^(Google|Adobe|Microsoft|Amazon|Meta|Apple|Data|Machine|Deep|Auto|New|Sales|Table|Power)/i;

  function splitSkillTags(text) {
    // 分隔符本身（/ · 、 |）不是技能，丢掉，否则会拼出 "A / / / B"
    const tokens = splitTokens(text).filter((t) => !/^[\/·、|,，;；-]+$/.test(t));
    const merged = [];
    tokens.forEach((token) => {
      const prev = merged[merged.length - 1];
      if (prev && BRAND_WORDS.test(prev) && /^[A-Za-z]/.test(token)) {
        merged[merged.length - 1] = prev + ' ' + token;
        return;
      }
      merged.push(token);
    });
    return merged;
  }

  /** 从一行里找出联系方式 */
  function extractContact(text) {
    const rest = String(text || '').replace(/\s+/g, ' ').trim();
    const found = { email: '', phone: '', links: [], city: '' };

    const emailMatch = rest.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    if (emailMatch) found.email = emailMatch[0];

    const phoneMatch = rest.match(/(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}|\+?\d[\d\s-]{7,}\d/);
    const phoneRaw = phoneMatch ? phoneMatch[0] : '';
    if (phoneMatch) found.phone = phoneMatch[0].replace(/[^\d+]/g, '');

    // 先把邮箱从原文里挖掉，否则 "zhangzhe@email.com" 会被当成网址 "email.com"
    const withoutEmail = found.email ? rest.replace(found.email, ' ') : rest;
    const linkRe = /(?:https?:\/\/)?(?:www\.)?(?:[\w-]+\.)+(?:com|cn|net|io|me|dev|org|co|xyz|top)(?:\/[\w./#?=-]*)?/gi;
    (withoutEmail.match(linkRe) || []).forEach((link) => {
      if (found.links.indexOf(link) === -1) found.links.push(link);
    });

    const cityMatch = rest.match(/(?:北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|天津|重庆|长沙|郑州|青岛|厦门|福州|合肥|济南|大连|宁波|无锡|珠海|东莞|佛山)(?:市)?(?:[\u4e00-\u9fa5]{2,6}区)?/);
    if (cityMatch) found.city = cityMatch[0];

    // 剩下的零碎（比如"男 / 25岁"）先留着，交给"其他"模块，不丢
    let leftover = rest;
    [found.email, phoneRaw, found.city, ...found.links].forEach((piece) => {
      if (!piece) return;
      leftover = leftover.split(piece).join(' ');
    });
    leftover = leftover.replace(/\s+/g, ' ').trim();

    return { found, leftover };
  }

  function isHeading(line, bodySize, headingSize) {
    const text = line.text.replace(/[：:]\s*$/, '');
    // 命中模块名关键词，直接当标题
    if (SECTION_PATTERNS.some((p) => p.re.test(text))) return true;
    // 带日期范围的是"经历/项目条目"，不是模块标题
    if (DATE_RANGE.test(text)) return false;
    // 模块标题一般很短；长一点的多半是条目
    if (text.length > 12) return false;
    if (line.size >= headingSize - 0.1) return true;
    return line.size > bodySize + 0.6;
  }

  function sectionIdFor(title) {
    const text = String(title || '').replace(/[：:]\s*$/, '');
    const hit = SECTION_PATTERNS.find((p) => p.re.test(text));
    return hit ? hit.id : null;
  }

  /** 解析一条经历/项目的标题行：拆成名称、职位、起止时间 */
  function splitEntryTitle(text) {
    const dateMatch = text.match(DATE_RANGE);
    let head = text;
    let start = '';
    let end = '';
    if (dateMatch) {
      head = text.slice(0, dateMatch.index).trim();
      start = dateMatch[1].trim();
      end = dateMatch[2].trim();
    }

    let title = head;
    let sub = '';
    const sep = head.match(/\s+[-–—|·]\s+|\s*｜\s*|\s*\|\s*/);
    if (sep) {
      const parts = head.split(/\s+[-–—|·]\s+|\s*｜\s*|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        // 哪个是职位？按关键词判断；都不匹配就按"职位在前"（中文简历常见）
        if (ROLE_WORDS.test(parts[1]) && !ROLE_WORDS.test(parts[0])) {
          title = parts[1];
          sub = parts[0];
        } else {
          title = parts[0];
          sub = parts.slice(1).join(' · ');
        }
      }
    }
    return { title, sub, start, end };
  }

  /** 主入口：行 → 结构化简历 */
  function buildResume(rawLines) {
    const lines = mergeParagraphs(rawLines).filter((l) => l.text);
    const warnings = [];
    const bodySize = median(lines.map((l) => l.size)) || 10;
    const headingSize = Math.max(...lines.map((l) => l.size)) - 2;

    const resume = {
      title: '',
      basics: { name: '', headline: '', phone: '', email: '', city: '', link: '', summary: '' },
      experience: [],
      projects: [],
      education: [],
      skills: [],
      extras: [],
      customSections: [],
    };

    // 1. 姓名：重排之后，取"顶部若干行里字号最大的短行"，
    //    并排除模块标题（否则顺序一乱就会把「工作经历」当成姓名）
    const HEADING_WORDS =
      /^(个人简介|自我评价|个人总结|个人优势|简介|工作经历|工作经验|职业经历|实习经历|项目经历|项目经验|教育背景|教育经历|学历背景|技能|技能与特长|专业技能|技术技能|资格证书|证书|认证|语言|语言能力|荣誉|获奖|其它|其他|联系方式|个人信息)/;
    let cursor = 0;
    const topLines = lines.slice(0, 8);
    const namePool = topLines.filter(
      (l) =>
        l.text.length <= 24 &&
        !/@|\d{3,}|\//.test(l.text) &&
        !HEADING_WORDS.test(l.text.replace(/[：:]\s*$/, ''))
    );
    const maxSize = Math.max(...lines.map((l) => l.size), 0);
    const nameCandidate =
      namePool.filter((l) => l.size >= maxSize - 0.6).sort((a, b) => b.size - a.size)[0] ||
      namePool.sort((a, b) => b.size - a.size)[0] ||
      topLines[0] ||
      null;
    if (nameCandidate) {
      resume.basics.name = nameCandidate.text;
      cursor = lines.indexOf(nameCandidate) + 1;
    }

    // 2. 联系方式：姓名之后，含 @ 或手机号或网址的第一行
    for (let i = cursor; i < Math.min(lines.length, cursor + 4); i += 1) {
      const line = lines[i];
      if (!/@|1[3-9]\d|https?:|\.(com|cn|net|io)\b/i.test(line.text)) continue;
      const contact = extractContact(line.text);
      resume.basics.email = contact.found.email || resume.basics.email;
      resume.basics.phone = contact.found.phone || resume.basics.phone;
      resume.basics.city = contact.found.city || resume.basics.city;
      if (contact.found.links.length) resume.basics.link = contact.found.links.join(' · ');
      if (contact.leftover) {
        warnings.push('联系方式里有没识别的片段：' + contact.leftover);
      }
      cursor = i + 1;
      break;
    }

    // 3. 逐行归类
    let current = null; // { id, title, lines: [] }
    const sections = [];
    const pushSection = (id, title) => {
      current = { id, title, lines: [] };
      sections.push(current);
    };

    for (let i = cursor; i < lines.length; i += 1) {
      const line = lines[i];
      const text = line.text;

      // "技术技能：" 这种是模块内的小标题，不是新模块；
      // 但 "其它：" 这种真的是新模块，不能吞掉
      const headingId = sectionIdFor(text);
      const insideSkillSection = current && (current.id === 'skills' || current.id === 'certs');
      const isSubLabel =
        /[：:]\s*$/.test(text) &&
        text.length <= 12 &&
        insideSkillSection &&
        (headingId === null || headingId === current.id || /语言/.test(text));

      if (!isSubLabel && isHeading(line, bodySize, headingSize)) {
        pushSection(headingId, text);
        continue;
      }

      if (!current) {
        // 正文开始前的内容 → 当作简介
        pushSection('summary', '个人简介');
      }
      current.lines.push(line);
    }

    // 4. 按模块解析
    sections.forEach((section) => {
      const body = section.lines;
      if (section.id === 'summary') {
        const text = body.map((l) => l.text).join(' ');
        if (text) resume.basics.summary = resume.basics.summary ? resume.basics.summary + ' ' + text : text;
        return;
      }

      if (section.id === 'skills' || section.id === 'certs') {
        parseSkillsSection(section, resume);
        return;
      }

      if (section.id === 'experience' || section.id === 'projects' || section.id === 'education') {
        parseEntrySection(section, resume);
        return;
      }

      // 其他（语言、荣誉、兴趣…）：整段放进自定义模块，文字原样
      const text = body.map((l) => l.text).filter(Boolean).join('\n');
      if (!text) return;
      resume.customSections.push({
        title: section.title.replace(/[：:]\s*$/, ''),
        labels: null,
        items: [{ name: '', role: '', start: '', end: '', desc: text }],
      });
    });

    resume.title = resume.basics.name ? resume.basics.name + ' 的简历' : '导入的简历';
    return { resume, warnings, sections };
  }

  /** 技能 / 证书段：按"小标题："分组，其余按标签拆 */
  function parseSkillsSection(section, resume) {
    // 证书：每一行原样保留（不拆词，避免把证书名字弄碎）
    if (section.id === 'certs') {
      section.lines.forEach((line) => {
        const text = line.text.trim();
        if (text) resume.extras.push({ label: '', value: text });
      });
      return;
    }

    let subLabel = '';
    const buckets = [];

    section.lines.forEach((line) => {
      const text = line.text;
      const sub = text.match(/^(.{1,12})[:：]\s*(.*)$/);
      if (sub) {
        subLabel = sub[1];
        const rest = sub[2].trim();
        buckets.push({ label: subLabel, items: rest ? splitSkillTags(rest) : [], raw: rest });
        return;
      }
      if (!buckets.length) buckets.push({ label: subLabel, items: [], raw: '' });
      const bucket = buckets[buckets.length - 1];
      splitSkillTags(text).forEach((token) => bucket.items.push(token));
      bucket.raw = (bucket.raw ? bucket.raw + ' ' : '') + text;
    });

    // 技能最后合并成"一整行"：技能 A / B / C
    const tokens = [];
    buckets.forEach((bucket) => {
      const isLang = /语言/.test(bucket.label);
      if (isLang) {
        // 语言这一行原样保留（里面的逗号、顿号是用户原文）
        resume.extras.push({ label: '语言', value: (bucket.raw || bucket.items.join(' · ')).trim() });
        return;
      }
      bucket.items.forEach((item) => {
        if (tokens.indexOf(item) === -1) tokens.push(item);
      });
    });
    if (tokens.length) {
      resume.skills = [{ label: '技能', value: tokens.join(' / ') }];
    }
  }

  /** 经历 / 项目 / 教育段：按"带日期范围的行"切条目 */
  function parseEntrySection(section, resume) {
    const entries = [];
    let current = null;
    let bulletX = null;

    section.lines.forEach((line) => {
      const isDateEntry = DATE_RANGE.test(line.text) && line.size >= median(section.lines.map((l) => l.size)) - 0.6;
      if (isDateEntry) {
        current = { head: line.text, lines: [] };
        entries.push(current);
        return;
      }
      if (!current) {
        // 第一条没有日期：也当成一个条目，避免丢内容
        current = { head: line.text, lines: [] };
        entries.push(current);
        bulletX = line.x;
        return;
      }
      if (bulletX === null) bulletX = line.x;
      current.lines.push(line);
    });

    entries.forEach((entry) => {
      const info = splitEntryTitle(entry.head);
      // 条目下的第一行如果是地点（短、无标点），单独拿出来
      let extraLines = entry.lines.slice();
      let place = '';
      if (extraLines.length && extraLines[0].text.length <= 8 && !/[。，,；;]/.test(extraLines[0].text)) {
        place = extraLines[0].text;
        extraLines = extraLines.slice(1);
      }
      const desc = extraLines.map((l) => l.text).join('<br>');

      if (section.id === 'education') {
        // 先把日期范围从标题里去掉，否则会混进"学历/专业"里重复一遍
        const headNoDate = entry.head.replace(DATE_RANGE, ' ').replace(/\s+/g, ' ').trim();
        const parts = headNoDate.split(/\s*[|｜]\s*|\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
        const school = parts[0] || info.title;
        const degreeParts = parts.slice(1).filter((p) => !/^\d{4}/.test(p));
        resume.education.push({
          school: school,
          degree: degreeParts.join(' · ') || info.sub || '',
          start: info.start,
          end: info.end,
          desc: extraLines.map((l) => l.text).join('<br>'),
        });
        return;
      }

      if (section.id === 'projects') {
        resume.projects.push({
          name: info.title,
          role: info.sub,
          start: info.start,
          end: info.end,
          desc: desc,
        });
        return;
      }

      // 工作经历：中文常见"职位 - 公司"，英文常见"公司 - 职位"，都试一遍
      let company = info.sub;
      let role = info.title;
      if (ROLE_WORDS.test(info.sub) && !ROLE_WORDS.test(info.title)) {
        company = info.title;
        role = info.sub;
      }
      if (!company && !role) {
        company = entry.head;
      }
      resume.experience.push({
        company: company + (place ? '（' + place + '）' : ''),
        role: role,
        start: info.start,
        end: info.end,
        desc: desc,
      });
    });
  }

  RS.pdfImport = {
    loadPdfjs,
    extractLines,
    buildResume,

    /** pdf.js 是否已经就绪（没就绪说明首次导入要先下载解析组件） */
    isReady() {
      return !!window.pdfjsLib;
    },

    /**
     * 后台预取 pdf.js（约 1.5MB，GitHub Pages 上首次要几十秒）。
     * 在用户打开导入弹窗时就先下，等他选完文件多半已经好了。
     */
    async prefetch() {
      try {
        await loadPdfjs();
        // 顺便把 worker 也拉进缓存，真正解析时不用再等
        await fetch(PDFJS_WORKER, { cache: 'force-cache' }).catch(() => {});
        return true;
      } catch (err) {
        console.warn('[pdf] 解析组件预取失败，导入时会重试', err);
        return false;
      }
    },
    /** 完整流程：ArrayBuffer → { resume, warnings, lines, numPages } */
    async parse(buffer) {
      const { lines, numPages } = await extractLines(buffer);
      if (!lines.length) {
        throw new Error('这份 PDF 提取不到文字（可能是扫描件，或字体没有嵌入），暂时无法导入');
      }
      const result = buildResume(lines);
      const allText = lines.map((l) => l.text).join('\n');
      if (hasBrokenGlyphs(allText)) {
        result.warnings.unshift('这份 PDF 的字体编码不完整，个别字可能显示异常，导入后请检查一遍');
      }
      return {
        resume: result.resume,
        warnings: result.warnings,
        lines: lines.map((l) => l.text),
        numPages: numPages,
        sections: result.sections.map((s) => ({ id: s.id, title: s.title, count: s.lines.length })),
      };
    },
  };
})();
