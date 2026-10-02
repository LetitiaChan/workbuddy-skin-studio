import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_ID = "workbuddy-skin-studio";
export const PRODUCT_NAME = "WorkBuddy Skin Studio";
export const STATE_SCHEMA_VERSION = 1;
export const THEME_SCHEMA_VERSION = 1;
export const DEFAULT_THEME_ID = "miku-light";
export const DEFAULT_CDP_PORT = 9223;
// 内置视频主题（hero 为 MP4）的体积上限；与皮肤菜单里自定义视频上传的 30MB 上限保持一致
export const MAX_THEME_VIDEO_BYTES = 30 * 1024 * 1024;
export const EXPECTED_BUNDLE_ID = "com.workbuddy.workbuddy";

// WorkBuddy renderer target 的 URL 特征：app.asar/renderer/index.html
export const RENDERER_URL_HINT = "renderer/index.html";

export function resolveStudioPaths({ home = homedir() } = {}) {
  const isWin = process.platform === "win32";
  const installRoot = join(home, ".workbuddy", PRODUCT_ID);
  const stateRoot = isWin
    ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "WorkBuddySkinStudio")
    : join(home, "Library", "Application Support", "WorkBuddySkinStudio");

  return {
    installRoot,
    stateRoot,
    statePath: join(stateRoot, "state.json"),
    logPath: join(stateRoot, "injector.log"),
    userThemesRoot: join(stateRoot, "themes"),
  };
}
