/* ============================================================
   今天吃什么 · 微信小程序版（V2）
   ------------------------------------------------------------
   打开小程序 → 直接看到今天吃什么 → 随机得到一桌家常菜
   → 不满意就换一组 → 满意就点菜看做法。

   数据与业务规则全部复用 Web 版：
   - 菜谱与营养数据来自 miniprogram/data/*.js（由 tools/build-miniprogram.mjs
     从仓库根的 data/*.json 生成，源头唯一）
   - 营养计算来自 miniprogram/lib/nutrition.js（复制自仓库根的 nutrition.js）
   - 随机菜单与屏蔽逻辑见 miniprogram/lib/menu.js

   全程不发任何网络请求，飞行模式下核心功能可用。
   ============================================================ */

const recipesData = require('./data/recipes.js');
const foodsData = require('./data/foods.js');
const { buildIndex } = require('./lib/nutrition.js');
const { buildPools, MENU_ROLES } = require('./lib/menu.js');

/** 兼容两种顶层形态：数组 或 { recipes: [...] }（与 Web 版启动时的处理一致） */
function asRecipeArray(data) {
  return Array.isArray(data) ? data : (data.recipes || []);
}

App({
  globalData: {
    recipes: [],
    pools: { protein: [], vegetable: [] },
    total: 0,
    foodsData: null,
    foodIndex: null,
    ready: false,
    loadError: '',
  },

  onLaunch() {
    this.loadData();
  },

  loadData() {
    try {
      const recipes = asRecipeArray(recipesData);
      if (!recipes.length) throw new Error('菜谱数据为空');

      const pools = buildPools(recipes);
      const missing = MENU_ROLES.filter((role) => !pools[role].length);
      if (missing.length) throw new Error(`缺少菜谱池：${missing.join('、')}`);

      this.globalData.recipes = recipes;
      this.globalData.pools = pools;
      this.globalData.total = recipes.length;
      this.globalData.foodsData = foodsData;
      this.globalData.foodIndex = buildIndex(foodsData);
      this.globalData.ready = true;

      console.log(`[今天吃什么] 数据就绪：${recipes.length} 道菜谱，`
        + `荤 ${pools.protein.length} / 素 ${pools.vegetable.length}`);
    } catch (e) {
      console.error('[今天吃什么] 数据加载失败：', e);
      this.globalData.ready = false;
      this.globalData.loadError = (e && e.message) ? e.message : String(e);
    }
  },

  /** 按 id 找菜谱（详情页用） */
  findRecipe(id) {
    return this.globalData.recipes.find((r) => r.id === id) || null;
  },
});
