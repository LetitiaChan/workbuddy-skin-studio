import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

// runCli 全部依赖可注入：这里只验证 apply 的编排（主题选择、并发加载、坏主题跳过、恢复自定义皮肤）
function applyOverrides({ saved = null, themes, failLoad = new Set() }) {
  const calls = { applySkin: null, activateSavedSkin: null };
  const overrides = {
    bundledThemesRoot: "bundled",
    userThemesRoot: "user",
    listThemes: async () => themes,
    readSavedActiveSkin: async () => saved,
    loadTheme: async (path) => {
      if (failLoad.has(path)) throw new Error(`broken ${path}`);
      return { manifest: { id: path.replace(/^dir-/, "") }, path };
    },
    applySkin: async (args) => {
      calls.applySkin = args;
      return { applied: 1, themeId: args.activeId === undefined ? args.loadedTheme.manifest.id : args.activeId };
    },
    activateSavedSkin: async (args) => {
      calls.activateSavedSkin = args;
      return { activated: 1 };
    },
  };
  return { overrides, calls };
}

const THEMES = ["miku-light", "a", "b"].map((id) => ({ id, path: `dir-${id}` }));

test("apply --theme：坏主题不进菜单，菜单保持 listThemes 顺序", async () => {
  const { overrides, calls } = applyOverrides({ themes: THEMES, failLoad: new Set(["dir-a"]) });
  const result = await runCli(["apply", "--theme", "b"], overrides);
  assert.equal(result.themeId, "b");
  assert.deepEqual(calls.applySkin.themes.map(({ manifest }) => manifest.id), ["miku-light", "b"]);
  assert.equal(calls.applySkin.loadedTheme, calls.applySkin.themes[1]); // 选中主题只加载一次并复用
});

test("apply --theme：选中主题本身加载失败时直接报错", async () => {
  const { overrides } = applyOverrides({ themes: THEMES, failLoad: new Set(["dir-b"]) });
  await assert.rejects(runCli(["apply", "--theme", "b"], overrides), /broken dir-b/);
});

test("apply 无 --theme：恢复上次记住的自定义皮肤（先默认主题注入，再激活）", async () => {
  const { overrides, calls } = applyOverrides({ saved: "custom-xyz", themes: THEMES });
  const result = await runCli(["apply"], overrides);
  assert.equal(calls.applySkin.activeId, null);
  assert.deepEqual(calls.activateSavedSkin, { port: 9223, id: "custom-xyz", fallbackId: "miku-light" });
  assert.equal(result.themeId, "custom-xyz");
  assert.equal(result.restored, true);
});

test("apply 无 --theme：记住的内置主题已不存在时回退默认主题", async () => {
  const { overrides, calls } = applyOverrides({ saved: "gone", themes: THEMES });
  const result = await runCli(["apply"], overrides);
  assert.equal(result.themeId, "miku-light");
  assert.equal(calls.activateSavedSkin, null);
});

test("apply --theme：指定的主题不存在时报错", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  await assert.rejects(runCli(["apply", "--theme", "nope"], overrides), /找不到主题：nope/);
});
