/**
 * 「营养语义重构」的自动化自检。
 *
 * 与 check-nutrition.mjs 的分工：
 *   check-nutrition.mjs           看估算**准不准**（覆盖率、分布、手算核对）
 *   check-nutrition-semantics.mjs 看语义**有没有跑偏**（每日能量 / 这桌菜 / 实际摄入
 *                                 三个概念是否被混为一谈、老数据是否还读得回来）
 *
 * 每条断言都对应规划文件里的一条硬约束，失败即退出码非 0。
 * 断言全部实际执行，不做静默跳过；每条都打印实测值。
 *
 * 用法：node tools/check-nutrition-semantics.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  healthMetrics, validateMember, dailyEnergyReference, macroRanges,
  normalizeMealsPerDay, summarizeMeal, estimateRecipe, nutritionOf,
  buildIndex, DAILY_ENERGY_LIMITS, MEALS_PER_DAY_OPTIONS, MEALS_PER_DAY_DEFAULT,
  fmt,
} from '../nutrition.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const out = [];

function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  out.push(`${ok ? '✅' : '❌'} ${name}`);
  if (detail) out.push(`     实测：${detail}`);
}

const w = (s = '') => out.push(s);

// ------------------------------------------------------------------
// 准备：一位标准成员 + 一位没有新字段的「老版本成员」
// ------------------------------------------------------------------

const BASE = {
  id: 'm1', name: '我', gender: 'male', age: 30,
  heightCm: 175, weightKg: 70, activityLevel: 'sedentary', enabled: true,
};

// G 段的口径扫描和 D 段的除法检查都要读源码，这里先读一次
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const nutritionSrc = fs.readFileSync(path.join(ROOT, 'nutrition.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const metrics = healthMetrics(BASE);
if (!metrics) {
  console.error('基础成员资料算不出 metrics，脚本无法继续');
  process.exit(1);
}

/**
 * 老版本存下来的成员：没有 dailyEnergyMode / dailyEnergyManual。
 * 这是升级场景里最常见的输入，必须能原样通过校验。
 */
const LEGACY = { ...BASE };

w('=== A. 每日能量参考：两种来源必须分得清 ===');
w('');

const auto = dailyEnergyReference({ ...BASE, dailyEnergyMode: 'auto' }, metrics);
check(
  'A1 自动估算 = 公式算出的维持能量',
  auto.mode === 'auto' && auto.hasValue && Math.abs(auto.kcal - metrics.tdee) < 1e-9,
  `mode=${auto.mode} kcal=${fmt(auto.kcal)} 公式值=${fmt(metrics.tdee)} 来源标签=${auto.label}`,
);

const manual = dailyEnergyReference(
  { ...BASE, dailyEnergyMode: 'manual', dailyEnergyManual: 1800 }, metrics,
);
check(
  'A2 自己设定 = 用户填的数字，且来源标签可辨',
  manual.mode === 'manual' && manual.kcal === 1800 && manual.label === '自己设定'
    && auto.label === '自动估算',
  `mode=${manual.mode} kcal=${fmt(manual.kcal)} 标签=${manual.label} ／ 自动来源标签=${auto.label}`,
);

const autoWithStaleNumber = dailyEnergyReference(
  { ...BASE, dailyEnergyMode: 'auto', dailyEnergyManual: 1800 }, metrics,
);
check(
  'A2b 来源是自动时，输入框里残留的数字不参与计算',
  autoWithStaleNumber.kcal === auto.kcal,
  `残留 1800 时取到 ${fmt(autoWithStaleNumber.kcal)}，自动值 ${fmt(auto.kcal)}`,
);

const manualEmpty = dailyEnergyReference(
  { ...BASE, dailyEnergyMode: 'manual', dailyEnergyManual: null }, metrics,
);
check(
  'A2c 手动模式没填数字时不给值，也不偷偷回退到自动值',
  manualEmpty.kcal === null && manualEmpty.hasValue === false,
  `kcal=${manualEmpty.kcal} hasValue=${manualEmpty.hasValue}（自动值 ${fmt(auto.kcal)} 未被借用）`,
);

w('');
w('=== B. 手动输入的防呆边界（不是营养学标准） ===');
w('');

for (const [v, shouldPass] of [
  [DAILY_ENERGY_LIMITS.min, true],
  [DAILY_ENERGY_LIMITS.max, true],
  [1800, true],
  [DAILY_ENERGY_LIMITS.min - 1, false],
  [DAILY_ENERGY_LIMITS.max + 1, false],
  [0, false],
  [-500, false],
  ['abc', false],
  ['', false],
]) {
  const m = { ...BASE, dailyEnergyMode: 'manual', dailyEnergyManual: v };
  const err = validateMember(m);
  const gotPass = err === null;
  check(
    `B1 手动填 ${JSON.stringify(v)} → ${shouldPass ? '通过' : '被拒'}`,
    gotPass === shouldPass,
    `validateMember 返回：${err === null ? '通过' : err}`,
  );
}

const outOfRangeErr = validateMember({
  ...BASE, dailyEnergyMode: 'manual', dailyEnergyManual: DAILY_ENERGY_LIMITS.max + 1,
});
check(
  'B2 超范围的提示只说范围，不对用户设的值做健康判断',
  outOfRangeErr !== null && !/健康|标准|建议|偏|过多|过少|不正常|不合理/.test(outOfRangeErr),
  `提示：${outOfRangeErr}`,
);

const inRangeErr = validateMember({
  ...BASE, dailyEnergyMode: 'manual', dailyEnergyManual: 1200,
});
check(
  'B3 范围内的一律照收，程序不评价这个数字合不合适',
  inRangeErr === null,
  `手动填 1200 → ${inRangeErr === null ? '通过' : inRangeErr}`,
);

w('');
w('=== C. 老数据不能被新校验误杀（本轮最高风险） ===');
w('');

check(
  'C1 老版本成员（无 dailyEnergyMode 字段）通过校验，不被整条丢弃',
  validateMember(LEGACY) === null,
  `validateMember 返回：${validateMember(LEGACY) === null ? '通过' : validateMember(LEGACY)}`,
);

const legacyEnergy = dailyEnergyReference(LEGACY, metrics);
check(
  'C2 老成员按「自动估算」处理，行为与升级前一致',
  legacyEnergy.mode === 'auto' && Math.abs(legacyEnergy.kcal - metrics.tdee) < 1e-9,
  `mode=${legacyEnergy.mode} kcal=${fmt(legacyEnergy.kcal)}`,
);

check(
  'C3 手动模式但数字非法（脏数据）时被拒，提示可改回自动',
  /自动估算/.test(validateMember({ ...BASE, dailyEnergyMode: 'manual', dailyEnergyManual: '' }) ?? ''),
  `提示：${validateMember({ ...BASE, dailyEnergyMode: 'manual', dailyEnergyManual: '' })}`,
);

w('');
w('=== D. 每天吃几餐：只记录，不参与计算 ===');
w('');

for (const v of MEALS_PER_DAY_OPTIONS) {
  check(
    `D1 餐数 ${v} 原样保留`,
    normalizeMealsPerDay(v) === v,
    `normalizeMealsPerDay(${v}) = ${normalizeMealsPerDay(v)}`,
  );
}

for (const v of [1, 7, 0, -1, 'x', null, undefined, 3.5, '', 'abc', NaN, {}]) {
  check(
    `D2 非法餐数 ${JSON.stringify(v) ?? String(v)} 回退默认 ${MEALS_PER_DAY_DEFAULT}`,
    normalizeMealsPerDay(v) === MEALS_PER_DAY_DEFAULT,
    `normalizeMealsPerDay(${JSON.stringify(v) ?? String(v)}) = ${normalizeMealsPerDay(v)}`,
  );
}

// 存储被手工改过时（比如 "4" 这种数字字符串）宁可救回来，也不要因类型不对就丢设置
check(
  'D2b 数字字符串 "4" 被宽容接受为 4（救回被改过的存储，而不是丢掉）',
  normalizeMealsPerDay('4') === 4,
  `normalizeMealsPerDay("4") = ${normalizeMealsPerDay('4')}`,
);

// 「每日能量 ÷ 餐数」的机械除法在本轮被明确禁止：源码里不得出现这种写法。
const divisionSmell = [
  /mealsPerDay\s*[*/]/,
  /\/\s*settings\.mealsPerDay/,
  /dailyEnergy[^\n]{0,40}\/\s*meal/i,
].filter((re) => re.test(appSrc) || re.test(nutritionSrc));

check(
  'D3 源码里没有「每日能量 ÷ 餐数」这类机械除法',
  divisionSmell.length === 0,
  divisionSmell.length === 0
    ? 'app.js / nutrition.js 均未命中'
    : `命中 ${divisionSmell.length} 处：${divisionSmell.map(String).join(' , ')}`,
);

check(
  'D4 餐数设置不被用来改动任何营养数值（只写 settings，不触发重算）',
  /mealsPerDay = n;[\s\S]{0,120}?renderMealsGroup\(\)/.test(appSrc)
    && !/mealsPerDay[\s\S]{0,200}?renderNutrition\(\)/.test(appSrc),
  '设置餐数后只调用 saveSettings() + renderMealsGroup()，没有 recompute / renderNutrition',
);

w('');
w('=== E. 宏量范围跟随「每日能量参考」（手动值优先） ===');
w('');

const autoRanges = macroRanges(auto.kcal);
const manualRanges = macroRanges(manual.kcal);

check(
  'E1 自动模式下，碳水范围与 healthMetrics 的算法一致（回归）',
  Math.abs(autoRanges.carbsLow - metrics.carbsLow) < 1e-9
    && Math.abs(autoRanges.carbsHigh - metrics.carbsHigh) < 1e-9
    && Math.abs(autoRanges.fatLow - metrics.fatLow) < 1e-9
    && Math.abs(autoRanges.fatHigh - metrics.fatHigh) < 1e-9,
  `自动碳水 ${fmt(autoRanges.carbsLow)}–${fmt(autoRanges.carbsHigh)} g `
  + `＝ healthMetrics ${fmt(metrics.carbsLow)}–${fmt(metrics.carbsHigh)} g`,
);

check(
  'E2 手动设定 1800 后，碳水 / 脂肪范围按 1800 算，不再按自动值',
  Math.abs(manualRanges.carbsLow - (1800 * 0.45) / 4) < 1e-9
    && Math.abs(manualRanges.fatHigh - (1800 * 0.35) / 9) < 1e-9
    && Math.abs(manualRanges.carbsLow - autoRanges.carbsLow) > 1,
  `手动 1800 → 碳水 ${fmt(manualRanges.carbsLow)}–${fmt(manualRanges.carbsHigh)} g`
  + `／自动 ${fmt(auto.kcal)} → 碳水 ${fmt(autoRanges.carbsLow)}–${fmt(autoRanges.carbsHigh)} g`,
);

check(
  'E3 拿不到每日能量时不给宏量范围，而不是拿别的数顶替',
  macroRanges(null) === null && macroRanges(0) === null && macroRanges(NaN) === null,
  `macroRanges(null)=${macroRanges(null)} macroRanges(0)=${macroRanges(0)} macroRanges(NaN)=${macroRanges(NaN)}`,
);

w('');
w('=== F. 计算层未被本轮改动（回归） ===');
w('');

const cases = [
  { name: '男30/175/70/久坐', gender: 'male', age: 30, heightCm: 175, weightKg: 70, activityLevel: 'sedentary' },
  { name: '女45/160/55/中等', gender: 'female', age: 45, heightCm: 160, weightKg: 55, activityLevel: 'moderate' },
];
for (const c of cases) {
  const m = healthMetrics(c);
  const h = c.heightCm / 100;
  const expectBmi = c.weightKg / (h * h);
  const expectBmr = 10 * c.weightKg + 6.25 * c.heightCm - 5 * c.age + (c.gender === 'male' ? 5 : -161);
  const expectTdee = expectBmr * m.activity.factor;
  check(
    `F1 ${c.name} 的 BMI / BMR / TDEE 与手算一致`,
    Math.abs(m.bmi - expectBmi) < 1e-9
      && Math.abs(m.bmr - expectBmr) < 1e-9
      && Math.abs(m.tdee - expectTdee) < 1e-9,
    `BMI ${fmt(m.bmi, 2)}（手算 ${fmt(expectBmi, 2)}）`
    + ` BMR ${fmt(m.bmr)}（手算 ${fmt(expectBmr)}）`
    + ` TDEE ${fmt(m.tdee)}（手算 ${fmt(expectTdee)}）`,
  );
}

const foodsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/foods.json'), 'utf8'));
const foodIndex = buildIndex(foodsRaw);
const recipesRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/recipes.json'), 'utf8'));
const sample = recipesRaw.recipes
  .filter((r) => ['西红柿炒鸡蛋', '红烧茄子', '清蒸南瓜'].includes(r.name));
const ests = sample.map((r) => ({ recipe: r, est: estimateRecipe(r, foodIndex, foodsRaw.unitConversions) }));
const stapleNutri = nutritionOf('rice-cooked', 750, foodIndex);
const summary = summarizeMeal(ests, { key: 'rice-cooked', grams: 750, nutri: stapleNutri }, 5);

let handTotal = stapleNutri.kcal;
for (const e of ests) handTotal += e.est.total.kcal;

check(
  'F2 这桌菜合计 = 各道菜 + 主食（逐位相加，未按人数折算）',
  Math.abs(summary.total.kcal - handTotal) < 1e-9,
  `summary ${fmt(summary.total.kcal)} kcal ／ 手加 ${fmt(handTotal)} kcal`,
);

check(
  'F3 人均 = 合计 ÷ 人数（纯数学平均，未做任何份量分配）',
  Math.abs(summary.perPerson.kcal - summary.total.kcal / 5) < 1e-9,
  `人均 ${fmt(summary.perPerson.kcal)} kcal ＝ ${fmt(summary.total.kcal)} ÷ 5`,
);

w('');
w('=== G. 界面与文档口径扫描（局部改了、整体没跟上 = 失败） ===');
w('');

/**
 * 这些是「把每天和这一顿混为一谈」的旧口径词，
 * 重构后不应再出现在界面、样式说明和文档里。
 */
const BANNED = [
  { re: /维持能量/, why: '旧术语，已改为「每日能量参考」' },
  { re: /全家的量/, why: '暗示实际摄入，已改为「准备量」' },
  { re: /实际吃掉的量|全家实际吃掉/, why: '暗示实际摄入' },
  { re: /整顿饭\s*<\/span>|>\s*整顿饭\s*</, why: '旧面板列头，已改为「按菜谱用量的合计」' },
  { re: /按菜谱所写用量（整锅）/, why: '旧口径，已改为「整份估算」' },
];

const SCAN_FILES = [
  'app.js', 'index.html', 'styles.css', 'specs.md', 'README.md',
];
for (const file of SCAN_FILES) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const { re, why } of BANNED) {
    check(
      `G1 ${file} 不含旧口径 ${String(re)}`,
      !re.test(src),
      re.test(src) ? `仍命中：${why}` : '未命中',
    );
  }
}

// 三概念必须各自出现，且「实际摄入」明确写成不知道
check(
  'G2 界面明确写出「每日能量参考 / 这桌菜估算」两层语义',
  /每日能量参考/.test(appSrc) && /这桌菜估算/.test(htmlSrc),
  'app.js 含「每日能量参考」，index.html 含「这桌菜估算」',
);

check(
  'G3 界面明确声明不伪造「实际摄入」',
  /实际吃进去|实际摄入/.test(htmlSrc),
  'index.html 的边界说明里已声明',
);

// ------------------------------------------------------------------

const report = [
  '营养语义自检报告',
  `生成方式：node tools/check-nutrition-semantics.mjs`,
  '',
  ...out,
  '',
  '=== 汇总 ===',
  `通过 ${pass} ／ 失败 ${fail}`,
].join('\n');

fs.mkdirSync(path.join(ROOT, '.tmpfiles'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmpfiles', '_nutrition_semantics.txt'), report, 'utf8');
console.log(report);

if (fail > 0) {
  console.error(`\n有 ${fail} 条断言没通过，详见 .tmpfiles/_nutrition_semantics.txt`);
  process.exit(1);
}
