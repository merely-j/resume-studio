/**
 * 导出 PDF：把预览里的排版"转录"成真正的 PDF 文字
 * ------------------------------------------------------------
 * 为什么不直接 window.print()：
 *   打印会弹出打印对话框，用户还得手动选"另存为 PDF"。
 *   这里由我们自己生成 PDF 字节，点一下就下载。
 *
 * 为什么不截图转 PDF：
 *   简历要过 ATS（招聘系统自动解析），图片 PDF 解析不到文字。
 *   所以这里读 DOM 里每一行的文字和坐标，再画成真文字。
 *
 * 字体：PDF 必须内嵌中文字体，否则别人打开是乱码。
 *   用的是 Noto Sans SC（OFL 开源），已按 GB2312 子集化，约 2.3MB，
 *   首次导出时才下载，之后走浏览器缓存。用 jsPDF 的 putOnlyUsedFonts
 *   把用到的字形再筛一遍，导出的 PDF 只有一两百 KB。
 */

(function () {
  'use strict';

  const RS = (window.RS = window.RS || {});

  /* A4 尺寸（pt）。1 CSS px = 0.75pt（96dpi） */
  const PAGE_W = 595.276;
  const PAGE_H = 841.89;
  const PX = 0.75;
  const MM_PER_PAGE = 297;
  const PX_PER_MM = 96 / 25.4;

  const ASCENT = 0.88; // 基线在行高内的位置，按 Noto Sans SC 调的
  const FONT_FILES = {
    regular: './vendor/fonts/NotoSansSC-Regular.ttf',
  };

  const cache = { regular: null };

  /* ---------------------------- 资源加载 ---------------------------- */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('加载失败：' + src));
      document.head.appendChild(script);
    });
  }

  async function ensureLibs() {
    if (!window.jspdf) await loadScript('./vendor/pdflib/jspdf.umd.min.js');
    if (!window.jspdf) throw new Error('PDF 组件加载失败');
  }

  function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function loadFont(kind) {
    if (cache[kind]) return cache[kind];
    const res = await fetch(FONT_FILES[kind]);
    if (!res.ok) throw new Error('字体下载失败（' + res.status + '）');
    cache[kind] = toBase64(new Uint8Array(await res.arrayBuffer()));
    return cache[kind];
  }

  /* ---------------------------- 颜色 ---------------------------- */

  function parseColor(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (text === 'transparent' || text === 'none') return null;
    let m = text.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (parts.length >= 3) {
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (alpha === 0) return null;
        return { r: parts[0], g: parts[1], b: parts[2] };
      }
    }
    m = text.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    return null;
  }

  /* ---------------------------- 采集：文字 ---------------------------- */

  /**
   * 每个文本节点逐字测量，按视觉行合并成一条"绘制记录"。
   * 逐字测的好处：换行发生在哪里、justify/居中/右对齐后的真实位置都能还原。
   */
  function collectText(paper, paperRect, scale) {
    const runs = [];
    const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT, null);
    const range = document.createRange();

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = node.nodeValue;
      if (!value || !value.trim()) continue;

      const el = node.parentElement;
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (parseFloat(cs.opacity) === 0) continue;

      const lines = [];
      let current = null;
      for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        const r = rects[0];
        if (!current || Math.abs(current.top - r.top) > 1.5) {
          current = { text: ch, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
          lines.push(current);
        } else {
          current.text += ch;
          current.left = Math.min(current.left, r.left);
          current.right = Math.max(current.right, r.right);
          current.bottom = Math.max(current.bottom, r.bottom);
        }
      }

      lines.forEach((line) => {
        const text = line.text.replace(/\s+/g, ' ').trim();
        if (!text) return;
        runs.push({
          text: text,
          x: (line.left - paperRect.left) / scale,
          right: (line.right - paperRect.left) / scale,
          top: (line.top - paperRect.top) / scale,
          bottom: (line.bottom - paperRect.top) / scale,
          fontSize: parseFloat(cs.fontSize) || 10,
          lineHeight: parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 10) * 1.6,
          bold: parseInt(cs.fontWeight, 10) >= 600,
          color: parseColor(cs.color) || { r: 0, g: 0, b: 0 },
          underline: String(cs.textDecorationLine || '').indexOf('underline') !== -1,
        });
      });
    }

    // 列表符号（::marker 不在文本节点里，单独补）
    paper.querySelectorAll('.r-bullets > li').forEach((li) => {
      const text = li.textContent.trim();
      if (!text) return;
      const liRect = li.getBoundingClientRect();
      const cs = getComputedStyle(li);
      const fontSize = parseFloat(cs.fontSize) || 10;
      runs.push({
        text: '•',
        x: (liRect.left - paperRect.left) / scale - fontSize * 0.72,
        right: 0,
        top: (liRect.top - paperRect.top) / scale,
        bottom: 0,
        fontSize: fontSize * 0.95,
        lineHeight: parseFloat(cs.lineHeight) || fontSize * 1.6,
        bold: false,
        color: { r: 0, g: 0, b: 0 },
        underline: false,
        isBullet: true,
      });
    });

    return runs;
  }

  /* ---------------------------- 采集：线框和背景 ---------------------------- */

  function collectBoxes(paper, paperRect, scale) {
    const boxes = [];
    const all = paper.querySelectorAll('*');

    all.forEach((el) => {
      if (el.tagName === 'IMG') return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;

      const x = (r.left - paperRect.left) / scale;
      const y = (r.top - paperRect.top) / scale;
      const w = r.width / scale;
      const h = r.height / scale;
      if (x < -1 || y < -1 || w <= 0 || h <= 0) return;

      const bg = parseColor(cs.backgroundColor);
      if (bg) boxes.push({ type: 'fill', x, y, w, h, color: bg });

      ['Top', 'Right', 'Bottom', 'Left'].forEach((side) => {
        const width = parseFloat(cs['border' + side + 'Width']) || 0;
        if (width <= 0) return;
        const color = parseColor(cs['border' + side + 'Color']);
        if (!color) return;
        const style = cs['border' + side + 'Style'];
        if (style === 'none' || style === 'hidden') return;
        boxes.push({ type: 'line', side, x, y, w, h, width, color });
      });
    });
    return boxes;
  }

  /* ---------------------------- 生成 PDF ---------------------------- */

  async function createPdf(paper) {
    const stage = (name) => {
      window.__exportStage = name;
    };
    stage('libs');
    await ensureLibs();
    const { jsPDF } = window.jspdf;

    const paperRect = paper.getBoundingClientRect();
    if (!paper.offsetWidth || !paperRect.width) {
      throw new Error('预览没有被渲染（可能在编辑页），无法导出');
    }
    const scale = paperRect.width / (paper.offsetWidth || paperRect.width) || 1;
    const totalMm = paper.offsetHeight / PX_PER_MM;
    const pageCount = Math.max(1, Math.ceil((totalMm - 1) / MM_PER_PAGE));

    stage('collect-text');
    const runs = collectText(paper, paperRect, scale);
    stage('collect-boxes');
    const boxes = collectBoxes(paper, paperRect, scale);
    if (typeof window !== 'undefined') {
      window.__pdfExportStats = { runs: runs.length, boxes: boxes.length, pages: pageCount, scale: scale };
    }

    const doc = new jsPDF({
      unit: 'pt',
      format: [PAGE_W, PAGE_H],
      orientation: 'portrait',
      compress: true,
      putOnlyUsedFonts: true,
    });

    const regular = await loadFont('regular');
    stage('fonts');
    doc.addFileToVFS('NotoSansSC-Regular.ttf', regular);
    doc.addFont('NotoSansSC-Regular.ttf', 'NotoSC', 'normal');
    // 粗体不另下 2.4MB 的粗体字体（GitHub Pages 上太慢），
    // 用"同一段文字画两遍、错开一丝"来模拟
    doc.addFont('NotoSansSC-Regular.ttf', 'NotoSC', 'bold');

    for (let i = 1; i < pageCount; i += 1) doc.addPage([PAGE_W, PAGE_H]);

    const toPt = (value) => value * PX;

    stage('draw-boxes');
    /* 背景 + 线框 */
    boxes.forEach((box) => {
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        doc.setPage(pageIndex + 1);
        const baseY = pageIndex * PAGE_H;
        const top = toPt(box.y) - baseY;
        const bottom = toPt(box.y + box.h) - baseY;
        if (bottom < -1 || top > PAGE_H + 1) continue;

        if (box.type === 'fill') {
          doc.setFillColor(box.color.r, box.color.g, box.color.b);
          const yTop = Math.max(top, 0);
          const yBottom = Math.min(bottom, PAGE_H);
          doc.rect(toPt(box.x), yTop, toPt(box.w), yBottom - yTop, 'F');
          continue;
        }

        doc.setDrawColor(box.color.r, box.color.g, box.color.b);
        doc.setLineWidth(Math.max(0.5, toPt(box.width)));
        const left = toPt(box.x);
        const right = toPt(box.x + box.w);
        if (box.side === 'Bottom') doc.line(left, bottom, right, bottom);
        else if (box.side === 'Top') doc.line(left, top, right, top);
        else if (box.side === 'Left') doc.line(left, bottom, left, top);
        else doc.line(right, bottom, right, top);
      }
    });

    stage('draw-text');
    /* 文字 */
    runs.forEach((run) => {
      const size = toPt(run.fontSize);
      const baseline = toPt(run.top + (run.lineHeight - run.fontSize) / 2 + run.fontSize * ASCENT);

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const y = baseline - pageIndex * PAGE_H;
        if (y < -20 || y > PAGE_H + 20) continue;
        doc.setPage(pageIndex + 1);
        doc.setFont('NotoSC', 'normal');
        doc.setFontSize(size);
        doc.setTextColor(run.color.r, run.color.g, run.color.b);
        if (run.bold) {
          // 用"描边 + 填充"模拟粗体：只画一遍，文字不会被复制成两份
          doc.setDrawColor(run.color.r, run.color.g, run.color.b);
          doc.setLineWidth(Math.max(0.14, size * 0.018));
          doc.text(run.text, toPt(run.x), y, {
            baseline: 'alphabetic',
            renderingMode: 'fillThenStroke',
          });
        } else {
          doc.text(run.text, toPt(run.x), y, { baseline: 'alphabetic' });
        }
        if (run.underline) {
          doc.setDrawColor(run.color.r, run.color.g, run.color.b);
          doc.setLineWidth(Math.max(0.4, size * 0.05));
          doc.line(toPt(run.x), y + size * 0.12, toPt(run.right), y + size * 0.12);
        }
      }
    });

    /* 照片 */
    const img = paper.querySelector('.r-photo');
    if (img && img.src) {
      try {
        stage('image');
        const r = img.getBoundingClientRect();
        const x = (r.left - paperRect.left) / scale;
        const y = (r.top - paperRect.top) / scale;
        const w = r.width / scale;
        const h = r.height / scale;
        const format = img.src.indexOf('image/png') !== -1 ? 'PNG' : 'JPEG';
        doc.setPage(1);
        doc.addImage(img.src, format, toPt(x), toPt(y), toPt(w), toPt(h), undefined, 'FAST');
      } catch (err) {
        console.warn('[pdf] 照片绘制失败（不影响其他内容）', err);
      }
    }

    stage('done');
    return doc;
  }

  /* ---------------------------- 对外接口 ---------------------------- */

  RS.pdfExport = {
    /** 字体是否已经就绪（没就绪说明首次导出要先下载） */
    isReady() {
      return !!cache.regular;
    },

    /** 后台预取字体：用户编辑时就先下好，点导出时不用等 */
    async prefetch() {
      try {
        await loadFont('regular');
        return true;
      } catch (err) {
        console.warn('[pdf] 字体预取失败，导出时会重试', err);
        return false;
      }
    },

    /** 生成 PDF 并直接触发下载 */
    async download(paper, fileName) {
      const doc = await createPdf(paper);
      const blob = doc.output('blob');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || '简历.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return blob.size;
    },

    /** 只生成 Blob，测试用 */
    async toBlob(paper) {
      const doc = await createPdf(paper);
      return doc.output('blob');
    },
  };
})();
