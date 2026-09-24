/* ============================================================
   小程序端：设置结构与归一化（纯逻辑）
   ------------------------------------------------------------
   移植自 Web 版 app.js 的 DEFAULT_SETTINGS / loadSettings / normalizeMember /
   dedupeKeywords，基线提交 deabc45。**Web 版改动这些函数时，这里必须同步。**

   本文件不出现任何 wx. 调用，因此可以在 Node 里直接 require 做自动化断言。
   真正的读写存储在 lib/store.js。

   语义与 Web 版完全一致，包括：
   - 新增字段一律「读不到就用默认值」，不做一次性迁移写入
   - 老版本的单份 healthProfile 迁移成一位成员
   - 每日能量的判断严格限定在 manual 分支内，避免老成员被整条丢弃
   ============================================================ */

const {
  MAX_MEMBERS,
  NAME_MAX,
  ACTIVITY_LEVELS,
  DAILY_ENERGY_LIMITS,
  MEALS_PER_DAY_DEFAULT,
  normalizeMealsPerDay,
  validateMember,
} = require('./nutrition.js');

/** 与 Web 版共用同一个键名：将来若做数据迁移，不需要翻译结构 */
const SETTINGS_KEY = 'what-should-we-eat-today.settings';

/** 每餐菜品数量（荤素 1:1，所以每边各一半） */
const MEAL_SIZES = [2, 4, 6, 8];
/** 用餐人数可选值 */
const PEOPLE = [1, 2, 3, 4, 5, 6, 7, 8];
/** 没有家庭成员资料时的默认用餐人数 */
const DEFAULT_DINERS = 2;
/** 每人默认主食量（克，熟重） */
const STAPLE_PER_PERSON = 150;

const MENU_PHRASE = { 1: '一荤一素', 2: '两荤两素', 3: '三荤三素', 4: '四荤四素' };

/**
 * 「转发给朋友」共用的文案与落地路径。
 * 放在这里而不是各页面各写一份，避免两处标题走样。
 */
const SHARE_TITLE = '今天吃什么？';
const HOME_PATH = '/pages/index/index';

/**
 * 设置结构。
 *
 * 关于人数：只有**两个**事实源，且互不覆盖——
 *   members 描述「家里有谁」，currentMealHouseholdSize 描述「今天来几个」。
 *   后者为 null 时表示「跟着家庭成员走」，绝不把两者强绑成同一个数字。
 *
 * 关于餐数：mealsPerDay 是「每天通常吃几餐」，**只用于记录和展示**，
 *   与 mealSize（每餐几道菜）是两回事，且不参与任何能量计算。
 *
 * 关于开关：healthNutritionEnabled 默认 **false**。关闭时不显示也不计算任何
 *   营养/健康内容，但**不删除数据**，重新开启即恢复。
 */
const DEFAULT_SETTINGS = {
  mealSize: 2,
  healthNutritionEnabled: false,
  members: [],
  currentMealHouseholdSize: null,
  mealsPerDay: MEALS_PER_DAY_DEFAULT,
  blockedKeywords: [],
  staple: { key: 'rice-cooked', grams: null, auto: true },
};

let memberSeq = 0;

function newMemberId() {
  memberSeq += 1;
  return `member-${Date.now().toString(36)}-${memberSeq}`;
}

/** 去重（忽略大小写），保持原顺序与原始大小写 */
function dedupeKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const k of list) {
    const key = String(k).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/** 从各种脏输入里救回一位成员；救不回来返回 null */
function normalizeMember(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // 每日能量参考的来源，默认「自动估算」。
  // 老版本存下来的成员没有这两个字段，会落到 auto——
  // 这里刻意不报错、不拒绝，否则老数据会被整条丢掉。
  const manualRaw = Number(raw.dailyEnergyManual);
  const manualOk = Number.isFinite(manualRaw)
    && manualRaw >= DAILY_ENERGY_LIMITS.min && manualRaw <= DAILY_ENERGY_LIMITS.max;
  const energyMode = raw.dailyEnergyMode === 'manual' && manualOk ? 'manual' : 'auto';

  const m = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newMemberId(),
    name: String(raw.name == null ? '' : raw.name).trim().slice(0, NAME_MAX),
    gender: raw.gender === 'female' ? 'female' : 'male',
    age: Number(raw.age),
    heightCm: Number(raw.heightCm),
    weightKg: Number(raw.weightKg),
    activityLevel: ACTIVITY_LEVELS.some((a) => a.key === raw.activityLevel)
      ? raw.activityLevel : 'sedentary',
    dailyEnergyMode: energyMode,
    dailyEnergyManual: energyMode === 'manual' ? manualRaw : null,
    enabled: raw.enabled !== false,
  };
  // 存进来时就不合法的成员直接丢弃，避免界面上出现半残的条目
  return validateMember(m) === null ? m : null;
}

/**
 * 把存储里读到的任意值归一成一份可用设置。
 * raw 为 null / 损坏 / 老格式时都能给出可用结果，不抛异常。
 */
function normalizeSettings(raw) {
  const base = {
    ...DEFAULT_SETTINGS,
    members: [],
    blockedKeywords: [],
    staple: { ...DEFAULT_SETTINGS.staple },
  };
  if (!raw || typeof raw !== 'object') return base;

  base.healthNutritionEnabled = raw.healthNutritionEnabled === true;
  base.mealSize = MEAL_SIZES.includes(Number(raw.mealSize))
    ? Number(raw.mealSize) : DEFAULT_SETTINGS.mealSize;
  // 每天吃几餐：老数据没有这个字段，回退默认值，不做一次性迁移写入
  base.mealsPerDay = normalizeMealsPerDay(raw.mealsPerDay);

  if (Array.isArray(raw.members)) {
    base.members = raw.members
      .map(normalizeMember)
      .filter(Boolean)
      .slice(0, MAX_MEMBERS);
  }

  // 旧版本存的是「单个健康资料」，迁移成一位成员，不丢用户已填的数据
  if (!base.members.length && raw.healthProfile && typeof raw.healthProfile === 'object') {
    const legacy = normalizeMember({
      name: '我',
      gender: raw.healthProfile.sex,
      age: raw.healthProfile.age,
      heightCm: raw.healthProfile.height,
      weightKg: raw.healthProfile.weight,
      activityLevel: raw.healthProfile.activity,
      enabled: true,
    });
    if (legacy) base.members = [legacy];
  }

  // 本次用餐人数：null 表示跟随家庭成员
  if (raw.currentMealHouseholdSize === null || raw.currentMealHouseholdSize === undefined) {
    base.currentMealHouseholdSize = null;
  } else {
    const n = Number(raw.currentMealHouseholdSize);
    base.currentMealHouseholdSize = PEOPLE.includes(n) ? n : null;
  }
  // 更旧版本只有 householdSize（纯手动人数），迁移成显式覆盖值
  if (base.currentMealHouseholdSize === null && PEOPLE.includes(Number(raw.householdSize))) {
    base.currentMealHouseholdSize = Number(raw.householdSize);
  }

  if (Array.isArray(raw.blockedKeywords)) {
    base.blockedKeywords = dedupeKeywords(
      raw.blockedKeywords
        .filter((k) => typeof k === 'string' && k.trim())
        .map((k) => k.trim()),
    );
  }

  const st = raw.staple;
  if (st && typeof st === 'object') {
    const grams = Number(st.grams);
    base.staple = {
      key: typeof st.key === 'string' ? st.key : DEFAULT_SETTINGS.staple.key,
      grams: Number.isFinite(grams) && grams >= 0 && grams <= 5000 ? grams : null,
      auto: st.auto !== false,
    };
  }

  return base;
}

/** 今天实际几个人吃：有显式指定就用指定的，否则跟随已启用成员数，再没有就用默认值 */
function effectiveDiners(settings) {
  if (settings.currentMealHouseholdSize != null) return settings.currentMealHouseholdSize;
  const on = settings.members.filter((m) => m.enabled).length;
  return on > 0 ? on : DEFAULT_DINERS;
}

module.exports = {
  SETTINGS_KEY,
  MEAL_SIZES,
  PEOPLE,
  DEFAULT_DINERS,
  STAPLE_PER_PERSON,
  MENU_PHRASE,
  SHARE_TITLE,
  HOME_PATH,
  DEFAULT_SETTINGS,
  newMemberId,
  dedupeKeywords,
  normalizeMember,
  normalizeSettings,
  effectiveDiners,
};
