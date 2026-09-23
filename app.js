/* ============================================================
   今晚吃什么 · 前端逻辑
   ------------------------------------------------------------
   打开页面 → 随机给出荤素搭配的一桌菜 → 不满意就换一组 → 点卡片看做法。
   每餐数量与屏蔽关键词记在浏览器 localStorage 里，刷新和重开都不丢。
   数据全部来自本地 data/recipes.json，不请求任何第三方接口。
   ============================================================ */

const DATA_URL = 'data/recipes.json';

/** 随机菜单只从这两个池子里取菜，且始终 1:1 搭配 */
const MENU_ROLES = ['protein', 'vegetable'];

const ROLE_EMOJI = { protein: '🍖', vegetable: '🥬' };

/** 这道菜在菜单里扮演的角色。用词和产品对外的说法保持一致。 */
const ROLE_LABEL = { protein: '荤菜', vegetable: '素菜' };

/** 每餐菜品数量的可选值（荤素 1:1，所以每边各一半） */
const MEAL_SIZES = [2, 4, 6, 8];

/** 首页副标题文案，键是每一边的菜数 */
const MENU_PHRASE = { 1: '一荤一素', 2: '两荤两素', 3: '三荤三素', 4: '四荤四素' };

const SETTINGS_KEY = 'what-should-we-eat-today.settings';
const DEFAULT_SETTINGS = { mealSize: 2, blockedKeywords: [] };

/** 屏蔽关键词在哪些字段里查找（都是能描述「这道菜是什么」的字段） */
const BLOCK_FIELDS = ['name', 'categoryName', 'description'];

const state = {
  /** @type {Record<string, object[]>} 全部菜谱，按 menuRole 分池 */
  pools: { protein: [], vegetable: [] },
  /** @type {Record<string, object[]>} 剔除被屏蔽的菜之后，真正可用的池子 */
  available: { protein: [], vegetable: [] },
  /** @type {object[] | null} 当前这一桌菜（荤菜在前、素菜在后） */
  current: null,
  total: 0,
  blocked: 0,
};

const el = {
  heroSub: document.getElementById('hero-sub'),
  menu: document.getElementById('menu'),
  reroll: document.getElementById('reroll'),
  hint: document.getElementById('hint'),
  detail: document.getElementById('detail'),
  detailBody: document.getElementById('detail-body'),
  detailClose: document.getElementById('detail-close'),
  detailChip: document.getElementById('detail-chip'),
  settings: document.getElementById('settings'),
  settingsBody: document.getElementById('settings-body'),
  settingsOpen: document.getElementById('settings-open'),
  settingsClose: document.getElementById('settings-close'),
  sizeGroup: document.getElementById('size-group'),
  sizeNote: document.getElementById('size-note'),
  kwForm: document.getElementById('kw-form'),
  kwInput: document.getElementById('kw-input'),
  kwList: document.getElementById('kw-list'),
  kwClear: document.getElementById('kw-clear'),
  kwErr: document.getElementById('kw-err'),
};

/** 关闭面板后把焦点还回去 */
let lastFocused = null;

// ------------------------------------------------------------------
// 小工具
// ------------------------------------------------------------------

/** 转义，避免菜谱文本里的特殊字符破坏页面结构 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** 角色的展示名：没在图例里的角色就退回原始分类名 */
function roleLabel(recipe) {
  return ROLE_LABEL[recipe.menuRole] || recipe.categoryName;
}

/** 次级分类标签。和角色名重复时（例如「素菜 / 素菜」）就不显示，避免啰嗦。 */
function categoryTag(recipe) {
  if (roleLabel(recipe) === recipe.categoryName) return '';
  return `<span class="card-cat">${esc(recipe.categoryName)}</span>`;
}

// ------------------------------------------------------------------
// 设置：读写 localStorage
// ------------------------------------------------------------------

/** 读设置。localStorage 不可用（隐私模式等）时退回默认值，不影响主流程。 */
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, blockedKeywords: [] };
    const saved = JSON.parse(raw);
    const size = Number(saved?.mealSize);
    const keywords = Array.isArray(saved?.blockedKeywords)
      ? saved.blockedKeywords.filter((k) => typeof k === 'string' && k.trim())
        .map((k) => k.trim())
      : [];
    return {
      mealSize: MEAL_SIZES.includes(size) ? size : DEFAULT_SETTINGS.mealSize,
      blockedKeywords: dedupeKeywords(keywords),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, blockedKeywords: [] };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    // 存不下不算致命：本次会话内设置依然生效，只是刷新后丢失
    console.warn('[今晚吃什么] 设置没能保存到本地：', e);
  }
}

/** 去重（忽略大小写），保留用户原本的写法 */
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
// 屏蔽关键词
// ------------------------------------------------------------------

/**
 * 唯一的屏蔽判断入口。
 * 中文按「包含即命中」处理：屏蔽「鱼」，清蒸鲈鱼 / 红烧鱼 / 鱼香肉丝 都算命中。
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

/** 按当前屏蔽词重建可用池子 */
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

/** 把输入框内容解析成关键词（支持中英文逗号、空格分隔） */
function parseKeywordInput(raw) {
  return dedupeKeywords(
    raw.split(/[,，、\s]+/).map((k) => k.trim()).filter(Boolean),
  );
}

// ------------------------------------------------------------------
// 随机菜单
// ------------------------------------------------------------------

/** 当前数量下，每个角色各需要几道；以及池子够不够 */
function menuPlan() {
  const perRole = settings.mealSize / 2;
  const need = { protein: perRole, vegetable: perRole };
  const short = MENU_ROLES
    .map((role) => ({ role, need: need[role], have: state.available[role].length }))
    .filter((x) => x.have < x.need);
  return { need, short, ok: short.length === 0 };
}

/** 从池子里不重复地取 n 道；池子不够返回 null（绝不返回残缺结果） */
function sampleDistinct(pool, n) {
  if (pool.length < n) return null;
  const idx = pool.map((_, i) => i);
  for (let i = 0; i < n; i++) {            // 部分洗牌，不必洗完整池子
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

/**
 * 生成一桌菜：荤素各一半，组内不重样，尽量和上一桌不同。
 * 池子不足时返回 null，由调用方给出提示——不会死循环，也不会悄悄放宽屏蔽。
 */
function pickMenu(prev) {
  if (!menuPlan().ok) return null;

  const build = () => {
    const dishes = [];
    for (const role of MENU_ROLES) {
      const picked = sampleDistinct(state.available[role], menuPlan().need[role]);
      if (!picked) return null;
      dishes.push(...picked);
    }
    // 兜底：万一数据里出现跨角色的重复 id，这一组作废重抽
    if (new Set(dishes.map((d) => d.id)).size !== dishes.length) return null;
    return dishes;
  };

  const prevIds = new Set(prev ? prev.map((r) => r.id) : []);
  let last = null;

  // 第一优先：整桌菜全部换掉。点「换一组」就是想看点不一样的，
  // 只换掉一半（两道菜里留一道）手感很差。
  for (let i = 0; i < 60; i++) {
    const dishes = build();
    if (!dishes) return null;
    last = dishes;
    if (!dishes.some((d) => prevIds.has(d.id))) return dishes;
  }

  // 第二优先：至少整桌和上一桌不一样（池子小到必然复用时的退让）
  for (let i = 0; i < 60; i++) {
    const dishes = build();
    if (!dishes) return null;
    last = dishes;
    if (!sameMenu(dishes, prev)) return dishes;
  }

  return last;   // 池子小到换不出新组合时，接受最后一次
}

/** 换一组 */
function reroll() {
  const next = pickMenu(state.current);
  if (!next) { renderShortage(); return; }   // 池子突然不够也给出提示，不留旧菜单
  state.current = next;
  renderMenu();
  el.hint.textContent = hintText();
}

// ------------------------------------------------------------------
// 渲染
// ------------------------------------------------------------------

function cardVisual(recipe) {
  const emoji = ROLE_EMOJI[recipe.menuRole] || '🍽️';
  const fallback = `<span class="card-emoji-fallback" aria-hidden="true">${emoji}</span>`;
  if (!recipe.imageUrl) return `<span class="card-emoji">${fallback}</span>`;
  // 有图就用图；图挂掉时 img 被移除，自动露出底下的 emoji，功能不受影响
  return `<span class="card-emoji">${fallback}`
    + `<img src="${esc(recipe.imageUrl)}" alt="" loading="lazy" onerror="this.remove()"></span>`;
}

function cardHtml(recipe) {
  const stars = recipe.difficulty
    ? `<span class="stars" title="预估烹饪难度">${'★'.repeat(recipe.difficulty)}</span>`
    : '';
  const preview = recipe.ingredients.slice(0, 4).join(' · ');

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
      <span class="card-arrow" aria-hidden="true">›</span>
    </button>`;
}

function renderMenu() {
  const { current } = state;
  if (!current) return;
  el.menu.innerHTML = current.map(cardHtml).join('');
  el.menu.setAttribute('aria-busy', 'false');
  el.reroll.disabled = false;
  el.heroSub.textContent = heroSubText();
}

function renderNotice(title, detail) {
  el.menu.innerHTML = `<div class="notice"><strong>${esc(title)}</strong>${detail}</div>`;
  el.menu.setAttribute('aria-busy', 'false');
  el.reroll.disabled = true;
}

/** 首页副标题不能和实际菜品数量矛盾 */
function heroSubText() {
  const half = settings.mealSize / 2;
  return `${MENU_PHRASE[half] || `${settings.mealSize} 道菜`}，已经帮你配好了`;
}

function hintText() {
  let text = `已收录 ${state.total} 道家常菜谱 · 点卡片看做法`;
  if (state.blocked) text += ` · 已屏蔽 ${state.blocked} 道`;
  return text;
}

/** 池子不够时给出明确原因，而不是留一个空白页面 */
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
}

/** 设置或屏蔽词变化后，重建池子并重新出一桌 */
function refreshMenu() {
  rebuildAvailable();
  if (!menuPlan().ok) {
    state.current = null;
    renderShortage();
    return;
  }
  state.current = pickMenu(null);
  if (!state.current) { renderShortage(); return; }
  renderMenu();
  el.hint.textContent = hintText();
}

// ------------------------------------------------------------------
// 设置面板
// ------------------------------------------------------------------

function renderSizeGroup() {
  el.sizeGroup.innerHTML = MEAL_SIZES.map((n) => `
    <button class="s-size${n === settings.mealSize ? ' is-active' : ''}" type="button"
      role="radio" aria-checked="${n === settings.mealSize}" data-size="${n}">${n}</button>`).join('');

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

function renderSettings() {
  renderSizeGroup();
  renderKeywords();
  el.kwErr.textContent = '';
}

function openSettings() {
  renderSettings();
  openSheet(el.settings, el.settingsBody);
  el.settingsClose.focus();
}

/** 关键词变更后的统一收尾：存盘 + 重画面板 + 重出菜单 */
function afterKeywordsChange() {
  saveSettings();
  renderKeywords();
  refreshMenu();
}

function addKeywords(raw) {
  const incoming = parseKeywordInput(raw);
  if (!incoming.length) {
    el.kwErr.textContent = '先输入关键词再添加';
    return false;
  }
  const before = settings.blockedKeywords.length;
  settings.blockedKeywords = dedupeKeywords([...settings.blockedKeywords, ...incoming]);
  el.kwErr.textContent = settings.blockedKeywords.length === before
    ? '这个关键词已经在屏蔽列表里了'
    : '';
  afterKeywordsChange();
  el.kwInput.value = '';
  return true;
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

  el.detailChip.textContent = roleLabel(recipe);
  el.detailBody.innerHTML = `
    <h2 class="d-name" id="detail-name">${esc(recipe.name)}</h2>
    <div class="d-meta">
      <span class="chip chip--plain">${esc(roleLabel(recipe))}</span>
      ${categoryTag(recipe)}
      ${stars}
    </div>
    ${recipe.description ? `<p class="d-desc">${esc(recipe.description)}</p>` : ''}
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

function closeSettings() {
  if (el.settings.hidden) return;
  el.settings.hidden = true;
  releaseLock();
}

// ------------------------------------------------------------------
// 面板通用行为
// ------------------------------------------------------------------

function openSheet(sheetEl, bodyEl) {
  lastFocused = document.activeElement;
  sheetEl.hidden = false;
  document.body.classList.add('is-locked');
  bodyEl.scrollTop = 0;
  bodyEl.focus();
}

/** 两个面板都关上了才解锁页面滚动 */
function releaseLock() {
  if (el.detail.hidden && el.settings.hidden) {
    document.body.classList.remove('is-locked');
  }
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  lastFocused = null;
}

// ------------------------------------------------------------------
// 事件
// ------------------------------------------------------------------

el.reroll.addEventListener('click', reroll);
el.settingsOpen.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', closeSettings);
el.detailClose.addEventListener('click', closeDetail);

// 点菜单卡片看做法
el.menu.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || !state.current) return;
  const recipe = state.current.find((r) => r.id === card.dataset.id);
  if (recipe) openDetail(recipe);
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

// 添加关键词
el.kwForm.addEventListener('submit', (e) => {
  e.preventDefault();
  addKeywords(el.kwInput.value);
});

// 删除单个关键词
el.kwList.addEventListener('click', (e) => {
  const btn = e.target.closest('.s-chip-x');
  if (!btn) return;
  const target = btn.dataset.kw.toLowerCase();
  settings.blockedKeywords = settings.blockedKeywords.filter((k) => k.toLowerCase() !== target);
  el.kwErr.textContent = '';
  afterKeywordsChange();
});

// 清空全部
el.kwClear.addEventListener('click', () => {
  if (!settings.blockedKeywords.length) return;
  settings.blockedKeywords = [];
  el.kwErr.textContent = '';
  afterKeywordsChange();
});

// 点遮罩关闭（点面板本身不关）
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
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const recipes = Array.isArray(data) ? data : data.recipes;
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
      '菜谱数据没加载成功',
      '请确认 <code>data/recipes.json</code> 存在，并通过本地服务器访问。'
      + `<br>（${esc(err.message)}）`,
    );
  }
}

boot();
