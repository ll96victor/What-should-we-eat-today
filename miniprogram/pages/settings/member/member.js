/* ============================================================
   家庭成员页
   ------------------------------------------------------------
   两个视图共用一个页面：
     list —— 成员列表 + 每位成员各自的健康参考 + 删除二次确认
     form —— 新增 / 编辑（**新增与编辑共用同一个表单**，不允许两套）

   硬性语义（与 Web 版一致）：
   - 每位成员各有一份**独立**的「每日能量参考」，来源标明是自动估算还是自己设定
   - 资料不全就标「资料不全」，不出结果也不猜
   - 删除需二次确认，且不得影响其他成员，也不得清空菜谱/屏蔽词/菜品数量/主食设置
   - 成员资料只存在这台手机上
   ============================================================ */

const store = require('../../../lib/store.js');
const { MAX_MEMBERS, newMemberId } = require('../../../lib/settings.js');
const {
  ACTIVITY_LEVELS, ENERGY_SOURCE, DAILY_ENERGY_LIMITS, NAME_MAX,
  validateMember, healthMetrics, dailyEnergyReference, macroRanges, fmt,
} = require('../../../lib/nutrition.js');

const GENDERS = [
  { key: 'male', label: '男' },
  { key: 'female', label: '女' },
];

const EMPTY_FORM = {
  id: null,
  name: '',
  genderIndex: 0,
  age: '',
  heightCm: '',
  weightKg: '',
  activityIndex: 0,
  energyMode: 'auto',
  dailyEnergyManual: '',
};

Page({
  data: {
    mode: 'list',
    members: [],
    confirmId: null,
    maxMembers: MAX_MEMBERS,
    nameMax: NAME_MAX,
    genderLabels: GENDERS.map((g) => g.label),
    activityLabels: ACTIVITY_LEVELS.map((a) => `${a.label}　${a.hint}`),
    // 顺序固定为 [自动估算, 自己设定]，与表单里两个按钮的先后一致
    energyLabels: [ENERGY_SOURCE.auto.label, ENERGY_SOURCE.manual.label],
    energyLimits: DAILY_ENERGY_LIMITS,
    form: { ...EMPTY_FORM },
    formErr: '',
  },

  onShow() {
    this.settings = store.loadSettings();
    this.renderList();
  },

  renderList() {
    this.setData({
      mode: 'list',
      members: this.settings.members.map((m) => this.memberModel(m)),
    });
  },

  // ---- 列表 ----

  /** 一位成员的展示模型：基本信息 + 该成员独立的健康参考 */
  memberModel(m) {
    const activity = ACTIVITY_LEVELS.find((a) => a.key === m.activityLevel);
    const model = {
      id: m.id,
      name: m.name,
      enabled: m.enabled,
      meta: `${m.age}岁 · ${m.heightCm}cm · ${m.weightKg}kg · ${activity ? activity.label : ''}`,
      hasMetrics: false,
      bmiLabel: '资料不全',
    };

    // 资料不完整时不出结果，也不猜
    const metrics = healthMetrics(m);
    if (!metrics) return model;

    const energy = dailyEnergyReference(m, metrics);
    const ranges = macroRanges(energy.kcal);

    return {
      ...model,
      hasMetrics: true,
      bmiLabel: metrics.bmiCategory.label,
      bmi: fmt(metrics.bmi, 1),
      bmr: fmt(metrics.bmr),
      energyText: energy.hasValue ? `${fmt(energy.kcal)} kcal / 天` : '还没填数字',
      energyLabel: energy.label,
      energyNote: energy.hasValue
        ? '一整天的参考量，包含早餐、午餐、晚餐以及其他摄入。'
        : '选了「自己设定」但还没填数字，编辑这位成员补上即可。',
      foot1: ranges
        ? `每天参考：蛋白质 ${fmt(metrics.proteinG)} g　·　`
          + `碳水 ${fmt(ranges.carbsLow)}–${fmt(ranges.carbsHigh)} g　·　`
          + `脂肪 ${fmt(ranges.fatLow)}–${fmt(ranges.fatHigh)} g`
        : '',
      foot2: ranges
        ? '碳水与脂肪由上面的每日能量参考推算，只是范围，不是必须吃到。'
        : '填上每日能量参考以后，这里会给出碳水与脂肪的参考范围。',
    };
  },

  onAdd() {
    if (this.settings.members.length >= MAX_MEMBERS) {
      wx.showToast({ title: `最多添加 ${MAX_MEMBERS} 位家庭成员`, icon: 'none' });
      return;
    }
    this.setData({
      mode: 'form',
      form: { ...EMPTY_FORM },
      formErr: '',
    });
    wx.setNavigationBarTitle({ title: '添加成员' });
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.settings.members.find((x) => x.id === id);
    if (!m) return;

    const activityIndex = Math.max(
      0, ACTIVITY_LEVELS.findIndex((a) => a.key === m.activityLevel),
    );
    const genderIndex = Math.max(0, GENDERS.findIndex((g) => g.key === m.gender));
    const mode = m.dailyEnergyMode === 'manual' ? 'manual' : 'auto';

    this.setData({
      mode: 'form',
      formErr: '',
      form: {
        id: m.id,
        name: m.name,
        genderIndex,
        age: String(m.age),
        heightCm: String(m.heightCm),
        weightKg: String(m.weightKg),
        activityIndex,
        energyMode: mode,
        dailyEnergyManual: m.dailyEnergyManual != null ? String(m.dailyEnergyManual) : '',
      },
    });
    wx.setNavigationBarTitle({ title: '编辑成员' });
  },

  onToggle(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.settings.members.find((x) => x.id === id);
    if (!m) return;
    m.enabled = !m.enabled;
    this.persist();
    this.renderList();
  },

  onAskDelete(e) {
    this.setData({ confirmId: e.currentTarget.dataset.id });
  },

  onCancelDelete() {
    this.setData({ confirmId: null });
  },

  /** 删除只影响这一位成员，不动其他成员，也不动菜谱/屏蔽词/菜品数量/主食 */
  onConfirmDelete(e) {
    const id = e.currentTarget.dataset.id;
    this.settings.members = this.settings.members.filter((m) => m.id !== id);
    this.persist();
    this.setData({ confirmId: null });
    this.renderList();
  },

  // ---- 表单 ----

  onFormName(e) {
    this.setData({ 'form.name': e.detail.value });
  },

  onFormGender(e) {
    this.setData({ 'form.genderIndex': Number(e.detail.value) });
  },

  onFormAge(e) {
    this.setData({ 'form.age': e.detail.value });
  },

  onFormHeight(e) {
    this.setData({ 'form.heightCm': e.detail.value });
  },

  onFormWeight(e) {
    this.setData({ 'form.weightKg': e.detail.value });
  },

  onFormActivity(e) {
    this.setData({ 'form.activityIndex': Number(e.detail.value) });
  },

  /** 只有选了「自己设定」才需要填数字 */
  onFormEnergyMode(e) {
    const mode = e.currentTarget.dataset.mode === 'manual' ? 'manual' : 'auto';
    // 「自动估算」时不保留输入框里的数字，避免看起来像还在用手动值
    const patch = { 'form.energyMode': mode, formErr: '' };
    if (mode !== 'manual') patch['form.dailyEnergyManual'] = '';
    this.setData(patch);
  },

  onFormEnergyManual(e) {
    this.setData({ 'form.dailyEnergyManual': e.detail.value });
  },

  onFormCancel() {
    this.setData({ form: { ...EMPTY_FORM }, formErr: '' });
    wx.setNavigationBarTitle({ title: '家庭成员' });
    this.renderList();
  },

  onFormSave() {
    const f = this.data.form;
    const mode = f.energyMode === 'manual' ? 'manual' : 'auto';

    // 读原始输入（数字不 trim，交给 validateMember 统一判定）
    const draft = {
      id: f.id,
      name: String(f.name || '').trim(),
      gender: GENDERS[f.genderIndex] ? GENDERS[f.genderIndex].key : 'male',
      age: f.age,
      heightCm: f.heightCm,
      weightKg: f.weightKg,
      activityLevel: ACTIVITY_LEVELS[f.activityIndex]
        ? ACTIVITY_LEVELS[f.activityIndex].key : 'sedentary',
      dailyEnergyMode: mode,
      // 自动估算时不读数字：这个值会存成 null，来源不会含糊
      dailyEnergyManual: mode === 'manual' ? f.dailyEnergyManual : '',
    };

    const err = validateMember(draft);
    if (err) {
      this.setData({ formErr: err });
      return;
    }

    const existing = draft.id
      ? this.settings.members.find((m) => m.id === draft.id) : null;

    const member = {
      id: draft.id || newMemberId(),
      name: draft.name,
      gender: draft.gender,
      age: Number(draft.age),
      heightCm: Number(draft.heightCm),
      weightKg: Number(draft.weightKg),
      activityLevel: draft.activityLevel,
      dailyEnergyMode: mode,
      dailyEnergyManual: mode === 'manual' ? Number(draft.dailyEnergyManual) : null,
      // 编辑时保留原来的启用状态
      enabled: existing ? existing.enabled !== false : true,
    };

    if (draft.id) {
      const i = this.settings.members.findIndex((m) => m.id === draft.id);
      if (i >= 0) this.settings.members[i] = member;
      else this.settings.members.push(member);
    } else {
      if (this.settings.members.length >= MAX_MEMBERS) {
        this.setData({ formErr: `最多添加 ${MAX_MEMBERS} 位家庭成员` });
        return;
      }
      this.settings.members.push(member);
    }

    this.persist();
    this.setData({ form: { ...EMPTY_FORM }, formErr: '' });
    wx.setNavigationBarTitle({ title: '家庭成员' });
    this.renderList();
  },

  persist() {
    store.saveSettings(this.settings);
  },
});
