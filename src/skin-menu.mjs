const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const DEFAULT_ACCENT = "#24c9d7";

// 客户端 CSS 由 Node 端模板加哨兵生成，替换后与内置主题同源，避免两套模板漂移
export const CSS_SENTINELS = {
  id: "workbuddy-custom-sentinel-id",
  hero: "data:image/png;base64,WORKBUDDYHEROSENTINEL",
  accent: "#010203",
  secondary: "#040506",
  surface: "#070809",
  text: "#0a0b0c",
};

export function buildSkinMenuScript({ entries, activeId, styleId, menuId, cssTemplate = "" }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("皮肤菜单至少需要一个主题");
  }
  const themes = entries.map((entry) => {
    if (!entry?.id || typeof entry.css !== "string") throw new Error("主题条目缺少 id 或 css");
    return {
      id: String(entry.id),
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : String(entry.id),
      accent: HEX_COLOR.test(entry.accent ?? "") ? entry.accent : DEFAULT_ACCENT,
      surface: typeof entry.surface === "string" ? entry.surface : "#ffffff",
      css: entry.css,
    };
  });
  if (activeId !== null && !themes.some((theme) => theme.id === activeId)) {
    throw new Error(`当前主题不在菜单列表中：${activeId}`);
  }
  const payload = JSON.stringify({
    styleId,
    menuId,
    activeId,
    themes,
    cssTemplate,
    sentinels: CSS_SENTINELS,
    customPrefix: "custom-",
    storageKey: "workbuddyCustomThemes",
    legacyKey: "workbuddyCustomTheme",
    maxCustomSlots: 6,
  });

  return `(() => {
  const data = ${payload};

  let style = document.getElementById(data.styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = data.styleId;
    document.head.appendChild(style);
  }

  document.getElementById(data.menuId)?.remove();
  const root = document.createElement("div");
  root.id = data.menuId;
  root.style.cssText = "position:fixed;top:48px;right:16px;z-index:2147483000;font:500 13px/1.4 system-ui;user-select:none;";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "\\u{1F3A8}";
  button.title = "WorkBuddy Skin Studio";
  button.style.cssText = "display:block;margin-left:auto;width:38px;height:38px;border-radius:50%;border:1px solid rgba(0,0,0,.18);background:rgba(255,255,255,.92);backdrop-filter:blur(10px);box-shadow:0 3px 12px rgba(0,0,0,.24);cursor:pointer;font-size:19px;padding:0;";

  const panel = document.createElement("div");
  panel.style.cssText = "display:none;margin-top:8px;min-width:200px;padding:6px;border-radius:12px;border:1px solid rgba(0,0,0,.1);background:rgba(255,255,255,.94);backdrop-filter:blur(16px);box-shadow:0 10px 30px rgba(0,0,0,.18);color:#17344f;";

  const rows = new Map();
  const paint = (id) => {
    for (const [rowId, row] of rows) {
      row.style.background = rowId === id ? "rgba(36,201,215,.16)" : "transparent";
      row.style.fontWeight = rowId === id ? "700" : "500";
    }
  };
  const row = (label, dotColor, onPick, before) => {
    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;";
    const dot = document.createElement("span");
    dot.style.cssText = "width:10px;height:10px;border-radius:50%;flex:none;background:" + dotColor + ";";
    const text = document.createElement("span");
    text.textContent = label;
    item.append(dot, text);
    item.addEventListener("mouseenter", () => { if (item.style.fontWeight !== "700") item.style.background = "rgba(0,0,0,.05)"; });
    item.addEventListener("mouseleave", () => paint(document.documentElement.dataset.workbuddySkin ?? null));
    item.addEventListener("click", () => onPick(item));
    if (before) panel.insertBefore(item, before); else panel.appendChild(item);
    return item;
  };

  const isLightSurface = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return true;
    const v = parseInt(m[1], 16);
    return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) > 140;
  };
  // 同步切换 WorkBuddy 的 VS Code 主题模式，让原生控件（输入框/按钮等）跟着深浅色变
  const applyMode = (surface) => {
    const dark = !isLightSurface(surface);
    const body = document.body;
    const html = document.documentElement;
    body.dataset.vscodeThemeKind = dark ? "vscode-dark" : "vscode-light";
    body.dataset.vscodeThemeName = dark ? "IDE Dark" : "IDE Light";
    html.style.colorScheme = dark ? "dark" : "light";
    ["light", "vscode-light", "cb-light", "dark", "vscode-dark", "cb-dark"].forEach((cls) => {
      const isDarkCls = cls === "dark" || cls === "vscode-dark" || cls === "cb-dark";
      body.classList.toggle(cls, dark ? isDarkCls : !isDarkCls);
      html.classList.toggle(cls, dark ? isDarkCls : !isDarkCls);
    });
  };
  const setTheme = (id) => {
    const theme = data.themes.find((candidate) => candidate.id === id);
    if (!theme) return;
    style.textContent = theme.css;
    document.documentElement.dataset.workbuddySkin = theme.id;
    applyMode(theme.surface);
    paint(theme.id);
  };
  const clearTheme = () => {
    style.textContent = "";
    delete document.documentElement.dataset.workbuddySkin;
    applyMode("#ffffff");
    paint(null);
  };

  for (const theme of data.themes) {
    rows.set(theme.id, row(theme.name, theme.accent, () => { setTheme(theme.id); panel.style.display = "none"; }));
  }

  // ---- 自定义图片：本地选图 -> 压缩 -> 取色 -> 生成 CSS -> 持久化（多槽位） ----
  const buildCustomCss = (dataUrl, colors, themeId) => data.cssTemplate
    .split(data.sentinels.hero).join(dataUrl)
    .split(data.sentinels.accent).join(colors.accent)
    .split(data.sentinels.secondary).join(colors.secondary)
    .split(data.sentinels.surface).join(colors.surface)
    .split(data.sentinels.text).join(colors.text)
    .split(data.sentinels.id).join(themeId);

  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  const extractPalette = (canvas) => {
    const ctx = canvas.getContext("2d");
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const buckets = new Map();
    let lumSum = 0, count = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum; count += 1;
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < 0.18 || lum < 24 || lum > 245) continue;   // 灰、过暗、过曝不参与取主色
      const d = max - min || 1;
      let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const bucket = Math.round(h) % 6 * 2 + (sat > 0.55 ? 1 : 0);
      const entry = buckets.get(bucket) ?? { w: 0, r: 0, g: 0, b: 0, h: h * 60 };
      const weight = sat * sat;
      entry.w += weight; entry.r += r * weight; entry.g += g * weight; entry.b += b * weight;
      buckets.set(bucket, entry);
    }
    const avgLum = count ? lumSum / count : 128;
    const ranked = [...buckets.values()].sort((a, b2) => b2.w - a.w)
      .map((e) => ({ rgb: [e.r / e.w, e.g / e.w, e.b / e.w], h: e.h, w: e.w }));
    const accent = ranked[0]?.rgb ?? [36, 201, 215];
    const second = ranked.find((e) => Math.abs(e.h - (ranked[0]?.h ?? 0)) > 50)?.rgb
      ?? mix(accent, [255, 255, 255], 0.35);
    const light = avgLum > 128;
    const surface = light ? mix(accent, [252, 252, 255], 0.92) : mix(accent, [12, 12, 18], 0.86);
    const text = light ? mix(accent, [16, 24, 40], 0.82) : mix(accent, [244, 246, 252], 0.85);
    return {
      accent: hex(...accent),
      secondary: hex(...second),
      surface: hex(...surface),
      text: hex(...text),
    };
  };

  // Blink 的 CSS 解析器会静默丢弃含超长 data URL 的 background 声明（实测 4MB 动图
  // 必现，整个 background 简写失效背景消失），大体积 hero 统一转 blob: URL 再注入。
  // blob URL 生命周期与 renderer 一致，正好匹配注入的生命周期；localStorage 里仍存
  // data URL，每次应用现场转换，重启后重新注入时自然重建
  let heroBlobUrl = null;
  const asCssUrl = (dataUrl) => {
    if (dataUrl.length < 256 * 1024) return dataUrl;
    if (heroBlobUrl) URL.revokeObjectURL(heroBlobUrl);
    const comma = dataUrl.indexOf(",");
    const mime = dataUrl.slice(5, comma).split(";")[0];
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    heroBlobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    return heroBlobUrl;
  };

  const applyCustomTheme = (theme) => {
    style.textContent = buildCustomCss(asCssUrl(theme.dataUrl), theme.colors, theme.id);
    document.documentElement.dataset.workbuddySkin = theme.id;
    applyMode(theme.colors.surface);
    ensureCustomRow(theme);
    paint(theme.id);
  };

  const deleteCustom = (id) => {
    const list = loadCustoms().filter((theme) => theme.id !== id);
    saveCustoms(list);
    if (document.documentElement.dataset.workbuddySkin === id) clearTheme();
    rows.get(id)?.remove();
    rows.delete(id);
  };
  const ensureCustomRow = (theme) => {
    if (rows.has(theme.id)) return;
    const customRow = row(theme.name, theme.colors.accent, () => {
      applyCustomTheme(loadCustoms().find((saved) => saved.id === theme.id) ?? theme);
      panel.style.display = "none";
    }, uploadRow);
    const text = customRow.querySelector("span + span");
    text.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const del = document.createElement("span");
    del.textContent = "\\u00d7";
    del.title = "\\u5220\\u9664\\u81ea\\u5b9a\\u4e49\\u4e3b\\u9898";
    del.style.cssText = "flex:none;width:18px;height:18px;line-height:18px;text-align:center;border-radius:50%;color:rgba(0,0,0,.45);font-size:14px;";
    del.addEventListener("mouseenter", () => { del.style.background = "rgba(220,60,60,.15)"; del.style.color = "#c03030"; });
    del.addEventListener("mouseleave", () => { del.style.background = "transparent"; del.style.color = "rgba(0,0,0,.45)"; });
    del.addEventListener("click", (event) => { event.stopPropagation(); deleteCustom(theme.id); });
    customRow.appendChild(del);
    rows.set(theme.id, customRow);
  };

  // ---- 动图支持：GIF / 动态 WebP 跳过 canvas 重编码，原数据直接注入 CSS 以保留动画 ----
  // localStorage 配额约 5MB，base64 膨胀 4/3，故原始动图限制 3MB；
  // 动图不走 canvas 压缩，需单独卡分辨率上限，避免超大尺寸拖慢渲染
  const MAX_ANIMATED_BYTES = 3 * 1024 * 1024;
  const MAX_ANIMATED_DIMENSION = 1920;
  const sniffAnimated = (dataUrl) => {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return false;
    const header = dataUrl.slice(0, comma).toLowerCase();
    if (header.indexOf("image/gif") >= 0) return true;   // GIF 一律保留原数据（GIF87a/89a）
    if (header.indexOf("image/avif") >= 0) {
      try {
        // AVIF 是 ISO BMFF：第 8-11 字节为 ftyp 主品牌，avis = 动图序列，avif = 静态
        const bytes = atob(dataUrl.slice(comma + 1, comma + 1 + 64));
        return bytes.length >= 12 && bytes.slice(8, 12) === "avis";
      } catch { return false; }
    }
    if (header.indexOf("image/webp") < 0) return false;
    try {
      // 动态 WebP 的 VP8X + ANIM chunk 位于文件头部，解码前 400 个 base64 字符足够判定
      const b64 = dataUrl.slice(comma + 1, comma + 1 + 400);
      return atob(b64).includes("ANIM");
    } catch { return false; }
  };

  // 多槽位持久化：storageKey 存数组；legacyKey（单主题旧格式）读取时自动迁移
  const loadCustoms = () => {
    let list = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(data.storageKey) ?? "[]");
      if (Array.isArray(parsed)) list = parsed.filter((theme) => theme && theme.id && theme.dataUrl && theme.colors);
    } catch {}
    try {
      const legacy = JSON.parse(localStorage.getItem(data.legacyKey) ?? "null");
      if (legacy && legacy.dataUrl && legacy.colors) {
        legacy.id = data.customPrefix + "legacy";
        list = [legacy, ...list];
        localStorage.setItem(data.storageKey, JSON.stringify(list));
        localStorage.removeItem(data.legacyKey);
      }
    } catch {}
    return list;
  };
  const saveCustoms = (list) => {
    try { localStorage.setItem(data.storageKey, JSON.stringify(list)); }
    catch (error) { console.warn("WorkBuddy Skin：自定义主题占用超出 localStorage 配额，本次生效但重启后不保留", error); }
  };

  const importFromDataUrl = (dataUrl, name) => new Promise((resolve, reject) => {
    const existing = loadCustoms();
    if (existing.length >= data.maxCustomSlots) {
      reject(new Error("\\u81ea\\u5b9a\\u4e49\\u69fd\\u4f4d\\u5df2\\u6ee1\\uff08\\u6700\\u591a " + data.maxCustomSlots + " \\u4e2a\\uff09\\uff0c\\u8bf7\\u5148\\u5220\\u9664\\u4e00\\u4e2a\\u518d\\u4e0a\\u4f20"));
      return;
    }
    const animated = sniffAnimated(dataUrl);
    // base64 长度 * 3/4 ≈ 原始字节数；动图不压缩直接持久化，必须卡上限
    if (animated && Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4) > MAX_ANIMATED_BYTES) {
      reject(new Error("动图超过 3MB 上限（需存入 localStorage 以便重启后保留），请压缩后再试"));
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (animated && Math.max(img.width, img.height) > MAX_ANIMATED_DIMENSION) {
        reject(new Error("动图分辨率过高（" + img.width + "×" + img.height + "，最长边限 " + MAX_ANIMATED_DIMENSION + "px），请缩小尺寸后再试"));
        return;
      }
      // canvas drawImage 对动图只取第一帧，正好用于取色
      const sample = document.createElement("canvas");
      sample.width = 48; sample.height = Math.max(1, Math.round(48 * img.height / img.width));
      sample.getContext("2d").drawImage(img, 0, 0, sample.width, sample.height);
      let heroUrl = dataUrl;
      if (!animated) {
        const scale = Math.min(1, 1600 / img.width);
        const full = document.createElement("canvas");
        full.width = Math.round(img.width * scale);
        full.height = Math.round(img.height * scale);
        full.getContext("2d").drawImage(img, 0, 0, full.width, full.height);
        heroUrl = full.toDataURL("image/webp", 0.8);
      }
      const theme = {
        id: data.customPrefix + Date.now().toString(36),
        name: name || "\\u6211\\u7684\\u56fe\\u7247",
        dataUrl: heroUrl,
        colors: extractPalette(sample),
      };
      saveCustoms([...existing, theme]);
      applyCustomTheme(theme);
      resolve(theme.colors);
    };
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = dataUrl;
  });

  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif";
  picker.style.display = "none";
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => importFromDataUrl(reader.result, file.name.replace(/\\.[a-z0-9]+$/i, ""))
      .catch((error) => alert("WorkBuddy Skin\\uff1a" + (error?.message ?? error)));
    reader.readAsDataURL(file);
    picker.value = "";
    panel.style.display = "none";
  });

  const uploadRow = row("\\uff0b \\u81ea\\u5b9a\\u4e49\\u56fe\\u7247", "rgba(36,201,215,.9)", () => picker.click());
  uploadRow.style.borderTop = "1px solid rgba(0,0,0,.08)";

  const native = row("\\u539f\\u751f\\u754c\\u9762", "rgba(0,0,0,.24)", () => { clearTheme(); panel.style.display = "none"; });
  rows.set(null, native);

  for (const saved of loadCustoms()) ensureCustomRow(saved);

  button.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  root.append(button, panel, picker);
  document.body.appendChild(root);
  if (data.activeId === null) clearTheme();
  else setTheme(data.activeId);

  // 供脚本化调用与测试：window.__workbuddySkin.importFromDataUrl(dataUrl, name)
  window.__workbuddySkin = { importFromDataUrl, setTheme, clearTheme, deleteCustom, listCustoms: loadCustoms };
  return true;
})()`;
}
