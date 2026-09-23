/* ============================================================
   本文件由 tools/build-miniprogram.mjs 自动生成，请勿手工编辑。
   源头：nutrition.js
   重新生成：node tools/build-miniprogram.mjs
   CommonJS 版本，导出 28 项
   ============================================================ */

/* ============================================================
   营养估算引擎
   ------------------------------------------------------------
   设计原则：**营养数字只来自数据或公式，不由程序凭空生成。**

   - 每个食材的营养值来自 data/foods.json（溯源自 USDA FoodData Central，CC0）
   - 健康指标（BMI / BMR / TDEE）来自明确的公开公式
   - 无法确定重量的食材一律标记为「未能识别」，计入覆盖率，绝不猜

   本模块不发起任何网络请求，纯粹基于本地数据进行计算。
   ============================================================ */

/** 中文数字 -> 阿拉伯数字（食材用量里常出现） */
const CN_NUM = { 半: 0.5, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 明确表示重量的单位及其到克的换算 */
const WEIGHT_UNITS = {
  g: 1, 克: 1, 公克: 1,
  kg: 1000, 千克: 1000, 公斤: 1000,
  // 毫升按 1 g/ml 处理（水）。油类实际密度约 0.92，会略微高估油的热量，
  // 这是有意的保守取舍：宁可略微高估，也不低估。
  ml: 1, 毫升: 1, cc: 1,
  l: 1000, 升: 1000,
};

/** 模糊量词：出现这些且没有明确数字时，判为无法识别，不猜重量 */
const VAGUE_RE = /适量|少许|少量|若干|按需|酌情|随意|看个人|根据个人|自备|视情况|凭感觉/;

/**
 * 上游数据里有少量条目其实不是食材，而是解释性文字
 * （例如「水的体积是米饭的体积的 9-12 倍。」）。
 * 这类条目会被排除出覆盖率分母——它们本来就不是食材，
 * 算进「未识别食材」会低报覆盖率，对用户不诚实。
 */
const NOTE_RE = /容量|体积|可以食用|能够食用|的倍数|分钟|足够一人|个人经验|玻璃|陶瓷容器|密封容器/;

function looksLikeNote(raw) {
  return NOTE_RE.test(String(raw));
}

/**
 * 油炸用油：用量远超一顿饭的实际摄入。
 * 一整锅油不可能被吃掉，全额计入会算出「一道菜两万大卡」这种离谱结果。
 * 超过阈值的油不计入营养，并把这道菜标成「部分估算」，
 * 宁可略微低估，也不能给出一个明显错误的数字。
 */
const OIL_KEYS = new Set(['oil', 'olive-oil', 'sesame-oil', 'lard']);
const OIL_AS_FRYING_MEDIUM_G = 150;

/** 把一段文本里的中文数字统一成阿拉伯数字 */
function normalizeNumbers(text) {
  return text.replace(/[半一二两三四五六七八九十]/g, (c) => String(CN_NUM[c]));
}

/**
 * 从用量文本里解析出克数。
 * 优先取明确重量，其次按「个数单位 × 单重」折算。
 * @returns {{grams: number, how: string} | null}
 */
function parseGrams(text, foodKey, unitConversions) {
  const t = normalizeNumbers(String(text));

  const WEIGHT_ALT = '千克|公斤|kg|公克|克|g|毫升|ml|cc|升|l';
  const COUNT_ALT = '个|只|根|瓣|颗|片|段|条|块|把|支|张|听|罐|包|袋|勺|汤匙|茶匙|碗|杯|斤|两';

  /** 个数单位的单重：先按食材细分，再退回通用单位 */
  const unitWeight = (unit) => {
    const perItem = unitConversions.perItem[foodKey];
    if (perItem) return perItem;
    return unitConversions.byUnit[unit] ?? null;
  };

  // 1) 明确重量 + 区间（取中值，例如「10-15 g」按 12.5 g）
  let m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*[-~～至]\\s*(\\d+(?:\\.\\d+)?)\\s*(${WEIGHT_ALT})(?![a-zA-Z])`, 'i'));
  if (m) {
    const unit = WEIGHT_UNITS[m[3].toLowerCase()] ?? WEIGHT_UNITS[m[3]] ?? 1;
    return { grams: ((parseFloat(m[1]) + parseFloat(m[2])) / 2) * unit, how: 'weight-range' };
  }

  // 2) 明确重量 + 单值
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${WEIGHT_ALT})(?![a-zA-Z])`, 'i'));
  if (m) {
    const unit = WEIGHT_UNITS[m[2].toLowerCase()] ?? WEIGHT_UNITS[m[2]] ?? 1;
    return { grams: parseFloat(m[1]) * unit, how: 'weight' };
  }

  // 3) 个数单位 + 区间（「3~4 斤」这类，同样取中值，不能只取上限）
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*[-~～至]\\s*(\\d+(?:\\.\\d+)?)\\s*(${COUNT_ALT})`));
  if (m) {
    const w = unitWeight(m[3]);
    if (w) return { grams: ((parseFloat(m[1]) + parseFloat(m[2])) / 2) * w, how: 'count-range' };
  }

  // 4) 个数单位 + 单值
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${COUNT_ALT})`));
  if (m) {
    const w = unitWeight(m[2]);
    if (w) return { grams: parseFloat(m[1]) * w, how: 'count' };
  }

  return null;
}

/**
 * 在食材文本里认出是哪一种食物。
 * 用「最长别名优先」，避免「老豆腐」被「豆腐」抢先匹配。
 * @returns {string | null} 食物 key
 */
function matchFood(text, index, aliasesByLength) {
  const t = String(text);
  for (const alias of aliasesByLength) {
    if (t.includes(alias)) return index.get(alias);
  }
  return null;
}

/** 建立别名索引；按长度降序，保证最长匹配优先 */
function buildIndex(foodsData) {
  const index = new Map();
  for (const f of foodsData.foods) {
    for (const n of f.names) index.set(n, f.key);
  }
  const aliasesByLength = [...index.keys()].sort((a, b) => b.length - a.length);
  return { index, aliasesByLength, byKey: new Map(foodsData.foods.map((f) => [f.key, f])) };
}

/**
 * 解析单条食材。
 * @returns {{raw, foodKey, grams, status}} status: ok | no-food | no-amount
 */
function parseIngredient(text, foodIndex, unitConversions) {
  const foodKey = matchFood(text, foodIndex.index, foodIndex.aliasesByLength);
  if (!foodKey) return { raw: text, foodKey: null, grams: 0, status: 'no-food' };

  const g = parseGrams(text, foodKey, unitConversions);
  if (!g || !(g.grams > 0)) {
    // 有明确模糊量词的，说明确实无从判断；没有数字的同样如此
    return { raw: text, foodKey, grams: 0, status: VAGUE_RE.test(text) ? 'vague' : 'no-amount' };
  }
  // 单条食材重量上限做个保护，避免「份数」之类被误读成克数
  if (g.grams > 5000) return { raw: text, foodKey, grams: 0, status: 'no-amount' };
  return { raw: text, foodKey, grams: g.grams, status: 'ok' };
}

/** 按克数算营养 */
function nutritionOf(foodKey, grams, foodsData) {
  const food = foodsData.byKey.get(foodKey);
  if (!food) return null;
  const k = grams / 100;
  return {
    kcal: food.per100g.kcal * k,
    protein: food.per100g.protein * k,
    fat: food.per100g.fat * k,
    carbs: food.per100g.carbs * k,
  };
}

const ZERO = { kcal: 0, protein: 0, fat: 0, carbs: 0 };

function addNutri(a, b) {
  return {
    kcal: a.kcal + b.kcal,
    protein: a.protein + b.protein,
    fat: a.fat + b.fat,
    carbs: a.carbs + b.carbs,
  };
}

function divNutri(a, n) {
  if (!(n > 0)) return { ...ZERO };
  return { kcal: a.kcal / n, protein: a.protein / n, fat: a.fat / n, carbs: a.carbs / n };
}

/**
 * 估算一道菜的营养。
 * 只累加能识别出重量的食材；其余全部计入 coverage，供界面如实展示。
 * @returns {{total, items, matched, totalCount, status}} status: full | partial | none
 */
function estimateRecipe(recipe, foodIndex, unitConversions) {
  const items = [];
  let noteCount = 0;
  let fryingOil = 0;

  for (const raw of recipe.ingredients) {
    // 不是食材的解释性文字：不参与营养，也不算进覆盖率分母
    if (looksLikeNote(raw)) { noteCount++; continue; }

    const p = parseIngredient(raw, foodIndex, unitConversions);
    if (p.status !== 'ok') {
      items.push({ ...p, nutri: null });
      continue;
    }

    // 一整锅油炸用油不可能被吃完，不计入；标出来让界面如实说明
    if (OIL_KEYS.has(p.foodKey) && p.grams > OIL_AS_FRYING_MEDIUM_G) {
      fryingOil++;
      items.push({ ...p, status: 'frying-oil', nutri: null });
      continue;
    }

    items.push({ ...p, nutri: nutritionOf(p.foodKey, p.grams, foodIndex) });
  }

  const totalCount = items.length;
  const matched = items.filter((i) => i.nutri).length;
  let total = { ...ZERO };
  for (const i of items) if (i.nutri) total = addNutri(total, i.nutri);

  const status = matched === 0 ? 'none' : matched === totalCount ? 'full' : 'partial';

  return { total, items, matched, totalCount, status, noteCount, fryingOil };
}

/**
 * 汇总一餐。
 * @param recipes 估算好的菜品数组 [{recipe, est}]
 * @param staple  {key, grams, nutri} | null
 * @param people  用餐人数
 */
function summarizeMeal(recipes, staple, people) {
  let total = { ...ZERO };
  let matchedDishes = 0;
  let fullDishes = 0;
  let countedDishes = 0;

  for (const { est } of recipes) {
    countedDishes++;
    if (est.status === 'full') fullDishes++;
    if (est.status !== 'none') matchedDishes++;
    total = addNutri(total, est.total);
  }
  if (staple && staple.nutri) total = addNutri(total, staple.nutri);

  return {
    total,
    perPerson: divNutri(total, people),
    dishes: countedDishes,
    dishesWithData: matchedDishes,
    dishesFull: fullDishes,
    hasStaple: !!(staple && staple.nutri),
  };
}

// ==================================================================
// 健康参考：全部来自公开公式，不涉及任何推测
// ==================================================================

/** BMI 分级（中国成年人参考标准） */
function bmiCategory(bmi) {
  if (bmi < 18.5) return { label: '偏瘦', hint: '低于 18.5' };
  if (bmi < 24) return { label: '正常', hint: '18.5 – 23.9' };
  if (bmi < 28) return { label: '超重', hint: '24.0 – 27.9' };
  return { label: '肥胖', hint: '≥ 28.0' };
}

const ACTIVITY_LEVELS = [
  { key: 'sedentary', label: '久坐', factor: 1.2, hint: '几乎不运动，以久坐为主' },
  { key: 'light', label: '轻度', factor: 1.375, hint: '每周轻度运动 1–3 次' },
  { key: 'moderate', label: '中等', factor: 1.55, hint: '每周中等强度运动 3–5 次' },
  { key: 'active', label: '高活动', factor: 1.725, hint: '每周高强度运动 6–7 次' },
];

/**
 * 由**一位家庭成员**的资料算出各项参考值。
 * 每个成员独立计算，不把全家混成一个数字。
 *
 * BMI  = 体重 / 身高²
 * BMR  = Mifflin-St Jeor
 * TDEE = BMR × 活动系数
 *
 * @param {{gender, age, heightCm, weightKg, activityLevel}} member
 * @returns null 表示资料不完整
 */
function healthMetrics(member) {
  const age = Number(member?.age);
  const height = Number(member?.heightCm);
  const weight = Number(member?.weightKg);
  const gender = member?.gender;
  const activity = ACTIVITY_LEVELS.find((a) => a.key === member?.activityLevel);

  if (!(age > 0 && height > 0 && weight > 0) || !gender || !activity) return null;

  const m = height / 100;
  const bmi = weight / (m * m);

  // Mifflin-St Jeor
  const bmr = 10 * weight + 6.25 * height - 5 * age + (gender === 'male' ? 5 : -161);
  const tdee = bmr * activity.factor;

  return {
    bmi,
    bmiCategory: bmiCategory(bmi),
    bmr,
    tdee,
    activity,
    // 蛋白质：普通成年人约 0.8 g/kg/天
    proteinG: 0.8 * weight,
    // 碳水 45%–65% 总能量；1 g 碳水 ≈ 4 kcal
    carbsLow: (tdee * 0.45) / 4,
    carbsHigh: (tdee * 0.65) / 4,
    // 脂肪 20%–35% 总能量；1 g 脂肪 ≈ 9 kcal
    fatLow: (tdee * 0.2) / 9,
    fatHigh: (tdee * 0.35) / 9,
  };
}

// ------------------------------------------------------------------
// 每日能量参考：每位成员一份，来源可以是自动估算或用户自己设定
// ------------------------------------------------------------------

/**
 * 两种来源必须清晰可辨，不允许混成一个数字。
 *
 * auto   = 用本人资料按公开公式算出的粗略值
 * manual = 用户自己填的数字，程序不对它做任何健康判断
 */
const ENERGY_SOURCE = {
  auto: { key: 'auto', label: '自动估算' },
  manual: { key: 'manual', label: '自己设定' },
};

/**
 * 手动输入的**技术防呆**范围：只用来挡住明显无效的输入
 * （多打一个 0、填成负数、误填成年份之类）。
 *
 * 这不是营养学标准，也不能用来判断用户设的值是否健康——
 * 用户填多少，就按多少算。
 */
const DAILY_ENERGY_LIMITS = { min: 500, max: 8000 };

/**
 * 一位成员的「每日能量参考」。
 *
 * 语义：**一整天 24 小时全部摄入**的参考量（含早、午、晚及其他），
 * 不是「这一顿该吃多少」，也不是「必须吃到这个数」。
 *
 * 手动模式下如果数字不可用，返回 kcal = null，**不回退到自动值**：
 * 来源一旦静默改变，用户就无法再相信这个数字是从哪来的。
 * （正常情况下保存时已校验，这里是防御性兜底。）
 *
 * @returns {{mode: string, label: string, kcal: number|null, hasValue: boolean}}
 */
function dailyEnergyReference(member, metrics) {
  const mode = member?.dailyEnergyMode === 'manual' ? 'manual' : 'auto';
  const label = ENERGY_SOURCE[mode].label;

  if (mode === 'manual') {
    const n = Number(member?.dailyEnergyManual);
    const ok = Number.isFinite(n)
      && n >= DAILY_ENERGY_LIMITS.min && n <= DAILY_ENERGY_LIMITS.max;
    return { mode, label, kcal: ok ? n : null, hasValue: ok };
  }

  const kcal = Number.isFinite(metrics?.tdee) ? metrics.tdee : null;
  return { mode, label, kcal, hasValue: kcal != null };
}

/**
 * 以「每日能量参考」为基准的碳水 / 脂肪范围。
 *
 * 这两个范围本来就定义为「占总能量的百分比」，所以基准换成用户
 * 自己设定的值以后，它们必须跟着换——否则会出现
 * 「每日能量设 1800、碳水却按自动算出的 2300 算」的口径冲突。
 *
 * 只是范围参考，不是「必须吃到这个克数」。
 * 蛋白质按体重算（见 healthMetrics.proteinG），与能量来源无关。
 */
function macroRanges(dailyEnergyKcal) {
  const kcal = Number(dailyEnergyKcal);
  if (!Number.isFinite(kcal) || kcal <= 0) return null;
  return {
    // 碳水 45% – 65% 总能量；1 g 碳水 ≈ 4 kcal
    carbsLow: (kcal * 0.45) / 4,
    carbsHigh: (kcal * 0.65) / 4,
    // 脂肪 20% – 35% 总能量；1 g 脂肪 ≈ 9 kcal
    fatLow: (kcal * 0.2) / 9,
    fatHigh: (kcal * 0.35) / 9,
  };
}

// ------------------------------------------------------------------
// 每天通常吃几餐
// ------------------------------------------------------------------

/**
 * 「每天通常吃几餐」的可选值。
 *
 * 这个字段**只用于记录和展示饮食习惯**：
 * 不参与计算，不做「每日能量 ÷ 餐数 = 每餐该吃多少」，
 * 也不给 2 / 4 / 5 / 6 餐编造任何能量比例。
 */
const MEALS_PER_DAY_OPTIONS = [2, 3, 4, 5, 6];
const MEALS_PER_DAY_DEFAULT = 3;

/** 把存储里的值规范成合法餐数，不合法一律回退默认值 */
function normalizeMealsPerDay(value) {
  const n = Number(value);
  return MEALS_PER_DAY_OPTIONS.includes(n) ? n : MEALS_PER_DAY_DEFAULT;
}

// ------------------------------------------------------------------
// 家庭成员：字段取值范围与校验
// ------------------------------------------------------------------

const MAX_MEMBERS = 8;

/** 各字段的合理区间。表单校验和读取本地存储时共用同一份，避免两处规则不一致。 */
const MEMBER_LIMITS = {
  age: { min: 10, max: 100, label: '年龄', unit: '岁' },
  heightCm: { min: 80, max: 230, label: '身高', unit: 'cm' },
  weightKg: { min: 25, max: 200, label: '体重', unit: 'kg' },
};

const NAME_MAX = 12;

/**
 * 校验一位成员。返回 null 表示通过，否则返回给用户看的错误说明。
 * @returns {string | null}
 */
function validateMember(m) {
  const name = String(m?.name ?? '').trim();
  if (!name) return '请填写称呼';
  if (name.length > NAME_MAX) return `称呼不要超过 ${NAME_MAX} 个字`;
  if (m?.gender !== 'male' && m?.gender !== 'female') return '请选择性别';
  if (!ACTIVITY_LEVELS.some((a) => a.key === m?.activityLevel)) return '请选择活动水平';

  for (const [field, lim] of Object.entries(MEMBER_LIMITS)) {
    const v = Number(m?.[field]);
    if (!Number.isFinite(v) || v <= 0) return `请填写${lim.label}`;
    if (v < lim.min || v > lim.max) {
      return `${lim.label}请填 ${lim.min} – ${lim.max} ${lim.unit}`;
    }
  }

  // 每日能量参考：只有「自己设定」才需要数字。
  //
  // 这个判断必须严格限定在 manual 分支内——老版本存下来的成员没有
  // dailyEnergyMode 字段，一旦在这里被拒，normalizeMember() 会把整条
  // 成员当作脏数据丢掉，用户升级后会发现家庭成员全没了。
  if (m?.dailyEnergyMode === 'manual') {
    const v = Number(m?.dailyEnergyManual);
    if (!Number.isFinite(v) || v <= 0) {
      return '请填写每日能量参考，或者改回「自动估算」';
    }
    if (v < DAILY_ENERGY_LIMITS.min || v > DAILY_ENERGY_LIMITS.max) {
      return `每日能量参考请填 ${DAILY_ENERGY_LIMITS.min} – ${DAILY_ENERGY_LIMITS.max} kcal`;
    }
  }
  return null;
}

/** 普通成年人日常膳食参考（中国居民膳食指南的常识性条目，非个人化处方） */
const DIET_REFERENCE = [
  { item: '新鲜蔬菜', amount: '300 – 500 g' },
  { item: '水果', amount: '200 – 350 g' },
  { item: '谷物', amount: '200 – 300 g' },
  { item: '全谷物 / 杂豆', amount: '50 – 150 g' },
  { item: '奶及奶制品', amount: '300 ml 以上' },
  { item: '鱼、禽、蛋、瘦肉', amount: '120 – 200 g' },
  { item: '烹调油', amount: '25 – 30 g' },
  { item: '盐', amount: '不超过 5 g' },
  { item: '添加糖', amount: '不超过 50 g，最好 25 g 以下' },
];

// ==================================================================
// 展示格式化
// ==================================================================

function fmt(n, digits = 0) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** 覆盖率文案：只说清事实，不夸大精度 */
function coverageText(matched, total) {
  return `已识别 ${matched} / ${total} 项食材`;
}

const STATUS_TEXT = {
  full: '已估算',
  partial: '部分估算',
  none: '暂无完整估算',
};

module.exports = {
  looksLikeNote,
  parseGrams,
  matchFood,
  buildIndex,
  parseIngredient,
  nutritionOf,
  addNutri,
  divNutri,
  estimateRecipe,
  summarizeMeal,
  bmiCategory,
  healthMetrics,
  dailyEnergyReference,
  macroRanges,
  normalizeMealsPerDay,
  validateMember,
  fmt,
  coverageText,
  ACTIVITY_LEVELS,
  ENERGY_SOURCE,
  DAILY_ENERGY_LIMITS,
  MEALS_PER_DAY_OPTIONS,
  MEALS_PER_DAY_DEFAULT,
  MAX_MEMBERS,
  MEMBER_LIMITS,
  NAME_MAX,
  DIET_REFERENCE,
  STATUS_TEXT,
};
