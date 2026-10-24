/**
 * 发布到 GitHub：取授权 → 建仓库 → 提交 → 推送
 * ------------------------------------------------------------
 * 用 Node 而不是 PowerShell：中文描述不会被 5.1 的 ANSI 编码搞乱，
 * 而且 git 和 fetch 都能直接用。
 *
 * 用法：node tools/publish-github.mjs [仓库名]
 * 交互：只会弹一次浏览器登录（Git Credential Manager），不接触你的密码。
 */

import { execFileSync } from 'node:child_process';

const GIT = 'D:\\Git\\cmd\\git.exe';
const REPO_PATH = 'D:\\ds_workspace\\resume-app';
const repoName = process.argv[2] || 'resume-studio';
const description = '手机上填写、排版并导出 A4 PDF 的简历工具，纯前端零依赖';

const run = (args, options = {}) =>
  execFileSync(GIT, args, { encoding: 'utf8', ...options });

console.log('[1/5] 请求 GitHub 授权……（浏览器会弹出登录页）');
const credential = run(['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
});

const user = /^username=(.+)$/m.exec(credential)?.[1]?.trim();
const token = /^password=(.+)$/m.exec(credential)?.[1]?.trim();
if (!user || !token) {
  console.error('没有拿到 GitHub 凭据（可能取消了登录）');
  process.exit(1);
}
console.log(`      已登录：${user}`);

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'resume-app-publisher',
  'X-GitHub-Api-Version': '2022-11-28',
};

console.log(`[2/5] 检查仓库 ${user}/${repoName} ……`);
const repoRes = await fetch(`https://api.github.com/repos/${user}/${repoName}`, { headers });

if (repoRes.ok) {
  const repo = await repoRes.json();
  console.log(`      已存在：${repo.html_url}`);
} else if (repoRes.status === 404) {
  const createRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: repoName,
      description,
      private: false,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    }),
  });
  if (!createRes.ok) {
    console.error('创建仓库失败：', createRes.status, await createRes.text());
    process.exit(1);
  }
  const created = await createRes.json();
  console.log(`      已创建：${created.html_url}`);
} else {
  console.error('查询仓库失败：', repoRes.status, await repoRes.text());
  process.exit(1);
}

console.log('[3/5] 配置提交身份并提交……');
run(['-C', REPO_PATH, 'config', 'user.name', user]);
run(['-C', REPO_PATH, 'config', 'user.email', `${user}@users.noreply.github.com`]);
run(['-C', REPO_PATH, 'add', '-A']);

const status = run(['-C', REPO_PATH, 'status', '--porcelain']).trim();
if (status) {
  run(['-C', REPO_PATH, 'commit', '-m', '初始化：简历工坊'], { stdio: 'inherit' });
  console.log('      已提交');
} else {
  console.log('      没有新的改动需要提交');
}

console.log('[4/5] 设置远程仓库……');
try {
  run(['-C', REPO_PATH, 'remote', 'remove', 'origin']);
} catch {
  /* 没有 origin 就算了 */
}
run(['-C', REPO_PATH, 'remote', 'add', 'origin', `https://github.com/${user}/${repoName}.git`]);
console.log(`      origin = https://github.com/${user}/${repoName}.git`);

console.log('[5/5] 推送……');
run(['-C', REPO_PATH, 'push', '-u', 'origin', 'main'], { stdio: 'inherit' });

console.log('');
console.log(`完成：https://github.com/${user}/${repoName}`);
console.log('下一步：仓库 Settings → Pages → Source 选 GitHub Actions，即可自动发布网页');
