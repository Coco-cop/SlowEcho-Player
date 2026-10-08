/* An offline lesson contains source code and selected lesson data, never settings or keys. */
(() => {
  'use strict';
  const button = document.getElementById('btnOfflinePack');
  if (!button) return;
  const safeJSON = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const HOTSPOT_KEY = 'echoplayer.hotspot';

  /* WiFi 二维码内容（手机相机可直接识别并弹出「加入网络」） */
  const wifiPayload = (ssid, password) => {
    const esc = v => String(v == null ? '' : v).replace(/([\\;,:"'])/g, '\\$1');
    return 'WIFI:T:WPA;S:' + esc(ssid) + ';' + (password ? 'P:' + esc(password) + ';' : '') + ';';
  };
  const readSavedHotspot = () => {
    try { return JSON.parse(localStorage.getItem(HOTSPOT_KEY) || 'null') || null; } catch (e) { return null; }
  };
  const saveHotspot = (ssid, password) => {
    try { localStorage.setItem(HOTSPOT_KEY, JSON.stringify({ ssid, password })); } catch (e) { /* 无痕模式忽略 */ }
  };
  const humanSize = bytes => bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
    : Math.max(1, Math.round(bytes / 1024)) + ' KB';

  function restoreLesson() {
    const lesson = JSON.parse(document.getElementById('offlineLesson').textContent);
    S.settings.autoTranslate = false;
    S.settings.net = false;
    S.settings.dsKey = "";
    S.settings.showIpa = !!lesson.showIpa;
    const ipaBtn = document.getElementById('btnIpa');
    if (ipaBtn) ipaBtn.classList.toggle('on', S.settings.showIpa);
    const originalLoadVideo = loadVideoFile;
    loadVideoFile = function(file) {
      originalLoadVideo(file);
      loadSegments(lesson.segments, true);
      S.speed = lesson.speed;
      document.getElementById('speed').value = String(lesson.speed);
      document.getElementById('video').playbackRate = lesson.speed;
    };
    loadSegments(lesson.segments, true);
    if (lesson.media) {
      const data = lesson.media.split(',')[1];
      const chunks = [];
      for (let i = 0; i < data.length; i += 65536) {
        const str = atob(data.slice(i, i + 65536));
        chunks.push(Uint8Array.from(str, c => c.charCodeAt(0)));
      }
      loadVideoFile(new File(chunks, lesson.name, {type: lesson.type || 'video/mp4'}));
      toast('离线学习包已就绪：选择一句，打开循环即可精听');
    } else {
      document.querySelector('#dropzone h2').textContent = '打开手机里保存的同一个视频，即可离线精听';
      document.querySelector('#dropzone p').textContent = '本学习包已包含字幕。请选择：' + lesson.name;
      toast('字幕已保存，请选择同名视频文件');
    }
    document.title = lesson.name + ' · 离线精听';
  }

  /* ---------- 打包：复用播放器自身模板，产出单个自包含 HTML ---------- */
  async function buildPack(file, embedMedia) {
    const saved = S.savedMedia ? { ...S.savedMedia } : null;
    let mediaFile = file;
    const segments = S.segments.map(s => ({ start: s.start, end: s.end, text: s.text, zh: s.zh || '', ipa: s.ipa || '', words: s.words }));
    const lesson = { name: file.name, type: file.type, segments, speed: S.speed, showIpa: !!S.settings.showIpa, media: null };
    if (location.protocol === 'file:') throw new Error('请通过桌面快捷方式启动电脑服务，再下载离线学习包');
    let html = await (await fetch('index.html', { cache: 'no-store' })).text();
    for (const match of [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/gi)]) {
      const r = await fetch(match[1], { cache: 'no-store' });
      if (!r.ok) throw new Error('读取样式失败');
      const style = await r.text();
      html = html.replace(match[0], () => '<style>' + style + '</style>');
    }
    for (const match of [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>\s*<\/script>/gi)]) {
      if (match[1] === 'offline-pack.js') { html = html.replace(match[0], ''); continue; }
      const r = await fetch(match[1], { cache: 'no-store' });
      if (!r.ok) throw new Error('读取模块失败：' + match[1]);
      const source = (await r.text()).replace(/<\/script/gi, '<\\/script');
      html = html.replace(match[0], () => '<script>' + source + '</script>');
    }
    html = html.replace('<head>', '<head><meta name="echoplayer-offline" content="1">');
    if (embedMedia && saved && !(mediaFile instanceof Blob)) {
      const media = await fetch('/api/library-media/' + encodeURIComponent(saved.key));
      if (!media.ok) throw new Error('原视频无法读取，请确认文件仍在原位置');
      const size = Number(media.headers.get('Content-Length'));
      if (!size || size > 80 * 1024 * 1024) {
        await media.body && media.body.cancel();
        throw new Error('视频超过 80 MB，请取消视频嵌入并单独传输视频');
      }
      const blob = await media.blob();
      mediaFile = new File([blob], lesson.name, { type: blob.type });
      lesson.type = mediaFile.type;
    }
    if (embedMedia) {
      lesson.media = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取视频失败'));
        reader.readAsDataURL(mediaFile);
      });
    }
    html = html.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi, '');
    html = html.replace(/<head>/i, '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; media-src blob: data:; img-src data: blob:; connect-src \'none\'">');
    html = html.replace('</head>', '<style>#toolsMenu,#btnLibrary,#btnLocalAsr,#btnComputerAsr,#btnAsr,#btnOfflinePack,#btnTranslateAll,#btnSettings,#resumeBar,[data-act="tr"]{display:none!important}</style></head>');
    const payload = '<script id="offlineLesson" type="application/json">' + safeJSON(lesson) + '</script><script>(' + restoreLesson.toString() + ')();</script>';
    html = html.replace('</body>', payload + '</body>');
    return html;
  }

  const downloadLocally = (html, name) => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/\.[^.]+$/, '') + '-离线精听.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  /* ---------- 弹窗：① 扫码连热点 ② 扫码一键下载 ---------- */
  function openPackDialog(file) {
    const savedHotspot = readSavedHotspot();
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML =
      '<div class="card pack-card">' +
        '<h3>带走精听 · 离线学习包</h3>' +
        '<div class="sub">手机扫两个码就能带走：先连电脑，再下载。不用同一 WiFi，也不用数据线。</div>' +
        '<label class="switch pack-switch"><input type="checkbox" id="embedMedia"><span>把视频一起装进学习包（80 MB 以内才建议勾选）</span></label>' +
        '<div class="pack-hint" id="packHint"></div>' +
        '<div class="pack-steps" id="packSteps" hidden>' +
          '<div class="pack-step">' +
            '<div class="pack-qr"><img id="qrHotspot" alt="热点连接二维码"></div>' +
            '<div class="pack-step-text">' +
              '<b>① 手机连上电脑</b>' +
              '<span>用手机相机扫这个码 → 点「加入网络」</span>' +
              '<span class="pack-ssid" id="hotspotName"></span>' +
              '<button class="btn pack-mini" id="togglePass" hidden>显示密码</button>' +
            '</div>' +
          '</div>' +
          '<div class="pack-step">' +
            '<div class="pack-qr"><img id="qrDownload" alt="下载二维码"></div>' +
            '<div class="pack-step-text">' +
              '<b>② 再扫一下，直接下载</b>' +
              '<span>下载完用手机浏览器打开这个文件即可离线精听</span>' +
              '<a class="pack-link" id="packUrl" target="_blank" rel="noopener"></a>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pack-manual" id="packManual" hidden>' +
          '<div class="field"><label>电脑热点名称（SSID）</label><input type="text" id="hsSsid" placeholder="例如 EchoPhone"></div>' +
          '<div class="field"><label>热点密码</label><input type="text" id="hsPass" placeholder="WPA2 密码"></div>' +
          '<button class="btn" id="hsSave">保存并生成二维码</button>' +
          '<div class="hint">Windows：设置 → 网络和 Internet → 移动热点，打开后把名称和密码填进来，以后自动记住。</div>' +
        '</div>' +
        '<p class="pack-progress" id="packProgress" role="status"></p>' +
        '<div class="actions">' +
          '<button class="btn" id="packCopy">复制下载地址</button>' +
          '<button class="btn" id="packLocal">下载到电脑</button>' +
          '<button class="btn primary" id="packCreate">生成并出码</button>' +
          '<button class="btn ghost" id="packClose">关闭</button>' +
        '</div>' +
      '</div>';
    document.body.append(wrap);
    const close = () => { wrap.remove(); };
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    wrap.querySelector('#packClose').onclick = close;

    const embed = wrap.querySelector('#embedMedia');
    const hint = wrap.querySelector('#packHint');
    const steps = wrap.querySelector('#packSteps');
    const progress = wrap.querySelector('#packProgress');
    embed.checked = file.size <= 80 * 1024 * 1024;
    embed.disabled = file.size > 80 * 1024 * 1024;
    const refreshHint = () => {
      hint.textContent = embed.checked
        ? '含视频，学习包约 ' + humanSize(file.size * 1.37) + '，扫码下载要走完整个视频。'
        : '只装字幕，学习包约几百 KB，扫码秒下；视频请另外拷到手机。';
    };
    embed.onchange = refreshHint;
    refreshHint();

    let packUrl = '';
    let packHtml = '';

    const copyUrl = () => {
      if (!packUrl) { toast('先点「生成并出码」', true); return; }
      const done = () => toast('下载地址已复制');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(packUrl).then(done, () => toast(packUrl));
      } else {
        const ta = document.createElement('textarea');
        ta.value = packUrl; document.body.append(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { toast(packUrl); }
        ta.remove();
      }
    };
    wrap.querySelector('#packCopy').onclick = copyUrl;
    wrap.querySelector('#packLocal').onclick = async () => {
      if (!packHtml) { toast('先点「生成并出码」', true); return; }
      downloadLocally(packHtml, file.name);
      toast('已下载到电脑');
    };

    /* 热点信息：先读系统，读不到就用本地保存的/手填的 */
    const applyHotspot = (ssid, password) => {
      const qr = wrap.querySelector('#qrHotspot');
      qr.src = '/api/qr.png?size=9&text=' + encodeURIComponent(wifiPayload(ssid, password));
      const name = wrap.querySelector('#hotspotName');
      name.textContent = '热点：' + ssid;
      const toggle = wrap.querySelector('#togglePass');
      if (password) {
        toggle.hidden = false;
        toggle.textContent = '显示密码';
        toggle.onclick = () => {
          const shown = toggle.dataset.shown === '1';
          toggle.dataset.shown = shown ? '0' : '1';
          name.textContent = shown ? '热点：' + ssid : '热点：' + ssid + ' · 密码 ' + password;
          toggle.textContent = shown ? '显示密码' : '隐藏密码';
        };
      }
      wrap.querySelector('#packManual').hidden = true;
    };
    const showManual = preset => {
      const manual = wrap.querySelector('#packManual');
      manual.hidden = false;
      if (preset) {
        wrap.querySelector('#hsSsid').value = preset.ssid || '';
        wrap.querySelector('#hsPass').value = preset.password || '';
      }
    };
    wrap.querySelector('#hsSave').onclick = () => {
      const ssid = wrap.querySelector('#hsSsid').value.trim();
      const password = wrap.querySelector('#hsPass').value;
      if (!ssid) { toast('先填热点名称', true); return; }
      saveHotspot(ssid, password);
      applyHotspot(ssid, password);
      toast('已记住这个热点');
    };

    wrap.querySelector('#packCreate').onclick = async event => {
      const trigger = event.currentTarget;
      trigger.disabled = true;
      progress.textContent = '正在打包，请保持页面打开…';
      try {
        if (!packHtml) packHtml = await buildPack(file, embed.checked);
        const upload = await fetch('/api/offline-pack?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          headers: { 'Content-Type': 'text/html;charset=utf-8', 'X-EchoPlayer': '1' },
          body: packHtml
        });
        const data = await upload.json();
        if (!upload.ok) throw new Error(data.error || '上传学习包失败');
        packUrl = data.url;
        wrap.querySelector('#qrDownload').src =
          '/api/qr.png?size=9&text=' + encodeURIComponent(packUrl);
        const link = wrap.querySelector('#packUrl');
        link.href = packUrl;
        link.textContent = packUrl;
        steps.hidden = false;
        progress.textContent = '好了，学习包 ' + humanSize(data.size) + '，有效期 2 小时。';

        try {
          const info = await (await fetch('/api/hotspot')).json();
          if (info.wifiPayload) applyHotspot(info.hotspot.ssid, info.hotspot.password);
          else showManual(savedHotspot || (info.hotspot || null));
        } catch (e) {
          showManual(savedHotspot);
        }
      } catch (err) {
        progress.textContent = '打包失败：' + err.message;
      } finally {
        trigger.disabled = false;
      }
    };
  }

  button.onclick = () => {
    const saved = S.savedMedia ? { ...S.savedMedia } : null;
    const file = S.videoFile || window.__currentVideoFile ||
      (saved ? { name: saved.name, size: Number.isFinite(saved.size) ? saved.size : Infinity, type: 'video/mp4' } : null);
    if (!file || !S.segments.length) { toast('先打开视频并生成或导入字幕', true); return; }
    openPackDialog(file);
  };
})();
