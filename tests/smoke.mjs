/**
 * 冒烟测试：不打开浏览器，直接验证"数据 -> HTML"这一层
 * 运行：node tests/smoke.mjs
 *
 * 因为源码改成了普通脚本（挂到 window.RS 上，不再用 ES Module），
 * 这里用 Node 的 vm 造一个最小的 window 环境把文件跑起来，
 * 既能测纯函数，又不需要浏览器。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sandbox = {
  console,
  localStorage: {
    _data: new Map(),
    getItem(key) {
      return this._data.has(key) ? this._data.get(key) : null;
    },
    setItem(key, value) {
      this._data.set(key, String(value));
    },
    removeItem(key) {
      this._data.delete(key);
    },
  },
};
sandbox.window = sandbox; // 让脚本里的 window.RS 就是沙箱本身
vm.createContext(sandbox);

for (const file of ['model.js', 'store.js', 'preview.js']) {
  const code = await readFile(new URL(`../js/${file}`, import.meta.url), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const RS = sandbox.RS;
const {
  emptyResume,
  sampleResume,
  formatRange,
  formatBirthday,
  toBullets,
  renderResume,
  exportJson,
  importJson,
  richText,
  richToBullets,
  normalizeSectionOrder,
  normalizeFontSize,
  sectionTitle,
  formatPhone,
  emptyCustomSection,
  emptyCustomItem,
} = RS;

const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, message: err.message });
  }
}

const sample = sampleResume();

// 防回归：一旦有人把 import/export 加回来，沙箱 iframe 里又会白屏
{
  const offenders = [];
  for (const file of ['model.js', 'store.js', 'preview.js', 'editor.js', 'app.js']) {
    const code = await readFile(new URL(`../js/${file}`, import.meta.url), 'utf8');
    if (/^\s*(import|export)\s/m.test(code)) offenders.push(file);
  }
  checks.push({
    name: '源码不再使用 ES Module 语法',
    ok: offenders.length === 0,
    message: offenders.length ? offenders.join(', ') + ' 里还有 import/export' : '',
  });
}

check('三套模板都能渲染且包含关键内容', () => {
  for (const template of ['classic', 'modern', 'minimal']) {
    const html = renderResume({ ...sample, template });
    assert.match(html, /陈晓/, `${template} 缺少姓名`);
    assert.match(html, /工作经历/, `${template} 缺少工作经历`);
    assert.match(html, /浙江大学/, `${template} 缺少教育经历`);
  }
});

check('渲染结果里不出现 undefined / null 字样', () => {
  for (const template of ['classic', 'modern', 'minimal']) {
    const html = renderResume({ ...sample, template });
    assert.ok(!html.includes('undefined'), `${template} 渲染出 undefined`);
    assert.ok(!html.includes('null'), `${template} 渲染出 null`);
  }
});

check('用户输入被转义，不会注入标签', () => {
  const evil = sampleResume();
  evil.basics.name = '<img src=x onerror=alert(1)>';
  evil.basics.summary = '"><script>alert(2)</script>';
  evil.experience[0].desc = '<b>加粗</b>';
  const html = renderResume(evil);
  assert.ok(!/<script/i.test(html), 'script 标签没有被转义');
  assert.ok(!/<img/i.test(html), 'img 标签没有被转义');
  assert.ok(html.includes('&lt;img'), '应当出现转义后的文本');
});

check('空简历不会渲染出空标题块', () => {
  const blank = emptyResume('空白简历');
  const html = renderResume(blank);
  assert.ok(!html.includes('工作经历'), '空简历不应出现工作经历标题');
  assert.ok(!html.includes('教育经历'), '空简历不应出现教育经历标题');
  assert.ok(!html.includes('你的姓名'), '没填姓名时不应出现占位姓名');
  assert.ok(!html.includes('r-name'), '没填姓名时不该渲染姓名标签');
  assert.ok(!html.includes('r-personal'), '没有个人信息时不该渲染那一行');
});

check('个人信息只渲染填了的部分，且不多出分隔符', () => {
  const resume = sampleResume();
  resume.basics.ethnicity = ''; // 清空民族
  const html = renderResume(resume);
  assert.ok(html.includes('r-personal'), '有值时应渲染个人信息行');
  assert.ok(!html.includes('汉族'), '清空的民族不应出现');

  const line = html.match(/<p class="r-personal">([\s\S]*?)<\/p>/)[1];
  const dots = (line.match(/r-dot/g) || []).length;
  const filled = [
    resume.basics.gender,
    resume.basics.ethnicity,
    resume.basics.birthday,
    resume.basics.hometown,
    resume.basics.politics,
  ].filter(Boolean).length;
  assert.equal(dots, filled - 1, '分隔符数量应等于有值项数减一');
});

check('缺少字段的旧数据也能渲染', () => {
  const partial = { basics: { name: '张三' }, template: 'classic' };
  const html = renderResume(partial);
  assert.match(html, /张三/);
  assert.ok(!html.includes('undefined'));
});

check('生日统一显示成横杠形式', () => {
  assert.equal(formatBirthday('1995.08'), '1995-08');
  assert.equal(formatBirthday('1995/8'), '1995-08');
  assert.equal(formatBirthday('1995年8月'), '1995-08');
  assert.equal(formatBirthday('1995-08-12'), '1995-08-12');
  assert.equal(formatBirthday('1995'), '1995');
  assert.equal(formatBirthday(''), '');
  assert.equal(formatBirthday('保密'), '保密', '认不出来的写法原样保留');
});

check('联系方式和个人信息的上下顺序可以调换', () => {
  const resume = sampleResume();
  resume.basics.blockOrder = ['contact', 'personal'];
  const first = renderResume(resume);
  assert.ok(
    first.indexOf('r-contact') < first.indexOf('r-personal'),
    '默认应先渲染联系方式'
  );

  resume.basics.blockOrder = ['personal', 'contact'];
  const swapped = renderResume(resume);
  assert.ok(
    swapped.indexOf('r-personal') < swapped.indexOf('r-contact'),
    '调换后个人信息应在前面'
  );
});

check('富文本只保留白名单标签，脚本仍被转义', () => {
  assert.equal(richText('<b>粗</b>'), '<b>粗</b>');
  assert.equal(richText('<strong>粗</strong>'), '<b>粗</b>', 'strong 归一化成 b');
  assert.equal(richText('<em>斜</em>'), '<i>斜</i>', 'em 归一化成 i');
  assert.equal(richText('<b class="x" style="color:red">粗</b>'), '<b>粗</b>', '属性被丢掉');

  const evil = richText('<script>alert(1)</script><img src=x onerror=alert(2)>');
  assert.ok(!/<script/i.test(evil), 'script 标签必须被转义');
  assert.ok(!/<img/i.test(evil), 'img 标签必须被转义');
  assert.ok(evil.includes('&lt;script'), '应留下可见的转义文本');
});

check('富文本要点按 <br> 或换行拆行，并保留行内格式', () => {
  const lines = richToBullets('<b>第一条</b><br>第二条\n- 第三条<br><br>');
  assert.equal(lines.length, 3, '空行应被丢掉');
  assert.equal(lines[0], '<b>第一条</b>');
  assert.equal(lines[1], '第二条');
  assert.equal(lines[2], '第三条', '行首的项目符号要去掉');
  assert.equal(richToBullets('').length, 0);
});

check('个人简介里的加粗能渲染出来', () => {
  const resume = sampleResume();
  resume.basics.summary = '我做<b>企业服务</b>产品。';
  const html = renderResume(resume);
  assert.ok(html.includes('<b>企业服务</b>'), '预览里应保留加粗标签');
});

check('大模块顺序可以自由调整', () => {
  const resume = sampleResume();
  const before = renderResume(resume);
  assert.ok(before.indexOf('工作经历') < before.indexOf('教育经历'), '默认工作经历在教育经历前');

  resume.sectionOrder = ['summary', 'education', 'experience', 'projects', 'skills'];
  const after = renderResume(resume);
  assert.ok(after.indexOf('教育经历') < after.indexOf('工作经历'), '调换后教育经历应在前面');
});

check('旧数据的顺序数组会自动补全', () => {
  const order = normalizeSectionOrder({ sectionOrder: ['skills'] });
  assert.equal(order.length, 5, '应补齐到 5 个固定模块');
  assert.equal(order[0], 'skills', '用户排过的顺序要保留');
  assert.ok(order.indexOf('experience') !== -1, '缺失的模块要补进来');
});

check('技能和证书合成一个模块', () => {
  const resume = sampleResume();
  const html = renderResume(resume);
  assert.ok(html.includes('技能与证书'), '应只有一个合并后的模块标题');
  assert.ok(!html.includes('证书与其他'), '旧的独立模块标题不该再出现');
  // 一个模块里先技能、后证书
  const sectionStart = html.indexOf('技能与证书');
  assert.ok(html.indexOf('Axure', sectionStart) > sectionStart, '技能应在这个模块里');
  assert.ok(html.indexOf('PMP', sectionStart) > sectionStart, '证书也应在这个模块里');
});

check('自定义模块能渲染，字段名可改', () => {
  const resume = sampleResume();
  const custom = emptyCustomSection('获奖经历');
  custom.labels.name = '奖项名称';
  custom.labels.role = '颁发机构';
  custom.items.push(
    Object.assign(emptyCustomItem(), {
      name: '产品设计大赛',
      role: '华东赛区组委会',
      start: '2019.05',
      end: '2019.06',
      desc: '二等奖',
    })
  );
  resume.customSections = [custom];
  resume.sectionOrder = normalizeSectionOrder(resume);

  const html = renderResume(resume);
  assert.ok(html.includes('获奖经历'), '应渲染自定义模块标题');
  assert.ok(html.includes('产品设计大赛'), '应渲染条目名称');
  assert.ok(html.includes('华东赛区组委会'), '应渲染角色');
  assert.ok(html.includes('2019.05 – 2019.06'), '应渲染时间区间');
  assert.ok(html.includes('二等奖'), '应渲染内容');

  // 字段名只在编辑器里显示，简历里用的是用户定义的模块名和条目值
  assert.ok(!html.includes('奖项名称'), '简历正文不该出现字段名');
});

check('字号支持 pt 数字，并兼容旧的倍率写法', () => {
  assert.equal(normalizeFontSize(12), 12);
  assert.equal(normalizeFontSize('11.5'), 11.5);
  assert.equal(normalizeFontSize(200), 14, '超过上限要夹住');
  assert.equal(normalizeFontSize(1), 8, '低于下限要夹住');
  assert.equal(normalizeFontSize(undefined, 1.16), 12.2, '旧倍率换算成 pt');
  assert.equal(normalizeFontSize(undefined), 10.5, '默认 10.5pt');
});

check('自定义模块删除后会从顺序里消失', () => {
  const resume = sampleResume();
  resume.customSections = [emptyCustomSection('临时模块')];
  resume.sectionOrder = normalizeSectionOrder(resume);
  assert.equal(resume.sectionOrder.length, 6);
  resume.customSections = [];
  assert.equal(normalizeSectionOrder(resume).length, 5, '模块删掉后顺序里也不该留着');
});

check('手机号显示成纯数字', () => {
  assert.equal(formatPhone('138-0000-0000'), '13800000000');
  assert.equal(formatPhone('138 0000 0000'), '13800000000');
  assert.equal(formatPhone('(138)00000000'), '13800000000');
  assert.equal(formatPhone('+86 138-0000-0000'), '+8613800000000');
  assert.equal(formatPhone(''), '');

  const resume = sampleResume();
  resume.basics.phone = '138-0000-0000';
  const html = renderResume(resume);
  assert.ok(html.includes('13800000000'), '简历里应显示纯数字手机号');
  assert.ok(!html.includes('138-0000-0000'), '不应保留带横线的写法');
});

check('模块标题可以自定义，留空回退默认名', () => {
  const resume = sampleResume();
  assert.ok(renderResume(resume).includes('工作经历'), '默认用内置标题');

  resume.sectionTitles = { experience: '职业经历', skills: '技能证书' };
  const html = renderResume(resume);
  assert.ok(html.includes('职业经历'), '应渲染自定义标题');
  assert.ok(!html.includes('工作经历'), '自定义后不该再出现默认标题');
  assert.ok(html.includes('技能证书'), '技能模块也能改名');

  assert.equal(sectionTitle({ sectionTitles: { experience: '   ' } }, 'experience'), '工作经历');
  assert.equal(sectionTitle({}, 'education'), '教育经历');
});

check('压缩到一页是默认关闭的独立开关', () => {
  assert.equal(sampleResume().fitOnePage, false, '默认不压缩');
  assert.equal(sampleResume().sectionGap, 13, '模块间距默认 13px');
});

check('时间区间格式化', () => {
  assert.equal(formatRange('2020.07', '2022.02'), '2020.07 – 2022.02');
  assert.equal(formatRange('2022.03', '至今'), '2022.03 – 至今');
  assert.equal(formatRange('', '至今'), '至今');
  assert.equal(formatRange('', ''), '');
});

check('多行文本按行拆成要点并去掉项目符号', () => {
  // 注意：vm 里创建的数组和外面的数组原型不同，deepEqual 会判不等，所以比字符串
  assert.equal(toBullets('负责 A\n- 主导 B\n• 结果 C').join('|'), '负责 A|主导 B|结果 C');
  assert.equal(toBullets('').length, 0);
});

check('有照片时渲染图片，没照片时不渲染空 img', () => {
  const withPhoto = sampleResume();
  withPhoto.basics.photo = 'data:image/jpeg;base64,AAAA';
  for (const template of ['classic', 'modern', 'minimal']) {
    const html = renderResume({ ...withPhoto, template });
    assert.ok(html.includes('r-photo'), `${template} 没有渲染照片`);
  }
  const plain = renderResume(sampleResume());
  assert.ok(!plain.includes('r-photo'), '没有照片时不该出现 img');
});

check('JSON 导出后能原样导入', () => {
  const json = exportJson(sample);
  const restored = importJson(json);
  assert.equal(restored.basics.name, '陈晓');
  assert.equal(restored.experience.length, sample.experience.length);
  assert.equal(restored.experience[0].company, sample.experience[0].company);
});

check('英文稿不残留任何中文', () => {
  const resume = sampleResume();
  // 完全不翻译时：纸面上不应该出现一个汉字
  const enHtml = renderResume(RS.localizedResume(resume, 'en'));
  const text = enHtml.replace(/<[^>]*>/g, '');
  assert.ok(!/[\u4e00-\u9fa5]/.test(text), '英文稿里出现了中文：' + text.slice(0, 80));
});

check('英文内容填全后，模块结构与中文一致', () => {
  const resume = sampleResume();
  const en = RS.syncEnglish(resume);
  en.basics.name = 'Xiao Chen';
  en.basics.headline = 'Senior Product Manager';
  en.basics.summary = 'Product manager with 3 years in B2B SaaS.';
  en.basics.gender = 'Male';
  en.basics.ethnicity = 'Han Chinese';
  en.basics.birthday = '1995-08';
  en.basics.hometown = 'Hangzhou';
  en.basics.politics = 'CPC member';
  en.experience.forEach((item) => {
    item.company = 'Acme Tech';
    item.role = 'Product Manager';
    item.desc = 'Owned the collaboration suite';
  });
  en.projects.forEach((item) => {
    item.name = 'Permissions Center';
    item.role = 'Product Lead';
    item.desc = 'Designed the role model';
  });
  en.education.forEach((item) => {
    item.school = 'Zhejiang University';
    item.degree = 'B.S. in Information Management';
    item.desc = 'GPA 3.7/4.0';
  });
  en.skills = ['Figma', 'SQL'];
  en.extras = [{ id: 'e1', label: 'Certificate', value: 'PMP (2023)' }];

  const count = (html, needle) => (html.match(new RegExp(needle, 'g')) || []).length;
  const zhHtml = renderResume(resume);
  const enHtml = renderResume(RS.localizedResume(resume, 'en'));
  assert.equal(count(enHtml, 'class="r-section"'), count(zhHtml, 'class="r-section"'), '模块数不一致');
  assert.equal(count(enHtml, 'class="r-entry"'), count(zhHtml, 'class="r-entry"'), '条目数不一致');
  assert.ok(!/[\u4e00-\u9fa5]/.test(enHtml.replace(/<[^>]*>/g, '')), '英文稿里出现了中文');
});

check('导入非法文件会给出明确错误', () => {
  assert.throws(() => importJson('{"foo":1}'), /缺少简历内容/);
});

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n      ${c.message}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
