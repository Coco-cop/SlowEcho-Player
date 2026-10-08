/* Feature: ipa-words. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("ipa-words", () => {
'use strict';
/* ---------- 美音音标（General American）：纯函数，可单测 ---------- */
// 只认「明确标注美音」的音标。宁可空着，也不要塞英式(RP)音标或半截乱码给用户。
const IPA_UK_RE = /(^|[^a-z])(uk|gb|en[-_]gb|rp|british|received pronunciation)([^a-z]|$)/i;
const IPA_US_RE = /(^|[^a-z])(us|ga|en[-_]us|general american|american)([^a-z]|$)/i;
const IPA_KV_RE = /^(a|q|dial|dialect|lang|accent|pron|ipa|ref|n|nn)\d*=/i;

/** 把来源里的音标字符串洗干净；不可信就返回 "" */
function cleanIpa(raw) {
  const s = normalizeIpa(raw);
  return s && s.length <= 100 ? s : '';
}
function normalizeIpa(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.normalize('NFC').trim().replace(/^[/\[]+|[/\]]+$/g,'')
    .replace(/['`]/g,'ˈ').replace(/:/g,'ː').replace(/\s+/g,' ').trim();
  if (!s || s.length > 1200) return '';
  // ASCII IPA is valid (ju, bi, stop); theta is Greek, outside the IPA extensions block.
  if (!/^[a-zæœøŋðθβχɡ\u0250-\u02ff\u0300-\u036f\u1d00-\u1d7f .,;!?()\-]+$/u.test(s)) return '';
  // Reject prose labels, but do not guess IPA validity by the number of ASCII letters.
  if (/\b(american|british|pronunciation|transcription|ipa)\b/i.test(s)) return '';
  return s;
}

/** 字幕行展示：统一成 /…/；没有可靠美音就返回空串（行内不放占位文案） */
function ipaLabel(ipa) {
  const s = cleanSentenceIpa(ipa);
  return s ? "/" + s + "/" : "";
}
function cleanSentenceIpa(raw) { return normalizeIpa(raw); }
function sentenceWords(text){return String(text||'').match(WORD_RE)||[];}
function hasSentenceIpa(s) {
  const ipa=cleanSentenceIpa(s?.ipa);
  return !!ipa && ipa.split(/\s+/).length>=Math.ceil(sentenceWords(s.text).length*.75);
}
function sentenceIpaDisplay(s) {
  if(hasSentenceIpa(s))return ipaLabel(s.ipa);
  if(s?._ipaBusy)return '正在生成整句美音音标…';
  if(!S.settings.net && !s?._ipaError)return '正在用本地美音词表生成；生词可开启联网后重试';
  return s?._ipaError ? s._ipaError+'（点击重试）' : '美音音标待生成（点击生成）';
}

/** Free Dictionary API 词条 → 只在带明确美音标记时取用 */
function pickUsPhonetic(entry) {
  const list = Array.isArray(entry && entry.phonetics) ? entry.phonetics : [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const audio = String(p.audio || "");
    const meta = String(p.sourceUrl || "") + " " + String(p.source || "");
    const marked = /-us\./i.test(audio) || IPA_US_RE.test(audio) || IPA_US_RE.test(meta);
    if (!marked) continue;                          // 没标美音的发音条目一律不用
    if (IPA_UK_RE.test(audio) || IPA_UK_RE.test(meta)) continue;
    const ipa = cleanIpa(p.text);
    if (ipa) return { ipa, src: "DictionaryAPI(en-US)" };
  }
  return null;
}

/** 兜底：没标美音，但也没有英式痕迹（音频不是 -uk./-gb./RP）→ 用 DictionaryAPI 默认音标 */
function pickFallbackPhonetic(entry) {
  if (!entry || typeof entry !== "object") return null;
  const meta = String(entry.sourceUrl || "") + " " + String(entry.source || "");
  if (IPA_UK_RE.test(meta)) return null;                 // 词条自己标着英式：放弃
  const list = Array.isArray(entry.phonetics) ? entry.phonetics : [];
  const audios = list.map(p => String((p && p.audio) || ""));
  const hasUs = audios.some(a => /-us\./i.test(a));
  const hasUk = audios.some(a => !!a && IPA_UK_RE.test(a));
  if (hasUk && !hasUs) return null;                      // 只有英式发音：不用
  const order = hasUs ? list.filter(p => /-us\./i.test(String((p && p.audio) || ""))).concat(list) : list;
  for (const p of order) {
    if (!p || typeof p !== "object") continue;
    const audio = String(p.audio || "");
    if (audio && hasUk && IPA_UK_RE.test(audio) && !/-us\./i.test(audio)) continue;
    const ipa = cleanIpa(p.text);
    if (ipa) return { ipa, src: "DictionaryAPI(default-en)" };
  }
  const ipa = cleanIpa(entry.phonetic);                  // 词条级 phonetic 兜底
  return ipa ? { ipa, src: "DictionaryAPI(default-en)" } : null;
}

/** Wiktionary wikitext → 只在模板里明确写了美音时才采用 */
function wiktionaryUsIpa(wikitext) {
  const src = String(wikitext || "");
  if (!src) return null;
  const re = /\{\{\s*(IPA|IPA-en|pron-en|IPAc-en)\s*\|([^{}]*)\}\}/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const params = m[2].split("|").map(p => p.trim()).filter(Boolean);
    if (!params.length) continue;
    const marks = params.join(" ");
    if (IPA_UK_RE.test(marks)) continue;            // 写着 RP / UK：跳过
    if (!IPA_US_RE.test(marks)) continue;           // 没写美音：不用（宁缺毋滥）
    const vals = params.filter(p => /^[/\[]/.test(p) && !IPA_KV_RE.test(p));
    if (vals.length !== 1) continue;                // 一个模板里混着多个方言写法 → 不可信
    const ipa = cleanIpa(vals[0]);
    if (ipa) return { ipa, src: "Wiktionary(en-US)" };
  }
  return null;
}

/* ---------- 美音音标：网络 + 缓存 ---------- */
const IPA_KEY = "elp.usipa.v3";
const ipaCache = LS.get(IPA_KEY, {});   // { word: {ipa, src} }
let ipaFillSeq = 0;                     // 批量补音标的取消序号
const ipaRequests=new Map();
// 常用功能词与当前示例中的高频词：网络不可用时仍可生成基础美音音标。
// 这是兜底词表，不替代联网词典；不在表中的词会显示可重试提示。
const LOCAL_US_IPA = {
  a:'ə', an:'ən', almost:'ˈɔlmoʊst', and:'ænd', are:'ɑr', aren:'ɑrən', at:'æt',
  be:'bi', book:'bʊk', boredom:'ˈbɔrdəm', brains:'breɪnz', break:'breɪk', but:'bət',
  camp:'kæmp', chilling:'ˈtʃɪlɪŋ', everyone:'ˈɛvriˌwʌn', eventually:'ɪˈvɛntʃuəli',
  experts:'ˈɛkspɝts', filled:'fɪld', for:'fɔr', getting:'ˈɡɛtɪŋ', good:'ɡʊd', got:'ɡɑt',
  here:'hɪr', inevitably:'ɪnˈɛvətəbli', into:'ˈɪntu', is:'ɪz', it:'ɪt', maybe:'ˈmeɪbi',
  many:'ˈmɛni', minds:'maɪndz', of:'əv', or:'ɔr', our:'aʊr', ping:'pɪŋ', pings:'pɪŋz',
  plans:'plænz', posts:'poʊsts', pro:'proʊ', quiet:'ˈkwaɪət', run:'rʌn', same:'seɪm',
  say:'seɪ', scientists:'ˈsaɪəntɪsts', scrolling:'ˈskroʊlɪŋ', snaps:'snæps', solid:'ˈsɑlɪd',
  some:'sʌm', summer:'ˈsʌmɚ', thing:'θɪŋ', time:'taɪm', to:'tə', turns:'tɝnz', us:'ʌs',
  vacation:'veɪˈkeɪʃən', well:'wɛl', thank:'θæŋk', thanks:'θæŋks', yes:'jɛs', no:'noʊ', yeah:'jæ', course:'kɔrs', right:'raɪt', now:'naʊ', news:'nuz', big:'bɪɡ', in:'ɪn', on:'ɑn', my:'maɪ', first:'fɝst', question:'ˈkwɛstʃən', about:'əˈbaʊt', iphone:'ˈaɪfoʊn', dual:'ˈduəl', what:'wʌt', with:'wɪð', world:'wɝld', you:'ju',
  youve:'juv', your:'jʊr', enough:'ɪˈnʌf', endless:'ˈɛndləs', word:'wɝd', words:'wɝdz'
};
function localUsIpa(word) { return LOCAL_US_IPA[String(word||'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z]/g,'')] || ''; }

function ipaCachePut(word, val) {
  if (!word) return;
  ipaCache[word] = val;
  LS.set(IPA_KEY, ipaCache);
}

/** Wiktionary wikitext → 只取明确标注美音的 IPA */
async function fetchWiktionaryUsIpa(word) {
  try {
    const u = "https://en.wiktionary.org/w/api.php?action=query&format=json&origin=*"
      + "&prop=revisions&rvprop=content&rvslots=main&redirects=1&titles=" + encodeURIComponent(word);
    const r = await fetch(u, { signal: timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const pg = Object.values(j?.query?.pages || {})[0];
    const wt = pg?.revisions?.[0]?.slots?.main?.["*"] || "";
    return wiktionaryUsIpa(wt);
  } catch { return null; }
}

/** Free Dictionary API 原始词条（音标挑选要看 phonetics 里的音频标记） */
async function fetchDotDevEntry(word) {
  try {
    const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word),
      { signal: timeout(7000) });
    if (!r.ok) return null;
    return (await r.json())?.[0] || null;
  } catch { return null; }
}

/** 单词 → 可靠美音音标 {ipa,src}；查不到返回 {ipa:"",src:""}（来源与音标一起缓存） */
async function lookupUsIpa(word, entry) {
  const w = String(word || "").toLowerCase().trim();
  if (!w) return { ipa: "", src: "" };
  if (ipaCache[w]?.ipa && cleanIpa(ipaCache[w].ipa) && !IPA_UK_RE.test(ipaCache[w].src||'')) return ipaCache[w];
  if (ipaRequests.has(w)) return ipaRequests.get(w);
  const local = localUsIpa(w);
  if (local) return {ipa:local,src:'Local(en-US)'};
  if (!S.settings.net) return { ipa: "", src: "" };
  const request=(async()=>{
  let hit = entry ? pickUsPhonetic(entry) : null;   // 调用方已抓过词条就复用，少一次请求
  if (!hit) {
    const [dd, wk] = await Promise.all([
      entry ? Promise.resolve(null) : fetchDotDevEntry(w),
      fetchWiktionaryUsIpa(w)
    ]);
    // 明确标注美音 > Wiktionary 美音 > 无英式痕迹时的 DictionaryAPI 默认音标
    // 明确美音优先；没有方言标记时使用 DictionaryAPI 默认英文字典音标，
    // 只有检测到明确英式标记时才拒绝，避免整句全部空白。
    hit = pickUsPhonetic(dd) || wk;
  }
  const val = hit && hit.ipa ? { ipa: hit.ipa, src: hit.src } : { ipa: "", src: "" };
  if(val.ipa)ipaCachePut(w, val);
  return val;
  })();
  ipaRequests.set(w,request);
  try{return await request;}finally{ipaRequests.delete(w);}
}


return {
get IPA_UK_RE(){return IPA_UK_RE;},
get IPA_US_RE(){return IPA_US_RE;},
get IPA_KV_RE(){return IPA_KV_RE;},
get cleanIpa(){return cleanIpa;}, set cleanIpa(value){cleanIpa=value;},
get normalizeIpa(){return normalizeIpa;}, set normalizeIpa(value){normalizeIpa=value;},
get ipaLabel(){return ipaLabel;}, set ipaLabel(value){ipaLabel=value;},
get cleanSentenceIpa(){return cleanSentenceIpa;}, set cleanSentenceIpa(value){cleanSentenceIpa=value;},
get sentenceWords(){return sentenceWords;}, set sentenceWords(value){sentenceWords=value;},
get hasSentenceIpa(){return hasSentenceIpa;}, set hasSentenceIpa(value){hasSentenceIpa=value;},
get sentenceIpaDisplay(){return sentenceIpaDisplay;}, set sentenceIpaDisplay(value){sentenceIpaDisplay=value;},
get pickUsPhonetic(){return pickUsPhonetic;}, set pickUsPhonetic(value){pickUsPhonetic=value;},
get pickFallbackPhonetic(){return pickFallbackPhonetic;}, set pickFallbackPhonetic(value){pickFallbackPhonetic=value;},
get wiktionaryUsIpa(){return wiktionaryUsIpa;}, set wiktionaryUsIpa(value){wiktionaryUsIpa=value;},
get IPA_KEY(){return IPA_KEY;},
get ipaCache(){return ipaCache;},
get ipaFillSeq(){return ipaFillSeq;}, set ipaFillSeq(value){ipaFillSeq=value;},
get ipaRequests(){return ipaRequests;},
get LOCAL_US_IPA(){return LOCAL_US_IPA;},
get localUsIpa(){return localUsIpa;}, set localUsIpa(value){localUsIpa=value;},
get ipaCachePut(){return ipaCachePut;}, set ipaCachePut(value){ipaCachePut=value;},
get fetchWiktionaryUsIpa(){return fetchWiktionaryUsIpa;}, set fetchWiktionaryUsIpa(value){fetchWiktionaryUsIpa=value;},
get fetchDotDevEntry(){return fetchDotDevEntry;}, set fetchDotDevEntry(value){fetchDotDevEntry=value;},
get lookupUsIpa(){return lookupUsIpa;}, set lookupUsIpa(value){lookupUsIpa=value;}
};
});
