# 今晚吃什么

一个纯静态的家庭小工具，只解决一件事：

> **每天做饭时，不知道今晚吃什么。**

打开页面 → 自动给出一荤一素 → 不满意就「换一组」→ 点菜名看完整做法。
目标是 10 秒内决定今晚吃什么，不用注册、不用登录、不用联网调接口。

---

## 快速开始

需要 Node.js（本机已验证 v24）。在项目目录执行：

```bash
node tools/serve.mjs
```

然后浏览器打开 <http://localhost:5173>。

> **不要直接双击 `index.html`。** 浏览器不允许 `file://` 页面读取本地 JSON，
> 直接打开会看到「需要通过本地服务器打开」的提示。用上面的命令起一个本地服务器即可。
>
> 不想用 Node 也可以：`python -m http.server 5173`，效果一样。

---

## 项目结构

```text
What-should-we-eat-today/
├── index.html            页面骨架
├── styles.css            样式（移动端优先）
├── app.js                全部前端逻辑：随机菜单 + 做法详情
├── data/
│   └── recipes.json      ★ 菜谱数据（唯一事实源，370 道）
├── assets/
│   └── favicon.svg
├── tools/
│   ├── serve.mjs         本地静态服务器（零依赖）
│   ├── build-recipes.mjs 从上游重建菜谱数据
│   └── deploy-cloudbase.mjs  CloudBase 部署辅助（见下文）
└── README.md
```

技术栈就是 **原生 HTML / CSS / JavaScript**，没有框架、没有打包工具、没有后端、没有数据库。
所有逻辑都在浏览器里运行。

---

## 菜谱数据

### 来源

菜谱来自开源项目 **[Anduin2017/HowToCook](https://github.com/Anduin2017/HowToCook)（程序员做饭指南）**，
上游采用 **Unlicense**（公有领域）授权，可自由使用与再分发。

本项目**只提取 V1 真正需要的文字信息**（菜名、食材用量、做法步骤、小贴士、来源链接），
不复制上游项目结构，也不下载上游图片。

当前收录 **370 道**（上游 371 篇，其中 1 篇同名重复已合并）：

| menuRole | 数量 | 说明 |
|---|---:|---|
| `protein` | 188 | **随机池**：肉、水产、蛋、豆腐、豆类，含肉汤 |
| `vegetable` | 42 | **随机池**：以蔬菜为主料的家常素菜 |
| `staple` | 75 | 主食、粥、面点（不进随机池） |
| `dessert` | 25 | 甜品、糖水（不进随机池） |
| `drink` | 23 | 饮品（不进随机池） |
| `condiment` | 10 | 调料酱汁（不进随机池） |
| `breakfast` | 7 | 佐餐小食：水煮蛋、卤蛋等（不进随机池） |

随机池共 **230 道**（188 × 42 = 7896 种搭配组合）。

> 白煮蛋、温泉蛋、卤蛋这类「佐餐小食」是有意**不放进随机池**的：
> 它们确实提供蛋白质，但抽到「溏心蛋 + 蒜蓉西兰花」不像一顿正经晚饭。
> 它们仍然完整保留在数据里，以后做搜索或浏览时可以直接用。

**关于数量**：需求目标是 1000～3000 道。上游 HowToCook 公开的高质量中文菜谱总量就是 371 篇，
本项目没有为了凑数去抓取版权和质量无法确认的数据源。缺口的补齐方式见文末「下一步」。

### 字段说明

```jsonc
{
  "id": "htc-1a2b3c4d5e",     // 稳定 id，由上游文件路径派生
  "name": "西红柿炒鸡蛋",
  "menuRole": "protein",       // ★ 随机菜单归属：protein | vegetable | staple | ...
  "category": "vegetable_dish",// 上游原始分类，保留用于展示与以后扩展
  "categoryName": "素菜",       // 分类中文名
  "description": "一道酸甜开胃的家常菜肴……",
  "ingredients": ["西红柿 = 1 个（约 180g） * 份数", "..."],
  "steps": ["西红柿洗净", "..."],
  "tips": ["快速做法：……"],
  "difficulty": 2,             // 1~5 星，可能为 null
  "calories": null,
  "imageUrl": null,            // 预留字段，V1 不使用（见下）
  "sourceName": "HowToCook 程序员做饭指南",
  "sourceUrl": "https://github.com/Anduin2017/HowToCook/blob/master/...",
  "referenceName": "...",      // 上游标注的参考视频/文章，可能为 null
  "referenceUrl": null,
  "tags": ["素菜", "新手友好"]
}
```

**`menuRole` 是最重要的字段**，决定这道菜进哪个随机池。上游按「荤菜 / 素菜」分目录，
但家常菜里鸡蛋、豆腐、豆类同属蛋白质来源，部分肉汤也实际是正经菜，因此生成脚本里有一张
**人工复核的修正表**（`tools/build-recipes.mjs` 的 `ROLE_OVERRIDE`），逐条把语义纠正到位。

### 图片

`imageUrl` 字段保留但当前**全部为 `null`**。原因是上游图片托管在境外 CDN，
而本项目面向国内家庭网络，不适合把图片作为核心依赖。

**没有图片不影响任何功能**：卡片用类别配色 + emoji 兜底，详情页完全是文字。
以后接入国内可访问的图床时，只要往 `imageUrl` 填地址即可自动生效，
图片加载失败也会自动回落到 emoji（`app.js` 的 `cardVisual()`）。

### 重建数据

```bash
node tools/build-recipes.mjs            # 用本地缓存重建
node tools/build-recipes.mjs --refresh  # 强制重新联网拉取上游最新菜谱
```

上游 md 原文缓存在 `tools/.cache/`（不入库）。重建后会打印数据校验结果。

---

## 部署

本项目是纯静态站点，**不需要任何构建步骤**，仓库根目录即可直接部署。

### GitHub Pages

1. 把仓库推到 GitHub。
2. 仓库 **Settings → Pages**。
3. Source 选 **Deploy from a branch**，分支选 `main`，目录选 **`/ (root)`**。
4. 保存后访问 `https://<你的用户名>.github.io/What-should-we-eat-today/`。

仓库里的 `.nojekyll` 会让 Pages 跳过 Jekyll 处理，按原样发布文件。

### 腾讯云 CloudBase 静态托管

同样是把仓库根目录作为站点根目录，不需要数据库、云函数或任何后端资源。

**方式一：控制台手动上传（最省事）**

进入 CloudBase 控制台 → **静态网站托管** → 上传文件，选择这几个：
`index.html`、`styles.css`、`app.js`、`data/recipes.json`、`assets/`、`.nojekyll`。

**方式二：命令行部署**

```bash
tcb login                                          # 首次需要登录
node tools/deploy-cloudbase.mjs <你的环境ID>         # 自动整理出干净目录并调用 tcb
```

`tools/deploy-cloudbase.mjs` 会把站点文件复制到 `dist/`（排除 `tools/`、`.git/`、
`answers/` 等与站点无关的内容），再执行 `tcb hosting deploy dist / -e <环境ID>`。
如果暂时不传环境 ID，它只准备 `dist/` 目录并提示后续命令。

> **状态说明**：本机已安装 CloudBase CLI 2.12.2，但**尚未登录、没有环境 ID**，
> 因此 **CloudBase 线上部署未实际执行验证**，属于「待用户真实验证」项。
> 项目侧的静态适配（零构建、纯静态资源、干净部署目录）已完成。

---

## V1 范围

已经做到：

- 打开页面自动给出 **1 道蛋白类 + 1 道蔬菜类**
- **换一组** 重新随机，保证不会和上一组完全相同，两道菜也不会是同一道
- 点卡片查看 **菜名 / 食材用量 / 做法步骤 / 小贴士 / 来源**
- 移动端优先，手机浏览器体验良好；电脑上居中显示
- 全程本地数据，不请求任何第三方接口（GitHub Pages 与 CloudBase 上运行同样如此）

**明确不做**（属于后续阶段，本轮未实现，也没有为它们提前搭架构）：

微信小程序 · 手机端增删菜谱 · 数据库 · 登录注册 · 收藏 · 历史记录 · 智能推荐 ·
食材库存 · 购物清单 · 营养分析 · AI 推荐 · 家庭成员账号 · 多用户同步 · 评论 · 社交分享

## 下一步（V2 方向）

```text
手机维护菜谱 → 收藏 → 历史菜单 → 近期不重复 → 偏好 → 微信小程序
```

后续的小程序应当**复用 `data/recipes.json` 这份数据和 `menuRole` 这套业务逻辑**，
而不是另建一套独立的菜谱系统。

菜谱数量也还有缺口（当前 370 道，目标 1000+）。补齐的前提是找到**版权明确、质量可控**的中文菜谱数据源；
在确认之前不引入无法溯源的数据。
