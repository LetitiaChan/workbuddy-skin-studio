import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { CdpSession, fetchRendererTargets, waitForRendererTargets } from "./cdp-client.mjs";
import { BASE64_DECODE_SNIPPET, IDB_OPEN_SNIPPET, VIDEO_DB_LITERALS } from "./renderer-snippets.mjs";
import { buildSkinCss } from "./skin-css.mjs";
import { buildSkinMenuScript, CSS_SENTINELS, TEARDOWN_GLOBAL, VIDEO_LAYER_CSS } from "./skin-menu.mjs";
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
const { store: VIDEO_STORE } = VIDEO_DB_LITERALS;

const errorText = (error) => (error instanceof Error ? error.message : String(error));

function resolveDeps(deps) {
  return {
    fetchTargets: deps.fetchRendererTargets ?? fetchRendererTargets,
    Session: deps.Session ?? CdpSession,
  };
}

async function openSession(Session, target) {
  const session = new Session(target.webSocketDebuggerUrl);
  try {
    await session.open();
  } catch (error) {
    session.close();
    throw error;
  }
  return session;
}

async function withSession(Session, target, run) {
  const session = await openSession(Session, target);
  try {
    return await run(session);
  } finally {
    session.close();
  }
}

// 轻量表达式（状态/暂停/读取/激活）各 target 互不依赖，并发执行；结果顺序与 targets 一致
function evaluateTargets(targets, expression, Session) {
  return Promise.all(targets.map((target) => withSession(Session, target, (session) => session.evaluate(expression))));
}

async function evaluateOnPort(port, expression, deps) {
  const { fetchTargets, Session } = resolveDeps(deps);
  const targets = await fetchTargets(port);
  return evaluateTargets(targets, expression, Session);
}

async function themeEntry(loadedTheme) {
  const extension = extname(loadedTheme.heroPath).toLowerCase();
  const isVideo = extension === ".mp4";
  // 视频主题：CSS 底图用 poster 海报帧（视频体太大不进 CSS，见 syncVideosInSession）
  const mediaPath = isVideo ? loadedTheme.posterPath : loadedTheme.heroPath;
  if (typeof mediaPath !== "string" || mediaPath.length === 0) {
    // schema 层（loadTheme）已保证视频主题必有 poster；此处防御未来绕过校验的调用方，
    // 避免 readFile(undefined) 抛出难以定位的 TypeError
    throw new Error(`主题 ${loadedTheme.manifest.id} 缺少 ${isVideo ? "poster" : "hero"} 文件路径`);
  }
  const mime = MIME[extname(mediaPath).toLowerCase()];
  if (!mime) throw new Error(isVideo ? "不支持的 poster 图片类型" : "不支持的 hero 图片类型");
  // 读图与动图头探测互不依赖，并发
  const [bytes, animatedSize] = await Promise.all([
    readFile(mediaPath),
    isVideo ? null : probeAnimatedSize(loadedTheme.heroPath, extension),
  ]);
  const heroDataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  // 动图主题（GIF/动态 WebP/动态 AVIF）打 animated 标，菜单列表据此加「动图」标注
  const kind = isVideo ? "video" : animatedSize !== null ? "animated" : undefined;
  return {
    id: loadedTheme.manifest.id,
    name: loadedTheme.manifest.name,
    accent: loadedTheme.manifest.colors?.accent,
    surface: loadedTheme.manifest.colors?.surface,
    css: buildSkinCss({ theme: loadedTheme.manifest, heroDataUrl }) + (isVideo ? VIDEO_LAYER_CSS : ""),
    ...(kind ? { kind } : {}),
    ...(isVideo ? { videoPath: loadedTheme.heroPath } : {}),
  };
}

// 自定义上传主题的客户端 CSS 模板：哨兵值占位，页面内替换，和内置主题同一套模板
function buildCustomCssTemplate() {
  return buildSkinCss({
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
}

// ---- 内置视频主题：MP4 分块经 CDP 写入渲染进程 IndexedDB ----
// 与皮肤菜单自定义视频共用同一个视频库、按主题 id 取放；
// 内置主题内容稳定，判重仅按字节数（前提：不同主题的视频长度不同、同一主题内容变更
// 必引起长度变化；内置主题满足此前提，自定义内容不经此路径）。重复 apply 时
// 先 stat 比大小即可跳过，不把整段 MP4 读进内存
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;

async function rendererVideoSize(session, id) {
  const size = await session.evaluate(`(async () => {
    ${IDB_OPEN_SNIPPET}
    const db = await wbSkinIdbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction(${VIDEO_STORE}, "readonly").objectStore(${VIDEO_STORE}).get(${JSON.stringify(id)});
        req.onsuccess = () => resolve(req.result && typeof req.result.size === "number" ? req.result.size : 0);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  })()`, { timeoutMs: 15000 });
  return typeof size === "number" ? size : 0;
}

export async function uploadRendererVideo(session, id, bytes) {
  const key = JSON.stringify(id);
  try {
    await session.evaluate(`(() => { (window.__wbSkinVideoUpload ??= {})[${key}] = []; return true; })()`);
    for (let offset = 0; offset < bytes.length; offset += VIDEO_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + VIDEO_CHUNK_BYTES, bytes.length));
      // 每块 4MB → base64 约 5.6MB，解码在渲染进程主线程同步执行；每块开头 setTimeout(0)
      // 让出主线程，把 apply 期间的连续卡顿降为可接受的掉帧。
      // base64 字母表只含 [A-Za-z0-9+/=]，无需 JSON.stringify 转义，直接加引号省一次 5.6MB 扫描
      await session.evaluate(`(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        ${BASE64_DECODE_SNIPPET}
        const arr = wbSkinDecodeBase64("${chunk.toString("base64")}");
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
          const tx = db.transaction(${VIDEO_STORE}, "readwrite");
          tx.objectStore(${VIDEO_STORE}).put(blob, ${key});
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
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

// 本地视频文件在 loadTheme 已校验存在；stat 失败属确定性损坏，降级为警告（返回 warning）
async function prepareVideoSources(entries) {
  const videoEntries = entries.filter((entry) => entry.kind === "video" && entry.videoPath);
  if (videoEntries.length === 0) return { videoEntries };
  try {
    const sizes = await Promise.all(videoEntries.map((entry) => stat(entry.videoPath)));
    // bytes 存 Promise：跨 target 复用、只读一次，且并发场景下不会重复读盘
    const sources = new Map(videoEntries.map((entry, index) => [entry.id, { size: sizes[index].size, bytes: null }]));
    return { videoEntries, sources };
  } catch (error) {
    return { videoEntries: [], warning: `读取内置视频文件失败：${errorText(error)}` };
  }
}

async function syncVideosInSession(session, { videoEntries, sources }) {
  for (const entry of videoEntries) {
    const source = sources.get(entry.id);
    if ((await rendererVideoSize(session, entry.id)) === source.size) continue;
    source.bytes ??= readFile(entry.videoPath);
    await uploadRendererVideo(session, entry.id, await source.bytes);
  }
}

const videoWarning = (target, error) => `视频预置到渲染进程失败（target ${target.id}）：${errorText(error)}`;

// 视频预置是增强项而非注入目标：单个 target 上传失败（超时 / OOM / renderer 正好导航）
// 只收集警告，不阻塞皮肤注入——菜单端对「视频数据缺失」本就有兜底提示
export async function ensureRendererVideos({ targets, Session, entries }) {
  const plan = await prepareVideoSources(entries);
  if (plan.warning) return [plan.warning];
  if (plan.videoEntries.length === 0) return [];
  const warnings = [];
  for (const target of targets) {
    try {
      await withSession(Session, target, (session) => syncVideosInSession(session, plan));
    } catch (error) {
      warnings.push(videoWarning(target, error));
    }
  }
  return warnings;
}

export async function applySkin({ loadedTheme, themes, port, activeId, deps = {} }) {
  const wait = deps.waitForRendererTargets ?? waitForRendererTargets;
  const { Session } = resolveDeps(deps);
  const menuThemes = themes?.length ? themes : [loadedTheme];
  // 各主题读图/编码互不依赖，并发；Promise.all 保序，菜单顺序不变
  const entries = await Promise.all(menuThemes.map(themeEntry));
  // activeId 显式传入时优先（null = 注入后保持清空，由调用方后续激活自定义皮肤）；
  // 但不得指向菜单之外的主题（buildSkinMenuScript 校验）
  const themeId = activeId === undefined ? loadedTheme.manifest.id : activeId;
  const expression = buildSkinMenuScript({
    entries,
    activeId: themeId,
    styleId: STYLE_ID,
    menuId: MENU_ID,
    cssTemplate: buildCustomCssTemplate(),
  });
  const plan = await prepareVideoSources(entries);
  const videoWarnings = plan.warning ? [plan.warning] : [];
  const targets = await wait(port, {
    timeoutMs: deps.waitTimeoutMs ?? 20_000,
    pollMs: deps.pollMs ?? 500,
  });

  // 每个 target 一条会话：先预置内置视频 MP4（菜单初始激活视频主题时即可从 IndexedDB 取到），
  // 再注入菜单。视频失败只记警告；该会话可能已被超时/导航打断，换新连接再注入，保证不阻塞换肤
  let applied = 0;
  for (const target of targets) {
    let session = await openSession(Session, target);
    try {
      if (plan.videoEntries.length > 0) {
        try {
          await syncVideosInSession(session, plan);
        } catch (error) {
          videoWarnings.push(videoWarning(target, error));
          session.close();
          session = await openSession(Session, target);
        }
      }
      await session.evaluate(expression);
      applied += 1;
    } finally {
      session.close();
    }
  }
  return {
    applied,
    themeId,
    menuThemes: entries.map(({ id }) => id),
    targets: targets.map(({ id }) => id),
    videoWarnings,
  };
}

export async function removeSkin({ port, deps = {} }) {
  // 先调菜单脚本注册的 teardown：断开 MutationObserver、解除明暗钉住、移除全局监听与视频层；
  // 缺了这步，暂停后旧菜单的观察者仍会持续改写 body/html 的明暗类
  const expression = `(() => {
    try { window[${JSON.stringify(TEARDOWN_GLOBAL)}]?.(); } catch (error) { console.warn("WorkBuddy Skin：teardown 失败", error); }
    document.getElementById(${JSON.stringify(STYLE_ID)})?.remove();
    document.getElementById(${JSON.stringify(MENU_ID)})?.remove();
    delete document.documentElement.dataset.workbuddySkin;
    return true;
  })()`;
  const values = await evaluateOnPort(port, expression, deps);
  return { removed: values.length };
}

export function skinStatus({ port, deps = {} }) {
  const expression = `(() => ({
    installed: Boolean(document.getElementById(${JSON.stringify(STYLE_ID)})),
    menu: Boolean(document.getElementById(${JSON.stringify(MENU_ID)})),
    themeId: document.documentElement.dataset.workbuddySkin ?? null
  }))()`;
  return evaluateOnPort(port, expression, deps);
}

// 读取渲染进程里记住的上次皮肤 id（workbuddySkinActive），无则 null。
// 供 apply 不带 --theme 时恢复上次皮肤；读取失败（如 CDP 未就绪）由调用方兜底走默认
export async function readSavedActiveSkin({ port, deps = {} }) {
  const expression = `(() => {
    try { return localStorage.getItem("workbuddySkinActive"); } catch { return null; }
  })()`;
  const values = await evaluateOnPort(port, expression, deps);
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

// 激活已持久化的自定义皮肤；若该皮肤已不存在（被删除/迁移失败），回落到指定内置主题
export async function activateSavedSkin({ port, id, fallbackId, deps = {} }) {
  const expression = `(() => {
    const api = window.__workbuddySkin;
    if (!api) return false;
    api.applyCustom(${JSON.stringify(id)});
    if (!document.documentElement.dataset.workbuddySkin) api.setTheme(${JSON.stringify(fallbackId)});
    return true;
  })()`;
  const values = await evaluateOnPort(port, expression, deps);
  return { activated: values.filter(Boolean).length };
}
