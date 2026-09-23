/* ============================================================
   设置页
   ------------------------------------------------------------
   每餐菜品数量、屏蔽关键词、健康与营养开关；
   开关打开后再出现：家庭成员入口、本次用餐人数、每天通常吃几餐、
   日常饮食参考，以及底部的口径说明。

   设置存在本机（lib/store.js），不上传、不需要账号。
   改动即时生效：首页在 onShow 时会重新读设置。
   ============================================================ */

const store = require('../../lib/store.js');
const {
  MEAL_SIZES, PEOPLE, MENU_PHRASE, effectiveDiners, dedupeKeywords,
} = require('../../lib/settings.js');
const { parseKeywordInput } = require('../../lib/menu.js');
const {
  MEALS_PER_DAY_OPTIONS, MAX_MEMBERS, DIET_REFERENCE,
} = require('../../lib/nutrition.js');

Page({
  data: {
    hnOn: false,
    mealSizes: [],
    sizeNote: '',
    keywords: [],
    kwInput: '',
    kwErr: '',
    people: [],
    peopleNote: '',
    overridden: false,
    meals: [],
    mealsNote: '',
    membersCount: 0,
    maxMembers: MAX_MEMBERS,
    dietList: [],
  },

  onShow() {
    this.settings = store.loadSettings();
    this.render();
  },

  render() {
    const s = this.settings;
    const half = s.mealSize / 2;
    const diners = effectiveDiners(s);
    const enabledCount = s.members.filter((m) => m.enabled).length;
    const overridden = s.currentMealHouseholdSize != null;

    let peopleNote;
    if (enabledCount > 0) {
      peopleNote = `家庭成员 ${enabledCount} 人，本次按 ${diners} 人算`;
    } else {
      peopleNote = `当前 ${diners} 人　·　主食人均约 150 g`;
    }

    this.setData({
      hnOn: s.healthNutritionEnabled === true,
      mealSizes: MEAL_SIZES.map((v) => ({ value: v, active: v === s.mealSize })),
      sizeNote: `当前：${MENU_PHRASE[half] || `${s.mealSize} 道`}`
        + `（${half} 道荤菜 + ${half} 道素菜）`,
      keywords: s.blockedKeywords.slice(),
      people: PEOPLE.map((v) => ({ value: v, active: v === diners })),
      peopleNote,
      overridden,
      meals: MEALS_PER_DAY_OPTIONS.map((v) => ({ value: v, active: v === s.mealsPerDay })),
      mealsNote: `当前记录：每天 ${s.mealsPerDay} 餐　·　只用来记录你的习惯，不参与任何能量计算`,
      membersCount: s.members.length,
      dietList: DIET_REFERENCE,
    });
  },

  persist() {
    store.saveSettings(this.settings);
  },

  // ---- 每餐数量 ----

  onSizeTap(e) {
    const size = Number(e.currentTarget.dataset.value);
    if (!MEAL_SIZES.includes(size) || size === this.settings.mealSize) return;
    this.settings.mealSize = size;
    this.persist();
    this.render();
  },

  // ---- 屏蔽关键词 ----

  onKwInput(e) {
    this.setData({ kwInput: e.detail.value });
  },

  onKwAdd() {
    const incoming = parseKeywordInput(this.data.kwInput);
    if (!incoming.length) {
      this.setData({ kwErr: '先输入关键词再添加' });
      return;
    }
    const before = this.settings.blockedKeywords.length;
    this.settings.blockedKeywords = dedupeKeywords([
      ...this.settings.blockedKeywords, ...incoming,
    ]);
    const err = this.settings.blockedKeywords.length === before
      ? '这个关键词已经在屏蔽列表里了' : '';
    this.persist();
    this.setData({ kwInput: '', kwErr: err });
    this.render();
  },

  onKwRemove(e) {
    const target = String(e.currentTarget.dataset.kw || '').toLowerCase();
    if (!target) return;
    this.settings.blockedKeywords = this.settings.blockedKeywords
      .filter((k) => k.toLowerCase() !== target);
    this.persist();
    this.setData({ kwErr: '' });
    this.render();
  },

  onKwClear() {
    if (!this.settings.blockedKeywords.length) return;
    this.settings.blockedKeywords = [];
    this.persist();
    this.setData({ kwErr: '' });
    this.render();
  },

  // ---- 健康与营养开关 ----

  /**
   * 关闭时保留成员、主食、屏蔽等全部数据，只是不再显示与计算。
   * 随机菜单完全不受这个开关影响。
   */
  onToggleHn(e) {
    this.settings.healthNutritionEnabled = e.detail.value === true;
    this.persist();
    this.render();
  },

  // ---- 家庭成员 ----

  onOpenMembers() {
    wx.navigateTo({ url: '/pages/settings/member/member' });
  },

  // ---- 本次用餐人数 ----

  onPeopleTap(e) {
    const n = Number(e.currentTarget.dataset.value);
    if (!PEOPLE.includes(n)) return;
    this.settings.currentMealHouseholdSize = n;
    this.persist();
    this.render();
  },

  onPeopleFollow() {
    this.settings.currentMealHouseholdSize = null;
    this.persist();
    this.render();
  },

  // ---- 每天通常吃几餐：只记录习惯，刻意不触发任何重算 ----

  onMealsTap(e) {
    const n = Number(e.currentTarget.dataset.value);
    if (!MEALS_PER_DAY_OPTIONS.includes(n) || n === this.settings.mealsPerDay) return;
    this.settings.mealsPerDay = n;
    this.persist();
    this.render();
  },
});
