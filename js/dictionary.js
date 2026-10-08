/* Feature: dictionary. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("dictionary", () => {
'use strict';
/** Wiktionary REST → 英文释义 + 例句 */
async function fetchWiktionary(word) {
  try {
    const r = await fetch("https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(word),
      { signal: timeout(9000) });
    if (!r.ok) return null;
    const j = await r.json();
    const arr = j?.en;
    if (!Array.isArray(arr) || !arr.length) return null;
    const meanings = [];
    for (const e of arr) {
      if (meanings.length >= 3) break;
      const defs = (e.definitions || [])
        .filter(d => d && d.definition && stripHtml(d.definition).length > 2)
        .slice(0, 4)
        .map(d => ({
          def: trimDef(d.definition),
          ex: d.parsedExamples?.[0]?.example ? stripHtml(d.parsedExamples[0].example)
            : (d.examples?.[0] ? stripHtml(d.examples[0]) : "")
        }))
        .filter(d => d.def);
      if (defs.length) meanings.push({ pos: String(e.partOfSpeech || "").toLowerCase(), defs });
    }
    return meanings.length ? meanings : null;
  } catch { return null; }
}

/** Free Dictionary API → 释义 + 真人发音音频（优先美音音频） */
async function fetchDotDev(word) {
  const e = await fetchDotDevEntry(word);
  if (!e) return null;
  const phs = e.phonetics || [];
  const pickAudio = list => list.find(p => p.audio && !/\/\/\//.test(p.audio))?.audio || "";
  const audio = pickAudio(phs.filter(p => /-us\./i.test(String(p.audio || "")))) || pickAudio(phs);
  const meanings = (e.meanings || []).slice(0, 3).map(m => ({
    pos: String(m.partOfSpeech || "").toLowerCase(),
    defs: (m.definitions || []).slice(0, 3).map(d => ({ def: d.definition || "", ex: d.example || "" }))
  })).filter(m => m.defs.length);
  return { audio, meanings, entry: e };
}

async function lookupWord(word) {
  const w = word.toLowerCase();
  const old = dictCache[w];
  if (old && old.usSrc !== undefined) return old;   // 已是新的「美音优先」缓存
  if (!S.settings.net) return old || null;          // 没网时用旧缓存兜底

  // 释义与发音源并行，互不阻塞；音标只取「明确的美音」
  const [wk, dd] = await Promise.all([
    fetchWiktionary(w),
    fetchDotDev(w)
  ]);
  const us = await lookupUsIpa(w, dd?.entry || null);

  const data = {
    word: w,
    phonetic: us.ipa || "",
    usSrc: us.src || "",
    audio: dd?.audio || "",
    meanings: wk || dd?.meanings || (old?.meanings || []),
    src: wk ? (dd ? "Wiktionary + DictionaryAPI" : "Wiktionary") : (dd ? "DictionaryAPI" : "")
  };
  // 只要拿到任何一点有用信息就缓存；全空则不缓存，下次网络恢复还能重试
  if (data.meanings.length || data.phonetic) {
    dictCache[w] = data;
    LS.set(DICT_KEY, dictCache);
    return data;
  }
  return null;
}
function markSeen(w) {
  if (!SEEN.has(w)) { SEEN.add(w); LS.set("elp.seen", Array.from(SEEN).slice(-4000)); }
}
function refreshWordClass(w) {
  $$(`.word[data-w="${w}"]`).forEach(el => {
    el.classList.toggle("saved", VOCAB.has(w));
    el.classList.toggle("seen", !VOCAB.has(w) && SEEN.has(w));
  });
}

/* 查词弹窗 */
let popupWord = "", popupCtx = "";
function closePopup() { $$("#popup").forEach(el => el.remove()); }
function showPopupLoading(word, x, y) {
  closePopup();
  const d = document.createElement("div");
  d.className = "popup"; d.id = "popup";
  d.innerHTML = `<div class="pw"><b>${esc(word)}</b><button class="close" title="关闭">✕</button></div>
    <div class="loading">查询中…</div>`;
  document.body.appendChild(d);
  place(d, x, y);
  d.querySelector(".close").onclick = closePopup;
  return d;
}
function place(el, x, y) {
  const w = el.offsetWidth || 352, h = el.offsetHeight || 260;
  const px = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8);
  const py = (y + h + 16 > window.innerHeight) ? Math.max(8, y - h - 14) : y + 14;
  el.style.left = px + "px"; el.style.top = py + "px";
}
async function openWord(word, ctx, x, y) {
  popupWord = word.toLowerCase(); popupCtx = ctx || "";
  const loadingEl = showPopupLoading(word, x, y);
  const data = await lookupWord(word);
  markSeen(popupWord);
  refreshWordClass(popupWord);
  closePopup();                       // 移除加载态卡片
  const d = document.createElement("div");
  d.className = "popup"; d.id = "popup";
  const saved = VOCAB.has(popupWord);
  let body;
  if (!data) {
    body = `<div class="loading">${S.settings.net ? "词典接口没有返回结果（生僻词 / 变形词 / 网络不可达）" : "已关闭联网查询（可在设置中开启）"}</div>`;
  } else {
    const posCls = p => /^n/.test(p) ? "n" : /^v/.test(p) ? "v" : /^adj/.test(p) ? "adj" : "";
    body = data.meanings.map(m => `
      <div class="mn">
        <span class="pos ${posCls(m.pos)}">${esc(m.pos || "—")}</span>
        <ol>${m.defs.map(x => `<li>${esc(x.def)}${x.ex ? `<span class="ex">e.g. ${esc(x.ex)}</span>` : ""}</li>`).join("")}</ol>
      </div>`).join("") || `<div class="loading">暂无语义信息</div>`;
  }
  d.innerHTML = `
    <div class="pw">
      <b>${esc(word)}</b>
      ${data ? (data.phonetic ? `<span class="ph">/${esc(data.phonetic)}/</span>` : `<span class="ph off" title="词典里没有可信的美音音标">美音音标暂不可用</span>`) : ""}
      <button class="spk" title="播放发音">🔊</button>
      <button class="close" title="关闭 (Esc)">✕</button>
    </div>
    ${ctx ? `<div class="qctx">原文：<em>${esc(ctx)}</em></div>` : ""}
    <div class="zhdef" id="zhDef"><span class="zzz">中文释义加载中…</span></div>
    ${body}
    ${data && data.src ? `<div class="src">释义来源：${esc(data.src)}${data.usSrc ? " · 音标来源：" + esc(data.usSrc) : ""}</div>` : ""}
    <div class="foot">
      <button class="btn ${saved ? "" : "primary"}" data-a="star">${saved ? "✓ 已收藏" : "⭐ 加入生词本"}</button>
      <button class="btn" data-a="speak">🔈 朗读</button>
    </div>
    <div class="ext">
      更多：
      <a href="https://www.collinsdictionary.com/dictionary/english/${encodeURIComponent(popupWord)}" target="_blank" rel="noopener">柯林斯</a>·
      <a href="https://youglish.com/pronounce/${encodeURIComponent(popupWord)}/english" target="_blank" rel="noopener">YouGlish 真实语境</a>
    </div>`;
  document.body.appendChild(d);
  place(d, x, y);
  d.querySelector(".close").onclick = closePopup;
  const spk = d.querySelector(".spk");
  spk.onclick = () => {
    if (data && data.audio) new Audio(data.audio).play().catch(() => speakTTS(word));
    else speakTTS(word);          // 拿不到真人音频时用浏览器内置语音合成，离线可用
  };
  d.querySelector('[data-a="speak"]').onclick = () => speakTTS(word);
  d.querySelector('[data-a="star"]').onclick = () => {
    toggleVocab(popupWord, data, ctx);
    closePopup();
  };
  fillChinese(d, data, word);
}

/** 中文释义：优先翻译英文释义（比直译单词更准确），异步填充 */
async function fillChinese(card, data, word) {
  const box = card.querySelector("#zhDef");
  if (!box) return;
  if (!S.settings.net) { box.remove(); return; }
  const texts = [];
  if (data && data.meanings.length) {
    for (const m of data.meanings) {
      for (const dd of m.defs) { texts.push(dd.def); if (texts.length >= 2) break; }
      if (texts.length >= 2) break;
    }
  }
  if (!texts.length) texts.push(word);
  const out = [];
  for (const t of texts.slice(0, 2)) {
    const zh = await translateText(t);
    if (zh) out.push(zh);
  }
  if (!box.isConnected) return;      // 卡片可能已被关掉
  if (!out.length) { box.remove(); return; }
  box.innerHTML = `<b>中文</b>${out.map(t => `<span>${esc(t)}</span>`).join("")}`;
}
function speakTTS(word) {
  try {
    const u = new SpeechSynthesisUtterance(word);
    u.lang = "en-US"; u.rate = 0.9;
    const vs = speechSynthesis.getVoices().filter(v => /en[-_]/i.test(v.lang));
    if (vs.length) u.voice = vs.find(v => /US|United States/i.test(v.name)) || vs[0];
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { toast("浏览器不支持朗读", true); }
}


return {
get fetchWiktionary(){return fetchWiktionary;}, set fetchWiktionary(value){fetchWiktionary=value;},
get fetchDotDev(){return fetchDotDev;}, set fetchDotDev(value){fetchDotDev=value;},
get lookupWord(){return lookupWord;}, set lookupWord(value){lookupWord=value;},
get markSeen(){return markSeen;}, set markSeen(value){markSeen=value;},
get refreshWordClass(){return refreshWordClass;}, set refreshWordClass(value){refreshWordClass=value;},
get popupWord(){return popupWord;}, set popupWord(value){popupWord=value;},
get popupCtx(){return popupCtx;}, set popupCtx(value){popupCtx=value;},
get closePopup(){return closePopup;}, set closePopup(value){closePopup=value;},
get showPopupLoading(){return showPopupLoading;}, set showPopupLoading(value){showPopupLoading=value;},
get place(){return place;}, set place(value){place=value;},
get openWord(){return openWord;}, set openWord(value){openWord=value;},
get fillChinese(){return fillChinese;}, set fillChinese(value){fillChinese=value;},
get speakTTS(){return speakTTS;}, set speakTTS(value){speakTTS=value;}
};
});
