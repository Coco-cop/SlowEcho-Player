/* Feature: translation. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("translation", () => {
'use strict';
/* ---------- 翻译 ----------
   Google 免费端点（translate.googleapis.com）质量最好，但国内直连不通、走代理也常 429；
   MyMemory 两种网络环境下都能用。所以启动时探测一次，把可用的引擎记下来优先使用。   */
const TR_KEY = "elp.tr.v1";
const trCache = LS.get(TR_KEY, {});
let TR_PROVIDER = null;          // 'google' | 'mymemory' | null(未探测)

function trSaveCache(text, zh) {
  trCache[text] = zh;
  const keys = Object.keys(trCache);
  if (keys.length > 2500) {           // 控制 localStorage 体积
    for (const k of keys.slice(0, keys.length - 2000)) delete trCache[k];
  }
  LS.set(TR_KEY, trCache);
}
async function trGoogle(text) {
  try {
    const u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q="
      + encodeURIComponent(text.slice(0, 1800));
    const r = await fetch(u, { signal: timeout(6000) });
    if (!r.ok) return "";
    const j = await r.json();
    if (Array.isArray(j) && Array.isArray(j[0])) return j[0].map(x => x[0]).join("").trim();
  } catch {}
  return "";
}
async function trMyMemory(text) {
  try {
    const u = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text.slice(0, 480))
      + "&langpair=en|zh-CN";
    const r = await fetch(u, { signal: timeout(8000) });
    if (!r.ok) return "";
    const j = await r.json();
    const t = j?.responseData?.translatedText;
    if (t && !/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t)) return t.trim();
  } catch {}
  return "";
}
async function probeTranslator() {
  if (!S.settings.net) { TR_PROVIDER = "off"; return; }
  if (S.settings.engine === "deepseek") { TR_PROVIDER = "deepseek"; return; }
  if (S.settings.engine === "google") { TR_PROVIDER = "google"; return; }
  if (S.settings.engine === "mymemory") { TR_PROVIDER = "mymemory"; return; }
  // 自动：优先 DeepSeek（国内直连可用 + 质量最好），其次 Google，最后 MyMemory
  if (S.settings.dsKey && (await trDeepSeek("hello"))) { TR_PROVIDER = "deepseek"; return; }
  TR_PROVIDER = (await trGoogle("hello")) ? "google" : "mymemory";
}
async function translateText(text) {
  if (!S.settings.net) return "";
  const key = text.trim();
  if (trCache[key]) return trCache[key];
  if (!TR_PROVIDER) {
    if (S.settings.dsKey && (await trDeepSeek("hello"))) TR_PROVIDER = "deepseek";
    else TR_PROVIDER = (await trGoogle("hello")) ? "google" : "mymemory";
  }
  const order = TR_PROVIDER === "deepseek" ? ["deepseek", "google", "mymemory"]
    : TR_PROVIDER === "google" ? ["google", "mymemory", "deepseek"]
      : ["mymemory", "google", "deepseek"];
  for (const p of order) {
    if (p === "deepseek" && !S.settings.dsKey) continue;
    const t = p === "deepseek" ? await trDeepSeek(key)
      : p === "google" ? await trGoogle(key) : await trMyMemory(key);
    if (t) { trSaveCache(key, t); if (TR_PROVIDER !== p) TR_PROVIDER = p; return t; }
  }
  return "";
}

/* ---------- DeepSeek（大模型） ----------
   实测：api.deepseek.com 国内直连可用，不需要代理；翻译质量明显好于免费接口。
   批量翻译用 [编号] 协议保证行数对齐，模型偶尔把一条拆行时按编号回并。 */
/** 按 [编号] 解析模型输出；未编号的续行并入上一条，保证行数对齐 */
function parseNumbered(out, n) {
  const map = {};
  let cur = null;
  for (const ln of out.split("\n")) {
    const m = ln.match(/^\s*\[(\d+)\]\s*(.*)$/);
    if (m) { cur = +m[1]; map[cur] = m[2]; }
    else if (cur != null && ln.trim()) map[cur] = ((map[cur] || "") + " " + ln.trim()).trim();
  }
  return Array.from({ length: n }, (_, i) => map[i + 1] || "");
}

async function trDeepSeekBatch(lines) {
  const out = await dsChat(
    "把用户给的每行英文翻译成自然、口语化的中文，用于对照学习。要求：\n" +
    "1) 原样保留行首的 [编号]，输出条数与输入完全一致\n" +
    "2) 每条一行，只输出译文，不要解释\n" +
    "3) 保持口语化，符合字幕语气",
    lines.map((t, i) => `[${i + 1}] ${t}`).join("\n"));
  return parseNumbered(out, lines.length);
}
async function trDeepSeek(text) {
  try {
    const r = await trDeepSeekBatch([text]);
    return r && r[0] ? r[0] : "";
  } catch (e) { console.warn("DeepSeek 翻译失败:", e.message); return ""; }
}

const DS_POLISH_SYS =
  "你是字幕校对员。用户给出若干条 Whisper 语音识别结果，标点缺失或错误、断句混乱。请为每条补全标点并合理断句。要求：\n" +
  "1) 不得增删或改写任何词语，只加标点和调整大小写\n" +
  "2) 必须原样保留行首的 [编号]，输出条数与输入完全一致\n" +
  "3) 不翻译、不解释，每条输出一行\n" +
  "4) 若某条无需修改，原样输出";
async function translateSeg(i, force) {
  const s = S.segments[i];
  if (!s || (s.zh && !force) || s._trBusy) return;
  s._trBusy = true;
  const el = $(`.seg[data-i="${i}"] .zh`);
  if (el) { el.classList.add("loading"); el.textContent = "翻译中…"; }
  const t = await translateText(s.text);
  s._trBusy = false;
  if (t) { s.zh = t; renderSeg(i); }
  else if (el) { el.classList.remove("loading"); el.textContent = s.zh || ""; }
}
function maybeTranslate(i) {
  if (S.settings.autoTranslate && S.showZh) translateSeg(i);
}
async function translateAll() {
  const translationToken = S.videoToken, translationSegments = S.segments;
  if (S.translating) { S.translating = false; toast("已停止翻译"); return; }
  if (!S.segments.length) { toast("还没有字幕", true); return; }
  if (!S.settings.net) { toast("已在设置中关闭联网功能", true); return; }
  S.translating = true;
  $("#btnTranslateAll").classList.add("on");
  const btn = $("#btnTranslateAll");
  const oldLabel = btn.textContent;
  let done = 0, fail = 0;

  const todo = [];
  S.segments.forEach((s, i) => { if (!s.zh && !trCache[s.text.trim()]) todo.push(i); });
  // 已经缓存过的先直接填上
  S.segments.forEach((s, i) => {
    if (!s.zh && trCache[s.text.trim()]) { s.zh = trCache[s.text.trim()]; renderSeg(i); }
  });

  const useDS = !!S.settings.dsKey && (S.settings.engine === "deepseek" ||
    (S.settings.engine === "auto" && TR_PROVIDER !== "google" && TR_PROVIDER !== "mymemory"));

  if (useDS && todo.length) {
    /* 大模型分批翻译：一次 20 条，比逐条快得多（实测约 3 秒/条 → 每批约 60 秒） */
    const BATCH = 20;
    for (let k = 0; k < todo.length; k += BATCH) {
      if (!S.translating) break;
      const idxs = todo.slice(k, k + BATCH);
      btn.textContent = `翻译 ${Math.min(k + BATCH, todo.length)}/${todo.length}`;
      try {
        const res = await trDeepSeekBatch(idxs.map(i => S.segments[i].text));
        if(translationToken!==S.videoToken || translationSegments!==S.segments) break;
        idxs.forEach((i, n) => {
          const t = res[n];
          if (t) { S.segments[i].zh = t; trSaveCache(S.segments[i].text.trim(), t); renderSeg(i); done++; }
          else fail++;
        });
      } catch (e) {
        fail += idxs.length;
        toast("DeepSeek 调用失败：" + e.message, true);
        if (fail > 40) break;
      }
    }
  } else {
    let streak = 0;
    for (const i of todo) {
      if (!S.translating) break;
      const t = await translateText(S.segments[i].text);
      if(translationToken!==S.videoToken || translationSegments!==S.segments) break;
      if (t) { S.segments[i].zh = t; renderSeg(i); done++; streak = 0; }
      else { fail++; streak++; }
      if (streak > 12) { toast("翻译接口不可用，已停止", true); break; }
      await new Promise(r => setTimeout(r, 260));
    }
  }

  S.translating = false;
  btn.classList.remove("on");
  btn.textContent = oldLabel;
  toast(`翻译完成 ${done} 句${fail ? `，失败 ${fail} 句` : ""}`);
}


return {
get TR_KEY(){return TR_KEY;},
get trCache(){return trCache;},
get TR_PROVIDER(){return TR_PROVIDER;}, set TR_PROVIDER(value){TR_PROVIDER=value;},
get trSaveCache(){return trSaveCache;}, set trSaveCache(value){trSaveCache=value;},
get trGoogle(){return trGoogle;}, set trGoogle(value){trGoogle=value;},
get trMyMemory(){return trMyMemory;}, set trMyMemory(value){trMyMemory=value;},
get probeTranslator(){return probeTranslator;}, set probeTranslator(value){probeTranslator=value;},
get translateText(){return translateText;}, set translateText(value){translateText=value;},
get parseNumbered(){return parseNumbered;}, set parseNumbered(value){parseNumbered=value;},
get trDeepSeekBatch(){return trDeepSeekBatch;}, set trDeepSeekBatch(value){trDeepSeekBatch=value;},
get trDeepSeek(){return trDeepSeek;}, set trDeepSeek(value){trDeepSeek=value;},
get DS_POLISH_SYS(){return DS_POLISH_SYS;},
get translateSeg(){return translateSeg;}, set translateSeg(value){translateSeg=value;},
get maybeTranslate(){return maybeTranslate;}, set maybeTranslate(value){maybeTranslate=value;},
get translateAll(){return translateAll;}, set translateAll(value){translateAll=value;}
};
});
