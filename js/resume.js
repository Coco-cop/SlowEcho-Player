/* Feature: resume. 自动载入上次学习的视频与进度。 */
EchoPlayer.define("resume", () => {
'use strict';
/* 只在本机浏览器里记一条「上次学到哪」；不涉及 Key、不上传任何内容。 */
const SESSION_KEY = 'elp.session';
const SKIP_KEY = 'elp.sessionSkip';
const WRITE_MS = 2000;          // timeupdate 大约每秒 4 次，节流到 2 秒写一次
let lastWrite = 0, pendingTimer = 0, opening = false, prompted = false;
let pendingResume=null;

const offlinePack = () => !!document.querySelector('meta[name="echoplayer-offline"]');
const httpMode = () => /^https?:$/.test(location.protocol) && !offlinePack();
const localHost = () => /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);

function session() {
  const value = LS.get(SESSION_KEY, null);
  if (!value || typeof value !== 'object') return null;
  if (!Number.isFinite(Number(value.time))) return null;
  if (!value.key && !value.name) return null;
  return value;
}

function snapshot() {
  const v = $('#video');
  if (!LIB.key || !v || v.readyState < 1) return null;
  if (!S.videoName && !S.segments.length) return null;   // 什么都没打开时不要覆盖旧记录
  return {
    key: LIB.key || '',
    name: S.videoName || '',
    size: S.videoFile ? S.videoFile.size : 0,
    time: v && Number.isFinite(v.currentTime) ? v.currentTime : 0,
    duration: v && Number.isFinite(v.duration) ? v.duration : 0,
    active: S.active,
    speed: S.speed,
    offset: S.offset,
    hasVideo: !!(S.savedMedia || S.videoFile),
    at: Date.now()
  };
}

function save(force) {
  if (opening) return;
  const data = snapshot();
  if (!data) return;
  const now = Date.now();
  if (!force && now - lastWrite < WRITE_MS) return;
  lastWrite = now;
  LS.set(SESSION_KEY, data);
}
function saveSoon() {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => { pendingTimer = 0; save(); }, WRITE_MS);
}
function saveNow() {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = 0; }
  save(true);
}

/* ---------- 恢复进度 ---------- */
function seekTo(v, time) {
  if (!Number.isFinite(v.duration) || v.duration <= 0) return false;
  v.currentTime = Math.max(0,Math.min(Number(time)||0,Math.max(0,v.duration-.05)));
  return true;
}
function applyProgress(saved) {
  if (!saved) return false;
  const v = $('#video');
  const time = Number(saved.time) || 0;
  if(S.metaHandler)v.removeEventListener('loadedmetadata',S.metaHandler);
  const token=S.videoToken;
  if (!seekTo(v, time)) v.addEventListener('loadedmetadata', () => {if(token===S.videoToken)seekTo(v, time);}, { once: true });
  const speed = Number(saved.speed);
  if (Number.isFinite(speed) && speed > 0) setPlaybackSpeed(speed);
  const index = Number(saved.active);
  if (Number.isInteger(index) && index >= 0 && index < S.segments.length) setActive(index);
  hideBar();
  return true;
}

/* ---------- 「上次学到哪」提示条 ---------- */
function clearProgress(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) v.currentTime = 0;
  LS.set(SESSION_KEY, null);
  hideBar();
  toast('已清除上次进度，从头开始');
}
function hideBar() {
  const bar = $('#resumeBar');
  if (bar) bar.hidden = true;
}
function showBar(saved, reason) {
  const bar = $('#resumeBar');
  if (!bar || !saved) return;
  if (saved.key && LS.get(SKIP_KEY, '') === saved.key) return;
  const parts = [saved.name || '未命名视频'];
  if (Number(saved.time) > 1) parts.push(fmt(Number(saved.time)));
  if (Number.isInteger(saved.active) && saved.active >= 0) parts.push('第 ' + (saved.active + 1) + ' 句');
  $('#resumeText').textContent = '上次学到 ' + parts.join(' · ');
  $('#resumeHint').textContent = reason === 'noconn'
    ? '电脑服务未连接；连接后可自动打开，或先手动选择视频'
    : reason === 'local'
      ? '视频本身没存到电脑文件库（浏览器不允许自己打开本地文件）。重新选一次同一个文件，进度会自动接上'
      : '点「继续上次」接着学，或点 ✕ 不再提示';
  // library 为 false 表示已经确认电脑文件库里没有这个视频，只能让用户重新选文件
  $('#resumeGo').textContent = saved.library === false || !saved.key ? '选择同一个视频' : '继续上次';
  $('#resumeSaveVideo').hidden = !(reason === 'local' && httpMode() && localHost());
  bar.hidden = false;
  if (!prompted) {
    prompted = true;
    toast(reason === 'local'
      ? '上次的视频没存到电脑文件库，播放器无法自动打开它；可点上方「以后自动保存视频」'
      : '上次学习记录还在，点上方提示条即可继续', true);
  }
}

/* ---------- 从电脑文件库直接续播 ---------- */
async function libraryEntries() {
  const response = await fetch('/api/library-index', { signal: timeout(6000) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const data = await response.json();
  return data.lessons || [];
}

async function openFromLibrary(entry, saved) {
  await EchoPlayer.storage.openLesson(entry);
  if (entry.key !== LIB.key) throw new Error('字幕库记录已变化');
  applyProgress(saved);
  toast('已自动继续上次学习：' + (saved.name || entry.videoName) + ' · ' + fmt(Number(saved.time) || 0));
}

async function autoResume() {
  const saved = session();
  if (!saved || offlinePack() || S.videoName || document.querySelector('#resumeDialog')) return;
  if (S.settings.autoResume === false) { showBar(saved); return; }
  const dlg=document.createElement('dialog');dlg.id='resumeDialog';
  dlg.style.cssText='width:calc(100% - 40px);max-width:480px;box-sizing:border-box;border:1px solid #414955;border-radius:18px;background:#191e27;color:#eee;padding:24px';
  dlg.innerHTML='<h2>继续上次学习？</h2><p id="resumeName" style="overflow-wrap:anywhere"></p><p id="resumePosition"></p><p id="resumeDialogHint" role="status">正在检查上次视频…</p><div class="actions"><button class="btn primary" id="resumeConfirm" disabled>继续学习</button><button class="btn" id="resumeLater">暂不继续</button></div>';
  dlg.querySelector('#resumeName').textContent=saved.name||'上次视频';
  dlg.querySelector('#resumePosition').textContent='上次播放到 '+fmt(Math.max(0,Number(saved.time)||0));
  document.body.append(dlg);dlg.showModal();
  dlg.querySelector('#resumeLater').onclick=()=>dlg.close();
  dlg.addEventListener('close',()=>dlg.remove(),{once:true});
  let hit=null,failed=false;
  if(httpMode())try{hit=(await libraryEntries()).find(e=>e.key===saved.key&&e.hasVideo);}catch{failed=true;}
  if(!dlg.isConnected)return;
  if(S.videoName){dlg.close();return;}
  const button=dlg.querySelector('#resumeConfirm'),hint=dlg.querySelector('#resumeDialogHint');
  hint.textContent=hit?'将打开上次视频，并恢复播放位置和倍速。':failed?'电脑文件库暂时无法连接；可以重新选择原视频继续。':'视频未保存在文件库。请选择原视频，字幕和进度会自动恢复。';
  button.textContent=hit?'继续学习':'选择原视频继续';button.disabled=false;
  button.onclick=async()=>{
    if(!hit){pendingResume=saved;dlg.close();$('#btnOpenVideo').click();return;}
    opening=true;button.disabled=true;
    try{await openFromLibrary(hit,saved);dlg.close();await $('#video').play().catch(()=>toast('进度已恢复，点击播放即可继续'));}
    catch(error){hint.textContent='暂时无法打开：'+error.message+'。可重新选择原视频继续。';hit=null;button.textContent='选择原视频继续';}
    finally{opening=false;button.disabled=false;}
  };
}

/* 用户重新选择同一个本地文件时（含改名）按内容指纹接上进度 */
function onKeyResolved(key, token) {
  if (token !== S.videoToken || S.savedMedia) return;
  const saved = pendingResume || session();
  if (!saved || !saved.key || saved.key !== key) {pendingResume=null;return;}
  applyProgress(saved);
  if(pendingResume){
    pendingResume=null;
    const v=$('#video'),play=()=>{if(token===S.videoToken)v.play().catch(()=>toast('进度已恢复，点击播放即可继续'));};
    if(v.readyState>=1)play();else v.addEventListener('loadedmetadata',play,{once:true});
  }
}
function cancelPending(){pendingResume=null;}
function onNativeOpened(key,saved){
  const shouldPlay=!!pendingResume;
  const previous=pendingResume||saved;pendingResume=null;
  if(previous?.key!==key)return;
  applyProgress(previous);
  if(shouldPlay)$('#video').play().catch(()=>toast('进度已恢复，点击播放即可继续'));
}

function start() {
  const v = $('#video');
  if (!v) return;
  $('#fileVideo').addEventListener('cancel',()=>{pendingResume=null;});
  v.addEventListener('timeupdate', saveSoon);
  v.addEventListener('pause', saveNow);
  v.addEventListener('ended', saveNow);
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', saveNow);
  const bar = $('#resumeBar');
  if (bar) {
    $('#resumeGo').onclick = async () => {
      const saved = session();
      if (!saved || opening) return;
      const button = $('#resumeGo');
      button.disabled = true;
      try {
        if (httpMode() && saved.key) {
          opening = true;
          const entries = await libraryEntries();
          const hit = entries.find(e => e.key === saved.key && e.hasVideo);
          if (hit) { await openFromLibrary(hit, saved); return; }
        }
        toast('请选择同一个视频文件，进度会自动恢复', true);
        $('#btnOpenVideo').click();
      } catch (error) {
        toast('继续失败：' + error.message, true);
      } finally {
        opening = false;
        button.disabled = false;
      }
    };
    $('#resumeDismiss').onclick = () => {
      const saved = session();
      if (saved && saved.key) LS.set(SKIP_KEY, saved.key);
      hideBar();
    };
    $('#resumeClear').onclick = () => clearProgress($('#video'));
    $('#resumeSaveVideo').onclick = async () => {
      const button = $('#resumeSaveVideo');
      button.disabled = true;
      try {
        const config = await EchoPlayer.storage.enableVideoAutoSave();
        toast('已开启：以后打开视频会自动存进「' + config.directory + '」，下次就能直接自动续播');
        button.hidden = true;
      } catch (error) {
        toast('开启失败：' + error.message, true);
        button.disabled = false;
      }
    };
  }
  // init.js 最后运行，设置读完之后再决定要不要自动载入
  if (EchoPlayer.modules.init) autoResume();
  else EchoPlayer.events.addEventListener('module-ready', function once(event) {
    if (event.detail !== 'init') return;
    EchoPlayer.events.removeEventListener('module-ready', once);
    autoResume();
  });
}

start();

return {
  get onNativeOpened(){return onNativeOpened;},
  get cancelPending(){return cancelPending;},
  get autoResume(){return autoResume;}, set autoResume(value){autoResume=value;},
  get applyProgress(){return applyProgress;}, set applyProgress(value){applyProgress=value;},
  get onKeyResolved(){return onKeyResolved;}, set onKeyResolved(value){onKeyResolved=value;},
  get session(){return session;}, set session(value){session=value;},
  get saveNow(){return saveNow;}, set saveNow(value){saveNow=value;}
};
});
