/* Appearance and accessibility layer. Playback/library contracts remain unchanged. */
(() => {
  'use strict';
  const root = document.documentElement;
  const key = 'elp.appearance';
  let prefs = { theme: 'system', reduceMotion: false, reduceTransparency: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(key) || '{}')); } catch (_) {}
  if (!['system', 'light', 'dark'].includes(prefs.theme)) prefs.theme = 'system';
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const byId = id => document.getElementById(id);
  function apply() {
    root.dataset.theme = prefs.theme === 'system' ? (dark.matches ? 'dark' : 'light') : prefs.theme;
    root.dataset.reduceMotion = String(!!prefs.reduceMotion || motion.matches);
    root.dataset.reduceTransparency = String(!!prefs.reduceTransparency || transparency.matches);
    document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === prefs.theme)));
    for (const [id, prop, media] of [['reduceMotion', 'reduceMotion', motion], ['reduceTransparency', 'reduceTransparency', transparency]]) {
      const input = byId(id);
      input.checked = !!prefs[prop] || media.matches;
      input.disabled = media.matches;
      input.title = media.matches ? '已由系统辅助功能设置开启' : '';
    }
  }
  function save() { try { localStorage.setItem(key, JSON.stringify(prefs)); } catch (_) {} apply(); }
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.addEventListener('click', () => { prefs.theme = b.dataset.themeChoice; save(); }));
  byId('reduceMotion').addEventListener('change', e => { prefs.reduceMotion = e.target.checked; save(); });
  byId('reduceTransparency').addEventListener('change', e => { prefs.reduceTransparency = e.target.checked; save(); });
  [dark, motion, transparency].forEach(m => m.addEventListener('change', apply));
  apply();

  // Small, consistent outline icons. No platform font files or external assets.
  const paths = {
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    subtitle: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M7 10h4m3 0h3M7 15h10"/>',
    library: '<rect x="3" y="4" width="5" height="16" rx="1"/><path d="M12 4v16m5-16 4 15"/>',
    settings: '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2 2m8.8 8.8 2 2M5.6 18.4l2-2m8.8-8.8 2-2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-1.5 1-2 1.5-2 3M12 17h.01"/>',
    prev: '<path d="M6 5v14m12-14L8 12l10 7V5Z"/>',
    next: '<path d="M18 5v14M6 5l10 7-10 7V5Z"/>',
    repeat: '<path d="M5 8h12l-3-3m3 3-3 3M19 16H7l3 3m-3-3 3-3"/>',
    loop: '<path d="M4 10V7a3 3 0 0 1 3-3h12l-3-3m3 3-3 3M20 14v3a3 3 0 0 1-3 3H5l3 3m-3-3 3-3"/>',
    split: '<path d="m8 8 12 12M8 16l12-12"/><circle cx="5" cy="5" r="3"/><circle cx="5" cy="19" r="3"/>',
    engine: '<rect x="4" y="3" width="16" height="12" rx="3"/><path d="M8 21h8m-4-6v6m-4-12 3 3 5-5"/>',
    translate: '<path d="M3 5h12m-6-3v3m-4 0c0 6 5 10 8 11M13 5c-1 6-6 10-10 12m12 4 4-11 4 11m-6-4h4"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  };
  function decorate(id, icon, label, iconOnly = false) {
    const b = byId(id); if (!b) return;
    b.innerHTML = `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[icon]}</svg>${iconOnly ? '' : `<span>${label}</span>`}`;
    b.setAttribute('aria-label', iconOnly ? b.title || label : label);
  }
  [['btnOpenVideo','folder','打开视频'],['btnWelcomeOpen','folder','选择视频'],['btnOpenSub','subtitle','字幕工具'],['btnOpenSub2','subtitle','字幕工具'],['btnLibrary','library','文件库'],['btnOfflinePack','download','离线学习包'],['btnRepeat','repeat','重复'],['btnLoop','loop','循环'],['btnSplit','split','精听分段'],['btnPrev','prev','上一句',true],['btnNext','next','下一句',true],['btnHelp','help','快捷键与说明',true],['btnSettings','settings','设置',true]].forEach(a => decorate(...a));
  byId('btnWelcomeOpen').addEventListener('click', () => byId('btnOpenVideo').click());
  byId('seek').setAttribute('aria-label', '播放进度');
  byId('offsetInput').setAttribute('aria-label', '字幕偏移（秒）');
  byId('toast').setAttribute('role', 'status');

  // Phone workspace: move the existing controls, preserving all listeners and IDs.
  // Landscape phones use the same dock; wider tablets keep the desktop controls.
  const phone = matchMedia('(max-width: 599px), (max-width: 999px) and (max-height: 500px)');
  const controls = document.querySelector('.controls');
  const transport = controls.querySelector('.transport-group');
  const study = controls.querySelector('.study-group');
  const mobileToggle = document.createElement('button');
  mobileToggle.id = 'mobileStudyToggle'; mobileToggle.type = 'button';
  mobileToggle.className = 'icon-btn mobile-only';
  mobileToggle.setAttribute('aria-expanded', 'false');
  mobileToggle.setAttribute('aria-controls', 'mobileStudyPanel');
  mobileToggle.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/></svg><span>学习设置</span>';
  transport.append(mobileToggle);
  const mobilePanel = document.createElement('div');
  mobilePanel.id = 'mobileStudyPanel'; mobilePanel.className = 'mobile-study-panel'; mobilePanel.hidden = true;
  mobilePanel.setAttribute('role', 'region'); mobilePanel.setAttribute('aria-label', '字幕与学习设置');
  mobilePanel.innerHTML = '<div class="mobile-panel-heading"><strong>字幕与学习设置</strong><button type="button" class="icon-btn" aria-label="收起学习设置">收起</button></div><div class="mobile-extra-tools"></div>';
  controls.append(mobilePanel);
  const extras = mobilePanel.querySelector('.mobile-extra-tools');
  const presets = controls.querySelector('.speed-presets');
  const moves = [
    [controls, document.querySelector('main')], [study, mobilePanel],
    [byId('btnLoopGap'), study], [presets, byId('speedPanel')],
    ...['btnLibrary','btnOfflinePack','appearanceMenu','btnHelp'].map(id => [byId(id), extras]),
    [document.querySelector('.export-row'), mobilePanel]
  ].map(([node, destination]) => {
    const anchor = document.createComment('responsive home');
    node.before(anchor); return {node, destination, anchor};
  });
  function closeMobilePanel(restoreFocus = false) {
    mobilePanel.hidden = true; mobileToggle.setAttribute('aria-expanded', 'false');
    byId('appearanceMenu').open = false;
    if (restoreFocus) mobileToggle.focus({preventScroll:true});
  }
  mobileToggle.addEventListener('click', () => {
    const open = mobilePanel.hidden;
    closeMobilePanel();
    if (open) { mobilePanel.hidden = false; mobileToggle.setAttribute('aria-expanded','true'); }
  });
  mobilePanel.querySelector('.mobile-panel-heading button').addEventListener('click', () => closeMobilePanel(true));
  document.addEventListener('click', e => {
    if (!mobilePanel.hidden && !mobilePanel.contains(e.target) && !mobileToggle.contains(e.target)) closeMobilePanel();
  });
  mobilePanel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMobilePanel(true); }
  });
  function syncPhoneLayout() {
    closeMobilePanel();
    if (!byId('speedPanel').hidden) byId('speedToggle').click();
    if (phone.matches) {
      moves.forEach(({node,destination}) => destination.append(node));
      mobilePanel.insertBefore(study, extras);
    }
    else moves.slice().reverse().forEach(({node,anchor}) => anchor.after(node));
    document.body.classList.toggle('phone-workspace', phone.matches);
  }
  phone.addEventListener('change', syncPhoneLayout);
  syncPhoneLayout();

  const video = byId('video');
  const stage = byId('vwrap');
  const slot = stage.parentElement;
  const desktop = matchMedia('(min-width: 1000px)');
  let frame = 0;
  function fitStage() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (document.fullscreenElement === stage) return;
      if (!desktop.matches || !document.body.classList.contains('has-media')) {
        stage.style.removeProperty('width'); stage.style.removeProperty('height');
        return;
      }
      const parts = getComputedStyle(stage).aspectRatio.split('/').map(Number);
      const ratio = parts.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : 16 / 9;
      const width = Math.max(0, Math.min(slot.clientWidth, slot.clientHeight * ratio));
      if (!width) return;
      const w = width.toFixed(2) + 'px', h = (width / ratio).toFixed(2) + 'px';
      if (stage.style.width !== w) stage.style.width = w;
      if (stage.style.height !== h) stage.style.height = h;
    });
  }
  new ResizeObserver(fitStage).observe(slot);
  desktop.addEventListener('change', fitStage);
  document.addEventListener('fullscreenchange', fitStage);
  function syncPlayer() {
    document.body.classList.toggle('has-media', !!video.currentSrc && video.readyState > 0 && !video.error);
    if (video.error || !video.getAttribute('src')) byId('dropzone').classList.remove('hide');
    fitStage();
    const playing = !video.paused;
    byId('btnPlay').dataset.playing = String(playing);
    byId('btnPlay').setAttribute('aria-label', playing ? '暂停（空格）' : '播放（空格）');
    byId('btnPlay').disabled = !video.currentSrc || !!video.error;
    byId('seek').disabled = !Number.isFinite(video.duration) || !video.duration;
    byId('seek').style.setProperty('--seek-progress', `${Number.isFinite(video.duration) && video.duration ? video.currentTime / video.duration * 100 : 0}%`);
    byId('seek').setAttribute('aria-valuetext', `${byId('tCur').textContent} / ${byId('tDur').textContent}`);
    const hint = video.currentSrc ? `当前素材 · ${byId('statusBadge').textContent}` : '打开一段视频，开始今天的精听。';
    if (byId('workspaceHint').textContent !== hint) byId('workspaceHint').textContent = hint;
  }
  ['play','pause','loadedmetadata','emptied','timeupdate','error'].forEach(e => video.addEventListener(e, syncPlayer));
  syncPlayer();
  const status = byId('statusBadge');
  new MutationObserver(syncPlayer).observe(status, { childList: true, characterData: true, subtree: true });

  ['btnLoop','btnOverlay','btnEn','btnIpa','btnZh','btnAutoScroll'].forEach(id => {
    const b = byId(id);
    const sync = () => b.setAttribute('aria-pressed', String(b.classList.contains('on')));
    new MutationObserver(sync).observe(b, { attributes: true, attributeFilter: ['class'] }); sync();
  });
  const tabs = [...document.querySelectorAll('.scol .tab')];
  const panels = ['paneSubs','paneVocab','panePaste'];
  document.querySelector('.scol .tabs').setAttribute('role', 'tablist');
  document.querySelector('.scol .tabs').setAttribute('aria-label', '学习笔记');
  function syncTabs() { tabs.forEach(b => { const selected = b.classList.contains('on'); b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1; }); }
  tabs.forEach((b, i) => {
    b.id = `learningTab${i}`; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', panels[i]);
    byId(panels[i]).setAttribute('role', 'tabpanel'); byId(panels[i]).setAttribute('aria-labelledby', b.id);
    new MutationObserver(syncTabs).observe(b, { attributes: true, attributeFilter: ['class'] });
    b.addEventListener('keydown', e => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); const target = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3; tabs[target].click(); tabs[target].focus(); });
  });
  syncTabs();

  const menus = [...document.querySelectorAll('details.appearance-menu')];
  menus.forEach(menu => {
    menu.addEventListener('toggle', () => { menu.querySelector('summary').setAttribute('aria-expanded', String(menu.open)); if (menu.open) menus.filter(m => m !== menu).forEach(m => m.open = false); });
    menu.querySelector('summary').setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', e => menus.forEach(menu => { if (!menu.contains(e.target)) menu.open = false; }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') menus.forEach(m => { if (m.open) { m.open = false; m.querySelector('summary').focus(); } }); });

  // Track only a subtle highlight, with at most one update per animation frame.
  document.querySelectorAll('.topbar, .controls').forEach(surface => {
    let frame = 0;
    surface.addEventListener('pointermove', e => {
      if (root.dataset.reduceMotion === 'true' || root.dataset.reduceTransparency === 'true' || frame) return;
      frame = requestAnimationFrame(() => { const r = surface.getBoundingClientRect(); surface.style.setProperty('--light-x', `${(e.clientX-r.left)/r.width*100}%`); surface.style.setProperty('--light-y', `${(e.clientY-r.top)/r.height*100}%`); frame = 0; });
    }, { passive: true });
  });

  // Shared dialog shell: focus entry, Tab containment, Escape, focus restoration.
  const previousFocus = new WeakMap();
  const focusable = '[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches('.modal')) {
        previousFocus.set(node, document.activeElement);
        node.setAttribute('role','dialog'); node.setAttribute('aria-modal','true');
        const title = node.querySelector('h3,h2'); if (title) node.setAttribute('aria-label', title.textContent);
        const focus = node.querySelector('button,input,select,textarea'); if (focus) focus.focus({ preventScroll: true });
      }
      for (const node of record.removedNodes) if (previousFocus.has(node)) { const target = previousFocus.get(node); if (target?.isConnected) target.focus({ preventScroll: true }); }
    }
  }).observe(document.body, { childList:true });
  document.addEventListener('keydown', e => {
    const dialogs = document.querySelectorAll('.modal'); const dialog = dialogs[dialogs.length-1];
    if (!dialog) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (dialog.closeDialog) dialog.closeDialog(); else dialog.remove(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(focusable)].filter(el => !el.disabled && el.getClientRects().length);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length-1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }, true);
})();
