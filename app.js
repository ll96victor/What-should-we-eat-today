/* ============================================================
   今晚吃什么 · 前端逻辑
   ------------------------------------------------------------
   打开页面 → 随机给出荤素搭配的一桌菜 → 不满意就换一组 → 点卡片看做法。
   可以设置用餐人数、每餐菜品数量、屏蔽关键词，并看到粗略的营养估算。
   全部设置存在浏览器本地，不上传、不需要账号。

   数据与计算全部在本地完成，运行时不请求任何第三方接口。
   ============================================================ */

import {
  buildIndex, estimateRecipe, nutritionOf, summarizeMeal,
  healthMetrics, ACTIVITY_LEVELS, DIET_REFERENCE,
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
/** 每人默认主食量（克，熟重） */
const STAPLE_PER_PERSON = 150;

const MENU_PHRASE = { 1: '一荤一素', 2: '两荤两素', 3: '三荤三素', 4: '四荤四素' };

const SETTINGS_KEY = 'what-should-we-eat-today.settings';
const DEFAULT_SETTINGS = {
  mealSize: 2,
  householdSize: 2,
  blockedKeywords: [],
  healthProfile: { sex: 'male', age: '', height: '', weight: '', activity: 'sedentary' },
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
};

const el = {};
for (const id of [
  'hero-sub', 'menu', 'reroll', 'hint', 'detail', 'detail-body', 'detail-close', 'detail-chip',
  'settings', 'settings-body', 'settings-open', 'settings-close',
  'size-group', 'size-note', 'people-group', 'people-note',
  'kw-form', 'kw-input', 'kw-list', 'kw-clear', 'kw-err',
  'staple-panel', 'staple-select', 'staple-amount', 'staple-note',
  'nutrition-panel', 'meal-nutri', 'meal-foot', 'meal-status',
  'hp-sex', 'hp-age', 'hp-height', 'hp-weight', 'hp-activity', 'hp-out', 'hp-hint',
  'diet-list',
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

// ------------------------------------------------------------------
// 设置读写
// ------------------------------------------------------------------

function loadSettings() {
  const base = {
    ...DEFAULT_SETTINGS,
    blockedKeywords: [],
    healthProfile: { ...DEFAULT_SETTINGS.healthProfile },
    staple: { ...DEFAULT_SETTINGS.staple },
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const s = JSON.parse(raw);

    const mealSize = Number(s?.mealSize);
    if (MEAL_SIZES.includes(mealSize)) base.mealSize = mealSize;

    const people = Number(s?.householdSize);
    if (PEOPLE.includes(people)) base.householdSize = people;

    if (Array.isArray(s?.blockedKeywords)) {
      base.blockedKeywords = dedupeKeywords(
        s.blockedKeywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()),
      );
    }

    const hp = s?.healthProfile;
    if (hp && typeof hp === 'object') {
      base.healthProfile = {
        sex: hp.sex === 'female' ? 'female' : 'male',
        age: numOrEmpty(hp.age),
        height: numOrEmpty(hp.height),
        weight: numOrEmpty(hp.weight),
        activity: ACTIVITY_LEVELS.some((a) => a.key === hp.activity) ? hp.activity : 'sedentary',
      };
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

function numOrEmpty(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : '';
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('[今晚吃什么] 设置没能保存到本地：', e);
  }
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

let settings = loadSettings();

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
  renderNutrition();
  el.hint.textContent = hintText();
}

// ------------------------------------------------------------------
// 营养估算
// ------------------------------------------------------------------

/** 主食当前使用多少克；auto 模式下按人数推算 */
function stapleGrams() {
  if (settings.staple.auto) return settings.householdSize * STAPLE_PER_PERSON;
  return Number(settings.staple.grams) || 0;
}

/** 重算每道菜的营养与整餐汇总 */
function recompute() {
  if (!state.foodIndex || !state.current) {
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

  state.summary = summarizeMeal(state.estimates, staple, settings.householdSize);
}

/** 每道菜的营养小结（用于详情页） */
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
        <p class="nutri-scope">按菜谱所写用量（整锅）</p>
        <p class="nutri-kcal">约 ${fmt(t.kcal)} <span>kcal</span></p>
        <ul class="nutri-macros">
          <li><span>蛋白质</span><b>${fmt(t.protein, 1)} g</b></li>
          <li><span>碳水</span><b>${fmt(t.carbs, 1)} g</b></li>
          <li><span>脂肪</span><b>${fmt(t.fat, 1)} g</b></li>
        </ul>
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

  // 卡片上只给一个粗略的热量提示，详细数字留在详情页
  let kcal = '';
  if (est && est.status !== 'none') {
    kcal = `<span class="card-kcal">约 ${fmt(est.total.kcal)} kcal${est.status === 'partial' ? '*' : ''}</span>`;
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
// 渲染：主食 + 本餐营养
// ------------------------------------------------------------------

function renderStaple() {
  if (!state.foodsData) return;
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

  const per = settings.householdSize > 0 ? stapleGrams() / settings.householdSize : 0;
  const food = state.foodIndex.byKey.get(settings.staple.key);
  el.stapleNote.textContent = stapleGrams() > 0
    ? `全家的量，人均约 ${fmt(per)} g${settings.staple.auto ? '（按人数自动）' : ''}`
      + `　·　${food ? esc(food.usdaDescription) : ''}`
    : '填 0 表示这顿不算主食';
}

function nutriRow(label, v, unit) {
  return `<div class="ng-cell"><span class="ng-label">${esc(label)}</span>`
    + `<b class="ng-value">${fmt(v, unit === 'g' ? 1 : 0)}<i>${unit}</i></b></div>`;
}

function renderNutrition() {
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

  const people = settings.householdSize;
  el.mealNutri.innerHTML = `
    <div class="ng-head">
      <span>整顿饭</span>
      <span>${esc(String(people))} 人平均</span>
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
    parts.push(`${f ? f.names[0] : '主食'} ${fmt(stapleGrams())}g`);
  }
  const skipped = state.estimates.filter((e) => e.est.fryingOil).length;
  el.mealFoot.innerHTML = `按菜谱所写用量估算：${esc(parts.join(' + '))}`
    + `<br>${esc(String(withData))} / ${esc(String(dishes))} 道菜有可用营养数据`
    + (skipped ? `　·　${esc(String(skipped))} 道菜的油炸用油未计入` : '')
    + '<br>菜谱未按人数折算，实际按你下锅的量同比变化。';
}

// ------------------------------------------------------------------
// 渲染：设置面板
// ------------------------------------------------------------------

function radioGroupHtml(values, active, attr) {
  return values.map((n) => `
    <button class="s-size${n === active ? ' is-active' : ''}" type="button"
      role="radio" aria-checked="${n === active}" data-${attr}="${n}">${n}</button>`).join('');
}

function renderPeopleGroup() {
  el.peopleGroup.innerHTML = radioGroupHtml(PEOPLE, settings.householdSize, 'people');
  el.peopleNote.textContent = `当前 ${settings.householdSize} 人`
    + `　·　主食人均约 ${fmt(STAPLE_PER_PERSON)} g`;
}

function renderSizeGroup() {
  el.sizeGroup.innerHTML = radioGroupHtml(MEAL_SIZES, settings.mealSize, 'size');
  const half = settings.mealSize / 2;
  el.sizeNote.textContent = `当前：${MENU_PHRASE[half] || settings.mealSize + ' 道'}`
    + `（${half} 道荤菜 + ${half} 道素菜）`;
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

function renderHealth() {
  const p = settings.healthProfile;
  el.hpSex.value = p.sex;
  el.hpAge.value = p.age === '' ? '' : String(p.age);
  el.hpHeight.value = p.height === '' ? '' : String(p.height);
  el.hpWeight.value = p.weight === '' ? '' : String(p.weight);
  el.hpActivity.innerHTML = ACTIVITY_LEVELS
    .map((a) => `<option value="${esc(a.key)}">${esc(a.label)}　${esc(a.hint)}</option>`).join('');
  el.hpActivity.value = p.activity;

  const m = healthMetrics(p);
  if (!m) {
    el.hpOut.innerHTML = '';
    el.hpHint.textContent = '把性别、年龄、身高、体重填完，这里会给出粗略参考值。';
    return;
  }
  el.hpHint.textContent = '以下为粗略估算，仅供日常参考，不是医疗建议。';
  el.hpOut.innerHTML = `
    <div class="hp-result">
      <div class="hp-line"><span>BMI</span><b>${fmt(m.bmi, 1)}</b>
        <em>${esc(m.bmiCategory.label)}（${esc(m.bmiCategory.hint)}）</em></div>
      <div class="hp-line"><span>基础代谢 BMR</span><b>${fmt(m.bmr)}</b><em>kcal / 天</em></div>
      <div class="hp-line"><span>维持能量 TDEE</span><b>${fmt(m.tdee)}</b><em>kcal / 天（${esc(m.activity.label)}）</em></div>
      <div class="hp-line"><span>蛋白质参考</span><b>${fmt(m.proteinG)}</b><em>g / 天（约 0.8 g/kg）</em></div>
      <div class="hp-line"><span>碳水参考</span><b>${fmt(m.carbsLow)}–${fmt(m.carbsHigh)}</b><em>g / 天（总能量的 45%–65%）</em></div>
      <div class="hp-line"><span>脂肪参考</span><b>${fmt(m.fatLow)}–${fmt(m.fatHigh)}</b><em>g / 天（总能量的 20%–35%）</em></div>
    </div>
    <p class="hp-caveat">BMI 是粗略筛查指标，不是医疗诊断。</p>`;
}

function renderDiet() {
  el.dietList.innerHTML = DIET_REFERENCE
    .map((d) => `<li><span>${esc(d.item)}</span><b>${esc(d.amount)}</b></li>`).join('');
}

function renderSettings() {
  renderPeopleGroup();
  renderSizeGroup();
  renderKeywords();
  renderHealth();
  renderDiet();
  el.kwErr.textContent = '';
}

// ------------------------------------------------------------------
// 面板
// ------------------------------------------------------------------

function openSheet(sheetEl, bodyEl) {
  lastFocused = document.activeElement;
  sheetEl.hidden = false;
  document.body.classList.add('is-locked');
  bodyEl.scrollTop = 0;
  bodyEl.focus();
}

function releaseLock() {
  if (el.detail.hidden && el.settings.hidden) {
    document.body.classList.remove('is-locked');
  }
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  lastFocused = null;
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

  const est = state.estimates.find((e) => e.recipe === recipe)?.est;

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

function closeDetail() {
  if (el.detail.hidden) return;
  el.detail.hidden = true;
  el.detailBody.innerHTML = '';
  releaseLock();
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
  el.staplePanel.hidden = false;
  renderStaple();
  renderNutrition();
  el.hint.textContent = hintText();
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

// 用餐人数
el.peopleGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.s-size');
  if (!btn) return;
  const n = Number(btn.dataset.people);
  if (!PEOPLE.includes(n) || n === settings.householdSize) return;
  settings.householdSize = n;
  saveSettings();
  renderPeopleGroup();
  recompute();
  renderStaple();
  renderNutrition();
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

// 健康资料
for (const [node, field] of [
  [el.hpSex, 'sex'], [el.hpAge, 'age'], [el.hpHeight, 'height'],
  [el.hpWeight, 'weight'], [el.hpActivity, 'activity'],
]) {
  node.addEventListener('change', () => {
    const raw = node.value;
    settings.healthProfile[field] = (field === 'sex' || field === 'activity') ? raw : numOrEmpty(raw);
    saveSettings();
    renderHealth();
  });
}

for (const [sheetEl, close] of [[el.detail, closeDetail], [el.settings, closeSettings]]) {
  sheetEl.addEventListener('click', (e) => {
    if (e.target === sheetEl) close();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.settings.hidden) closeSettings();
  else closeDetail();
});

// ------------------------------------------------------------------
// 启动
// ------------------------------------------------------------------

async function boot() {
  el.heroSub.textContent = heroSubText();

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

    refreshMenu();
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
