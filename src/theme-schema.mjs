import { lstat, readFile, realpath } from "node:fs/promises";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { MAX_THEME_VIDEO_BYTES, THEME_SCHEMA_VERSION } from "./constants.mjs";

const COLOR_KEYS = ["accent", "secondary", "surface", "text"];
const COPY_KEYS = ["brand", "headline", "tagline"];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".avifs"]);
const VIDEO_EXTENSIONS = new Set([".mp4"]);
const HERO_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_COLORS = {
  accent: "#4BC2E0",
  secondary: "#AD7ED5",
  surface: "#FAFAFF",
  text: "#122C60",
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInside(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function normalizeMediaPath(value, label, extensions, types) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`theme ${label} must be a relative path inside the theme directory`);
  }
  if (!extensions.has(extname(value).toLowerCase())) {
    throw new Error(`theme ${label} must be ${types}`);
  }
  return value;
}

function normalizeHero(hero) {
  return normalizeMediaPath(hero, "hero", HERO_EXTENSIONS, "PNG, JPEG, WebP, GIF, AVIF, or MP4");
}

// 视频主题（hero 为 MP4）必须配 poster 海报帧图片：作 CSS 底图兜底，
// 视频异步挂载/解码失败时不至于裸奔；图片 hero 不允许带 poster
function normalizePoster(poster, hero) {
  const isVideo = VIDEO_EXTENSIONS.has(extname(hero).toLowerCase());
  if (!isVideo) {
    if (poster !== undefined) throw new Error("theme poster is only valid for video heroes");
    return null;
  }
  if (poster === undefined) throw new Error("video hero requires a poster image");
  return normalizeMediaPath(poster, "poster", IMAGE_EXTENSIONS, "PNG, JPEG, WebP, GIF, or AVIF");
}

function normalizeColors(colors) {
  if (colors != null && !isRecord(colors)) {
    throw new Error("theme colors must be an object");
  }
  return Object.fromEntries(
    COLOR_KEYS.map((key) => {
      const configured = colors?.[key];
      const value = configured === undefined ? DEFAULT_COLORS[key] : configured;
      if (typeof value !== "string" || !HEX_COLOR.test(value)) {
        throw new Error(`${key} must be a six-digit hex color`);
      }
      return [key, value.toUpperCase()];
    }),
  );
}

function normalizeCopy(copy) {
  if (copy == null) return null;
  if (!isRecord(copy)) {
    throw new Error("theme copy must be null or an object");
  }

  return Object.fromEntries(
    COPY_KEYS.filter((key) => copy[key] !== undefined).map((key) => {
      if (typeof copy[key] !== "string") {
        throw new Error(`copy.${key} must be a string`);
      }
      return [key, copy[key]];
    }),
  );
}

export function validateThemeManifest(input) {
  if (!isRecord(input)) {
    throw new Error("theme manifest must be an object");
  }
  if (input.schemaVersion !== THEME_SCHEMA_VERSION) {
    throw new Error(`unsupported theme schema ${input.schemaVersion}`);
  }
  if (typeof input.id !== "string" || !THEME_ID.test(input.id)) {
    throw new Error("theme id must use lowercase letters, numbers, and hyphens");
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("theme name must be a non-empty string");
  }

  const hero = normalizeHero(input.hero);
  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: input.id,
    name: input.name.trim(),
    hero,
    poster: normalizePoster(input.poster, hero),
    colors: normalizeColors(input.colors),
    copy: normalizeCopy(input.copy),
  };
}

async function resolveMediaFile(root, mediaPath, label) {
  const filePath = resolve(root, mediaPath);
  if (!isInside(root, filePath)) {
    throw new Error(`theme ${label} escapes the theme directory`);
  }

  const [realRoot, realFilePath] = await Promise.all([
    realpath(root),
    realpath(filePath),
  ]);
  if (!isInside(realRoot, realFilePath)) {
    throw new Error(`theme ${label} escapes the theme directory`);
  }

  const info = await lstat(filePath);
  if (!info.isFile() || info.size < 1) {
    throw new Error(`theme ${label} must be a non-empty file`);
  }
  return { path: filePath, size: info.size };
}

export async function loadTheme(themeDir) {
  const root = resolve(themeDir);
  const raw = JSON.parse(await readFile(join(root, "theme.json"), "utf8"));
  const manifest = validateThemeManifest(raw);

  const hero = await resolveMediaFile(root, manifest.hero, "hero");
  if (VIDEO_EXTENSIONS.has(extname(manifest.hero).toLowerCase()) && hero.size > MAX_THEME_VIDEO_BYTES) {
    throw new Error(
      `theme hero video exceeds the ${MAX_THEME_VIDEO_BYTES / 1024 / 1024}MB limit`,
    );
  }
  const poster = manifest.poster
    ? await resolveMediaFile(root, manifest.poster, "poster")
    : null;

  return { manifest, heroPath: hero.path, posterPath: poster?.path ?? null, root };
}
