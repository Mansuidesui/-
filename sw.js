// Service Worker - 缓存 game_logic.py + voice + pyodide 运行时 + 应用自身
// 让狼人杀 Web 版完全离线运行、可加到 iPad/iPhone 主屏

const CACHE_NAME = "werewolf-v2-5-20260921";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./icon-512.png",
  "./game_logic.py",
];

// 已知的 voice 文件清单（与 main.py ROLE_VOICE 对齐）
const VOICE_KEYS = [
  "night_fall", "day_break", "eyes_close", "hunter_ask",
  "guard_wake", "guard_act",
  "wolf_wake", "wolf_act",
  "witch_wake", "witch_act",
  "seer_wake", "seer_act",
  "halfblood_wake", "halfblood_act",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 应用核心 + game_logic + voice（pyodide 大文件走运行时缓存，避免首访双份下载）
    const voiceUrls = VOICE_KEYS.map(k => `./voice/${k}.mp3`);
    const allUrls = [...APP_SHELL, ...voiceUrls];
    await Promise.allSettled(allUrls.map(async u => {
      try { await cache.add(u); } catch (e) { console.warn("[sw] cache miss:", u, e.message); }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 同源资源（含 /pyodide/ 运行时与 /voice/ 语音）：
  // 缓存优先，未命中走网络并写入缓存；离线时兜底旧缓存
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const fetchAndUpdate = async () => {
        try {
          const resp = await fetch(req);
          if (resp && resp.ok && resp.type !== "opaque") cache.put(req, resp.clone());
          return resp;
        } catch (e) {
          return cached || new Response("offline", { status: 503 });
        }
      };
      if (cached) {
        fetchAndUpdate(); // 后台更新
        return cached;
      }
      return fetchAndUpdate();
    })());
  }
});

// 接收主线程的 SKIP_WAITING 触发
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
