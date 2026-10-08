/* Feature: settings. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("settings", () => {
'use strict';
/* 设置 */
$("#btnSettings").onclick = () => {
  const d = document.createElement("div");
  d.className = "modal";
  d.innerHTML = `
  <div class="card">
    <h3>设置</h3>
    <div class="sub">设置保存在当前浏览器，字幕和视频可保存到电脑文件库。启用在线查词、翻译或 AI 润色时，相关文字会发送给对应服务。</div>
    <label class="switch"><input type="checkbox" id="stNet" ${S.settings.net ? "checked" : ""}> 允许联网（词典释义 / 音标 / 发音 / 翻译）</label>
    <label class="switch"><input type="checkbox" id="stAutoTr" ${S.settings.autoTranslate ? "checked" : ""}> 自动翻译当前正在播放的句子</label>
    <label class="switch"><input type="checkbox" id="stShowIpa" ${S.settings.showIpa ? "checked" : ""}> 显示句子音标（美音 / General American）</label>
    <label class="switch"><input type="checkbox" id="stAutoResume" ${S.settings.autoResume !== false ? "checked" : ""}> 打开时询问续播，并将导入视频自动保存到电脑文件库</label>
    <div class="field"><label>默认循环间隔（跟读用）</label>
      <select id="stGap">
        <option value="0">0 秒</option><option value="0.5">0.5 秒</option><option value="1">1 秒</option><option value="2">2 秒</option>
      </select></div>
    <div class="field"><label>翻译引擎</label>
      <select id="stEngine">
        <option value="auto">自动（优先用可用的）</option>
        <option value="deepseek">DeepSeek（需填 Key，质量最好）</option>
        <option value="mymemory">MyMemory（免费、无需 Key）</option>
        <option value="google">Google 翻译（需能访问外网）</option>
      </select>
      <div class="hint">配了 DeepSeek Key 并选「自动」时会优先用它——国内直连可用，且质量明显好于免费接口。</div></div>
    <div class="field"><label>DeepSeek API Key</label>
      <input type="password" id="stDsKey" placeholder="sk-...（留空则不用）" autocomplete="off" spellcheck="false">
      <div style="display:flex;gap:8px;align-items:center;margin-top:7px">
        <select id="stDsModel" style="flex:1;height:34px">
          <option value="deepseek-flash">deepseek-flash（V4.1 Flash，推荐）</option>
        </select>
        <button class="btn" id="stDsTest" style="height:34px">测试连接</button>
      </div>
      <div class="hint" id="stDsHint">Key 保存在当前浏览器、当前网址下；调用时仅发给 DeepSeek 官方 API。换端口或浏览器后需重新填写。</div></div>
    <label class="switch"><input type="checkbox" id="stDsPolish"> 默认启用 DeepSeek 检查与润色</label>
    <div class="field"><label>词典数据源</label>
      <div class="hint" style="color:var(--tx2);font-size:12px;line-height:1.8">
        主：<b>Wiktionary</b>（免费、免 Key、支持跨域，国内可直连）<br>
        补：<b>api.dictionaryapi.dev</b>（提供真人发音音频，部分网络不通）<br>
        发音兜底：浏览器内置语音合成（离线可用）
      </div></div>
    <div class="actions">
      <button class="btn" data-a="clearDict">清空词典缓存</button>
      <button class="btn" data-a="clearAll" style="color:var(--red)">清空全部本地数据</button>
      <button class="btn primary" data-a="ok">完成</button>
    </div>
  </div>`;
  document.body.appendChild(d);
  d.querySelector("#stGap").value = String(S.loopGap);
  d.querySelector("#stEngine").value = S.settings.engine || "auto";
  const close = () => d.remove();
  d.onclick = e => { if (e.target === d) close(); };
  const dsKeyEl = d.querySelector("#stDsKey");
  const dsHint = d.querySelector("#stDsHint");
  dsKeyEl.value = S.settings.dsKey || "";
  // 统一迁移旧配置：V4.1 Flash 的官方 API ID 是 deepseek-flash。
  S.settings.dsModel = "deepseek-flash";
  d.querySelector("#stDsModel").value = "deepseek-flash";
  d.querySelector("#stDsPolish").checked = !!S.settings.dsPolish;
  d.querySelector("#stDsTest").onclick = async () => {
    const k = dsKeyEl.value.trim();
    if (!k) { dsHint.textContent = "请先填入 Key"; return; }
    dsHint.textContent = "测试中…";
    try {
      const r = await fetch(DS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + k },
        body: JSON.stringify({
          model: d.querySelector("#stDsModel").value,
          messages: [{ role: "user", content: "回复 OK 两个字即可" }],
          stream: false, thinking: {type: "disabled"}, max_tokens: 128
        }),
        signal: timeout(60000)
      });
      if (!r.ok) { dsHint.textContent = "✗ 失败：HTTP " + r.status + " " + (await r.text()).slice(0, 80); return; }
      const j = await r.json();
      dsHint.textContent = "✓ 连接正常，模型：" + (j.model || "(未知)") + "。请点击完成保存 Key。";
    } catch (e) { dsHint.textContent = "✗ 失败：" + e.message; }
  };
  d.querySelector('[data-a="ok"]').onclick = () => {
    const prevEngine = S.settings.engine;
    const prevShowIpa = S.settings.showIpa;
    const prevKey = S.settings.dsKey;
    const prevNet = S.settings.net;
    S.settings.net = d.querySelector("#stNet").checked;
    S.settings.autoTranslate = d.querySelector("#stAutoTr").checked;
    S.settings.showIpa = d.querySelector("#stShowIpa").checked;
    S.settings.engine = d.querySelector("#stEngine").value;
    S.settings.dsKey = dsKeyEl.value.trim();
    S.settings.dsModel = d.querySelector("#stDsModel").value;
    S.settings.dsPolish = d.querySelector("#stDsPolish").checked;
    S.settings.autoResume = d.querySelector("#stAutoResume").checked;
    S.loopGap = parseFloat(d.querySelector("#stGap").value);
    $("#btnLoopGap").textContent = "停顿 " + S.loopGap + "s";
    $("#btnLoopGap").classList.toggle("on", S.loopGap > 0);
    LS.set("elp.settings", S.settings);
    close(); toast("设置已保存");
    if(prevKey !== S.settings.dsKey || prevNet !== S.settings.net) S.segments.forEach(s=>{s._ipaRetryAt=0;s._ipaError="";});
    if (S.settings.engine !== prevEngine) { TR_PROVIDER = null; probeTranslator(); }
    if (S.settings.net && S.active >= 0) maybeTranslate(S.active);
    if (prevShowIpa !== S.settings.showIpa) setShowIpa(S.settings.showIpa);
    else if (S.settings.showIpa) fillSentenceIpas(30);
  };
  d.querySelector('[data-a="clearDict"]').onclick = () => {
    LS.set(DICT_KEY, {}); for (const k in dictCache) delete dictCache[k];
    LS.set(IPA_KEY, {}); for (const k in ipaCache) delete ipaCache[k];
    ipaFillSeq++;
    S.segments.forEach(s => { delete s.ipa; delete s._ipaError; delete s._ipaRetryAt; });
    renderList();
    toast("词典和美音音标缓存已清空");
  };
  d.querySelector('[data-a="clearAll"]').onclick = () => {
    if (confirm("将清空词典缓存、生词本、播放记录，确定？")) { localStorage.clear(); location.reload(); }
  };
};


return {

};
});
