/* ============================================================
   首页：打开即见一桌荤素搭配的菜
   ------------------------------------------------------------
   默认只显示菜；「健康与营养」开启后才追加主食与本餐估算。
   关闭时**不显示也不计算**任何营养内容，但设置数据保留。

   业务逻辑全部来自 lib/，本文件只负责「组装视图模型 + 处理事件」。
   注意：菜谱对象（几百 KB）绝不放进 setData，只放算好的小视图模型。
   ============================================================ */

const store = require('../../lib/store.js');
const {
  MENU_PHRASE, STAPLE_PER_PERSON, effectiveDiners, SHARE_TITLE, HOME_PATH,
} = require('../../lib/settings.js');
const {
  ROLE_EMOJI, ROLE_LABEL, rebuildAvailable, menuPlan, pickMenu, roleLabel,
} = require('../../lib/menu.js');
const {
  estimateRecipe, summarizeMeal, nutritionOf, STATUS_TEXT, fmt,
} = require('../../lib/nutrition.js');

Page({
  data: {
    ready: false,
    loadError: '',
    heroSub: '',
    hint: '',
    cards: [],
    notice: null,
    canReroll: false,
    staple: null,
    meal: null,
  },

  // ---- 非渲染状态：不参与 setData ----

  settings: null,
  available: { protein: [], vegetable: [] },
  blocked: 0,
  current: null,
  estimates: [],
  summary: null,
  lastMealSize: null,

  onShow() {
    const app = getApp();
    const g = app.globalData;

    if (!g.ready) {
      this.setData({
        ready: false,
        loadError: g.loadError || '数据没准备好',
        notice: {
          title: '数据没加载成功',
          lines: [g.loadError || '未知错误'],
        },
        canReroll: false,
      });
      return;
    }

    this.settings = store.loadSettings();
    this.setData({ ready: true, loadError: '' });

    this.refresh();
    this.render();
  },

  /** 按当前设置重建可用池，并决定是否重新选一桌 */
  refresh() {
    const g = getApp().globalData;
    const { available, blocked } = rebuildAvailable(g.pools, this.settings.blockedKeywords);
    this.available = available;
    this.blocked = blocked;

    const sizeChanged = this.lastMealSize !== this.settings.mealSize;
    const plan = menuPlan(this.available, this.settings.mealSize);

    if (!plan.ok) {
      // 池子不足：明确报错，禁用换组，不返回残缺菜单
      this.current = null;
      this.estimates = [];
      this.summary = null;
      this.lastMealSize = this.settings.mealSize;
      this.shortage = plan;
      return;
    }

    this.shortage = null;
    // 屏蔽词可能被改过：在桌的菜只要有一道已经进了屏蔽名单，就整桌重选，
    // 否则用户会看到「明明屏蔽了鱼，桌上还有鱼」。
    const stillAllowed = !!this.current && this.current.every((r) => (
      (this.available[r.menuRole] || []).some((x) => x.id === r.id)
    ));

    if (!this.current || sizeChanged || !stillAllowed) {
      this.current = pickMenu(this.available, this.settings.mealSize, null);
      this.lastMealSize = this.settings.mealSize;
    }

    // 理论上 plan.ok 通过时 pickMenu 不会失败；真失败了也走同一套报错，
    // 不留下「空菜单 + 可点换组」这种半残状态。
    if (!this.current) {
      this.shortage = plan;
      this.estimates = [];
      this.summary = null;
      return;
    }

    this.recompute();
  },

  onReroll() {
    if (this.shortage || !this.current) return;
    const next = pickMenu(this.available, this.settings.mealSize, this.current);
    if (!next) { this.refresh(); this.render(); return; }
    this.current = next;
    this.recompute();
    this.render();
  },

  onOpenSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  /**
   * 转发给朋友（右上角「…」里的原生入口）。
   * 落地页就是首页：这一桌菜是当场随机出来的，写进分享路径对方打开的
   * 也不会是同一桌，与其给一个会变的期望，不如直接让对方自己摇一桌。
   */
  onShareAppMessage() {
    return { title: SHARE_TITLE, path: HOME_PATH };
  },

  onCardTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // ---- 主食 ----

  onStapleChange(e) {
    const index = Number(e.detail.value);
    const staples = this.stapleFoods();
    const food = staples[index];
    if (!food) return;
    this.settings.staple.key = food.key;
    store.saveSettings(this.settings);
    this.recompute();
    this.render();
  },

  onStapleGrams(e) {
    const raw = Number(e.detail.value);
    const v = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 5000) : 0;
    this.settings.staple.grams = v;
    // 一旦手改就退出「按人数自动」
    this.settings.staple.auto = false;
    store.saveSettings(this.settings);
    this.recompute();
    this.render();
  },

  stapleFoods() {
    const foods = getApp().globalData.foodsData;
    return (foods && foods.foods ? foods.foods : []).filter((f) => f.staple);
  },

  /** 主食当前使用多少克；自动模式下按本次用餐人数推算 */
  stapleGrams() {
    if (this.settings.staple.auto) {
      return effectiveDiners(this.settings) * STAPLE_PER_PERSON;
    }
    return Number(this.settings.staple.grams) || 0;
  },

  // ---- 营养估算 ----

  /** 健康与营养关闭时不做任何计算——数据保留，只是不参与 */
  recompute() {
    const g = getApp().globalData;
    const on = this.settings.healthNutritionEnabled === true;

    if (!on || !g.foodIndex || !this.current) {
      this.estimates = [];
      this.summary = null;
      return;
    }

    const units = g.foodsData.unitConversions;
    this.estimates = this.current.map((recipe) => ({
      recipe,
      est: estimateRecipe(recipe, g.foodIndex, units),
    }));

    const grams = this.stapleGrams();
    const key = this.settings.staple.key;
    const staple = grams > 0
      ? { key, grams, nutri: nutritionOf(key, grams, g.foodIndex) }
      : null;

    this.summary = summarizeMeal(this.estimates, staple, effectiveDiners(this.settings));
  },

  // ---- 渲染 ----

  render() {
    if (this.shortage) { this.renderShortage(); return; }

    const cards = (this.current || []).map((recipe) => this.cardModel(recipe));
    const hnOn = this.settings.healthNutritionEnabled === true;

    this.setData({
      cards,
      notice: null,
      canReroll: true,
      heroSub: this.heroSubText(),
      hint: this.hintText(),
      staple: hnOn ? this.stapleModel() : null,
      meal: hnOn ? this.mealModel() : null,
    });
  },

  cardModel(recipe) {
    const est = this.estimates.find((e) => e.recipe === recipe);

    // 热量只在开启健康与营养后才出现在卡片上；关闭时卡片只有菜名。
    // 写「整份约」而不是裸数字：这是菜谱所写用量的整份估算。
    let kcalText = '';
    if (this.settings.healthNutritionEnabled === true && est && est.est.status !== 'none') {
      kcalText = `整份约 ${fmt(est.est.total.kcal)} kcal${est.est.status === 'partial' ? '*' : ''}`;
    }

    return {
      id: recipe.id,
      name: recipe.name,
      roleClass: recipe.menuRole,
      roleLabel: roleLabel(recipe),
      emoji: ROLE_EMOJI[recipe.menuRole] || '🍽️',
      categoryName: roleLabel(recipe) === recipe.categoryName ? '' : (recipe.categoryName || ''),
      stars: recipe.difficulty ? '★'.repeat(recipe.difficulty) : '',
      ingredientsPreview: (recipe.ingredients || []).slice(0, 4).join(' · '),
      kcalText,
    };
  },

  heroSubText() {
    const half = this.settings.mealSize / 2;
    return `${MENU_PHRASE[half] || `${this.settings.mealSize} 道菜`}，已经帮你配好了`;
  },

  hintText() {
    let text = `已收录 ${getApp().globalData.total} 道家常菜谱 · 点卡片看做法`;
    if (this.blocked) text += ` · 已屏蔽 ${this.blocked} 道`;
    return text;
  },

  stapleModel() {
    const staples = this.stapleFoods();
    let index = staples.findIndex((f) => f.key === this.settings.staple.key);
    if (index < 0) {
      // 存储里的主食键已失效时回落到第一项，并写回设置
      index = 0;
      if (staples[0]) {
        this.settings.staple.key = staples[0].key;
        store.saveSettings(this.settings);
      }
    }
    const grams = this.stapleGrams();
    const diners = effectiveDiners(this.settings);
    const per = diners > 0 ? grams / diners : 0;
    const food = staples[index];

    // 说的是「准备量」而不是「吃掉的量」：这只是本次拿来算营养的数字，
    // 不代表每个人实际吃了多少，也不代表你一定按这个量下锅。
    const note = grams > 0
      ? `本次用于计算的主食准备量${this.settings.staple.auto ? `（按 ${diners} 人自动填）` : ''}；`
        + `人均 ${fmt(per)} g 是把总克数除以人数，不代表每个人吃了这么多。`
        + (food ? `　·　${food.usdaDescription}` : '')
      : '填 0 表示这顿不算主食';

    return {
      names: staples.map((f) => (f.names && f.names[0]) || f.key),
      index,
      grams,
      note,
    };
  },

  mealModel() {
    const s = this.summary;
    if (!s) return null;

    const dishes = s.dishes;
    const withData = s.dishesWithData;
    let status = 'full';
    if (withData === 0) status = 'none';
    else if (withData < dishes) status = 'partial';
    else if (s.dishesFull < dishes) status = 'partial';

    const people = effectiveDiners(this.settings);
    const staples = this.stapleFoods();
    const stapleFood = staples.find((f) => f.key === this.settings.staple.key);

    const parts = [`${dishes} 道菜`];
    if (s.hasStaple) {
      parts.push(`${stapleFood ? stapleFood.names[0] : '主食'}准备量 ${fmt(this.stapleGrams())}g`);
    }
    const skipped = this.estimates.filter((e) => e.est.fryingOil).length;

    const lines = [
      `按菜谱所写用量 + 本次主食准备量估算：${parts.join(' + ')}`,
      `${withData} / ${dishes} 道菜有可用营养数据${skipped ? `　·　${skipped} 道菜的油炸用油未计入` : ''}`,
      '人均只是把合计除以人数，不代表每个人实际吃了相同份量。',
      '菜谱写多少就按多少算——既不是你实际买的量、实际下锅的量，也不是实际吃进去的量。',
    ];

    return {
      status,
      statusText: STATUS_TEXT[status],
      people,
      totalKcal: fmt(s.total.kcal),
      totalProtein: fmt(s.total.protein, 1),
      totalCarbs: fmt(s.total.carbs, 1),
      totalFat: fmt(s.total.fat, 1),
      perKcal: fmt(s.perPerson.kcal),
      perProtein: fmt(s.perPerson.protein, 1),
      perCarbs: fmt(s.perPerson.carbs, 1),
      perFat: fmt(s.perPerson.fat, 1),
      lines,
    };
  },

  renderShortage() {
    const { need, short } = this.shortage;
    const detail = short
      .map((s) => `${ROLE_LABEL[s.role]}只剩 ${s.have} 道，需要 ${s.need} 道`)
      .join('；');

    this.setData({
      cards: [],
      canReroll: false,
      heroSub: this.heroSubText(),
      hint: '屏蔽条件太严了',
      staple: null,
      meal: null,
      notice: {
        title: `凑不出 ${this.settings.mealSize} 道菜`,
        lines: [
          `${this.settings.mealSize} 道需要 ${need.protein} 道荤菜 + ${need.vegetable} 道素菜，但现在${detail}。`,
          '减少几个屏蔽关键词，或者把每餐数量调小一点。',
        ],
      },
    });
  },
});
