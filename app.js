// 狼人杀小助手 Web UI - 主应用逻辑
// 调用 Pyodide 跑 game_logic.py，UI 完全用原生 JS 渲染。

"use strict";

// ========== 环境兼容 ==========
const IS_WECHAT = /MicroMessenger/i.test(navigator.userAgent);
// 旧内核(X5/老 WebView)缺少 Object.fromEntries(ES2019)，补一个最小实现，
// 否则 PyProxy.toJs(dict_converter) 会 TypeError 中断游戏
if (typeof Object.fromEntries !== "function") {
  Object.fromEntries = function (entries) {
    const obj = {};
    entries.forEach(function (kv) { obj[kv[0]] = kv[1]; });
    return obj;
  };
}

// ========== 常量（与 game_logic.py 对齐）==========
const ROLE_UI = {
  werewolf:  { icon:"狼", name:"狼人",   camp:"狼人阵营",     color:"#D94B4B", skill:"夜晚与狼同伴共同选择一名玩家击杀" },
  villager:   { icon:"民", name:"村民",   camp:"好人阵营",     color:"#8A93A6", skill:"没有特殊技能，靠讨论与投票找出狼人" },
  seer:       { icon:"验", name:"预言家", camp:"神职 · 好人",  color:"#D8B55A", skill:"每晚查验一名玩家，得知其是好人还是狼人" },
  witch:      { icon:"药", name:"女巫",   camp:"神职 · 好人",  color:"#D8B55A", skill:"一瓶解药、一瓶毒药(8人以下只有解药)，两药同晚只能用一瓶，每瓶全程仅一次" },
  guard:      { icon:"守", name:"守卫",   camp:"神职 · 好人",  color:"#D8B55A", skill:"每晚守护一人免于狼刀，不能连守同一人" },
  hunter:     { icon:"枪", name:"猎人",   camp:"神职 · 好人",  color:"#D8B55A", skill:"出局时可开枪带走一人，被毒杀时不能开枪" },
  halfblood:  { icon:"混", name:"混血儿", camp:"跟随榜样阵营", color:"#9B6BD4", skill:"首夜选一名玩家为榜样，不知其身份；榜样属哪方你就与哪方共胜负，被查验时显示好人" },
};
const ROLE_VOICE = { guard:"guard", werewolf:"wolf", witch:"witch", seer:"seer", halfblood:"halfblood" };
const CAUSE_NAME = { wolf:"被狼人杀害", poison:"被女巫毒死", vote:"被投票出局", shoot:"被猎人开枪带走", manual:"被主持人手动出局" };
const BOARDS = {
  6:  ["werewolf","werewolf","villager","villager","villager","seer"],
  7:  ["werewolf","werewolf","villager","villager","villager","villager","seer"],
  8:  ["werewolf","werewolf","werewolf","villager","villager","villager","villager","seer"],
  9:  ["werewolf","werewolf","werewolf","villager","villager","villager","seer","witch","hunter"],
  10: ["werewolf","werewolf","werewolf","villager","villager","villager","villager","seer","witch","hunter"],
  11: ["werewolf","werewolf","werewolf","werewolf","villager","villager","villager","villager","seer","witch","hunter"],
  12: ["werewolf","werewolf","werewolf","werewolf","villager","villager","villager","villager","seer","witch","hunter","guard"],
};
const ROLE_LIMITS = {
  werewolf:[1,8], villager:[0,15], seer:[0,1], witch:[0,1], guard:[0,1], hunter:[0,1], halfblood:[0,1],
};
const ROLE_ORDER = ["werewolf","villager","seer","witch","guard","hunter","halfblood"];
const APP_VERSION = "V2.6";

// 本机存档/历史（localStorage）：30 分钟内可继续对局，历史保留最近 10 局
const LS_SAVE = "wolf_save_v1";
const LS_HISTORY = "wolf_history_v1";
const LS_TTS = "wolf_tts_v1";
const LS_TTS_SERVER = "wolf_tts_server_v1";  // 局域网克隆语音合成服务器
const LS_TTS_VOICE = "wolf_tts_voice_v1";    // 手动选择的系统音色 voiceURI
const RESUME_WINDOW_MS = 30 * 60 * 1000;
const HISTORY_KEEP = 10;

// 同源托管的 Pyodide 目录（GitHub Pages 部署在 /-/ 子路径下，必须用相对当前页面的 ./）
const PYODIDE_BASE = "./pyodide/";
// 运行时生成 0.1 秒静音 WAV（iOS 音频解锁用，无需外部文件）
function silentWavDataUri() {
  const rate = 8000, n = Math.floor(rate * 0.1);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, n * 2, true);
  const bytes = new Uint8Array(buf);
  let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(bin);
}

// ========== 顶层状态 ==========
const App = {
  pyodide: null,
  state: null,      // PyProxy to Python state object
  flow: null,       // PyProxy to NightFlow
  mod_mode: false,
  screen: "setup",  // setup/deal/night/day/over
  audioVoice: null,
  audioUnlocked: false,
  voiceTimers: [],
  // 夜晚播报去重键（state 对象 + day number）
  nightEnteredKey: null,
  // end 阶段计划播 day_break 的时间戳
  dayBreakAt: 0,
  // 已播过 act 音频的夜晚阶段游标（防止重渲染重复播）
  actCursor: -1,
  // 两步确认：scene=night/dayShoot/dayExile，seat=当前高亮目标
  pending: { scene: null, seat: null },
  // 退出按钮双击确认
  quitBtnText: "退出游戏",
  quitResetTimer: null,
  // 设置屏的本地 UI 状态（不进 Python）
  setup: {
    preset: 9,        // 6..12 或 0 表示自定义
    counts: { werewolf:3, villager:3, seer:1, witch:1, guard:0, hunter:1, halfblood:0 },
    winRule: "bian",
    modMode: false,
    names: [],       // 玩家昵称数组
  },
  // 发牌屏状态
  deal: { idx: 0, revealed: false },
  // 白天屏状态
  day: { shootQueue: [], shootContext: "", exiledSeat: null, kickMode: false },
  // 首页的历史对局视图：null | {type:"list"} | {type:"detail", item}
  historyView: null,
  // 天亮死亡系统语音朗读（浏览器 speechSynthesis）
  ttsEnabled: false,
  ttsUnlocked: false,
  ttsServer: "",  // 局域网 GPT-SoVITS 合成服务器(念玩家名字)
  ttsVoiceURI: "",  // 手动选择的系统音色(空=自动选女声)
};

// ========== DOM 引用 ==========
const $app = document.getElementById("app");
const $quit = document.getElementById("quit-btn");
const $modBtn = document.getElementById("mod-btn");
const $modOverlay = document.getElementById("mod-overlay");
const $modList = document.getElementById("mod-list");
const $loading = document.getElementById("loading");
const $loadingText = document.getElementById("loading-text");
const $confirmOverlay = document.getElementById("confirm-overlay");
const $confirmText = document.getElementById("confirm-text");
const $confirmOk = document.getElementById("confirm-ok");
const $confirmCancel = document.getElementById("confirm-cancel");

// ========== 通用确认弹窗 ==========
let _confirmCallback = null;
function showConfirm(text, onOk) {
  $confirmText.textContent = text;
  _confirmCallback = onOk;
  $confirmOverlay.classList.add("show");
}
function hideConfirm() {
  $confirmOverlay.classList.remove("show");
  _confirmCallback = null;
}
$confirmOk.addEventListener("click", () => {
  const cb = _confirmCallback;
  hideConfirm();
  if (cb) cb();
});
$confirmCancel.addEventListener("click", hideConfirm);
$confirmOverlay.addEventListener("click", (ev) => { if (ev.target === $confirmOverlay) hideConfirm(); });

// ========== Pyodide 桥（同源自托管，不依赖任何第三方 CDN）==========
function loadPyodideScript() {
  return new Promise((resolve, reject) => {
    if (window.loadPyodide) return resolve();
    const s = document.createElement("script");
    s.src = PYODIDE_BASE + "pyodide.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("运行环境脚本(pyodide.js)加载失败"));
    document.head.appendChild(s);
  });
}

async function initPyodide() {
  setLoadingText("正在加载运行环境（约 14MB，首次稍候）...");
  await loadPyodideScript();
  App.pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });
  console.log("[py] pyodide loaded:", App.pyodide.runPython("import sys; sys.version"));

  setLoadingText("正在加载游戏逻辑 ...");
  const resp = await fetch("./game_logic.py");
  if (!resp.ok) throw new Error("fetch game_logic.py 失败：" + resp.status);
  const src = await resp.text();
  App.pyodide.FS.writeFile("game_logic.py", src);
  App.pyodide.runPython(`
import game_logic as gl
print("[py] game_logic loaded")
`);
  hideLoading();
}

function setLoadingText(t) { $loadingText.textContent = t; }
function hideLoading() { $loading.style.display = "none"; }
function showLoading(t="加载中...") {
  $loadingText.textContent = t;
  $loading.style.display = "flex";
}

// runPython 简写
function py(code) { return App.pyodide.runPython(code); }
// 把 Python 单值取为 JS
function pyVal(code) { return App.pyodide.runPython(code); }
// 取 Python 对象的属性为 JS 值（避免 PyProxy 泄漏）
function pyAttr(obj, attr) {
  return App.pyodide.runPython(`repr(${obj}.${attr})`);
}

// ========== 音频模块（兼容 iOS Safari：手势解锁 + load() 重置）==========
function playVoice(key, delay = 0) {
  clearVoiceTimers();
  if (!App.audioVoice) App.audioVoice = document.getElementById("voice");
  const run = () => {
    const a = App.audioVoice;
    a.src = `./voice/${key}.mp3`;
    // iOS 上换 src 后必须 load()，否则 play() 可能仍播旧源或被拒
    try { a.load(); } catch (e) {}
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  };
  if (delay > 0) {
    const id = setTimeout(run, delay * 1000);
    App.voiceTimers.push(id);
  } else {
    run();
  }
}
function clearVoiceTimers() {
  App.voiceTimers.forEach(clearTimeout);
  App.voiceTimers = [];
}

// ========== 系统语音朗读（天亮死亡播报）==========
// 安卓浏览器（Chrome/小米/系统浏览器）用克隆音频拼接；
// iOS Safari / 电脑 Chrome 用浏览器系统 TTS。
function isAndroidBrowser() {
  return /Android/i.test(navigator.userAgent);
}
function useClipsAudio() {
  // 安卓浏览器走拼接音频（不依赖系统 TTS 引擎）
  return isAndroidBrowser();
}
function ttsAvailable() {
  // 安卓总是可用（拼接音频）；其他平台需要 speechSynthesis
  return useClipsAudio() || (("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window));
}
function ttsSupported() {
  return ttsAvailable();
}

// 克隆音频拼接播放（安卓浏览器专用）
const TTS_CLIP_DIR = "./voice/tts/";
let _ttsClipQueue = [];
let _ttsClipIdx = 0;
const _ttsClipCache = {};   // 预加载的 Audio 对象，避免顺序加载延迟
let _ttsClipTimer = null;

// V2.4：短文本经 GPT-SoVITS 合成偶发哑火，改为每名死者一句完整句
// tts_<wolf|poison|shoot>_<座位号>，不再拼接单字片段
const TTS_CLIP_NAMES = ["tts_night", "tts_safe_night"];
["wolf", "poison", "shoot"].forEach(function (c) {
  for (let i = 1; i <= 15; i++) TTS_CLIP_NAMES.push("tts_" + c + "_" + i);
});

function _getClipAudio(name) {
  if (!_ttsClipCache[name]) {
    const a = new Audio(TTS_CLIP_DIR + name + ".wav");
    a.preload = "auto";
    _ttsClipCache[name] = a;
  }
  return _ttsClipCache[name];
}

function preloadTTSClips() {
  TTS_CLIP_NAMES.forEach(n => _getClipAudio(n));
}

function playTTSClip(name) {
  const a = _getClipAudio(name);
  try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) {}
}

// 夜晚死因 → 完整句音频前缀
const CAUSE_CLIP_PREFIX = { wolf: "wolf", poison: "poison", shoot: "shoot" };

async function announceDeathsByClips(deaths) {
  _ttsClipQueue = [];
  if (!deaths || !deaths.length) {
    _ttsClipQueue.push("clip:tts_safe_night");
  } else {
    _ttsClipQueue.push("clip:tts_night");
    // 座位号 → 昵称（用于插队合成含名字整句）
    let nameBySeat = {};
    try { nameBySeat = Object.fromEntries(getPlayers().map(p => [p.seat, p.name])); } catch (e) {}
    for (const [seat, cause] of deaths) {
      const prefix = CAUSE_CLIP_PREFIX[cause] || "wolf";
      const key = namedClipKey(prefix, seat);
      let useNamed = !!TTS_NAMED.map[key];
      if (!useNamed && useClipsAudio() && App.ttsEnabled && TTS_NAMED.server) {
        // 后台还没合到这句：插队优先合成，最多等 25 秒，期间顶部有提示
        useNamed = await ensureDeathClip(prefix, seat, nameBySeat[seat], 25000);
      }
      // V2.6：优先播含名字的整句(实时合成)，没有则回退内置无名字片段
      _ttsClipQueue.push(useNamed
        ? "dyn:" + key : "clip:tts_" + prefix + "_" + seat);
    }
  }
  _ttsClipIdx = 0;
  _playNextClip();
}

function _playNextClip() {
  if (_ttsClipIdx >= _ttsClipQueue.length) return;
  const item = _ttsClipQueue[_ttsClipIdx];
  const colon = item.indexOf(":");
  const kind = item.slice(0, colon);
  const name = item.slice(colon + 1);
  const a = kind === "dyn" ? _getDynAudio(name) : _getClipAudio(name);
  let done = false;

  const goNext = (gap) => {
    if (done) return;
    done = true;
    clearTimeout(_ttsClipTimer);
    a.removeEventListener("ended", onEnded);
    setTimeout(() => { _ttsClipIdx++; _playNextClip(); }, gap);
  };
  // 队列里每句都是完整句：前缀句后短停顿，每名死者句子后停顿稍长
  const onEnded = () => goNext(name === "tts_night" ? 120 : 320);

  a.addEventListener("ended", onEnded, { once: true });
  a.addEventListener("error", () => goNext(60), { once: true });
  // 兜底：ended 未触发(部分安卓内核)时按时长推进
  const dur = (isFinite(a.duration) && a.duration > 0) ? a.duration : 3;
  _ttsClipTimer = setTimeout(() => goNext(60), dur * 1000 + 800);
  try {
    a.currentTime = 0;
    a.play().catch(() => goNext(60));
  } catch (e) { goNext(60); }
}

// ========== V2.6：名字整句实时合成(局域网 GPT-SoVITS，仅安卓浏览器) ==========
const CAUSE_SENTENCE = {
  wolf: "遭到狼人强奸",
  poison: "遭到女巫毒杀",
  shoot: "被猎人射杀",
};
// 单一串行合成器：所有请求(后台预热 + 天亮死者插队)共用一个队列，
// 保证同一时刻只有一个请求在飞(GPU 单 worker，并发会拖慢/报错)。
const TTS_NAMED = {
  map: {},        // key -> 可播放的 objectURL
  queue: [],      // [{key,text}]，队首优先
  known: {},      // key -> true（已入队过，避免重复）
  waiters: {},    // key -> [resolve,...]
  total: 0, done: 0,
  running: false,
  server: "",
  ctxBox: { ctx: null },
};

function namedClipKey(cause, seat) { return cause + "_" + seat; }
function namedClipText(cause, seat, name) {
  return seat + "号" + (name || "") + "，" + (CAUSE_SENTENCE[cause] || CAUSE_SENTENCE.wolf);
}

function _getDynAudio(key) {
  let a = _ttsClipCache["dyn:" + key];
  if (!a) {
    a = new Audio(TTS_NAMED.map[key]);
    a.preload = "auto";
    _ttsClipCache["dyn:" + key] = a;
  }
  return a;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 合成进度浮层（顶部细条，明确告诉用户没卡、且不影响游戏）
function _progEl() {
  let el = document.getElementById("tts-prog");
  if (!el) {
    el = document.createElement("div");
    el.id = "tts-prog";
    el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;" +
      "background:rgba(20,22,30,.94);color:#FFC24B;font-size:12px;line-height:1.4;" +
      "padding:7px 12px;border-bottom:1px solid #3A3F4D;text-align:center;" +
      "font-family:inherit;box-shadow:0 2px 10px rgba(0,0,0,.4)";
    document.body.appendChild(el);
  }
  return el;
}
function _hideProgSoon() {
  setTimeout(() => {
    const el = document.getElementById("tts-prog");
    if (el && TTS_NAMED.queue.length === 0) el.remove();
  }, 1200);
}
function _renderProg(extra) {
  const t = TTS_NAMED;
  if (!t.total) return;
  const el = _progEl();
  const pct = Math.min(100, Math.round(t.done * 100 / t.total));
  el.innerHTML = "克隆语音准备中 " + t.done + "/" + t.total + "（" + pct + "%）" +
    (extra ? " · " + extra : "") +
    "<br><span style='color:#9aa0ad'>后台进行，不影响发牌和游戏，可直接开始</span>";
}

// 合成结果哑火校验：解码后测音量，异常时放行交给播放兜底
async function _namedClipAudible(buf, ctxBox) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return true;
    if (!ctxBox.ctx) ctxBox.ctx = new Ctx();
    const audio = await ctxBox.ctx.decodeAudioData(buf.slice(0));
    const ch = audio.getChannelData(0);
    let sum = 0, n = 0;
    for (let i = 0; i < ch.length; i += 8) { sum += ch[i] * ch[i]; n++; }
    const rms = Math.sqrt(sum / Math.max(1, n));
    return rms > 0.01 && audio.duration > 1.0;
  } catch (e) {
    return true;
  }
}

// 真正发一次合成请求（失败换 seed 重试），成功写入 map，返回 bool
async function _fetchNamedClip(server, text, key) {
  for (const seed of [101, 202, 303]) {
    const qs = new URLSearchParams({
      text, text_lang: "zh", media_type: "wav",
      text_split_method: "cut0", seed: String(seed),
      ref_audio_path: "D:\\GPT-SoVITS\\xjx10s.mp3",
      prompt_text: "以前遇到棘手的案子，是因为线索太少。比如残缺的指纹与鞋印，模糊不清的监控等等",
      prompt_lang: "zh",
    }).toString();
    try {
      const r = await fetch(server + "/tts?" + qs, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 5000) throw new Error("tiny");
      if (await _namedClipAudible(buf, TTS_NAMED.ctxBox)) {
        // 同一 key 旧的 Audio 对象要清掉，让播放器拿到新 URL
        delete _ttsClipCache["dyn:" + key];
        TTS_NAMED.map[key] = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        return true;
      }
    } catch (e) { /* mixed content 拦截/超时/哑火 → 换 seed 重试 */ }
    await sleep(300);
  }
  return false;
}

function _notifyDone(key) {
  const ws = TTS_NAMED.waiters[key];
  if (ws) { ws.forEach(fn => fn(!!TTS_NAMED.map[key])); delete TTS_NAMED.waiters[key]; }
}

// 把一句排进队列；front=true 插队（天亮死者用）。返回该句完成 Promise
function _enqueue(key, text, front) {
  if (TTS_NAMED.map[key]) return Promise.resolve(true);
  if (!TTS_NAMED.known[key]) {
    TTS_NAMED.known[key] = true;
    const item = { key, text };
    if (front) TTS_NAMED.queue.unshift(item);
    else TTS_NAMED.queue.push(item);
    TTS_NAMED.total++;
  } else if (front) {
    // 已在后台队列里但还没轮到：提到队首（跳过正在合成的那句）
    const i = TTS_NAMED.queue.findIndex(q => q.key === key);
    if (i > 0) TTS_NAMED.queue.unshift(TTS_NAMED.queue.splice(i, 1)[0]);
  }
  _runWorker();
  return new Promise(resolve => {
    (TTS_NAMED.waiters[key] = TTS_NAMED.waiters[key] || []).push(resolve);
  });
}

// 唯一的串行合成循环
async function _runWorker() {
  if (TTS_NAMED.running) return;
  TTS_NAMED.running = true;
  try {
    while (TTS_NAMED.queue.length) {
      const { key, text } = TTS_NAMED.queue.shift();
      if (!TTS_NAMED.map[key]) {
        await _fetchNamedClip(TTS_NAMED.server, text, key);
      }
      TTS_NAMED.done++;
      _notifyDone(key);
      _renderProg();
      await sleep(200);
    }
    _hideProgSoon();
  } finally {
    TTS_NAMED.running = false;
  }
}

async function ensureNamedClips() {
  // 安卓浏览器 + 朗读开 + 配了服务器才合成；页面刷新后重新合成
  if (!useClipsAudio() || !App.ttsEnabled) return;
  const server = (App.ttsServer || "").replace(/\/+$/, "");
  if (!server || !/^https?:\/\//i.test(server)) return;
  const players = getPlayers();
  if (!players || !players.length) return;
  TTS_NAMED.server = server;
  // 后台预热：每个玩家 × 三种死因全部排到队尾（不阻塞游戏）
  for (const p of players) {
    for (const cause of Object.keys(CAUSE_SENTENCE)) {
      const key = namedClipKey(cause, p.seat);
      _enqueue(key, namedClipText(cause, p.seat, p.name), false);
    }
  }
  _renderProg();
}

// 天亮播报前调用：确保死者句子就绪（插队优先），限时等待；超时返回 false 走无名字兜底
async function ensureDeathClip(cause, seat, name, timeoutMs) {
  const key = namedClipKey(cause, seat);
  if (TTS_NAMED.map[key]) return true;
  if (!TTS_NAMED.server) return false;
  let timer = null;
  const timeout = new Promise(res => { timer = setTimeout(() => res(false), timeoutMs); });
  const done = _enqueue(key, namedClipText(cause, seat, name), true);
  _renderProg("正在优先准备 " + seat + "号 语音…");
  const ok = await Promise.race([done, timeout]);
  clearTimeout(timer);
  return ok === true;
}
// 中文音色缓存（Safari 的 getVoices 初始为空，voiceschanged 后才有）
function refreshVoices() {
  if (!ttsSupported()) return;
  const voices = window.speechSynthesis.getVoices() || [];
  App.zhVoices = voices.filter(v => /^zh|cmn/i.test(v.lang));
}
// 选中文女声：iOS 上 zh-CN 同时存在男声 Li-mu 和女声 Ting-Ting/Tian-Tian，
// 顺序取第一个可能取到男声，必须按女声名字优先。
// iOS 系统更新后默认引擎可能变成新男声(Siri/新语音包)，
// 所以女声白名单从宽、男声黑名单从宽，最后 pitch 兜底减轻男声感。
function pickZhVoice() {
  if (!App.zhVoices || !App.zhVoices.length) refreshVoices();
  const list = App.zhVoices || [];
  if (!list.length) return null;
  // 0) 手动选择的音色最优先（首页"语音"下拉，存 localStorage）
  if (App.ttsVoiceURI) {
    const picked = list.find(v => v.voiceURI === App.ttsVoiceURI);
    if (picked) return picked;
  }
  // 女声白名单：大陆 Ting-Ting/Tian-Tian，台湾 Mei-Jia，香港 Sin-ji
  const female = /ting[-_ ]?ting|tian[-_ ]?tian|mei[-_ ]?jia|sin[-_ ]?ji|female|女声?$/i;
  // 男声黑名单：旧男声 Li-mu + iOS 新增常见男声拼音名 + Siri(名字分不出男女，降级处理)
  const male = /li[-_ ]?mu|yun[-_ ]?(yang|yi|hui|kang|xiang|ye)|zhi[-_ ]?wei|jian[-_ ]?wei|hui[-_ ]?hui|siri|male|男/i;
  // 1) 普通话女声白名单
  const cn = list.filter(v => /zh[-_]?(CN|Hans)/i.test(v.lang));
  let v = cn.find(x => female.test(x.name) && !male.test(x.name));
  if (v) return v;
  // 2) 任意中文女声白名单（港 Sin-ji / 台 Mei-Jia 等）
  v = list.find(x => female.test(x.name) && !male.test(x.name));
  if (v) return v;
  // 3) 普通话里避开已知男声/Siri
  v = cn.find(x => !male.test(x.name));
  if (v) return v;
  // 4) 任意中文里避开已知男声/Siri
  v = list.find(x => !male.test(x.name));
  if (v) return v;
  return list[0];
}
function speakText(text, _retry) {
  if (!App.ttsEnabled || !text || !ttsSupported()) return;
  // Safari 音色列表尚未加载：等它加载好(最多 1 秒)再朗读，否则会用默认男声
  const zh = pickZhVoice();
  if (!zh && !_retry) {
    let done = false;
    const go = () => { if (!done) { done = true; speakText(text, true); } };
    try { window.speechSynthesis.addEventListener("voiceschanged", go); } catch (e) {}
    setTimeout(go, 600);
    return;
  }
  try {
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 1.0;
    // 选中的不是已知女声(如只剩 Siri/男声)时抬高音调减轻男声感；
    // 用户手动选的音色按原声播(尊重选择，不再强改音调)
    const manual = !!(zh && App.ttsVoiceURI && zh.voiceURI === App.ttsVoiceURI);
    const isFemale = zh && /ting[-_ ]?ting|tian[-_ ]?tian|mei[-_ ]?jia|sin[-_ ]?ji|female|女/i.test(zh.name);
    u.pitch = (manual || isFemale) ? 1.0 : 1.15;
    u.volume = 1.0;
    if (zh) u.voice = zh;
    // 不在 speak 前 cancel：iOS 上 cancel+speak 竞态会吞掉整句；
    // resume 兜底 iOS 偶发的「卡在 paused 状态」
    synth.resume();
    synth.speak(u);
  } catch (e) { console.warn("TTS failed:", e); }
}
// Safari 语音列表异步加载，加载后立即缓存；若正停在首页则重渲染出音色下拉
if (ttsSupported()) {
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    refreshVoices();
    if (App.screen === "setup" && !App.historyView) {
      try { renderSetup(); } catch (e) {}
    }
  };
}

// ========== 工具：HTML 转义 + 玩家信息 ==========
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 从 Python state 读取玩家数组 → JS 数组
function getPlayers() {
  // 返回 [{seat, name, role, alive, death_cause}, ...]
  return App.pyodide.runPython(`
import json
def _p(p):
    return {"seat": p.seat, "name": p.name, "role": p.role,
            "alive": p.alive, "death_cause": p.death_cause}
[ _p(p) for p in state.players ]
`).toJs();
}

function getAlivePlayers() {
  return getPlayers().filter(p => p.alive);
}

// 通用：渲染一个目标网格（点格=选中高亮，再点底部确认按钮提交，防误触）
function renderTargetGrid(choices, chooseAction, disabledSet = new Set(), wolfMates = new Set(), selectedSeat = null) {
  const cells = choices.map(p => {
    const dis = disabledSet.has(p.seat) ? "disabled" : "";
    const mate = wolfMates.has(p.seat) ? "wolf-mate" : "";
    const sel = (p.seat === selectedSeat) ? "selected" : "";
    return `<button type="button" class="target-cell ${mate} ${sel}" data-action="${chooseAction}" data-seat="${p.seat}" ${dis}>
      <span class="seat">${p.seat}号</span>
      <span class="name">${esc(p.name)}</span>
    </button>`;
  }).join("");
  return `<div class="target-grid">${cells}</div>`;
}

// 底部确认条：选中目标后出现
function renderConfirmBar(confirmAction, seat, name) {
  return `<div class="confirm-bar">
    <span class="picked">已选 ${seat}号 ${esc(name)}</span>
    <button type="button" class="btn amber lg" data-action="${confirmAction}">确认选择</button>
  </div>`;
}

// ========== 本机存档 / 历史对局 ==========
function saveGame(screen) {
  try {
    const token = App.pyodide.runPython(
      "gl.snapshot_game(state, globals().get('flow')) "
      + "if globals().get('state') is not None else ''");
    if (!token) return;
    const day = App.pyodide.runPython("state.day");
    localStorage.setItem(LS_SAVE, JSON.stringify({
      token, screen, day,
      dealIdx: App.deal ? App.deal.idx : 0,
      modMode: !!App.mod_mode,
      ts: Date.now(),
    }));
  } catch (e) { console.warn("save game failed:", e); }
}
function clearSave() {
  try { localStorage.removeItem(LS_SAVE); } catch (e) {}
}
function loadSave() {
  try {
    const raw = localStorage.getItem(LS_SAVE);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (Date.now() - (d.ts || 0) > RESUME_WINDOW_MS) {
      clearSave();
      return null;
    }
    return d;
  } catch (e) { return null; }
}
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function recordHistory() {
  try {
    const summary = JSON.parse(App.pyodide.runPython(
      "import json; json.dumps(gl.game_summary(state))"));
    summary.ts = Date.now();
    const h = loadHistory();
    h.push(summary);
    localStorage.setItem(LS_HISTORY, JSON.stringify(h.slice(-HISTORY_KEEP)));
  } catch (e) { console.warn("record history failed:", e); }
}
function resumeGame() {
  const d = loadSave();
  if (!d) { App.historyView = null; renderSetup(); return; }
  App.pyodide.globals.set("_save_token", d.token);
  App.pyodide.runPython("state, flow = gl.restore_game(_save_token)");
  App.state = App.pyodide.globals.get("state");
  App.flow = App.pyodide.globals.get("flow");
  App.mod_mode = !!d.modMode;
  App.actCursor = -1;
  App.pending = { scene: null, seat: null };
  App.historyView = null;
  if (d.screen === "deal") {
    App.deal = { idx: d.dealIdx || 0, revealed: false };
    setScreen("deal");
  } else if (d.screen === "day") {
    // 白天恢复到当天起点：重新公布死亡后继续投票
    App.day = { shootQueue: [], shootContext: "", exiledSeat: null, kickMode: false };
    setScreen("day");
  } else {
    // 恢复夜晚：直接停在退出时的阶段，不重播天黑语音
    App.nightEnteredKey = App.pyodide.runPython("state.day");
    setScreen("night");
  }
}
function discardSave() {
  clearSave();
  App.historyView = null;
  renderSetup();
}

// ========== 屏幕调度 ==========
function setScreen(name) {
  App.screen = name;
  App.pending = { scene: null, seat: null };
  App.quitBtnText = "退出游戏";
  if (App.quitResetTimer) { clearTimeout(App.quitResetTimer); App.quitResetTimer = null; }
  // 首页不显示退出/身份按钮，其它屏都显示；身份按钮仅主持人模式
  $quit.classList.toggle("show", name !== "setup");
  $modBtn.classList.toggle("show", name !== "setup" && App.mod_mode);
  // 对局中切屏自动落盘；终局写入历史并清存档
  if (name === "over") { recordHistory(); clearSave(); }
  else if (name === "deal" || name === "night" || name === "day") {
    saveGame(name);
  }
  if (name === "setup")  renderSetup();
  else if (name === "deal")  renderDeal();
  else if (name === "night") renderNight();
  else if (name === "day")   renderDay();
  else if (name === "over")  renderOver();
  $app.scrollTop = 0;
}

// ========== 设置屏 ==========
function renderSetup() {
  // 历史对局视图优先（列表 / 详情）
  if (App.historyView) { renderHistoryView(); return; }
  const s = App.setup;
  const resume = loadSave();
  // 同步昵称列表长度
  const total = s.preset ? s.preset : Object.values(s.counts).reduce((a,b)=>a+b, 0);
  while (s.names.length < total) s.names.push("玩家" + (s.names.length + 1));
  s.names.length = total;

  // 预设按钮
  const presets = [6,7,8,9,10,11,12].map(n => {
    const active = (s.preset === n) ? "active" : "";
    return `<button class="${active}" data-action="pick-preset" data-n="${n}">${n}人</button>`;
  }).join("");

  // 角色计数器
  const roleRows = ROLE_ORDER.map(r => {
    const ui = ROLE_UI[r];
    const [min,max] = ROLE_LIMITS[r];
    const cur = s.counts[r];
    const decDisabled = (cur <= min) ? "disabled" : "";
    const incDisabled = (cur >= max) ? "disabled" : "";
    return `<div class="role-row">
      <div class="name">
        <span class="badge" style="background:${ui.color};color:#12141C">${ui.icon}</span>
        <span>${ui.name}</span>
      </div>
      <div class="count">
        <button data-action="role-dec" data-role="${r}" ${decDisabled}>-</button>
        <span class="val">${cur}</span>
        <button data-action="role-inc" data-role="${r}" ${incDisabled}>+</button>
      </div>
    </div>`;
  }).join("");

  const totalCustom = Object.values(s.counts).reduce((a,b)=>a+b, 0);

  const html = `
    <div class="page-head"><span class="day">狼人杀小助手</span> · ${APP_VERSION}</div>
    <div class="label bold" style="margin-bottom:8px">板子预设</div>
    <div class="seg">${presets}</div>
    <div class="seg"><button class="${s.preset===0?'active':''}" data-action="pick-preset" data-n="0">自定义</button></div>

    ${s.preset === 0 ? `
      <div class="label bold" style="margin:12px 0 6px">自定义身份（共 ${totalCustom} 人）</div>
      ${roleRows}
    ` : `
      <div class="label muted" style="margin:6px 0">${boardSummary(s.preset)}</div>
    `}

    <hr class="sep">

    <div class="label bold" style="margin-bottom:6px">胜利规则</div>
    <div class="seg">
      <button class="${s.winRule==='bian'?'active':''}" data-action="pick-rule" data-v="bian">屠边（默认）</button>
      <button class="${s.winRule==='cheng'?'active':''}" data-action="pick-rule" data-v="cheng">屠城</button>
    </div>

    <hr class="sep">

    <div class="label bold" style="margin-bottom:6px">玩家昵称（共 ${total} 人）</div>
    <div class="name-list">
      ${s.names.map((n,i)=>`<input type="text" data-action="set-name" data-i="${i}" value="${esc(n)}" maxlength="6">`).join("")}
    </div>

    <hr class="sep">

    <label class="checkbox-row">
      <input type="checkbox" data-action="toggle-mod" ${s.modMode?'checked':''}>
      <span class="label">主持人模式（发完牌后可看全场身份）</span>
    </label>

    <label class="checkbox-row" ${ttsSupported() ? "" : 'title="当前浏览器不支持语音合成"'}>
      <input type="checkbox" data-action="toggle-tts" ${App.ttsEnabled?'checked':''}
        ${ttsSupported() ? "" : "disabled"}>
      <span class="label">天亮死亡朗读（${useClipsAudio() ? "克隆语音" : "系统语音"}念出号码/昵称）${ttsSupported() ? "" : " · 当前浏览器不支持"}</span>
    </label>

    ${useClipsAudio() && ttsSupported() ? `
      <input type="text" data-action="tts-server" value="${esc(App.ttsServer||"")}"
        maxlength="60" placeholder="克隆服务器 http://电脑IP:9880(念名字)"
        style="width:100%;margin-top:8px;background:#1C202B;border:1px solid #2A2F3D;
               border-radius:8px;color:#EDF0F6;padding:10px;font-size:14px">
      <div class="label" style="opacity:.65;font-size:12px;margin-top:4px">
        电脑运行 GPT-SoVITS API(端口9880)且与手机同一WiFi，死亡播报才会念出玩家名字；
        留空或被浏览器拦截时自动改用内置语音(不带名字)。</div>
    ` : ""}

    ${!useClipsAudio() && ttsSupported() ? (() => {
      const vs = App.zhVoices || [];
      const opts = ['<option value="">自动（优先女声）</option>']
        .concat(vs.map(v => `<option value="${esc(v.voiceURI)}" ${App.ttsVoiceURI===v.voiceURI?'selected':''}>${esc(v.name)}（${v.lang}）</option>`))
        .join("");
      return `
      <div style="display:flex;gap:8px;margin-top:10px;align-items:stretch">
        <select data-action="tts-voice"
          style="flex:1;background:#1C202B;border:1px solid #2A2F3D;border-radius:8px;
                 color:#EDF0F6;padding:10px;font-size:14px">
          ${vs.length ? opts : '<option value="">语音列表加载中…</option>'}
        </select>
        <button class="btn line sm" data-action="tts-voice-test"
          style="padding:0 14px;white-space:nowrap">试听</button>
      </div>
      <div class="label" style="opacity:.65;font-size:12px;margin-top:4px">
        觉得是男声就选「婷婷 / Tian-Tian / Mei-Jia」等女声再点试听；
        下拉里全是男声 = 手机没装中文女声包，去 设置→辅助功能→朗读内容→声音→中文 下载女声后回来刷新。</div>
    `; })() : ""}

    ${resume ? `
      <button class="btn lg block" data-action="resume-game"
        style="margin-top:16px;background:#3FA68E;color:#12141C">
        继续 ${Math.max(1, Math.round((Date.now()-resume.ts)/60000))} 分钟前的对局（第 ${resume.day} ${resume.screen==='day'?'天':'夜'}）
      </button>
      <button class="btn line sm block" data-action="discard-save" style="margin-top:8px">放弃该对局，开始新局</button>
    ` : ""}

    <button class="btn amber lg block" data-action="start-game" style="margin-top:16px">开始游戏</button>
    <button class="btn line sm block" data-action="open-history" style="margin-top:10px">历史对局（最近 ${HISTORY_KEEP} 局）</button>
    <div class="version-tag">${APP_VERSION}</div>
  `;
  $app.innerHTML = html;
}

// ========== 历史对局视图（列表 + 详情）==========
function openHistory() {
  App.historyView = { type: "list" };
  renderSetup();
}
function closeHistory() {
  App.historyView = null;
  renderSetup();
}
function openHistoryDetail(idx) {
  App.historyView = { type: "detail", item: loadHistory()[idx] };
  renderSetup();
}
function fmtTs(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderHistoryView() {
  const v = App.historyView;
  if (v.type === "detail" && v.item) {
    const item = v.item;
    const winTxt = item.winner === "good" ? "好人阵营胜利" : "狼人阵营胜利";
    const winCls = item.winner === "good" ? "good" : "wolf";
    const rows = (item.players || []).map(p => {
      const ui = ROLE_UI[p.role] || ROLE_UI.villager;
      return `<div class="role-row-final ${p.alive?'':'dead'}">
        <div class="left">
          <span class="badge" style="background:${ui.color};color:#12141C;width:24px;height:24px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${ui.icon}</span>
          <span class="label">${p.seat}号 ${esc(p.name)} — ${ui.name}</span>
        </div>
        <span class="status">${p.alive?"存活":"出局"}</span>
      </div>`;
    }).join("");
    $app.innerHTML = `
      <div class="page-head"><span class="day">对局详情</span></div>
      <div class="center-stack" style="padding:10px 0">
        <div class="label big bold ${winCls}">${winTxt}</div>
        <div class="label muted">第 ${item.day} 天结束 · ${item.total} 人 · ${esc(item.board||"")}</div>
      </div>
      <div class="label bold" style="color:#E8A33D">—— 全场身份 ——</div>
      <div class="scroll-area" style="max-height:260px">${rows}</div>
      <div class="label bold" style="color:#E8A33D;margin-top:10px">—— 对局记录 ——</div>
      <div class="scroll-area" style="max-height:300px">
        ${(item.log||[]).map(l => `<div class="log-line">${esc(l)}</div>`).join("")}
      </div>
      <button class="btn line sm block" data-action="history-back" style="margin-top:12px">返回列表</button>
    `;
    return;
  }
  const history = loadHistory().slice().reverse();
  $app.innerHTML = `
    <div class="page-head"><span class="day">历史对局</span> · 最近 ${HISTORY_KEEP} 局</div>
    ${history.length === 0
      ? `<div class="center-stack" style="padding:60px 0"><div class="label muted">暂无历史对局</div></div>`
      : `<div class="scroll-area">
        ${history.map((item, i) => {
          const realIdx = loadHistory().length - 1 - i;
          const winTxt = item.winner === "good" ? "好人胜" : "狼人胜";
          const cls = item.winner === "good" ? "good" : "wolf";
          return `<button class="btn block" data-action="history-detail" data-i="${realIdx}"
            style="text-align:left;margin-bottom:8px;display:flex;justify-content:space-between">
            <span>${fmtTs(item.ts)}　第${item.day}天　${item.total}人</span>
            <span class="${cls}" style="font-weight:700">${winTxt}</span>
          </button>`;
        }).join("")}
      </div>`}
    <button class="btn line sm block" data-action="history-back" style="margin-top:12px">返回</button>
  `;
}

function boardSummary(n) {
  const roles = BOARDS[n];
  const wolf = roles.filter(r=>r==="werewolf").length;
  const vill = roles.filter(r=>r==="villager").length;
  const gods = ["seer","witch","hunter","guard"].filter(r=>roles.includes(r));
  const godNames = { seer:"预言家", witch:"女巫", hunter:"猎人", guard:"守卫" };
  let parts = [`${wolf}狼`, `${vill}民`];
  if (gods.length) parts.push(gods.map(r=>godNames[r]).join(""));
  if (roles.includes("halfblood")) parts.push("混血");
  return parts.join("  ");
}

function setupPickPreset(n) {
  App.setup.preset = n;
  if (n !== 0) {
    const roles = BOARDS[n];
    ROLE_ORDER.forEach(r => App.setup.counts[r] = 0);
    roles.forEach(r => App.setup.counts[r]++);
  }
  renderSetup();
}

function setupRoleInc(r) {
  const [min,max] = ROLE_LIMITS[r];
  if (App.setup.counts[r] < max) {
    App.setup.counts[r]++;
    renderSetup();
  }
}
function setupRoleDec(r) {
  const [min,max] = ROLE_LIMITS[r];
  if (App.setup.counts[r] > min) {
    App.setup.counts[r]--;
    renderSetup();
  }
}

function startGame() {
  const s = App.setup;
  clearSave();  // 新对局开始，旧的未完成存档作废
  App.historyView = null;
  let roles;
  if (s.preset !== 0) {
    roles = BOARDS[s.preset];
  } else {
    roles = [];
    ROLE_ORDER.forEach(r => { for (let i=0;i<s.counts[r];i++) roles.push(r); });
  }
  const names = s.names.slice();
  while (names.length < roles.length) names.push("玩家" + (names.length+1));
  // 把 setup_game 调用字符串安全化（昵称可能含特殊字符）
  App.pyodide.globals.set("_js_names", names);
  App.pyodide.globals.set("_js_roles", roles);
  App.pyodide.runPython(`
import json
names = list(_js_names.to_py() if hasattr(_js_names, "to_py") else _js_names)
roles = list(_js_roles.to_py() if hasattr(_js_roles, "to_py") else _js_roles)
state = gl.setup_game(names, roles=roles, seed=None, win_rule="${s.winRule}")
print("[py] setup_game done, players:", len(state.players))
`);
  App.state = App.pyodide.globals.get("state");
  App.mod_mode = s.modMode;
  App.deal = { idx: 0, revealed: false };
  // 开局预加载内置片段 + 后台合成含名字整句(配置了服务器才有)
  if (App.ttsEnabled) {
    preloadTTSClips();
    ensureNamedClips();
  }
  // 进入发牌屏（主持人模式时也先进发牌，主持人确认在 deal 完成后切到 mod）
  setScreen("deal");
}

// ========== 发牌屏 ==========
function renderDeal() {
  const players = getPlayers();
  const idx = App.deal.idx;
  const revealed = App.deal.revealed;
  if (idx >= players.length) {
    // 所有人发完，进入夜晚或主持人确认
    finishDeal();
    return;
  }
  const p = players[idx];
  if (!revealed) {
    // 交接屏：请把手机交给 X 号
    $app.innerHTML = `
      <div class="page-head"><span class="day">发牌阶段</span> · 第 ${idx+1}/${players.length} 位</div>
      <div class="deal-stage">
        <div class="label muted">请把手机交给</div>
        <div class="big-role">${p.seat}号 ${esc(p.name)}</div>
        <div class="label muted" style="margin-top:24px">其他人请勿注视屏幕</div>
        <button class="btn amber lg block" data-action="deal-reveal" style="margin-top:32px">我是 ${esc(p.name)}，查看身份</button>
      </div>
    `;
  } else {
    const ui = ROLE_UI[p.role];
    $app.innerHTML = `
      <div class="page-head"><span class="day">发牌阶段</span> · 第 ${idx+1}/${players.length} 位</div>
      <div class="deal-stage">
        <div class="label muted">${p.seat}号 ${esc(p.name)}，你的身份是</div>
        <div class="role-icon" style="color:${ui.color}">${ui.icon}</div>
        <div class="role-name" style="color:${ui.color}">${ui.name}</div>
        <div class="role-camp">${ui.camp}</div>
        <div class="role-skill">${ui.skill}</div>
        <button class="btn amber lg block" data-action="deal-next" style="margin-top:32px">
          ${idx === players.length - 1 ? "全员发牌完成，进入夜晚" : "我已记住身份，下一位"}
        </button>
      </div>
    `;
  }
}

function dealReveal() {
  App.deal.revealed = true;
  renderDeal();
}

function dealNext() {
  App.deal.idx++;
  App.deal.revealed = false;
  renderDeal();
}

function finishDeal() {
  if (App.mod_mode) {
    // 主持人模式：切到 night 但先显示主持人确认（直接复用 night 的 mod 流程？）
    // 简化：直接在 deal 屏末尾显示主持人确认，按钮进入夜
    $app.innerHTML = `
      <div class="page-head"><span class="day">主持人模式</span></div>
      <div class="deal-stage">
        <div class="label big bold" style="margin-top:40px">身份已发完</div>
        <div class="label muted" style="margin:16px 0">是否以主持人身份开始本局？<br>确认后你可以查看所有玩家的身份</div>
        <button class="btn gold lg block" data-action="mod-show-roles" style="margin-top:24px">主持人确认开始</button>
        <button class="btn line sm block" data-action="mod-redeal" style="margin-top:12px">重新发牌</button>
      </div>
    `;
    return;
  }
  enterNight();
}

function modShowRoles() {
  const players = getPlayers();
  const rows = players.map(p => {
    const ui = ROLE_UI[p.role];
    return `<div class="role-row-final">
      <div class="left">
        <span class="badge" style="background:${ui.color};color:#12141C;width:24px;height:24px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${ui.icon}</span>
        <span class="label">${p.seat}号 ${esc(p.name)} — ${ui.name}（${ui.camp}）</span>
      </div>
    </div>`;
  }).join("");
  $app.innerHTML = `
    <div class="page-head"><span class="day">主持人视角</span> · 全场身份</div>
    <div class="label muted" style="margin:6px 0">仅主持人可看，请勿展示给其他玩家</div>
    <div class="scroll-area">${rows}</div>
    <button class="btn wolf lg block" data-action="enter-night" style="margin-top:16px">进入第 1 夜</button>
  `;
}

function modRedeal() {
  // 回设置页重新开始（主持人主动重发，旧存档作废）
  clearSave();
  App.pyodide.runPython("state = None; flow = None");
  App.state = null; App.flow = null;
  setScreen("setup");
}

function enterNight() {
  App.pyodide.runPython(`
gl.start_night(state)
flow = gl.NightFlow(state)
print("[py] entered night, day=", state.day, "stages=", len(flow.stages))
`);
  App.state = App.pyodide.globals.get("state");
  App.flow = App.pyodide.globals.get("flow");
  App.nightEnteredKey = null;
  App.actCursor = -1;
  setScreen("night");
}

// ========== 事件委托 ==========
$app.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-action]");
  if (!t) return;
  const action = t.dataset.action;
  const seat = parseInt(t.dataset.seat, 10);
  switch (action) {
    case "pick-preset":  setupPickPreset(parseInt(t.dataset.n, 10)); break;
    case "pick-rule":    App.setup.winRule = t.dataset.v; renderSetup(); break;
    case "role-inc":     setupRoleInc(t.dataset.role); break;
    case "role-dec":     setupRoleDec(t.dataset.role); break;
    case "toggle-mod":   App.setup.modMode = t.checked; break;
    case "tts-voice-test":
      App.ttsUnlocked = true;
      speakText("大家好，这是朗读试听，天黑请闭眼，天亮请睁眼。");
      break;
    case "toggle-tts":
      App.ttsEnabled = t.checked;
      try { localStorage.setItem(LS_TTS, App.ttsEnabled ? "1" : "0"); } catch (e) {}
      if (App.ttsEnabled) {
        if (useClipsAudio()) { preloadTTSClips(); playTTSClip("tts_night"); }
        else speakText("天亮死亡朗读已开启");
      } else {
        if (!useClipsAudio() && ttsSupported()) window.speechSynthesis.cancel();
      }
      break;
    case "start-game":   startGame(); break;
    case "resume-game":  resumeGame(); break;
    case "discard-save": discardSave(); break;
    case "open-history": openHistory(); break;
    case "history-back": closeHistory(); break;
    case "history-detail": openHistoryDetail(parseInt(t.dataset.i, 10)); break;
    case "deal-reveal":  dealReveal(); break;
    case "deal-next":    dealNext(); break;
    case "mod-show-roles": modShowRoles(); break;
    case "mod-redeal":   modRedeal(); break;
    case "enter-night":  enterNight(); break;
    // 夜晚
    case "night-start-action": nightStartAction(); break;
    case "night-choose": nightChoose(seat); break;
    case "night-confirm": nightConfirmPick(); break;
    case "night-skip":   nightSkipConfirm(); break;
    case "night-heal-yes": nightCommitHealConfirm(true); break;
    case "night-heal-no":  nightCommitHealConfirm(false); break;
    case "night-seer-ok":  nightNext(); break;
    case "night-finish":   finishNight(); break;
    // 白天
    case "day-after-announce": dayAfterAnnounce(); break;
    case "day-choose":  dayChoose(seat); break;
    case "day-confirm": dayConfirmPick(); break;
    case "day-shoot":   dayShoot(seat); break;
    case "day-shoot-pass": dayPassShoot(); break;
    case "day-exile":    dayExile(seat); break;
    case "day-exile-pass": dayExilePassConfirm(); break;
    case "day-kick":      dayKick(seat); break;
    case "day-choose-kick": dayChooseKick(seat); break;
    case "day-confirm-kick": dayConfirmKick(); break;
    case "day-enter-kick": dayEnterKick(); break;
    case "day-cancel-kick": dayCancelKick(); break;
    case "day-next-night": toNextNight(); break;
    // 终局
    case "over-restart":  overRestart(); break;
  }
});

$app.addEventListener("input", (ev) => {
  const t = ev.target.closest("[data-action]");
  if (!t) return;
  if (t.dataset.action === "set-name") {
    const i = parseInt(t.dataset.i, 10);
    App.setup.names[i] = t.value;
  } else if (t.dataset.action === "tts-server") {
    App.ttsServer = t.value.trim();
    try { localStorage.setItem(LS_TTS_SERVER, App.ttsServer); } catch (e) {}
  }
});

// 语音音色下拉（select 的选择走 change 事件）
$app.addEventListener("change", (ev) => {
  const t = ev.target.closest("[data-action]");
  if (!t || t.dataset.action !== "tts-voice") return;
  App.ttsVoiceURI = t.value;
  try { localStorage.setItem(LS_TTS_VOICE, App.ttsVoiceURI); } catch (e) {}
});

// 退出按钮（双击确认）
$quit.addEventListener("click", () => {
  if (App.quitBtnText === "退出游戏") {
    App.quitBtnText = "再按一次确认";
    $quit.textContent = "再按一次确认";
    App.quitResetTimer = setTimeout(() => {
      App.quitBtnText = "退出游戏";
      $quit.textContent = "退出游戏";
    }, 3000);
  } else {
    if (App.quitResetTimer) clearTimeout(App.quitResetTimer);
    App.quitBtnText = "退出游戏";
    $quit.textContent = "退出游戏";
    // 暂停退出：先把当前对局落盘(30 分钟内首页可继续)，再回设置页
    closeModOverlay();
    if (ttsSupported()) window.speechSynthesis.cancel();
    if (App.state) saveGame(App.screen);
    App.pyodide.runPython("state = None; flow = None");
    App.state = null; App.flow = null;
    setScreen("setup");
  }
});

// 页面关闭 / 切后台前最后保存一次，保证 30 分钟内可继续
window.addEventListener("pagehide", () => { if (App.state) saveGame(App.screen); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && App.state) saveGame(App.screen);
});

// ============================================
// 夜晚屏（renderNight + 6 个子阶段）
// ============================================
function renderNight() { nightRender(); }

function nightRender() {
  const day = App.pyodide.runPython("state.day");
  if (App.nightEnteredKey !== day) {
    App.nightEnteredKey = day;
    playVoice("night_fall");
  }
  const stage = App.flow.current();  // PyProxy to dict
  const stageType = stage.get("type");
  const cursor = App.pyodide.runPython("flow.cursor");
  // 进入新的 select/witch_heal 阶段时播 act 音频（同一阶段重渲染不重复播）
  if ((stageType === "select" || stageType === "witch_heal") && App.actCursor !== cursor) {
    App.actCursor = cursor;
    const role = stage.get("role");
    const key  = stage.get("key");
    if (ROLE_VOICE[role] && key !== "poison") {
      playVoice(ROLE_VOICE[role] + "_act");
    }
  }
  if (stageType === "handoff")     renderHandoff(stage);
  else if (stageType === "select")  renderSelect(stage);
  else if (stageType === "witch_heal") renderWitchHeal(stage);
  else if (stageType === "seer_result") renderSeerResult(stage);
  else if (stageType === "hunter_ask")  renderHunterAsk(stage);
  else if (stageType === "end")        renderNightEnd(stage);
  $app.scrollTop = 0;
}

function renderHandoff(stage) {
  const role = stage.get("role");
  // handoff 后 4 秒播 role_wake（猎人用 hunter_ask 固定提示）
  if (role === "hunter") {
    playVoice("hunter_ask", 4.0);
  } else {
    const v = ROLE_VOICE[role];
    if (v) playVoice(v + "_wake", 4.0);
  }
  const ui = ROLE_UI[role] || ROLE_UI.villager;
  const extra = stage.get("extra") || "";
  const isWolf = (role === "werewolf");
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${App.pyodide.runPython("state.day")} 夜</span></div>
    <div class="night-stage center-stack" style="padding-top:40px">
      <div class="label big muted">天黑请闭眼</div>
      <div class="label muted">请把手机放回中央</div>
      <div class="big-role" style="color:${ui.color}">【${ui.name}】</div>
      <div class="label muted">请睁眼，到中央操作<br>其他人请勿注视屏幕</div>
      ${extra ? `<div class="label muted spacer-top">${esc(extra)}</div>` : ""}
      <button class="btn ${isWolf?'wolf':'amber'} lg block" data-action="night-start-action" style="margin-top:32px">
        我是${ui.name}，开始行动
      </button>
    </div>
  `;
}

function renderSelect(stage) {
  const role = stage.get("role");
  const key  = stage.get("key");
  const title = stage.get("title") || "";
  const hint  = stage.get("hint") || "";
  const skipLabel = stage.get("skip_label");
  // active=false：玩家已出局或药已用完，仍可操作但不会生效
  const isActive = stage.get("active") !== false;
  const players = getPlayers();
  const alive = players.filter(p=>p.alive);
  let choices = alive;
  const disabled = new Set();
  const wolfMates = new Set();
  if (key === "guard") {
    if (isActive) {
      const last = App.pyodide.runPython("state.last_guard_target");
      if (last !== undefined && last !== null) disabled.add(last);
    }
  } else if (key === "seer") {
    // 用 players_with_role 而非 alive_role：预言家已出局时也能完成假操作
    const seerSeat = App.pyodide.runPython("state.players_with_role(gl.SEER)[0].seat");
    choices = alive.filter(p => p.seat !== seerSeat);
  } else if (key === "halfblood") {
    const hbSeat = App.pyodide.runPython("state.players_with_role(gl.HALFBLOOD)[0].seat");
    choices = alive.filter(p => p.seat !== hbSeat);
  } else if (key === "wolf") {
    alive.forEach(p => { if (p.role === "werewolf") wolfMates.add(p.seat); });
  }
  let extraInfo = "";
  if (role === "werewolf") {
    const wolfNames = alive.filter(p=>p.role==="werewolf").map(p=>`${p.seat}号${esc(p.name)}`).join("、");
    extraInfo = `<div class="label wolf" style="margin:8px 0">今晚在场狼人：${wolfNames}</div>`;
  }
  // 出局/无药提示横幅：
  // 女巫特殊处理——只有已出局 或 解药毒药都用完才显示横幅；
  // 仅一瓶药用完不显示横幅（避免误以为女巫整体不能行动）
  let showInactive = !isActive;
  if (role === "witch") {
    const witchAlive = App.pyodide.runPython("bool(state.alive_role(gl.WITCH))");
    const healAvail = App.pyodide.runPython("state.heal_available()");
    const poisonAvail = App.pyodide.runPython("state.poison_available()");
    showInactive = !witchAlive || (!healAvail && !poisonAvail);
  }
  const inactiveNote = showInactive
    ? `<div class="inactive-banner">${inactiveText(role, key)}</div>` : "";
  const picked = (App.pending.scene === "night" && App.pending.seat != null)
    ? choices.find(p => p.seat === App.pending.seat) : null;
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${App.pyodide.runPython("state.day")} 夜</span></div>
    <div class="night-stage">
      <div class="label big bold">${esc(title)}</div>
      ${hint ? `<div class="label muted">${esc(hint)}</div>` : ""}
      ${extraInfo}
      ${inactiveNote}
      <div class="label muted" style="margin-top:4px">先点选目标，确认无误后再点底部「确认选择」</div>
      <div class="scroll-area">${renderTargetGrid(choices, "night-choose", disabled, wolfMates, picked ? picked.seat : null)}</div>
      ${picked ? renderConfirmBar("night-confirm", picked.seat, picked.name) : ""}
      ${skipLabel ? `<button type="button" class="btn line sm block" data-action="night-skip" style="margin-top:8px">${esc(skipLabel)}</button>` : ""}
    </div>
  `;
}

// 出局 / 无药 角色夜晚仍行动时的提示文案
function inactiveText(role, key) {
  if (role === "witch") {
    return "女巫已出局，或所有药品已用完：你仍可完成操作，但本次选择不会生效";
  }
  const name = ROLE_UI[role] ? ROLE_UI[role].name : "该玩家";
  return `${name}已出局：你仍可完成操作走个过场，但本次选择不会生效`;
}

function renderWitchHeal(stage) {
  // flow.witch_heal_info() 返回 [target_seat|None, can_heal, reason]
  const info = App.flow.witch_heal_info().toJs();
  const target = info[0];
  let canHeal = info[1];
  const reason = info[2];
  // stage.active = 解药是否可用
  const healAvail = stage.get("active") !== false;
  if (!healAvail) canHeal = false;
  // 女巫是否完全无法行动：已出局 或 解药毒药都已用完
  const witchAlive = App.pyodide.runPython("bool(state.alive_role(gl.WITCH))");
  const poisonAvail = App.pyodide.runPython("state.poison_available()");
  const witchInactive = !witchAlive || (!healAvail && !poisonAvail);
  // 只有完全无法行动时才显示"操作不会生效"横幅；
  // 仅解药用完但毒药还在 → 只把"使用解药"按钮置灰，不显示横幅
  const inactiveBanner = witchInactive
    ? `<div class="inactive-banner">女巫已出局，或所有药品已用完：你仍可完成操作，但本次选择不会生效</div>` : "";
  let body = "";
  if (target === null || target === undefined) {
    body = `
      <div class="label big bold good">今晚没有人被狼刀</div>
      <div class="label muted">无需使用解药</div>
      <button type="button" class="btn amber lg block" data-action="night-heal-no" style="margin-top:32px">继续</button>
    `;
  } else {
    const p = getPlayers().find(x=>x.seat===target);
    body = `
      <div class="label big bold">今晚 ${target}号 ${esc(p.name)} 被狼人强奸</div>
      ${reason && healAvail ? `<div class="label wolf">${esc(reason)}</div>` : ""}
      <button type="button" class="btn good lg block" data-action="night-heal-yes" ${canHeal?'':'disabled'} style="margin-top:32px">
        ${canHeal ? "使用解药解救 TA" : "无法使用解药"}
      </button>
      <button type="button" class="btn line block" data-action="night-heal-no" style="margin-top:8px">不使用解药</button>
    `;
  }
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${App.pyodide.runPython("state.day")} 夜</span> · 女巫 · 解药</div>
    ${poisonAvail ? `<div class="label muted" style="margin:6px 0">提醒：解药与毒药同一晚只能用一瓶，使用解药后今晚不能再用毒药</div>` : ""}
    ${inactiveBanner}
    <div class="witch-info">${body}</div>
  `;
}

function renderSeerResult(stage) {
  const target = stage.get("target");
  const isWolf = stage.get("is_wolf");
  const p = getPlayers().find(x=>x.seat===target);
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${App.pyodide.runPython("state.day")} 夜</span> · 预言家查验结果</div>
    <div class="seer-info">
      <div class="label big">${target}号 ${esc(p.name)} 的身份是</div>
      <div class="label huge" style="color:${isWolf?'#D94B4B':'#3FA68E'};margin:16px 0">${isWolf?"狼 人":"好 人"}</div>
      <div class="label ${isWolf?'wolf':'good'}">${isWolf?"此人是狼人！":"此人是好人阵营"}</div>
      <button class="btn amber lg block" data-action="night-seer-ok" style="margin-top:32px">我知道了</button>
    </div>
  `;
}

function renderHunterAsk(stage) {
  const info = App.pyodide.runPython(`
import json
info = gl.hunter_status(state)
{"alive": info["alive"], "dying_tonight": info["dying_tonight"], "cause": info["cause"], "can_shoot": info["can_shoot"]}
`).toJs({dict_converter: Object.fromEntries});
  const alive = info.alive, dying = info.dying_tonight, canShoot = info.can_shoot;
  const resolved = App.pyodide.runPython("state.hunter_resolved");
  let title = !alive ? "你已出局" : (dying ? "你今晚将出局" : "你当前存活");
  let body = "";
  if (resolved) {
    // 已结算(开过枪/已放弃)：只是走个过场，不影响局面
    body = `
      <div class="label muted">你已完成本局行动，无需操作</div>
      <button type="button" class="btn line lg block" data-action="night-skip" style="margin-top:24px">闭眼继续</button>
    `;
  } else if (!canShoot) {
    body = `
      <div class="label muted">死因是毒药，开枪技能失效</div>
      <button type="button" class="btn line lg block" data-action="night-skip" style="margin-top:24px">闭眼继续</button>
    `;
  } else if (alive && !dying) {
    body = `
      <div class="label muted">开枪状态正常，今晚无需开枪</div>
      <button class="btn line lg block" data-action="night-skip" style="margin-top:24px">闭眼继续</button>
    `;
  } else {
    const hunterSeat = App.pyodide.runPython("state.players_with_role(gl.HUNTER)[0].seat");
    const choices = getAlivePlayers().filter(p=>p.seat !== hunterSeat);
    const picked = (App.pending.scene === "night" && App.pending.seat != null)
      ? choices.find(p => p.seat === App.pending.seat) : null;
    body = `
      <div class="label muted">是否选择开枪带走一名玩家？</div>
      <div class="label muted" style="font-size:12px">先点选目标，再点底部确认</div>
      <div class="scroll-area">${renderTargetGrid(choices, "night-choose", new Set(), new Set(), picked ? picked.seat : null)}</div>
      ${picked ? renderConfirmBar("night-confirm", picked.seat, picked.name) : ""}
      <button type="button" class="btn line sm block" data-action="night-skip" style="margin-top:8px">放弃开枪，闭眼</button>
    `;
  }
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${App.pyodide.runPython("state.day")} 夜</span> · 猎人 · 开枪状态</div>
    <div class="hunter-info">
      <div class="label big bold ${alive?'good':'wolf'}">${title}</div>
      ${body}
    </div>
  `;
}

function renderNightEnd(stage) {
  // 2.2 秒后播录音版「天亮了」；TTS 死亡播报由 dayBegin 排在其结束后
  playVoice("day_break", 2.2);
  App.dayBreakAt = Date.now() + 2200;
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${App.pyodide.runPython("state.day")} 夜</span> · 夜晚结束</div>
    <div class="center-stack" style="padding-top:40px">
      <div class="label big">夜晚行动结束</div>
      <div class="label muted">请把手机放回桌子中央<br>所有人准备睁眼</div>
      <button class="btn amber lg block" data-action="night-finish" style="margin-top:32px">天亮了，公布结果</button>
    </div>
  `;
}

// 夜晚通用：行动结束播 eyes_close
function nightVoiceClose(stage) {
  const t = stage.get("type");
  if (t === "hunter_ask") { playVoice("eyes_close"); return; }
  if (t !== "select" && t !== "witch_heal") return;
  const role = stage.get("role");
  if (!ROLE_VOICE[role]) return;
  // 女巫有后续毒药环节时不闭眼
  if (t === "witch_heal" && App.pyodide.runPython("state.poison_available()")) return;
  playVoice("eyes_close");
}

function nightStartAction() {
  App.pending = { scene: null, seat: null };
  App.flow.next_stage();
  nightRender();
}

// 第一步：点格子只做高亮，不提交
function nightChoose(seat) {
  App.pending = { scene: "night", seat };
  nightRender();
}

// 第二步：确认后才真正提交（防误触）
// 猎人开枪额外弹窗确认
function nightConfirmPick() {
  if (App.pending.scene !== "night" || App.pending.seat == null) return;
  const seat = App.pending.seat;
  const stage = App.flow.current();
  const doCommit = () => {
    App.pending = { scene: null, seat: null };
    nightVoiceClose(stage);
    App.flow.commit(stage, seat);
    App.flow.next_stage();
    nightRender();
  };
  if (stage.get("type") === "hunter_ask") {
    showConfirm(`确认开枪带走 ${seat}号？`, doCommit);
  } else {
    doCommit();
  }
}

function nightSkip() {
  App.pending = { scene: null, seat: null };
  const stage = App.flow.current();
  nightVoiceClose(stage);
  App.flow.commit(stage, null);
  App.flow.next_stage();
  nightRender();
}

// 跳过类行动二次确认（空刀/空守/不用毒药/闭眼继续）
// 猎人不开枪无需确认，直接闭眼
function nightSkipConfirm() {
  const stage = App.flow.current();
  const key = stage.get("key");
  const t = stage.get("type");
  if (t === "hunter_ask") { nightSkip(); return; }
  let text = "确认放弃本次行动？";
  if (key === "wolf") text = "确认空刀（不击杀任何人）？";
  else if (key === "guard") text = "确认空守（不守护任何人）？";
  else if (key === "poison") text = "确认不使用毒药？";
  showConfirm(text, nightSkip);
}

function nightCommitHeal(use) {
  App.pending = { scene: null, seat: null };
  const stage = App.flow.current();
  App.flow.commit(stage, use);
  App.flow.next_stage();
  // 用了解药会自动跳过毒药；除非下个是 poison select 否则播 eyes_close
  const next = App.flow.current();
  if (!(next.get("type") === "select" && next.get("key") === "poison")) {
    playVoice("eyes_close");
  }
  nightRender();
}

// 女巫解药选择二次确认
function nightCommitHealConfirm(use) {
  showConfirm(use ? "确认使用解药？" : "确认不使用解药？", () => nightCommitHeal(use));
}

function nightNext() {
  App.pending = { scene: null, seat: null };
  App.flow.next_stage();
  nightRender();
}

function finishNight() {
  clearVoiceTimers();
  if (Date.now() < App.dayBreakAt) {
    playVoice("day_break");
  }
  App.pyodide.runPython("gl.resolve_night(state)");
  App.state = App.pyodide.globals.get("state");
  setScreen("day");
}

// ============================================
// 白天屏（renderDay + 子阶段：公布死亡/猎人开枪/投票/收尾）
// ============================================
function renderDay() { dayBegin(); }

function dayBegin() {
  // 夜里死亡的猎人已在夜晚阶段结算过；这里只兜底未结算的
  App.pyodide.runPython(`
shoot_queue = [s for s,c in state.last_night_deaths
               if gl.hunter_can_shoot(state, s) and not state.hunter_resolved]
`);
  App.day.shootQueue = App.pyodide.globals.get("shoot_queue").toJs();
  App.day.shootContext = "";
  App.day.exiledSeat = null;
  dayShowAnnounce();
  // TTS 死亡播报：排在录音版「天亮了」念完之后
  // (录音还在放就等 ended；已放完则立即说——此时仍在点击手势内，iOS 允许)
  if (App.ttsEnabled) {
    if (useClipsAudio()) {
      const deaths = App.pyodide.runPython(`[(s, str(c)) for s, c in state.last_night_deaths]`).toJs();
      speakAfterBreakClips(deaths);
    } else {
      const text = App.pyodide.runPython("gl.death_announcement_text(state)");
      speakAfterBreak(text);
    }
  }
}

// 安卓拼接音频：等录音版「天亮了」播完再播放死亡播报
function speakAfterBreakClips(deaths) {
  if (!App.audioVoice) App.audioVoice = document.getElementById("voice");
  const a = App.audioVoice;
  if (a && !a.ended && !a.paused) {
    let done = false;
    const go = () => { if (!done) { done = true; announceDeathsByClips(deaths); } };
    a.addEventListener("ended", go, { once: true });
    setTimeout(go, 3500);
  } else {
    announceDeathsByClips(deaths);
  }
}

// 等录音版「天亮了」播完再说 TTS；3.5 秒兜底防止 ended 事件丢失
function speakAfterBreak(text) {
  if (!App.audioVoice) App.audioVoice = document.getElementById("voice");
  const a = App.audioVoice;
  if (a && !a.ended && !a.paused) {
    let done = false;
    const go = () => { if (!done) { done = true; speakText(text); } };
    a.addEventListener("ended", go, { once: true });
    setTimeout(go, 3500);
  } else {
    speakText(text);
  }
}

function dayShowAnnounce() {
  const day = App.pyodide.runPython("state.day");
  const deaths = App.pyodide.runPython(`
import json
[(s, c) for s, c in state.last_night_deaths]
`).toJs();
  let body = "";
  if (deaths.length === 0) {
    body = `
      <div class="label big bold good" style="text-align:center;margin:20px 0">昨夜是平安夜</div>
      <div class="label muted center">没有人死亡</div>
    `;
  } else {
    const cards = deaths.map(([seat, cause]) => {
      const p = getPlayers().find(x=>x.seat===seat);
      const causeText = CAUSE_NAME[cause] || "夜间出局";
      const cls = cause === "poison" ? "poison" : (cause === "shoot" ? "shoot" : "");
      return `<div class="death-card ${cls}">
        <div class="who">${seat}号 ${esc(p.name)}</div>
        <div class="cause">${causeText}</div>
      </div>`;
    }).join("");
    body = `
      <div class="label" style="margin:6px 0">昨夜有 ${deaths.length} 人死亡：</div>
      <div class="scroll-area" style="max-height:420px">${cards}</div>
    `;
  }
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${day} 天 · 天亮了</span></div>
    ${body}
    <button class="btn amber lg block" data-action="day-after-announce" style="margin-top:16px">进入讨论与投票环节</button>
  `;
  $app.scrollTop = 0;
}

function dayAfterAnnounce() {
  // 猎人开枪必须先于终局判定完成：天亮先结算猎人枪，再判胜负
  if (App.day.shootQueue.length > 0) {
    App.day.shootContext = "night";
    dayShowShoot();
    return;
  }
  const w0 = App.pyodide.runPython("gl.check_winner(state)");
  if (w0) { setScreen("over"); return; }
  dayShowVote();
}

function dayShowShoot() {
  const hunterSeat = App.day.shootQueue[0];
  const hunter = getPlayers().find(p=>p.seat===hunterSeat);
  const choices = getAlivePlayers();
  const picked = (App.pending.scene === "dayShoot" && App.pending.seat != null)
    ? choices.find(p => p.seat === App.pending.seat) : null;
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${App.pyodide.runPython("state.day")} 天</span> · 猎人发动技能</div>
    <div class="label big bold">${hunterSeat}号 ${esc(hunter.name)}（猎人）</div>
    <div class="label muted" style="margin:6px 0">是否开枪带走一名玩家？先点选目标，再点确认</div>
    <div class="scroll-area">${renderTargetGrid(choices, "day-choose", new Set(), new Set(), picked ? picked.seat : null)}</div>
    ${picked ? renderConfirmBar("day-confirm", picked.seat, picked.name) : ""}
    <button type="button" class="btn line sm block" data-action="day-shoot-pass" style="margin-top:8px">不开枪，继续</button>
  `;
  $app.scrollTop = 0;
}

// 白天选择目标（开枪 / 投票共用）：只高亮
function dayChoose(seat) {
  // 根据当前界面决定场景
  const scene = App.day.shootQueue.length > 0
    && (App.day.shootContext === "night" || App.day.shootContext === "vote")
    ? "dayShoot" : "dayExile";
  App.pending = { scene, seat };
  if (scene === "dayShoot") dayShowShoot(); else dayShowVote();
}

// 确认白天选择（开枪需弹窗二次确认）
function dayConfirmPick() {
  if (App.pending.seat == null) return;
  const seat = App.pending.seat;
  const scene = App.pending.scene;
  if (scene === "dayShoot") {
    showConfirm(`确认开枪带走 ${seat}号？`, () => {
      App.pending = { scene: null, seat: null };
      dayShoot(seat);
    });
  } else {
    App.pending = { scene: null, seat: null };
    dayExile(seat);
  }
}

function dayShoot(seat) {
  App.pyodide.runPython(`
gl.shoot(state, ${seat})
state.hunter_resolved = True
`);
  App.day.shootQueue.shift();
  dayAfterShoot();
}

function dayPassShoot() {
  App.pending = { scene: null, seat: null };
  App.pyodide.runPython("state.hunter_resolved = True");
  App.day.shootQueue.shift();
  dayAfterShoot();
}

// 白天平票/无人出局二次确认
function dayExilePassConfirm() {
  showConfirm("确认无人出局（平票）？", () => dayExile(null));
}

function dayAfterShoot() {
  const w = App.pyodide.runPython("gl.check_winner(state)");
  if (w) { setScreen("over"); return; }
  if (App.day.shootQueue.length > 0) { dayShowShoot(); return; }
  if (App.day.shootContext === "vote") { dayFinishDay(); return; }
  // night(天亮猎人的枪) / kick(手动出局猎人的枪)结算完回到投票
  dayShowVote();
}

function dayShowVote() {
  const day = App.pyodide.runPython("state.day");
  const alive = getAlivePlayers();
  const kickMode = App.day.kickMode;
  const pickedScene = kickMode ? "dayKick" : "dayExile";
  const picked = (App.pending.scene === pickedScene && App.pending.seat != null)
    ? alive.find(p => p.seat === App.pending.seat) : null;
  const chooseAction = kickMode ? "day-choose-kick" : "day-choose";
  const confirmAction = kickMode ? "day-confirm-kick" : "day-confirm";
  const head = kickMode
    ? `<div class="page-head"><span class="day">第 ${day} 天 · 手动出局</span></div>
       <div class="inactive-banner" style="margin:8px 0">手动出局模式：选择一名玩家直接出局（若为猎人可开枪）。手动出局不影响本天投票，结束后回到正常投票</div>`
    : `<div class="page-head"><span class="day">第 ${day} 天 · 白天发言与投票</span></div>
       <div class="label muted" style="margin:6px 0">自由发言后，记录投票出局的玩家。先点选，再点确认</div>`;
  $app.innerHTML = `
    ${head}
    <div class="label good" style="margin-bottom:8px">当前存活 ${alive.length} 人</div>
    <div class="scroll-area" style="max-height:420px">${renderTargetGrid(alive, chooseAction, new Set(), new Set(), picked ? picked.seat : null)}</div>
    ${picked ? renderConfirmBar(confirmAction, picked.seat, picked.name) : ""}
    ${kickMode
      ? `<button type="button" class="btn line sm block" data-action="day-cancel-kick" style="margin-top:8px">取消手动出局</button>`
      : `<button type="button" class="btn line sm block" data-action="day-exile-pass" style="margin-top:8px">平票 / 无人出局</button>
         <button type="button" class="btn danger sm block" data-action="day-enter-kick" style="margin-top:8px">手动出局</button>`
    }
  `;
  $app.scrollTop = 0;
}

// 白天手动出局：选择目标
function dayChooseKick(seat) {
  App.pending = { scene: "dayKick", seat };
  dayShowVote();
}
// 白天手动出局：确认
function dayConfirmKick() {
  if (App.pending.seat == null) return;
  const seat = App.pending.seat;
  App.pending = { scene: null, seat: null };
  showConfirm(`确认将 ${seat}号 手动出局？`, () => dayKick(seat));
}
// 白天手动出局：执行（猎人被手动出局也可开枪）
function dayKick(seat) {
  App.day.kickMode = false;
  // 统一走逻辑层：置出局 + 死因 manual + 写入对局日志
  App.pyodide.runPython(`gl.manual_exile(state, ${seat})`);
  App.day.exiledSeat = seat;
  // 手动出局不占用当天投票：猎人先开枪(先于终局判定)，之后回到正常投票
  const canShoot = App.pyodide.runPython(`gl.hunter_can_shoot(state, ${seat})`);
  if (canShoot) {
    App.day.shootQueue = [seat];
    App.day.shootContext = "kick";
    dayShowShoot();
    return;
  }
  const wNow = App.pyodide.runPython("gl.check_winner(state)");
  if (wNow) { setScreen("over"); return; }
  dayShowVote();
}
function dayEnterKick() {
  App.day.kickMode = true;
  App.pending = { scene: null, seat: null };
  dayShowVote();
}
function dayCancelKick() {
  App.day.kickMode = false;
  App.pending = { scene: null, seat: null };
  dayShowVote();
}

function dayExile(seat) {
  if (seat === null || seat === undefined) {
    App.pyodide.runPython("gl.exile(state, None)");
    App.day.exiledSeat = null;
    dayFinishDay();
    return;
  }
  App.pyodide.runPython(`gl.exile(state, ${seat})`);
  App.day.exiledSeat = seat;
  // 猎人开枪先于终局判定，开完枪再收尾
  const canShoot = App.pyodide.runPython(`gl.hunter_can_shoot(state, ${seat})`);
  if (canShoot) {
    App.day.shootQueue = [seat];
    App.day.shootContext = "vote";
    dayShowShoot();
    return;
  }
  const wNow = App.pyodide.runPython("gl.check_winner(state)");
  if (wNow) { setScreen("over"); return; }
  dayFinishDay();
}

function dayFinishDay() {
  const w = App.pyodide.runPython("gl.check_winner(state)");
  if (w) { setScreen("over"); return; }
  const day = App.pyodide.runPython("state.day");
  const alive = getAlivePlayers();
  // 只显示存活总数，不显示狼/民分布——避免玩家反推刚出局者的身份
  // 白天出局结果（投票 / 手动踢出）
  let exileInfo = "";
  if (App.day.exiledSeat != null) {
    const p = getPlayers().find(x=>x.seat===App.day.exiledSeat);
    const cause = App.pyodide.runPython(`state.player(${App.day.exiledSeat}).death_cause`);
    const causeText = CAUSE_NAME[cause] || "白天出局";
    exileInfo = `
      <div class="death-card" style="margin:16px 0">
        <div class="who">${App.day.exiledSeat}号 ${esc(p.name)}</div>
        <div class="cause">${causeText}</div>
      </div>
    `;
  }
  $app.innerHTML = `
    <div class="page-head"><span class="day">第 ${day} 天结束</span></div>
    <div class="center-stack" style="padding-top:24px">
      <div class="label big">第 ${day} 天结束</div>
      ${exileInfo}
      <div class="label muted">当前存活 ${alive.length} 人</div>
      <button class="btn wolf lg block" data-action="day-next-night" style="margin-top:32px">进入第 ${day+1} 夜</button>
    </div>
  `;
  $app.scrollTop = 0;
}

function toNextNight() {
  App.pyodide.runPython(`
gl.advance_to_next_night(state)
flow = gl.NightFlow(state)
`);
  App.state = App.pyodide.globals.get("state");
  App.flow = App.pyodide.globals.get("flow");
  App.nightEnteredKey = null;
  App.actCursor = -1;
  setScreen("night");
}

// ============================================
// 终局屏（renderOver）
// ============================================
function renderOver() {
  const state = App.pyodide.globals.get("state");
  const winner = App.pyodide.runPython("gl.check_winner(state) or state.winner");
  const winRule = App.pyodide.runPython("getattr(state, 'win_rule', 'bian')");
  const players = getPlayers();
  const winnerText = winner === "good" ? "好人阵营胜利" : "狼人阵营胜利";
  const winnerClass = winner === "good" ? "good" : "wolf";
  const subText = winner === "good"
    ? "狼人全部出局"
    : (winRule === "cheng" ? "所有好人已出局(屠城局)" : "神职或平民已被杀光(屠边局)");

  const rows = players.map(p => {
    const ui = ROLE_UI[p.role];
    return `<div class="role-row-final ${p.alive?'':'dead'}">
      <div class="left">
        <span class="badge" style="background:${ui.color};color:#12141C;width:24px;height:24px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${ui.icon}</span>
        <span class="label">${p.seat}号 ${esc(p.name)} — ${ui.name}（${ui.camp}）</span>
      </div>
      <span class="status">${p.alive?"存活":"出局"}</span>
    </div>`;
  }).join("");

  // 混血儿结果（用 JSON 序列化，避免 None.toJs() 报错）
  const hbRaw = App.pyodide.runPython(`
import json
hb = gl.halfblood_result(state)
json.dumps(hb) if hb else "null"
`);
  const hbInfo = hbRaw ? JSON.parse(hbRaw) : null;
  let hbBlock = "";
  if (hbInfo) {
    const campTxt = hbInfo.model_wolf ? "狼人阵营" : "好人阵营";
    const campClass = hbInfo.model_wolf ? "wolf" : "good";
    const resultTxt = hbInfo.won ? "本局你与榜样同阵营，获胜" : "本局你与榜样同阵营，失败";
    hbBlock = `<div class="label ${campClass}" style="margin-top:16px">
      混血儿 ${hbInfo.seat}号 ${esc(hbInfo.name)}：榜样是 ${hbInfo.model_seat}号 ${esc(hbInfo.model_name)}（${campTxt}），${resultTxt}
    </div>`;
  }

  // 对局记录：整局行动流水(每晚各角色行动 + 白天出局过程)，便于复盘核对
  let logBlock = "";
  const logLines = JSON.parse(App.pyodide.runPython("import json; json.dumps(state.log)"));
  if (logLines.length) {
    logBlock = `
    <div class="label bold" style="margin-top:16px;color:#E8A33D">—— 对局记录 ——</div>
    <div class="scroll-area" style="max-height:300px">
      ${logLines.map(l => `<div class="log-line">${esc(l)}</div>`).join("")}
    </div>`;
  }

  $app.innerHTML = `
    <div class="page-head"><span class="day">游戏结束</span></div>
    <div class="center-stack" style="padding:20px 0">
      <div class="label big bold ${winnerClass}" style="font-size:28px">${winnerText}</div>
      <div class="label muted">${subText}</div>
    </div>
    <div class="scroll-area" style="max-height:380px">${rows}</div>
    ${hbBlock}
    ${logBlock}
    <button class="btn amber lg block" data-action="over-restart" style="margin-top:16px">再来一局</button>
  `;
  $app.scrollTop = 0;
}

function overRestart() {
  App.pyodide.runPython("state = None; flow = None");
  App.state = null;
  App.flow = null;
  setScreen("setup");
}

// ========== 主持人身份浮层（游戏中随时查看，不打断流程）==========
function openModOverlay() {
  if (!App.mod_mode || !App.state) return;
  const players = getPlayers();
  $modList.innerHTML = players.map(p => {
    const ui = ROLE_UI[p.role];
    return `<div class="mod-row ${p.alive?'':'dead'}">
      <span class="mod-seat">${p.seat}号</span>
      <span class="mod-badge" style="background:${ui.color}">${ui.icon}</span>
      <span class="mod-name">${esc(p.name)}</span>
      <span class="mod-role" style="color:${ui.color}">${ui.name}</span>
      <span class="mod-status">${p.alive?"存活":"出局"}</span>
    </div>`;
  }).join("");
  $modOverlay.classList.add("show");
}
function closeModOverlay() { $modOverlay.classList.remove("show"); }
$modBtn.addEventListener("click", openModOverlay);
document.getElementById("mod-close").addEventListener("click", closeModOverlay);
$modOverlay.addEventListener("click", (ev) => { if (ev.target === $modOverlay) closeModOverlay(); });

// ========== iOS/Safari 音频解锁 ==========
// 必须在真实用户手势内，把 audio 元素“非静音真实播放”一次，
// 之后定时延时播放语音才会被允许。用极短静音 WAV，听不到声音。
function unlockAudio() {
  if (App.audioUnlocked) return;
  if (!App.audioVoice) App.audioVoice = document.getElementById("voice");
  const a = App.audioVoice;
  const oldSrc = a.src;
  const restore = () => {
    // 恢复原 src，不打断后续流程
    a.removeAttribute("src");
    a.load();
    if (oldSrc) { a.src = oldSrc; }
  };
  try {
    a.muted = false;
    a.src = silentWavDataUri();
    const pr = a.play();
    if (pr && pr.then) {
      pr.then(() => {
        App.audioUnlocked = true;
        setTimeout(restore, 60);
      }).catch(() => { try { restore(); } catch (e) {} });
    }
  } catch (e) { /* 手势无效，等下一次 */ }
  // 同时预热系统语音(iOS Safari 要求语音在真实手势内首次触发；
  // volume 必须接近 1，volume:0 的空 utterance 不会被 iOS 当成真实播放)
  if (App.ttsEnabled && ttsSupported() && !App.ttsUnlocked) {
    try {
      const u = new SpeechSynthesisUtterance("。");
      u.volume = 0.01;
      u.lang = "zh-CN";
      window.speechSynthesis.speak(u);
      App.ttsUnlocked = true;
    } catch (e) {}
  }
}
// 不能 once：第一次手势可能太早，解锁失败后还要继续尝试
["click", "touchend", "pointerdown"].forEach(ev =>
  document.addEventListener(ev, unlockAudio, { passive: true }));

// ========== 启动 ==========
(function boot() {
  // 读取本机设置：天亮死亡系统语音朗读开关 + 克隆语音服务器地址 + 手动音色
  try { App.ttsEnabled = localStorage.getItem(LS_TTS) === "1"; } catch (e) {}
  try { App.ttsServer = localStorage.getItem(LS_TTS_SERVER) || ""; } catch (e) {}
  try { App.ttsVoiceURI = localStorage.getItem(LS_TTS_VOICE) || ""; } catch (e) {}
  // SW 尽早注册，好在加载 Pyodide 大文件时就开始建立缓存
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW reg failed:", e));
  }
  // 全局错误兜底：启动阶段任何报错都直接显示在加载屏上，不再永远转圈
  const showBootError = (msg) => {
    if (!App.bootDone) {
      setLoadingText("加载出错：" + msg + "，请点击重试或换用系统浏览器");
    }
  };
  window.addEventListener("error", ev => showBootError(ev.message || "未知错误"));
  window.addEventListener("unhandledrejection", ev => showBootError(
    (ev.reason && ev.reason.message) || "未知错误"));
  // 微信内置浏览器：内核旧 + 对 14MB 运行时限速，容易卡在加载
  if (IS_WECHAT) {
    const tip = document.createElement("div");
    tip.className = "text";
    tip.style.cssText = "margin-top:14px;font-size:12px;max-width:82vw;line-height:1.6;color:#E8A33D";
    tip.textContent = "微信加载可能较慢或失败：若超过一分钟未进入首页，请点右上角「···」选择「在浏览器打开」";
    $loading.appendChild(tip);
  }
  // 30 秒仍未完成 → 显示慢速提示与重试按钮
  setTimeout(() => {
    if (!App.bootDone) {
      const tip = document.createElement("div");
      tip.className = "text";
      tip.style.cssText = "margin-top:14px;font-size:12px;max-width:82vw;line-height:1.6;color:#E8A33D";
      tip.textContent = "仍在加载（首次需下载约 14MB 运行环境）…若长时间无进展，建议点右上角「···」→「在浏览器打开」";
      $loading.appendChild(tip);
    }
  }, 30000);
  (async () => {
    try {
      await initPyodide();
      App.bootDone = true;
      setScreen("setup");
    } catch (e) {
      App.bootDone = true;
      console.error(e);
      $loading.innerHTML =
        '<div class="text">加载失败：' + esc(e.message || String(e)) + '</div>' +
        '<button type="button" class="btn amber lg" style="margin-top:16px" onclick="location.reload()">点击重试</button>' +
        '<div class="text" style="margin-top:10px;font-size:12px;color:#8A93A6">微信内打不开时：点右上角「···」→「在浏览器打开」</div>';
    }
  })();
})();
