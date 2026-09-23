/* ============================================================
   今晚吃什么 · 前端逻辑
   ------------------------------------------------------------
   打开页面 → 随机一荤一素 → 不满意就换一组 → 点卡片看做法。
   数据全部来自本地 data/recipes.json，不请求任何第三方接口，
   断网（或国内网络直连）也能正常使用。
   ============================================================ */

const DATA_URL = 'data/recipes.json';

/** 随机菜单只从这两个池子里取菜 */
const MENU_ROLES = ['protein', 'vegetable'];

const ROLE_EMOJI = { protein: '🍖', vegetable: '🥬' };

/** 这道菜在「一荤一素」里扮演的角色。用词和产品对外的说法保持一致。 */
const ROLE_LABEL = { protein: '荤菜', vegetable: '素菜' };

/** 角色的展示名：没在图例里的角色就退回原始分类名 */
function roleLabel(recipe) {
  return ROLE_LABEL[recipe.menuRole] || recipe.categoryName;
}

/** 次级分类标签。和角色名重复时（例如「素菜 / 素菜」）就不显示，避免啰嗦。 */
function categoryTag(recipe) {
  const label = roleLabel(recipe);
  if (label === recipe.categoryName) return '';
  return `<span class="card-cat">${esc(recipe.categoryName)}</span>`;
}

const state = {
  /** @type {Record<string, object[]>} 按 menuRole 分好的菜谱池 */
  pools: { protein: [], vegetable: [] },
  /** @type {{protein: object, vegetable: object} | null} 当前这一组 */
  current: null,
  total: 0,
};

const el = {
  menu: document.getElementById('menu'),
  reroll: document.getElementById('reroll'),
  hint: document.getElementById('hint'),
  detail: document.getElementById('detail'),
  detailBody: document.getElementById('detail-body'),
  detailClose: document.getElementById('detail-close'),
  detailChip: document.getElementById('detail-chip'),
};

/** 关闭详情后把焦点还回去 */
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

// ------------------------------------------------------------------
// 随机菜单
// ------------------------------------------------------------------

/**
 * 抽一荤一素。
 * 优先保证「两道都和上一组不同」，其次是「组合与上一组不同」，
 * 池子极小时逐级退让，不会卡死也不会返回非法结果。
 */
function pickPair(prev) {
  const { protein, vegetable } = state.pools;
  if (!protein.length || !vegetable.length) return null;

  for (let i = 0; i < 60; i++) {
    const p = randomOf(protein);
    const v = randomOf(vegetable);
    if (p.id === v.id) continue;                       // 同一道菜，不可能出现
    if (!prev) return { protein: p, vegetable: v };
    if (p.id !== prev.protein.id && v.id !== prev.vegetable.id) {
      return { protein: p, vegetable: v };             // 两道都换掉
    }
  }

  for (let i = 0; i < 60; i++) {
    const p = randomOf(protein);
    const v = randomOf(vegetable);
    if (p.id === v.id) continue;
    if (!prev || p.id !== prev.protein.id || v.id !== prev.vegetable.id) {
      return { protein: p, vegetable: v };             // 至少整组不一样
    }
  }

  return { protein: randomOf(protein), vegetable: randomOf(vegetable) };
}

/** 换一组：重新抽，并给一次轻微的入场动效 */
function reroll() {
  const next = pickPair(state.current);
  if (!next) return;
  state.current = next;
  renderMenu();
  el.hint.textContent = '不满意就再换，换到看着顺眼为止';
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
  el.menu.innerHTML = cardHtml(current.protein) + cardHtml(current.vegetable);
  el.menu.setAttribute('aria-busy', 'false');
  el.reroll.disabled = false;
}

function renderNotice(title, detail) {
  el.menu.innerHTML = `<div class="notice"><strong>${esc(title)}</strong>${detail}</div>`;
  el.menu.setAttribute('aria-busy', 'false');
  el.reroll.disabled = true;
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

  lastFocused = document.activeElement;
  el.detail.hidden = false;
  document.body.classList.add('is-locked');
  el.detailBody.scrollTop = 0;
  el.detailBody.focus();
}

function closeDetail() {
  if (el.detail.hidden) return;
  el.detail.hidden = true;
  document.body.classList.remove('is-locked');
  el.detailBody.innerHTML = '';
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
}

// ------------------------------------------------------------------
// 事件
// ------------------------------------------------------------------

el.reroll.addEventListener('click', reroll);

el.menu.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || !state.current) return;
  const { protein, vegetable } = state.current;
  const recipe = [protein, vegetable].find((r) => r.id === card.dataset.id);
  if (recipe) openDetail(recipe);
});

el.detailClose.addEventListener('click', closeDetail);

// 点遮罩关闭（点面板本身不关）
el.detail.addEventListener('click', (e) => {
  if (e.target === el.detail) closeDetail();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDetail();
});

// ------------------------------------------------------------------
// 启动
// ------------------------------------------------------------------

async function boot() {
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

    state.current = pickPair(null);
    renderMenu();
    el.hint.textContent = `已收录 ${state.total} 道家常菜谱 · 点卡片看做法`;
  } catch (err) {
    console.error('[今晚吃什么] 数据加载失败：', err);
    renderNotice(
      '菜谱数据没加载成功',
      `请确认 <code>data/recipes.json</code> 存在，并通过本地服务器访问。`
      + `<br>（${esc(err.message)}）`,
    );
  }
}

boot();
