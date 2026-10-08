/* Module registry. Feature closures own their variables; bridge exports preserve legacy consumers.
   New features use EchoPlayer.modules[name] and EchoPlayer.events instead of adding global state. */
(() => {
  'use strict';
  const modules = Object.create(null), failures = [];
  const events = new EventTarget();
  function report(name, error) {
    failures.push({name,message:String(error?.message || error)});
    console.error('[EchoPlayer module: '+name+']',error);
    const status=document.getElementById('libraryStatus');
    if(status)status.textContent='模块 '+name+' 未能加载；请刷新或检查该模块文件';
  }
  window.EchoPlayer = {
    modules, events, failures, version:'SlowEcho Player 1.0.0',
    define(name, factory) {
      try {
        const api=factory(); modules[name]=api;
        for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(api))) {
          Object.defineProperty(window,key,{...descriptor,configurable:true});
        }
        events.dispatchEvent(new CustomEvent('module-ready',{detail:name}));
      } catch(error) { report(name,error); }
    },
    report
  };
  // Optional feature fallbacks keep basic playback working if an add-on fails to load.
  window.sentenceIpaDisplay=s=>s?.ipa?'/'+s.ipa+'/':'音标模块未加载';
  window.hasSentenceIpa=s=>!!s?.ipa;
  window.ensureIpa=async()=>{};
  window.fillSentenceIpas=async()=>{};
  window.maybeTranslate=()=>{};
  window.cancelLocalJob=()=>{};
  window.probeTranslator=async()=>{};
  window.renderVocab=()=>{};
  window.translateAll=async()=>window.toast?.('翻译模块未加载，请刷新页面',true);
  window.setShowIpa=()=>window.toast?.('音标模块未加载，请刷新页面',true);
  window.openLocalAsrDialog=()=>window.toast?.('识别模块未加载，请刷新页面',true);
  window.openAsrDialog=()=>window.toast?.('字幕工具模块未加载，请刷新页面',true);
  window.openSubtitleTools=()=>document.querySelector('#fileSub')?.click();
})();
