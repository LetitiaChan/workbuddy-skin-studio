import assert from "node:assert/strict";
import test from "node:test";

import { buildSkinMenuScript } from "../src/skin-menu.mjs";

// 皮肤菜单脚本是字符串模板：无法直接在 Node 里跑 DOM，
// 采用「语法编译 + 关键结构片段断言」，与 injector.test.mjs 的表达式断言风格一致
const ENTRIES = [
  { id: "night", name: "暗夜", accent: "#24c9d7", surface: "#101418", css: ":root{--wb-a:1}" },
  { id: "waves", name: "海浪", css: ":root{--wb-b:2}", kind: "video" },
];

const build = (overrides = {}) =>
  buildSkinMenuScript({ entries: ENTRIES, activeId: "night", styleId: "sid", menuId: "mid", ...overrides });

test("buildSkinMenuScript：生成的注入脚本可被 JS 引擎编译", () => {
  assert.doesNotThrow(() => new Function(build()));
  // activeId 指向自定义皮肤（注入后由 activateSavedSkin 激活）时同样可编译
  assert.doesNotThrow(() => new Function(build({ activeId: null })));
});

test("切换路径：setTheme/applyCustomTheme/clearTheme 均有异常兜底与错误日志", () => {
  const script = build();
  assert.ok(script.includes('logError("切换主题失败", id, error)'));
  assert.ok(script.includes('logError("应用自定义主题失败", theme?.id, error)'));
  assert.ok(script.includes('logError("恢复原生界面失败", null, error)'));
  // 列表行点击的最后一道兜底，覆盖内置/自定义/上传/原生所有 onPick
  assert.ok(script.includes("主题列表项点击处理失败"));
});

test("切换路径：主题不在列表中时输出警告而非静默忽略", () => {
  assert.ok(build().includes("主题不在菜单列表中，切换已忽略"));
});

test("asCssUrl：非法 data URL 与 base64 解码失败均回退并告警，不抛异常打断切换", () => {
  const script = build();
  assert.ok(script.includes("不是合法 data URL，已跳过 blob 转换"));
  assert.ok(script.includes("base64 解码失败，回退原始 data URL"));
});

test("asCssUrl：大图解码优先 Uint8Array.fromBase64 快路径，避免逐字节循环卡主线程", () => {
  const script = build();
  assert.ok(script.includes('typeof Uint8Array.fromBase64 === "function"'));
  assert.ok(script.includes("atob(b64)")); // 旧内核回退仍保留
});

test("videoStore：onblocked 告警 + onabort reject，IndexedDB 阻塞/中止不再静默挂起", () => {
  const script = build();
  assert.ok(script.includes("req.onblocked"));
  assert.ok(script.includes("IndexedDB 打开被阻塞"));
  assert.ok(script.includes("tx.onabort"));
});

test("mountVideo：视频缺失与加载失败的日志均带主题 id，自动播放失败不再静默", () => {
  const script = build();
  assert.ok(script.includes('视频皮肤加载失败（" + theme.id + "）'));
  assert.ok(script.includes('主题：" + theme.id + "'));
  assert.ok(script.includes('视频自动播放失败（" + theme.id + "）'));
});
