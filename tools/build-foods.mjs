/**
 * 食物营养数据构建脚本
 * ------------------------------------------------------------------
 * 数据来源：USDA FoodData Central
 *   https://fdc.nal.usda.gov/
 *   授权：CC0 1.0 Universal（公有领域贡献，可自由再分发）
 *   数据集：SR Legacy（2018-04）+ Foundation Foods（2026-04-30）
 *
 * 运行方式：
 *   node tools/build-foods.mjs             # 有缓存则用缓存
 *   node tools/build-foods.mjs --refresh   # 强制重新下载
 *
 * ★ 设计原则（重要）★
 *   营养数值**不是手抄的**。本文件只维护「中文食材名 → USDA fdcId」的对照关系，
 *   每个数值都由脚本从 USDA 原始数据中按键取出，因此不会出现录入笔误，
 *   也保证每个数字都能回溯到具体那条 USDA 记录。
 *
 *   输出 data/foods.json，只包含本项目用到的食物（约 200 条），
 *   而不是把 USDA 的 7888 条全量打包——运行时读的是这份精简文件。
 *
 * 为什么不使用中国食物成分表：
 *   《中国食物成分表标准版》为正式出版物，存在版权限制；
 *   网络上流传的衍生数据集（如 GitHub 上的 OCR 版本）经核查无 LICENSE 声明，
 *   不可重新分发。因此营养数值一律采用版权明确为公有领域的 USDA FDC。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const CACHE_DIR = path.join(HERE, '.cache', 'usda');
const OUT_FILE = path.join(PROJECT_ROOT, 'data', 'foods.json');

const FDC_BASE = 'https://fdc.nal.usda.gov/fdc-datasets/';
const DATASETS = [
  { file: 'FoodData_Central_sr_legacy_food_json_2018-04.zip', key: 'SRLegacyFoods', label: 'SR Legacy (2018-04-30)' },
  { file: 'FoodData_Central_foundation_food_json_2026-04-30.zip', key: 'FoundationFoods', label: 'Foundation Foods (2026-04-30)' },
];

/** USDA 营养素编号 -> 我们的字段名（数值均为每 100 g） */
const NUTRIENT_IDS = { 1008: 'kcal', 1003: 'protein', 1004: 'fat', 1005: 'carbs' };

// ==================================================================
// 中文食材名 -> USDA fdcId 对照表
// ------------------------------------------------------------------
// staple: true 表示可以作为「主食」在界面上直接选
// alias:  同名不同写法都列进来，匹配时按最长优先
// ==================================================================
const FOODS = [
  // ---------- 主食 ----------
  { key: 'rice-cooked', staple: true, alias: ['米饭', '白米饭', '大米饭', '熟米饭', '蒸米饭', '冷饭', '剩饭'], fdcId: 168880 },
  { key: 'rice-raw', staple: true, alias: ['大米', '稻米', '白米'], fdcId: 168879 },
  { key: 'brown-rice-cooked', staple: true, alias: ['糙米饭', '杂粮饭', '粗粮饭'], fdcId: 169704 },
  { key: 'noodles-cooked', staple: true, alias: ['面条', '挂面', '面', '面条（煮熟）'], fdcId: 169732 },
  { key: 'noodles-dry', alias: ['干面条', '生的面条'], fdcId: 169731 },
  { key: 'bread', staple: true, alias: ['面包', '吐司', '吐司片', '切片面包'], fdcId: 174924 },
  { key: 'mantou', staple: true, alias: ['馒头', '花卷'], fdcId: 167532, note: '馒头无独立 USDA 条目，采用白小麦面包作为近似' },
  { key: 'corn-cooked', staple: true, alias: ['玉米', '甜玉米', '水煮玉米', '玉米棒'], fdcId: 168540 },
  { key: 'corn-raw', alias: ['玉米粒', '生玉米'], fdcId: 169998 },
  { key: 'sweet-potato-cooked', staple: true, alias: ['红薯', '地瓜', '番薯', '烤红薯', '蒸红薯'], fdcId: 168483 },
  { key: 'sweet-potato-raw', alias: ['生红薯'], fdcId: 168482 },
  { key: 'oats', staple: true, alias: ['燕麦', '燕麦片', '纯燕麦片'], fdcId: 169705, note: '为干燕麦数值，若计量的是煮好的燕麦粥需自行折算' },
  { key: 'millet-raw', staple: true, alias: ['小米', '小米粥', '小米饭'], fdcId: 169702, note: '为干小米数值；小米粥含水量高，实际热量远低于此' },
  { key: 'flour', alias: ['面粉', '中筋面粉', '高筋面粉', '低筋面粉', '小麦粉', '白面'], fdcId: 168894 },
  { key: 'glutinous-rice', alias: ['糯米', '江米', '圆糯米'], fdcId: 168883 },
  { key: 'cornstarch', alias: ['淀粉', '生粉', '玉米淀粉', '土豆淀粉', '红薯淀粉', '糯米粉'], fdcId: 169698, note: '糯米粉按玉米淀粉近似（同为高淀粉粉料）' },
  { key: 'rice-noodle', alias: ['米粉', '米线', '河粉', '蕨根粉'], fdcId: 169732, note: 'USDA 无米制品条目，采用面条作为近似' },
  { key: 'yam', alias: ['山药', '淮山'], fdcId: 170071 },
  { key: 'taro', alias: ['芋头', '香芋'], fdcId: 169308 },
  { key: 'potato', alias: ['土豆', '马铃薯', '洋芋'], fdcId: 170026 },

  // ---------- 肉类 ----------
  { key: 'pork-lean', alias: ['猪里脊', '猪瘦肉', '瘦猪肉', '里脊肉', '瘦肉', '猪肉丝', '猪肉片'], fdcId: 168249 },
  { key: 'pork-belly', alias: ['五花肉', '猪五花', '带皮五花肉'], fdcId: 167812 },
  { key: 'pork-loin', alias: ['猪肉', '猪', '猪腿肉', '前腿肉', '后腿肉'], fdcId: 167818 },
  { key: 'pork-ground', alias: ['猪肉末', '肉末', '猪肉馅'], fdcId: 167902 },
  { key: 'pork-ribs', alias: ['排骨', '猪排骨', '肋排', '小排', '子排'], fdcId: 167895 },
  { key: 'ham', alias: ['火腿', '火腿片', '方腿'], fdcId: 173864 },
  { key: 'beef', alias: ['牛肉', '牛腩', '牛腱', '牛里脊', '肥牛', '牛肋条'], fdcId: 168694 },
  { key: 'beef-ground', alias: ['牛肉末', '牛肉馅'], fdcId: 174030 },
  { key: 'chicken', alias: ['鸡肉', '鸡胸肉', '鸡腿肉', '鸡', '整鸡'], fdcId: 171052 },
  { key: 'chicken-leg', alias: ['鸡腿', '手枪腿'], fdcId: 173619 },
  { key: 'chicken-wing', alias: ['鸡翅', '鸡翅中', '鸡翅根'], fdcId: 173632 },
  { key: 'duck', alias: ['鸭肉', '鸭', '鸭腿'], fdcId: 171052, note: 'USDA 无独立鸭肉条目，采用鸡肉作为近似' },
  { key: 'lamb', alias: ['羊肉', '羊排', '羊腿'], fdcId: 168694, note: 'USDA 无独立羊肉条目，采用牛肉作为近似' },
  { key: 'bacon', alias: ['培根', '腊肉', '咸肉'], fdcId: 168277 },
  { key: 'sausage', alias: ['香肠', '腊肠', '火腿肠', '午餐肉'], fdcId: 172936 },

  // ---------- 水产 ----------
  { key: 'fish-white', alias: ['鱼肉', '鱼', '鲈鱼', '鳕鱼', '草鱼', '鲤鱼', '鲫鱼', '鲅鱼'], fdcId: 171955 },
  { key: 'salmon', alias: ['三文鱼', '鲑鱼'], fdcId: 175138 },
  { key: 'shrimp', alias: ['虾', '大虾', '基围虾', '对虾', '虾仁', '小龙虾'], fdcId: 175179 },
  { key: 'squid', alias: ['鱿鱼', '墨鱼'], fdcId: 174223 },
  { key: 'octopus', alias: ['章鱼', '八爪鱼'], fdcId: 174218 },
  { key: 'tuna-canned', alias: ['金枪鱼', '吞拿鱼'], fdcId: 173709 },
  { key: 'seaweed', alias: ['海带', '紫菜', '裙带菜'], fdcId: 168457 },

  // ---------- 蛋 / 奶 / 豆 ----------
  { key: 'egg', alias: ['鸡蛋', '蛋', '土鸡蛋', '蛋液'], fdcId: 171287 },
  { key: 'egg-white', alias: ['蛋清', '鸡蛋清', '蛋白'], fdcId: 172183 },
  { key: 'tofu', alias: ['豆腐', '嫩豆腐', '老豆腐', '北豆腐', '南豆腐', '内酯豆腐'], fdcId: 172476 },
  { key: 'tofu-firm', alias: ['老豆腐（硬）', '豆干', '香干', '干豆腐', '豆腐干'], fdcId: 172475 },
  { key: 'soy-milk', alias: ['豆浆', '豆奶'], fdcId: 174271 },
  { key: 'strawberry', alias: ['草莓'], fdcId: 167762 },
  { key: 'cola', alias: ['可乐', '雪碧', '汽水'], fdcId: 174852 },
  { key: 'spirits', alias: ['金酒', '朗姆酒', '伏特加', '威士忌', '白酒', '白朗姆酒'], fdcId: 174817 },
  { key: 'soybean', alias: ['黄豆', '大豆', '毛豆', '青豆'], fdcId: 169282 },
  { key: 'milk', alias: ['牛奶', '纯牛奶', '全脂牛奶'], fdcId: 171265 },
  { key: 'cream', alias: ['淡奶油', '奶油', '稀奶油'], fdcId: 170859 },
  { key: 'butter', alias: ['黄油', '牛油'], fdcId: 173410 },
  { key: 'cheese', alias: ['芝士', '奶酪', '起司', '芝士片'], fdcId: 170899 },
  { key: 'yogurt', alias: ['酸奶', '优格'], fdcId: 171284 },

  // ---------- 蔬菜 ----------
  { key: 'tomato', alias: ['西红柿', '番茄', '圣女果', '小番茄'], fdcId: 170457 },
  { key: 'cucumber', alias: ['黄瓜', '青瓜'], fdcId: 168409 },
  { key: 'eggplant', alias: ['茄子', '青茄子', '长茄子', '圆茄子'], fdcId: 169228 },
  { key: 'cabbage-napa', alias: ['大白菜', '白菜', '娃娃菜', '黄芽白'], fdcId: 169979 },
  { key: 'cabbage', alias: ['包菜', '卷心菜', '圆白菜', '甘蓝', '手撕包菜'], fdcId: 169975 },
  { key: 'bokchoy', alias: ['青菜', '小白菜', '油菜', '上海青', '鸡毛菜'], fdcId: 170390 },
  { key: 'spinach', alias: ['菠菜'], fdcId: 168462 },
  { key: 'celery', alias: ['芹菜', '香芹', '西芹', '芹菜苗'], fdcId: 169988 },
  { key: 'broccoli', alias: ['西兰花', '绿花菜'], fdcId: 170379 },
  { key: 'cauliflower', alias: ['花菜', '菜花', '白花菜', '有机花菜'], fdcId: 169986 },
  { key: 'onion', alias: ['洋葱', '圆葱'], fdcId: 170000 },
  { key: 'carrot', alias: ['胡萝卜', '红萝卜'], fdcId: 170393 },
  { key: 'pumpkin', alias: ['南瓜'], fdcId: 168448 },
  { key: 'radish', alias: ['白萝卜', '萝卜', '青萝卜', '水萝卜'], fdcId: 169276 },
  { key: 'lotus-root', alias: ['莲藕', '藕', '藕丁'], fdcId: 169250 },
  { key: 'green-beans', alias: ['豆角', '四季豆', '刀豆', '扁豆', '豇豆'], fdcId: 169961 },
  { key: 'green-pepper', alias: ['青椒', '尖椒', '柿子椒', '菜椒', '彩椒'], fdcId: 170427 },
  { key: 'red-pepper', alias: ['红椒', '红菜椒', '红甜椒'], fdcId: 170108 },
  { key: 'bean-sprout', alias: ['豆芽', '绿豆芽', '黄豆芽'], fdcId: 169957 },
  { key: 'chili', alias: ['辣椒', '小米辣', '小米椒', '干辣椒', '线椒', '螺丝椒', '杭椒'], fdcId: 170106 },
  { key: 'shiitake', alias: ['香菇', '冬菇', '花菇'], fdcId: 169242 },
  { key: 'mushroom', alias: ['蘑菇', '口蘑', '白蘑菇', '鲜香菇', '平菇', '蟹味菇', '白玉菇', '杏鲍菇'], fdcId: 169251 },
  { key: 'enoki', alias: ['金针菇'], fdcId: 169382 },
  { key: 'wood-ear', alias: ['木耳', '黑木耳', '云耳'], fdcId: 168581 },
  { key: 'oyster-mushroom', alias: ['蚝菇', '秀珍菇'], fdcId: 168580 },
  { key: 'scallion', alias: ['葱', '小葱', '香葱', '大葱', '葱花', '葱段', '葱末', '蒜苗'], fdcId: 170005 },
  { key: 'garlic', alias: ['大蒜', '蒜', '蒜瓣', '蒜头', '蒜末', '蒜蓉', '蒜片'], fdcId: 169230 },
  { key: 'ginger', alias: ['姜', '生姜', '姜片', '姜末', '姜丝', '老姜', '泡姜'], fdcId: 169231 },
  { key: 'cilantro', alias: ['香菜', '芫荽'], fdcId: 169997 },
  { key: 'chives', alias: ['韭菜', '韭黄'], fdcId: 169994 },
  { key: 'lettuce', alias: ['生菜', '油麦菜', '莴笋叶', '罗马生菜'], fdcId: 169247 },
  { key: 'asparagus-lettuce', alias: ['莴笋', '莴苣'], fdcId: 169247 },
  { key: 'zucchini', alias: ['西葫芦', '角瓜'], fdcId: 170487 },
  { key: 'kale', alias: ['羽衣甘蓝', '芥蓝'], fdcId: 168421 },
  { key: 'squash', alias: ['冬瓜', '丝瓜', '苦瓜', '佛手瓜'], fdcId: 170489, note: 'USDA 无对应条目，采用冬季南瓜作为近似' },
  { key: 'pea', alias: ['豌豆', '青豆粒', '甜豆'], fdcId: 170419 },
  { key: 'corn-kernel', alias: ['甜玉米粒', '罐头玉米'], fdcId: 169216 },
  { key: 'peanut', alias: ['花生', '花生米', '熟花生'], fdcId: 172430 },
  { key: 'sesame', alias: ['芝麻', '白芝麻', '熟芝麻', '黑芝麻'], fdcId: 170150 },
  { key: 'goji', alias: ['枸杞', '枸杞子'], fdcId: 168581, note: 'USDA 无枸杞条目，采用干木耳作为近似（用量通常很小）' },
  { key: 'jujube', alias: ['红枣', '大枣', '枣'], fdcId: 168581, note: 'USDA 无红枣条目，采用干木耳作为近似（用量通常很小）' },

  // ---------- 油脂 ----------
  { key: 'oil', alias: ['食用油', '植物油', '油', '菜籽油', '葵花籽油', '大豆油', '玉米油', '花生油', '色拉油'], fdcId: 171411 },
  { key: 'olive-oil', alias: ['橄榄油'], fdcId: 171413 },
  { key: 'sesame-oil', alias: ['香油', '芝麻油'], fdcId: 171016 },
  { key: 'lard', alias: ['猪油', '大油', '荤油'], fdcId: 171401 },

  // ---------- 调味 ----------
  { key: 'salt', alias: ['盐', '食盐', '食用盐', '精盐'], fdcId: 173468 },
  { key: 'sugar', alias: ['白糖', '白砂糖', '糖', '砂糖', '冰糖', '细砂糖'], fdcId: 169655 },
  { key: 'brown-sugar', alias: ['红糖', '黑糖'], fdcId: 168833 },
  { key: 'soy-sauce', alias: ['生抽', '酱油', '老抽', '味极鲜', '蒸鱼豉油'], fdcId: 174277 },
  { key: 'oyster-sauce', alias: ['蚝油'], fdcId: 174529 },
  { key: 'vinegar', alias: ['醋', '香醋', '陈醋', '白醋', '米醋', '料酒'], fdcId: 172237, note: '料酒（烹饪黄酒）在 USDA 中无对应条目，此处按醋近似；用量小且酒精会挥发' },
  { key: 'cooking-wine', alias: ['黄酒', '花雕酒', '米酒', '醪糟'], fdcId: 167723 },
  { key: 'beer', alias: ['啤酒'], fdcId: 168746 },
  { key: 'fish-sauce', alias: ['鱼露'], fdcId: 174531 },
  { key: 'ketchup', alias: ['番茄酱', '番茄沙司'], fdcId: 170054 },
  { key: 'tomato-paste', alias: ['番茄膏', '番茄罐头'], fdcId: 170459 },
  { key: 'honey', alias: ['蜂蜜'], fdcId: 169640 },
  { key: 'black-pepper', alias: ['胡椒粉', '黑胡椒', '白胡椒粉', '花椒粉'], fdcId: 170931, note: '花椒粉按黑胡椒近似' },
  { key: 'cumin', alias: ['孜然', '孜然粉'], fdcId: 170923 },
  { key: 'anise', alias: ['八角', '大料', '茴香'], fdcId: 171316 },
  { key: 'cinnamon', alias: ['桂皮', '肉桂'], fdcId: 171320 },
  { key: 'bay-leaf', alias: ['香叶'], fdcId: 170917 },
  { key: 'fennel', alias: ['小茴香'], fdcId: 171323 },
  { key: 'chili-powder', alias: ['辣椒粉', '辣椒面', '五香粉', '十三香', '椒盐粉'], fdcId: 171319 },
  { key: 'garlic-powder', alias: ['蒜粉', '蒜香粉'], fdcId: 171325 },
  { key: 'lemon', alias: ['柠檬', '柠檬汁'], fdcId: 167746 },
  { key: 'water', alias: ['水', '清水', '开水', '饮用水', '温水', '凉水', '热水', '沸水', '冰块', '高汤', '鸡汤（液体）'], fdcId: 175096, note: '水、冰块与清汤按 0 热量计' },
];

// ==================================================================
// 家庭常用「个数单位 -> 克」换算
// ------------------------------------------------------------------
// 说明：这些是家庭烹饪的常见折算值，属于本项目的经验参数，
//       不是 USDA 数据。数值保守取中位，避免高估。
// ==================================================================
const UNIT_GRAMS = {
  个: null,   // 「个」的含义随食材变化很大，不能一概而论，由 PER_ITEM 按食材处理
  只: null,
  根: 15, 瓣: 4, 颗: 5, 片: 4, 段: 20, 条: 30,
  块: 30, 把: 30, 支: 10, 张: 8, 听: 330, 罐: 330, 包: 200, 袋: 200,
  勺: 15, 汤匙: 15, 茶匙: 5, 碗: 200, 杯: 240,
  斤: 500, 两: 50, 人份: null,
};

/** 「个/只」按食材细分的单重（克）。没有列到的食材用 DEFAULT_ITEM_GRAMS。 */
const PER_ITEM = {
  egg: 50,
  'egg-white': 33,
  tomato: 180,
  potato: 150,
  onion: 150,
  'sweet-potato-raw': 200,
  'sweet-potato-cooked': 200,
  eggplant: 200,
  cucumber: 200,
  'green-pepper': 60,
  chili: 5,
  carrot: 120,
  'lotus-root': 200,
  lemon: 100,
  'corn-cooked': 250,
  bread: 35,
  mantou: 80,
  shiitake: 15,
  mushroom: 20,
  scallion: 15,
  garlic: 4,
  ginger: 5,
  squash: 300,
  pumpkin: 300,
  zucchini: 250,
  radish: 200,
  'cabbage-napa': 800,
  cabbage: 800,
  cauliflower: 500,
  broccoli: 300,
  taro: 120,
  yam: 200,
  'chicken-leg': 200,
  'chicken-wing': 50,
  'pork-belly': 500,
  sausage: 40,
  bacon: 20,
  'fish-white': 400,
  salmon: 200,
  shrimp: 8,
  squid: 200,
  'corn-kernel': 250,
};
const DEFAULT_ITEM_GRAMS = 50;

// ==================================================================
// 构建
// ==================================================================

const refresh = process.argv.includes('--refresh');

function unzip(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // Windows 自带 PowerShell 的 Expand-Archive；其他平台用 unzip
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`], { stdio: 'pipe' });
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', outDir], { stdio: 'pipe' });
  }
}

async function fetchFile(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'what-should-we-eat-today-build' } });
  if (!res.ok) throw new Error(`下载失败 ${url}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** 建立 fdcId -> { 数值, 描述 } 的索引 */
async function loadCatalog() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const index = new Map();

  for (const ds of DATASETS) {
    const zipPath = path.join(CACHE_DIR, ds.file);
    if (refresh || !fs.existsSync(zipPath)) {
      console.log(`· 下载 ${ds.file} …`);
      await fetchFile(FDC_BASE + ds.file, zipPath);
    }
    const jsonName = ds.file.replace(/\.zip$/, '.json');
    const jsonPath = path.join(CACHE_DIR, jsonName);
    if (!fs.existsSync(jsonPath)) {
      console.log(`· 解压 ${ds.file} …`);
      unzip(zipPath, CACHE_DIR);
    }

    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    for (const food of raw[ds.key] || []) {
      if (!food || !Array.isArray(food.foodNutrients)) continue;
      const vals = {};
      for (const n of food.foodNutrients) {
        const id = n?.nutrient?.id;
        if (id in NUTRIENT_IDS && n.amount != null) {
          vals[NUTRIENT_IDS[id]] = Math.round(Number(n.amount) * 100) / 100;
        }
      }
      if (vals.kcal == null) continue;
      index.set(food.fdcId, {
        fdcId: food.fdcId,
        usdaDescription: food.description,
        dataset: ds.label,
        per100g: {
          kcal: vals.kcal,
          protein: vals.protein ?? 0,
          fat: vals.fat ?? 0,
          carbs: vals.carbs ?? 0,
        },
      });
    }
    console.log(`· ${ds.label}: 解析 ${(raw[ds.key] || []).length} 条`);
  }
  return index;
}

console.log('营养数据构建开始');
const catalog = await loadCatalog();
console.log(`· USDA 索引共 ${catalog.size} 条含能量的食物`);

// —— 解析对照表 ——
const foods = [];
const problems = [];
const seenKeys = new Set();
const seenNames = new Map();

for (const def of FOODS) {
  if (seenKeys.has(def.key)) problems.push(`重复的 key：${def.key}`);
  seenKeys.add(def.key);

  const hit = catalog.get(def.fdcId);
  if (!hit) {
    problems.push(`fdcId 在 USDA 数据中找不到：${def.key} -> ${def.fdcId}`);
    continue;
  }

  const entry = {
    key: def.key,
    names: def.alias,
    fdcId: def.fdcId,
    usdaDescription: hit.usdaDescription,
    per100g: hit.per100g,
  };
  if (def.staple) entry.staple = true;
  if (def.note) entry.note = def.note;
  foods.push(entry);

  for (const n of def.alias) {
    const k = n.toLowerCase();
    if (seenNames.has(k)) problems.push(`别名冲突：「${n}」同时属于 ${seenNames.get(k)} 和 ${def.key}`);
    else seenNames.set(k, def.key);
  }
}

const payload = {
  version: 1,
  source: {
    sourceName: 'USDA FoodData Central',
    sourceType: 'public-domain-dataset',
    sourceUrl: 'https://fdc.nal.usda.gov/',
    license: 'CC0 1.0 Universal (Public Domain Dedication)',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    datasets: DATASETS.map((d) => d.label),
    retrievedAt: new Date().toISOString().slice(0, 10),
    note: '营养数值为每 100 g 可食部、直接取自上述数据集（未手工录入）。'
      + '中文名称为本项目建立的对应关系，其中标注 note 的条目为近似替代。',
  },
  unitConversions: { byUnit: UNIT_GRAMS, perItem: PER_ITEM, defaultItemGrams: DEFAULT_ITEM_GRAMS },
  foods,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');

const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
console.log('\n—— 构建结果 ——');
console.log(`食物条目：${foods.length} 条（别名共 ${seenNames.size} 个）`);
console.log(`可作主食：${foods.filter((f) => f.staple).length} 条`);
console.log(`输出：${path.relative(PROJECT_ROOT, OUT_FILE)}  (${sizeKb} KB)`);
if (problems.length) {
  console.log(`\n⚠ 问题 ${problems.length} 条：`);
  problems.forEach((p) => console.log('  - ' + p));
  process.exitCode = 1;
} else {
  console.log('对照表校验：通过（无重复 key、无别名冲突、fdcId 全部命中）');
}
