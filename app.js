/* ============================================================
   今晚吃什么 · 前端逻辑
   ------------------------------------------------------------
   打开页面 → 随机给出荤素搭配的一桌菜 → 不满意就换一组 → 点卡片看做法。
   首页默认只显示菜，保持极简。

   「健康与营养」默认关闭。开启后才会出现：家庭成员、主食、
   本餐营养估算、健康参考。关闭时不显示也不参与计算，数据仍保留。

   全部设置存在浏览器本地，不上传、不需要账号。
   数据与计算全部在本地完成，运行时不请求任何第三方接口。
   ============================================================ */

import {
  buildIndex, estimateRecipe, nutritionOf, summarizeMeal,
  healthMetrics, validateMember, ACTIVITY_LEVELS, DIET_REFERENCE,
  MAX_MEMBERS, NAME_MAX,
  dailyEnergyReference, macroRanges,
  ENERGY_SOURCE, DAILY_ENERGY_LIMITS,
  MEALS_PER_DAY_OPTIONS, MEALS_PER_DAY_DEFAULT, normalizeMealsPerDay,
  STATUS_TEXT, coverageText, fmt,
} from './nutrition.js';

const RECIPES_URL = 'data/recipes.json';
const FOODS_URL = 'data/foods.json';

/** 随机菜单只从这两个池子里取菜，且始终 1:1 搭配 */
const MENU_ROLES = ['protein', 'vegetable'];

const ROLE_EMOJI = { protein: '🍖', vegetable: '🥬' };
const ROLE_LABEL = { protein: '荤菜', vegetable: '素菜' };

/** 每餐菜品数量的可选值（荤素 1:1，所以每边各一半） */
const MEAL_SIZES = [2, 4, 6, 8];
/** 用餐人数可选值 */
const PEOPLE = [1, 2, 3, 4, 5, 6, 7, 8];
/** 没有家庭成员资料时的默认用餐人数 */
const DEFAULT_DINERS = 2;
/** 每人默认主食量（克，熟重） */
const STAPLE_PER_PERSON = 150;

const MENU_PHRASE = { 1: '一荤一素', 2: '两荤两素', 3: '三荤三素', 4: '四荤四素' };

const ACTIVITY_LABEL = Object.fromEntries(ACTIVITY_LEVELS.map((a) => [a.key, a.label]));

const SETTINGS_KEY = 'what-should-we-eat-today.settings';

/**
 * 设置结构。
 *
 * 关于人数：只有**一个**事实源在描述「今天几个人吃」——
 *   members 描述「家里有谁」，currentMealHouseholdSize 描述「今天来几个」。
 *   后者为 null 时表示「跟着家庭成员走」，绝不把两者强绑成同一个数字。
 *
 * 关于餐数：mealsPerDay 是「每天通常吃几餐」，**只用于记录和展示**，
 *   与 mealSize（每餐几道菜）是两回事，且不参与任何能量计算。
 */
const DEFAULT_SETTINGS = {
  mealSize: 2,
  healthNutritionEnabled: false,
  members: [],
  /** 本次用餐人数；null = 自动（有已启用成员就用成员数，否则用 DEFAULT_DINERS） */
  currentMealHouseholdSize: null,
  /** 每天通常吃几餐：只记录饮食习惯，不做任何除法 */
  mealsPerDay: MEALS_PER_DAY_DEFAULT,
  blockedKeywords: [],
  staple: { key: 'rice-cooked', grams: null, auto: true },
};

/** 屏蔽关键词在哪些字段里查找（都是能描述「这道菜是什么」的字段） */
const BLOCK_FIELDS = ['name', 'categoryName', 'description'];

const state = {
  pools: { protein: [], vegetable: [] },
  available: { protein: [], vegetable: [] },
  current: null,
  total: 0,
  blocked: 0,
  foodIndex: null,
  foodsData: null,
  estimates: [],
  summary: null,
  /** 正在等待二次确认删除的成员 id */
  pendingDeleteId: null,
  /** 正在编辑的成员 id；null 表示新增 */
  editingMemberId: null,
};

const el = {};
for (const id of [
  'hero-sub', 'menu', 'reroll', 'hint', 'detail', 'detail-body', 'detail-close', 'detail-chip',
  'settings', 'settings-body', 'settings-open', 'settings-close',
  'size-group', 'size-note', 'people-group', 'people-note', 'people-follow',
  'kw-form', 'kw-input', 'kw-list', 'kw-clear', 'kw-err',
  'hn-toggle', 'hn-state', 'hn-sections',
  'meals-group', 'meals-note',
  'member-list', 'member-add', 'member-err',
  'member-health', 'diet-list',
  'staple-panel', 'staple-select', 'staple-amount', 'staple-note',
  'nutrition-panel', 'meal-nutri', 'meal-foot', 'meal-status',
  'member', 'member-form', 'member-title', 'member-close', 'member-cancel', 'member-save',
  'mf-name', 'mf-gender', 'mf-age', 'mf-height', 'mf-weight', 'mf-activity', 'mf-err',
  'mf-energy-mode', 'mf-energy-manual-field', 'mf-energy-manual',
]) {
  el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
}

let lastFocused = null;

// ------------------------------------------------------------------
// 小工具
// ------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function roleLabel(recipe) {
  return ROLE_LABEL[recipe.menuRole] || recipe.categoryName;
}

function categoryTag(recipe) {
  if (roleLabel(recipe) === recipe.categoryName) return '';
  return `<span class="card-cat">${esc(recipe.categoryName)}</span>`;
}

/** 健康与营养是否开启 */
function hnOn() {
  return settings.healthNutritionEnabled === true;
}

function numOrEmpty(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : '';
}

function dedupeKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const k of list) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

let memberSeq = 0;
function newMemberId() {
  memberSeq += 1;
  return `member-${Date.now().toString(36)}-${memberSeq}`;
}

// ------------------------------------------------------------------
// 设置读写
// ------------------------------------------------------------------

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
    name: String(raw.name ?? '').trim().slice(0, NAME_MAX),
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

function loadSettings() {
  const base = {
    ...DEFAULT_SETTINGS,
    members: [],
    blockedKeywords: [],
    staple: { ...DEFAULT_SETTINGS.staple },
  };
  let raw = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return base;
  }
  if (!raw) return base;

  try {
    const s = JSON.parse(raw);

    base.healthNutritionEnabled = s?.healthNutritionEnabled === true;
    base.mealSize = MEAL_SIZES.includes(Number(s?.mealSize))
      ? Number(s.mealSize) : DEFAULT_SETTINGS.mealSize;
    // 每天吃几餐：老数据没有这个字段，回退默认值，不做一次性迁移写入
    base.mealsPerDay = normalizeMealsPerDay(s?.mealsPerDay);

    if (Array.isArray(s?.members)) {
      base.members = s.members.map(normalizeMember).filter(Boolean).slice(0, MAX_MEMBERS);
    }

    // 旧版本存的是「单个健康资料」，迁移成一位成员，不丢用户已填的数据
    if (!base.members.length && s?.healthProfile && typeof s.healthProfile === 'object') {
      const legacy = normalizeMember({
        name: '我',
        gender: s.healthProfile.sex,
        age: s.healthProfile.age,
        heightCm: s.healthProfile.height,
        weightKg: s.healthProfile.weight,
        activityLevel: s.healthProfile.activity,
        enabled: true,
      });
      if (legacy) base.members = [legacy];
    }

    // 本次用餐人数：null 表示跟随家庭成员
    if (s?.currentMealHouseholdSize === null || s?.currentMealHouseholdSize === undefined) {
      base.currentMealHouseholdSize = null;
    } else {
      const n = Number(s.currentMealHouseholdSize);
      base.currentMealHouseholdSize = PEOPLE.includes(n) ? n : null;
    }
    // 更旧版本只有 householdSize（纯手动人数），迁移成显式覆盖值
    if (base.currentMealHouseholdSize === null && PEOPLE.includes(Number(s?.householdSize))) {
      base.currentMealHouseholdSize = Number(s.householdSize);
    }

    if (Array.isArray(s?.blockedKeywords)) {
      base.blockedKeywords = dedupeKeywords(
        s.blockedKeywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()),
      );
    }

    const st = s?.staple;
    if (st && typeof st === 'object') {
      const grams = Number(st.grams);
      base.staple = {
        key: typeof st.key === 'string' ? st.key : DEFAULT_SETTINGS.staple.key,
        grams: Number.isFinite(grams) && grams >= 0 && grams <= 5000 ? grams : null,
        auto: st.auto !== false,
      };
    }
  } catch {
    // 存储损坏时退回默认设置，不影响使用
  }
  return base;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('[今晚吃什么] 设置没能保存到本地：', e);
  }
}

let settings = loadSettings();

// ------------------------------------------------------------------
// 家庭成员 / 用餐人数
// ------------------------------------------------------------------

function enabledMembers() {
  return settings.members.filter((m) => m.enabled);
}

/**
 * 今天实际几个人吃。
 * 有显式指定就用指定的；否则跟随已启用成员数；再没有就用默认值。
 */
function effectiveDiners() {
  if (settings.currentMealHouseholdSize != null) return settings.currentMealHouseholdSize;
  const on = enabledMembers().length;
  return on > 0 ? on : DEFAULT_DINERS;
}

function findMember(id) {
  return settings.members.find((m) => m.id === id) ?? null;
}

// ------------------------------------------------------------------
// 屏蔽
// ------------------------------------------------------------------

/**
 * 唯一的屏蔽判断入口，荤素两个池子共用。
 * 中文按「包含即命中」：屏蔽「鱼」，清蒸鲈鱼 / 红烧鱼 / 鱼香肉丝 都算命中。
 */
function isBlocked(recipe) {
  if (!settings.blockedKeywords.length) return false;
  const haystack = [
    ...BLOCK_FIELDS.map((f) => recipe[f]),
    ...(recipe.ingredients || []),
    ...(recipe.tags || []),
  ].join('\n').toLowerCase();
  return settings.blockedKeywords.some((k) => haystack.includes(k.toLowerCase()));
}

function rebuildAvailable() {
  let blocked = 0;
  for (const role of MENU_ROLES) {
    state.available[role] = state.pools[role].filter((r) => {
      if (isBlocked(r)) { blocked++; return false; }
      return true;
    });
  }
  state.blocked = blocked;
}

function parseKeywordInput(raw) {
  return dedupeKeywords(String(raw).split(/[,，、\s]+/).map((k) => k.trim()).filter(Boolean));
}

// ------------------------------------------------------------------
// 随机菜单
// ------------------------------------------------------------------

function menuPlan() {
  const perRole = settings.mealSize / 2;
  const need = { protein: perRole, vegetable: perRole };
  const short = MENU_ROLES
    .map((role) => ({ role, need: need[role], have: state.available[role].length }))
    .filter((x) => x.have < x.need);
  return { need, short, ok: short.length === 0 };
}

function sampleDistinct(pool, n) {
  if (pool.length < n) return null;
  const idx = pool.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).map((i) => pool[i]);
}

function sameMenu(a, b) {
  if (!b || a.length !== b.length) return false;
  const key = (list) => list.map((r) => r.id).sort().join('|');
  return key(a) === key(b);
}

function pickMenu(prev) {
  if (!menuPlan().ok) return null;

  const build = () => {
    const dishes = [];
    for (const role of MENU_ROLES) {
      const picked = sampleDistinct(state.available[role], menuPlan().need[role]);
      if (!picked) return null;
      dishes.push(...picked);
    }
    if (new Set(dishes.map((d) => d.id)).size !== dishes.length) return null;
    return dishes;
  };

  const prevIds = new Set(prev ? prev.map((r) => r.id) : []);
  let last = null;

  // 先争取整桌全换掉（点「换一组」就是想看点不一样的）
  for (let i = 0; i < 60; i++) {
    const dishes = build();
    if (!dishes) return null;
    last = dishes;
    if (!dishes.some((d) => prevIds.has(d.id))) return dishes;
  }
  // 退让：至少整桌和上一桌不一样
  for (let i = 0; i < 60; i++) {
    const dishes = build();
    if (!dishes) return null;
    last = dishes;
    if (!sameMenu(dishes, prev)) return dishes;
  }
  return last;
}

function reroll() {
  const next = pickMenu(state.current);
  if (!next) { renderShortage(); return; }
  state.current = next;
  recompute();
  renderMenu();
  renderStaple();
  renderNutrition();
  el.hint.textContent = hintText();
}

// ------------------------------------------------------------------
// 营养估算
// ------------------------------------------------------------------

/** 主食当前使用多少克；自动模式下按本次用餐人数推算 */
function stapleGrams() {
  if (settings.staple.auto) return effectiveDiners() * STAPLE_PER_PERSON;
  return Number(settings.staple.grams) || 0;
}

/**
 * 重算每道菜的营养与整餐汇总。
 * 健康与营养关闭时不做任何计算——数据保留，只是不参与。
 */
function recompute() {
  if (!hnOn() || !state.foodIndex || !state.current) {
    state.estimates = [];
    state.summary = null;
    return;
  }
  const units = state.foodsData.unitConversions;
  state.estimates = state.current.map((recipe) => ({
    recipe,
    est: estimateRecipe(recipe, state.foodIndex, units),
  }));

  const grams = stapleGrams();
  const key = settings.staple.key;
  const staple = grams > 0
    ? { key, grams, nutri: nutritionOf(key, grams, state.foodIndex) }
    : null;

  state.summary = summarizeMeal(state.estimates, staple, effectiveDiners());
}

/** 每道菜的营养小结（详情页用） */
function recipeNutritionHtml(est) {
  if (est.status === 'none') {
    return `<section class="d-section"><h3>营养估算</h3>
      <p class="nutri-none">这道菜的食材没有可用的营养数据，暂时无法估算。</p></section>`;
  }
  const t = est.total;
  const notes = [];
  if (est.fryingOil) notes.push(`${est.fryingOil} 项油炸用油未计入`);
  if (est.noteCount) notes.push(`${est.noteCount} 条说明文字不计入`);

  return `
    <section class="d-section">
      <h3>营养估算</h3>
      <div class="nutri-box">
        <p class="nutri-scope">按菜谱所写用量的整份估算</p>
        <p class="nutri-kcal">约 ${fmt(t.kcal)} <span>kcal</span></p>
        <ul class="nutri-macros">
          <li><span>蛋白质</span><b>${fmt(t.protein, 1)} g</b></li>
          <li><span>碳水</span><b>${fmt(t.carbs, 1)} g</b></li>
          <li><span>脂肪</span><b>${fmt(t.fat, 1)} g</b></li>
        </ul>
        <p class="nutri-scope-note">这是这道菜谱写出来的整份量，不是某个人实际吃进去的量；<br>你实际买多少、实际下锅多少，营养值按同比例变化。</p>
        <p class="nutri-cov">
          <span class="nutri-tag nutri-tag--${est.status}">${STATUS_TEXT[est.status]}</span>
          ${esc(coverageText(est.matched, est.totalCount))}
          ${notes.length ? `<br>${esc(notes.join('；'))}` : ''}
        </p>
      </div>
    </section>`;
}

// ------------------------------------------------------------------
// 渲染：菜单
// ------------------------------------------------------------------

function cardVisual(recipe) {
  const emoji = ROLE_EMOJI[recipe.menuRole] || '🍽️';
  const fallback = `<span class="card-emoji-fallback" aria-hidden="true">${emoji}</span>`;
  if (!recipe.imageUrl) return `<span class="card-emoji">${fallback}</span>`;
  return `<span class="card-emoji">${fallback}`
    + `<img src="${esc(recipe.imageUrl)}" alt="" loading="lazy" onerror="this.remove()"></span>`;
}

function cardHtml(recipe, est) {
  const stars = recipe.difficulty
    ? `<span class="stars" title="预估烹饪难度">${'★'.repeat(recipe.difficulty)}</span>`
    : '';
  const preview = recipe.ingredients.slice(0, 4).join(' · ');

  // 热量只在开启健康与营养后才出现在卡片上；关闭时首页只有菜名。
  // 写「整份约」而不是裸数字：这是这道菜谱所写用量的整份估算，
  // 跟「某个人实际吃进去多少」是两回事。
  let kcal = '';
  if (hnOn() && est && est.status !== 'none') {
    kcal = `<span class="card-kcal">整份约 ${fmt(est.total.kcal)} kcal${est.status === 'partial' ? '*' : ''}</span>`;
  }

  return `
    <button class="card card--${esc(recipe.menuRole)}" type="button" data-id="${esc(recipe.id)}">
      ${cardVisual(recipe)}
      <span class="card-main">
        <span class="card-head">
          <span class="chip">${esc(roleLabel(recipe))}</span>
          ${categoryTag(recipe)}
          ${stars}
        </span>
        <span class="card-name">${esc(recipe.name)}</span>
        <span class="card-ing">${esc(preview)}</span>
      </span>
      <span class="card-side">
        ${kcal}
        <span class="card-arrow" aria-hidden="true">›</span>
      </span>
    </button>`;
}

function renderMenu() {
  const { current } = state;
  if (!current) return;
  el.menu.innerHTML = current
    .map((r) => cardHtml(r, state.estimates.find((e) => e.recipe === r)?.est))
    .join('');
  el.menu.setAttribute('aria-busy', 'false');
  el.reroll.disabled = false;
  el.heroSub.textContent = heroSubText();
}

function renderNotice(title, detail) {
  el.menu.innerHTML = `<div class="notice"><strong>${esc(title)}</strong>${detail}</div>`;
  el.menu.setAttribute('aria-busy', 'false');
  el.reroll.disabled = true;
}

function renderShortage() {
  const { need, short } = menuPlan();
  const detail = short
    .map((s) => `${ROLE_LABEL[s.role]}只剩 ${s.have} 道，需要 ${s.need} 道`)
    .join('；');
  renderNotice(
    `凑不出 ${settings.mealSize} 道菜`,
    `${settings.mealSize} 道需要 ${need.protein} 道荤菜 + ${need.vegetable} 道素菜，`
    + `但现在${detail}。`
    + '<br>减少几个屏蔽关键词，或者把每餐数量调小一点。',
  );
  el.hint.textContent = '屏蔽条件太严了';
  el.staplePanel.hidden = true;
  el.nutritionPanel.hidden = true;
}

function heroSubText() {
  const half = settings.mealSize / 2;
  return `${MENU_PHRASE[half] || `${settings.mealSize} 道菜`}，已经帮你配好了`;
}

function hintText() {
  let text = `已收录 ${state.total} 道家常菜谱 · 点卡片看做法`;
  if (state.blocked) text += ` · 已屏蔽 ${state.blocked} 道`;
  return text;
}

// ------------------------------------------------------------------
// 渲染：主食 + 本餐营养（仅在开启时显示）
// ------------------------------------------------------------------

function renderStaple() {
  if (!hnOn() || !state.foodsData) { el.staplePanel.hidden = true; return; }
  el.staplePanel.hidden = false;

  const staples = state.foodsData.foods.filter((f) => f.staple);
  el.stapleSelect.innerHTML = staples
    .map((f) => `<option value="${esc(f.key)}">${esc(f.names[0])}</option>`).join('');
  if (staples.some((f) => f.key === settings.staple.key)) {
    el.stapleSelect.value = settings.staple.key;
  } else {
    settings.staple.key = staples[0]?.key ?? settings.staple.key;
    el.stapleSelect.value = settings.staple.key;
  }
  el.stapleAmount.value = String(stapleGrams());

  const diners = effectiveDiners();
  const per = diners > 0 ? stapleGrams() / diners : 0;
  const food = state.foodIndex.byKey.get(settings.staple.key);
  // 说的是「准备量」而不是「吃掉的量」：这只是本次拿来算营养的数字，
  // 不代表每个人实际吃了多少，也不代表你一定按这个量下锅。
  el.stapleNote.textContent = stapleGrams() > 0
    ? `本次用于计算的主食准备量${settings.staple.auto ? `（按 ${diners} 人自动填）` : ''}；`
      + `人均 ${fmt(per)} g 是把总克数除以人数，不代表每个人吃了这么多。`
      + (food ? `　·　${food.usdaDescription}` : '')
    : '填 0 表示这顿不算主食';
}

function renderNutrition() {
  if (!hnOn()) { el.nutritionPanel.hidden = true; return; }
  const s = state.summary;
  if (!s) { el.nutritionPanel.hidden = true; return; }
  el.nutritionPanel.hidden = false;

  const dishes = s.dishes;
  const withData = s.dishesWithData;
  let status = 'full';
  if (withData === 0) status = 'none';
  else if (withData < dishes) status = 'partial';
  else if (s.dishesFull < dishes) status = 'partial';

  el.mealStatus.textContent = STATUS_TEXT[status];
  el.mealStatus.className = `panel-badge panel-badge--${status}`;

  const people = effectiveDiners();
  el.mealNutri.innerHTML = `
    <div class="ng-head">
      <span>按菜谱用量的合计</span>
      <span>÷ ${esc(String(people))} 人的数学平均</span>
    </div>
    <div class="ng-body">
      <div class="ng-col">
        <b class="ng-kcal">${fmt(s.total.kcal)}<i>kcal</i></b>
        <span class="ng-sub">蛋白 ${fmt(s.total.protein, 1)}g</span>
        <span class="ng-sub">碳水 ${fmt(s.total.carbs, 1)}g</span>
        <span class="ng-sub">脂肪 ${fmt(s.total.fat, 1)}g</span>
      </div>
      <div class="ng-col ng-col--hl">
        <b class="ng-kcal">${fmt(s.perPerson.kcal)}<i>kcal</i></b>
        <span class="ng-sub">蛋白 ${fmt(s.perPerson.protein, 1)}g</span>
        <span class="ng-sub">碳水 ${fmt(s.perPerson.carbs, 1)}g</span>
        <span class="ng-sub">脂肪 ${fmt(s.perPerson.fat, 1)}g</span>
      </div>
    </div>`;

  const parts = [`${dishes} 道菜`];
  if (s.hasStaple) {
    const f = state.foodIndex.byKey.get(settings.staple.key);
    parts.push(`${f ? f.names[0] : '主食'}准备量 ${fmt(stapleGrams())}g`);
  }
  const skipped = state.estimates.filter((e) => e.est.fryingOil).length;
  el.mealFoot.innerHTML = `按菜谱所写用量 + 本次主食准备量估算：${esc(parts.join(' + '))}`
    + `<br>${esc(String(withData))} / ${esc(String(dishes))} 道菜有可用营养数据`
    + (skipped ? `　·　${esc(String(skipped))} 道菜的油炸用油未计入` : '')
    + '<br>人均只是把合计除以人数，不代表每个人实际吃了相同份量。'
    + '<br>菜谱写多少就按多少算——既不是你实际买的量、实际下锅的量，也不是实际吃进去的量。';
}

// ------------------------------------------------------------------
// 渲染：设置面板
// ------------------------------------------------------------------

function radioGroupHtml(values, active, attr) {
  return values.map((n) => `
    <button class="s-size${n === active ? ' is-active' : ''}" type="button"
      role="radio" aria-checked="${n === active}" data-${attr}="${n}">${n}</button>`).join('');
}

function renderSizeGroup() {
  el.sizeGroup.innerHTML = radioGroupHtml(MEAL_SIZES, settings.mealSize, 'size');
  const half = settings.mealSize / 2;
  el.sizeNote.textContent = `当前：${MENU_PHRASE[half] || settings.mealSize + ' 道'}`
    + `（${half} 道荤菜 + ${half} 道素菜）`;
}

function renderPeopleGroup() {
  const diners = effectiveDiners();
  el.peopleGroup.innerHTML = radioGroupHtml(PEOPLE, diners, 'people');

  const on = enabledMembers().length;
  const overridden = settings.currentMealHouseholdSize != null;
  if (on > 0) {
    el.peopleNote.textContent = overridden && settings.currentMealHouseholdSize !== on
      ? `家庭成员 ${on} 人，本次按 ${diners} 人算`
      : `家庭成员 ${on} 人，本次按 ${diners} 人算`;
  } else {
    el.peopleNote.textContent = `当前 ${diners} 人　·　主食人均约 ${fmt(STAPLE_PER_PERSON)} g`;
  }
  // 只在「有成员可跟随」且当前是手动指定时才提供恢复入口
  el.peopleFollow.hidden = !(on > 0 && overridden);
}

/**
 * 每天通常吃几餐。
 * 只记录用户的饮食习惯，**不做任何计算**：
 * 既不拿每日能量除以餐数，也不给 2 / 4 / 5 / 6 餐编造能量比例。
 */
function renderMealsGroup() {
  el.mealsGroup.innerHTML = radioGroupHtml(MEALS_PER_DAY_OPTIONS, settings.mealsPerDay, 'meals');
  el.mealsNote.textContent = `当前记录：每天 ${settings.mealsPerDay} 餐`
    + '　·　只用来记录你的习惯，不参与任何能量计算';
}

function renderKeywords() {
  const list = settings.blockedKeywords;
  el.kwList.innerHTML = list.length
    ? list.map((k) => `
        <span class="s-chip">
          <span class="s-chip-text">${esc(k)}</span>
          <button class="s-chip-x" type="button" data-kw="${esc(k)}"
            aria-label="取消屏蔽 ${esc(k)}">×</button>
        </span>`).join('')
    : '<p class="s-empty">还没有屏蔽任何关键词</p>';
  el.kwClear.hidden = list.length === 0;
}

function renderHealthToggle() {
  const on = hnOn();
  el.hnToggle.setAttribute('aria-checked', String(on));
  el.hnToggle.classList.toggle('is-on', on);
  el.hnState.textContent = on ? '开启' : '关闭';
  el.hnSections.hidden = !on;
}

function memberMetaText(m) {
  return `${m.age}岁 · ${m.heightCm}cm · ${m.weightKg}kg · ${ACTIVITY_LABEL[m.activityLevel] || ''}`;
}

function renderMembers() {
  const list = settings.members;
  if (!list.length) {
    el.memberList.innerHTML = '<p class="s-empty">还没有添加家庭成员</p>';
    return;
  }
  el.memberList.innerHTML = list.map((m) => {
    const confirming = state.pendingDeleteId === m.id;
    const acts = confirming
      ? `<div class="member-confirm">
           <span class="member-confirm-text">删除「${esc(m.name)}」？</span>
           <button class="member-btn" type="button" data-act="cancel-del">取消</button>
           <button class="member-btn member-btn--danger" type="button" data-act="confirm-del">删除</button>
         </div>`
      : `<div class="member-acts">
           <button class="member-btn" type="button" data-act="edit">编辑</button>
           <button class="member-btn" type="button" data-act="toggle">${m.enabled ? '停用' : '启用'}</button>
           <button class="member-btn member-btn--danger" type="button" data-act="del">删除</button>
         </div>`;
    return `
      <div class="member-row${m.enabled ? '' : ' is-off'}" data-id="${esc(m.id)}">
        <div class="member-main">
          <span class="member-name">${esc(m.name)}</span>
          <span class="member-meta">${esc(memberMetaText(m))}${m.enabled ? '' : '　·　已停用'}</span>
        </div>
        ${acts}
      </div>`;
  }).join('');
}

/**
 * 一位成员的健康参考卡。
 *
 * 分两块，刻意不让它们混在一起：
 *   1. 「每日能量参考」= 一整天 24 小时全部摄入的参考量，来源标明是自动还是自己设定
 *   2. 体型指标（BMI / 基础代谢）与每天的宏量参考
 *
 * 这里不出现「这一顿该吃多少」——那是另一回事，且本版本不提供。
 */
function memberHealthHtml(m) {
  const off = m.enabled ? '' : ' is-off';
  const metrics = healthMetrics(m);

  if (!metrics) {
    return `<div class="mh-card${off}">
      <div class="mh-head"><span class="mh-name">${esc(m.name)}</span>
        <span class="mh-tag">资料不全</span></div>
      <p class="mh-empty">这位成员的资料没填完整，暂时算不出参考值。</p>
    </div>`;
  }

  const energy = dailyEnergyReference(m, metrics);
  const ranges = macroRanges(energy.kcal);

  const num = energy.hasValue
    ? `${fmt(energy.kcal)}<i>kcal / 天</i>`
    : '<span class="mh-energy-none">还没填数字</span>';

  const foot = ranges
    ? `每天参考：蛋白质 ${fmt(metrics.proteinG)} g　·　`
      + `碳水 ${fmt(ranges.carbsLow)}–${fmt(ranges.carbsHigh)} g　·　`
      + `脂肪 ${fmt(ranges.fatLow)}–${fmt(ranges.fatHigh)} g`
      + `<br>碳水与脂肪由上面的每日能量参考推算，只是范围，不是必须吃到。`
    : '填上每日能量参考以后，这里会给出碳水与脂肪的参考范围。';

  return `
    <div class="mh-card${off}">
      <div class="mh-head">
        <span class="mh-name">${esc(m.name)}</span>
        <span class="mh-tag">${esc(metrics.bmiCategory.label)}</span>
      </div>

      <div class="mh-energy">
        <span class="mh-energy-label">每日能量参考</span>
        <span class="mh-energy-val">${num}</span>
        <span class="mh-energy-src">${esc(energy.label)}</span>
      </div>
      <p class="mh-energy-note">${
  energy.hasValue
    ? '一整天的参考量，包含早餐、午餐、晚餐以及其他摄入。'
    : '选了「自己设定」但还没填数字，编辑这位成员补上即可。'
}</p>

      <div class="mh-grid">
        <div class="mh-cell"><span>BMI</span><b>${fmt(metrics.bmi, 1)}</b></div>
        <div class="mh-cell"><span>基础代谢</span><b>${fmt(metrics.bmr)}<i>kcal</i></b></div>
      </div>
      <p class="mh-sub">BMI 与基础代谢都是按公式估的粗略值，不代表你该吃多少。</p>
      <p class="mh-sub">${foot}</p>
    </div>`;
}

function renderMemberHealth() {
  if (!settings.members.length) {
    el.memberHealth.innerHTML = '<p class="s-empty">添加家庭成员后，这里会按人分别给出参考值。</p>';
    return;
  }
  el.memberHealth.innerHTML = settings.members.map(memberHealthHtml).join('');
}

function renderDiet() {
  el.dietList.innerHTML = DIET_REFERENCE
    .map((d) => `<li><span>${esc(d.item)}</span><b>${esc(d.amount)}</b></li>`).join('');
}

function renderSettings() {
  renderSizeGroup();
  renderKeywords();
  renderHealthToggle();
  if (hnOn()) {
    renderMembers();
    renderPeopleGroup();
    renderMealsGroup();
    renderMemberHealth();
    renderDiet();
  }
  el.kwErr.textContent = '';
  el.memberErr.textContent = '';
}

// ------------------------------------------------------------------
// 面板
// ------------------------------------------------------------------

function anySheetOpen() {
  return !el.detail.hidden || !el.settings.hidden || !el.member.hidden;
}

function openSheet(sheetEl, bodyEl) {
  lastFocused = document.activeElement;
  sheetEl.hidden = false;
  document.body.classList.add('is-locked');
  if (bodyEl) { bodyEl.scrollTop = 0; bodyEl.focus(); }
}

function releaseLock() {
  if (!anySheetOpen()) document.body.classList.remove('is-locked');
}

function openSettings() {
  renderSettings();
  openSheet(el.settings, el.settingsBody);
  el.settingsClose.focus();
}

function closeSettings() {
  if (el.settings.hidden) return;
  el.settings.hidden = true;
  releaseLock();
}

function closeDetail() {
  if (el.detail.hidden) return;
  el.detail.hidden = true;
  el.detailBody.innerHTML = '';
  releaseLock();
}

// ------------------------------------------------------------------
// 成员表单（新增与编辑共用同一个 Sheet）
// ------------------------------------------------------------------

/** 每日能量参考的来源选择：自动估算 / 自己设定（两者必须能一眼分清） */
function energyModeGroupHtml(active) {
  return Object.values(ENERGY_SOURCE).map((s) => `
    <button class="s-size s-size--text${s.key === active ? ' is-active' : ''}" type="button"
      role="radio" aria-checked="${s.key === active}" data-energy="${s.key}">${esc(s.label)}</button>`)
    .join('');
}

/** 只有选了「自己设定」才需要填数字 */
function selectedEnergyMode() {
  return el.mfEnergyMode.querySelector('.is-active')?.dataset.energy === 'manual' ? 'manual' : 'auto';
}

function syncEnergyManualField() {
  const manual = selectedEnergyMode() === 'manual';
  el.mfEnergyManualField.hidden = !manual;
  // 「自动估算」时不保留输入框里的数字，避免看起来像还在用手动值
  if (!manual) el.mfEnergyManual.value = '';
}

function fillMemberForm(member) {
  state.editingMemberId = member?.id ?? null;
  el.memberTitle.textContent = member ? '编辑成员' : '添加成员';
  el.mfName.value = member?.name ?? '';
  el.mfGender.value = member?.gender ?? 'male';
  el.mfAge.value = member ? String(member.age) : '';
  el.mfHeight.value = member ? String(member.heightCm) : '';
  el.mfWeight.value = member ? String(member.weightKg) : '';
  el.mfActivity.value = member?.activityLevel ?? 'sedentary';

  const mode = member?.dailyEnergyMode === 'manual' ? 'manual' : 'auto';
  el.mfEnergyMode.innerHTML = energyModeGroupHtml(mode);
  el.mfEnergyManual.value = member?.dailyEnergyManual != null
    ? String(member.dailyEnergyManual) : '';
  el.mfEnergyManualField.hidden = mode !== 'manual';

  el.mfErr.textContent = '';
}

function openMemberSheet(member) {
  fillMemberForm(member);
  openSheet(el.member, null);
  el.mfName.focus();
}

function closeMemberSheet() {
  if (el.member.hidden) return;
  el.member.hidden = true;
  el.memberForm.reset();
  state.editingMemberId = null;
  releaseLock();
  // 关掉成员表单后把焦点还给设置面板里的「添加成员」
  if (!el.settings.hidden) el.memberAdd.focus();
}

/** 从表单读出原始输入（不 trim 数字，交给校验统一判定） */
function readMemberForm() {
  const mode = selectedEnergyMode();
  return {
    id: state.editingMemberId,
    name: el.mfName.value.trim(),
    gender: el.mfGender.value,
    age: el.mfAge.value,
    heightCm: el.mfHeight.value,
    weightKg: el.mfWeight.value,
    activityLevel: el.mfActivity.value,
    dailyEnergyMode: mode,
    // 自动估算时不读数字：这个值会存成 null，来源不会含糊
    dailyEnergyManual: mode === 'manual' ? el.mfEnergyManual.value.trim() : '',
    enabled: state.editingMemberId
      ? (findMember(state.editingMemberId)?.enabled ?? true)
      : true,
  };
}

function saveMember() {
  const draft = readMemberForm();
  const err = validateMember(draft);
  if (err) {
    el.mfErr.textContent = err;
    return;
  }

  const member = {
    id: draft.id || newMemberId(),
    name: draft.name,
    gender: draft.gender,
    age: Number(draft.age),
    heightCm: Number(draft.heightCm),
    weightKg: Number(draft.weightKg),
    activityLevel: draft.activityLevel,
    dailyEnergyMode: draft.dailyEnergyMode,
    dailyEnergyManual: draft.dailyEnergyMode === 'manual'
      ? Number(draft.dailyEnergyManual) : null,
    enabled: draft.enabled,
  };

  if (draft.id) {
    const i = settings.members.findIndex((m) => m.id === draft.id);
    if (i >= 0) settings.members[i] = member;
    else settings.members.push(member);
  } else {
    if (settings.members.length >= MAX_MEMBERS) {
      el.mfErr.textContent = `最多添加 ${MAX_MEMBERS} 位家庭成员`;
      return;
    }
    settings.members.push(member);
  }

  saveSettings();
  closeMemberSheet();
  renderMembers();
  renderPeopleGroup();
  renderMemberHealth();
  refreshMenu();
}

function deleteMember(id) {
  settings.members = settings.members.filter((m) => m.id !== id);
  state.pendingDeleteId = null;
  saveSettings();
  renderMembers();
  renderPeopleGroup();
  renderMemberHealth();
  refreshMenu();
}

function toggleMember(id) {
  const m = findMember(id);
  if (!m) return;
  m.enabled = !m.enabled;
  saveSettings();
  renderMembers();
  renderPeopleGroup();
  renderMemberHealth();
  refreshMenu();
}

// ------------------------------------------------------------------
// 做法详情
// ------------------------------------------------------------------

function section(title, bodyHtml) {
  return bodyHtml ? `<section class="d-section"><h3>${esc(title)}</h3>${bodyHtml}</section>` : '';
}

function listHtml(items, className) {
  if (!items || !items.length) return '';
  return `<ul class="${className}">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

function openDetail(recipe) {
  const stars = recipe.difficulty
    ? `<span class="stars" title="预估烹饪难度">${'★'.repeat(recipe.difficulty)}</span>`
    : '';
  const source = recipe.sourceUrl
    ? `<p>来源：<a href="${esc(recipe.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(recipe.sourceName)}</a></p>`
    : '';
  const reference = recipe.referenceUrl
    ? `<p>参考：<a href="${esc(recipe.referenceUrl)}" target="_blank" rel="noopener noreferrer">${esc(recipe.referenceName || recipe.referenceUrl)}</a></p>`
    : '';

  // 营养区只在开启健康与营养时出现
  const est = hnOn() ? state.estimates.find((e) => e.recipe === recipe)?.est : null;

  el.detailChip.textContent = roleLabel(recipe);
  el.detailBody.innerHTML = `
    <h2 class="d-name" id="detail-name">${esc(recipe.name)}</h2>
    <div class="d-meta">
      <span class="chip chip--plain">${esc(roleLabel(recipe))}</span>
      ${categoryTag(recipe)}
      ${stars}
    </div>
    ${recipe.description ? `<p class="d-desc">${esc(recipe.description)}</p>` : ''}
    ${est ? recipeNutritionHtml(est) : ''}
    ${section('食材', listHtml(recipe.ingredients, 'd-list'))}
    ${section('做法', listHtml(recipe.steps, 'd-steps'))}
    ${section('小贴士', listHtml(recipe.tips, 'd-tips'))}
    <div class="d-source">${source}${reference}</div>`;

  openSheet(el.detail, el.detailBody);
}

// ------------------------------------------------------------------
// 变更后的统一收尾
// ------------------------------------------------------------------

function refreshMenu() {
  rebuildAvailable();
  if (!menuPlan().ok) {
    state.current = null;
    state.estimates = [];
    state.summary = null;
    renderShortage();
    return;
  }
  state.current = pickMenu(null);
  if (!state.current) { renderShortage(); return; }
  recompute();
  renderMenu();
  renderStaple();
  renderNutrition();
  el.hint.textContent = hintText();
}

/** 开关切换后重画所有受影响的地方 */
function applyHealthToggle() {
  renderHealthToggle();
  renderSettings();
  refreshMenu();
  // 首页两块与卡片上的热量都要跟着开关走
  if (hnOn()) {
    renderMembers();
    renderPeopleGroup();
    renderMemberHealth();
    renderDiet();
  }
}

function afterKeywordsChange() {
  saveSettings();
  renderKeywords();
  refreshMenu();
}

function addKeywords(raw) {
  const incoming = parseKeywordInput(raw);
  if (!incoming.length) {
    el.kwErr.textContent = '先输入关键词再添加';
    return;
  }
  const before = settings.blockedKeywords.length;
  settings.blockedKeywords = dedupeKeywords([...settings.blockedKeywords, ...incoming]);
  el.kwErr.textContent = settings.blockedKeywords.length === before
    ? '这个关键词已经在屏蔽列表里了' : '';
  afterKeywordsChange();
  el.kwInput.value = '';
}

// ------------------------------------------------------------------
// 事件
// ------------------------------------------------------------------

el.reroll.addEventListener('click', reroll);
el.settingsOpen.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', closeSettings);
el.detailClose.addEventListener('click', closeDetail);

el.menu.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || !state.current) return;
  const recipe = state.current.find((r) => r.id === card.dataset.id);
  if (recipe) openDetail(recipe);
});

// 健康与营养总开关
el.hnToggle.addEventListener('click', () => {
  settings.healthNutritionEnabled = !hnOn();
  // 关闭时保留成员、主食、屏蔽等全部数据，只是不再显示与计算
  saveSettings();
  applyHealthToggle();
});

// 每餐数量
el.sizeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.s-size');
  if (!btn) return;
  const size = Number(btn.dataset.size);
  if (!MEAL_SIZES.includes(size) || size === settings.mealSize) return;
  settings.mealSize = size;
  saveSettings();
  renderSizeGroup();
  refreshMenu();
});

// 本次用餐人数
el.peopleGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.s-size');
  if (!btn) return;
  const n = Number(btn.dataset.people);
  if (!PEOPLE.includes(n)) return;
  settings.currentMealHouseholdSize = n;
  saveSettings();
  renderPeopleGroup();
  recompute();
  renderStaple();
  renderNutrition();
});

// 恢复为家庭成员数
el.peopleFollow.addEventListener('click', () => {
  settings.currentMealHouseholdSize = null;
  saveSettings();
  renderPeopleGroup();
  recompute();
  renderStaple();
  renderNutrition();
});

// 每天通常吃几餐：只记录习惯，刻意不触发任何重算
el.mealsGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.s-size');
  if (!btn) return;
  const n = Number(btn.dataset.meals);
  if (!MEALS_PER_DAY_OPTIONS.includes(n) || n === settings.mealsPerDay) return;
  settings.mealsPerDay = n;
  saveSettings();
  renderMealsGroup();
});

// 成员列表：编辑 / 启停 / 删除（删除两步确认）
el.memberList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.member-row');
  const id = row?.dataset.id;
  if (!id) return;

  switch (btn.dataset.act) {
    case 'edit': {
      const m = findMember(id);
      if (m) openMemberSheet(m);
      break;
    }
    case 'toggle':
      toggleMember(id);
      break;
    case 'del':
      state.pendingDeleteId = id;
      renderMembers();
      break;
    case 'cancel-del':
      state.pendingDeleteId = null;
      renderMembers();
      break;
    case 'confirm-del':
      deleteMember(id);
      break;
    default:
      break;
  }
});

el.memberAdd.addEventListener('click', () => {
  if (settings.members.length >= MAX_MEMBERS) {
    el.memberErr.textContent = `最多添加 ${MAX_MEMBERS} 位家庭成员`;
    return;
  }
  el.memberErr.textContent = '';
  openMemberSheet(null);
});

el.memberForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveMember();
});
el.memberCancel.addEventListener('click', closeMemberSheet);
el.memberClose.addEventListener('click', closeMemberSheet);

// 每日能量参考的来源切换：选「自己设定」才展开数字输入
el.mfEnergyMode.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-energy]');
  if (!btn) return;
  el.mfEnergyMode.innerHTML = energyModeGroupHtml(btn.dataset.energy);
  syncEnergyManualField();
  el.mfErr.textContent = '';
  if (btn.dataset.energy === 'manual') el.mfEnergyManual.focus();
});

// 主食选择
el.stapleSelect.addEventListener('change', () => {
  settings.staple.key = el.stapleSelect.value;
  saveSettings();
  recompute();
  renderStaple();
  renderNutrition();
});

// 主食克数：一旦手改就退出「按人数自动」
el.stapleAmount.addEventListener('change', () => {
  const raw = Number(el.stapleAmount.value);
  const v = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 5000) : 0;
  settings.staple.grams = v;
  settings.staple.auto = false;
  el.stapleAmount.value = String(v);
  saveSettings();
  recompute();
  renderStaple();
  renderNutrition();
});

// 关键词
el.kwForm.addEventListener('submit', (e) => {
  e.preventDefault();
  addKeywords(el.kwInput.value);
});

el.kwList.addEventListener('click', (e) => {
  const btn = e.target.closest('.s-chip-x');
  if (!btn) return;
  const target = btn.dataset.kw.toLowerCase();
  settings.blockedKeywords = settings.blockedKeywords.filter((k) => k.toLowerCase() !== target);
  el.kwErr.textContent = '';
  afterKeywordsChange();
});

el.kwClear.addEventListener('click', () => {
  if (!settings.blockedKeywords.length) return;
  settings.blockedKeywords = [];
  el.kwErr.textContent = '';
  afterKeywordsChange();
});

// 点遮罩关闭（点面板本身不关）
for (const [sheetEl, close] of [
  [el.detail, closeDetail],
  [el.settings, closeSettings],
  [el.member, closeMemberSheet],
]) {
  sheetEl.addEventListener('click', (e) => {
    if (e.target === sheetEl) close();
  });
}

// Esc 从最上层的面板开始关
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.member.hidden) closeMemberSheet();
  else if (!el.settings.hidden) closeSettings();
  else closeDetail();
});

// ------------------------------------------------------------------
// 启动
// ------------------------------------------------------------------

async function boot() {
  el.heroSub.textContent = heroSubText();

  el.mfActivity.innerHTML = ACTIVITY_LEVELS
    .map((a) => `<option value="${esc(a.key)}">${esc(a.label)}　${esc(a.hint)}</option>`).join('');

  // 手动每日能量的防呆范围只在 nutrition.js 定义一次，这里直接引用，
  // 避免 HTML 里再抄一份造成两处不一致
  el.mfEnergyManual.min = String(DAILY_ENERGY_LIMITS.min);
  el.mfEnergyManual.max = String(DAILY_ENERGY_LIMITS.max);
  el.mfEnergyManual.placeholder = `${DAILY_ENERGY_LIMITS.min} – ${DAILY_ENERGY_LIMITS.max}`;

  if (location.protocol === 'file:') {
    renderNotice(
      '需要通过本地服务器打开',
      '直接双击 index.html 浏览器会拦下数据加载。请在项目目录执行'
      + '<br><code>node tools/serve.mjs</code><br>然后访问 http://localhost:5173',
    );
    el.hint.textContent = '';
    return;
  }

  try {
    const [recipesRes, foodsRes] = await Promise.all([
      fetch(RECIPES_URL, { cache: 'no-cache' }),
      fetch(FOODS_URL, { cache: 'no-cache' }),
    ]);
    if (!recipesRes.ok) throw new Error(`菜谱数据 HTTP ${recipesRes.status}`);
    if (!foodsRes.ok) throw new Error(`营养数据 HTTP ${foodsRes.status}`);

    const recipeData = await recipesRes.json();
    state.foodsData = await foodsRes.json();
    state.foodIndex = buildIndex(state.foodsData);

    const recipes = Array.isArray(recipeData) ? recipeData : recipeData.recipes;
    if (!Array.isArray(recipes) || !recipes.length) throw new Error('菜谱数据为空');

    state.total = recipes.length;
    for (const role of MENU_ROLES) state.pools[role] = [];
    for (const r of recipes) {
      if (state.pools[r.menuRole]) state.pools[r.menuRole].push(r);
    }
    const missing = MENU_ROLES.filter((role) => !state.pools[role].length);
    if (missing.length) throw new Error(`缺少菜谱池：${missing.join('、')}`);

    applyHealthToggle();
  } catch (err) {
    console.error('[今晚吃什么] 数据加载失败：', err);
    renderNotice(
      '数据没加载成功',
      '请确认 <code>data/recipes.json</code> 与 <code>data/foods.json</code> 存在，'
      + `并通过本地服务器访问。<br>（${esc(err.message)}）`,
    );
  }
}

boot();
