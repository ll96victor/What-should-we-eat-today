/**
 * 菜谱数据构建脚本
 * ------------------------------------------------------------------
 * 数据来源：Anduin2017/HowToCook（Unlicense，中文家常菜谱）
 *   https://github.com/Anduin2017/HowToCook
 *
 * 作用：把上游仓库的 markdown 菜谱解析成项目唯一的菜谱数据文件
 *       data/recipes.json，供纯前端直接读取。
 *
 * 用法：
 *   node tools/build-recipes.mjs              # 有缓存则用缓存，否则联网拉取
 *   node tools/build-recipes.mjs --refresh    # 强制重新联网拉取
 *
 * 说明：上游 md 原文缓存在 tools/.cache/（不入库，见 .gitignore）。
 *       本项目只提取文字（菜名/食材/步骤/小贴士），不下载上游图片。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const CACHE_DIR = path.join(HERE, '.cache');
const OUT_FILE = path.join(PROJECT_ROOT, 'data', 'recipes.json');

const UPSTREAM = 'Anduin2017/HowToCook';
const BRANCH = 'master';
const API_TREE = `https://api.github.com/repos/${UPSTREAM}/git/trees/${BRANCH}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${UPSTREAM}/${BRANCH}/`;
const BLOB_BASE = `https://github.com/${UPSTREAM}/blob/${BRANCH}/`;

/** 上游分类目录 -> 默认 menuRole（随机菜单归属） */
const CATEGORY_ROLE = {
  meat_dish: 'protein',
  aquatic: 'protein',
  vegetable_dish: 'vegetable',
  soup: 'soup',
  breakfast: 'breakfast',
  staple: 'staple',
  dessert: 'dessert',
  drink: 'drink',
  condiment: 'condiment',
  'semi-finished': 'other',
};

/** 分类中文名（UI 展示用） */
const CATEGORY_LABEL = {
  meat_dish: '荤菜',
  aquatic: '水产',
  vegetable_dish: '素菜',
  soup: '汤羹',
  breakfast: '早餐',
  staple: '主食',
  dessert: '甜品',
  drink: '饮品',
  condiment: '调料',
  'semi-finished': '半成品',
};

/**
 * menuRole 人工复核修正表。
 * 上游按"荤菜/素菜"分目录，但家常菜里鸡蛋、豆腐、豆类同属蛋白质来源，
 * 部分汤和早餐也实际是正经菜，这里逐条纠正，保证随机池语义正确。
 *
 * ⚠️ 同一个菜名只能出现一次。JS 对象字面量里重复的 key 会被后者静默覆盖，
 *    改这张表时请改原地，不要在别处再补一条同名项（构建末尾有回归断言兜底）。
 */
const ROLE_OVERRIDE = {
  // —— 上游归在「素菜」，但主料是蛋白质 ——
  凉拌豆腐: 'protein', 家常日本豆腐: 'protein', 油醋爆蛋: 'protein',
  洋葱炒鸡蛋: 'protein', 炒滑蛋: 'protein', 皮蛋豆腐: 'protein',
  脆皮豆腐: 'protein', 莴笋叶煎饼: 'protein', 葱煎豆腐: 'protein',
  鸡蛋火腿炒黄瓜: 'protein', 西红柿炒鸡蛋: 'protein', 西红柿豆腐汤羹: 'protein',
  话梅煮毛豆: 'protein', 金针菇日本豆腐煲: 'protein', 金钱蛋: 'protein',
  雷椒皮蛋: 'protein', 韭菜炒蛋: 'protein', 微波炉鸡蛋羹: 'protein',
  蒸箱鸡蛋羹: 'protein', 鸡蛋羹: 'protein',
  菠菜炒鸡蛋: 'protein', 西葫芦炒鸡蛋: 'protein', 包菜炒鸡蛋粉丝: 'protein',
  // 注：上汤娃娃菜/干锅花菜/手撕包菜/榄菜肉末四季豆/炒茄子/茄子炖土豆
  //     以蔬菜为主料，肉类仅提味，保持 vegetable，不进蛋白池。

  // —— 以下蛋类/糖水属于"佐餐小食"，不是一道能上桌的主菜，不进随机池 ——
  //     否则「一荤一素」会抽出「溏心蛋 + 蒜蓉西兰花」这种看着像 bug 的组合。
  完美水煮蛋: 'breakfast', 温泉蛋: 'breakfast', 溏心蛋: 'breakfast',
  微波炉荷包蛋: 'breakfast', 太阳蛋: 'breakfast', 茶叶蛋: 'breakfast',
  鸡蛋花: 'breakfast', 朱雀汤: 'dessert',

  // —— 上游归在「素菜」，但放进"今晚的素菜"会让人困惑 ——
  拔丝土豆: 'dessert',     // 主料是 120g 白砂糖裹土豆，本质是甜品
  水油焖蔬菜: 'other',      // 食材只写「叶菜类蔬菜」，是一套烹调技法而非一道具体的菜

  // —— 汤：按主料判定，肉汤进蛋白池，素汤进蔬菜池，粥类不进池 ——
  勾芡香菇汤: 'vegetable', 奶油蘑菇汤: 'vegetable', 金针菇汤: 'vegetable',
  山药南瓜炖鸡汤: 'protein', 排骨山药玉米汤: 'protein', 排骨苦瓜汤: 'protein',
  昂刺鱼豆腐汤: 'protein', 玉米排骨汤: 'protein',
  生汆丸子汤: 'protein', 番茄牛肉蛋花汤: 'protein', 紫菜蛋花汤: 'protein',
  罗宋汤: 'protein', 羊肉汤: 'protein', 菌菇炖乳鸽: 'protein',
  西红柿鸡蛋汤: 'protein', 黄瓜皮蛋汤: 'protein', 陈皮排骨汤: 'protein',
  小米粥: 'staple', 米粥: 'staple', 皮蛋瘦肉粥: 'staple', 腊八粥: 'staple',
  银耳莲子粥: 'dessert',

  // —— 早餐：蛋类/三明治是正经蛋白来源，主食甜点不进随机池 ——
  微波炉蒸蛋: 'protein', 意式香肠北非蛋: 'protein',
  燕麦鸡蛋饼: 'protein', 美式炒蛋: 'protein', 苏格兰蛋: 'protein',
  蒸水蛋: 'protein', 蛋煎糍粑: 'protein', 金枪鱼酱三明治: 'protein',
  韩国麻药鸡蛋: 'protein', 鸡蛋三明治: 'protein',
  水煮玉米: 'staple',
  吐司果酱: 'staple', 手抓饼: 'staple', 煎饺: 'staple', 牛奶燕麦: 'staple',
  空气炸锅面包片: 'staple', 蒸花卷: 'staple',
  微波炉蛋糕: 'dessert', 桂圆红枣粥: 'dessert',

  // —— 半成品 ——
  空气炸锅鸡翅中: 'protein', 空气炸锅羊排: 'protein',
  凉皮: 'staple', 半成品意面: 'staple', 炸薯条: 'staple',
  速冻水饺: 'staple', 速冻馄饨: 'staple',
  懒人蛋挞: 'dessert', 速冻汤圆: 'dessert',
  牛油火锅底料: 'condiment',
};

/** 需要合并的重复菜（上游同名两份，保留内容较长的一份） */
const DEDUPE_BY_NAME = true;

// ------------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------------

const NOISE_RE = /^(如果您遵循本指南|请提出\s*Issue|请提出\s*Pull|---+$)/;
const LIST_RE = /^(?:[-*+]|\d+\.)\s+(.*)$/;
const LINK_LINE_RE = /^\[[^\]]*\]\(https?:\/\/[^)]+\)\s*$/;

/** 去掉 markdown 行内标记，压缩空白 */
function cleanText(s) {
  return String(s)
    .replace(/`{1,3}/g, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*>\s?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按 ## 二级标题切分；### 三级标题保留在所属二级节内 */
function splitSections(md) {
  const secs = {};
  let title = '__intro__';
  const buf = [];
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      secs[title] = buf.join('\n');
      title = line.slice(3).trim();
      buf.length = 0;
    } else {
      buf.push(line);
    }
  }
  secs[title] = buf.join('\n');
  return secs;
}

/** 提取列表项（含 ### 分组标题下的项），自动跳过噪音行 */
function listItems(block) {
  const out = [];
  for (const raw of (block || '').split('\n')) {
    const line = raw.trim();
    if (!line || NOISE_RE.test(line)) continue;
    const m = line.match(LIST_RE);
    if (!m) continue;
    const item = cleanText(m[1]);
    if (item) out.push(item);
  }
  return out;
}

/** 解析「操作」节：分组标题并入该组第一条步骤，其余按顺序平铺 */
function parseSteps(block) {
  const steps = [];
  let group = '';
  for (const raw of (block || '').split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || NOISE_RE.test(trimmed)) continue;

    const h3 = trimmed.match(/^###\s+(.+)$/);
    if (h3) {
      group = cleanText(h3[1]);
      continue;
    }
    const m = trimmed.match(LIST_RE);
    if (!m) continue;

    let text = cleanText(m[1]);
    if (!text) continue;
    // 顶级列表项才开启新步骤；缩进的子项并入上一条
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      if (group) {
        text = `${group}：${text}`;
        group = '';
      }
      steps.push(text);
    } else if (steps.length) {
      steps[steps.length - 1] += `；${text}`;
    }
  }
  return steps;
}

const TOOL_WORDS = ['锅', '铲', '刀', '勺', '碗', '盘', '盆', '筷', '烤箱', '微波炉',
  '电饭煲', '蒸锅', '高压锅', '保鲜膜', '锡纸', '烤盘', '案板', '砧板', '擀面杖',
  '模具', '打蛋器', '温度计', '厨房秤', '手套', '牙签', '灶', '洗碗机'];

/** 食材优先取「计算」（带用量），缺省退回「必备原料和工具」并剔除厨具 */
function pickIngredients(secs) {
  const calc = listItems(secs['计算']);
  if (calc.length) return calc;
  return listItems(secs['必备原料和工具'])
    .filter((x) => !TOOL_WORDS.some((w) => x.includes(w)));
}

function firstLink(block) {
  const m = (block || '').match(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/);
  return m ? { name: cleanText(m[1]), url: m[2] } : null;
}

function makeId(relPath) {
  return 'htc-' + crypto.createHash('md5').update(relPath).digest('hex').slice(0, 10);
}

// ------------------------------------------------------------------
// 抓取
// ------------------------------------------------------------------

async function fetchText(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'tonight-eat-build' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw new Error(`抓取失败 ${url}: ${lastErr?.message}`);
}

/** 并发跑任务，限制并发数 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadSources(refresh) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const indexFile = path.join(CACHE_DIR, 'index.json');

  let paths;
  if (!refresh && fs.existsSync(indexFile)) {
    paths = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    console.log(`· 使用缓存索引：${paths.length} 个菜谱文件`);
  } else {
    console.log('· 联网读取上游仓库文件树…');
    const tree = JSON.parse(await fetchText(API_TREE));
    paths = tree.tree
      .filter((t) => t.type === 'blob' && t.path.startsWith('dishes/')
        && t.path.endsWith('.md') && !t.path.includes('/template'))
      .map((t) => t.path);
    fs.writeFileSync(indexFile, JSON.stringify(paths, null, 1));
    console.log(`· 上游共有 ${paths.length} 个菜谱文件`);
  }

  const missing = paths.filter((p) => !fs.existsSync(cachePath(p)));
  if (missing.length) {
    console.log(`· 下载 ${missing.length} 个菜谱原文（并发 10）…`);
    let done = 0;
    await pool(missing, 10, async (p) => {
      const text = await fetchText(RAW_BASE + encodeURI(p));
      fs.mkdirSync(path.dirname(cachePath(p)), { recursive: true });
      fs.writeFileSync(cachePath(p), text, 'utf8');
      if (++done % 50 === 0) console.log(`    ${done}/${missing.length}`);
    });
  }

  return paths.map((p) => ({ path: p, text: fs.readFileSync(cachePath(p), 'utf8') }));
}

function cachePath(relPath) {
  return path.join(CACHE_DIR, relPath.replace(/^dishes\//, '').replace(/\//g, '__'));
}

// ------------------------------------------------------------------
// 解析
// ------------------------------------------------------------------

function parseRecipe({ path: relPath, text }) {
  const md = text.replace(/\r\n/g, '\n');
  const titleMatch = md.match(/^#\s+(.+)$/m);
  if (!titleMatch) return null;

  const name = cleanText(titleMatch[1]).replace(/的做法\s*$/, '').trim();
  const category = relPath.split('/')[1] || 'other';
  const secs = splitSections(md);

  const intro = (secs.__intro__ || '')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && !l.startsWith('预估'))
    .join(' ');
  const description = cleanText(intro);

  const rawSteps = parseSteps(secs['操作']);
  if (!name || rawSteps.length === 0) return null;

  const extra = secs['附加内容'] || '';
  const tips = listItems(extra).filter((t) => !LINK_LINE_RE.test(t));
  const ref = firstLink(extra);

  const difficulty = (md.match(/预估烹饪难度：\s*(★+)/) || [, ''])[1].length || null;
  const calories = Number((md.match(/预估卡路里：\s*(\d+)/) || [])[1]) || null;

  const menuRole = ROLE_OVERRIDE[name] || CATEGORY_ROLE[category] || 'other';
  const label = CATEGORY_LABEL[category] || '其他';

  const tags = [label];
  if (difficulty && difficulty <= 2) tags.push('新手友好');
  if (difficulty && difficulty >= 4) tags.push('有点挑战');
  if (menuRole === 'protein' && category === 'vegetable_dish') tags.push('含蛋白质');
  if (menuRole === 'vegetable' && category === 'soup') tags.push('汤');

  return {
    id: makeId(relPath),
    name,
    menuRole,
    category,
    categoryName: label,
    description,
    ingredients: pickIngredients(secs),
    steps: rawSteps,
    tips,
    difficulty,
    calories,
    imageUrl: null,
    sourceName: 'HowToCook 程序员做饭指南',
    sourceUrl: BLOB_BASE + encodeURI(relPath),
    referenceName: ref ? ref.name : null,
    referenceUrl: ref ? ref.url : null,
    tags,
    _srcPath: relPath,
  };
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------

const refresh = process.argv.includes('--refresh');
console.log('菜谱数据构建开始');
const sources = await loadSources(refresh);

let recipes = sources.map(parseRecipe).filter(Boolean);
console.log(`· 解析成功 ${recipes.length} 道`);

// 同名去重：保留食材+步骤信息更全的一份
const byName = new Map();
for (const r of recipes) {
  const prev = byName.get(r.name);
  if (!prev) {
    byName.set(r.name, r);
    continue;
  }
  const score = (x) => x.ingredients.length + x.steps.length;
  const keep = score(r) > score(prev) ? r : prev;
  const drop = keep === r ? prev : r;
  console.log(`  ! 重名「${r.name}」：保留 ${keep._srcPath}，丢弃 ${drop._srcPath}`);
  byName.set(r.name, keep);
}
recipes = [...byName.values()];

recipes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
for (const r of recipes) delete r._srcPath;

// —— 质量校验 ——
const problems = [];
const roleCount = {};
for (const r of recipes) {
  roleCount[r.menuRole] = (roleCount[r.menuRole] || 0) + 1;
  if (!r.ingredients.length) problems.push(`无食材：${r.name}`);
  if (r.steps.length < 2) problems.push(`步骤过少：${r.name}(${r.steps.length})`);
  if (!r.menuRole) problems.push(`无 menuRole：${r.name}`);
}

const protein = recipes.filter((r) => r.menuRole === 'protein');
const vegetable = recipes.filter((r) => r.menuRole === 'vegetable');
if (protein.length < 20) problems.push(`蛋白池过小：${protein.length}`);
if (vegetable.length < 20) problems.push(`蔬菜池过小：${vegetable.length}`);

// 回归保护：这些佐餐小食/主食不应出现在「一荤一素」的随机池里。
// 曾经因为 ROLE_OVERRIDE 里同名 key 重复定义，它们的 breakfast 归类被静默覆盖回 protein。
const SHOULD_NOT_POOL = ['完美水煮蛋', '温泉蛋', '溏心蛋', '微波炉荷包蛋', '太阳蛋',
  '茶叶蛋', '鸡蛋花', '朱雀汤', '水煮玉米'];
const leaked = SHOULD_NOT_POOL.filter((n) => {
  const r = recipes.find((x) => x.name === n);
  return r && (r.menuRole === 'protein' || r.menuRole === 'vegetable');
});
if (leaked.length) problems.push(`不应进随机池但仍在池内：${leaked.join('、')}`);

const payload = {
  version: 1,
  generatedFrom: `https://github.com/${UPSTREAM}`,
  license: 'Unlicense (上游 HowToCook 项目授权)',
  updatedAt: new Date().toISOString().slice(0, 10),
  stats: {
    total: recipes.length,
    protein: protein.length,
    vegetable: vegetable.length,
    byRole: roleCount,
  },
  recipes,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');

const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
console.log('\n—— 构建结果 ——');
console.log(`总菜谱：${recipes.length}`);
console.log(`随机池：蛋白类 ${protein.length} 道 / 蔬菜类 ${vegetable.length} 道`);
console.log('各 menuRole：', JSON.stringify(roleCount, null, 0));
console.log(`输出：${path.relative(PROJECT_ROOT, OUT_FILE)}  (${sizeKb} KB)`);
if (problems.length) {
  console.log(`\n告警 ${problems.length} 条：`);
  problems.slice(0, 20).forEach((p) => console.log('  - ' + p));
} else {
  console.log('数据校验：通过');
}
