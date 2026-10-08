/* Feature: core. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("core", () => {
'use strict';
"use strict";
/* ============================================================
   SlowEcho Player —— 本地英语学习视频播放器
   模块化前端，无构建；可选 Python 服务负责识别和共享文件库。
   ============================================================ */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ---------- 全局状态 ---------- */
const S = {
  segments: [],        // {start,end,text,zh,ipa}
  active: -1,
  loopSentence: false, // 单句循环
  loopGap: 0,          // 循环间隔（秒）
  speed: 1,
  showEn: true,
  showOverlay: true,
  showZh: true,
  autoScroll: true,
  videoName: "",
  currentObjUrl: null,
  rafId: 0,
  ipaSeq: 0,
  loopLock: -1,
  offset: 0,           // 字幕整体偏移（秒），正数=字幕延后
  gapTimer: 0,         // 单句循环"停顿"用的定时器 id
  internalPause: false,// 这个 pause 是不是循环停顿自己触发的
  videoFile: null,     // 当前视频 File（离线学习包导出等外部脚本要用）
  videoToken: 0,       // 换视频就 +1，用来作废在途的识别/轮询结果
  posHandler: null,    // 记住当前挂在 video 上的 timeupdate 句柄，换视频时先摘掉
  metaHandler: null,
  localSeq: 0,         // 本机识别：请求序号，用于丢弃陈旧结果
  localJobId: null,    // 本机识别：正在跑的任务 id
  translating: false,
  settings: {
    model: "onnx-community/whisper-base",  // 默认多语言模型，中英都能识别
    customSrc: "",                         // 自定义模型源（留空则用 huggingface.co）
    net: true,                   // 允许联网（词典 / 翻译）
    autoTranslate: true,         // 自动翻译当前句
    showIpa: false,              // 显示句子音标（美音 / General American，默认关）
    engine: "auto",              // 翻译引擎：auto | deepseek | google | mymemory
    dsKey: "",                   // DeepSeek API Key（只存本机 localStorage）
    dsModel: "deepseek-flash",   // DeepSeek V4.1-Flash（官方 API ID）
    dsPolish: true,              // 识别完成后用 DeepSeek 修标点断句
    device: "wasm",              // 推理设备：wasm | webgpu
    deviceSet: false,            // 用户有没有手动选过。没选过就自动挑（能上 WebGPU 就上）
    autoResume: true             // 打开播放器时自动载入上次学习的视频和进度
  }
};

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

/* ---------- 基础工具 ---------- */
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const timeout = ms => {
  if(typeof AbortSignal.timeout==='function')return AbortSignal.timeout(ms);
  const controller=new AbortController();setTimeout(()=>controller.abort(),ms);return controller.signal;
};

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  const p = n => String(n).padStart(2, "0");
  return h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function fmtSrt(t) {
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}
let toastTimer = 0;
function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast on" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast" + (isErr ? " err" : ""); }, 2800);
}


return {
get $(){return $;},
get $$(){return $$;},
get S(){return S;},
get LS(){return LS;},
get esc(){return esc;},
get timeout(){return timeout;},
get fmt(){return fmt;}, set fmt(value){fmt=value;},
get fmtSrt(){return fmtSrt;}, set fmtSrt(value){fmtSrt=value;},
get toastTimer(){return toastTimer;}, set toastTimer(value){toastTimer=value;},
get toast(){return toast;}, set toast(value){toast=value;}
};
});
