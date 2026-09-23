# 任务单：营养语义重构（L3）

> 规划来源：`answers/规划模式 - 回答 - 20260923-1344 - 营养语义重构.md`
> 实施记录：`answers/实施模式 - 回答 - 20260923-1401 - 营养语义重构.md`
> 状态：**实施完成，已交付，待用户真实验证**
> 依据基线：`f8c874b`

---

## 用户确认的规则（已落地，不再作为待确认项）

- [x] **Q1** 手动能量区间 → 500 – 8000 kcal，仅技术防呆，不做健康判断
- [x] **Q2** 手动设定后，碳水/脂肪基准 → 跟随「每日能量参考」（手动值优先）
- [x] **Q3** 「每天吃几餐」用途 → 只作记录与展示，不参与任何计算

---

## 实施任务

- [x] **T1** 备份 6 个待改文件到 `history/*.before-20260923-v5`
- [x] **T2** `nutrition.js`：新增 `ENERGY_SOURCE` / `DAILY_ENERGY_LIMITS` / `dailyEnergyReference()` / `macroRanges()`
- [x] **T3** `nutrition.js`：`validateMember()` 扩展（严格限定在 `manual` 分支内）⚠️ 最高风险
- [x] **T4** `app.js`：`normalizeMember()` / `loadSettings()` 新增字段默认回填
- [x] **T5** `app.js`：`memberHealthHtml()` 术语与分区重写（维持能量 → 每日能量参考）
- [x] **T6** `app.js`：`renderNutrition()` / `cardHtml()` / `recipeNutritionHtml()` / `renderStaple()` 口径重写
- [x] **T7** `app.js`：`mealsPerDay` 读写 + 渲染 + 事件
- [x] **T8** `index.html`：成员表单新增「每日能量来源」；设置页新增「每天吃几餐」（放进 `#hn-sections` 内部）
- [x] **T9** `styles.css`：新增 `.s-sizes--2/--5`、`.s-size--text`、`.mh-energy*`、`.nutri-scope-note`；修复 `.mf-field[hidden]`
- [x] **T10** 新增 `tools/check-nutrition-semantics.mjs`：断言 A–G 共 72 条
- [x] **T11** 跑自动化断言 + 浏览器页面级验证 B1–B11
- [x] **T12** `specs.md` / `README.md` 同步（README 主食口径已改写）
- [x] **T13** 实施模式回答 + `project-achievements.md` 更新 + 本文件勾选

---

## 验收

- [x] 自动化断言 72 条全部通过，每条打印实测值（无静默跳过）
- [x] 覆盖率自检回归：与重构前逐项相同（121 / 234 / 15，识别率 80.8%）
- [x] 页面验证 B1–B11 全部通过（真实浏览器，非推断）
- [x] 全仓口径扫描：无 `维持能量` / `全家的量` / `实际吃掉的量` / `整锅` / `整顿饭` 残留
- [x] 老数据回归：真实老格式成员「甲」完整保留，按 auto 处理
- [ ] **用户真实验证 5 步**（打开 → 开开关 → 加两位成员 → 看措辞 → 关开关）

---

## 未验证风险（详见回答文件 §12）

- 线上 GitHub Pages 表现未实机确认（本地实测通过，代码同源）
- 用户历史 localStorage 若存在更早期形态未覆盖
- 项目中文名「今晚吃什么」未改（用户本轮明确禁止顺手改）→ ✅ （2026-09-23 已单独开一轮完成重命名，提交 a8af68f）
- `renderPeopleGroup()` 的三元死代码未修（本轮不做项）

---

## 本轮不做（硬边界，已逐条核对）

不改项目中文名 · 不引入午/晚餐独立生成 · 不引入饮食日历/库存/历史/数据库 ·
不做「每日能量 ÷ 餐数 = 每餐目标」· 不做「占今日目标 X%」· 不做实际摄入追踪/称重/营养处方 ·
不动 `data/*.json`、`tools/build-*.mjs`、`tools/serve.mjs`、`tools/deploy-cloudbase.mjs`、`canvas/`
