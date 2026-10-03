import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applySkin, ensureRendererVideos, removeSkin, uploadRendererVideo } from "../src/injector.mjs";

// 假 CDP Session：按表达式特征分流返回值，并记录完整调用序列
class FakeSession {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.calls = [];
    this.closed = false;
  }

  async open() {
    if (this.options.failOpen) throw new Error("connect refused");
  }

  close() {
    this.closed = true;
  }

  async evaluate(expression) {
    this.calls.push(expression);
    if (this.options.failEvaluate) throw new Error("renderer navigated");
    if (this.options.failVideo && expression.includes('objectStore("videos")')) throw new Error("video timed out");
    // rendererVideoSize：读 IndexedDB 里已存视频的字节数
    if (expression.includes('objectStore("videos").get(')) return this.options.storedSize ?? 0;
    // uploadRendererVideo 收尾：返回写入 Blob 的大小
    if (expression.includes("return blob.size")) return this.options.blobSize ?? 0;
    return true;
  }

  chunkPushes() {
    return this.calls.filter((call) => typeof call === "string" && call.includes("push(arr)")).length;
  }

  lastCall() {
    return this.calls.at(-1);
  }
}

// Session 工厂：收集实例，支持按 url 注入失败
function sessionFactory(options = {}, { failUrls = new Set() } = {}) {
  const sessions = [];
  class Session extends FakeSession {
    constructor(url) {
      super(url, failUrls.has(url) ? { failEvaluate: true } : options);
      sessions.push(this);
    }
  }
  return { Session, sessions };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wss-injector-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const target = (id) => ({ id, webSocketDebuggerUrl: `ws://127.0.0.1:9223/${id}` });

test("uploadRendererVideo：按 4MB 分块，写入大小一致后清理暂存", async () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 1); // 4MB + 1B → 2 块
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: bytes.length });
  await uploadRendererVideo(session, "demo", bytes);
  assert.equal(session.chunkPushes(), 2);
  assert.ok(session.lastCall().includes("delete window.__wbSkinVideoUpload"));
});

test("uploadRendererVideo：写入大小不符时抛错，且仍清理暂存", async () => {
  const bytes = Buffer.alloc(16, 1);
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: 8 });
  await assert.rejects(uploadRendererVideo(session, "demo", bytes), /大小不符/);
  assert.ok(session.lastCall().includes("delete window.__wbSkinVideoUpload"));
});

test("uploadRendererVideo：优先原生 Uint8Array.fromBase64，带 atob 回退与主线程让出", async () => {
  const bytes = Buffer.alloc(16, 1);
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: bytes.length });
  await uploadRendererVideo(session, "demo", bytes);
  const chunkCall = session.calls.find((call) => typeof call === "string" && call.includes("push(arr)"));
  assert.ok(chunkCall.includes("Uint8Array.fromBase64"));
  assert.ok(chunkCall.includes("atob("));
  assert.ok(chunkCall.includes("setTimeout(resolve, 0)"));
});

test("ensureRendererVideos：渲染进程已有同尺寸视频时跳过上传（stat 判重）", async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, "hero.mp4");
    await writeFile(videoPath, Buffer.alloc(1024, 7));
    const { Session, sessions } = sessionFactory({ storedSize: 1024 });
    const warnings = await ensureRendererVideos({
      targets: [target("t1")],
      Session,
      entries: [{ kind: "video", id: "demo", videoPath }],
    });
    assert.deepEqual(warnings, []);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].chunkPushes(), 0);
  });
});

test("ensureRendererVideos：尺寸不一致时执行分块上传", async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, "hero.mp4");
    await writeFile(videoPath, Buffer.alloc(1024, 7));
    const { Session, sessions } = sessionFactory({ storedSize: 0, blobSize: 1024 });
    const warnings = await ensureRendererVideos({
      targets: [target("t1")],
      Session,
      entries: [{ kind: "video", id: "demo", videoPath }],
    });
    assert.deepEqual(warnings, []);
    assert.equal(sessions[0].chunkPushes(), 1);
  });
});

test("ensureRendererVideos：单个 target 失败只记警告，不阻塞其余 target", async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, "hero.mp4");
    await writeFile(videoPath, Buffer.alloc(1024, 7));
    const { Session, sessions } = sessionFactory(
      { storedSize: 0, blobSize: 1024 },
      { failUrls: new Set(["ws://127.0.0.1:9223/t1"]) },
    );
    const warnings = await ensureRendererVideos({
      targets: [target("t1"), target("t2")],
      Session,
      entries: [{ kind: "video", id: "demo", videoPath }],
    });
    assert.equal(sessions.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /t1/);
    assert.match(warnings[0], /renderer navigated/);
    assert.equal(sessions[1].chunkPushes(), 1); // 第二个 target 正常上传
  });
});

test("ensureRendererVideos：本地视频文件缺失时降级为警告而非抛错", async () => {
  const { Session, sessions } = sessionFactory();
  const warnings = await ensureRendererVideos({
    targets: [target("t1")],
    Session,
    entries: [{ kind: "video", id: "demo", videoPath: join(tmpdir(), "wss-no-such-file.mp4") }],
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /读取内置视频文件失败/);
  assert.equal(sessions.length, 0);
});

test("ensureRendererVideos：无视频主题时不触碰任何 target", async () => {
  const { Session, sessions } = sessionFactory();
  const warnings = await ensureRendererVideos({
    targets: [target("t1")],
    Session,
    entries: [{ kind: "animated", id: "demo" }],
  });
  assert.deepEqual(warnings, []);
  assert.equal(sessions.length, 0);
});

// applySkin 的最小依赖：一个视频主题 + 一个图片主题，临时目录内真实文件
async function withThemes(fn) {
  return withTempDir(async (dir) => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(dir, "hero.png"), png);
    await writeFile(join(dir, "poster.png"), png);
    await writeFile(join(dir, "hero.mp4"), Buffer.alloc(1024, 7));
    const image = { manifest: { id: "img", name: "Img", colors: {} }, heroPath: join(dir, "hero.png"), posterPath: null };
    const video = { manifest: { id: "vid", name: "Vid", colors: {} }, heroPath: join(dir, "hero.mp4"), posterPath: join(dir, "poster.png") };
    return fn({ image, video });
  });
}

test("applySkin：每个 target 一条会话，视频预置与菜单注入复用同一连接", async () => {
  await withThemes(async ({ image, video }) => {
    const { Session, sessions } = sessionFactory({ storedSize: 1024 });
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1"), target("t2")] },
    });
    assert.equal(result.applied, 2);
    assert.deepEqual(result.menuThemes, ["img", "vid"]);
    assert.deepEqual(result.videoWarnings, []);
    assert.equal(sessions.length, 2);
    for (const session of sessions) {
      assert.ok(session.calls[0].includes('objectStore("videos").get('));
      assert.ok(session.lastCall().includes("__workbuddySkinTeardown"));
      assert.ok(session.closed);
    }
  });
});

test("applySkin：视频预置失败只记警告，换新连接后照常注入菜单", async () => {
  await withThemes(async ({ image, video }) => {
    let created = 0;
    const sessions = [];
    class Session extends FakeSession {
      constructor(url) {
        // 第一条连接视频阶段失败，其后的连接正常
        super(url, created++ === 0 ? { failVideo: true } : { storedSize: 1024 });
        sessions.push(this);
      }
    }
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    assert.equal(result.videoWarnings.length, 1);
    assert.match(result.videoWarnings[0], /video timed out/);
    assert.equal(sessions.length, 2);
    assert.ok(sessions[0].closed);
    assert.ok(sessions[1].lastCall().includes("__workbuddySkinTeardown"));
  });
});

test("removeSkin：先调菜单 teardown 再移除节点，并发处理所有 target", async () => {
  const { Session, sessions } = sessionFactory();
  const result = await removeSkin({
    port: 9223,
    deps: { Session, fetchRendererTargets: async () => [target("t1"), target("t2")] },
  });
  assert.deepEqual(result, { removed: 2 });
  for (const session of sessions) {
    const expression = session.lastCall();
    assert.ok(expression.indexOf("__workbuddySkinTeardown") < expression.indexOf(".remove()"));
  }
});
