/* ── ui.js · 界面渲染与交互 ───────────────────────────── */
(function (FM) {
  'use strict';
  const U = FM.util, L = FM.lib, P = FM.player;
  const esc = U.escape, icon = U.icon, fmtT = U.fmtTime, fmtS = U.fmtSize, fmtD = U.fmtDur;

  const state = { view: 'home', cat: null, albumId: null, q: '', detailQ: '', sortDesc: false, showHidden: false, page: 0 };
  const PAGE = 30;   // 专辑声音列表每页集数
  let refs = {};
  let dragId = null;
  let queueOpen = false;
  let scrubbing = false;
  let menuEl = null;
  let menuOff = null;

  const CAT_COLORS = ['#22d3ee', '#a855f7', '#f472b6', '#34d399', '#fbbf24', '#ff8a65', '#60a5fa', '#c084fc'];

  function $(id) { return document.getElementById(id); }

  /* ── 初始化 ── */
  function init() {
    refs = {
      view: $('view'), nav: $('nav'), catList: $('catList'), libStat: $('libStat'),
      topbar: $('topbar'), sidebar: $('sidebar'), drawerMask: $('drawerMask'), btnMenu: $('btnMenu'), brand: $('brand'), brandVer: $('brandVer'),
      libSwitch: $('libSwitch'), libName: $('libName'), libPath: $('libPath'), libBadge: $('libBadge'),
      btnSync: $('btnSync'), btnAddCat: $('btnAddCat'),
      searchInput: $('searchInput'), searchClear: $('searchClear'),
      scanState: $('scanState'), scanStateText: $('scanStateText'),
      linkState: $('linkState'), linkStateText: $('linkStateText'),
      playerbar: $('playerbar'), pbCover: $('pbCover'), pbTitle: $('pbTitle'), pbSub: $('pbSub'), pbFav: $('pbFav'), pbKind: $('pbKind'),
      btnPrev: $('btnPrev'), btnPlay: $('btnPlay'), btnNext: $('btnNext'),
      btnBack15: $('btnBack15'), btnFwd15: $('btnFwd15'),
      pbCur: $('pbCur'), pbDur: $('pbDur'), pbScrub: $('pbScrub'), pbTip: $('pbTip'),
      btnRate: $('btnRate'), btnLoop: $('btnLoop'), btnVol: $('btnVol'), volScrub: $('volScrub'), btnExpand: $('btnExpand'),
      volNum: $('volNum'), vVolNum: $('vVolNum'), btnLogout: $('btnLogout'),
      sheet: $('sheet'), sheetArt: $('sheetArt'), sheetArtImg: $('sheetArtImg'), btnCollapse: $('btnCollapse'),
      sheetCover: $('sheetCover'), sheetDisc: $('sheetDisc'), shTitle: $('shTitle'), shSub: $('shSub'),
      shCur: $('shCur'), shDur: $('shDur'), shScrub: $('shScrub'), shTip: $('shTip'),
      shPlay: $('shPlay'), shPrev: $('shPrev'), shNext: $('shNext'), shBack: $('shBack'), shFwd: $('shFwd'),
      shRate: $('shRate'), shSleep: $('shSleep'), shLoop: $('shLoop'), shFav: $('shFav'),
      media: $('media'), vStage: $('vStage'), vUi: $('vUi'), vTitle: $('vTitle'), vSub: $('vSub'),
      vScrub: $('vScrub'), vTip: $('vTip'), vCur: $('vCur'), vDur: $('vDur'),
      vPlay: $('vPlay'), vPrev: $('vPrev'), vNext: $('vNext'), vRate: $('vRate'),
      vVol: $('vVol'), vVolScrub: $('vVolScrub'), vPip: $('vPip'), vCinema: $('vCinema'), vFull: $('vFull'),
      vCollapse: $('vCollapse'), vQueue: $('vQueue'), vBigPlay: $('vBigPlay'), vLoading: $('vLoading'),
      queuePanel: $('queuePanel'), sheetQueue: $('sheetQueue'), btnSheetQueue: $('btnSheetQueue'),
      btnQueueClose: $('btnQueueClose'), queueCount: $('queueCount'),
      modalRoot: $('modalRoot'), toastRoot: $('toastRoot'),
      main: $('main'), libLoading: $('libLoading'), libLoadingName: $('libLoadingName'), libLoadingHint: $('libLoadingHint')
    };
    state.sortDesc = !!FM.db.state().sortDesc;
    state.showHidden = !!FM.db.state().showHidden;
    if (FM.store.read('sideCollapsed', false)) $('app').classList.add('side-collapsed');
    setMenuState();

    /* 远程模式：断线提示 + 恢复后补刷；未授权时点提示条重连 */
    if (FM.fs.remote) {
      FM.fs.onLink(handleLink);
      if (refs.linkState) {
        refs.linkState.addEventListener('click', function () {
          if (FM.fs.link === 'auth' && FM.fs.desktop) openRemoteDialog();
        });
      }
    }

    bindChrome();
    bindView();
    bindPlayer();
    bindVideo();
    bindKeys();
    bindScrubs();
    window.addEventListener('hashchange', route);

    syncMode();
    renderNav();
    renderCats();
    renderStat();
    if (L.albums().length) { route(); } else { renderWelcome(); }
  }

  /* ── 远程链路提示：断线挂个条，恢复后自动补刷 ── */
  function paintLink(state) {
    const el = refs.linkState, txt = refs.linkStateText;
    if (!el) return;
    if (!FM.fs.remote || !state || state === 'online' || state === 'unknown') { el.hidden = true; return; }
    el.hidden = false;
    const auth = state === 'auth';
    el.classList.toggle('auth', auth);
    txt.textContent = auth ? '远程未授权，点此重连' : '离线，正在重连…';
    el.title = auth ? 'token 可能已失效，重新输入口令' : '网络断开，正在自动重试';
  }

  function handleLink(next, prev) {
    paintLink(next);
    renderStat();          // 侧栏徽标的小圆点跟着在线/离线变色
    if (next !== 'online' || (prev !== 'offline' && prev !== 'auth')) return;
    /* 恢复：本地还有库就补刷一次；一条库都没有说明开机就没连上，直接重载走完整启动 */
    if (!FM.fs.libs().length) { location.reload(); return; }
    toast('已重新连接');
    autoRescan(true);
    renderAll();
  }

  /* ── 通用 UI ── */
  /* ── 下载（只有 APK 有原生下载队列，桌面/浏览器里菜单项和按钮都不出现） ── */
  function canDownload() { return !!(FM.android && FM.android.canDownload); }

  function downloadTracks(list) {
    if (!canDownload()) return;
    if (!list || !list.length) { toast('没有可下载的内容', 'warn'); return; }
    if (!FM.android.download(list)) toast('没排上队，稍后再试', 'warn');
  }

  /* rel → 已下载条目，只有 APK 有；桌面/浏览器拿到空表 */
  function dlMap() {
    return (FM.android && FM.android.downloads) ? FM.android.downloads() : {};
  }

  function dlCount() { return Object.keys(dlMap()).length; }

  /* 某专辑里「已经下完」的曲目（播放/删除只认这些） */
  function dlTracks(albumId) {
    const map = dlMap();
    return L.albumTracks(albumId).filter(function (t) {
      const e = map[t.rel];
      return !!e && (e.state === 'done' || !e.state);
    });
  }

  /* 某专辑里所有有条目的曲目：完成 + 排队 + 下载中 + 失败 */
  function dlAll(albumId) {
    const map = dlMap();
    return L.albumTracks(albumId).filter(function (t) { return !!map[t.rel]; });
  }

  function dlPct(e) {
    if (!e) return 0;
    const total = e.total || e.size || 0;
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.floor((e.loaded || 0) * 100 / total)));
  }

  /* 行尾的状态文案：下载中 42% / 排队中 / 下载失败 / 空（已完成） */
  function dlStateText(e) {
    if (!e || e.state === 'done' || !e.state) return '';
    if (e.state === 'error') return '下载失败';
    if (e.state === 'queued') return '排队中';
    return '下载中 ' + dlPct(e) + '%';
  }

  /* 一组条目的汇总：完成多少、还有几个在跑 */
  function dlSummary(list) {
    const map = dlMap();
    let done = 0, doneSize = 0, active = 0, loaded = 0, total = 0, bad = 0;
    list.forEach(function (t) {
      const e = map[t.rel];
      if (!e) return;
      if (e.state === 'done' || !e.state) { done++; doneSize += e.size || t.size || 0; return; }
      if (e.state === 'error') { bad++; return; }
      active++;
      loaded += e.loaded || 0;
      total += e.total || e.size || t.size || 0;
    });
    return { done: done, size: doneSize, active: active, bad: bad, pct: total > 0 ? Math.floor(loaded * 100 / total) : 0 };
  }

  /* 播放队列只放已下载的曲目 */
  function playDlTracks(albumId, trackId) {
    const list = dlTracks(albumId);
    if (!list.length) { toast('这张专辑还没有下载内容', 'warn'); return; }
    let i = 0;
    if (trackId) i = Math.max(0, list.findIndex(function (t) { return t.id === trackId; }));
    P.setQueue(list, i, { autoplay: true });
  }

  /* 曲名前的已下载图标 */
  function dlFlag(t) {
    if (!t || !FM.android || !FM.android.downloaded || !FM.android.downloaded(t.rel)) return '';
    return '<span class="tk-dl" title="已下载">' + icon('download') + '</span>';
  }

  /* 壳推来「下载有变化」：下载页整页重画，其它页面只补标记，别打断滚动 */
  /* 条目集合 / 状态变了才整页重画；只是进度在动就原地改数字，别把列表抖没 */
  let dlSig = null;
  function dlSignature() {
    const map = dlMap();
    return Object.keys(map).sort().map(function (rel) {
      const e = map[rel];
      return rel + ':' + (e.state || 'done');
    }).join('|');
  }

  function downloadsChanged() {
    const sig = dlSignature();
    const changed = sig !== dlSig;
    dlSig = sig;
    if (state.view === 'downloads' || state.view.indexOf('dl') === 0) {
      if (changed) renderMain();
      else patchDlProgress();
    } else {
      if (changed) syncDownloadFlags();
      if (changed) renderNav();
      return;
    }
    if (changed) renderNav();
  }

  /* 原地刷新进度文案：行上的「下载中 42%」、专辑行上的「下载中 3 集 · 41%」 */
  function patchDlProgress() {
    const map = dlMap();
    U.$$('.dl-state', refs.view).forEach(function (el) {
      const e = map[el.dataset.rel];
      el.textContent = dlStateText(e);
      el.classList.toggle('bad', !!(e && e.state === 'error'));
    });
    U.$$('.dl-live', refs.view).forEach(function (el) {
      const albumId = el.dataset.album;
      const s = dlSummary(dlAll(albumId));
      el.textContent = s.active ? '下载中 ' + s.active + ' 集 · ' + s.pct + '%' : (s.bad ? '有 ' + s.bad + ' 集失败' : '');
    });
  }

  function syncDownloadFlags() {
    const map = dlMap();
    U.$$('.track[data-id]', refs.view).forEach(function (li) {
      const t = L.track(li.dataset.id);
      const main = li.querySelector('.tk-main');
      if (!main) return;
      const host = main.querySelector('.tk-title-row') || main;
      const cur = host.querySelector('.tk-dl');
      const on = !!(t && map[t.rel]);
      if (on && !cur) host.insertAdjacentHTML('afterbegin', dlFlag(t));
      else if (!on && cur) cur.remove();
    });
  }

  function toast(msg, type) {
    const node = U.el('div', { class: 'toast' + (type ? ' ' + type : '') },
      [U.el('span', { html: icon(type === 'warn' ? 'moon' : 'check') }), U.el('span', { text: msg })]);
    refs.toastRoot.appendChild(node);
    setTimeout(function () {
      node.classList.add('out');
      setTimeout(() => node.remove(), 300);
    }, 2400);
  }

  /* 归类写的是桌面端本地的专辑元数据：只有「桌面端 + 本地资源库」能改 */
  function assignBlocked() {
    if (FM.fs.native && !FM.fs.server) return false;
    toast('归类只能在桌面端本地资源库修改', 'warn');
    return true;
  }

  /* 远端只读的其它整理动作（置顶/重命名/隐藏） */
  function readonlyBlocked() {
    if (!FM.fs.server) return false;
    toast('远端只读：整理请在桌面端修改', 'warn');
    return true;
  }

  function closeMenu() {
    if (menuOff) { menuOff(); menuOff = null; }
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }

  function openMenu(anchor, items, opts) {
    const o = opts || {};
    closeMenu();
    const el = U.el('div', { class: 'menu-pop' + (o.cls ? ' ' + o.cls : '') });
    items.forEach(function (it) {
      if (it.sep) { el.appendChild(U.el('div', { class: 'menu-sep' })); return; }
      const b = U.el('button', { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.cls ? ' ' + it.cls : '') });
      b.innerHTML = (o.noIcon ? '' : icon(it.icon || 'chevron')) +
        '<span>' + esc(it.label) + '</span>' +
        (it.right ? '<span class="menu-right">' + icon(it.right) + '</span>' : '');
      b.addEventListener('click', function () { closeMenu(); it.onClick && it.onClick(); });
      el.appendChild(b);
    });
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth, mh = el.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 12);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 6);
    el.style.left = Math.max(12, left) + 'px';
    el.style.top = top + 'px';
    menuEl = el;
    const onDocClick = function (ev) {
      if (!el.contains(ev.target)) closeMenu();
    };
    /* 延后一拍绑定，避免打开菜单的那次点击立刻把它关掉 */
    setTimeout(function () {
      if (menuEl !== el) return;
      document.addEventListener('click', onDocClick);
      menuOff = function () { document.removeEventListener('click', onDocClick); };
    }, 0);
  }

  function openModal(opt) {
    const mask = U.el('div', { class: 'modal-mask' });
    const box = U.el('div', { class: 'modal' + (opt.cls ? ' ' + opt.cls : '') });
    const head = U.el('div', { class: 'modal-head' });
    head.appendChild(U.el('h3', { text: opt.title || '' }));
    const x = U.el('button', { class: 'icon-btn', html: icon('close') });
    x.onclick = close;
    head.appendChild(x);
    const body = U.el('div', { class: 'modal-body' });
    if (typeof opt.body === 'string') body.innerHTML = opt.body; else if (opt.body) body.appendChild(opt.body);
    const foot = U.el('div', { class: 'modal-foot' });
    (opt.actions || []).forEach(function (a) {
      const b = U.el('button', { class: 'btn ' + (a.cls || ''), text: a.label });
      b.onclick = function () { if (a.onClick) { if (a.onClick() === false) return; } close(); };
      foot.appendChild(b);
    });
    box.appendChild(head); box.appendChild(body); box.appendChild(foot);
    mask.appendChild(box);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    refs.modalRoot.appendChild(mask);
    function close() {
      if (!mask.isConnected) return;
      mask.remove();
      if (opt.onClose) opt.onClose();
    }
    setTimeout(function () {
      const inp = body.querySelector('input');
      if (inp) { inp.focus(); inp.select && inp.select(); }
    }, 60);
    return { close, body, box, mask };
  }

  /* 应用内确认框——系统 confirm 的样式和应用完全不搭，统一走这里 */
  function confirmModal(opt) {
    opt = opt || {};
    const body = U.el('div', { class: 'confirm' });
    body.appendChild(U.el('span', {
      class: 'confirm-ico' + (opt.danger ? ' danger' : ''),
      html: icon(opt.icon || (opt.danger ? 'trash' : 'moon'))
    }));
    const txt = U.el('div', { class: 'confirm-txt' });
    txt.appendChild(U.el('p', { class: 'confirm-msg', text: opt.message || '' }));
    if (opt.note) txt.appendChild(U.el('p', { class: 'confirm-note', text: opt.note }));
    body.appendChild(txt);

    return new Promise(function (resolve) {
      let settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      openModal({
        title: opt.title || '请确认',
        body: body,
        actions: [
          { label: opt.cancelText || '取消', cls: 'btn-ghost', onClick: function () { done(false); } },
          { label: opt.okText || '确定', cls: opt.danger ? 'danger' : 'btn-primary', onClick: function () { done(true); } }
        ],
        onClose: function () { done(false); }
      });
    });
  }

  /* ── 侧栏 ── */
  function renderNav() {
    const all = L.albums();
    const favCount = all.filter(a => a.fav && !a.hidden).length;
    const cont = continueList(999).length;
    const recent = recentList(999).length;
    const items = [
      { key: 'home', hash: '#/', label: '首页', icon: 'home', count: all.filter(a => !a.hidden).length },
      { key: 'continue', hash: '#/continue', label: '继续收听', icon: 'clock', count: cont },
      { key: 'recent', hash: '#/recent', label: '最近播放', icon: 'headphones', count: recent },
      { key: 'fav', hash: '#/fav', label: '我的收藏', icon: 'heart', count: favCount }
    ];
    /* 下载管理只存在于 APK：和「我的收藏」一样是个网页视图 */
    if (canDownload()) items.push({ key: 'downloads', hash: '#/downloads', label: '下载管理', icon: 'download', count: dlCount() });
    refs.nav.innerHTML = items.map(function (it) {
      const on = (state.view === it.key || (it.key === 'downloads' && state.view.indexOf('dl') === 0 /* dlAlbum / dlRemove */)) && !state.q;
      return '<button class="nav-item' + (on ? ' active' : '') + '" data-hash="' + it.hash + '">' +
        icon(it.icon) + '<span>' + it.label + '</span>' +
        (it.count ? '<span class="count">' + it.count + '</span>' : '') + '</button>';
    }).join('');
  }

  function renderCats() {
    const cats = L.cats();
    if (!cats.length) {
      refs.catList.innerHTML = '<div class="cat-empty">还没有分类，点右上角 + 新建</div>';
      return;
    }
    refs.catList.innerHTML = cats.map(function (c) {
      const on = state.view === 'cat' && state.cat === c.id;
      return '<div class="cat-item' + (on ? ' active' : '') + '" data-cat="' + c.id + '" style="--cc:' + c.color + '">' +
        '<i class="bullet"></i><span>' + esc(c.name) + '</span>' +
        '<span class="count">' + L.catCount(c.id) + '</span>' +
        '<button class="cat-edit" data-act="edit-cat" data-id="' + c.id + '">' + icon('edit') + '</button></div>';
    }).join('');
  }

  function renderStat() {
    const lib = FM.fs.active();
    const list = FM.fs.libs();
    if (refs.libName) refs.libName.textContent = lib ? lib.name : '选择资源库';
    if (refs.libPath) {
      refs.libPath.textContent = !lib
        ? '点这里添加资源库'
        : (lib.missing ? '资源库目录不存在，点这里处理'
          : (FM.fs.remote
            ? '远程 · ' + (list.length > 1 ? list.length + ' 个资源库' : remoteHost())
            : (list.length > 1 ? list.length + ' 个资源库' : '点击管理资源库')));
    }
    if (refs.libBadge) refs.libBadge.textContent = lib ? (lib.name.slice(0, 1) || '库') : '库';
    if (refs.libSwitch) {
      const link = FM.fs.remote ? FM.fs.link : '';
      refs.libSwitch.classList.toggle('missing', !!(lib && lib.missing));
      refs.libSwitch.classList.toggle('remote', !!FM.fs.remote);
      refs.libSwitch.classList.toggle('link-warn', link === 'offline' || link === 'auth');
    }

    if (lib && lib.missing) {
      refs.libStat.textContent = '资源库目录不存在';
      return;
    }
    if (!L.albums().length) {
      refs.libStat.textContent = lib ? '这个资源库里还没有音频' : '尚未载入资源库';
      return;
    }
    const s = L.stats();
    refs.libStat.innerHTML = s.albums + ' 个专辑 · ' + s.tracks + ' 集<br>' + fmtS(s.size);
  }

  /* 远程服务器去掉协议头的显示名，例如 192.168.1.8:8080 */
  function remoteHost() {
    const r = FM.fs.remote;
    return r ? String(r.base || '').replace(/^https?:\/\//, '') : '';
  }

  function setScanBusy(busy, text) {
    refs.scanState.hidden = !busy;
    if (!text) return;
    refs.scanStateText.textContent = text;
    /* 切库过渡层盖住了顶栏，进度要同步显示在过渡层里 */
    if (refs.libLoadingHint && refs.libLoading && refs.libLoading.classList.contains('show')) {
      refs.libLoadingHint.textContent = text;
    }
  }

  /* ── 路由 ── */
  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const seg = h.split('/').filter(Boolean);
    state.q = '';
    refs.searchInput.value = '';
    refs.searchClear.hidden = true;
    if (!seg.length) { state.view = 'home'; }
    else if (seg[0] === 'album') { state.view = 'album'; state.albumId = seg[1]; }
    else if (seg[0] === 'cat') { state.view = 'cat'; state.cat = seg[1]; }
    else if (seg[0] === 'downloads' && seg[2] === 'more') { state.view = 'dlMore'; state.albumId = seg[1]; }
    else if (seg[0] === 'downloads' && seg[2] === 'remove') { state.view = 'dlRemove'; state.albumId = seg[1]; }
    else if (seg[0] === 'downloads' && seg[1]) { state.view = 'dlAlbum'; state.albumId = seg[1]; }
    else { state.view = seg[0]; }
    if (state.view === 'dlRemove') state.dlSel = {};
    if (state.view === 'dlMore') state.dlMoreSel = {};
    if (state.view.indexOf('dl') === 0 || state.view === 'downloads') {
      if (FM.android && FM.android.refreshDownloads) FM.android.refreshDownloads();
    }
    state.detailQ = '';
    state.page = 0;
    renderMain();
    renderNav();
    renderCats();
    refs.view.scrollTop = 0;
  }

  function renderMain(opts) {
    const quiet = !!(opts && opts.quiet);
    const v = refs.view;
    v.innerHTML = '';
    if (!L.albums().length) { renderWelcome(); return; }
    let node;
    if (state.q) node = viewSearch(state.q);
    else if (state.view === 'album') node = viewAlbum(state.albumId);
    else if (state.view === 'cat') node = viewCat(state.cat);
    else if (state.view === 'fav') node = viewGridPage('我的收藏', '收藏的专辑会出现在这里', L.allAlbums({ fav: true, showHidden: state.showHidden }));
    else if (state.view === 'downloads') node = viewDownloads();
    else if (state.view === 'dlAlbum') node = viewDlAlbum(state.albumId);
    else if (state.view === 'dlRemove') node = viewDlRemove(state.albumId);
    else if (state.view === 'dlMore') node = viewDlMore(state.albumId);
    else if (state.view === 'continue') node = viewContinue();
    else if (state.view === 'recent') node = viewRecent();
    else node = viewHome();
    if (node) {
      /* 后台静默刷新：别让整页再播一遍入场动画，看起来像"跳"了一下 */
      if (quiet) node.style.animation = 'none';
      v.appendChild(node);
    }
    observeCards(v, quiet);
    applyPlayingState(v);
    if (state.view === 'album' && !state.q && state.albumId) {
      probeDurations(L.albumTracks(state.albumId));
    } else {
      probeToken++;
    }
  }

  /* ── 专辑卡片 ── */
  function initialOf(a) { return U.initials(a.title, true); }
  function albumType(a) { return a.videoCount ? '视频' : '本地有声书'; }

  function albumCard(a) {
    const st = L.albumStat(a);
    const pct = st.pct;
    const done = a.count > 0 && st.doneCount >= a.count;
    const badges = [];
    if (done) badges.push('<span class="card-badge done">已听完</span>');
    const tags = (a.tags && a.tags.length) ? a.tags.join(' · ') : albumType(a);
    const initial = initialOf(a);
    const countLabel = a.videoCount === a.count ? a.count + ' 视频' : a.count + ' 集' + (a.videoCount ? ' · ' + a.videoCount + ' 视频' : '');
    const art = a.cover
      ? '<img class="cover-img" src="' + esc(a.cover) + '" alt="">'
      : '<div class="rings"><i></i><i></i><i></i></div><span class="card-char' + (initial.length > 2 ? ' word' : '') + '">' + esc(initial) + '</span>';
    return '<article class="card' + (a.fav ? ' fav' : '') + '" data-id="' + a.id + '" draggable="true" style="' +
      U.coverVars(a.seed) + '">' +
      '<div class="card-cover' + (a.cover ? ' has-photo' : '') + '">' +
        art +
        (a.fav ? '<span class="card-fav" title="已收藏">' + icon('heart-fill') + '</span>' : '') +
        badges.join('') +
        '<button class="card-play" data-act="play-album" data-id="' + a.id + '" title="播放全部">' + icon('play') + '</button>' +
      '</div>' +
      '<div class="card-body">' +
        '<h3 class="card-title" title="' + esc(a.title) + '">' + esc(a.title) + '</h3>' +
        '<div class="card-tags">' + esc(tags) + '</div>' +
        '<div class="card-foot"><span>' + countLabel + '</span><span class="dot"></span><span>' + fmtS(a.size) + '</span><span class="dot"></span><span>' + pct + '%</span></div>' +
        '<div class="card-prog"><i style="width:' + pct + '%"></i></div>' +
      '</div>' +
    '</article>';
  }

  function gridHtml(list) {
    if (!list.length) {
      return '<div class="empty"><div class="empty-art">' + icon('folder') + '</div>' +
        '<h3>这里还没有专辑</h3><p>换个分类看看，或把专辑卡片拖到左侧分类里。</p></div>';
    }
    return '<div class="grid">' + list.map(albumCard).join('') + '</div>';
  }

  /* ── 各个视图 ── */
  /* 展示用的库名：优先用资源库的显示名（重命名后跟着变），退回扫描到的目录名 */
  function libLabel() {
    const lib = FM.fs.active();
    return (lib && lib.name) || L.rootName || '本地资源库';
  }

  function viewHome() {
    const all = L.allAlbums({ showHidden: state.showHidden });
    const s = L.stats();
    const wrap = U.el('div');
    const hiddenCount = L.albums().filter(a => a.hidden).length;

    const head = '<div class="view-head"><div>' +
      '<div class="page-title">全部专辑<span class="accent"> · </span><span style="font-size:14px;color:var(--dim);font-weight:500">' + esc(libLabel()) + '</span></div>' +
      '<div class="page-sub">' + s.albums + ' 个专辑 · ' + s.tracks + ' 集 · ' + fmtS(s.size) +
        (s.done ? ' · 已听完 ' + s.done + ' 集' : '') + '</div></div></div>';


    let resume = '';
    const cont = continueList(1)[0];
    if (cont) {
      const a = L.album(cont.albumId);
      const p = L.progressOf(cont.id) || {};
      const d = p.d || cont.duration || 0;
      const pct = d ? Math.min(100, Math.round((p.p || 0) / d * 100)) : 0;
      if (a) {
        resume = '<div class="resume-card" style="' + U.coverVars(a.seed) + '">' +
          '<div class="resume-cover" data-act="open-album" data-id="' + a.id + '" title="查看专辑">' + (a.cover
            ? '<img class="cover-img" src="' + esc(a.cover) + '" alt="">'
            : '<span>' + esc(initialOf(a)) + '</span>') + '</div>' +
          '<div class="resume-body">' +
            '<div class="resume-kicker">继续收听</div>' +
            '<div class="resume-title">' + esc(cont.title) + '</div>' +
            '<div class="resume-sub">' + esc(a.title) + ' · 上次听到 ' + fmtT(p.p || 0) + (d ? ' / ' + fmtT(d) : '') + ' · ' + U.fmtAgo(p.t) + '</div>' +
            '<div class="resume-bar"><i style="width:' + pct + '%"></i></div>' +
          '</div>' +
          '<div class="resume-actions">' +
            '<button class="btn btn-primary" data-act="resume" data-id="' + cont.id + '">' + icon('play') + '继续播放</button>' +
          '</div></div>';
      }
    }

    const hiddenLink = hiddenCount
      ? '<div style="margin-top:22px;text-align:center"><button class="link-btn" data-act="toggle-hidden">' + (state.showHidden ? '隐藏 ' : '显示 ') + hiddenCount + ' 个已隐藏专辑</button></div>'
      : '';

    wrap.innerHTML = head + resume +
      (all.length ? gridHtml(all) : '') + hiddenLink;
    return wrap;
  }

  function viewGridPage(title, sub, list) {
    const wrap = U.el('div');
    wrap.innerHTML = '<div class="view-head"><div>' +
      '<div class="page-title">' + esc(title) + '</div>' +
      '<div class="page-sub">' + esc(sub) + '</div></div></div>' +
      (list.length ? gridHtml(list) : '<div class="empty"><div class="empty-art">' + icon('heart') + '</div>' +
        '<h3>还是空的</h3><p>在专辑卡片右上角或详情页点收藏，就会出现在这里。</p></div>');
    return wrap;
  }

  function viewCat(catId) {
    const cat = L.cats().find(c => c.id === catId);
    if (!cat) return viewGridPage('分类不存在', '该分类可能已被删除', L.albums());
    const list = L.allAlbums({ cat: catId, showHidden: state.showHidden });
    const wrap = U.el('div');
    wrap.innerHTML = '<div class="view-head"><div>' +
      '<div class="page-title"><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + cat.color + ';box-shadow:0 0 14px ' + cat.color + '"></i>' + esc(cat.name) + '</div>' +
      '<div class="page-sub">' + list.length + ' 个专辑</div></div>' +
      '<div class="head-actions"><button class="btn btn-ghost" data-act="edit-cat" data-id="' + cat.id + '">' + icon('edit') + '编辑分类</button></div></div>' +
      (list.length ? gridHtml(list) : '<div class="empty"><div class="empty-art">' + icon('grid') + '</div>' +
        '<h3>这个分类还没有专辑</h3><p>把首页的专辑卡片拖到这里，或点击专辑详情页的「归类」按钮。</p></div>');
    return wrap;
  }

  /* 下载管理：占了多少 / 还剩多少 + 有下载内容的专辑列表（至少下一集才算） */
  function viewDownloads() {
    /* 有下载记录的专辑都进来：正在下的也算，别等下完才出现 */
    const albums = L.allAlbums({ showHidden: state.showHidden }).map(function (a) {
      const tracks = dlAll(a.id);
      return { album: a, tracks: tracks, sum: dlSummary(tracks) };
    }).filter(function (x) { return x.tracks.length > 0; });

    let used = 0, count = 0, running = 0;
    albums.forEach(function (x) { used += x.sum.size; count += x.sum.done; running += x.sum.active; });
    const free = (FM.android && FM.android.freeSpace) ? FM.android.freeSpace() : 0;

    const wrap = U.el('div');
    wrap.innerHTML = '<div class="view-head"><div>' +
      '<div class="page-title">下载管理</div>' +
      '<div class="page-sub">' + albums.length + ' 个专辑 · ' + count + ' 集' +
        (running ? ' · 下载中 ' + running : '') + '</div></div>' +
      '<div class="head-actions"><button class="btn btn-ghost" data-act="open-downloads">' + icon('download') + '管理 / 删除</button></div></div>' +
      (albums.length ? '<div class="dl-sum">' +
          '<b>已占用 ' + fmtS(used) + '</b>' +
          '<span>/ 可用 ' + (free > 0 ? fmtS(free) : '未知') + '</span>' +
        '</div>' +
        '<div class="dl-list">' + albums.map(dlAlbumRow).join('') + '</div>'
        : '<div class="empty"><div class="empty-art">' + icon('download') + '</div><h3>还没有下载</h3>' +
          '<p>在专辑菜单点「下载全部」，或单集菜单点「下载」，下完的内容会出现在这里。</p></div>');
    return wrap;
  }

  /* 下载管理的「更多」只给两件事：播放、删掉这张的下载 */
  function dlAlbumMenu(id, anchor) {
    const a = L.album(id);
    if (!a) return;
    /* 排队中和在途的也算：删了要连下载一起停掉，不能只删已完成的那几个 */
    const mine = dlAll(id);
    const doneCount = dlTracks(id).length;
    openMenu(anchor, [
      { label: '播放全部', icon: 'play', onClick: function () { go('#/downloads/' + id); playDlTracks(id); } },
      { sep: true },
      {
        label: '删除', icon: 'trash', danger: true, onClick: function () {
          if (!mine.length) { toast('这张专辑没有下载内容', 'warn'); return; }
          confirmModal({
            title: '删除这张专辑的下载？',
            message: '「' + a.title + '」的 ' + mine.length + ' 集下载会停掉' +
              (doneCount ? '，已下的 ' + doneCount + ' 集文件从手机里删掉' : '') + '。',
            note: '想再听可以重新下载，播放记录不受影响。',
            danger: true, okText: '删除'
          }).then(function (ok) {
            if (!ok) return;
            if (!(FM.android && FM.android.canRemoveMany)) { toast('App 版本太旧，更新 APK 后才能删除', 'warn'); return; }
            if (!FM.android.removeDownloads(mine.map(function (t) { return t.rel; }))) { toast('删除失败，重试一次', 'warn'); return; }
            toast('已删除 ' + mine.length + ' 集');
            downloadsChanged();
          });
        }
      }
    ]);
  }

  /* 下载管理里的一行：封面 + 专辑名 + 大小/集数 + 更多 */
  function dlAlbumRow(x) {
    const a = x.album;
    const s = x.sum;
    const live = s.active ? '<span class="dl-live" data-album="' + a.id + '">下载中 ' + s.active + ' 集 · ' + s.pct + '%</span>'
      : (s.bad ? '<span class="dl-live" data-album="' + a.id + '">有 ' + s.bad + ' 集失败</span>' : '');
    const art = a.cover
      ? '<img src="' + esc(a.cover) + '" alt="">'
      : '<span class="dl-char' + (initialOf(a).length > 2 ? ' word' : '') + '">' + esc(initialOf(a)) + '</span>';
    return '<div class="dl-item" data-act="open-dl-album" data-id="' + a.id + '">' +
      '<span class="dl-cover" style="' + U.coverVars(a.seed) + '">' + art + '</span>' +
      '<span class="dl-body">' +
        '<span class="dl-title" title="' + esc(a.title) + '">' + esc(a.title) + '</span>' +
        '<span class="dl-meta">' +
          '<span>' + icon('folder') + fmtS(s.size) + '</span>' +
          '<span>' + icon('headphones') + s.done + ' 集' +
            (s.done < a.count ? '（共 ' + a.count + '）' : '') + '</span>' +
          live +
        '</span>' +
      '</span>' +
      '<button class="dl-more" data-act="dl-menu" data-id="' + a.id + '" title="更多">' + icon('more') + '</button>' +
    '</div>';
  }

  /* 下载详情：只列这张专辑里下过的曲目 */
  function viewDlAlbum(id) {
    const a = L.album(id);
    if (!a) return viewGridPage('专辑不存在', '可能已被移除，请重新扫描资源库', L.albums());
    /* 排队和正在下的也列出来，用户能看到队列在动 */
    const mine = dlAll(id);
    const done = dlTracks(id);
    const sum = dlSummary(mine);
    const missing = Math.max(0, a.count - mine.length);
    const last = lastPlayed(done);
    const wrap = U.el('div');
    wrap.innerHTML =
      '<div class="view-head" style="padding:10px 2px 0"><button class="link-btn" data-act="back">← 返回</button>' +
        '<div class="head-actions"><button class="btn btn-ghost" data-act="open-downloads">' + icon('download') + '下载任务</button></div></div>' +
      '<div class="dl-hero">' +
        '<span class="dl-cover lg" style="' + U.coverVars(a.seed) + '">' + coverArt(a) + '</span>' +
        '<div class="dl-hero-body">' +
          '<div class="dl-hero-title">' + esc(a.title) + '</div>' +
          '<div class="dl-hero-sub">已下载 ' + done.length + ' 条 / 共 ' + a.count + ' 条' +
            (sum.size ? ' · ' + fmtS(sum.size) : '') +
            (sum.active ? ' · 下载中 ' + sum.active + ' 条 ' + sum.pct + '%' : '') + '</div>' +
        '</div>' +
        (missing > 0 ? '<button class="btn btn-primary dl-hero-btn" data-act="dl-more-page" data-id="' + a.id + '">下载更多</button>' : '') +
      '</div>' +
      '<div class="dl-tools">' +
        '<button class="dl-tool" data-act="dl-batch" data-id="' + a.id + '">' + icon('trash') + '批量删除</button>' +
        '<button class="dl-tool" data-act="play-dl" data-id="' + a.id + '">' + icon('play') + '播放全部</button>' +
        '<span class="dl-tool-count">' + (sum.active ? done.length + ' / ' + mine.length + ' 集' : mine.length + ' 集') + '</span>' +
      '</div>' +
      (last ? '<div class="dl-resume" data-act="row-play-dl" data-id="' + last.id + '">' + icon('play') + '继续播放：' + esc(last.title) + '</div>' : '') +
      (mine.length
        ? '<div class="dl-tracks">' + mine.map(dlRow).join('') + '</div>'
        : '<div class="empty"><div class="empty-art">' + icon('download') + '</div><h3>这一集都没下</h3>' +
          '<p>点上面「下载更多」把整张下下来。</p></div>');
    return wrap;
  }

  /* 封面：有图用图，没图用首字 */
  function coverArt(a) {
    return a.cover
      ? '<img src="' + esc(a.cover) + '" alt="">'
      : '<span class="dl-char' + (initialOf(a).length > 2 ? ' word' : '') + '">' + esc(initialOf(a)) + '</span>';
  }

  /* 最近在听、还没听完的那一集 */
  function lastPlayed(list) {
    let pick = null, at = 0;
    list.forEach(function (t) {
      const p = L.progressOf(t.id);
      if (!p || p.done || !p.t) return;
      if (p.t > at) { at = p.t; pick = t; }
    });
    return pick;
  }

  /* 下载详情的曲目行：序号 + 标题 + 时长/大小/进度，右侧删除 */
  function dlRow(t) {
    const it = dlMap()[t.rel] || {};
    const p = L.progressOf(t.id);
    const dur = t.duration || (p && p.d) || 0;
    const pct = p && dur ? Math.min(100, Math.round((p.p || 0) / dur * 100)) : 0;
    const playing = P.current && P.current.id === t.id;
    /* 还没下完的不能点播：本地没文件，硬播会跳到别的集 */
    const ready = !it.state || it.state === 'done';
    return '<li class="track dl-track' + (playing ? ' playing' : '') + '" data-id="' + t.id +
      '" data-act="' + (ready ? 'row-play-dl' : 'dl-wait') + '">' +
      '<span class="dl-idx">' + (t.order + 1) + '</span>' +
      '<div class="dl-tk">' +
        '<div class="dl-tk-title">' + esc(t.title) + (p && p.done ? '<span class="tk-flag">已听</span>' : '') + '</div>' +
        '<div class="dl-tk-meta">' +
          '<span>' + icon('clock') + (dur ? fmtT(dur) : '—') + '</span>' +
          '<span>' + icon('folder') + fmtS(it.size || t.size) + '</span>' +
          (pct > 0 && !(p && p.done) ? '<span class="dl-pct">已播 ' + pct + '%</span>' : '') +
          '<span class="dl-state' + (it.state === 'error' ? ' bad' : '') + '" data-rel="' + t.rel + '">' + dlStateText(it) + '</span>' +
        '</div>' +
      '</div>' +
      '<button class="dl-del" data-act="dl-remove" data-id="' + t.id + '" title="删除下载">' + icon('trash') + '</button>' +
    '</li>';
  }

  /* 批量下载页：按 20 集分组，组可一键下，也可勾选后底部一次下 */
  function viewDlMore(id) {
    const a = L.album(id);
    if (!a) return viewGridPage('专辑不存在', '可能已被移除，请重新扫描资源库', L.albums());
    const map = dlMap();
    const pend = L.albumTracks(id).filter(function (t) { return !map[t.rel]; });
    const sel = state.dlMoreSel || {};
    const picked = pend.filter(function (t) { return !!sel[t.id]; });
    const need = picked.reduce(function (n, t) { return n + (t.size || 0); }, 0);
    const free = (FM.android && FM.android.freeSpace) ? FM.android.freeSpace() : 0;
    const allOn = pend.length > 0 && picked.length === pend.length;
    const tight = need > 0 && free > 0 && need > free;

    /* 20 集一组，组头带总大小和一键下载 */
    const groups = [];
    for (let i = 0; i < pend.length; i += 20) groups.push(pend.slice(i, i + 20));

    const head = pend.length
      ? '<div class="dl-filter">' +
          '<span>未下载 ' + pend.length + ' 集</span>' +
          '<button class="dl-chip' + (allOn ? ' on' : '') + '" data-act="dl-more-all">' + (allOn ? '取消全选' : '全选') + '</button>' +
        '</div>' +
        groups.map(dlGroup).join('')
      : '<div class="empty"><div class="empty-art">' + icon('download') + '</div><h3>已经全下完了</h3>' +
        '<p>这张专辑没有待下载的集。</p></div>';

    const wrap = U.el('div');
    wrap.innerHTML =
      '<div class="dl-page-head"><button class="link-btn" data-act="back">← 返回</button>' +
        '<span class="dl-page-title">批量下载</span><span class="dl-page-spare"></span></div>' +
      (tight ? '<div class="dl-warn">手机空间可能不够，建议少选几集。</div>' : '') +
      head +
      (pend.length
        ? '<div class="dl-bar dl-bar-col">' +
            '<div class="dl-bar-row">' +
              '<button class="dl-bar-btn" data-act="dl-mine">我的下载</button>' +
              '<button class="dl-bar-btn primary" data-act="dl-more-go" data-id="' + a.id + '"' + (picked.length ? '' : ' disabled') + '>选集下载' +
                (picked.length ? '（' + picked.length + '）' : '') + '</button>' +
            '</div>' +
            '<div class="dl-bar-note">预计占用 ' + fmtS(need) + ' 空间 / 剩余 ' + (free > 0 ? fmtS(free) : '未知') + ' 可用</div>' +
          '</div>'
        : '');
    return wrap;
  }

  /* 一组（20 集）：组头 + 曲目行 */
  function dlGroup(list) {
    const size = list.reduce(function (n, t) { return n + (t.size || 0); }, 0);
    const ids = list.map(function (t) { return t.id; }).join(',');
    const sel = state.dlMoreSel || {};
    const label = '第 ' + (list[0].order + 1) + ' 集 - 第 ' + (list[list.length - 1].order + 1) + ' 集';
    return '<div class="dl-group">' +
      '<div class="dl-group-head">' +
        '<span class="dl-group-name">' + label + '</span>' +
        '<span class="dl-group-size">' + icon('folder') + fmtS(size) + '</span>' +
        '<button class="dl-group-go" data-act="dl-more-group" data-ids="' + ids + '" title="下载这一组">' + icon('download') + '</button>' +
      '</div>' +
      list.map(function (t) { return dlSelRow(t, !!sel[t.id], 'dl-more-toggle'); }).join('') +
    '</div>';
  }


  /* 批量删除页：勾选 → 底部删除 */
  function viewDlRemove(id) {
    const a = L.album(id);
    if (!a) return viewGridPage('专辑不存在', '可能已被移除，请重新扫描资源库', L.albums());
    const map = dlMap();
    const mine = L.albumTracks(id).filter(function (t) { return !!map[t.rel]; });
    const sel = state.dlSel || {};
    const size = mine.reduce(function (n, t) {
      const it = map[t.rel];
      return n + ((it && it.size) || t.size || 0);
    }, 0);
    const free = (FM.android && FM.android.freeSpace) ? FM.android.freeSpace() : 0;
    const picked = mine.filter(function (t) { return !!sel[t.id]; });
    const doneList = mine.filter(function (t) { const p = L.progressOf(t.id); return !!(p && p.done); });
    const allOn = mine.length > 0 && picked.length === mine.length;
    const doneOn = doneList.length > 0 && doneList.every(function (t) { return !!sel[t.id]; });
    const wrap = U.el('div');
    wrap.innerHTML =
      '<div class="dl-page-head"><button class="link-btn" data-act="back">← 返回</button>' +
        '<span class="dl-page-title">批量删除</span><span class="dl-page-spare"></span></div>' +
      '<div class="dl-sum"><b>已占用 ' + fmtS(size) + '</b><span>/ 可用 ' + (free > 0 ? fmtS(free) : '未知') + '</span></div>' +
      '<div class="dl-sel-head">' +
        '<button class="dl-ck-item" data-act="dl-sel-all">' + ck(allOn) + '全选</button>' +
        '<button class="dl-ck-item" data-act="dl-sel-done">' + ck(doneOn) + '选择已听完</button>' +
      '</div>' +
      '<div class="dl-tracks">' + mine.map(function (t) { return dlSelRow(t, !!sel[t.id]); }).join('') + '</div>' +
      '<div class="dl-bar">' +
        '<button class="dl-bar-btn" data-act="back">取消</button>' +
        '<button class="dl-bar-btn danger" data-act="dl-del-selected" data-id="' + a.id + '"' + (picked.length ? '' : ' disabled') + '>删除' +
          (picked.length ? '（' + picked.length + '）' : '') + '</button>' +
      '</div>';
    return wrap;
  }

  function ck(on) { return '<span class="dl-ck' + (on ? ' on' : '') + '">' + (on ? icon('check') : '') + '</span>'; }

  function dlSelRow(t, on, act) {
    const it = dlMap()[t.rel] || {};
    const p = L.progressOf(t.id);
    const dur = t.duration || (p && p.d) || 0;
    const pct = p && dur ? Math.min(100, Math.round((p.p || 0) / dur * 100)) : 0;
    const playing = P.current && P.current.id === t.id;
    return '<li class="track dl-track dl-sel' + (playing ? ' playing' : '') + (on ? ' on' : '') + '" data-id="' + t.id + '" data-act="' + (act || 'dl-toggle') + '">' +
      ck(on) +
      '<span class="dl-idx">' + (t.order + 1) + '</span>' +
      '<div class="dl-tk">' +
        '<div class="dl-tk-title">' + esc(t.title) + '</div>' +
        '<div class="dl-tk-meta">' +
          '<span>' + icon('clock') + (dur ? fmtT(dur) : '—') + '</span>' +
          '<span>' + icon('folder') + fmtS(it.size || t.size) + '</span>' +
          (pct > 0 ? '<span class="dl-pct">已播 ' + pct + '%</span>' : '') +
          '<span class="dl-state' + (it.state === 'error' ? ' bad' : '') + '" data-rel="' + t.rel + '">' + dlStateText(it) + '</span>' +
        '</div>' +
      '</div>' +
    '</li>';
  }

  function viewContinue() {
    const list = continueList(60);
    const wrap = U.el('div');
    wrap.innerHTML = '<div class="view-head"><div><div class="page-title">继续收听</div>' +
      '<div class="page-sub">没听完的内容都在这儿，点一下接着放</div></div></div>' +
      (list.length ? '<div class="track-list">' + list.map(t => flatTrack(t)).join('') + '</div>'
        : '<div class="empty"><div class="empty-art">' + icon('clock') + '</div><h3>没有未听完的内容</h3><p>去首页挑一个专辑开始吧。</p></div>');
    return wrap;
  }

  function viewRecent() {
    const list = recentList(80);
    const wrap = U.el('div');
    wrap.innerHTML = '<div class="view-head"><div><div class="page-title">最近播放</div>' +
      '<div class="page-sub">按时间倒序</div></div></div>' +
      (list.length ? '<div class="track-list">' + list.map(t => flatTrack(t)).join('') + '</div>'
        : '<div class="empty"><div class="empty-art">' + icon('headphones') + '</div><h3>还没有播放记录</h3><p>播放过的单集会记录在这里。</p></div>');
    return wrap;
  }

  function viewSearch(q) {
    const res = L.search(q);
    const wrap = U.el('div');
    wrap.innerHTML = '<div class="view-head"><div><div class="page-title">搜索 “' + esc(q) + '”</div>' +
      '<div class="page-sub">命中 ' + res.albums.length + ' 个专辑 · ' + res.tracks.length + ' 集</div></div></div>' +
      (res.albums.length ? '<div class="section-head"><div class="section-title">专辑</div></div>' + gridHtml(res.albums) : '') +
      (res.tracks.length ? '<div class="section-head" style="margin-top:26px"><div class="section-title">单集</div></div>' +
        '<div class="track-list">' + res.tracks.slice(0, 200).map(t => flatTrack(t)).join('') + '</div>' : '') +
      (!res.albums.length && !res.tracks.length ? '<div class="empty"><div class="empty-art">' + icon('search') + '</div><h3>没有找到相关内容</h3><p>换个关键词，或检查资源库是否已授权。</p></div>' : '');
    return wrap;
  }

  /* ── 专辑详情 ── */
  function viewAlbum(id) {
    const a = L.album(id);
    if (!a) return viewGridPage('专辑不存在', '可能已被移除，请重新扫描资源库', L.albums());
    const st = L.albumStat(a);
    const filtered = albumTracksFiltered(a);
    const pg = pageSlice(filtered);
    const cats = L.cats().filter(c => a.cats.indexOf(c.id) >= 0);
    const catTags = cats.map(c => '<span class="tag cat">' + esc(c.name) + '</span>').join('');
    const tagHtml = a.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('');
    const done = a.count > 0 && st.doneCount >= a.count;
    /* 归类只写桌面端本地元数据：非桌面/远端模式不渲染这个按钮（收藏不受限） */
    const assignBtn = (FM.fs.native && !FM.fs.server) ?
      '<button class="btn" data-act="assign" data-id="' + a.id + '">' + icon('folder') + '归类</button>' : '';

    const wrap = U.el('div');
    wrap.innerHTML =
      '<div class="view-head" style="padding:10px 2px 0"><button class="link-btn" data-act="back">← 返回</button>' +
        '<div class="head-actions"><button class="btn btn-ghost" data-act="more-album" data-id="' + a.id + '">' + icon('more') + '更多</button></div></div>' +
      '<section class="album-hero" style="' + U.coverVars(a.seed) + '">' +
        '<div class="hero-cover' + (a.cover ? ' has-photo' : '') + '">' +
          (a.cover ? '<img class="cover-img" src="' + esc(a.cover) + '" alt="">' : '<span class="card-char' + (initialOf(a).length > 2 ? ' word' : '') + '">' + esc(initialOf(a)) + '</span>') +
        '</div>' +
        '<div class="hero-info">' +
          '<div class="hero-heading">' +
            '<div class="hero-kicker">ALBUM · ' + albumType(a) + '</div>' +
            '<h1 class="hero-title" title="' + esc(a.title) + '">' + esc(a.title) + '</h1>' +
            '<div class="hero-tags">' + catTags + tagHtml + '</div>' +
          '</div>' +
          '<div class="hero-meta"><span>' + a.count + ' 集</span><span class="dot"></span><span>' + fmtS(a.size) + '</span>' +
            (st.dur ? '<span class="dot"></span><span>' + fmtD(st.dur) + '</span>' : '') +
            '<span class="dot"></span><span>已听 ' + st.pct + '%</span>' +
            (done ? '<span class="dot"></span><span style="color:#7ef7d0">已听完</span>' : '') + '</div>' +
          '<div class="hero-actions">' +
            '<button class="btn btn-primary" data-act="album-play" data-id="' + a.id + '">' + icon(albumPlayLabel(a).icon) + albumPlayLabel(a).text + '</button>' +
            '<button class="btn" data-act="queue-album" data-id="' + a.id + '">' + icon('list') + '加入队列</button>' +
            '<button class="btn' + (a.fav ? ' danger' : '') + '" data-act="fav" data-id="' + a.id + '">' + icon(a.fav ? 'heart-fill' : 'heart') + (a.fav ? '已收藏' : '收藏') + '</button>' +
            assignBtn +
          '</div>' +
        '</div>' +
      '</section>' +
      '<div class="track-toolbar">' +
        '<div class="tk-search">' + icon('search') + '<input id="tkSearch" placeholder="在本专辑中搜索…" value="' + esc(state.detailQ) + '"></div>' +
        '<button class="chip" data-act="sort">' + icon('sort') + (state.sortDesc ? '倒序' : '正序') + '</button>' +
        '<span class="tk-count">' + filtered.length + ' / ' + a.count + ' 集</span>' +
      '</div>' +
      '<div class="track-list" id="trackList">' + pg.items.map(t => trackRow(t)).join('') + '</div>' +
      '<div id="trackPager">' + pagerHtml(filtered.length) + '</div>';

    return wrap;
  }

  function sortedTracks(a) {
    const list = L.albumTracks(a.id).slice();
    if (state.sortDesc) list.reverse();
    return list;
  }

  function albumTracksFiltered(a) {
    const list = sortedTracks(a);
    if (!state.detailQ) return list;
    const key = state.detailQ.toLowerCase();
    return list.filter(t => t.title.toLowerCase().indexOf(key) >= 0);
  }

  /* 分页：页码越界时自动收敛，避免筛选后停在不存在的页 */
  function pageSlice(list) {
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    state.page = Math.min(Math.max(0, state.page), pages - 1);
    const from = state.page * PAGE;
    return { items: list.slice(from, from + PAGE), from: from, pages: pages };
  }

  function pagerHtml(total) {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    if (pages <= 1) return '';
    const page = state.page;
    const from = page * PAGE + 1;
    const to = Math.min(total, (page + 1) * PAGE);
    const nums = [];
    const lo = Math.max(0, page - 2), hi = Math.min(pages - 1, page + 2);
    for (let i = lo; i <= hi; i++) {
      nums.push('<button class="page-btn' + (i === page ? ' on' : '') + '" data-act="page" data-page="' + i + '">' + (i + 1) + '</button>');
    }
    const arrow = function (n, label, off) {
      return '<button class="page-btn arrow" data-act="page" data-page="' + n + '"' + (off ? ' disabled' : '') + '>' + label + '</button>';
    };
    return '<div class="track-pager">' +
      '<span class="pg-info">第 ' + from + '–' + to + ' 集 · 共 ' + total + ' 集</span>' +
      '<div class="pg-ctl">' + arrow(page - 1, '‹', page === 0) + nums.join('') + arrow(page + 1, '›', page === pages - 1) + '</div>' +
    '</div>';
  }

  function trackRow(t) {
    const p = L.progressOf(t.id);
    const playing = P.current && P.current.id === t.id;
    const dur = t.duration || (p && p.d) || 0;
    const flag = p && p.done ? '<span class="tk-flag">已听</span>' : '';
    const vid = t.kind === 'video' ? '<span class="tk-flag vid">' + icon('video') + '视频</span>' : '';
    const prog = (!p || !p.done) && p && p.p > 5 && dur
      ? '<span class="tk-prog">' + fmtT(p.p) + ' / ' + fmtT(dur) + '</span>' : '';
    return '<li class="track' + (playing ? ' playing' : '') + '" data-id="' + t.id + '" data-album="' + t.albumId + '">' +
      '<span class="tk-idx">' + (t.order + 1) + '</span>' +
      '<span class="tk-eq"><i></i><i></i><i></i></span>' +
      '<div class="tk-main">' + dlFlag(t) + '<span class="tk-name" title="' + esc(t.title) + '">' + esc(t.title) + '</span>' + vid + flag + '</div>' +
      prog +
      '<button class="tk-play" data-act="row-play" data-id="' + t.id + '" title="' + (playing && P.playing ? '暂停' : '播放这一集') + '">' +
        icon(playing && P.playing ? 'pause' : 'play') + '</button>' +
      '<span class="tk-dur">' + (dur ? fmtT(dur) : '—') + '</span>' +
      '<button class="tk-more" data-act="more-track" data-id="' + t.id + '">' + icon('more') + '</button>' +
    '</li>';
  }

  function flatTrack(t) {
    const a = L.album(t.albumId);
    const p = L.progressOf(t.id);
    const dur = t.duration || (p && p.d) || 0;
    const playing = P.current && P.current.id === t.id;
    const pct = p && dur ? Math.min(100, Math.round((p.p || 0) / dur * 100)) : 0;
    const sub = (t.kind === 'video' ? '视频 · ' : '') + (a ? a.title : '') + (p && p.t ? ' · ' + U.fmtAgo(p.t) : '');
    return '<li class="track' + (playing ? ' playing' : '') + '" data-id="' + t.id + '" data-album="' + t.albumId + '">' +
      '<span class="tk-idx">' + (t.order + 1) + '</span>' +
      '<span class="tk-eq"><i></i><i></i><i></i></span>' +
      '<div class="tk-main" style="flex-direction:column;align-items:flex-start;gap:3px">' +
        '<span class="tk-title-row">' + dlFlag(t) + '<span class="tk-name" title="' + esc(t.title) + '">' + esc(t.title) + '</span></span>' +
        '<span style="font-size:10.5px;color:var(--dim-2)">' + esc(sub) + '</span>' +
      '</div>' +
      (pct ? '<span class="tk-prog">' + pct + '%</span>' : '') +
      '<button class="tk-play" data-act="row-play" data-id="' + t.id + '" title="' + (playing && P.playing ? '暂停' : '播放这一集') + '">' +
        icon(playing && P.playing ? 'pause' : 'play') + '</button>' +
      '<span class="tk-dur">' + (dur ? fmtT(dur) : '—') + '</span>' +
      '<button class="tk-more" data-act="more-track" data-id="' + t.id + '">' + icon('more') + '</button>' +
    '</li>';
  }


  /* ── 时长探测（后台低并发） ── */
  let probeToken = 0;
  function readDuration(url, isVideo) {
    return new Promise(function (res) {
      const a = isVideo ? document.createElement('video') : new Audio();
      let done = false;
      const finish = function (v) {
        if (done) return;
        done = true;
        a.removeAttribute('src');
        a.load();
        res(v);
      };
      a.preload = 'metadata';
      a.onloadedmetadata = function () { finish(isFinite(a.duration) ? a.duration : 0); };
      a.onerror = function () { finish(0); };
      setTimeout(function () { finish(0); }, 8000);
      a.src = url;
    });
  }

  async function probeDurations(list) {
    const token = ++probeToken;
    if (!FM.fs.hasSource) return;
    const pool = list.filter(t => !t.duration && t.duration !== -1).slice(0, 500);
    pool.forEach(t => { t.__probing = true; });
    let cursor = 0;
    async function worker() {
      while (cursor < pool.length) {
        if (token !== probeToken) return;
        const t = pool[cursor++];
        try {
          const s = await FM.fs.src(t.rel);
          const dur = await readDuration(s.url, t.kind === 'video');
          if (s.revoke) s.revoke();
          if (token !== probeToken) return;
          t.__probing = false;
          if (dur > 0) {
            L.setDuration(t.id, dur);
            const cell = document.querySelector('.track[data-id="' + t.id + '"] .tk-dur');
            if (cell) cell.textContent = U.fmtTime(dur);
          }
        } catch (e) {
          t.__probing = false;
        }
      }
    }
    const workers = [];
    for (let i = 0; i < 3; i++) workers.push(worker());
    await Promise.all(workers);
  }

  /* ── 列表工具 ── */
  /* 专辑的续播点：这张专辑里最近一次没听完的那集；没有就从头开始 */
  function resumeTrackOf(albumId) {
    const all = FM.db.progress();
    let best = null, bestAt = 0;
    L.albumTracks(albumId).forEach(function (t) {
      const p = all[t.id];
      if (!p || p.done) return;
      if (!p.p || p.p < 10) return;
      if (p.d && p.p >= p.d - 12) return;
      const at = p.t || 0;
      if (at > bestAt) { bestAt = at; best = t; }
    });
    return best;
  }

  function playAlbumResume(albumId) {
    const list = L.albumTracks(albumId);
    if (!list.length) return;
    const t = resumeTrackOf(albumId);
    const i = t ? Math.max(0, list.findIndex(function (x) { return x.id === t.id; })) : 0;
    P.setQueue(list, i, { autoplay: true });
  }

  /* 详情页主按钮：这张专辑正在放就显示暂停，否则按有没有听过显示继续播放 / 播放全部 */
  function albumPlayLabel(a) {
    /* 原生视频播放器有自己的控件，网页这边不给“暂停”态，避免点了没反应 */
    const here = P.current && P.current.albumId === a.id && !P.nativeVideo;
    const playing = here && P.playing;
    const started = L.albumStat(a).started > 0;
    return { icon: playing ? 'pause' : 'play', text: playing ? '暂停播放' : (here || started ? '继续播放' : '播放全部') };
  }

  function syncAlbumPlayBtn() {
    const btn = document.querySelector('#view [data-act="album-play"]');
    if (!btn) return;
    const a = L.album(btn.dataset.id);
    if (!a) return;
    const l = albumPlayLabel(a);
    btn.innerHTML = icon(l.icon) + l.text;
  }

  function continueList(limit) {
    const all = FM.db.progress();
    const out = [];
    Object.keys(all).forEach(function (id) {
      const p = all[id];
      const t = L.track(id);
      if (!t || !p) return;
      if (p.done) return;
      if (!p.p || p.p < 10) return;
      if (p.d && p.p >= p.d - 12) return;
      out.push(t);
      out[out.length - 1].__t = p.t || 0;
    });
    out.sort((x, y) => y.__t - x.__t);
    return out.slice(0, limit);
  }

  function recentList(limit) {
    const all = FM.db.progress();
    const rows = [];
    Object.keys(all).forEach(function (id) {
      const p = all[id];
      const t = L.track(id);
      if (!t || !p) return;
      rows.push({ t: t, at: p.t || 0 });
    });
    rows.sort((x, y) => y.at - x.at);
    return rows.slice(0, limit).map(r => r.t);
  }

  /* ── 欢迎页 ── */
  function renderWelcome() {
    const v = refs.view;
    const srv = !!FM.fs.server;
    const secure = FM.fs.supportsPicker();
    const app = !srv && !!FM.android;      /* 安卓壳里但没读到库 */
    /* 三种空状态：远端有库 / 壳里读不到库 / 本机浏览器还没选目录 */
    let text, steps, actions;
    if (srv) {
      text = '远端模式：资源库由主机上的目录「' + esc(FM.fs.rootName || '远程资源库') + '」提供。<br>加书请在主机上放进这个目录，再点下面的重新扫描。';
      steps = '<span class="step"><b>1</b>主机放入音频</span>' +
        '<span class="step"><b>2</b>重新扫描</span>' +
        '<span class="step"><b>3</b>分类、倍速、播放</span>';
      actions = '<button class="btn btn-primary" data-act="rescan" style="height:44px;padding:0 26px">' + icon('refresh') + '重新扫描</button>';
    } else if (app) {
      text = '还没读到电脑上的资源库。<br>先在电脑端添加一个有声书目录，或确认服务是否在运行。';
      steps = '<span class="step"><b>1</b>电脑上运行服务</span>' +
        '<span class="step"><b>2</b>添加资源库</span>' +
        '<span class="step"><b>3</b>手机自动读到</span>';
      actions = '<button class="btn btn-primary" data-act="retry" style="height:44px;padding:0 26px">' + icon('refresh') + '重试连接</button>' +
        '<button class="btn" data-act="app-settings" style="height:44px;padding:0 20px">' + icon('edit') + '服务器地址</button>';
    } else {
      text = '选择一个存放有声书的文件夹，星海 FM 会自动扫描并整理成专辑。';
      steps = '<span class="step"><b>1</b>选择文件夹</span>' +
        '<span class="step"><b>2</b>自动扫描</span>' +
        '<span class="step"><b>3</b>分类、倍速、播放</span>';
      actions = '<button class="btn btn-primary" data-act="scan" style="height:44px;padding:0 26px">' + icon('folder') + '添加资源库</button>';
    }
    v.innerHTML = '<div class="welcome">' +
      '<div class="welcome-orbit"><i></i><i></i><i></i><div class="core">' + icon('headphones') + '</div></div>' +
      '<h1>让本地的声音<em>活起来</em></h1>' +
      '<p>' + text + '</p>' +
      '<div class="steps">' + steps + '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:6px">' + actions + '</div>' +
      (!srv && !app && !secure ? '<div class="notice" style="max-width:520px;text-align:left">' + icon('moon') +
        '<div>当前以 file:// 方式打开，浏览器会禁用目录记忆功能，每次打开都需要重新选择文件夹。<br>而且这种模式的资源库列表只存在这个页面自己的存储里，和桌面版 / 网址访问用的不是同一份。<br>想让它们统一，用 <b>启动.bat</b>（localhost）或桌面版打开。</div></div>' : '') +
    '</div>';
  }

  /* ── 事件绑定 ── */
  function bindChrome() {
    function goHome() { go('#/'); closeDrawer(); }
    refs.brand.addEventListener('click', goHome);
    refs.brand.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); }
    });
    refs.libSwitch.addEventListener('click', function () { openLibMenu(refs.libSwitch); });
    refs.btnSync.addEventListener('click', function () { doScan(); });
    if (refs.btnLogout) {
      refs.btnLogout.addEventListener('click', function () { location.href = '/__auth/logout'; });
    }
    refs.btnAddCat.addEventListener('click', function () { if (!assignBlocked()) editCat(null); });
    refs.btnMenu.addEventListener('click', function () {
      /* 窄屏：侧栏是抽屉，开/关；宽屏：整列折叠，状态记到本地 */
      if (window.matchMedia('(max-width:979.98px)').matches) {
        if (refs.sidebar.classList.contains('open')) closeDrawer();
        else {
          refs.sidebar.classList.add('open');
          refs.drawerMask.classList.add('show');
          setMenuState();
        }
        return;
      }
      const app = $('app');
      const next = !app.classList.contains('side-collapsed');
      app.classList.toggle('side-collapsed', next);
      FM.store.write('sideCollapsed', next);
      setMenuState();
    });
    refs.drawerMask.addEventListener('click', function () { closeDrawer(); });
    /* 从窄屏拖宽时把抽屉状态收干净，否则遮罩会留在上面挡住点击 */
    window.matchMedia('(max-width:979.98px)').addEventListener('change', function (e) {
      if (!e.matches) closeDrawer();
    });
    refs.nav.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-hash]');
      if (btn) go(btn.dataset.hash);
      closeDrawer();
    });
    refs.catList.addEventListener('click', function (e) {
      const edit = e.target.closest('[data-act="edit-cat"]');
      if (edit) { editCat(edit.dataset.id); return; }
      const item = e.target.closest('.cat-item');
      if (item) { go('#/cat/' + item.dataset.cat); closeDrawer(); }
    });

    /* 拖拽归类 */
    refs.catList.addEventListener('dragover', function (e) {
      const item = e.target.closest('.cat-item');
      if (!item || !dragId) return;
      e.preventDefault();
      item.classList.add('drop-target');
    });
    refs.catList.addEventListener('dragleave', function (e) {
      const item = e.target.closest('.cat-item');
      if (item) item.classList.remove('drop-target');
    });
    refs.catList.addEventListener('drop', function (e) {
      const item = e.target.closest('.cat-item');
      if (!item) return;
      e.preventDefault();
      item.classList.remove('drop-target');
      const id = e.dataTransfer.getData('text/plain') || dragId;
      if (id) { if (!assignBlocked()) assignCat(id, item.dataset.cat, true); }
    });

    refs.searchInput.addEventListener('input', U.debounce(function () {
      const q = refs.searchInput.value.trim();
      refs.searchClear.hidden = !q;
      state.q = q;
      if (q) { renderMain(); } else { route(); }
    }, 160));
    refs.searchClear.addEventListener('click', function () {
      refs.searchInput.value = '';
      refs.searchClear.hidden = true;
      state.q = '';
      route();
    });

    refs.view.addEventListener('scroll', function () {
      refs.topbar.classList.toggle('scrolled', refs.view.scrollTop > 8);
    });
  }

  function closeDrawer() {
    refs.sidebar.classList.remove('open');
    refs.drawerMask.classList.remove('show');
    setMenuState();
  }

  /* 菜单按钮的展开态：窄屏看抽屉，宽屏看折叠 */
  function setMenuState() {
    const narrow = window.matchMedia('(max-width:979.98px)').matches;
    const open = narrow
      ? refs.sidebar.classList.contains('open')
      : !$('app').classList.contains('side-collapsed');
    refs.btnMenu.setAttribute('aria-expanded', String(open));
    refs.btnMenu.title = narrow ? '打开菜单' : (open ? '收起侧栏' : '展开侧栏');
  }

  function bindView() {
    refs.view.addEventListener('click', onViewClick);
    refs.view.addEventListener('input', function (e) {
      if (e.target.id === 'tkSearch') {
        state.detailQ = e.target.value.trim();
        state.page = 0;
        const a = L.album(state.albumId);
        if (!a) return;
        const filtered = albumTracksFiltered(a);
        const pg = pageSlice(filtered);
        const box = document.getElementById('trackList');
        if (box) {
          box.innerHTML = pg.items.map(t => trackRow(t)).join('');
          applyPlayingState(box);
        }
        const pager = document.getElementById('trackPager');
        if (pager) pager.innerHTML = pagerHtml(filtered.length);
        const count = refs.view.querySelector('.tk-count');
        if (count) count.textContent = filtered.length + ' / ' + a.count + ' 集';
      }
    });
    refs.view.addEventListener('pointermove', function (e) {
      const card = e.target.closest('.card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
    refs.view.addEventListener('dragstart', function (e) {
      const card = e.target.closest('.card');
      if (!card) return;
      dragId = card.dataset.id;
      try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
      card.classList.add('dragging');
    });
    refs.view.addEventListener('dragend', function (e) {
      const card = e.target.closest('.card');
      if (card) card.classList.remove('dragging');
      dragId = null;
      U.$$('.cat-item.drop-target').forEach(x => x.classList.remove('drop-target'));
    });
  }

  function onViewClick(e) {
    const actEl = e.target.closest('[data-act]');
    if (actEl) {
      const act = actEl.dataset.act;
      const id = actEl.dataset.id;
      switch (act) {
        case 'album-play': {
          const a = L.album(id);
          if (!a) break;
          if (P.current && P.current.albumId === id && !P.nativeVideo) P.toggle();
          else playAlbumResume(id);
          break;
        }
        case 'play-album': {
          /* 下载管理里点卡片播放：进下载详情页，队列只放已下载的 */
          if (state.view === 'downloads' || state.view === 'dlAlbum') { go('#/downloads/' + id); playDlTracks(id); break; }
          P.playAlbum(id); break;
        }
        case 'open-dl-album': if (id) go('#/downloads/' + id); break;
        case 'dl-menu': dlAlbumMenu(id, actEl); break;
        case 'play-dl': playDlTracks(id); break;
        case 'row-play-dl': {
          const t = L.track(id);
          if (!t) break;
          if (P.current && P.current.id === id && P.media.src) P.toggle();
          else playDlTracks(t.albumId, id);
          break;
        }
        case 'dl-wait': toast('这集还在下载，下完才能播', 'warn'); break;
        case 'dl-batch': if (id) { state.dlSel = {}; go('#/downloads/' + id + '/remove'); } break;
        case 'dl-more-page': if (id) { state.dlMoreSel = {}; go('#/downloads/' + id + '/more'); } break;
        case 'dl-mine': go('#/downloads'); break;
        case 'dl-more-group': {
          const list = (actEl.dataset.ids || '').split(',').map(function (x) { return L.track(x); })
            .filter(function (t) { return t && !dlMap()[t.rel]; });
          if (!list.length) { toast('这一组已经下过了', 'warn'); break; }
          if (!(FM.android && FM.android.download && FM.android.download(list))) { toast('没排上队，稍后再试', 'warn'); break; }
          break;
        }
        case 'dl-more-toggle': {
          if (!state.dlMoreSel) state.dlMoreSel = {};
          if (state.dlMoreSel[id]) delete state.dlMoreSel[id]; else state.dlMoreSel[id] = true;
          renderMain();
          break;
        }
        case 'dl-more-all': {
          const sel = state.dlMoreSel || (state.dlMoreSel = {});
          const pend = L.albumTracks(state.albumId).filter(function (t) { return !dlMap()[t.rel]; });
          const all = pend.length > 0 && pend.every(function (t) { return !!sel[t.id]; });
          pend.forEach(function (t) { if (all) delete sel[t.id]; else sel[t.id] = true; });
          renderMain();
          break;
        }
        case 'dl-more-go': {
          const sel = state.dlMoreSel || {};
          const picked = L.albumTracks(id).filter(function (t) { return !!sel[t.id] && !dlMap()[t.rel]; });
          if (!picked.length) break;
          if (!(FM.android && FM.android.download && FM.android.download(picked))) { toast('没排上队，稍后再试', 'warn'); break; }
          /* 入队结果（含移动网络确认）由原生 toast，这里只负责回列表 */
          state.dlMoreSel = {};
          go('#/downloads/' + id);
          break;
        }
        case 'dl-toggle': {
          if (!state.dlSel) state.dlSel = {};
          if (state.dlSel[id]) delete state.dlSel[id]; else state.dlSel[id] = true;
          renderMain();
          break;
        }
        case 'dl-sel-all':
        case 'dl-sel-done': {
          const sel = state.dlSel || (state.dlSel = {});
          const pool = dlAll(state.albumId);
          const keep = act === 'dl-sel-done'
            ? pool.filter(function (t) { const p = L.progressOf(t.id); return !!(p && p.done); })
            : pool;
          const all = keep.length > 0 && keep.every(function (t) { return !!sel[t.id]; });
          keep.forEach(function (t) { if (all) delete sel[t.id]; else sel[t.id] = true; });
          renderMain();
          break;
        }
        case 'dl-del-selected': {
          const sel = state.dlSel || {};
          const rels = dlAll(state.albumId).filter(function (t) { return !!sel[t.id]; }).map(function (t) { return t.rel; });
          if (!rels.length) break;
          confirmModal({
            title: '删除 ' + rels.length + ' 集下载？',
            message: '这些文件会从手机里删掉。',
            note: '想再听可以重新下载，播放记录不受影响。',
            danger: true, okText: '删除'
          }).then(function (ok) {
            if (!ok) return;
            if (!(FM.android && FM.android.canRemoveMany)) { toast('App 版本太旧，更新 APK 后才能批量删除', 'warn'); return; }
            if (!FM.android.removeDownloads(rels)) { toast('删除失败，重试一次', 'warn'); return; }
            state.dlSel = {};
            toast('已删除 ' + rels.length + ' 集');
            go('#/downloads/' + id);
          });
          break;
        }
        case 'dl-remove': {
          const t = L.track(id);
          if (!t) break;
          confirmModal({
            title: '删除下载？',
            message: '「' + t.title + '」会从手机里删掉。',
            note: '想再听可以重新下载，播放记录不受影响。',
            danger: true, okText: '删除'
          }).then(function (ok) {
            if (!ok) return;
            if (!(FM.android && FM.android.canRemove)) { toast('App 版本太旧，更新 APK 后才能删除', 'warn'); return; }
            if (!FM.android.removeDownload(t.rel)) {
              toast('删除失败，去「管理 / 删除」里试试', 'warn');
              return;
            }
            toast('已删除下载');
            downloadsChanged();
          });
          break;
        }
        case 'queue-album': { const list = L.albumTracks(id); P.addToQueue(list); toast('已加入播放队列（' + list.length + ' 集）'); break; }
        case 'fav': toggleFavorite(id); break;
        case 'assign': if (!assignBlocked()) assignModal(id); break;
        case 'more-album': albumMenu(id, actEl); break;
        case 'more-track': trackMenu(id, actEl); break;
        case 'edit-cat': if (!assignBlocked()) editCat(id); break;
        case 'open-downloads': if (FM.android) FM.android.openDownloads(); break;
        case 'back': history.back(); break;
        case 'resume': { const t = L.track(id); if (t) P.playTrack(t); break; }
        case 'open-album': if (id) go('#/album/' + id); break;
        case 'row-play': {
          const t = L.track(id);
          if (!t) break;
          if (P.current && P.current.id === id && P.media.src) P.toggle();
          else P.playTrack(t);
          break;
        }
        case 'sort': state.sortDesc = !state.sortDesc; state.page = 0; FM.db.setState(Object.assign(FM.db.state(), { sortDesc: state.sortDesc })); FM.store.touch('state'); renderMain(); break;
        case 'page': {
          const p = parseInt(actEl.dataset.page, 10);
          if (isNaN(p) || p === state.page) break;
          state.page = p;
          renderMain();
          /* 滚到工具栏（sticky），避免首行被它盖住 */
          const anchor = refs.view.querySelector('.track-toolbar') || document.getElementById('trackList');
          if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ block: 'start' });
          break;
        }
        case 'scan': addLibFlow(); break;
        case 'rescan': doScan(); break;
        case 'retry': location.reload(); break;
        case 'app-settings': if (FM.android) FM.android.openSettings(); break;
        case 'lib-menu': openLibMenu(actEl); break;
        case 'relocate-lib': relocateFlow(FM.fs.active(), null); break;
        case 'toggle-hidden': state.showHidden = !state.showHidden; FM.db.setState(Object.assign(FM.db.state(), { showHidden: state.showHidden })); FM.store.touch('state'); renderAll(); break;
        default: break;
      }
      return;
    }
    const card = e.target.closest('.card');
    if (card) { go((state.view === 'downloads' ? '#/downloads/' : '#/album/') + card.dataset.id); return; }
    const tr = e.target.closest('.track');
    if (tr) {
      const t = L.track(tr.dataset.id);
      if (t) P.playTrack(t);
    }
  }

  function applyPlayingState(root) {
    const cur = P.current;
    U.$$('.track', root || document).forEach(function (row) {
      const on = cur && row.dataset.id === cur.id;
      row.classList.toggle('playing', !!on);
      row.classList.toggle('paused', !!on && !P.playing);
      const btn = row.querySelector('.tk-play');
      if (btn) {
        btn.innerHTML = icon(on && P.playing ? 'pause' : 'play');
        btn.title = on && P.playing ? '暂停' : '播放这一集';
      }
    });
    U.$$('.card', root || document).forEach(function (card) {
      card.classList.toggle('playing', !!(cur && cur.albumId === card.dataset.id));
    });
  }

  function observeCards(root, instant) {
    const cards = U.$$('.card', root);
    if (!cards.length) return;
    if (instant) {
      /* 静默刷新：直接落在终态，不走交错淡入 */
      cards.forEach(function (c) { c.style.transitionDelay = '0ms'; c.classList.add('in'); });
      return;
    }
    if (!('IntersectionObserver' in window)) { cards.forEach(c => c.classList.add('in')); return; }
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { root: refs.view, rootMargin: '0px 0px -30px 0px' });
    cards.forEach(function (c, i) {
      c.style.transitionDelay = Math.min(i, 10) * 22 + 'ms';
      io.observe(c);
    });
  }

  /* ── 菜单 ── */
  function albumMenu(id, anchor) {
    const a = L.album(id);
    if (!a) return;
    /* 权限：归类只在桌面原生本地库可用；置顶/重命名/隐藏在远端只读模式下无权限。
       无权限的项直接不加入菜单（而非显示后点击才提示）。 */
    const canAssign = FM.fs.native && !FM.fs.server;   // 归类…
    const canModify = !FM.fs.server;                    // 置顶 / 重命名 / 隐藏
    const canEditCover = FM.fs.native || FM.fs.server;  // 编辑封面（本地库 / 自有服务端都可写 .fm-covers/）
    const items = [
      { label: '播放全部', icon: 'play', onClick: () => P.playAlbum(id) },
      { label: '加入队列', icon: 'list', onClick: () => { P.addToQueue(L.albumTracks(id)); toast('已加入播放队列'); } }
    ];
    if (canDownload()) items.push({ label: '下载全部', icon: 'download', onClick: () => downloadTracks(L.albumTracks(id)) });
    items.push({ sep: true });
    items.push({ label: a.fav ? '取消收藏' : '收藏专辑', icon: 'heart', onClick: () => toggleFavorite(id) });
    if (canModify) items.push({ label: a.pinned ? '取消置顶' : '置顶专辑', icon: 'up', onClick: () => { if (readonlyBlocked()) return; L.setMeta(id, { pinned: !a.pinned }); renderAll(); } });
    if (canAssign) items.push({ label: '归类…', icon: 'folder', onClick: () => { if (!assignBlocked()) assignModal(id); } });
    if (canModify) items.push({ label: '重命名…', icon: 'edit', onClick: () => { if (!readonlyBlocked()) renameAlbum(id); } });
    if (canEditCover) items.push({ label: '编辑封面…', icon: 'image', onClick: () => coverEditModal(id) });
    items.push({ sep: true });
    if (canModify) items.push({ label: a.hidden ? '取消隐藏' : '隐藏专辑', icon: 'close', danger: !a.hidden, onClick: () => { if (readonlyBlocked()) return; const next = !a.hidden; L.setMeta(id, { hidden: next }); toast(next ? '已隐藏，可在首页底部找回' : '已取消隐藏'); renderAll(); } });
    if (window.fmNative && window.fmNative.isDesktop) {
      items.push({ sep: true },
        { label: '在文件夹中显示', icon: 'folder', onClick: () => { const t = L.albumTracks(id)[0]; nativeReveal(t && t.rel); } });
    }
    /* 去掉过滤后可能残留的首尾 / 连续分隔线 */
    const cleaned = [];
    items.forEach(function (it) {
      const prev = cleaned[cleaned.length - 1];
      if (it.sep && (!prev || prev.sep)) return;
      cleaned.push(it);
    });
    if (cleaned.length && cleaned[cleaned.length - 1].sep) cleaned.pop();
    openMenu(anchor, cleaned);
  }

  function nativeReveal(rel) {
    if (window.fmNative && window.fmNative.isDesktop && rel) window.fmNative.reveal(rel);
  }

  function trackMenu(id, anchor) {
    const t = L.track(id);
    if (!t) return;
    const p = L.progressOf(id);
    const items = [
      { label: '从这集开始播放', icon: 'play', onClick: () => P.playTrack(t) },
      { label: '加入队列', icon: 'list', onClick: () => { P.addToQueue([t]); toast('已加入播放队列'); } },
      { sep: true },
      {
        label: p && p.done ? '标记为未听' : '标记为已听', icon: 'check', onClick: function () {
          if (p && p.done) { FM.lib.setProgress(id, 0, p.d || t.duration || 0, false); }
          else { FM.lib.setProgress(id, t.duration || (p && p.d) || 0, t.duration || (p && p.d) || 0, true); }
          toast('已更新播放状态');
          renderMain();
        }
      }
    ];
    if (canDownload()) items.splice(2, 0, { label: '下载', icon: 'download', onClick: () => downloadTracks([t]) });
    if (window.fmNative && window.fmNative.isDesktop) {
      items.push({ sep: true });
      items.push({ label: '在文件夹中显示', icon: 'folder', onClick: () => nativeReveal(t.rel) });
    }
    openMenu(anchor, items);
  }

  /* ── 编辑封面：上传 / 自动获取 / 删除，点「保存」才写进 .fm-covers/ ── */
  function coverEditModal(id) {
    const a = L.album(id);
    if (!a) return;
    if (!(FM.fs.native || FM.fs.server)) { toast('本地文件夹模式不支持改封面', 'warn'); return; }

    let pending = null;      // { kind:'upload', dataUrl } 或 { kind:'xmly', url, albumId, title }
    let deleteMode = false;
    let delBtn = null, saveBtn = null;

    const preview = U.el('img', { class: 'cover-img', referrerpolicy: 'no-referrer', style: { width: '116px', height: '116px', objectFit: 'cover', borderRadius: '12px', display: a.cover ? 'block' : 'none' } });
    if (a.cover) preview.src = a.cover;
    const previewBox = U.el('div', { style: { width: '116px', height: '116px', flex: 'none', borderRadius: '12px', overflow: 'hidden', background: 'rgba(255,255,255,.06)' } }, [preview]);
    const candsBox = U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    const hint = U.el('p', { style: { fontSize: '11px', color: 'var(--dim-2)', margin: '10px 0 0' }, text: '点「保存」才会写入资源库的 .fm-covers/，不会自动生效。' });

    const fileInput = U.el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    fileInput.addEventListener('change', function () {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = function () {
        pending = { kind: 'upload', dataUrl: String(reader.result) };
        deleteMode = false;
        preview.src = pending.dataUrl;
        preview.style.display = 'block';
        updateActions();
      };
      reader.readAsDataURL(f);
    });

    const uploadBtn = U.el('button', { class: 'btn btn-ghost', text: '上传本地图片', onclick: function () { fileInput.click(); } });
    /* 关键词输入框：默认专辑名，可改成更准的搜索词 */
    const kwInput = U.el('input', { class: 'input', type: 'text', placeholder: '搜索关键词（默认专辑名）', value: a.title || '' });
    const autoBtn = U.el('button', { class: 'btn btn-ghost', text: '自动获取' });
    async function searchCover() {
      autoBtn.disabled = true;
      autoBtn.textContent = '搜索中…';
      const kw = (kwInput.value || '').trim() || a.title;
      let list = [];
      try { list = await FM.covers.search(kw); } catch (e) {}
      autoBtn.disabled = false;
      autoBtn.textContent = '自动获取';
      renderCands(list || []);
      if (!list || !list.length) toast('没搜到匹配的封面（喜马拉雅 + 百度都没结果），换个关键词；若刚更新代码，请重启应用', 'warn');
    }
    autoBtn.addEventListener('click', searchCover);
    kwInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); searchCover(); }
    });

    function renderCands(list) {
      candsBox.innerHTML = '';
      list.forEach(function (c) {
        /* 缩略图下面带标题，一眼能看出这张图对应哪张专辑 */
        const cell = U.el('div', { style: { width: '64px', cursor: 'pointer', position: 'relative' } }, [
          U.el('div', { style: { width: '64px', height: '64px', borderRadius: '8px', overflow: 'hidden' } }, [
            U.el('img', { src: c.url, alt: '', title: c.title, referrerpolicy: 'no-referrer', style: { width: '100%', height: '100%', objectFit: 'cover' } })
          ]),
          U.el('span', {
            style: { position: 'absolute', left: '2px', top: '2px', padding: '0 4px', borderRadius: '5px', fontSize: '8px', lineHeight: '1.5', color: '#e6f3ff', background: 'rgba(0,0,0,.62)' },
            text: c.source === 'baidu' ? '百度' : c.source === 'geekbang' ? '极客' : '喜马'
          }),
          U.el('div', {
            title: c.title,
            style: { marginTop: '3px', fontSize: '9px', lineHeight: '1.2', color: 'var(--dim-2)', maxWidth: '64px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
            text: c.title || ''
          })
        ]);
        cell.title = c.title || '';
        cell.addEventListener('click', function () {
          pending = { kind: 'xmly', url: c.url, albumId: c.id, title: c.title, source: c.source || 'xmly' };
          deleteMode = false;
          preview.src = c.url;
          preview.style.display = 'block';
          updateActions();
        });
        candsBox.appendChild(cell);
      });
    }

    const body = U.el('div', { class: 'cover-edit' }, [
      U.el('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start' } }, [
        previewBox,
        U.el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', gap: '10px' } }, [
          kwInput,
          U.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [uploadBtn, autoBtn]),
          candsBox
        ])
      ]),
      hint
    ]);

    function updateActions() {
      if (!delBtn) return;
      delBtn.textContent = deleteMode ? '取消删除' : '删除封面';
      delBtn.classList.toggle('danger', deleteMode);
      saveBtn.disabled = !pending && !deleteMode;
    }

    async function doSave() {
      const res = await FM.covers.save(a, pending);
      if (res && res.ok) { toast('封面已保存'); renderAll(); if (P.current) paintTrack(P.current); }
      else toast('保存失败：' + (res && res.reason ? res.reason : '未知原因'), 'warn');
    }
    async function doDelete() {
      const res = await FM.covers.remove(a);
      if (res && res.ok) { toast('封面已删除'); renderAll(); if (P.current) paintTrack(P.current); }
      else toast('删除失败：' + (res && res.reason ? res.reason : '未知原因'), 'warn');
    }

    const m = openModal({
      title: '编辑封面',
      body: body,
      actions: [
        {
          label: '删除封面', cls: 'btn-ghost', onClick: function () {
            deleteMode = !deleteMode;
            if (deleteMode) {
              pending = null;
              preview.src = a.cover || '';
              preview.style.display = a.cover ? 'block' : 'none';
            }
            updateActions();
            return false;
          }
        },
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '保存', cls: 'btn-primary', onClick: function () {
            if (deleteMode) { doDelete(); return; }
            if (pending) { doSave(); return; }
            toast('先选一张封面，或点「删除封面」', 'warn');
            return false;
          }
        }
      ],
      onClose: function () { fileInput.value = ''; }
    });

    const btns = m.box.querySelectorAll('.modal-foot button');
    delBtn = btns[0]; saveBtn = btns[2];
    updateActions();
  }

  function renameAlbum(id) {
    const a = L.album(id);
    if (!a) return;
    const input = U.el('input', { class: 'input', value: a.title });
    const box = U.el('div', { class: 'field' }, [U.el('label', { text: '显示名称' }), input]);
    const m = openModal({
      title: '重命名专辑', body: box,
      actions: [
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '保存', cls: 'btn-primary', onClick: function () {
            const v = input.value.trim();
            if (!v) { toast('名称不能为空', 'warn'); return false; }
            L.setMeta(id, { title: v });
            renderAll();
            toast('已重命名');
          }
        }
      ]
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { m.box.querySelector('.btn-primary').click(); } });
  }

  function assignModal(id) {
    const a = L.album(id);
    if (!a) return;
    const body = U.el('div');
    function draw() {
      const cats = L.cats();
      const cur = L.album(id);
      body.innerHTML = cats.map(function (c) {
        const on = cur.cats.indexOf(c.id) >= 0;
        return '<div class="cat-pick' + (on ? ' on' : '') + '" data-cat="' + c.id + '">' +
          '<span class="box">' + icon('check') + '</span>' +
          '<i style="width:8px;height:8px;border-radius:50%;background:' + c.color + '"></i>' +
          '<span>' + esc(c.name) + '</span><span class="count">' + L.catCount(c.id) + '</span></div>';
      }).join('') + '<button class="btn btn-ghost" data-new="1" style="margin-top:4px">' + icon('plus') + '新建分类</button>';
    }
    draw();
    body.addEventListener('click', function (e) {
      const pick = e.target.closest('.cat-pick');
      if (pick) {
        const catId = pick.dataset.cat;
        const cur = L.album(id);
        const cats = cur.cats.slice();
        const i = cats.indexOf(catId);
        if (i >= 0) cats.splice(i, 1); else cats.push(catId);
        L.setMeta(id, { cats: cats });
        pick.classList.toggle('on');
        renderCats(); renderNav();
        return;
      }
      if (e.target.closest('[data-new]')) {
        const inp = U.el('input', { class: 'input', placeholder: '例如：历史军事' });
        const nb = U.el('div', {}, [U.el('div', { class: 'field' }, [U.el('label', { text: '分类名称' }), inp])]);
        const m2 = openModal({
          title: '新建分类',
          body: nb,
          actions: [
            { label: '取消', cls: 'btn-ghost' },
            {
              label: '创建', cls: 'btn-primary', onClick: function () {
                const v = inp.value.trim();
                if (!v) { toast('请输入分类名称', 'warn'); return false; }
                L.addCat(v, CAT_COLORS[Math.floor(Math.random() * CAT_COLORS.length)]);
                draw(); renderCats();
              }
            }
          ]
        });
        inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') m2.box.querySelector('.btn-primary').click(); });
      }
    });
    openModal({
      title: '归类：' + a.title, body: body,
      actions: [{ label: '完成', cls: 'btn-primary', onClick: () => { renderAll(); } }]
    });
  }

  function assignCat(albumId, catId, additive) {
    const a = L.album(albumId);
    if (!a) return;
    if (a.cats.indexOf(catId) >= 0) { toast('该专辑已在此分类中'); return; }
    L.setMeta(albumId, { cats: a.cats.concat([catId]) });
    const cat = L.cats().find(c => c.id === catId);
    toast('已归入「' + (cat ? cat.name : '分类') + '」');
    renderCats(); renderNav(); renderMain();
  }

  function editCat(catId) {
    const isNew = !catId;
    const cat = isNew ? { name: '', color: CAT_COLORS[0] } : L.cats().find(c => c.id === catId);
    if (!cat) return;
    let color = cat.color;
    const input = U.el('input', { class: 'input', value: cat.name, placeholder: '例如：历史军事' });
    const sw = U.el('div', { class: 'swatches' });
    CAT_COLORS.forEach(function (c) {
      const b = U.el('button', { class: 'swatch' + (c === color ? ' on' : ''), style: { background: c } });
      b.onclick = function () {
        color = c;
        U.$$('.swatch', sw).forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      };
      sw.appendChild(b);
    });
    const body = U.el('div', {}, [
      U.el('div', { class: 'field' }, [U.el('label', { text: '分类名称' }), input]),
      U.el('div', { class: 'field' }, [U.el('label', { text: '标识颜色' }), sw])
    ]);
    const actions = [{ label: '取消', cls: 'btn-ghost' }];
    if (!isNew) {
      actions.push({
        label: '删除', cls: 'danger', onClick: function () {
          confirmModal({
            title: '删除分类',
            danger: true,
            message: '删除分类「' + cat.name + '」？',
            note: '分类里的专辑不会被删除，仍然留在资源库里。',
            okText: '删除'
          }).then(function (ok) {
            if (!ok) return;
            L.removeCat(catId);
            toast('分类已删除');
            renderAll();
            m.close();
          });
          return false;
        }
      });
    }
    actions.push({
      label: isNew ? '创建' : '保存', cls: 'btn-primary', onClick: function () {
        const v = input.value.trim();
        if (!v) { toast('请输入分类名称', 'warn'); return false; }
        if (isNew) { L.addCat(v, color); toast('分类已创建'); }
        else { L.updateCat(catId, { name: v, color: color }); toast('分类已更新'); }
        renderAll();
      }
    });
    const m = openModal({ title: isNew ? '新建分类' : '编辑分类', body: body, actions: actions });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') m.box.querySelector('.btn-primary').click(); });
  }

  /* ── 播放器 UI ── */
  function paintCover(el, album, track) {
    if (!el) return;
    const seed = album ? album.seed : 0;
    const char = album ? U.initials(album.title) : U.initials(track ? track.title : '声');
    if (el.classList.contains('sheet-cover')) {
      const c = el.querySelector('.sc-char');
      if (c) c.textContent = char;
      const d = refs.sheetDisc;
      if (d) { const dc = d.querySelector('.disc-char'); if (dc) dc.textContent = char.charAt(0); }
      if (refs.sheet) refs.sheet.classList.toggle('no-cover', !(album && album.cover));
    } else {
      const sp = el.querySelector('span');
      if (sp) sp.textContent = char;
    }
    if (album && album.seed != null) {
      const c = U.coverColors(seed);
      el.style.setProperty('--c1', c[0]);
      el.style.setProperty('--c2', c[1]);
      if (refs.sheetDisc) { refs.sheetDisc.style.setProperty('--c1', c[0]); refs.sheetDisc.style.setProperty('--c2', c[1]); }
    }
    paintPhoto(el, album && album.cover);
  }

  /* 有抓到的封面就贴图，没有就退回渐变+首字 */
  function paintPhoto(el, url) {
    let img = el.querySelector('img.cover-img');
    if (url) {
      if (!img) {
        img = document.createElement('img');
        img.className = 'cover-img';
        img.alt = '';
        el.insertBefore(img, el.firstChild);
      }
      if (img.getAttribute('src') !== url) img.src = url;
      el.classList.add('has-photo');
    } else if (img) {
      img.remove();
      el.classList.remove('has-photo');
    }
  }

  /* ── 视频模式（B 站式浮层控件） ── */
  let cinema = false;
  let vcTimer = 0;

  function videoSub(a, t) {
    const ext = String(t.ext || '').toUpperCase();
    if (P.kind !== 'video') return (a ? a.title : '') + ' · ' + ext;
    const m = P.media;
    const res = m.videoWidth ? ' · ' + m.videoWidth + '×' + m.videoHeight : '';
    return (a ? a.title : '') + res;
  }

  function wakeUi() {
    if (!refs.vStage) return;
    refs.vStage.classList.add('vc-visible');
    clearTimeout(vcTimer);
    if (P.playing) {
      vcTimer = setTimeout(function () { refs.vStage.classList.remove('vc-visible'); }, 2600);
    }
  }

  function hideUiNow() {
    clearTimeout(vcTimer);
    if (refs.vStage) refs.vStage.classList.remove('vc-visible');
  }

  function setCinema(on) {
    cinema = !!on && P.kind === 'video';
    refs.sheet.classList.toggle('cinema', cinema);
    document.body.classList.toggle('cinema', cinema);
    wakeUi();
  }

  function toggleFull() {
    /* 壳里走原生全屏（隐藏系统栏 + 横屏），WebView 的 requestFullscreen 经常直接失败 */
    if (FM.android) { FM.android.fullscreen(!FM.android.fullscreenOn); return; }
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    const p = document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(function () { toast('当前环境无法进入全屏', 'warn'); });
  }

  function paintBuffer() {
    const m = P.media;
    const d = m.duration;
    const b = m.buffered;
    if (!d || !isFinite(d) || !b || !b.length) return;
    const end = b.end(b.length - 1) || 0;
    refs.vScrub.style.setProperty('--buf', Math.min(100, end / d * 100) + '%');
  }

  /* 当前这一集在音频/视频之间切换时，整页布局跟着换 */
  function applyKind(kind) {
    const isVideo = kind === 'video';
    refs.sheet.classList.toggle('is-video', isVideo);
    refs.vStage.classList.toggle('vhidden', !isVideo);
    if (refs.pbKind) refs.pbKind.hidden = !isVideo;
    if (isVideo) {
      FM.viz.stop();
      wakeUi();
    } else {
      if (FM.android && FM.android.fullscreenOn) FM.android.fullscreen(false);
      setCinema(false);
      hideUiNow();
      if (queueOpen) toggleQueue();
      if (P.playing && refs.sheet.classList.contains('open')) {
        FM.viz.attach();
        FM.viz.resume();
        FM.viz.start();
      }
    }
  }

  function bindVideo() {
    if (!refs.vStage || !refs.media) return;
    /* 壳里没有系统画中画支持：隐藏按钮，避免点击报错 */
    if (FM.android && refs.vPip) refs.vPip.style.display = 'none';
    refs.vStage.addEventListener('pointermove', wakeUi);
    refs.vStage.addEventListener('pointerdown', wakeUi);
    refs.vStage.addEventListener('pointerleave', function () { if (P.playing) hideUiNow(); });

    /* 单击播/暂停，双击切影院：用延时避免双击时连播两次 */
    let clickTimer = 0;
    refs.media.addEventListener('click', function () {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(function () { P.toggle(); }, 190);
    });
    refs.media.addEventListener('dblclick', function () {
      clearTimeout(clickTimer);
      setCinema(!cinema);
    });
    refs.vBigPlay.addEventListener('click', function () { P.toggle(); });

    refs.vPlay.addEventListener('click', function () { P.toggle(); });
    refs.vPrev.addEventListener('click', function () { P.prev(); });
    refs.vNext.addEventListener('click', function () { P.next(); });
    refs.vVol.addEventListener('click', function () { P.toggleMute(); });
    refs.vRate.addEventListener('click', function (e) { rateMenu(e.currentTarget); });
    refs.vPip.addEventListener('click', function () { P.togglePip(); });
    refs.vCinema.addEventListener('click', function () { setCinema(!cinema); });
    refs.vFull.addEventListener('click', toggleFull);
    refs.vCollapse.addEventListener('click', closeSheet);
    refs.vQueue.addEventListener('click', toggleQueue);

    refs.media.addEventListener('progress', paintBuffer);
    refs.media.addEventListener('waiting', function () { if (P.kind === 'video') refs.vLoading.hidden = false; });
    refs.media.addEventListener('playing', function () { refs.vLoading.hidden = true; });
    refs.media.addEventListener('canplay', function () { refs.vLoading.hidden = true; });
    refs.media.addEventListener('loadedmetadata', function () {
      if (P.kind === 'video' && P.current) paintTrack(P.current);
    });
  }

  function paintTrack(t) {
    if (!t) return;
    const a = L.album(t.albumId);
    refs.playerbar.hidden = false;
    refs.pbTitle.textContent = t.title;
    refs.pbSub.textContent = (a ? a.title : '') + (a ? ' · 第 ' + (t.order + 1) + ' 集' : '');
    paintCover(refs.pbCover, a, t);
    paintCover(refs.sheetCover, a, t);
    paintSheetArt(a);
    refs.shTitle.textContent = t.title;
    refs.shSub.textContent = (a ? a.title : '') + ' · ' + (t.ext || '').toUpperCase();
    refs.vTitle.textContent = t.title;
    refs.vSub.textContent = videoSub(a, t);
    if (refs.pbKind) refs.pbKind.hidden = P.kind !== 'video';
    const fav = a && a.fav;
    refs.pbFav.classList.toggle('on', !!fav);
    refs.pbFav.innerHTML = icon(fav ? 'heart-fill' : 'heart');
    refs.shFav.classList.toggle('on', !!fav);
    refs.shFav.innerHTML = icon(fav ? 'heart-fill' : 'heart') + '<span>' + (fav ? '已收藏' : '收藏') + '</span>';
    const p = L.progressOf(t.id);
    if (p && p.d && !t.duration) { t.duration = p.d; }
    paintTime(0, t.duration || (p && p.d) || 0);
    applyPlayingState();
    renderNav();
  }

  /* 沉浸式渐变封面：有封面就整幅铺顶（再向下渐隐），没有用专辑配色兜底 */
  function paintSheetArt(album) {
    const el = refs.sheetArt;
    if (!el) return;
    const c = U.coverColors(album && album.seed != null ? album.seed : 0);
    el.style.backgroundImage = 'linear-gradient(160deg,' + c[0] + ',' + c[1] + ')';
    const img = refs.sheetArtImg;
    if (!img) return;
    if (album && album.cover) {
      img.onerror = function () { img.style.display = 'none'; };
      if (img.getAttribute('src') !== album.cover) img.src = album.cover;
      img.style.display = 'block';
    } else {
      img.onerror = null;
      img.removeAttribute('src');
      img.style.display = 'none';
    }
  }

  function paintTime(cur, dur) {
    if (scrubbing) return;
    refs.pbCur.textContent = fmtT(cur);
    refs.pbDur.textContent = fmtT(dur);
    refs.shCur.textContent = fmtT(cur);
    refs.shDur.textContent = fmtT(dur);
    refs.vCur.textContent = fmtT(cur);
    refs.vDur.textContent = fmtT(dur);
    const pct = dur > 0 ? (cur / dur * 100) : 0;
    refs.pbScrub.style.setProperty('--p', pct + '%');
    refs.shScrub.style.setProperty('--p', pct + '%');
    refs.vScrub.style.setProperty('--p', pct + '%');
    paintBuffer();
  }

  function paintState(playing) {
    const ic = icon(playing ? 'pause' : 'play');
    const isVideo = P.kind === 'video';
    refs.btnPlay.innerHTML = ic;
    refs.shPlay.innerHTML = ic;
    refs.vPlay.innerHTML = ic;
    refs.vBigPlay.innerHTML = ic;
    refs.sheet.classList.toggle('playing', playing);
    refs.pbCover.classList.toggle('spin', playing);
    refs.vStage.classList.toggle('is-paused', !playing);
    applyPlayingState();

    /* 只要音频上下文建过就得保持 running，否则视频声音会走静音图 */
    if (playing) { FM.viz.attach(); FM.viz.resume(); }
    if (playing && !isVideo && refs.sheet.classList.contains('open')) FM.viz.start();
    else FM.viz.stop();

    if (isVideo) {
      wakeUi();
      refs.vLoading.hidden = playing || !P.media.src;
    }
  }

  function paintRate(r) {
    const txt = (Math.round(r * 100) / 100) + '×';
    refs.btnRate.textContent = txt;
    refs.vRate.textContent = txt;
    const b = refs.shRate.querySelector('b');
    if (b) b.textContent = txt;
    refs.btnRate.classList.toggle('on', r !== 1);
    refs.vRate.classList.toggle('on', r !== 1);
  }

  function paintVolume(v, muted) {
    const n = Math.round((muted ? 0 : v) * 100);
    const ic = icon(muted || v === 0 ? 'mute' : 'volume');
    refs.volScrub.style.setProperty('--p', n + '%');
    refs.vVolScrub.style.setProperty('--p', n + '%');
    if (refs.volNum) refs.volNum.textContent = n;
    if (refs.vVolNum) refs.vVolNum.textContent = n;
    refs.btnVol.innerHTML = ic;
    refs.vVol.innerHTML = ic;
  }

  function paintLoop(l) {
    refs.btnLoop.innerHTML = icon(P.loopIcon);
    refs.btnLoop.classList.toggle('on', l !== 'all');
    refs.shLoop.innerHTML = icon(P.loopIcon) + '<span>' + P.loopLabel + '</span>';
  }

  function paintSleep(left, mode) {
    const label = refs.shSleep.querySelector('span');
    if (!mode) { refs.shSleep.classList.remove('on'); if (label) label.textContent = '定时关闭'; return; }
    refs.shSleep.classList.add('on');
    if (mode === 'chapter') { if (label) label.textContent = '本集播完暂停'; return; }
    const min = Math.max(1, Math.ceil((left || 0) / 60000));
    if (label) label.textContent = min + ' 分钟后关闭';
  }

  function bindPlayer() {
    P.on('track', function (t, opt) {
      paintTrack(t);
      syncAlbumPlayBtn();
      /* 用户主动点开视频集才展开播放页；启动恢复上次进度不弹。
         视频直接看画面：不自动弹选集列表，若之前开着（从音频队列过来）则关掉。 */
      if (t.kind === 'video' && !(opt && opt.restored)) {
        if (FM.android) return;   /* 壳内视频交给原生播放器，不展开网页播放页 */
        openSheet();
        if (queueOpen) toggleQueue();
      }
    });
    P.on('kind', applyKind);
    P.on('state', function (playing) { paintState(playing); syncAlbumPlayBtn(); });
    P.on('time', paintTime);
    P.on('rate', paintRate);
    P.on('volume', paintVolume);
    P.on('loop', paintLoop);
    P.on('sleep', paintSleep);
    /* 只有确实断网才用统一网络文案；本地文件损坏/编码问题不要误报成断网 */
    P.on('error', function (e) {
      const m = (e && e.message) ? String(e.message) : '';
      const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) ||
        (FM.fs && FM.fs.link === 'offline');
      if (m === U.NET_FAIL || offline) toast(U.NET_FAIL, 'warn');
      else if (m === '登录已过期，请重新登录') toast(m, 'warn');
      else toast('播放失败，请稍后重试', 'warn');
    });
    P.on('sleepend', function () { toast('定时关闭已生效'); });
    P.on('rewind', function (sec) { toast('已回退 ' + Math.round(sec) + ' 秒'); });
    P.on('queue', function () { if (queueOpen) renderQueue(); });
    /* 切资源库时播放器被清空：播放条收起、播放页关掉 */
    P.on('stop', function () {
      syncAlbumPlayBtn();
      if (refs.sheet.classList.contains('open')) closeSheet();
      setCinema(false);
      refs.playerbar.hidden = true;
      refs.pbTitle.textContent = '—';
      refs.pbSub.textContent = '选择一集开始收听';
      refs.pbKind.hidden = true;
      paintState(false);
      FM.viz.stop();
      applyPlayingState();
    });

    refs.btnPlay.addEventListener('click', function () { P.toggle(); });
    refs.shPlay.addEventListener('click', function () { P.toggle(); });
    refs.btnPrev.addEventListener('click', function () { P.prev(); });
    refs.btnNext.addEventListener('click', function () { P.next(); });
    refs.btnBack15.addEventListener('click', function () { P.jumpBy(-15); });
    refs.btnFwd15.addEventListener('click', function () { P.jumpBy(15); });
    refs.shPrev.addEventListener('click', function () { P.prev(); });
    refs.shNext.addEventListener('click', function () { P.next(); });
    refs.shBack.addEventListener('click', function () { P.jumpBy(-15); });
    refs.shFwd.addEventListener('click', function () { P.jumpBy(15); });
    refs.btnVol.addEventListener('click', function () { P.toggleMute(); });
    refs.btnLoop.addEventListener('click', function () { P.cycleLoop(); toast('播放模式：' + P.loopLabel); });

    /* 播放条左侧整块（封面+标题+副标题）点击展开播放详情页；收藏键除外 */
    const pbLeft = refs.playerbar.querySelector('.pb-left');
    if (pbLeft) {
      pbLeft.addEventListener('click', function (e) {
        if (e.target.closest('#pbFav')) return;
        if (P.current) openSheet();
      });
    }

    refs.pbFav.addEventListener('click', toggleFavOfCurrent);
    refs.shFav.addEventListener('click', toggleFavOfCurrent);
    refs.shLoop.addEventListener('click', function () { P.cycleLoop(); toast('播放模式：' + P.loopLabel); });

    refs.btnExpand.addEventListener('click', openSheet);
    refs.btnCollapse.addEventListener('click', closeSheet);
    refs.btnSheetQueue.addEventListener('click', toggleQueue);
    refs.btnQueueClose.addEventListener('click', toggleQueue);

    refs.btnRate.addEventListener('click', function (e) { rateMenu(e.currentTarget); });
    refs.shRate.addEventListener('click', function (e) { rateMenu(e.currentTarget); });
    refs.shSleep.addEventListener('click', function (e) { sleepMenu(e.currentTarget); });

    paintRate(P.rate);
    paintVolume(P.volume, P.muted);
    paintLoop(P.loop);
    paintSleep(0);
    if (P.current) paintTrack(P.current);
  }

  /* 收藏：跟数据库/用户走，先乐观更新，写失败再回滚；同专辑在途时忽略连点 */
  const favPending = new Set();
  function toggleFavorite(albumId) {
    const a = L.album(albumId);
    if (!a || favPending.has(albumId)) return;
    const next = !a.fav;
    favPending.add(albumId);
    a.fav = next;
    toast(next ? '已加入收藏' : '已取消收藏');
    renderAll();
    if (P.current) paintTrack(P.current);
    FM.fs.setFav(albumId, next).then(function (ok) {
      if (ok) return;
      a.fav = !next;
      toast('收藏失败，请稍后重试', 'warn');
      renderAll();
      if (P.current) paintTrack(P.current);
    }).catch(function () {}).then(function () { favPending.delete(albumId); });
  }

  function toggleFavOfCurrent() {
    const t = P.current;
    if (!t) return;
    toggleFavorite(t.albumId);
  }

  /* 档位显示：整数补一位小数，1 → 1.0×、1.25 → 1.25× */
  function fmtRate(r) { return (r % 1 === 0 ? r.toFixed(1) : String(r)) + '×'; }

  /* 倍速菜单：只列档位，当前档高亮打勾（参考 B 站的紧凑弹出层） */
  function rateMenu(anchor) {
    const items = P.RATES.map(function (r) {
      const on = Math.abs(r - P.rate) < 0.001;
      return {
        label: fmtRate(r),
        cls: on ? 'active' : '',
        right: on ? 'check' : '',
        onClick: function () { if (on) return; P.setRate(r); toast('倍速 ' + fmtRate(r)); }
      };
    });
    openMenu(anchor, items, { cls: 'menu-rate', noIcon: true });
  }

  function sleepMenu(anchor) {
    const opts = [15, 30, 45, 60, 90];
    const auto = P.autoSleep || {};
    const items = opts.map(function (m) {
      return {
        label: m + ' 分钟后暂停', icon: 'moon',
        onClick: function () { P.setSleep(m); toast('将在 ' + m + ' 分钟后暂停'); }
      };
    });
    items.push({ sep: true });
    items.push({
      label: '本集播完暂停', icon: 'moon',
      cls: P.sleepMode === 'chapter' ? 'active' : '',
      right: P.sleepMode === 'chapter' ? 'check' : '',
      onClick: function () { P.setSleepChapter(); toast('本集播完后暂停'); }
    });
    items.push({
      label: (auto.on ? '关闭' : '开启') + '每晚 ' + (auto.from || '22:00') + '–' + (auto.to || '07:00') + ' 自动定时',
      icon: 'clock',
      onClick: function () {
        const on = !auto.on;
        P.setAutoSleep(on);
        toast(on ? '夜间时段播放时自动定时 30 分钟' : '已关闭自动定时');
      }
    });
    items.push({ sep: true });
    items.push({ label: '关闭定时', icon: 'close', onClick: function () { P.setSleep(0); toast('已关闭定时'); } });
    openMenu(anchor, items);
  }

  function openSheet() {
    refs.sheet.classList.add('open');
    refs.sheet.setAttribute('aria-hidden', 'false');
    if (P.kind === 'video') { if (FM.android) setCinema(true); wakeUi(); return; }
    FM.viz.attach();
    FM.viz.resume();
    FM.viz.start();
  }

  function closeSheet() {
    if (FM.android && FM.android.fullscreenOn) FM.android.fullscreen(false);
    setCinema(false);
    hideUiNow();
    refs.sheet.classList.remove('open');
    refs.sheet.setAttribute('aria-hidden', 'true');
    if (queueOpen) toggleQueue();
    FM.viz.stop();
  }

  function toggleQueue() {
    queueOpen = !queueOpen;
    refs.queuePanel.hidden = !queueOpen;
    refs.queuePanel.classList.toggle('open', queueOpen);
    refs.sheet.classList.toggle('queue-open', queueOpen);
    if (queueOpen) renderQueue();
  }

  function renderQueue() {
    const q = P.queue;
    const head = refs.queuePanel.querySelector('.queue-head strong');
    if (head) head.textContent = P.kind === 'video' ? '选集' : '播放队列';
    refs.queueCount.textContent = q.length ? (P.index + 1) + ' / ' + q.length : '空';
    refs.sheetQueue.innerHTML = q.map(function (t, i) {
      return '<div class="q-item' + (i === P.index ? ' on' : '') + '" data-qi="' + i + '">' +
        '<span class="q-idx"><i class="num">' + (i + 1) + '</i><svg class="i q-pico"><use href="#i-play"/></svg></span>' +
        '<span class="q-name">' + esc(t.title) + '</span>' +
        '<span class="q-dur">' + (t.duration ? fmtT(t.duration) : '') + '</span></div>';
    }).join('') || '<div class="empty" style="padding:40px 10px"><p>队列为空</p></div>';
  }

  refsQueueClick();
  function refsQueueClick() {
    document.addEventListener('click', function (e) {
      const item = e.target.closest('.q-item');
      if (!item) return;
      const i = parseInt(item.dataset.qi, 10);
      if (isNaN(i)) return;
      P.setQueue(P.queue, i, { autoplay: true });
    });
  }

  /* ── 进度条拖动 ── */
  function bindScrubs() {
    setupScrub(refs.pbScrub, {
      seek: r => P.seekRatio(r),
      preview: (r, text) => { refs.pbTip.textContent = text; refs.pbTip.style.setProperty('--tipx', (r * 100) + '%'); }
    });
    setupScrub(refs.shScrub, {
      seek: r => P.seekRatio(r),
      preview: (r, text) => { refs.shTip.textContent = text; refs.shTip.style.setProperty('--tipx', (r * 100) + '%'); }
    });
    setupScrub(refs.volScrub, {
      vertical: true, self: true, holder: '.vol-wrap',
      seek: r => P.setVolume(r),
      preview: null,
      live: r => P.setVolume(r)
    });
    setupScrub(refs.vScrub, {
      seek: r => P.seekRatio(r),
      preview: (r, text) => { refs.vTip.textContent = text; refs.vTip.style.setProperty('--tipx', (r * 100) + '%'); }
    });
    setupScrub(refs.vVolScrub, {
      vertical: true, self: true, holder: '.vol-wrap',
      seek: r => P.setVolume(r),
      preview: null,
      live: r => P.setVolume(r)
    });
  }

  function setupScrub(root, opt) {
    if (!root) return;
    /* self：容器本身就是轨道（竖向音量条）；vertical：按 Y 取比例，底大顶小 */
    const track = opt.self ? root : root.querySelector('.scrub-track');
    const holder = opt.holder ? root.closest(opt.holder) : null;
    let dragging = false;
    function ratioAt(e) {
      const r = track.getBoundingClientRect();
      if (opt.vertical) return U.clamp(1 - (e.clientY - r.top) / Math.max(1, r.height), 0, 1);
      return U.clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
    }
    function apply(r) {
      root.style.setProperty('--p', (r * 100) + '%');
      if (opt.preview) {
        const d = P.media.duration || 0;
        opt.preview(r, d ? fmtT(d * r) : '--:--');
      }
    }
    /* 收尾统一走这里：鼠标在轨道外抬起、或指针捕获失败时也要能复位，
       否则 dragging/scrubbing 会卡在 true（进度时间不再刷新） */
    function endDrag(e, commit) {
      if (!dragging) return;
      dragging = false;
      scrubbing = false;
      root.classList.remove('dragging');
      if (holder) holder.classList.remove('dragging');
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      if (!commit) return;
      const r = ratioAt(e);
      opt.seek && opt.seek(r);
      if (opt.live) opt.live(r);
    }
    function onUp(e) { endDrag(e, true); }
    function onCancel() { endDrag(null, false); }

    root.addEventListener('pointerdown', function (e) {
      dragging = true;
      scrubbing = true;
      root.classList.add('dragging');
      if (holder) holder.classList.add('dragging');      /* 竖向音量：拖动时弹层别收起来 */
      /* 捕获只是"锦上添花"：拿不到也不影响，收尾靠 document 上的监听 */
      try { root.setPointerCapture && root.setPointerCapture(e.pointerId); } catch (err) {}
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
      const r = ratioAt(e);
      apply(r);
      if (opt.live) opt.live(r);
    });
    root.addEventListener('pointermove', function (e) {
      const r = ratioAt(e);
      if (dragging) { apply(r); if (opt.live) opt.live(r); }
      else if (opt.preview) opt.preview(r, (P.media.duration ? fmtT(P.media.duration * r) : '--:--'));
    });
  }

  /* ── 键盘 ── */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      const tag = (document.activeElement || {}).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (P.kind === 'video') wakeUi();
      switch (e.key) {
        case ' ':
          e.preventDefault(); P.toggle(); break;
        case 'ArrowLeft':
          if (e.shiftKey) { P.prev(); } else { e.preventDefault(); P.jumpBy(-15); }
          break;
        case 'ArrowRight':
          if (e.shiftKey) { P.next(); } else { e.preventDefault(); P.jumpBy(15); }
          break;
        case 'ArrowUp':
          e.preventDefault(); P.setVolume(Math.min(1, P.media.volume + 0.05)); break;
        case 'ArrowDown':
          e.preventDefault(); P.setVolume(Math.max(0, P.media.volume - 0.05)); break;
        case 'n': case 'N': P.next(); break;
        case 'p': case 'P': P.prev(); break;
        case 'm': case 'M': P.toggleMute(); break;
        case 'f': case 'F': refs.sheet.classList.contains('open') ? closeSheet() : openSheet(); break;
        case '[': P.cycleRate(-1); toast('倍速 ' + P.rate + '×'); break;
        case ']': P.cycleRate(1); toast('倍速 ' + P.rate + '×'); break;
        case 'Escape':
          if (cinema) { setCinema(false); break; }
          if (refs.sheet.classList.contains('open')) closeSheet();
          closeMenu(); closeDrawer();
          break;
        case '/':
          e.preventDefault(); refs.searchInput.focus(); break;
        default: break;
      }
    });
  }

  /* 连接远程后端：口令换 token 写进 remote.json，重载后数据通路切到远端（本地库不动） */
  function openRemoteDialog() {
    const cur = FM.fs.remote;
    const base = U.el('input', { class: 'input', value: cur ? cur.base : '', placeholder: 'http://服务器地址:8080', spellcheck: false });
    const user = U.el('input', { class: 'input', value: 'admin', placeholder: '用户名', autocomplete: 'username', spellcheck: false });
    const pw = U.el('input', { class: 'input', type: 'password', placeholder: '密码（服务器没设密码就留空）', autocomplete: 'current-password' });
    const err = U.el('small', { class: 'drawer-sub', style: { color: '#ff8a65' } });
    const body = U.el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
      U.el('p', { style: { fontSize: '12px', color: 'var(--dim)', lineHeight: '1.9' },
        text: '服务器上 node tools/serve.js 8080 启动（默认读桌面端的库列表，支持多个目录）。书和音频都留在服务器上，本机只缓存索引。' }),
      base, user, pw,
      U.el('small', { class: 'drawer-sub', text: '连接成功后会重载界面。' }),
      err
    ]);
    openModal({
      title: cur ? '远程服务器设置' : '连接远程服务器',
      body: body,
      actions: (cur ? [{
        label: '断开连接', cls: 'btn-ghost',
        onClick: async function () { await window.fmNative.setRemote(null); location.reload(); return false; }
      }] : []).concat([{
        label: '连接', cls: 'btn-primary',
        onClick: function () { connect(); return false; }
      }])
    });

    async function connect() {
      const b = base.value.trim().replace(/\/+$/, '');
      if (!b) { err.textContent = '先填服务器地址'; return; }
      err.textContent = '连接中…';
      try {
        const r = await fetch(b + '/api/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: (user.value || 'admin').trim(), password: pw.value })
        });
        if (!r.ok) throw new Error(r.status === 401 ? '用户名或密码不正确' : '服务器返回 ' + r.status);
        const data = await r.json();
        await window.fmNative.setRemote({ base: b, token: data.token || '' });
        location.reload();
      } catch (e) {
        err.textContent = (e && e.message === '用户名或密码不正确') ? e.message : U.NET_FAIL;
      }
    }
  }

  /* ── 资源库 ── */
  function openLibMenu(anchor) {
    const list = FM.fs.libs();
    const items = list.map(function (l) {
      const on = l.id === FM.fs.activeId;
      return {
        label: l.name + (l.missing ? '（不可用）' : ''),
        icon: on ? 'check' : (l.missing ? 'moon' : 'folder'),
        onClick: function () { switchLib(l.id); }
      };
    });
    if (list.length) items.push({ sep: true });
    items.push({ label: '资源库设置…', icon: 'edit', onClick: openLibDrawer });
    if (FM.android) {
      items.push({ label: '服务器地址…', icon: 'chevron', onClick: function () { FM.android.openSettings(); } });
    }
    if (FM.fs.desktop) {
      items.push({ label: FM.fs.remote ? '远程服务器设置…' : '连接远程服务器…', icon: 'chevron', onClick: openRemoteDialog });
    }
    openMenu(anchor, items);
  }

  /* 资源库设置：右侧抽屉，不遮住主界面，切库的上下文还在 */
  function openLibDrawer() {
    const sub = U.el('small', { class: 'drawer-sub' });
    const list_ = U.el('div', { class: 'lib-list' });
    const mask = U.el('div', { class: 'lib-drawer-mask' });
    const panel = U.el('div', { class: 'lib-drawer' });
    let closed = false;

    const head = U.el('div', { class: 'lib-drawer-head' });
    const titleBox = U.el('div', { class: 'lib-drawer-title' }, [U.el('h3', { text: '资源库设置' }), sub]);
    const x = U.el('button', { class: 'icon-btn', title: '关闭', html: icon('close') });
    x.onclick = function () { close(); };
    head.append(titleBox, x);

    const body = U.el('div', { class: 'lib-drawer-body' }, [list_]);

    const foot = U.el('div', { class: 'lib-drawer-foot' });
    /* 单目录模式、或服务端没开 --allow-lib-edit 时，列表是只读的，不给「添加」 */
    const canAdd = !FM.fs.server || FM.fs.libs().some(function (l) { return !l.fixed; });
    if (FM.fs.remote && !canAdd) {
      body.insertBefore(U.el('div', {
        class: 'lib-drawer-tip',
        text: '无法修改远程资源库。如需修改本地资源库，请先断开远程连接。'
      }), list_);
    }
    if (canAdd) {
      const add = U.el('button', { class: 'btn', html: icon('plus') + '<span>添加资源库</span>' });
      add.onclick = function () { close(); addLibFlow(); };
      foot.appendChild(add);
    }
    /* 远端设置入口在资源库菜单里（「远程服务器设置…」），抽屉底部不再重复放一个 */
    /* 壳里没有「在文件夹中打开」这类本地动作，换成唯一有用的：换服务器 */
    if (FM.android) {
      const appBtn = U.el('button', { class: 'btn btn-ghost lib-remote-btn', title: '服务器地址' });
      appBtn.innerHTML = '<span class="remote-txt"><b>服务器地址</b><small>' + esc(FM.android.base() || '未设置') + '</small></span>';
      appBtn.onclick = function () { close(); FM.android.openSettings(); };
      foot.appendChild(appBtn);
    }
    const done = U.el('button', { class: 'btn btn-primary', text: '完成' });
    done.onclick = function () { close(); };
    foot.appendChild(done);

    panel.append(head, body, foot);
    refs.modalRoot.append(mask, panel);

    /* ESC 关抽屉，但别把上面叠着的确认框一起关掉 */
    function onKey(e) {
      if (e.key !== 'Escape' || closed) return;
      if (refs.modalRoot.querySelector('.modal-mask')) return;
      close();
    }
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      mask.classList.remove('show');
      panel.classList.remove('open');
      setTimeout(function () { mask.remove(); panel.remove(); }, 380);
    }
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(function () {
      if (closed) return;
      mask.classList.add('show');
      panel.classList.add('open');
    });

    const handle = { close: close, panel: panel };

    function draw() {
      const list = FM.fs.libs();
      const curLib = list.filter(function (x) { return x.id === FM.fs.activeId; })[0];
      sub.textContent = list.length
        ? list.length + ' 个 · 当前 ' + (curLib ? curLib.name : '未选择') + (FM.fs.remote ? ' · 远程' : '')
        : '还没有添加';
      list_.innerHTML = '';
      if (!list.length) {
        list_.innerHTML = '<div class="lib-empty">还没有资源库。添加一个放音频 / 视频的文件夹就能开始。</div>';
        return;
      }
      list.forEach(function (l) {
        const cur = l.id === FM.fs.activeId;
        const row = U.el('div', { class: 'lib-row' + (cur ? ' current' : '') + (l.missing ? ' missing' : '') });
        row.innerHTML =
          '<span class="lib-ico">' + icon(l.missing ? 'moon' : ((l.fixed || FM.fs.remote) ? 'library' : 'folder')) + '</span>' +
          '<div class="lib-info"><b>' + esc(l.name) + '</b><small>' +
            esc((l.fixed || FM.fs.remote) ? '远程资源库' : String(l.path || '').replace(/\\/g, '/')) +
          '</small>' + (l.missing ? '<em>资源库目录不存在，需要重新定位</em>' : '') + '</div>' +
          (cur ? '<span class="lib-cur">当前</span>' : '') +
          (l.fixed ? '' : '<button class="icon-btn lib-more" title="更多">' + icon('more') + '</button>');
        const more = row.querySelector('.lib-more');
        if (more) more.addEventListener('click', function (e) { e.stopPropagation(); libRowMenu(e.currentTarget, l, draw, handle); });
        row.addEventListener('click', function (e) {
          if (e.target.closest('.lib-more') || cur) return;
          if (l.missing) { toast('资源库目录不存在，请先重新定位', 'warn'); return; }
          close();
          switchLib(l.id);
        });
        list_.appendChild(row);
      });
    }

    draw();
    return handle;
  }

  function libRowMenu(anchor, l, redraw, modal) {
    const items = [];
    if (l.id !== FM.fs.activeId) {
      items.push({
        label: '切换到此资源库', icon: 'check',
        onClick: function () { if (modal) modal.close(); switchLib(l.id); }
      });
    }
    items.push({ label: '重命名', icon: 'edit', onClick: function () { renameLibFlow(l, redraw); } });
    if (FM.fs.native) {
      items.push({ label: '重新定位…', icon: 'folder', onClick: function () { relocateFlow(l, redraw); } });
      items.push({ label: '在文件夹中打开', icon: 'folder', onClick: function () { FM.fs.openLib(l.id); } });
    }
    items.push({ sep: true });
    items.push({
      label: '移除资源库', icon: 'trash', danger: true,
      onClick: function () { removeLibFlow(l, redraw); }
    });
    openMenu(anchor, items);
  }

  function renameLibFlow(l, after) {
    const input = U.el('input', { class: 'input', value: l.name, placeholder: '资源库名称' });
    const body = U.el('div', {}, [U.el('div', { class: 'field' }, [U.el('label', { text: '显示名称' }), input])]);
    openModal({
      title: '重命名资源库',
      body: body,
      actions: [
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '保存', cls: 'btn-primary',
          onClick: function () {
            const v = input.value.trim();
            if (!v) { toast('名称不能为空', 'warn'); return false; }
            FM.fs.rename(l.id, v).then(function () {
              toast('已重命名');
              renderStat();
              if (after) after();
            }).catch(function (e) {
              toast(e.message || '重命名失败', 'warn');
            });
          }
        }
      ]
    });
  }

  async function removeLibFlow(l, after) {
    const ok = await confirmModal({
      title: '移除资源库',
      danger: true,
      icon: 'trash',
      message: '移除资源库「' + l.name + '」？',
      note: '文件夹和里面的文件不会被删除，分类和收藏也保留在本机。',
      okText: '移除'
    });
    if (!ok) return;
    try {
      const wasActive = l.id === FM.fs.activeId;
      if (wasActive) P.stop();
      const next = await FM.fs.remove(l.id);
      if (wasActive) {
        resetView();
        if (next) await enterLib({ force: true });
        else { L.clear(); renderAll(); renderWelcome(); }
      }
      renderAll();
      toast('已移除资源库');
      if (after) after();
    } catch (e) {
      toast(e.message || '移除失败', 'warn');
    }
  }

  async function relocateFlow(l, after) {
    if (!l || !FM.fs.native) { toast('当前模式不支持重新定位', 'warn'); return; }
    try {
      const wasActive = l.id === FM.fs.activeId;
      const v = await FM.fs.relocate(l.id);
      if (!v) return;
      toast('已重新定位到 ' + v.path);
      if (wasActive) {
        resetView();
        await enterLib({ force: true });
      }
      renderAll();
      if (after) after();
    } catch (e) {
      toast(e.message || '重新定位失败', 'warn');
    }
  }

  function addLibFlow() {
    if (FM.fs.server) { addLibByPath(); return; }
    runAddLib('');
  }

  /* 服务器模式：浏览器弹不出对方的目录选择框，改成让人填路径 */
  function addLibByPath() {
    const input = U.el('input', { class: 'input', placeholder: '例如 E:/学习资料/喜马拉雅mp3' });
    const body = U.el('div', {}, [
      U.el('div', { class: 'field' }, [U.el('label', { text: '服务器上的目录' }), input])
    ]);
    body.insertAdjacentHTML('beforeend',
      '<div style="font-size:11.5px;color:var(--dim);line-height:1.6">填运行服务的那台机器上的绝对路径——浏览器这边选不了对方的文件夹。' +
      '加完会写进那台机器的 config.json，桌面版下次刷新也能看到。</div>');
    openModal({
      title: '添加资源库',
      body: body,
      actions: [
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '添加', cls: 'btn-primary', onClick: function () {
            const v = input.value.trim();
            if (!v) { toast('请输入目录路径', 'warn'); return false; }
            runAddLib(v);
          }
        }
      ]
    });
  }

  async function runAddLib(path) {
    try {
      setScanBusy(true, '添加资源库…');
      const lib = await FM.fs.add(path || undefined);
      if (!lib) return;
      P.stop();
      resetView();
      await enterLib({ force: true });
      renderAll();
      toast('已添加资源库「' + lib.name + '」');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast(e.message || '添加资源库失败', 'warn');
    } finally {
      setScanBusy(false);
    }
  }

  /* ── 切库过渡：盖一层加载层，内容淡出→切换→淡回 ── */
  const LIB_SWITCH_MIN = 620;   // 过渡至少停留这么久，缓存命中时也不会一闪而过
  let libSwitchSeq = 0;
  let libHideTimer = 0;

  function beginLibSwitch(name) {
    const seq = ++libSwitchSeq;
    clearTimeout(libHideTimer);
    if (!refs.libLoading || !refs.main) return seq;
    refs.libLoadingName.textContent = name || '资源库';
    if (refs.libLoadingHint) refs.libLoadingHint.textContent = '正在载入…';
    refs.libLoading.hidden = false;
    /* 先上屏再挂 show，样式过渡才有起点 */
    requestAnimationFrame(function () {
      if (seq !== libSwitchSeq) return;
      refs.libLoading.classList.add('show');
      refs.main.classList.add('lib-switching');
    });
    return seq;
  }

  function endLibSwitch(seq, started) {
    if (seq !== libSwitchSeq || !refs.libLoading || !refs.main) return Promise.resolve();
    const wait = Math.max(0, LIB_SWITCH_MIN - (Date.now() - started));
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (seq !== libSwitchSeq) { resolve(); return; }
        refs.libLoading.classList.remove('show');
        refs.main.classList.remove('lib-switching');
        libHideTimer = setTimeout(function () {
          if (!refs.libLoading.classList.contains('show')) refs.libLoading.hidden = true;
        }, 420);
        resolve();
      }, wait);
    });
  }

  async function switchLib(id) {
    if (!id || id === FM.fs.activeId) return;
    const lib = FM.fs.libs().find(l => l.id === id);
    if (!lib) return;
    if (lib.missing) {
      toast('「' + lib.name + '」资源库目录不存在，请先重新定位', 'warn');
      openLibDrawer();
      return;
    }
    const seq = beginLibSwitch(lib.name);
    const started = Date.now();
    setScanBusy(true, '切换资源库…');
    try {
      /* 先切通道，成功了再停播：授权失败时不会白白打断正在听的内容 */
      await FM.fs.activate(id);
      P.stop();
      resetView();
      await enterLib({});
      renderAll();
      await endLibSwitch(seq, started);
      toast('已切换到「' + lib.name + '」');
    } catch (e) {
      await endLibSwitch(seq, started);
      toast(e.message || '切换资源库失败', 'warn');
    } finally {
      setScanBusy(false);
    }
  }

  /* 进入当前库：有缓存先秒出，再后台补扫 */
  async function enterLib(opts) {
    const o = opts || {};
    const id = FM.fs.activeId;
    if (!id) { L.clear(); renderAll(); renderWelcome(); return; }
    /* 服务器模式：先把桌面端整理的元数据拉下来，分类才带得出来 */
    if (FM.fs.server) { try { await FM.fs.pullMeta(); } catch (e) {} }
    const cached = o.force ? null : FM.db.index(id);
    if (cached && cached.albums && cached.albums.length) {
      try { await FM.covers.load(); } catch (e) {}
      L.restore(id);
      FM.store.write('lastLib', id);
      FM.store.touch('lastLib');
      renderAll();
      /* 切库后顺手把这库的元数据落一份，远程那边才有东西可读 */
      if (FM.app && FM.app.scheduleMetaWrite) FM.app.scheduleMetaWrite(1500, true);
      /* 1.2 秒后再补扫；期间已经切走就不扫了 */
      setTimeout(function () { if (id === FM.fs.activeId) autoRescan(true); }, 1200);
      return;
    }
    await runScan({ silent: true });
  }

  function resetView() {
    state.view = 'home'; state.cat = null; state.albumId = null;
    state.q = ''; state.detailQ = ''; state.page = 0;
    if (refs.searchInput) refs.searchInput.value = '';
    if (refs.searchClear) refs.searchClear.hidden = true;
    if (location.hash && location.hash !== '#/' && location.hash !== '') location.hash = '#/';
    else route();
  }

  function renderBrokenLib() {
    const lib = FM.fs.active();
    /* 当前库不可用时别留着上一个库的内容，免得侧栏统计对不上 */
    L.clear();
    renderNav(); renderCats(); renderStat();
    const native = FM.fs.native;
    const why = native
      ? '资源库目录不在了，可能被重命名、移动，或者磁盘没接上。<br>重新定位到新位置就行，分类和收藏都不会丢。'
      : '浏览器里的目录授权丢了（清理过浏览数据？）。<br>重新添加这个资源库就行，分类和收藏还在。';
    const fix = native
      ? '<button class="btn btn-primary" data-act="relocate-lib" style="height:44px;padding:0 24px">' + icon('folder') + '重新定位</button>'
      : '<button class="btn btn-primary" data-act="scan" style="height:44px;padding:0 24px">' + icon('folder') + '重新添加资源库</button>';
    refs.view.innerHTML = '<div class="welcome">' +
      '<div class="welcome-orbit"><i></i><i></i><i></i><div class="core">' + icon('folder') + '</div></div>' +
      '<h1>资源库<em>找不到</em>了</h1>' +
      '<p>「' + esc(lib ? lib.name : '当前资源库') + '」的' + why + '</p>' +
      '<div style="display:flex;gap:10px;margin-top:6px">' +
        fix +
        '<button class="btn btn-ghost" data-act="lib-menu" style="height:44px;padding:0 24px">' + icon('list') + '切换资源库</button>' +
      '</div></div>';
  }

  /* ── 扫描 ── */
  async function doScan() {
    if (!FM.fs.hasSource) { addLibFlow(); return; }
    try {
      setScanBusy(true, '准备中…');
      if (FM.fs.server) { try { await FM.fs.pullMeta(); } catch (e) {} }
      if (!FM.fs.granted) {
        const ok = await FM.fs.grant();
        if (!ok) throw new Error('目录授权被拒绝');
      }
      await runScan();
    } catch (e) {
      toast(e.message || '扫描失败', 'warn');
    } finally {
      setScanBusy(false);
    }
  }

  /* 内容指纹：专辑集合、集数、时长、体积、分类、收藏，任一变化才算更新 */
  function libSignature() {
    return L.albums().map(function (a) {
      return [a.id, a.count, a.duration, a.size, a.fav ? 1 : 0, a.hidden ? 1 : 0, (a.cats || []).join('+')].join(',');
    }).join('|');
  }

  let scanSeq = 0;
  async function runScan(opts) {
    const o = opts || {};
    const libId = o.libId || FM.fs.activeId;
    if (!libId || libId !== FM.fs.activeId) return false;
    /* 收藏可能在别的端刚改过：扫描前重拉一次，别让界面停在旧状态 */
    try { await FM.fs.loadFavs(libId); } catch (e) {}
    const my = ++scanSeq;
    setScanBusy(true, '正在扫描资源库…');
    try {
      const scan = await FM.fs.scan(function (p) {
        if (p.phase === 'list') setScanBusy(true, '发现 ' + p.count + ' 个音频…');
        else setScanBusy(true, '读取文件信息 ' + p.done + ' / ' + p.total);
      });
      /* 扫描期间切了库：这份结果属于上一个库，直接丢掉，别把界面串了 */
      if (libId !== FM.fs.activeId) return false;
      /* 换库或刚抓完封面时，索引会变，重新读一遍 */
      try { await FM.covers.load(); } catch (e) {}
      if (libId !== FM.fs.activeId) return false;
      /* 静默补扫先记内容指纹：扫完一模一样就不重绘，页面不会无端跳一下 */
      const before = o.silent ? libSignature() : '';
      L.build(scan);
      if (FM.fs.activeId) {
        FM.store.write('lastLib', FM.fs.activeId);
        FM.store.touch('lastLib');
      }
      if (!o.silent) renderAll();
      else if (libSignature() !== before) renderAll({ quiet: true });
      if (!o.silent) toast('资源库已更新：' + L.albums().length + ' 个专辑 · ' + L.tracks().length + ' 集');
      /* 服务端扫完也会在后台补封面，隔一会儿读一次索引，拿到新图就重绘 */
      if (FM.fs.server && scan.coversPending) watchCovers(libId);
      return true;
    } finally {
      /* 只有最新那次扫描能收起进度，旧扫描收尾不许关掉新扫描的提示 */
      if (my === scanSeq) setScanBusy(false);
    }
  }

  /* 等后台封面任务：每 15 秒看一次索引，数量变了才重绘，最多看 5 分钟 */
  let coverWatch = 0;
  function watchCovers(libId) {
    const my = ++coverWatch;
    let tries = 0;
    let last = FM.covers.count;
    const timer = setInterval(async function () {
      if (my !== coverWatch || libId !== FM.fs.activeId || ++tries > 20) { clearInterval(timer); return; }
      try {
        const n = await FM.covers.load();
        if (n && n !== last) {
          last = n;
          FM.covers.apply();
          renderAll({ quiet: true });
          if (FM.player.current) paintTrack(FM.player.current);
        }
      } catch (e) {}
    }, 15000);
  }

  async function autoRescan(silent) {
    if (!FM.fs.granted || !FM.fs.hasSource) return;
    const libId = FM.fs.activeId;
    try {
      /* 带上发起时的库 id：定时器到点时如果已经切走了，这次补扫直接作废 */
      await runScan({ silent: true, libId });
    } catch (e) {
      console.warn('[scan] 自动扫描失败', e);
      if (!silent) toast(U.NET_FAIL, 'warn');
    }
  }

  function syncMode() {
    document.body.classList.toggle('is-server', !!FM.fs.server);
    /* 退出登录只对浏览器直连服务器有意义：Electron 界面没有登录态 */
    if (refs.btnLogout) {
      refs.btnLogout.hidden = !(!FM.fs.desktop && !FM.android && !!FM.fs.server);
    }
    paintVersion();
  }

  /* 左侧 logo 旁显示当前程序版本：Electron 读 app 版本，APK 读壳版本，浏览器读服务端 package.json */
  function paintVersion() {
    const el = refs.brandVer;
    if (!el) return;
    let v = '';
    if (window.fmNative && window.fmNative.version) v = String(window.fmNative.version);
    else if (FM.android && FM.android.native) { try { v = String(FM.android.version() || ''); } catch (e) {} }
    else if (FM.fs.server) v = String(FM.fs.version || '');
    el.textContent = v ? 'v' + v : '';
    el.hidden = !v;
  }

  function renderAll(opts) {
    syncMode();
    renderNav();
    renderCats();
    renderStat();
    renderMain(opts);
  }

  FM.ui = {
    init, renderAll, paintTrack, syncMode, downloadsChanged,
    autoRescan, runScan, enterLib, switchLib, addLibFlow,
    openLibMenu, openLibDrawer, renderStat, renderWelcome, renderBrokenLib,
    toast, openSheet, closeSheet,
    get refs() { return refs; }
  };
})(window.FM);
