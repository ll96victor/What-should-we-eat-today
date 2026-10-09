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

  // —— 上游归在「素菜」，但放进"今天的素菜"会让人困惑 ——
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
// 忌口规则与荤菜白名单（源料文件，fail-closed 读取）
// ------------------------------------------------------------------
//
// 改动前请先读这四条：
//  1. 忌口规则只存在于 data/dietary-rules.json，本脚本内**不得出现任何忌口词字面量**。
//     要加/减忌口，改 JSON，不改代码（验收：grep 本文件不应命中忌口词）。
//  2. 读取一律 fail-closed：文件缺失 / JSON 坏了 / 缺键 / 核心词表为空 →
//     打印中文原因并 exit(1)。**任何情况下不得回退成「无忌口」继续构建**——
//     那会让全家忌口静默失效，且影响此后每一轮。
//  3. 匹配顺序固定为「先按字面例外等长屏蔽，再查排除词」。顺序颠倒会把
//     蚝油类约 33 道菜误杀（用户原话「蚝油可以吃一点点」）。
//  4. 内脏类只用精确多字词（猪心/鸡心/大肠/猪肚/扇贝…），不用单字（心/肠/肚/贝），
//     否则会误杀卷心菜、点心、腊肠、肠粉、贝果——这是实测踩出来的。

const RULES_FILE = path.join(PROJECT_ROOT, 'data', 'dietary-rules.json');
const WHITELIST_FILE = path.join(PROJECT_ROOT, 'data', 'meat-whitelist.json');
const BASELINE_FILE = path.join(CACHE_DIR, 'last-parsed-names.json'); // 派生缓存，不入库

/** 严格读 JSON：任何异常都 exit(1) 并给中文原因，绝不返回兜底值 */
function readJsonStrict(file, label, hint) {
  const rel = path.relative(PROJECT_ROOT, file);
  if (!fs.existsSync(file)) {
    console.error(`\n读取失败：找不到 ${rel}`);
    console.error(`  ${label} 是构建的必需输入。请从仓库恢复该文件，或找 AI 说「我把${label}删了」。`);
    console.error('  按设计，文件缺失时构建直接失败，不会当成「无忌口/无白名单」继续跑。');
    process.exit(1);
  }
  let text = fs.readFileSync(file, 'utf8');
  // BOM 容错：Windows 记事本另存可能加 BOM（这是容错，不是 fail-open）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    console.error(`\n读取失败：${rel} 不是合法 JSON。`);
    console.error('  常见原因：少了逗号 / 多了逗号 / 引号没配对 / 用了中文引号。');
    console.error(`  Node 报错位置：${e.message}`);
    if (hint) console.error(`  ${hint}`);
    process.exit(1);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.error(`\n读取失败：${rel} 的顶层必须是一个对象 {}。`);
    process.exit(1);
  }
  return obj;
}

/** 载入忌口规则；缺键 / 类型错 / 空表逐条给中文键路径后 exit(1) */
function loadDietaryRules() {
  const REL = path.relative(PROJECT_ROOT, RULES_FILE);
  const rules = readJsonStrict(RULES_FILE, '忌口规则文件', '改不好就找 AI 说「我把忌口文件改坏了」。');
  const fail = (msg) => {
    console.error(`\n忌口规则文件有问题（${REL}）：${msg}`);
    process.exit(1);
  };
  const strArray = (value, keyPath) => {
    if (!Array.isArray(value)) fail(`「${keyPath}」必须是数组 []（现在不是）。检查是否漏了引号或逗号。`);
    if (!value.length) fail(`「${keyPath}」是空的。这是核心词表，留空等于忌口失效，不允许。`);
    const bad = value.find((x) => typeof x !== 'string' || !x.trim());
    if (bad !== undefined) fail(`「${keyPath}」里有空项或非文字项：${JSON.stringify(bad)}。`);
    return value.map((x) => x.trim());
  };
  const reasonMap = (value, keyPath) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`「${keyPath}」必须是一个对象（可以为空 {}，但不能缺）。`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'string' || !v.trim()) {
        fail(`「${keyPath}.${k}」必须写成一条中文理由（字符串），不要写 true/false。理由是防止后来人「看着像 bug 就删」。`);
      }
    }
    return value;
  };

  if (rules['版本'] === undefined) fail('缺少「版本」键。');
  const categories = strArray(rules['整类排除'], '整类排除');

  if (!rules['排除食材'] || typeof rules['排除食材'] !== 'object' || Array.isArray(rules['排除食材'])) {
    fail('「排除食材」必须是一个对象，每个分组一个数组，例如 {"海鲜": ["鱼","虾"]}。');
  }
  const groups = {};
  for (const [name, list] of Object.entries(rules['排除食材'])) {
    groups[name] = strArray(list, `排除食材.${name}`);
  }
  if (!Object.keys(groups).length) fail('「排除食材」下面一个分组都没有。');
  // 必需分组：分组名是「文件结构的一部分」，不是排除词；排除词全部在 JSON 里。
  // 删掉整组会让该类忌口静默失效（例：删掉「海鲜」→ 全部海鲜菜回到池子），所以这里直接失败。
  const REQUIRED_GROUPS = ['海鲜', '内脏', '血制品', '海藻'];
  for (const name of REQUIRED_GROUPS) {
    if (!Object.prototype.hasOwnProperty.call(groups, name)) {
      fail(`「排除食材.${name}」这一组不见了（必需分组）。删掉整组会让该类忌口静默失效，所以构建直接失败。`);
    }
  }

  const exceptions = rules['字面例外'];
  if (!exceptions || typeof exceptions !== 'object' || Array.isArray(exceptions) || !Object.keys(exceptions).length) {
    fail('「字面例外」必须是至少含一条的对象，例如 {"蚝油":"用户可以吃一点点"}。');
  }
  for (const [k, v] of Object.entries(exceptions)) {
    if (typeof v !== 'string' || !v.trim()) {
      fail(`「字面例外.${k}」必须写成一条中文理由（字符串），不要写 true/false。`);
    }
  }

  const alertWords = strArray(rules['新菜告警词'], '新菜告警词');

  return {
    categories,
    groups,
    exceptions,
    forceExclude: reasonMap(rules['强制排除的菜'], '强制排除的菜'),
    forceKeep: reasonMap(rules['强制保留的菜'], '强制保留的菜'),
    alertWords,
  };
}

/** 载入荤菜白名单；缺失 / 坏 / 空 / 缺「启用」一律 exit(1) */
function loadMeatWhitelist() {
  const REL = path.relative(PROJECT_ROOT, WHITELIST_FILE);
  const data = readJsonStrict(WHITELIST_FILE, '荤菜白名单文件', '改不好就找 AI 说「我把白名单文件改坏了」。');
  const fail = (msg) => {
    console.error(`\n荤菜白名单文件有问题（${REL}）：${msg}`);
    console.error('  提示：想关闭白名单请把「启用」改成 false，不要删文件（删文件按设计会构建失败）。');
    process.exit(1);
  };
  if (data['版本'] === undefined) fail('缺少「版本」键。');
  if (data['启用'] === undefined) fail('缺少「启用」键（true=启用，false=所有非忌口荤菜都参与随机）。');
  if (typeof data['启用'] !== 'boolean') {
    fail(`「启用」必须是 true 或 false（不能带引号）。现在收到：${JSON.stringify(data['启用'])}`);
  }
  if (!Array.isArray(data['菜名'])) fail('「菜名」必须是数组 []。');
  if (!data['菜名'].length) fail('「菜名」是空的。至少放几道菜进去（下限 4 道，建议 15 道以上）。');
  const bad = data['菜名'].find((x) => typeof x !== 'string' || !x.trim());
  if (bad !== undefined) fail(`「菜名」里有空项或非文字项：${JSON.stringify(bad)}。`);
  return { 启用: data['启用'], 菜名: data['菜名'].map((x) => x.trim()) };
}

/** 把「字面例外」词按长度降序替换成等长空白（防「先短后长」漏屏蔽） */
function maskExceptions(text, exceptionKeys) {
  let out = String(text);
  for (const k of exceptionKeys) out = out.split(k).join(' '.repeat(k.length));
  return out;
}

// 命中即排除的字段 / 命中只进「存疑区」的字段。
// steps/tips 常出现「也可以加点虾皮」「参考：蒸鱼豉油」「炸糊也能炸鱼」这类**可选配料与类比**，
// 一律排除会误杀正常菜；但也不能静默放行（§6.4 教训：字面词表必然有漏网），故进人工复核清单。
const HARD_FIELDS = ['name', 'ingredients', 'description'];
const SOFT_FIELDS = ['steps', 'tips'];

function fieldText(recipe, field) {
  const v = recipe[field];
  return Array.isArray(v) ? v.join('\n') : String(v || '');
}

/**
 * 忌口过滤。优先级：强制保留 > 强制排除 > 整类排除 > 词命中。
 * 返回 { kept, excluded, suspicious }；excluded 每条含命中字段与命中词（可审计、不静默）。
 */
function applyDietaryFilter(recipes, rules) {
  const exceptionKeys = Object.keys(rules.exceptions).sort((a, b) => b.length - a.length);
  const words = [];
  for (const list of Object.values(rules.groups)) words.push(...list);
  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

  const hitsOf = (text) => {
    const masked = maskExceptions(text, exceptionKeys);
    const found = new Set();
    for (const w of words) if (masked.includes(w)) found.add(w);
    return [...found];
  };

  const kept = [];
  const excluded = [];
  const suspicious = [];

  for (const r of recipes) {
    if (has(rules.forceKeep, r.name)) { kept.push(r); continue; }
    if (has(rules.forceExclude, r.name)) {
      const also = HARD_FIELDS.flatMap((f) => hitsOf(fieldText(r, f)));
      excluded.push({
        name: r.name, menuRole: r.menuRole, layer: '强制排除',
        hits: [], alsoByWords: also.length > 0, note: rules.forceExclude[r.name],
      });
      continue;
    }
    if (rules.categories.includes(r.category)) {
      excluded.push({
        name: r.name, menuRole: r.menuRole, layer: '整类排除',
        hits: [], alsoByWords: false, note: `目录 ${r.category}`,
      });
      continue;
    }
    const hardHits = HARD_FIELDS.flatMap((f) => hitsOf(fieldText(r, f)).map((h) => `${f}:${h}`));
    if (hardHits.length) {
      excluded.push({ name: r.name, menuRole: r.menuRole, layer: '词命中', hits: hardHits, alsoByWords: false, note: '' });
      continue;
    }
    const softHits = SOFT_FIELDS.flatMap((f) => hitsOf(fieldText(r, f)).map((h) => `${f}:${h}`));
    kept.push(r);
    if (softHits.length) suspicious.push({ name: r.name, hits: softHits });
  }
  return { kept, excluded, suspicious };
}

/** 荤菜白名单收窄：只作用于 protein 池，素菜与其他 6 类不受影响 */
function applyWhitelist(recipes, whitelist) {
  if (!whitelist.启用) return { kept: recipes, dropped: [] };
  const allow = new Set(whitelist.菜名);
  const kept = [];
  const dropped = [];
  for (const r of recipes) {
    if (r.menuRole === 'protein' && !allow.has(r.name)) { dropped.push(r.name); continue; }
    kept.push(r);
  }
  return { kept, dropped };
}

/**
 * 校验集：三张表 + 白名单规模。问题**聚合后一次报完**（不要一次只报一个）；
 * 有任何 critical 即由主流程 exit(1)。返回非阻断的告警数组。
 */
function validateTables({ allRecipes, filtered, whitelist, rules }) {
  const critical = [];
  const warnings = [];

  const nameCount = new Map();
  for (const r of allRecipes) nameCount.set(r.name, (nameCount.get(r.name) || 0) + 1);

  // 1) 强制排除表：每个菜名必须恰好匹配 1 道（0=改名/写错；>1=同名重复）
  for (const name of Object.keys(rules.forceExclude)) {
    const n = nameCount.get(name) || 0;
    if (n !== 1) {
      critical.push(`「强制排除的菜.${name}」在菜谱库里匹配到 ${n} 道（必须恰好 1 道）——`
        + (n === 0 ? '菜名写错或上游改名了。' : '库里有同名菜。'));
    }
  }
  // 2) 强制保留表：必须真的在保留集里（防上游改名使保护静默失效）
  const keptNames = new Set(filtered.kept.map((r) => r.name));
  for (const name of Object.keys(rules.forceKeep)) {
    if (!keptNames.has(name)) {
      critical.push(`「强制保留的菜.${name}」不在保留集里（已被忌口排除或上游改名），这层保护已失效。`);
    }
  }

  // 3) 白名单菜名必须存在于「过滤后的 protein 池」
  const roleOf = new Map(allRecipes.map((r) => [r.name, r.menuRole]));
  const filteredProtein = new Set(filtered.kept.filter((r) => r.menuRole === 'protein').map((r) => r.name));
  const seen = new Set();
  for (const name of whitelist.菜名) {
    if (seen.has(name)) critical.push(`白名单里「${name}」重复出现，请去重。`);
    seen.add(name);
    if (filteredProtein.has(name)) continue;
    if (!roleOf.has(name)) {
      critical.push(`白名单里的「${name}」在菜谱库里找不到。两种可能：菜名写错字了，或上游改名了。`);
    } else if (roleOf.get(name) !== 'protein') {
      critical.push(`白名单里的「${name}」不是荤菜（menuRole=${roleOf.get(name)}），不能放进荤菜白名单。`);
    } else {
      critical.push(`白名单里的「${name}」已被忌口规则排除，不能进白名单（很可能是食材表干净、描述里藏着海鲜的菜）。`);
    }
  }

  // 4) 白名单规模：<4 无法出餐（硬失败）；4-14 组合数偏少（大声告警）
  //    下限 4 的由来：mealSize 最大 8，一桌需 4 道荤菜（specs §3.1 荤素 1:1）。
  if (whitelist.启用) {
    const n = seen.size;
    if (n < 4) {
      critical.push(`荤菜白名单只有 ${n} 道，低于 4 道：一桌最多 8 道菜需要 4 道荤菜，会直接出不了菜单。`);
    } else if (n < 15) {
      warnings.push(`荤菜白名单只有 ${n} 道（建议 15 道以上）：能组合出的菜单数偏少，容易连着吃到重复的菜。`);
    }
  }
  return { critical, warnings };
}

/**
 * 新菜告警（轻量，不阻断）。基线 = 上次成功构建的全量解析菜名，存 tools/.cache/（派生缓存，不入库）。
 * 基线丢失只退化为「本次不告警 + 显式提示」，不会静默。
 */
function detectNewDishes(recipes, whitelist, rules) {
  let baseline = null;
  if (fs.existsSync(BASELINE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
      if (Array.isArray(parsed)) baseline = parsed;
    } catch { baseline = null; }
  }
  if (!baseline) return { firstRun: true, fresh: [], watch: [], proteinOutside: [] };

  const baseSet = new Set(baseline);
  const fresh = recipes.filter((r) => !baseSet.has(r.name));
  const watch = fresh.filter((r) => rules.alertWords.some((w) => r.name.includes(w)));
  const allow = new Set(whitelist.菜名);
  const proteinOutside = fresh.filter((r) => r.menuRole === 'protein' && !allow.has(r.name));
  return { firstRun: false, fresh, watch, proteinOutside };
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------

const refresh = process.argv.includes('--refresh');

// 规则与白名单最先载入：坏输入 fail fast，不必先跑解析/联网
const rules = loadDietaryRules();
const whitelist = loadMeatWhitelist();
console.log(`· 忌口规则：词条 ${Object.values(rules.groups).reduce((a, b) => a + b.length, 0)} 个 / `
  + `字面例外 ${Object.keys(rules.exceptions).length} 个 / 整类排除 ${rules.categories.join('、')}`);
console.log(`· 荤菜白名单：${whitelist.启用 ? `启用，${whitelist.菜名.length} 道` : '未启用（所有非忌口荤菜都参与随机）'}`);

console.log('菜谱数据构建开始');
const sources = await loadSources(refresh);

let recipes = sources.map(parseRecipe).filter(Boolean);
console.log(`· 解析成功 ${recipes.length} 道`);

// 同名去重：保留食材+步骤信息更全的一份
// （保持在过滤之前：去重后菜名唯一，「强制排除表恰好匹配 1 道」这类校验才有确定含义。
//   实测库里有 1 组同名：陈皮排骨汤）
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
const parsedAll = recipes; // 过滤前的全量（供校验集与「新菜告警」基线对比）

// —— 忌口过滤（只读规则文件；本脚本内无任何忌口词字面量）——
const filtered = applyDietaryFilter(recipes, rules);
console.log(`· 忌口过滤：保留 ${filtered.kept.length} 道，排除 ${filtered.excluded.length} 道`);

// —— 校验集：三张表 + 白名单规模（问题聚合后一次报完）——
const { critical, warnings: tableWarnings } = validateTables({ allRecipes: parsedAll, filtered, whitelist, rules });
if (critical.length) {
  console.error('\n构建失败：忌口规则/白名单校验未通过');
  for (const c of critical) console.error(`  FAIL ${c}`);
  console.error('\n提示：这些校验是为了防止「忌口静默失效」或「白名单选了不存在的菜」。');
  console.error('      请按上面每条的中文提示修改 data/dietary-rules.json 或 data/meat-whitelist.json。');
  process.exit(1);
}

// —— 荤菜白名单收窄（只作用于 protein 池）——
const narrowed = applyWhitelist(filtered.kept, whitelist);

// —— 新菜告警（基线对比，不阻断）——
const newDish = detectNewDishes(parsedAll, whitelist, rules);

recipes = narrowed.kept;

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
// 蛋白池阈值随白名单模式切换：白名单启用时用 15（白名单设计下限，出处：规划 §5.4 /
// 需求梳理 §4.1 组合数表——低于 15 道会明显吃重复）；<4 已在校验集硬失败。
// 未启用白名单时维持 20 的原语义。这不是「当前数量」断言，是「够不够出餐 + 会不会吃重复」的功能性阈值。
const proteinWarnThreshold = whitelist.启用 ? 15 : 20;
if (protein.length < proteinWarnThreshold) {
  problems.push(`蛋白池过小：${protein.length}（阈值 ${proteinWarnThreshold}）`);
}
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

// —— 忌口与白名单统计（「有没有东西没被处理」必须直接可见，不静默）——
const exByLayer = {};
for (const e of filtered.excluded) exByLayer[e.layer] = (exByLayer[e.layer] || 0) + 1;
const doubleGuarded = filtered.excluded.filter((e) => e.layer === '强制排除' && e.alsoByWords).length;
const proteinBefore = filtered.kept.filter((r) => r.menuRole === 'protein').length;

console.log('\n—— 忌口与白名单 ——');
console.log(`忌口排除：${filtered.excluded.length} 道`
  + `（整类 ${exByLayer['整类排除'] || 0} / 词命中 ${exByLayer['词命中'] || 0} / 强制排除 ${exByLayer['强制排除'] || 0}`
  + `；其中强制排除表同时被词表命中的双保险 ${doubleGuarded} 道）`);
if (filtered.suspicious.length) {
  console.log(`存疑保留（steps/tips 含忌口词，需人工复核）：${filtered.suspicious.length} 道 → 清单如下`);
  for (const s of filtered.suspicious) console.log(`  ? ${s.name}  ← ${s.hits.join(' ')}`);
} else {
  console.log('存疑保留（steps/tips 含忌口词，需人工复核）：0 道');
}
console.log(`荤菜白名单：${whitelist.启用 ? `启用，荤菜池 ${proteinBefore} → ${protein.length} 道（收窄 ${narrowed.dropped.length}）` : '未启用（荤菜池保持全部非忌口荤菜）'}`);
if (!whitelist.启用) console.log('  ⚠️ 白名单未启用：所有非忌口荤菜都会进入随机池。');

// —— 新菜告警（基线对比；首次运行显式提示，不静默）——
if (newDish.firstRun) {
  console.log(`新菜告警：首次运行，本次建立基线（${parsedAll.length} 道菜名），新菜告警自下次构建起生效。`);
} else {
  console.log(`新菜告警：${newDish.fresh.length} 道新增菜${newDish.watch.length ? `，其中 ${newDish.watch.length} 道命中告警词，请人工复核` : ''}`);
  for (const r of newDish.watch) console.log(`  ! 新增且命中告警词：${r.name}（${r.menuRole}）`);
  if (newDish.proteinOutside.length) {
    console.log(`  上游新增荤菜 ${newDish.proteinOutside.length} 道，均不在白名单，未进随机池：`
      + newDish.proteinOutside.map((r) => r.name).join('、'));
  }
}

console.log('');
if (problems.length || tableWarnings.length) {
  const all = [...problems, ...tableWarnings];
  console.log(`告警 ${all.length} 条：`);
  all.slice(0, 20).forEach((p) => console.log('  - ' + p));
} else {
  console.log('数据校验：通过');
}

// —— 基线最后写：失败的构建不污染「新菜告警」基线（继承「把可能失败的外部调用放在写运行态数据之前」）——
fs.writeFileSync(BASELINE_FILE, JSON.stringify(parsedAll.map((r) => r.name)), 'utf8');
