/**
 * 腾讯云 CloudBase 静态托管部署辅助脚本
 *
 * 用法：
 *   node tools/deploy-cloudbase.mjs <环境ID>
 *   node tools/deploy-cloudbase.mjs            # 只整理出 dist/，不部署
 *
 * 为什么需要它：项目根目录还放着 tools/、answers/ 等与站点无关的内容，
 * 直接整目录上传会把它们一起发到线上。这个脚本先复制出一份干净的 dist/，
 * 再调用 CloudBase CLI 部署。
 *
 * 前置条件：
 *   npm i -g @cloudbase/cli
 *   tcb login
 *   在 CloudBase 控制台开通「静态网站托管」并拿到环境 ID
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** 真正需要发到线上的内容 */
const SITE_FILES = ['index.html', 'styles.css', 'app.js', '.nojekyll'];
const SITE_DIRS = ['data', 'assets'];

const envId = process.argv[2];

// 1. 整理出干净的部署目录
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const copied = [];
for (const f of SITE_FILES) {
  const from = path.join(ROOT, f);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(DIST, f));
    copied.push(f);
  }
}
for (const d of SITE_DIRS) {
  const from = path.join(ROOT, d);
  if (fs.existsSync(from)) {
    fs.cpSync(from, path.join(DIST, d), { recursive: true });
    copied.push(d + '/');
  }
}

console.log(`已整理部署目录：${DIST}`);
console.log('包含：' + copied.join('  '));

if (!envId) {
  console.log('\n未提供环境 ID，仅生成 dist/。确认无误后执行：');
  console.log('  tcb login');
  console.log('  tcb hosting deploy dist / -e <你的环境ID>');
  process.exit(0);
}

// 2. 调用 CloudBase CLI 部署
console.log(`\n开始部署到 CloudBase 环境 ${envId} …`);
const res = spawnSync('tcb', ['hosting', 'deploy', 'dist', '/', '-e', envId], {
  stdio: 'inherit',
  shell: true,
  cwd: ROOT,
});

if (res.status !== 0) {
  console.error('\n部署失败。请先确认：');
  console.error('  1) 已执行 tcb login 并登录成功');
  console.error('  2) 环境 ID 正确，且该环境已开通「静态网站托管」');
  process.exit(res.status ?? 1);
}

console.log('\n部署完成。可到 CloudBase 控制台查看静态托管的默认域名。');
