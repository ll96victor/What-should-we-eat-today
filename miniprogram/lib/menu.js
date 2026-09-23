/* ============================================================
   小程序端：随机菜单与屏蔽（纯逻辑）
   ------------------------------------------------------------
   移植自 Web 版 app.js 的 isBlocked / rebuildAvailable / parseKeywordInput /
   menuPlan / sampleDistinct / sameMenu / pickMenu，基线提交 deabc45。
   **Web 版改动这些函数时，这里必须同步**，否则两端会选出不同的菜。

   本文件不出现任何 wx. 调用，所有输入显式传入、所有输出显式返回，
   因此可以在 Node 里直接 require 做自动化断言（见 tools/check-miniprogram.mjs）。

   保持与 Web 版一致的硬性语义：
   - 只从 protein / vegetable 两个池子取菜，且始终 1:1
   - 同一桌不出现重复的菜
   - 换一组优先整桌换掉；池子太小时退让为「至少不完全相同」
   - 池子不足时返回 null，由调用方明确报错并禁用换组，**不死循环**
   ============================================================ */

const { dedupeKeywords } = require('./settings.js');

/** 随机菜单只从这两个池子里取菜，且始终 1:1 搭配 */
const MENU_ROLES = ['protein', 'vegetable'];

const ROLE_EMOJI = { protein: '🍖', vegetable: '🥬' };
const ROLE_LABEL = { protein: '荤菜', vegetable: '素菜' };

/**
 * 屏蔽关键词在哪些字段里查找。
 * 都是能描述「这道菜是什么」的字段；**不含 steps / tips**——
 * 做法文字里常出现无关词，会造成大量误伤。
 */
const BLOCK_FIELDS = ['name', 'categoryName', 'description'];

/**
 * 唯一的屏蔽判断入口，荤素两个池子共用。
 * 中文按「包含即命中」：屏蔽「鱼」，清蒸鲈鱼 / 红烧鱼 / 鱼香肉丝 都算命中。
 */
function isBlocked(recipe, blockedKeywords) {
  if (!blockedKeywords || !blockedKeywords.length) return false;
  const haystack = [
    ...BLOCK_FIELDS.map((f) => recipe[f]),
    ...(recipe.ingredients || []),
    ...(recipe.tags || []),
  ].join('\n').toLowerCase();
  return blockedKeywords.some((k) => haystack.includes(String(k).toLowerCase()));
}

/**
 * 按屏蔽词过滤两个池子。
 * @returns {{available: {protein: [], vegetable: []}, blocked: number}}
 */
function rebuildAvailable(pools, blockedKeywords) {
  let blocked = 0;
  const available = { protein: [], vegetable: [] };
  for (const role of MENU_ROLES) {
    available[role] = (pools[role] || []).filter((r) => {
      if (isBlocked(r, blockedKeywords)) { blocked++; return false; }
      return true;
    });
  }
  return { available, blocked };
}

/** 支持中英文逗号、顿号、空格分隔一次输入多个 */
function parseKeywordInput(raw) {
  return dedupeKeywords(
    String(raw).split(/[,，、\s]+/).map((k) => k.trim()).filter(Boolean),
  );
}

/**
 * 当前的池子够不够凑出一桌。
 * short 里每项说明哪个角色缺几道，供界面如实展示。
 */
function menuPlan(available, mealSize) {
  const perRole = mealSize / 2;
  const need = { protein: perRole, vegetable: perRole };
  const short = MENU_ROLES
    .map((role) => ({ role, need: need[role], have: (available[role] || []).length }))
    .filter((x) => x.have < x.need);
  return { need, short, ok: short.length === 0 };
}

/** 从池子里不重复地取 n 道（部分洗牌，不改变原数组） */
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

/**
 * 选一桌菜。
 * @param available 已过滤的池子
 * @param mealSize  每餐几道（2/4/6/8）
 * @param prev      上一桌（用于「换一组」尽量避开），首次为 null
 * @returns 菜品数组；池子不足时返回 null
 */
function pickMenu(available, mealSize, prev) {
  if (!menuPlan(available, mealSize).ok) return null;

  const build = () => {
    const dishes = [];
    for (const role of MENU_ROLES) {
      const picked = sampleDistinct(available[role] || [], mealSize / 2);
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

/** 按 menuRole 分组，得到两个随机池 */
function buildPools(recipes) {
  const pools = { protein: [], vegetable: [] };
  for (const r of recipes) {
    if (pools[r.menuRole]) pools[r.menuRole].push(r);
  }
  return pools;
}

function roleLabel(recipe) {
  return ROLE_LABEL[recipe.menuRole] || recipe.categoryName;
}

module.exports = {
  MENU_ROLES,
  ROLE_EMOJI,
  ROLE_LABEL,
  BLOCK_FIELDS,
  isBlocked,
  rebuildAvailable,
  parseKeywordInput,
  menuPlan,
  sampleDistinct,
  sameMenu,
  pickMenu,
  buildPools,
  roleLabel,
};
