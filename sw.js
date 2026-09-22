// Service Worker - 缓存 game_logic.py + voice + pyodide 运行时 + 应用自身
// 让狼人杀 Web 版完全离线运行、可加到 iPad/iPhone 主屏

const CACHE_NAME = "werewolf-v2-8-20260922";
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

// 必须 network-first 的关键小文件：页面、SW、游戏逻辑、应用代码。
// pyodide 运行时(13MB)不在这里——它稳定不变，走缓存优先+后台更新，省流量、可离线。
function isFreshCritical(url, req) {
  if (req.mode === "navigate") return true;
  const p = url.pathname;
  return p.endsWith("/sw.js")
      || p.endsWith("game_logic.py")
      || p.endsWith("app.js")
      || p.endsWith("styles.css")
      || p.endsWith("index.html");
}
// 带 ?b= / ?fresh= 的请求一律穿透，不读不写缓存（清缓存重试场景）
function isBust(url) {
  return url.searchParams.has("b") || url.searchParams.has("fresh");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    // 1) 穿透请求：只走网络，成功后更新缓存
    if (isBust(url)) {
      try {
        const resp = await fetch(req);
        if (resp && resp.ok && resp.type !== "opaque") cache.put(req, resp.clone());
        return resp;
      } catch (e) {
        return cached || new Response("offline", { status: 503 });
      }
    }

    // 2) 关键资源 network-first：8 秒拿不到才回退缓存（离线可用）
    if (isFreshCritical(url, req)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const resp = await fetch(req, { signal: ctrl.signal });
        clearTimeout(timer);
        if (resp && resp.ok && resp.type !== "opaque") {
          cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
      } catch (e) {
        clearTimeout(timer);
        if (cached) return cached;  // 离线/超时：用上次完整缓存
        return new Response("offline", { status: 503 });
      }
    }

    // 3) 语音等静态资源：缓存优先 + 后台更新
    if (cached) {
      fetch(req).then(r => {
        if (r && r.ok && r.type !== "opaque") cache.put(req, r.clone());
      }).catch(() => {});
      return cached;
    }
    try {
      const resp = await fetch(req);
      if (resp && resp.ok && resp.type !== "opaque") cache.put(req, resp.clone());
      return resp;
    } catch (e) {
      return new Response("offline", { status: 503 });
    }
  })());
});

// 接收主线程的 SKIP_WAITING 触发
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
