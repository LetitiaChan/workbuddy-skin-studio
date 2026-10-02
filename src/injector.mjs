import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { CdpSession, fetchRendererTargets, waitForRendererTargets } from "./cdp-client.mjs";
import { buildSkinCss } from "./skin-css.mjs";
import { buildSkinMenuScript, CSS_SENTINELS, VIDEO_LAYER_CSS } from "./skin-menu.mjs";
import { probeAnimatedSize } from "./theme-store.mjs";

const STYLE_ID = "workbuddy-skin-style";
const MENU_ID = "workbuddy-skin-menu";
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".avifs": "image/avif",
};

async function evaluateTargets(targets, expression, Session) {
  const values = [];
  for (const target of targets) {
    const session = new Session(target.webSocketDebuggerUrl);
    try {
      await session.open();
      values.push(await session.evaluate(expression));
    } finally {
      session.close();
    }
  }
  return values;
}

async function themeEntry(loadedTheme) {
  const extension = extname(loadedTheme.heroPath).toLowerCase();
  const isVideo = extension === ".mp4";
  // 视频主题：CSS 底图用 poster 海报帧（视频体太大不进 CSS，见 ensureRendererVideos）
  const mediaPath = isVideo ? loadedTheme.posterPath : loadedTheme.heroPath;
  const bytes = await readFile(mediaPath);
  const mime = MIME[extname(mediaPath).toLowerCase()];
  if (!mime) throw new Error(isVideo ? "不支持的 poster 图片类型" : "不支持的 hero 图片类型");
  const heroDataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  // 动图主题（GIF/动态 WebP/动态 AVIF）打 animated 标，菜单列表据此加「动图」标注
  const isAnimated = !isVideo && (await probeAnimatedSize(loadedTheme.heroPath, extension)) !== null;
  return {
    id: loadedTheme.manifest.id,
    name: loadedTheme.manifest.name,
    accent: loadedTheme.manifest.colors?.accent,
    surface: loadedTheme.manifest.colors?.surface,
    css: buildSkinCss({ theme: loadedTheme.manifest, heroDataUrl }) + (isVideo ? VIDEO_LAYER_CSS : ""),
    ...(isVideo ? { kind: "video", videoPath: loadedTheme.heroPath } : {}),
    ...(isAnimated ? { kind: "animated" } : {}),
  };
}

// ---- 内置视频主题：MP4 分块经 CDP 写入渲染进程 IndexedDB ----
// 与皮肤菜单自定义视频共用 workbuddy-skin-studio/videos 存储、按主题 id 取放；
// 内置主题内容稳定，按字节数判重，重复 apply 零成本
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
const IDB_OPEN_SNIPPET = `const wbSkinIdbOpen = () => new Promise((resolve, reject) => {
  const req = indexedDB.open("workbuddy-skin-studio", 1);
  req.onupgradeneeded = () => { req.result.createObjectStore("videos"); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});`;

async function rendererVideoSize(session, id) {
  const size = await session.evaluate(`(async () => {
    ${IDB_OPEN_SNIPPET}
    const db = await wbSkinIdbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction("videos", "readonly").objectStore("videos").get(${JSON.stringify(id)});
        req.onsuccess = () => resolve(req.result && typeof req.result.size === "number" ? req.result.size : 0);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  })()`, { timeoutMs: 15000 });
  return typeof size === "number" ? size : 0;
}

async function uploadRendererVideo(session, id, bytes) {
  const key = JSON.stringify(id);
  try {
    await session.evaluate(`(() => { (window.__wbSkinVideoUpload ??= {})[${key}] = []; return true; })()`);
    for (let offset = 0; offset < bytes.length; offset += VIDEO_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + VIDEO_CHUNK_BYTES, bytes.length));
      await session.evaluate(`(() => {
        const bin = atob(${JSON.stringify(chunk.toString("base64"))});
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        window.__wbSkinVideoUpload[${key}].push(arr);
        return arr.length;
      })()`, { timeoutMs: 30000 });
    }
    const stored = await session.evaluate(`(async () => {
      ${IDB_OPEN_SNIPPET}
      const parts = window.__wbSkinVideoUpload[${key}] ?? [];
      const blob = new Blob(parts, { type: "video/mp4" });
      const db = await wbSkinIdbOpen();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction("videos", "readwrite");
          tx.objectStore("videos").put(blob, ${key});
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
      return blob.size;
    })()`, { timeoutMs: 60000 });
    if (stored !== bytes.length) {
      throw new Error(`视频写入渲染进程后大小不符（${stored} != ${bytes.length}）`);
    }
  } finally {
    await session
      .evaluate(`(() => { if (window.__wbSkinVideoUpload) delete window.__wbSkinVideoUpload[${key}]; return true; })()`)
      .catch(() => {});
  }
}

async function ensureRendererVideos({ targets, Session, entries }) {
  const videoEntries = entries.filter((entry) => entry.kind === "video" && entry.videoPath);
  if (videoEntries.length === 0) return;
  for (const target of targets) {
    const session = new Session(target.webSocketDebuggerUrl);
    try {
      await session.open();
      for (const entry of videoEntries) {
        const bytes = await readFile(entry.videoPath);
        if ((await rendererVideoSize(session, entry.id)) === bytes.length) continue;
        await uploadRendererVideo(session, entry.id, bytes);
      }
    } finally {
      session.close();
    }
  }
}

export async function applySkin({ loadedTheme, themes, port, activeId, deps = {} }) {
  const wait = deps.waitForRendererTargets ?? waitForRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const menuThemes = themes?.length ? themes : [loadedTheme];
  const entries = [];
  for (const theme of menuThemes) entries.push(await themeEntry(theme));
  // activeId 显式传入时优先（null = 注入后保持清空，由调用方后续激活自定义皮肤）；
  // 但不得指向菜单之外的主题
  const themeId = activeId === undefined ? loadedTheme.manifest.id : activeId;
  // 自定义上传主题的客户端 CSS 模板：哨兵值占位，页面内替换，和内置主题同一套模板
  const cssTemplate = buildSkinCss({
    theme: {
      id: CSS_SENTINELS.id,
      name: "custom",
      colors: {
        accent: CSS_SENTINELS.accent,
        secondary: CSS_SENTINELS.secondary,
        surface: CSS_SENTINELS.surface,
        text: CSS_SENTINELS.text,
      },
      copy: null,
    },
    heroDataUrl: CSS_SENTINELS.hero,
  });
  const expression = buildSkinMenuScript({
    entries,
    activeId: themeId,
    styleId: STYLE_ID,
    menuId: MENU_ID,
    cssTemplate,
  });
  const targets = await wait(port, {
    timeoutMs: deps.waitTimeoutMs ?? 20_000,
    pollMs: deps.pollMs ?? 500,
  });
  // 先预置内置视频主题的 MP4（菜单初始激活视频主题时即可从 IndexedDB 取到），再注入菜单
  await ensureRendererVideos({ targets, Session, entries });
  const values = await evaluateTargets(targets, expression, Session);
  return { applied: values.length, themeId, menuThemes: entries.map(({ id }) => id), targets: targets.map(({ id }) => id) };
}

export async function removeSkin({ port, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    document.getElementById(${JSON.stringify(STYLE_ID)})?.remove();
    document.getElementById(${JSON.stringify(MENU_ID)})?.remove();
    delete document.documentElement.dataset.workbuddySkin;
    return true;
  })()`;
  const targets = await fetchTargets(port);
  const values = await evaluateTargets(targets, expression, Session);
  return { removed: values.length };
}

export async function skinStatus({ port, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => ({
    installed: Boolean(document.getElementById(${JSON.stringify(STYLE_ID)})),
    menu: Boolean(document.getElementById(${JSON.stringify(MENU_ID)})),
    themeId: document.documentElement.dataset.workbuddySkin ?? null
  }))()`;
  const targets = await fetchTargets(port);
  return evaluateTargets(targets, expression, Session);
}

// 读取渲染进程里记住的上次皮肤 id（workbuddySkinActive），无则 null。
// 供 apply 不带 --theme 时恢复上次皮肤；读取失败（如 CDP 未就绪）返回 null 走默认
export async function readSavedActiveSkin({ port, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    try { return localStorage.getItem("workbuddySkinActive"); } catch { return null; }
  })()`;
  const targets = await fetchTargets(port);
  const values = await evaluateTargets(targets, expression, Session);
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

// 激活已持久化的自定义皮肤；若该皮肤已不存在（被删除/迁移失败），回落到指定内置主题
export async function activateSavedSkin({ port, id, fallbackId, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    const api = window.__workbuddySkin;
    if (!api) return false;
    api.applyCustom(${JSON.stringify(id)});
    if (!document.documentElement.dataset.workbuddySkin) api.setTheme(${JSON.stringify(fallbackId)});
    return true;
  })()`;
  const targets = await fetchTargets(port);
  const values = await evaluateTargets(targets, expression, Session);
  return { activated: values.filter(Boolean).length };
}
