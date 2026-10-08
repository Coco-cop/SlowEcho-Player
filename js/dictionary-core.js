/* Feature: dictionary-core. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("dictionary-core", () => {
'use strict';
/* ---------- 词典查询 ---------- */
const DICT_KEY = "elp.dict.v2";
const dictCache = LS.get(DICT_KEY, {});
let SEEN = new Set(LS.get("elp.seen", []));
let VOCAB = new Map(LS.get("elp.vocab", []).map(o => [o.word, o]));

/* ---- 词典数据源 ----
   为什么要做多源：
     · api.dictionaryapi.dev 数据最全（含真人发音音频），但在国内多数网络下连不通；
     · Wiktionary REST 有 Access-Control-Allow-Origin: *，国内可直连，英文释义+例句质量高；
   所以以 Wiktionary 为主、dictionaryapi.dev 为补充；音标单独从 Wiktionary 的 wikitext 里提。
   发音音频拿不到时，回退到浏览器内置语音合成（离线可用）。               */
const stripHtml = s => String(s)
  .replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

function trimDef(s, n = 190) {
  s = stripHtml(s).replace(/\s*\([^)]{0,40}\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > n) s = s.slice(0, n).replace(/\s+\S*$/, "") + "…";
  return s;
}


return {
get DICT_KEY(){return DICT_KEY;},
get dictCache(){return dictCache;},
get SEEN(){return SEEN;}, set SEEN(value){SEEN=value;},
get VOCAB(){return VOCAB;}, set VOCAB(value){VOCAB=value;},
get stripHtml(){return stripHtml;},
get trimDef(){return trimDef;}, set trimDef(value){trimDef=value;}
};
});
