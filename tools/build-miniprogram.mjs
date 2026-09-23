#!/usr/bin/env node
/* ============================================================
   微信小程序端：数据与共享逻辑生成器
   ------------------------------------------------------------
   这个脚本是 Web 版与小程序版之间**唯一的桥**，只做三件事：

     1. data/recipes.json  ->  miniprogram/data/recipes.js
     2. data/foods.json    ->  miniprogram/data/foods.js
     3. nutrition.js       ->  miniprogram/lib/nutrition.js（ESM -> CommonJS）

   为什么要有它：
   - 小程序不能读取仓库外的文件，数据必须复制进小程序目录；
     手工复制会产生第二份事实源，所以由脚本生成，源头始终是 data/*.json。
   - 小程序的模块格式以 CommonJS 最无争议，而 nutrition.js 是 ESM，
     转换规则机械且可断言（见 esmToCjs）。

   幂等性：产物中**不写入时间戳**，同样的输入必然得到逐字节相同的输出。
   生成的文件已入库，用户拿到仓库后可直接用微信开发者工具打开，无需先跑本脚本。

   用法：
     node tools/build-miniprogram.mjs
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');

/** specs.md 记录的实测数量。数据重建后若不一致，必须同步 specs.md 与本表，而不是放宽断言。 */
const EXPECTED = {
  recipes: 370,
  protein: 188,
  vegetable: 40,
  foods: 123,
  stapleFoods: 10,
};

const problems = [];
const notes = [];

function check(ok, message) {
  if (ok) notes.push(`  ok   ${message}`);
  else problems.push(message);
  return ok;
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function writeOut(rel, content) {
  const abs = path.join(MP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return Buffer.byteLength(content, 'utf8');
}

// 行分隔符 / 段分隔符。它们在旧 JS 引擎里会被当作换行，写进源码会断行。
// 用 charCode 构造，避免把这两个字符本身写进本文件。
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

function toJsLiteral(value) {
  return JSON.stringify(value)
    .split(LINE_SEP).join('\\u2028')
    .split(PARA_SEP).join('\\u2029');
}

/** 把生成出来的 data/*.js 读回来解析，用于验证「产物确实等于源 JSON」 */
function readBackGenerated(rel) {
  const text = fs.readFileSync(path.join(MP, rel), 'utf8');
  const marker = 'module.exports = ';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`${rel} 里找不到 ${marker}`);
  return JSON.parse(text.slice(at + marker.length).replace(/;\s*$/, ''));
}

function banner(source, extra = '') {
  return [
    '/* ============================================================',
    '   本文件由 tools/build-miniprogram.mjs 自动生成，请勿手工编辑。',
    `   源头：${source}`,
    '   重新生成：node tools/build-miniprogram.mjs',
    extra ? `   ${extra}` : null,
    '   ============================================================ */',
    '',
  ].filter((l) => l !== null).join('\n');
}

/** 兼容两种顶层形态：数组 或 { recipes: [...] }（与 app.js 启动时的处理一致） */
function asRecipeArray(recipeData) {
  return Array.isArray(recipeData) ? recipeData : (recipeData.recipes || []);
}

// ------------------------------------------------------------------
// 1 + 2. 数据
// ------------------------------------------------------------------

function buildData() {
  const recipesData = readJson('data/recipes.json');
  const foodsData = readJson('data/foods.json');

  const recipes = asRecipeArray(recipesData);
  check(recipes.length === EXPECTED.recipes,
    `菜谱总数 ${recipes.length}（期望 ${EXPECTED.recipes}）`);

  const byRole = {};
  for (const r of recipes) byRole[r.menuRole] = (byRole[r.menuRole] || 0) + 1;
  check(byRole.protein === EXPECTED.protein,
    `荤菜池 ${byRole.protein ?? 0} 道（期望 ${EXPECTED.protein}）`);
  check(byRole.vegetable === EXPECTED.vegetable,
    `素菜池 ${byRole.vegetable ?? 0} 道（期望 ${EXPECTED.vegetable}）`);

  const foods = foodsData.foods || [];
  check(foods.length === EXPECTED.foods,
    `食物营养表 ${foods.length} 条（期望 ${EXPECTED.foods}）`);
  const staples = foods.filter((f) => f.staple);
  check(staples.length === EXPECTED.stapleFoods,
    `主食 ${staples.length} 条（期望 ${EXPECTED.stapleFoods}）`);

  const sizeRecipes = writeOut('data/recipes.js',
    `${banner('data/recipes.json', `菜谱 ${recipes.length} 道`)}module.exports = ${toJsLiteral(recipesData)};\n`);
  const sizeFoods = writeOut('data/foods.js',
    `${banner('data/foods.json', `营养表 ${foods.length} 条`)}module.exports = ${toJsLiteral(foodsData)};\n`);

  // 读回生成物，证明产物可解析且与源一致（不是只把源对象打印一遍）
  const backRecipes = asRecipeArray(readBackGenerated('data/recipes.js'));
  const backFoods = readBackGenerated('data/foods.js').foods || [];
  check(backRecipes.length === recipes.length,
    `读回 miniprogram/data/recipes.js：${backRecipes.length} 道，与源一致`);
  check(backFoods.length === foods.length,
    `读回 miniprogram/data/foods.js：${backFoods.length} 条，与源一致`);
  check(JSON.stringify(backRecipes) === JSON.stringify(recipes),
    '读回的菜谱数组与源 JSON 逐字节一致');
  check(JSON.stringify(backFoods) === JSON.stringify(foods),
    '读回的食物数组与源 JSON 逐字节一致');

  console.log(`  生成 miniprogram/data/recipes.js（${recipes.length} 道，文件 ${sizeRecipes} 字节）`);
  console.log(`  生成 miniprogram/data/foods.js（${foods.length} 条，文件 ${sizeFoods} 字节）`);

  return { recipes, foods };
}

// ------------------------------------------------------------------
// 3. nutrition.js：ESM -> CommonJS
// ------------------------------------------------------------------

const EXPORT_FN_RE = /^export\s+function\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_CONST_RE = /^export\s+const\s+([A-Za-z_$][\w$]*)/gm;

function esmToCjs(source) {
  const names = [];
  for (const m of source.matchAll(EXPORT_FN_RE)) names.push(m[1]);
  for (const m of source.matchAll(EXPORT_CONST_RE)) names.push(m[1]);

  const body = source
    .replace(EXPORT_FN_RE, 'function $1')
    .replace(EXPORT_CONST_RE, 'const $1');

  return { names, body };
}

function buildNutrition() {
  const source = fs.readFileSync(path.join(ROOT, 'nutrition.js'), 'utf8');

  // 前提假设必须先验证，否则正则转换会静默漏掉导出
  const hasDefault = /^export\s+default/m.test(source);
  const hasAggregate = /^export\s*\{/m.test(source);
  const hasReexport = /^export\s+\*\s+from/m.test(source);
  check(!hasDefault && !hasAggregate && !hasReexport,
    'nutrition.js 只使用了 export function / export const 两种形式');

  const { names, body } = esmToCjs(source);

  const exportMap = names.map((n) => `  ${n},`).join('\n');
  const out = `${banner('nutrition.js', `CommonJS 版本，导出 ${names.length} 项`)}
${body}
module.exports = {
${exportMap}
};
`;

  const size = writeOut('lib/nutrition.js', out);

  // 转换必须完整：源码里出现的 export 关键字一个都不能剩
  check(!/^export\s/m.test(out), '转换后源码中不再残留 export 关键字');
  check(names.length === new Set(names).size, `导出名无重复（${names.length} 项）`);
  check(!out.includes(String.fromCharCode(0x2028)) && !out.includes(String.fromCharCode(0x2029)),
    '转换产物中不含裸的行/段分隔符');

  console.log(`  生成 miniprogram/lib/nutrition.js（${names.length} 项导出，文件 ${size} 字节）`);

  return { names, size };
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------

console.log('生成小程序端数据与共享逻辑…');

buildData();
const { names } = buildNutrition();

console.log('\n断言：');
console.log(notes.join('\n'));

if (problems.length) {
  console.error('\n生成失败，以下断言未通过：');
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error('\n提示：若 data/*.json 是有意重建的，请同步更新 specs.md 与本脚本的 EXPECTED 常量。');
  process.exit(1);
}

console.log('\n全部通过。产物已写入 miniprogram/data/ 与 miniprogram/lib/nutrition.js');
console.log(`nutrition.js 导出：${names.join(', ')}`);
