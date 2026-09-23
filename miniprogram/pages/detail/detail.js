/* ============================================================
   做法详情页
   ------------------------------------------------------------
   菜名 / 分类 / 难度 / 简介 / 食材 / 做法 / 小贴士 / 来源。
   营养估算只在「健康与营养」开启时出现，口径与 Web 版逐字一致。

   来源链接：小程序不能直接打开外部网页，改为「复制链接」，
   不强行跳转，也不假装能打开。
   ============================================================ */

const store = require('../../lib/store.js');
const { estimateRecipe, STATUS_TEXT, coverageText, fmt } = require('../../lib/nutrition.js');
const { roleLabel } = require('../../lib/menu.js');

Page({
  data: {
    ready: false,
    notFound: false,
    recipe: null,
    nutrition: null,
  },

  onLoad(options) {
    this.settings = store.loadSettings();

    const app = getApp();
    const recipe = app.findRecipe(options.id);

    if (!recipe) {
      this.setData({ ready: true, notFound: true });
      wx.setNavigationBarTitle({ title: '没找到这道菜' });
      return;
    }

    wx.setNavigationBarTitle({ title: recipe.name });

    // 营养区只在开启健康与营养时出现
    let nutrition = null;
    if (this.settings.healthNutritionEnabled === true && app.globalData.foodIndex) {
      const est = estimateRecipe(
        recipe,
        app.globalData.foodIndex,
        app.globalData.foodsData.unitConversions,
      );
      nutrition = this.nutritionModel(est);
    }

    const label = roleLabel(recipe);
    this.setData({
      ready: true,
      notFound: false,
      nutrition,
      recipe: {
        name: recipe.name,
        roleLabel: label,
        roleClass: recipe.menuRole,
        categoryName: label === recipe.categoryName ? '' : (recipe.categoryName || ''),
        stars: recipe.difficulty ? '★'.repeat(recipe.difficulty) : '',
        description: recipe.description || '',
        ingredients: recipe.ingredients || [],
        steps: recipe.steps || [],
        tips: recipe.tips || [],
        sourceName: recipe.sourceName || '',
        sourceUrl: recipe.sourceUrl || '',
        referenceName: recipe.referenceName || '',
        referenceUrl: recipe.referenceUrl || '',
        hasSource: !!(recipe.sourceUrl || recipe.referenceUrl),
      },
    });
  },

  /**
   * 单道菜的营养小结。
   * 「按菜谱所写用量的整份估算」——不是某个人实际吃进去的量。
   */
  nutritionModel(est) {
    if (est.status === 'none') {
      return { status: 'none', statusText: STATUS_TEXT.none, empty: true, notes: [] };
    }

    const notes = [];
    if (est.fryingOil) notes.push(`${est.fryingOil} 项油炸用油未计入`);
    if (est.noteCount) notes.push(`${est.noteCount} 条说明文字不计入`);

    return {
      status: est.status,
      statusText: STATUS_TEXT[est.status],
      empty: false,
      kcal: fmt(est.total.kcal),
      protein: fmt(est.total.protein, 1),
      carbs: fmt(est.total.carbs, 1),
      fat: fmt(est.total.fat, 1),
      coverage: coverageText(est.matched, est.totalCount),
      notes,
    };
  },

  /** 小程序不能直接打开外部网页，改为复制链接 */
  onCopyLink(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({ data: url });
  },
});
