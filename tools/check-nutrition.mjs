/**
 * 营养估算的覆盖率自检
 * 用真实 data/recipes.json 跑一遍解析，报告覆盖率分布与典型样本，
 * 用来判断估算结果是否可信、有没有明显跑偏的菜。
 *
 * 用法：node tools/check-nutrition.mjs [--samples N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIndex, parseIngredient, estimateRecipe, summarizeMeal, nutritionOf,
  healthMetrics, validateMember, fmt,
} from '../nutrition.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const recipes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/recipes.json'), 'utf8'));
const foodsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/foods.json'), 'utf8'));
const foodIndex = buildIndex(foodsRaw);
const units = foodsRaw.unitConversions;

const out = [];
const w = (s = '') => out.push(String(s));

w('=== 1. 全量菜谱营养覆盖率 ===');
const stats = { full: 0, partial: 0, none: 0 };
const coverageRatios = [];
const perDish = [];

for (const r of recipes.recipes) {
  const est = estimateRecipe(r, foodIndex, units);
  stats[est.status]++;
  coverageRatios.push(est.totalCount ? est.matched / est.totalCount : 0);
  perDish.push({ name: r.name, est });
}

const total = recipes.recipes.length;
w(`菜谱总数 ${total}`);
w(`  完整估算(full)    ${stats.full}  (${(stats.full / total * 100).toFixed(1)}%)`);
w(`  部分估算(partial) ${stats.partial}  (${(stats.partial / total * 100).toFixed(1)}%)`);
w(`  无法估算(none)    ${stats.none}  (${(stats.none / total * 100).toFixed(1)}%)`);
const avg = coverageRatios.reduce((a, b) => a + b, 0) / total;
w(`食材平均识别率 ${(avg * 100).toFixed(1)}%`);

// 只看能识别出重量的食材（分母排除「无用量描述」的）
w('');
w('=== 2. 未识别的食材原因分布 ===');
const reasons = {};
for (const r of recipes.recipes) {
  for (const ing of r.ingredients) {
    const p = parseIngredient(ing, foodIndex, units);
    if (p.status !== 'ok') reasons[p.status] = (reasons[p.status] || 0) + 1;
  }
}
const reasonLabel = { 'no-food': '食材库里没有这个食物', vague: '写着适量/少许，没有数字', 'no-amount': '有食材但读不出克数' };
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  w(`  ${reasonLabel[k] || k}: ${v}`);
}

w('');
w('=== 3. 最常见「食材库里没有」的名字（前 25） ===');
const missing = {};
for (const r of recipes.recipes) {
  for (const ing of r.ingredients) {
    const p = parseIngredient(ing, foodIndex, units);
    if (p.status === 'no-food') {
      const head = ing.split(/[\s（(：:，,=*]/)[0].slice(0, 10);
      missing[head] = (missing[head] || 0) + 1;
    }
  }
}
w(Object.entries(missing).sort((a, b) => b[1] - a[1]).slice(0, 25)
  .map(([k, v]) => `${k}(${v})`).join('  '));

w('');
w('=== 4. 单道菜热量分布（看有没有明显跑偏） ===');
const withKcal = perDish.filter((d) => d.est.status !== 'none')
  .map((d) => ({ ...d, kcal: d.est.total.kcal }))
  .sort((a, b) => a.kcal - b.kcal);
const pct = (p) => withKcal[Math.floor(withKcal.length * p)];
w(`  最低 ${fmt(withKcal[0]?.kcal)} kcal (${withKcal[0]?.name})`);
w(`  25%  ${fmt(pct(0.25)?.kcal)} kcal`);
w(`  中位 ${fmt(pct(0.5)?.kcal)} kcal`);
w(`  75%  ${fmt(pct(0.75)?.kcal)} kcal`);
w(`  最高 ${fmt(withKcal[withKcal.length - 1]?.kcal)} kcal (${withKcal[withKcal.length - 1]?.name})`);
w('');
w('  热量最低的 5 道：');
withKcal.slice(0, 5).forEach((d) => w(`    ${fmt(d.kcal)} kcal  ${d.name}  [${d.est.matched}/${d.est.totalCount}]`));
w('  热量最高的 5 道：');
withKcal.slice(-5).reverse().forEach((d) => w(`    ${fmt(d.kcal)} kcal  ${d.name}  [${d.est.matched}/${d.est.totalCount}]`));
w('  没有营养数据的菜：');
perDish.filter((d) => d.est.status === 'none').forEach((d) => w(`    ${d.name}  [0/${d.est.totalCount}]`));

w('');
w('=== 5. 主食营养（对照 USDA 数值手算） ===');
for (const [key, grams] of [['rice-cooked', 100], ['rice-cooked', 300], ['rice-cooked', 750]]) {
  const n = nutritionOf(key, grams, foodIndex);
  const f = foodIndex.byKey.get(key);
  w(`  ${key} ${grams}g -> ${fmt(n.kcal)} kcal / 蛋白 ${fmt(n.protein, 1)}g / 碳水 ${fmt(n.carbs, 1)}g / 脂肪 ${fmt(n.fat, 1)}g   (每100g: ${f.per100g.kcal} kcal)`);
}

w('');
w('=== 6. 健康计算核对（手算验证） ===');
const cases = [
  { name: '我', gender: 'male', age: 30, heightCm: 175, weightKg: 70, activityLevel: 'sedentary' },
  { name: '老婆', gender: 'female', age: 45, heightCm: 160, weightKg: 55, activityLevel: 'moderate' },
  { name: '爸', gender: 'male', age: 60, heightCm: 170, weightKg: 85, activityLevel: 'active' },
];
for (const c of cases) {
  const m = healthMetrics(c);
  const m2 = c.heightCm / 100;
  const expectBmi = c.weightKg / (m2 * m2);
  const expectBmr = 10 * c.weightKg + 6.25 * c.heightCm - 5 * c.age + (c.gender === 'male' ? 5 : -161);
  w(`  ${c.name}（${c.gender} ${c.age}岁 ${c.heightCm}cm ${c.weightKg}kg ${c.activityLevel}）`);
  w(`    BMI=${fmt(m.bmi, 2)} (手算 ${fmt(expectBmi, 2)}) 分级=${m.bmiCategory.label}`);
  w(`    BMR=${fmt(m.bmr)} (手算 ${fmt(expectBmr)})  TDEE=${fmt(m.tdee)}`);
  w(`    蛋白质=${fmt(m.proteinG, 1)}g  碳水 ${fmt(m.carbsLow)}–${fmt(m.carbsHigh)}g  脂肪 ${fmt(m.fatLow)}–${fmt(m.fatHigh)}g`);
}

w('');
w('=== 6b. 成员校验规则 ===');
const badCases = [
  [{ name: '', gender: 'male', age: 30, heightCm: 175, weightKg: 70, activityLevel: 'sedentary' }, '空称呼应被拒'],
  [{ name: '我', gender: 'male', age: 5, heightCm: 175, weightKg: 70, activityLevel: 'sedentary' }, '年龄过小应被拒'],
  [{ name: '我', gender: 'male', age: 30, heightCm: 300, weightKg: 70, activityLevel: 'sedentary' }, '身高过高应被拒'],
  [{ name: '我', gender: 'male', age: 30, heightCm: 175, weightKg: 500, activityLevel: 'sedentary' }, '体重过重应被拒'],
  [{ name: '我', gender: 'x', age: 30, heightCm: 175, weightKg: 70, activityLevel: 'sedentary' }, '性别非法应被拒'],
  [{ name: '我', gender: 'male', age: 30, heightCm: 175, weightKg: 70, activityLevel: 'nope' }, '活动水平非法应被拒'],
];
for (const [m, desc] of badCases) {
  const err = validateMember(m);
  w(`  ${desc}：${err ? '✅ 已拒（' + err + '）' : '❌ 未拒'}`);
}
const good = validateMember(cases[0]);
w(`  合法成员应通过：${good === null ? '✅ 通过' : '❌ 被误拒（' + good + '）'}`);

w('');
w('=== 7. 整餐汇总抽样 ===');
const sample = recipes.recipes.filter((r) => ['西红柿炒鸡蛋', '红烧茄子', '清蒸南瓜'].includes(r.name));
const ests = sample.map((r) => ({ recipe: r, est: estimateRecipe(r, foodIndex, units) }));
const stapleNutri = nutritionOf('rice-cooked', 750, foodIndex);
const summary = summarizeMeal(ests, { key: 'rice-cooked', grams: 750, nutri: stapleNutri }, 5);
w(`  5 人 / 主食 米饭 750g / ${sample.length} 道菜`);
for (const e of ests) {
  w(`    ${e.recipe.name}: ${fmt(e.est.total.kcal)} kcal [${e.est.matched}/${e.est.totalCount}] ${e.est.status}`);
}
w(`  合计 ${fmt(summary.total.kcal)} kcal  人均 ${fmt(summary.perPerson.kcal)} kcal`);
w(`  人均 蛋白 ${fmt(summary.perPerson.protein, 1)}g 碳水 ${fmt(summary.perPerson.carbs, 1)}g 脂肪 ${fmt(summary.perPerson.fat, 1)}g`);
w(`  有数据的菜 ${summary.dishesWithData}/${summary.dishes}，其中完整估算 ${summary.dishesFull}`);

fs.writeFileSync(path.join(ROOT, '.tmpfiles', '_nutrition_check.txt'), out.join('\n'), 'utf8');
console.log('报告已写入 .tmpfiles/_nutrition_check.txt');
