/* Feature: init. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("init", () => {
'use strict';
/* ---------- 初始化 ---------- */
(function init() {
  const saved = LS.get("elp.settings", null);
  if (saved) Object.assign(S.settings, saved);
  S.showOverlay = LS.get("elp.showOverlay", true);
  $("#btnOverlay").classList.toggle("on", S.showOverlay);
  $("#btnOverlay").setAttribute("aria-pressed", String(S.showOverlay));
  renderOverlay();
  // 旧版本可能保存过 deepseek-v4-pro；播放器统一使用最新 V4.1 Flash。
  if (S.settings.dsModel !== "deepseek-flash") { S.settings.dsModel = "deepseek-flash"; LS.set("elp.settings", S.settings); }
  $("#btnIpa").classList.toggle("on", !!S.settings.showIpa);
  if(document.querySelector('meta[name="echoplayer-offline"]'))Object.assign(S.settings,{net:false,dsKey:"",autoTranslate:false});
  renderVocab();
  requestAnimationFrame(tick);
  probeTranslator();               // 后台探测可用的翻译引擎，不阻塞界面
  window.addEventListener("beforeunload", () => { if (S.currentObjUrl) URL.revokeObjectURL(S.currentObjUrl); });
  if (!window.isSecureContext && location.protocol === "file:") {
    console.info("SlowEcho Player: 以 file:// 打开。若「AI 生成字幕」无法加载模型，请用本地 HTTP 服务打开（见 README）。");
  }
})();

return {

};
});
