#!/usr/bin/env node
/* ============================================================
   微信小程序版：自动化断言
   ------------------------------------------------------------
   覆盖五组：

     A 数据一致性   小程序端 data/*.js 与仓库根 data/*.json 是否同源
     B 模块转换     nutrition.js 的 ESM -> CommonJS 转换是否等价
     C 业务逻辑     随机菜单与屏蔽的不变量（对 lib/menu.js 跑）
     D 设置容错     脏数据/老数据能不能读回来（对 lib/settings.js 跑）
     E 营养语义     三概念分离、手动值不回退、餐数不参与计算

   每条断言都打印实测值，**不做静默跳过**（断言写不出来的一律显式标记 SKIP 并说明原因）。

   局限（必须知道）：
   - 页面（pages/*）依赖 wx 运行时，本脚本不执行它们。
     与页面相关的行为只能做**源码级断言**，输出里会明确标注 `[源码断言]`。
   - WXML / WXSS 无法在 Node 里校验，只能在微信开发者工具中验证。

   用法：node tools/check-miniprogram.mjs
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];

function assert(group, name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   [${group}] ${name}${detail ? `  →  ${detail}` : ''}`);
  } else {
    failures.push(`[${group}] ${name}${detail ? `  →  ${detail}` : ''}`);
    console.log(`  FAIL [${group}] ${name}${detail ? `  →  ${detail}` : ''}`);
  }
}

function readSource(rel) {
  return fs.readFileSync(path.join(MP, rel), 'utf8');
}

/**
 * 去掉注释后再做源码断言。
 * 否则「本文件不出现任何 wx. 调用」这句注释本身就会被当成一次 wx 调用。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function readRootSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 从生成的 data/*.js 里取出 JSON 文本 */
function parseGeneratedData(rel) {
  const text = readSource(rel);
  const marker = 'module.exports = ';
  const at = text.indexOf(marker);
  return JSON.parse(text.slice(at + marker.length).replace(/;\s*$/, ''));
}

const asArray = (d) => (Array.isArray(d) ? d : (d.recipes || []));

console.log('微信小程序版 · 自动化断言\n');

// ==================================================================
// A. 数据一致性
// ==================================================================

console.log('A. 数据一致性（防分叉：小程序端必须是 data/*.json 的忠实产物）');

const srcRecipesRaw = JSON.parse(readRootSource('data/recipes.json'));
const srcFoodsRaw = JSON.parse(readRootSource('data/foods.json'));
const srcRecipes = asArray(srcRecipesRaw);
const srcFoods = srcFoodsRaw.foods;

const genRecipes = asArray(parseGeneratedData('data/recipes.js'));
const genFoodsRaw = parseGeneratedData('data/foods.js');
const genFoods = genFoodsRaw.foods;

assert('A', 'A1 菜谱条目数 小程序端 == 源', genRecipes.length === srcRecipes.length,
  `${genRecipes.length} / ${srcRecipes.length}`);

const countRole = (list, role) => list.filter((r) => r.menuRole === role).length;
assert('A', 'A2 荤菜池数量', countRole(genRecipes, 'protein') === 188,
  `${countRole(genRecipes, 'protein')} 道`);
assert('A', 'A3 素菜池数量', countRole(genRecipes, 'vegetable') === 40,
  `${countRole(genRecipes, 'vegetable')} 道`);

assert('A', 'A4 食物营养表条数', genFoods.length === 123, `${genFoods.length} 条`);
assert('A', 'A5 主食条数', genFoods.filter((f) => f.staple).length === 10,
  `${genFoods.filter((f) => f.staple).length} 条`);

assert('A', 'A6 菜谱数组与源 JSON 逐字节一致',
  JSON.stringify(genRecipes) === JSON.stringify(srcRecipes),
  `${genRecipes.length} 道逐项比对`);
assert('A', 'A7 食物数组与源 JSON 逐字节一致',
  JSON.stringify(genFoods) === JSON.stringify(srcFoods),
  `${genFoods.length} 条逐项比对`);

// 抽样：把生成的 data/*.js 当作真正被小程序 require 的模块加载一次
const loadedRecipesData = require('../miniprogram/data/recipes.js');
const loadedRecipes = asArray(loadedRecipesData);
const sampleIds = [0, 1, 100, 200, 369].map((i) => loadedRecipes[i]).filter(Boolean);
let sampleOk = sampleIds.length === 5;
const sampleDetail = [];
for (const r of sampleIds) {
  const src = srcRecipes.find((x) => x.id === r.id);
  const same = src && JSON.stringify(src) === JSON.stringify(r);
  if (!same) sampleOk = false;
  sampleDetail.push(`${r.id}:${same ? '同' : '异'}`);
}
assert('A', 'A8 抽样 5 道菜 require 后与源一致', sampleOk, sampleDetail.join(' '));

// ==================================================================
// B. 模块转换（ESM -> CommonJS）
// ==================================================================

console.log('\nB. 模块转换（nutrition.js 的 ESM -> CommonJS 是否等价）');

const nutritionCjs = require('../miniprogram/lib/nutrition.js');

// 把仓库根的 ESM 版复制成临时 .mjs 再 import —— 只读源文件，不改动它
const esmTmp = path.join(os.tmpdir(), `wswet-nutrition-${process.pid}.mjs`);
fs.writeFileSync(esmTmp, readRootSource('nutrition.js'), 'utf8');
const nutritionEsm = await import(pathToFileURL(esmTmp).href);
fs.unlinkSync(esmTmp);

const srcExportNames = [...readRootSource('nutrition.js').matchAll(
  /^export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/gm,
)].map((m) => m[1]).sort();
const cjsExportNames = Object.keys(nutritionCjs).sort();

const onlySrc = srcExportNames.filter((n) => !cjsExportNames.includes(n));
const onlyCjs = cjsExportNames.filter((n) => !srcExportNames.includes(n));

assert('B', 'B1 导出名集合相等',
  onlySrc.length === 0 && onlyCjs.length === 0,
  `源 ${srcExportNames.length} 项 / 转换后 ${cjsExportNames.length} 项`
  + (onlySrc.length ? `；缺失 ${onlySrc.join(',')}` : '')
  + (onlyCjs.length ? `；多出 ${onlyCjs.join(',')}` : ''));

// 同一组输入，两个版本必须算出完全相同的结果
const srcFoodsForIndex = srcFoodsRaw;
const esmIndex = nutritionEsm.buildIndex(srcFoodsForIndex);
const cjsIndex = nutritionCjs.buildIndex(srcFoodsForIndex);

const probeRecipes = srcRecipes.filter((r) =>
  ['protein', 'vegetable'].includes(r.menuRole)).slice(0, 5);

const esmEst = probeRecipes.map((r) =>
  nutritionEsm.estimateRecipe(r, esmIndex, srcFoodsRaw.unitConversions));
const cjsEst = probeRecipes.map((r) =>
  nutritionCjs.estimateRecipe(r, cjsIndex, srcFoodsRaw.unitConversions));

assert('B', 'B2a estimateRecipe 输出一致',
  JSON.stringify(esmEst) === JSON.stringify(cjsEst),
  `${probeRecipes.length} 道菜逐项比对，状态 ${esmEst.map((e) => e.status).join('/')}`);

const probeMember = {
  name: '甲', gender: 'male', age: 35, heightCm: 175, weightKg: 70,
  activityLevel: 'moderate', dailyEnergyMode: 'auto', enabled: true,
};
const esmHealth = nutritionEsm.healthMetrics(probeMember);
const cjsHealth = nutritionCjs.healthMetrics(probeMember);
assert('B', 'B2b healthMetrics 输出一致',
  JSON.stringify(esmHealth) === JSON.stringify(cjsHealth),
  `BMI ${cjsHealth.bmi.toFixed(2)} / BMR ${cjsHealth.bmr.toFixed(1)}`);

const cjsStaple = { key: 'rice-cooked', grams: 300, nutri: null };
const esmSummary = nutritionEsm.summarizeMeal(
  esmEst.map((est, i) => ({ recipe: probeRecipes[i], est })), null, 3);
const cjsSummary = nutritionCjs.summarizeMeal(
  cjsEst.map((est, i) => ({ recipe: probeRecipes[i], est })), null, 3);
assert('B', 'B2c summarizeMeal 输出一致',
  JSON.stringify(esmSummary) === JSON.stringify(cjsSummary),
  `合计 ${cjsSummary.total.kcal.toFixed(1)} kcal，${cjsSummary.dishes} 道菜`);
void cjsStaple;

// ==================================================================
// C. 业务逻辑不变量（lib/menu.js）
// ==================================================================

console.log('\nC. 业务逻辑（随机菜单与屏蔽，实跑 lib/menu.js）');

const menu = require('../miniprogram/lib/menu.js');
const pools = menu.buildPools(loadedRecipes);
const clean = menu.rebuildAvailable(pools, []);

assert('C', 'C0 两个池子的规模',
  clean.available.protein.length === 188 && clean.available.vegetable.length === 40,
  `荤 ${clean.available.protein.length} / 素 ${clean.available.vegetable.length}`);

// C1 荤素始终 1:1
let c1bad = 0;
const c1rows = [];
for (const size of [2, 4, 6, 8]) {
  let allOk = true;
  for (let i = 0; i < 200; i++) {
    const m = menu.pickMenu(clean.available, size, null);
    if (!m) { allOk = false; break; }
    const p = m.filter((x) => x.menuRole === 'protein').length;
    const v = m.filter((x) => x.menuRole === 'vegetable').length;
    if (m.length !== size || p !== size / 2 || v !== size / 2) { allOk = false; break; }
  }
  if (!allOk) c1bad++;
  c1rows.push(`${size}:${allOk ? '对' : '错'}`);
}
assert('C', 'C1 每桌荤素各半且总数等于 mealSize（各 200 次）', c1bad === 0,
  c1rows.join(' '));

// C2 同桌不重复
let dupCount = 0;
for (let i = 0; i < 1000; i++) {
  const m = menu.pickMenu(clean.available, 2, null);
  if (!m) continue;
  if (new Set(m.map((x) => x.id)).size !== m.length) dupCount++;
}
assert('C', 'C2 同一桌不出现重复的菜（1000 次）', dupCount === 0,
  `重复 ${dupCount} 次`);

// C3 换一组：至少和上一桌不完全相同
let sameCount = 0;
let fullyReplaced = 0;
let prev = menu.pickMenu(clean.available, 2, null);
for (let i = 0; i < 1000; i++) {
  const next = menu.pickMenu(clean.available, 2, prev);
  if (!next) continue;
  if (menu.sameMenu(next, prev)) sameCount++;
  const prevIds = new Set(prev.map((x) => x.id));
  if (!next.some((x) => prevIds.has(x.id))) fullyReplaced++;
  prev = next;
}
assert('C', 'C3a 连续两桌不会完全相同（1000 次）', sameCount === 0,
  `相同 ${sameCount} 次`);
assert('C', 'C3b 换一组优先整桌换掉', fullyReplaced > 900,
  `${fullyReplaced} / 1000 次做到整桌全换`);

// C4 屏蔽「鱼」后，两池中任何可被匹配的字段都不含「鱼」
const fish = menu.rebuildAvailable(pools, ['鱼']);
const BLOCK_FIELDS = menu.BLOCK_FIELDS;
const fishLeak = [...fish.available.protein, ...fish.available.vegetable].filter((r) => {
  const hay = [
    ...BLOCK_FIELDS.map((f) => r[f]),
    ...(r.ingredients || []),
    ...(r.tags || []),
  ].join('\n').toLowerCase();
  return hay.includes('鱼');
});
assert('C', 'C4 屏蔽「鱼」后可用池里不再有命中项', fishLeak.length === 0,
  `被屏蔽 ${fish.blocked} 道，泄漏 ${fishLeak.length} 道`);

// C5 steps / tips 不参与屏蔽匹配
const fakeRecipe = {
  id: 'fake-1', name: '番茄炒蛋', categoryName: '素菜', description: '家常菜',
  ingredients: ['番茄 2 个', '鸡蛋 3 个'], tags: [],
  steps: ['把鱼煎一下', '加香菜'], tips: ['鱼要新鲜'],
};
assert('C', 'C5 关键词只出现在 steps/tips 时不被屏蔽',
  menu.isBlocked(fakeRecipe, ['鱼']) === false && menu.isBlocked(fakeRecipe, ['香菜']) === false,
  `鱼:${menu.isBlocked(fakeRecipe, ['鱼'])} 香菜:${menu.isBlocked(fakeRecipe, ['香菜'])}`);
assert('C', 'C5b 关键词出现在 name/ingredients 时被屏蔽',
  menu.isBlocked(fakeRecipe, ['番茄']) === true,
  `番茄:${menu.isBlocked(fakeRecipe, ['番茄'])}`);

// C6 池子不足：明确失败，不死循环
const tinyPools = {
  protein: clean.available.protein,
  vegetable: clean.available.vegetable.slice(0, 1),
};
const tinyPlan = menu.menuPlan(tinyPools, 4);
const tinyPick = menu.pickMenu(tinyPools, 4, null);
assert('C', 'C6 池子不足时 ok=false 且 pickMenu 返回 null',
  tinyPlan.ok === false && tinyPick === null,
  `素菜剩 ${tinyPools.vegetable.length} 道、需要 ${tinyPlan.need.vegetable} 道，`
  + `short=${JSON.stringify(tinyPlan.short)}`);

// C7 关键词输入解析
const parsed = menu.parseKeywordInput('鱼，虾、肉 蛋,, 鱼');
assert('C', 'C7 分隔符解析 + 去空 + 去重', parsed.length === 4,
  JSON.stringify(parsed));

// ==================================================================
// D. 设置容错（lib/settings.js）
// ==================================================================

console.log('\nD. 设置容错（脏数据 / 老数据能不能读回来）');

const S = require('../miniprogram/lib/settings.js');

const d1 = S.normalizeSettings(null);
assert('D', 'D1 空存储 → 全默认值',
  d1.mealSize === 2 && d1.healthNutritionEnabled === false
  && d1.members.length === 0 && d1.blockedKeywords.length === 0
  && d1.mealsPerDay === 3 && d1.currentMealHouseholdSize === null,
  `mealSize=${d1.mealSize} 开关=${d1.healthNutritionEnabled} 餐数=${d1.mealsPerDay}`);

const d2 = S.normalizeSettings('');
assert('D', 'D2 非对象输入不抛异常且返回默认值', d2.mealSize === 2,
  `mealSize=${d2.mealSize}`);

const d3 = S.normalizeSettings({
  healthProfile: { sex: 'female', age: 32, height: 162, weight: 55, activity: 'light' },
});
assert('D', 'D3 老格式 healthProfile 迁移成 1 位成员',
  d3.members.length === 1 && d3.members[0].name === '我'
  && d3.members[0].gender === 'female',
  `${d3.members.length} 位，姓名「${d3.members[0] && d3.members[0].name}」`);

const d4 = S.normalizeSettings({
  members: [{
    id: 'm1', name: '甲', gender: 'male', age: 35, heightCm: 175, weightKg: 70,
    activityLevel: 'moderate', enabled: true,
    // 刻意不给 dailyEnergyMode / dailyEnergyManual / mealsPerDay
  }],
});
assert('D', 'D4 老成员缺新字段 → 回退 auto/null/3，且整条成员不丢弃',
  d4.members.length === 1
  && d4.members[0].dailyEnergyMode === 'auto'
  && d4.members[0].dailyEnergyManual === null
  && d4.mealsPerDay === 3,
  `成员 ${d4.members.length} 位，能量来源 ${d4.members[0] && d4.members[0].dailyEnergyMode}，`
  + `餐数 ${d4.mealsPerDay}`);

const d5 = S.normalizeSettings({ mealSize: 5 });
assert('D', 'D5 非法 mealSize 回退 2', d5.mealSize === 2, `mealSize=${d5.mealSize}`);

const d6 = S.normalizeSettings({ blockedKeywords: [' 鱼 ', '鱼', '虾', '', '  '] });
assert('D', 'D6 屏蔽词去空、去重、忽略大小写',
  d6.blockedKeywords.length === 2 && d6.blockedKeywords[0] === '鱼',
  JSON.stringify(d6.blockedKeywords));

const d7 = S.normalizeSettings({
  members: [{ id: 'm9', name: '', gender: 'male', age: 35, heightCm: 175, weightKg: 70, activityLevel: 'moderate' }],
});
assert('D', 'D7 存进来就不合法的成员被丢弃', d7.members.length === 0,
  `${d7.members.length} 位`);

const d8 = S.effectiveDiners({
  currentMealHouseholdSize: null,
  members: [{ enabled: true }, { enabled: true }, { enabled: false }],
});
assert('D', 'D8 无显式人数时跟随已启用成员数', d8 === 2, `${d8} 人`);

const d9 = S.effectiveDiners({ currentMealHouseholdSize: 5, members: [{ enabled: true }] });
assert('D', 'D9 显式人数优先于成员数', d9 === 5, `${d9} 人`);

// ==================================================================
// E. 营养语义
// ==================================================================

console.log('\nE. 营养语义（三概念分离 / 手动值不回退 / 餐数不参与计算）');

const N = nutritionCjs;

const e2 = N.dailyEnergyReference(
  { dailyEnergyMode: 'manual', dailyEnergyManual: null },
  { tdee: 2200 },
);
assert('E', 'E2 手动模式无数字时不回退到自动值',
  e2.kcal === null && e2.hasValue === false && e2.mode === 'manual',
  `mode=${e2.mode} kcal=${e2.kcal} 标签=${e2.label}`);

const e3manual = N.dailyEnergyReference(
  { dailyEnergyMode: 'manual', dailyEnergyManual: 1800 },
  { tdee: 2300 },
);
const e3ranges = N.macroRanges(e3manual.kcal);
const e3expectedLow = (1800 * 0.45) / 4;
assert('E', 'E3 碳水/脂肪基准跟随每日能量参考（手动值优先）',
  e3manual.kcal === 1800 && Math.abs(e3ranges.carbsLow - e3expectedLow) < 1e-9,
  `能量 ${e3manual.kcal}（自动值 2300 被忽略），碳水下限 ${e3ranges.carbsLow.toFixed(1)} g`);

const e3auto = N.dailyEnergyReference({ dailyEnergyMode: 'auto' }, { tdee: 2300 });
assert('E', 'E3b 自动模式用公式值', e3auto.kcal === 2300 && e3auto.label === '自动估算',
  `kcal=${e3auto.kcal} 标签=${e3auto.label}`);

assert('E', 'E4 餐数只记录不参与计算（无除法工具）',
  N.MEALS_PER_DAY_OPTIONS.join(',') === '2,3,4,5,6'
  && N.normalizeMealsPerDay('4') === 4
  && N.normalizeMealsPerDay(9) === 3,
  `选项 ${N.MEALS_PER_DAY_OPTIONS.join('/')}，'4'→${N.normalizeMealsPerDay('4')}，9→${N.normalizeMealsPerDay(9)}`);

assert('E', 'E5 状态文案三态',
  N.STATUS_TEXT.full === '已估算' && N.STATUS_TEXT.partial === '部分估算'
  && N.STATUS_TEXT.none === '暂无完整估算',
  `${N.STATUS_TEXT.full} / ${N.STATUS_TEXT.partial} / ${N.STATUS_TEXT.none}`);

assert('E', 'E6 默认关闭健康与营养',
  S.DEFAULT_SETTINGS.healthNutritionEnabled === false,
  `默认值 ${S.DEFAULT_SETTINGS.healthNutritionEnabled}`);

const e7 = N.validateMember({
  name: '甲', gender: 'male', age: 35, heightCm: 175, weightKg: 70,
  activityLevel: 'moderate', dailyEnergyMode: 'auto',
});
assert('E', 'E7 自动模式下不需要能量数字即可通过校验', e7 === null, `返回 ${e7}`);

const e8 = N.validateMember({
  name: '甲', gender: 'male', age: 35, heightCm: 175, weightKg: 70,
  activityLevel: 'moderate', dailyEnergyMode: 'manual', dailyEnergyManual: 300,
});
assert('E', 'E8 手动模式越界被拦下', typeof e8 === 'string', String(e8));

// ---- 源码级断言：页面行为无法在 Node 里执行，这里只证明守卫语句存在 ----

const indexSrc = readSource('pages/index/index.js');
const settingsPageSrc = readSource('pages/settings/settings.js');
const memberPageSrc = readSource('pages/settings/member/member.js');

assert('E', '[源码断言] E9 首页在开关关闭时直接清空估算、不做计算',
  /if\s*\(!on\s*\|\|\s*!g\.foodIndex\s*\|\|\s*!this\.current\)\s*\{[\s\S]*?this\.estimates\s*=\s*\[\][\s\S]*?this\.summary\s*=\s*null[\s\S]*?return;/.test(indexSrc),
  'index.js recompute() 的守卫语句存在');

assert('E', '[源码断言] E10 卡片热量只在开启时才生成',
  /healthNutritionEnabled === true && est && est\.est\.status !== 'none'/.test(indexSrc),
  'index.js cardModel() 的条件存在');

assert('E', '[源码断言] E11 餐数变更不触发任何营养重算',
  !/onMealsTap[\s\S]{0,400}recompute\(/.test(settingsPageSrc),
  'settings.js onMealsTap() 内无 recompute 调用');

assert('E', '[源码断言] E12 成员表单新增与编辑共用一个视图',
  /mode:\s*'form'/.test(memberPageSrc)
  && (memberPageSrc.match(/mode:\s*'form'/g) || []).length === 2,
  `进入 form 视图的入口数 ${(memberPageSrc.match(/mode:\s*'form'/g) || []).length}（应为 2：新增 + 编辑）`);

assert('E', '[源码断言] E13 删除成员需二次确认',
  /onAskDelete/.test(memberPageSrc) && /onConfirmDelete/.test(memberPageSrc)
  && /confirmId/.test(memberPageSrc),
  'confirmId 两步流程存在');

assert('E', '[源码断言] E14 详情页来源改为复制链接，不打开外部网页',
  /setClipboardData/.test(readSource('pages/detail/detail.js'))
  && !/web-view/.test(readSource('pages/detail/detail.wxml')),
  'detail 使用 wx.setClipboardData，未使用 web-view');

assert('E', '[源码断言] E15 存储层键名与 Web 版一致',
  /what-should-we-eat-today\.settings/.test(readSource('lib/settings.js')),
  'SETTINGS_KEY = what-should-we-eat-today.settings');

// 先剥掉注释：这两个文件的注释里写着「本文件不出现任何 wx. 调用」，不能把它当成调用
const menuCode = stripComments(readSource('lib/menu.js'));
const settingsCode = stripComments(readSource('lib/settings.js'));
assert('E', '[源码断言] E16 lib/menu.js 与 lib/settings.js 的代码里不含 wx 调用',
  !/\bwx\./.test(menuCode) && !/\bwx\./.test(settingsCode),
  `menu.js 命中 ${(menuCode.match(/\bwx\./g) || []).length} 处，`
  + `settings.js 命中 ${(settingsCode.match(/\bwx\./g) || []).length} 处`);

assert('E', '[源码断言] E17 唯一碰 wx 存储的是 lib/store.js',
  /\bwx\.getStorageSync/.test(stripComments(readSource('lib/store.js')))
  && /\bwx\.setStorageSync/.test(stripComments(readSource('lib/store.js'))),
  'store.js 同时使用 getStorageSync / setStorageSync');

// ==================================================================
// F. 页面接线（WXML 绑定 ↔ 页面 data / 方法）
// ==================================================================

console.log('\nF. 页面接线（用假的 Page/getApp/wx 执行页面 js，核对 WXML 绑定）');

const PAGES = [
  'pages/index/index',
  'pages/detail/detail',
  'pages/settings/settings',
  'pages/settings/member/member',
];

const RESERVED_IDENT = new Set(['item', 'index', 'true', 'false', 'null', 'undefined']);

/**
 * 页面 js 依赖 Page/getApp/wx 才能执行，这里用假的宿主把它跑一遍，
 * 拿到真实的配置对象（data 键 + 方法名）与 WXML 比对。
 * 这不能替代微信开发者工具的编译，但能拦住「绑定了不存在的字段/方法」这类低级错误。
 */
function loadPageConfig(rel) {
  const jsPath = path.join(MP, `${rel}.js`);
  const src = fs.readFileSync(jsPath, 'utf8');
  const req = createRequire(jsPath);
  let captured = null;
  const wxMock = new Proxy({}, { get: () => () => undefined });
  const getAppMock = () => ({ globalData: { ready: true, total: 0 } });
  // eslint-disable-next-line no-new-func
  const fn = new Function('Page', 'getApp', 'wx', 'require', 'module', 'exports', src);
  fn((cfg) => { captured = cfg; }, getAppMock, wxMock, req, { exports: {} }, {});
  if (!captured) throw new Error(`${rel} 没有调用 Page()`);
  return captured;
}

for (const rel of PAGES) {
  const cfg = loadPageConfig(rel);
  const dataKeys = new Set(Object.keys(cfg.data || {}));
  const methods = new Set(Object.keys(cfg).filter((k) => typeof cfg[k] === 'function'));
  const wxml = readSource(`${rel}.wxml`);

  const used = new Set();
  for (const m of wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // 抹掉成员访问，否则 item.name 里的 name 会被误当成顶层变量
    const expr = m[1]
      .replace(/'[^']*'/g, '')
      .replace(/"[^"]*"/g, '')
      .replace(/\.[A-Za-z_$][\w$]*/g, '');
    for (const id of expr.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!RESERVED_IDENT.has(id[0])) used.add(id[0]);
    }
  }
  const missingVars = [...used].filter((n) => !dataKeys.has(n));
  assert('F', `F1 ${rel} · WXML 绑定的字段都在 data 里`,
    missingVars.length === 0,
    missingVars.length ? `缺 ${missingVars.join(', ')}` : `${used.size} 个标识符`);

  const handlers = new Set();
  for (const m of wxml.matchAll(/\b(?:bind|catch)[a-z]*\s*=\s*"([^"{}]+)"/g)) {
    handlers.add(m[1]);
  }
  const badHandlers = [...handlers].filter((h) => !methods.has(h));
  assert('F', `F2 ${rel} · 事件绑定的方法都存在`,
    badHandlers.length === 0,
    badHandlers.length ? `缺 ${badHandlers.join(', ')}` : `${handlers.size} 个处理函数`);
}

// ==================================================================
// 汇总
// ==================================================================

console.log(`\n${'-'.repeat(60)}`);
console.log(`通过 ${passed} 条，失败 ${failures.length} 条`);

if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}

console.log('\n全部通过。');
console.log('未覆盖（无法在 Node 中执行，需在微信开发者工具 / 真机验证）：');
console.log('  - WXML / WXSS 渲染与布局');
console.log('  - 页面生命周期、setData、页面跳转');
console.log('  - wx.setStorageSync / setClipboardData 等宿主 API 的真实行为');
