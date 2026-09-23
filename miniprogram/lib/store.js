/* ============================================================
   小程序端：本地设置读写
   ------------------------------------------------------------
   这是整个小程序里**唯一**调用 wx 存储 API 的地方。
   归一化逻辑在 lib/settings.js（纯函数，可在 Node 里直接断言）。

   存储位置：本机（wx.setStorageSync），不上传、不需要账号、不跨设备同步。
   键名与 Web 版 localStorage 完全一致：what-should-we-eat-today.settings
   ============================================================ */

const { SETTINGS_KEY, normalizeSettings } = require('./settings.js');

/**
 * 读取设置。
 * 存储为空、格式损坏、是老版本结构，都会得到一份可用的默认设置，不抛异常。
 */
function loadSettings() {
  let raw = null;
  try {
    raw = wx.getStorageSync(SETTINGS_KEY);
  } catch (e) {
    console.warn('[今天吃什么] 读取本地设置失败，使用默认设置：', e);
    return normalizeSettings(null);
  }
  // 空串 / undefined 都会在 normalizeSettings 里落到默认值
  return normalizeSettings(raw);
}

/** 保存设置。失败时给出可读日志，不打断用户操作。 */
function saveSettings(settings) {
  try {
    wx.setStorageSync(SETTINGS_KEY, settings);
    return true;
  } catch (e) {
    console.warn('[今天吃什么] 设置没能保存到本地：', e);
    return false;
  }
}

module.exports = { SETTINGS_KEY, loadSettings, saveSettings };
