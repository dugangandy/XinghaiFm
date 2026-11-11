/* ── ui.js · 界面渲染与交互 ───────────────────────────── */
(function (FM) {
  'use strict';
  const U = FM.util, L = FM.lib, P = FM.player;
  const esc = U.escape, icon = U.icon, fmtT = U.fmtTime, fmtS = U.fmtSize, fmtD = U.fmtDur;

  const state = { view: 'home', cat: null, albumId: null, q: '', qScope: 'all', qTab: 'album', detailQ: '', sortDesc: false, showHidden: false, page: 0, trackShown: 0, qMore: false, gridShown: 0 };
  const PAGE = 30;            // 专辑声音列表每页集数（手机端滚动加载也拿它当批大小）
  const SEARCH_ALBUMS = 24;   // 搜索结果首屏最多画多少张卡片（点「显示更多」才展开）
  const SEARCH_TRACKS = 40;   // 搜索结果首屏最多画多少行单集（音频 / 视频各自算）
  const GRID_BATCH = 60;      // 专辑网格每批画多少张卡（一次画几百张要几百毫秒）
  const TRACK_END = '已经到底啦~';   // 手机端滚动加载到底时的收尾文案
  let refs = {};
  let dragId = null;
  let queueOpen = false;
  let scrubbing = false;
  let menuEl = null;
  let menuOff = null;
  /* 浮层登记表：弹窗、抽屉这类挂在 modalRoot 上的层，打开时把自己的 close 压进来，
     关闭时摘掉。返回键从栈顶收，既不用按 DOM 猜顺序，也不用合成 mousedown。 */
  const layerStack = [];
  function pushLayer(close) { layerStack.push(close); }
  function dropLayer(close) {
    const i = layerStack.indexOf(close);
    if (i >= 0) layerStack.splice(i, 1);
  }
  let gridTail = null;        // 还没画出来的专辑（滚动加载用）
  let trackTail = null;       // 手机端还没画出来的曲目（滚动加载用）
  let searchTail = null;      // 搜索结果当前标签下、还没画出来的条目（滚动加载用）
  let searchTotal = 0;        // 当前标签的命中总数（副标题「当前显示 x / y」用）
  let searchCountOn = false;  // 命中超过首屏预算时才显示上面那个计数
  let statsViewTeardown = null;   // 统计页的实时订阅与定时器，换页时必须显式清掉
  let albumViewTeardown = null;   // 专辑管理页的批量抓取任务，换页 / 换库时必须停掉
  /* 批量补封面的任务状态：只在本次会话内有效，不落盘。
     rows 以专辑 id 为键（渲染时按 albumId 合并），离开页面再回来还能看到上次的抓取结果 */
  let coverJob = null;
  let amListScroll = 0;           // 专辑管理列表内部滚动位置（保存 / 停止后重绘别跳回顶部）
  let amScrollPage = -1;          // 上面那个滚动位置属于第几页：翻页后要回顶部

  const CAT_COLORS = ['#22d3ee', '#a855f7', '#f472b6', '#34d399', '#fbbf24', '#ff8a65', '#60a5fa', '#c084fc'];

  function $(id) { return document.getElementById(id); }

  /* 页内「← 返回」那一行：手机断点（≤760px，含安卓壳）不再画——
     它跟着内容滚走，长列表要滚回顶部才点得到，还白占一行高度。
     手机改由顶栏左侧那颗常驻的返回箭头承担（见 paintTopbar / goBack）。
     桌面端与 761px 以上保持原样。用函数而不是加载期常量：横竖屏、分屏改宽度后要跟着变。 */
  const APP = !!(FM.android && FM.android.native);
  function inlineBack() { return !APP && !isPhone(); }
  function backBtn() { return inlineBack() ? '<button class="link-btn" data-act="back">← 返回</button>' : ''; }
  function backSpare() { return inlineBack() ? '<span class="dl-page-spare"></span>' : ''; }

  function backHead(actions) {
    if (!inlineBack()) return '';
    return '<div class="view-head" style="padding:10px 2px 0">' + backBtn() +
      (actions ? '<div class="head-actions">' + actions + '</div>' : '') + '</div>';
  }

  /* ── 初始化 ── */
  function init() {
    refs = {
      view: $('view'), nav: $('nav'), catList: $('catList'), libStat: $('libStat'),
      topbar: $('topbar'), sidebar: $('sidebar'), drawerMask: $('drawerMask'), btnMenu: $('btnMenu'), brand: $('brand'), brandVer: $('brandVer'),
      tbBrand: $('tbBrand'), tbBack: $('tbBack'), tbTitle: $('tbTitle'), btnSettings: $('btnSettings'),
      libSwitch: $('libSwitch'), libName: $('libName'), libPath: $('libPath'), libBadge: $('libBadge'),
      btnSync: $('btnSync'), btnAddCat: $('btnAddCat'),
      searchInput: $('searchInput'), searchClear: $('searchClear'),
      searchWrap: $('searchWrap'), searchPop: $('searchPop'),
      scanState: $('scanState'), scanStateText: $('scanStateText'),
      linkState: $('linkState'), linkStateText: $('linkStateText'),
      playerbar: $('playerbar'), pbCover: $('pbCover'), pbTitle: $('pbTitle'), pbSub: $('pbSub'), pbTime: $('pbTime'), pbFav: $('pbFav'), pbKind: $('pbKind'),
      pbQueue: $('pbQueue'), locateFab: $('locateFab'),
      btnPrev: $('btnPrev'), btnPlay: $('btnPlay'), btnNext: $('btnNext'),
      btnBack15: $('btnBack15'), btnFwd15: $('btnFwd15'),
      pbCur: $('pbCur'), pbDur: $('pbDur'), pbScrub: $('pbScrub'), pbTip: $('pbTip'),
      pbProgress: $('pbProgress'), pbProgressTip: $('pbProgressTip'),
      btnRate: $('btnRate'), btnLoop: $('btnLoop'), btnVol: $('btnVol'), volScrub: $('volScrub'), btnExpand: $('btnExpand'),
      volNum: $('volNum'), vVolNum: $('vVolNum'), btnLogout: $('btnLogout'),
      sheet: $('sheet'), sheetArt: $('sheetArt'), sheetArtImg: $('sheetArtImg'), btnCollapse: $('btnCollapse'),
      sheetCover: $('sheetCover'), sheetDisc: $('sheetDisc'), shTitle: $('shTitle'), shSub: $('shSub'),
      shSubText: $('shSubText'), shFavTag: $('shFavTag'),
      shCur: $('shCur'), shDur: $('shDur'), shScrub: $('shScrub'), shTip: $('shTip'),
      shPlay: $('shPlay'), shPrev: $('shPrev'), shNext: $('shNext'), shBack: $('shBack'), shFwd: $('shFwd'),
      shRate: $('shRate'), shSleep: $('shSleep'), shLoop: $('shLoop'), shFav: $('shFav'),
      /* 移动端专属：操作行 + 控制行队列/定时 + 底部专辑卡 */
      shmDownload: $('shmDownload'), shmRate: $('shmRate'), shmFav: $('shmFav'), shmMore: $('shmMore'), shmLoop: $('shmLoop'),
      shmQueue: $('shmQueue'), shmSleep: $('shmSleep'),
      shAlbumCard: $('shAlbumCard'), shAlbumCover: $('shAlbumCover'),
      shAlbumTitle: $('shAlbumTitle'), shAlbumSub: $('shAlbumSub'), shAlbumFav: $('shAlbumFav'),
      media: $('media'), vStage: $('vStage'), vUi: $('vUi'), vTitle: $('vTitle'), vSub: $('vSub'),
      vScrub: $('vScrub'), vTip: $('vTip'), vCur: $('vCur'), vDur: $('vDur'),
      vPlay: $('vPlay'), vPrev: $('vPrev'), vNext: $('vNext'), vRate: $('vRate'),
      vVol: $('vVol'), vVolScrub: $('vVolScrub'), vPip: $('vPip'), vCinema: $('vCinema'), vFull: $('vFull'),
      vCollapse: $('vCollapse'), vQueue: $('vQueue'), vBigPlay: $('vBigPlay'), vLoading: $('vLoading'),
      queuePanel: $('queuePanel'), sheetQueue: $('sheetQueue'), btnSheetQueue: $('btnSheetQueue'),
      btnQueueClose: $('btnQueueClose'), btnQueueClear: $('btnQueueClear'), queueCount: $('queueCount'),
      modalRoot: $('modalRoot'), toastRoot: $('toastRoot'),
      main: $('main'), libLoading: $('libLoading'), libLoadingName: $('libLoadingName'), libLoadingHint: $('libLoadingHint'),
      scanMask: $('scanMask'), scanMaskName: $('scanMaskName'), scanMaskHint: $('scanMaskHint'),
      tcLoading: $('tcLoading'), tcName: $('tcName'), tcHint: $('tcHint')
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
    /* 上面 renderWelcome 那条路不走 renderMain，顶栏态在这里兜一次 */
    paintTopbar();
    paintSearchHint();
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
    /* 恢复：本地还有库就补刷一次；一条库都没有说明开机就没连上，直接重载走完整启动。
       上次扫描成功（有缓存）就不重扫，断线前的内容照样能用 */
    if (!FM.fs.libs().length) { location.reload(); return; }
    toast('已重新连接');
    if (needRescan(FM.fs.activeId)) autoRescan(true);
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

  /* 壳推来「下载有变化」：下载页原地改数字，其它页面只补标记，别打断滚动 */
  /* 只有「有哪些条目」变了才整页重画（新入队 / 删除）；下载中→完成这种状态变化
     一秒来好几次，整页重画会把列表刷得一直闪、滚动也跟着跳回顶部，所以只就地改文案 */
  let dlSig = null;
  function dlKeysSignature() {
    return Object.keys(dlMap()).sort().join('|');
  }

  function inDlView() {
    return state.view === 'downloads' || state.view.indexOf('dl') === 0;
  }

  function downloadsChanged() {
    const sig = dlKeysSignature();
    const changed = sig !== dlSig;
    dlSig = sig;
    if (inDlView()) {
      if (changed) {
        /* 条目真变了才重建；内外两层滚动位置都要保住，别让正在看的那一段跳回顶部 */
        const top = refs.view.scrollTop;
        const sc = refs.view.querySelector('.dl-scroll');
        const inner = sc ? sc.scrollTop : 0;
        renderMain({ quiet: true });
        refs.view.scrollTop = top;
        const sc2 = refs.view.querySelector('.dl-scroll');
        if (sc2) sc2.scrollTop = inner;
        renderNav();
      } else {
        patchDlProgress();
      }
      return;
    }
    if (!changed) return;
    syncDownloadFlags();
    renderNav();
  }

  /* 原地刷新下载页：进度、状态、汇总数字都在原节点上改，整页不重建 */
  function patchDlProgress() {
    const v = refs.view;
    const map = dlMap();
    /* 状态文案：下载中 42% / 排队中 / 下载失败，做完就空 */
    U.$$('.dl-state', v).forEach(function (el) {
      const e = map[el.dataset.rel];
      const txt = dlStateText(e);
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('bad', !!(e && e.state === 'error'));
    });
    /* 下载详情的曲目行：下完的那一集要能点了，大小也是下完才有 */
    if (state.view === 'dlAlbum') {
      U.$$('.dl-track[data-id]', v).forEach(function (li) {
        const t = L.track(li.dataset.id);
        if (!t) return;
        const e = map[t.rel] || {};
        li.dataset.act = (!e.state || e.state === 'done') ? 'row-play-dl' : 'dl-wait';
        setNodeHtml(li.querySelector('.dl-tk-meta'), dlTrackMetaHtml(t, e));
      });
    }
    /* 下载管理的专辑行：大小 / 集数 / 下载中 3 集 · 41% */
    U.$$('.dl-meta[data-album]', v).forEach(function (el) {
      const a = L.album(el.dataset.album);
      if (a) setNodeHtml(el, dlAlbumMetaHtml(dlSummary(dlAll(a.id)), a));
    });
    /* 抬头汇总 */
    if (state.view === 'downloads') {
      const groups = dlGroups();
      const sub = v.querySelector('.dl-sub');
      if (sub) sub.textContent = dlPageSubText(groups);
      const used = v.querySelector('.dl-used');
      if (used) used.textContent = '已占用 ' + fmtS(dlUsedSize(groups));
    }
    if (state.view === 'dlAlbum' && state.albumId) {
      const a = L.album(state.albumId);
      if (!a) return;
      const hero = v.querySelector('.dl-hero-sub');
      if (hero) hero.textContent = dlHeroSubText(dlTracks(a.id).length, a.count, dlSummary(dlAll(a.id)));
      const tc = v.querySelector('.dl-tool-count');
      if (tc) tc.textContent = dlToolCountText(a.id);
    }
  }

  /* 内容没变就别动节点，别每秒重建一遍 */
  function setNodeHtml(el, html) {
    if (el && el.innerHTML !== html) el.innerHTML = html;
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

  /* key：同槽位只留一条（切库成功的提示被缓存警告顶掉，别两条并排挂着）；
     action：带按钮的提示，按钮自己打开 pointer-events（root 是 none） */
  const toastSlots = Object.create(null);

  function dismissToast(node) {
    if (!node || !node.parentNode) return;
    node.classList.add('out');
    setTimeout(function () { if (node.parentNode) node.remove(); }, 300);
  }

  function toast(msg, type, opts) {
    const o = opts || {};
    if (o.key && toastSlots[o.key]) { dismissToast(toastSlots[o.key]); delete toastSlots[o.key]; }
    const parts = [
      U.el('span', { html: icon(type === 'warn' ? 'moon' : 'check') }),
      U.el('span', { class: 'toast-txt', text: msg })
    ];
    let node = null;
    if (o.action) {
      parts.push(U.el('button', {
        class: 'toast-act', type: 'button', text: o.action.label,
        onclick: function () {
          dismissToast(node);
          if (o.key && toastSlots[o.key] === node) delete toastSlots[o.key];
          try { o.action.onPick(); } catch (e) { console.warn('[ui] toast 操作失败', e); }
        }
      }));
    }
    node = U.el('div', { class: 'toast' + (type ? ' ' + type : ''), role: 'status' }, parts);
    refs.toastRoot.appendChild(node);
    if (o.key) toastSlots[o.key] = node;
    setTimeout(function () {
      if (o.key && toastSlots[o.key] === node) delete toastSlots[o.key];
      dismissToast(node);
    }, o.ms || 2400);
  }

  /* ── 本地缓存写不进去 ──
     只弹一条，绝对不能跟「已切换到」并排：切库提示还在屏幕上就把它顶掉，
     换成一句说得清后果的合并文案。onBroken 每次启动只回调一次（store.js）。 */
  const TOAST_SWITCH = 'lib-switch';
  const TOAST_CACHE = 'cache-broken';

  function fmtFreed(bytes) {
    const kb = (bytes || 0) / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(kb)) + ' KB';
  }

  /* 清理入口：清掉索引缓存后探一次写入，成功才敢说「好了」 */
  function clearLocalCache() {
    let r = { count: 0, bytes: 0 };
    try { r = FM.store.clearIndexCache(); } catch (e) { console.warn('[ui] 清理索引缓存失败', e); }
    const ok = FM.store.probe();
    if (ok) FM.store.resetBroken();
    if (ok) {
      toast(r.count
        ? '已清除 ' + r.count + ' 个资源库的索引缓存（约 ' + fmtFreed(r.bytes) + '），下次打开资源库时将重新扫描'
        : '索引缓存已清除', null, { key: TOAST_CACHE, ms: 4200 });
    } else {
      toast(r.count
        ? '已清除 ' + r.count + ' 个资源库的索引缓存，但仍无法写入，请检查设备剩余存储'
        : '索引缓存已清除，但仍无法写入，请检查设备剩余存储', 'warn', { key: TOAST_CACHE, ms: 6000 });
    }
    return ok;
  }

  /* 设置菜单里的「存储管理」：本机会占空间的东西按类型分开管
     —— 资源库索引 / 封面缓存 / 下载数据。
     索引清了只是下次重开库时重扫；封面和下载清了要重新联网下载，所以这两类都走二次确认。 */
  function openStorageManager() {
    const TABS = [
      { id: 'index', label: '资源库索引' },
      { id: 'cover', label: '封面缓存' },
      { id: 'dl', label: '下载数据' }
    ];
    const tabBar = U.el('div', { class: 'store-tabs' });
    const host = U.el('div', { class: 'store-host' });
    const panes = {};
    const tabBtns = {};

    function select(id) {
      if (!panes[id]) return;
      Object.keys(panes).forEach(function (k) { panes[k].node.hidden = k !== id; });
      Object.keys(tabBtns).forEach(function (k) { tabBtns[k].classList.toggle('on', k === id); });
      panes[id].paint();
    }

    /* ── 页一：资源库索引（原「缓存管理」的内容）──
       逐库列出索引缓存的大小 / 更新时间 / 规模，单库可清，也能一键全清。
       清的都是可重建的扫描结果，用户数据不在里面。 */
    function indexPane() {
      const sum = U.el('p', { class: 'cache-sum' });
      const list = U.el('div', { class: 'cache-list' });
      const clearBtn = U.el('button', { class: 'btn store-clear', type: 'button', text: '清除全部索引' });
      const node = U.el('div', { class: 'store-pane' }, [
        sum,
        list,
        U.el('div', { class: 'store-foot' }, [clearBtn]),
        U.el('p', { class: 'confirm-note', text: '索引缓存只是扫描结果，清除后下次打开资源库会重新扫描；分类、播放进度、收藏与设置不受影响。' })
      ]);
      clearBtn.onclick = function () { clearAll(); };

      function fmtAt(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
          p(d.getHours()) + ':' + p(d.getMinutes());
      }

      /* 缓存的目录口径：写的是这份索引按什么结构扫的，不是当前的设置项 */
      const DIR_TEXT = { flat: '平铺结构', cat: '二级目录', auto: '自动检测' };

      function fmtNum(n) {
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      }

      /* 按资源库归并：同一个库可能同时留着本命名空间和无前缀孤儿两份索引，算一行 */
      function groups() {
        let items = [];
        try { items = FM.store.indexCacheItems() || []; } catch (e) {}
        const map = new Map();
        items.forEach(function (it) {
          const id = it.libId || '';
          if (!map.has(id)) map.set(id, []);
          map.get(id).push(it);
        });
        const out = [];
        (FM.fs.libs() || []).forEach(function (l) {
          out.push({
            name: l.name || '未命名资源库', id: l.id,
            cur: l.id === FM.fs.activeId,
            items: map.get(l.id) || [], real: true
          });
          map.delete(l.id);
        });
        /* 库已经移除、或者登录前留下的无前缀孤儿：也要能看见、能清掉 */
        map.forEach(function (its, id) {
          out.push({
            name: id ? '已移除的资源库' : '旧版本索引', id: id, cur: false,
            title: id ? '库 id：' + id : '登录前遗留的无前缀索引',
            items: its, real: false
          });
        });
        return out;
      }

      /* 一行里要看得清三件事：这是哪个库（当前库带标记）、占多少空间、这份索引上次扫出什么 */
      function paint() {
        const gs = groups();
        let total = 0, cached = 0, libs = 0;
        list.textContent = '';
        gs.forEach(function (g) {
          const bytes = g.items.reduce(function (n, it) { return n + it.bytes; }, 0);
          /* 同一个库有新旧两份时，详情取最新的那份，体积算总和 */
          const primary = g.items.slice().sort(function (a, b) { return b.scannedAt - a.scannedAt; })[0] || null;
          total += bytes;
          if (g.real) { libs++; if (primary) cached++; }

          const head = U.el('div', { class: 'cache-head' }, [
            U.el('span', { class: 'cache-lib', text: g.name, title: g.title || g.name })
          ]);
          if (g.cur) head.appendChild(U.el('span', { class: 'cache-tag', text: '当前' }));
          head.appendChild(U.el('span', {
            class: 'cache-size' + (primary ? '' : ' none'),
            text: primary ? fmtFreed(bytes) : '无缓存'
          }));

          const main = U.el('div', { class: 'cache-main' }, [head]);
          const meta = U.el('div', { class: 'cache-meta' });
          if (!primary) {
            meta.appendChild(U.el('span', { class: 'cache-hint', text: '打开这个库时会重新扫描' }));
          } else if (!primary.ok) {
            meta.appendChild(U.el('span', { class: 'cache-chip warn', text: '索引结构无法识别，建议清除' }));
          } else {
            if (primary.scannedAt) {
              /* 相对时间更好懂，精确到分钟的时间挂 title：排查「怎么还是旧的」时才需要 */
              meta.appendChild(U.el('span', {
                class: 'cache-chip',
                text: U.fmtAgo(primary.scannedAt) + '更新',
                title: '上次扫描：' + fmtAt(primary.scannedAt)
              }));
            }
            if (primary.albums || primary.tracks) {
              meta.appendChild(U.el('span', { class: 'cache-chip', text: fmtNum(primary.albums) + ' 张专辑' }));
              meta.appendChild(U.el('span', { class: 'cache-chip', text: fmtNum(primary.tracks) + ' 集' }));
            }
            if (DIR_TEXT[primary.dirMode]) {
              meta.appendChild(U.el('span', { class: 'cache-chip', text: DIR_TEXT[primary.dirMode] }));
            }
            /* 新旧两份并存时体积比预期大，点明一下，别让人以为统计错了 */
            if (g.items.length > 1) meta.appendChild(U.el('span', { class: 'cache-chip warn', text: '含旧版遗留索引' }));
            if (!meta.childNodes.length) meta.appendChild(U.el('span', { class: 'cache-hint', text: '无索引详情' }));
          }
          main.appendChild(meta);

          const row = U.el('div', { class: 'cache-row' + (primary ? '' : ' is-empty') }, [main]);
          if (primary) {
            row.appendChild(U.el('button', {
              class: 'btn cache-btn', type: 'button', text: '清除',
              onclick: function () { clearList(g.items, '「' + g.name + '」的索引缓存'); }
            }));
          }
          list.appendChild(row);
        });
        sum.textContent = libs
          ? '共 ' + libs + ' 个资源库 · ' + cached + ' 个已缓存 · 占用 ' + (total ? fmtFreed(total) : '0 KB')
          : '还没有资源库';
      }

      /* 清完探一次写入：探不通说明不是这份缓存导致的（磁盘满 / 隐私模式），别给用户假希望 */
      function clearList(items, label) {
        let freed = 0;
        items.forEach(function (it) {
          try { freed += FM.store.clearIndexCacheItem(it.full) || 0; } catch (e) { console.warn('[ui] 清理索引缓存失败', e); }
        });
        const ok = FM.store.probe();
        if (ok) FM.store.resetBroken();
        const done = '已清除' + label + (freed ? '（约 ' + fmtFreed(freed) + '）' : '');
        if (ok) toast(done + '，下次打开资源库时将重新扫描', null, { key: TOAST_CACHE, ms: 4200 });
        else toast(done + '，但仍无法写入，请检查设备剩余存储', 'warn', { key: TOAST_CACHE, ms: 6000 });
        paint();
      }

      function clearAll() {
        const all = [];
        let bytes = 0, count = 0;
        groups().forEach(function (g) {
          if (!g.items.length) return;
          count++;
          g.items.forEach(function (it) { bytes += it.bytes; all.push(it); });
        });
        if (!all.length) { toast('暂无可清理的索引缓存'); return; }
        confirmModal({
          title: '清除全部索引缓存？',
          message: '将删除 ' + count + ' 个资源库的索引缓存（约 ' + fmtFreed(bytes) + '）。',
          note: '分类、播放进度、收藏与设置不受影响；下次打开资源库时将重新扫描。',
          icon: 'broom', okText: '全部清除', danger: true
        }).then(function (ok) {
          if (ok) clearList(all, '全部 ' + count + ' 个资源库的索引缓存');
        });
      }

      paint();
      return { node: node, paint: paint };
    }

    /* ── 页二：封面缓存 ──
       App 里 <img> 的封面由壳缓存到 cacheDir/covers（见 Covers.kt）。
       网页端 / 桌面端的封面在服务端或库目录里，不占本机空间，这边显示「不可用」并说明原因。 */
    function coverPane() {
      const sizeEl = U.el('span', { class: 'cache-size' });
      const head = U.el('div', { class: 'cache-head' }, [
        U.el('span', { class: 'cache-lib', text: '本机封面缓存' }),
        sizeEl
      ]);
      const meta = U.el('div', { class: 'cache-meta' });
      const btn = U.el('button', { class: 'btn cache-btn', type: 'button', text: '一键清除' });
      const row = U.el('div', { class: 'cache-row' }, [
        U.el('div', { class: 'cache-main' }, [head, meta]),
        btn
      ]);
      const node = U.el('div', { class: 'store-pane' }, [
        row,
        U.el('p', { class: 'confirm-note', text: '封面显示过一次就会缓存在本机，清掉后重新显示时会再下载一次；资源库里的封面文件不受影响。' })
      ]);
      const can = !!(FM.android && FM.android.native && FM.android.canManageCoverCache);
      /* 上一次 paint 统计到的体积：壳里异步删文件，成功后没法回传释放量，
         只能拿这个值来显示「已清除约 X」 */
      let lastBytes = 0;

      function paint() {
        meta.textContent = '';
        const bytes = can ? FM.android.coverCacheSize() : -1;
        lastBytes = bytes > 0 ? bytes : 0;
        sizeEl.textContent = bytes >= 0 ? fmtS(bytes) : '不可用';
        sizeEl.classList.toggle('none', !(bytes > 0));
        if (!can) {
          meta.appendChild(U.el('span', { class: 'cache-hint', text: '只统计本机 App 的缓存；网页端和桌面端的封面在服务端，不占本机空间' }));
        } else if (bytes > 0) {
          meta.appendChild(U.el('span', { class: 'cache-chip', text: '显示过就不再重复下载' }));
        } else {
          meta.appendChild(U.el('span', { class: 'cache-hint', text: '还没有封面缓存' }));
        }
        btn.disabled = !can || !(bytes > 0);
      }

      btn.onclick = function () {
        if (btn.disabled) return;
        confirmModal({
          title: '清除封面缓存？',
          message: '将清空本机缓存的封面图片' + (lastBytes > 0 ? '（约 ' + fmtS(lastBytes) + '）' : '') + '。',
          note: '之后显示封面会重新下载一次（每张几十 KB）；播放进度、收藏与设置不受影响。',
          icon: 'broom', okText: '清除', danger: true
        }).then(function (ok) {
          if (!ok) return;
          const freed = lastBytes;
          /* 删除是壳里另起线程做的，先把按钮按住，等它删完再重新统计 */
          btn.disabled = true;
          sizeEl.textContent = '清理中…';
          sizeEl.classList.remove('none');
          lastBytes = 0;
          if (!FM.android.clearCoverCache()) { paint(); return; }
          /* 上万张封面时删一轮可能要几秒：数字还没归零就再等一轮，最多跟 4 次 */
          let tries = 0;
          (function refresh() {
            paint();
            if (can && lastBytes > 0 && ++tries < 4) { setTimeout(refresh, 700); return; }
            toast(freed > 0 ? '已清除封面缓存（约 ' + fmtS(freed) + '）' : '封面缓存已清除',
              null, { key: TOAST_CACHE, ms: 3200 });
          })();
        });
      };
      return { node: node, paint: paint };
    }

    /* ── 页三：下载数据 ──
       离线下载只有 App 有，清单在壳里（Dl.snapshot），网页只按快照统计。
       一键清除复用已有的 removeDownloads 桥：它会把排队中 / 下载中 / 已完成的一起收拾掉。 */
    function dlPane() {
      const sizeEl = U.el('span', { class: 'cache-size' });
      const head = U.el('div', { class: 'cache-head' }, [
        U.el('span', { class: 'cache-lib', text: '本机下载数据' }),
        sizeEl
      ]);
      const meta = U.el('div', { class: 'cache-meta' });
      const btn = U.el('button', { class: 'btn cache-btn', type: 'button', text: '一键清除' });
      const row = U.el('div', { class: 'cache-row' }, [
        U.el('div', { class: 'cache-main' }, [head, meta]),
        btn
      ]);
      const node = U.el('div', { class: 'store-pane' }, [
        row,
        U.el('p', { class: 'confirm-note', text: '下载内容存在手机本地，清掉后这些曲目要联网播放，想离线听需重新下载。' })
      ]);
      const can = !!(FM.android && FM.android.native && FM.android.canRemoveMany);

      /* 壳里的清单是懒加载的：每次统计前先拉一次，避免显示上次的数字 */
      function items() {
        if (!can) return [];
        try { FM.android.refreshDownloads(); } catch (e) {}
        const all = FM.android.allDownloads ? (FM.android.allDownloads() || []) : [];
        return all.filter(function (it) { return it && it.rel; });
      }

      function isDone(it) { return it.state === 'done' || !it.state; }

      /* 已完成算整个文件（size），未完成算已经下到的字节（loaded）：
         未完成条目也有 .part 占着空间，只统计 done 会显示偏小 */
      function bytesOf(all) {
        return all.reduce(function (n, it) {
          return n + (isDone(it) ? (it.size || 0) : (it.loaded || 0));
        }, 0);
      }

      function paint() {
        const all = items();
        const done = all.filter(isDone);
        const bytes = can ? bytesOf(all) : 0;
        meta.textContent = '';
        sizeEl.textContent = can ? fmtS(bytes) : '不可用';
        sizeEl.classList.toggle('none', !(bytes > 0));
        if (!can) {
          meta.appendChild(U.el('span', { class: 'cache-hint', text: '离线下载只在 App 里；当前环境没有可清理的下载数据' }));
        } else if (!all.length) {
          meta.appendChild(U.el('span', { class: 'cache-hint', text: '还没有下载内容' }));
        } else {
          meta.appendChild(U.el('span', { class: 'cache-chip', text: done.length + ' 集已下载' }));
          if (all.length > done.length) {
            meta.appendChild(U.el('span', { class: 'cache-chip', text: '另有 ' + (all.length - done.length) + ' 个未完成' }));
          }
        }
        btn.disabled = !can || !all.length;
      }

      btn.onclick = function () {
        if (btn.disabled) return;
        const all = items();
        const bytes = bytesOf(all);
        confirmModal({
          title: '清除全部下载？',
          message: '将删除本机 ' + all.length + ' 个下载条目' + (bytes ? '（约 ' + fmtS(bytes) + '）' : '') + '。',
          note: '删除后这些曲目需要联网播放，想离线听要重新下载；收藏、播放进度与设置不受影响。',
          icon: 'trash', okText: '全部删除', danger: true
        }).then(function (ok) {
          if (!ok) return;
          const n = FM.android.removeDownloads(all.map(function (it) { return it.rel; }));
          /* dlMap 已就地删掉，先重绘一次把按钮按住，别让人在删文件期间又点一次；
             壳里删完文件还会推 onChange，700ms 后按真实快照再对一遍数字 */
          paint();
          setTimeout(function () {
            paint();
            toast(n ? '已清除 ' + n + ' 个下载' : '下载数据已清除', null, { key: TOAST_CACHE, ms: 3200 });
          }, 700);
        });
      };
      return { node: node, paint: paint };
    }

    TABS.forEach(function (t) {
      const b = U.el('button', { class: 'store-tab', type: 'button', text: t.label });
      b.onclick = function () { select(t.id); };
      tabBtns[t.id] = b;
      tabBar.appendChild(b);
    });
    panes.index = indexPane();
    panes.cover = coverPane();
    panes.dl = dlPane();
    Object.keys(panes).forEach(function (k) { host.appendChild(panes[k].node); });

    openModal({
      title: '存储管理',
      cls: 'cache-modal',
      body: U.el('div', { class: 'store-mgr' }, [tabBar, host]),
      actions: [{ label: '完成', cls: 'btn-primary' }]
    });
    select('index');
  }

  function cacheBroken() {
    const lib = FM.fs && FM.fs.active ? FM.fs.active() : null;
    /* 切库提示还挂着：把它顶掉，用合并文案，别让用户同时看到成功和失败 */
    const switching = !!toastSlots[TOAST_SWITCH] && !!(lib && lib.name);
    if (toastSlots[TOAST_SWITCH]) { dismissToast(toastSlots[TOAST_SWITCH]); delete toastSlots[TOAST_SWITCH]; }
    toast(switching
      ? '已切换到「' + lib.name + '」，但索引缓存无法写入，本次改动不会保存'
      : '索引缓存已满或不可用，改动可能无法保存',
      'warn',
      { key: TOAST_CACHE, ms: 7000, action: { label: '清除索引缓存', onPick: clearLocalCache } });
  }

  /* 分类与专辑整理（归类/置顶/重命名/隐藏）已改为写 fm.db：桌面走 IPC、网页和手机走 /api/meta，
     三端都能改，不再有读端拦截，所以下面的动作直接执行。 */

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
      /* head：一小段分组标题（比如「目录结构」）；sub：主标题下面那行弱化的括号说明；
         rightText：同一行右侧的小字（如更新的版本号），不占第二行 */
      if (it.head) { el.appendChild(U.el('div', { class: 'menu-head', text: it.head })); return; }
      const b = U.el('button', { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.sub ? ' tall' : '') + (it.cls ? ' ' + it.cls : '') });
      b.innerHTML = (o.noIcon ? '' : icon(it.icon || 'chevron')) +
        (it.sub
          ? '<span class="menu-main"><span class="menu-label">' + esc(it.label) + '</span>' +
            '<span class="menu-sub">（' + esc(it.sub) + '）</span></span>'
          : '<span>' + esc(it.label) + '</span>') +
        (it.right ? '<span class="menu-right">' + icon(it.right) + '</span>' : '') +
        (it.rightText != null ? '<span class="menu-right menu-tail">' + esc(it.rightText) + '</span>' : '');
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
    return el;
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
      dropLayer(close);
      mask.remove();
      if (opt.onClose) opt.onClose();
    }
    pushLayer(close);
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

  /* ── 导航 ── */
  /* 导航唯一数据源：桌面侧栏和手机首页的快捷入口都吃这一份，避免两套计数逻辑漂移。
     手机端快捷入口不显示数量，opts.count === false 时跳过那几次 progress() 全遍历 */
  function navItems(opts) {
    const withCount = !(opts && opts.count === false);
    const all = L.albums();
    const favCount = withCount
      ? all.filter(a => a.fav && !a.hidden).length + (FM.fs.favTrackIds ? FM.fs.favTrackIds.size : 0)
      : 0;
    const items = [
      { key: 'home', hash: '#/', label: '首页', icon: 'home', count: withCount ? all.filter(a => !a.hidden).length : 0 },
      { key: 'continue', hash: '#/continue', label: '继续收听', icon: 'clock', count: withCount ? continueList(999).length : 0 },
      { key: 'recent', hash: '#/recent', label: '最近播放', icon: 'headphones', count: withCount ? recentList(999).length : 0 },
      { key: 'fav', hash: '#/fav', label: '我的收藏', icon: 'heart', count: favCount },
      { key: 'stats', hash: '#/stats', label: '收听统计', icon: 'chart' }
    ];
    /* 下载管理只存在于 APK：和「我的收藏」一样是个网页视图 */
    if (canDownload()) items.push({ key: 'downloads', hash: '#/downloads', label: '下载管理', icon: 'download', count: withCount ? dlCount() : 0 });
    return items;
  }

  function renderNav() {
    /* 手机上侧栏整块不出现（导航改为首页快捷入口），这里省掉一次 progress() 全遍历 */
    if (isPhone()) { refs.nav.innerHTML = ''; return; }
    const items = navItems();
    let html = items.map(function (it) {
      const on = (state.view === it.key
        || (it.key === 'downloads' && state.view.indexOf('dl') === 0)   /* dlAlbum / dlRemove */
        || (it.key === 'fav' && state.view === 'favTracks')) && !state.q;
      return '<button class="nav-item' + (on ? ' active' : '') + '" data-hash="' + it.hash + '">' +
        icon(it.icon) + '<span>' + it.label + '</span>' +
        (it.count ? '<span class="count">' + it.count + '</span>' : '') + '</button>';
    }).join('');
    /* 「设置」分组：只放一个「专辑管理」，需要能写 .fm-covers/ 且是管理员；
       普通网页用户看不到入口，也就不必在页面里再挡一次 */
    if (canManageLib() && (FM.fs.native || FM.fs.server)) {
      const on = state.view === 'albumManage' && !state.q;
      html += '<div class="nav-group">设置</div>' +
        '<button class="nav-item sub' + (on ? ' active' : '') + '" data-hash="#/settings/albums">' +
        icon('image') + '<span>专辑管理</span></button>';
    }
    refs.nav.innerHTML = html;
  }

  function renderCats() {
    /* 没有加载资源库前，整块「分类」区域都不显示 */
    const lib = FM.fs.active();
    const section = refs.catList && refs.catList.closest('.side-section');
    if (section) section.hidden = !lib;
    const canEdit = canManageLib();
    if (refs.btnAddCat) refs.btnAddCat.hidden = !canEdit;   /* 网页端普通用户不能新建分类 */
    if (!lib) return;
    const cats = L.cats();
    if (!cats.length) {
      /* 分类按资源库独立：非喜马拉雅库本来就是空的 */
      refs.catList.innerHTML = '<div class="cat-empty">' + (canEdit ? '还没有分类，点右上角 + 新建' : '还没有分类') + '</div>';
      return;
    }
    refs.catList.innerHTML = cats.map(function (c) {
      const on = state.view === 'cat' && state.cat === c.id;
      return '<div class="cat-item' + (on ? ' active' : '') + '" data-cat="' + c.id + '" style="--cc:' + c.color + '">' +
        '<i class="bullet"></i><span>' + esc(c.name) + '</span>' +
        '<span class="count">' + L.catCount(c.id) + '</span>' +
        (canEdit ? '<button class="cat-edit" data-act="edit-cat" data-id="' + c.id + '">' + icon('edit') + '</button>' : '') + '</div>';
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
      /* 没有选中任何资源库时不再显示「尚未载入资源库」这一行占位（卡片里已有「选择资源库 / 点这里添加资源库」） */
      if (lib) {
        refs.libStat.textContent = '这个资源库里还没有音频';
        if (refs.libStat) refs.libStat.hidden = false;
      } else if (refs.libStat) {
        refs.libStat.hidden = true;
      }
      return;
    }
    const s = L.stats();
    refs.libStat.innerHTML = s.albums + ' 个专辑 · ' + s.tracks + ' 集 · ' + fmtS(s.size);
    if (refs.libStat) refs.libStat.hidden = false;
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
    /* 扫描遮罩同样盖住了顶栏 */
    if (refs.scanMaskHint && refs.scanMask && refs.scanMask.classList.contains('show')) {
      refs.scanMaskHint.textContent = text;
    }
  }

  /* ── 扫描遮罩 ──
     整库扫描要递归 readdir + stat，NAS / 机械盘上几十秒都正常。这期间切库、重复点扫描
     都会把结果互相覆盖，所以在整屏铺一层遮罩把点击全拦掉（含左侧资源库按钮）。
     只有「会锁导航」的扫描才上遮罩，后台静默同步（runScan 的 background）不打扰用户。 */
  let scanMaskTimer = 0;
  function showScanMask() {
    const mask = refs.scanMask;
    if (!mask) return;
    clearTimeout(scanMaskTimer);
    const lib = FM.fs.active();
    if (refs.scanMaskName) refs.scanMaskName.textContent = lib ? lib.name : '资源库';
    if (refs.scanMaskHint) refs.scanMaskHint.textContent = '正在扫描资源库…';
    mask.hidden = false;
    /* 先上屏再挂 show，淡入过渡才有起点 */
    if (!mask.classList.contains('show')) {
      requestAnimationFrame(function () { if (!mask.hidden) mask.classList.add('show'); });
    }
  }
  function hideScanMask() {
    const mask = refs.scanMask;
    if (!mask) return;
    clearTimeout(scanMaskTimer);
    mask.classList.remove('show');
    scanMaskTimer = setTimeout(function () {
      if (!mask.classList.contains('show')) mask.hidden = true;
    }, 300);
  }

  /* ── 导航锁：整库扫描 / 切库加载期间不让切专辑、分类 ──
     扫到一半跳走只会看到空列表，还会把半成品渲染出去。
     后台静默同步不占锁（见 runScan 的 background 参数），免得定时器到点时打断用户 */
  let navLock = 0;
  const NAV_LOCK_TIP = '正在扫描资源库，完成后再切换专辑和分类';
  function lockNav() { navLock++; }
  function unlockNav() { if (navLock > 0) navLock--; }
  function navLocked() { return navLock > 0; }

  /* ── 搜索建议浮层 ──
     空输入给最近搜索，有输入给跨库实时命中；键盘 ↑/↓ 选、↵ 执行、Esc 收起。
     条目点击用 mousedown 阻止默认，避免 input 先失焦把面板关掉。 */
  let popItems = [];
  let popIdx = -1;
  let popSig = '';
  let popQuery = null;
  let popStale = false;

  function popClose() {
    if (!refs.searchPop) return;
    refs.searchPop.hidden = true;
    refs.searchPop.innerHTML = '';
    refs.searchPop.classList.remove('stale');
    refs.searchInput.setAttribute('aria-expanded', 'false');
    refs.searchInput.removeAttribute('aria-activedescendant');
    popItems = [];
    popIdx = -1;
    popSig = '';
    popQuery = null;
    popStale = false;
  }

  /* 输入到防抖重绘之间这 160ms，面板里还是上一次的结果：先标脏，
     这段时间不响应点击/方向键，回车也强制按输入框当前值提交，避免打开旧专辑 */
  function popInvalidate() {
    popStale = true;
    popSig = '';
    popItems = [];
    popIdx = -1;
    if (refs.searchPop) refs.searchPop.classList.add('stale');
    refs.searchInput.removeAttribute('aria-activedescendant');
  }

  /* 快速搜索只出专辑：单集（音频 / 视频）留到结果页的标签里看，
     浮层保持「一眼扫完」的密度。末尾固定一条「查看全部结果」入口 */
  function popSuggestHtml(q) {
    const res = L.searchAll(q, { scope: 'all', showHidden: state.showHidden });
    const albums = res.albums.slice(0, 6);
    const n = searchCounts(res);
    let html = '';
    albums.forEach(function (r) {
      const a = r.album;
      const initial = U.initials(a.title, true);
      /* 和结果页同一份口径：当前库用 a.cover，别的库现查；都没有才用首字 */
      const cover = a.cover || (r.self || !FM.covers ? null : FM.covers.forAlbum(a, r.libId));
      html += '<div class="sp-item" role="option" aria-selected="false" data-sp="album" data-id="' + esc(a.id) + '"' +
        (r.self ? '' : ' data-lib="' + esc(r.libId) + '"') + '>' +
        (cover
          ? '<span class="sp-art" style="' + U.coverVars(a.seed) + '"><img class="cover-img" loading="lazy" decoding="async" src="' + esc(cover) + '" alt=""></span>'
          : '<span class="sp-art" style="' + U.coverVars(a.seed) + '"><span class="card-char' + (initial.length > 2 ? ' word' : '') + '">' + esc(initial) + '</span></span>') +
        '<span class="sp-body"><span class="sp-title">' + esc(a.title) + '</span>' +
        '<span class="sp-sub">' + (r.self ? '' : esc(r.libName) + ' · ') + (a.count || 0) + ' 集</span></span>' +
        (r.self ? '' : '<span class="sp-badge">' + esc(r.libName) + '</span>') +
        '</div>';
    });
    if (!albums.length) {
      html += '<div class="sp-empty">没有匹配的专辑，按 ↵ 查看全部结果</div>';
      return html;
    }
    html += '<div class="sp-item sp-all" role="option" aria-selected="false" data-sp="all"><span class="sp-body">' +
      '<span class="sp-title">查看全部结果</span><span class="sp-sub">专辑 ' + n.album +
      ' · 音频 ' + n.audio + ' · 视频 ' + n.video + '</span></span>' +
      '<span class="sp-hint">↵</span></div>';
    return html;
  }

  function popHistoryHtml(list) {
    let html = '<div class="sp-head"><span>最近搜索</span>' +
      (list.length ? '<button class="sp-clear" data-sp="clear">清空</button>' : '') + '</div>';
    if (!list.length) {
      html += '<div class="sp-empty">试试拼音或首字母：<b>santi</b>、<b>st</b> 都能找到《三体》</div>';
      return html;
    }
    list.forEach(function (x) {
      html += '<div class="sp-item" role="option" aria-selected="false" data-sp="history" data-q="' + esc(x.q) + '">' +
        '<span class="sp-art sp-art-ic">' + icon('clock') + '</span>' +
        '<span class="sp-body"><span class="sp-title">' + esc(x.q) + '</span></span>' +
        '<span class="sp-hint">↵</span></div>';
    });
    return html;
  }

  /* 同样的内容不重复重建：清空按钮里 focus() 与显式重绘会连着调两次 */
  function popPaint() {
    if (!refs.searchPop || !refs.searchInput) return;
    const q = String(refs.searchInput.value || '').trim();
    const hist = q ? null : FM.search.history.list();
    const sig = q ? 'q:' + q : 'h:' + hist.map(function (x) { return x.q; }).join('\u0001');
    /* 内容没变就不重建：保留 popIdx，连按方向键才能一路往下走 */
    if (!refs.searchPop.hidden && sig === popSig && !popStale) return;
    refs.searchPop.innerHTML = q ? popSuggestHtml(q) : popHistoryHtml(hist);
    popItems = U.$$('.sp-item', refs.searchPop);
    popItems.forEach(function (el, i) { el.id = 'sp-opt-' + i; });
    popIdx = -1;
    refs.searchPop.hidden = false;
    refs.searchPop.classList.remove('stale');
    refs.searchInput.setAttribute('aria-expanded', 'true');
    refs.searchInput.removeAttribute('aria-activedescendant');
    popSig = sig;
    popQuery = q;
    popStale = false;
  }

  function popSelect(i) {
    if (!popItems.length) return;
    popIdx = Math.max(-1, Math.min(popItems.length - 1, i));
    popItems.forEach(function (el, k) {
      el.classList.toggle('on', k === popIdx);
      el.setAttribute('aria-selected', k === popIdx ? 'true' : 'false');
    });
    if (popIdx >= 0) {
      refs.searchInput.setAttribute('aria-activedescendant', popItems[popIdx].id);
      /* 只滚浮层自己，scrollIntoView 会连带把整页也滚了 */
      const el = popItems[popIdx], box = refs.searchPop;
      if (el.offsetTop < box.scrollTop) box.scrollTop = Math.max(0, el.offsetTop - 4);
      else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) {
        box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight + 4;
      }
    } else {
      refs.searchInput.removeAttribute('aria-activedescendant');
    }
  }

  /* 搜索框占位：不再写死「搜索专辑、演播者或单集…」，改显最近一次搜索词。
     手机顶栏右边只剩百来像素，固定长文案会把输入框占满；有历史时点开搜索浮层也是同一份列表。
     只改 placeholder、不预填输入框，点进去直接打字就覆盖掉；没历史时退回「搜索」 */
  function paintSearchHint() {
    if (!refs || !refs.searchInput) return;
    const list = FM.search && FM.search.history ? FM.search.history.list() : [];
    const last = list.length ? String(list[0].q || '') : '';
    refs.searchInput.placeholder = last || '搜索';
  }

  function submitSearch(q) {
    const v = String(q || '').trim();
    popClose();
    if (!v) return;
    refs.searchInput.value = v;
    refs.searchClear.hidden = false;
    FM.search.history.push(v);
    paintSearchHint();
    state.q = v;
    state.qMore = false;
    /* 默认落在「专辑」：下拉框里点的那张专辑就是用户的第一意图；
       专辑零命中时才自动落到第一个有命中的标签 */
    state.qTab = 'album';
    resolveSearchTab(v, state.qScope === 'cur' ? 'cur' : 'all');
    renderMain();
  }

  function popAct(el) {
    if (!el || popStale) return;      /* 防抖还没重绘：旧条目一律不响应 */
    const kind = el.dataset.sp;
    if (kind === 'clear') { FM.search.history.clear(); paintSearchHint(); popPaint(); return; }
    if (kind === 'history') { submitSearch(el.dataset.q); return; }
    if (kind === 'all') { submitSearch(refs.searchInput.value); return; }
    if (kind === 'album') {
      const q = refs.searchInput.value.trim();
      if (q) FM.search.history.push(q);
      popClose();
      openAlbumIn(el.dataset.lib, el.dataset.id);
    }
  }

  /* ── 路由 ── */
  function go(hash) {
    if (navLocked()) { toast(NAV_LOCK_TIP); return; }
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  /* ── 手机顶栏：子页显示返回箭头、首页显示品牌 ──
     顶栏是 .main 的 flex 项，不随内容滚动，长列表滚到深处照样点得到；
     手机断点已经把页内「← 返回」那行收掉了（见 inlineBack），这里是唯一的返回入口 */
  function isSubPage() { return state.view !== 'home' || !!state.q; }

  /* 手机端个别子页把顶栏腾出来：只留返回箭头 + 页面标题。
     统计页用不到站内搜索，设置也是低频入口，让位后标题和触控区都宽松；
     以后要加类似页面，往这张表里补一行即可 */
  const PHONE_TOPBAR = {
    stats: { title: '收听统计', search: false, settings: false }
  };

  function paintTopbar() {
    if (!refs || !refs.tbBack) return;
    const sub = isPhone() && isSubPage();
    refs.tbBack.hidden = !sub;
    if (refs.tbBrand) refs.tbBrand.hidden = sub;
    /* 搜索态下一律按常规顶栏走：搜索框必须还在 */
    const cfg = (isPhone() && !state.q) ? PHONE_TOPBAR[state.view] : null;
    if (refs.topbar) {
      refs.topbar.classList.toggle('tb-no-search', !!(cfg && cfg.search === false));
      refs.topbar.classList.toggle('tb-no-settings', !!(cfg && cfg.settings === false));
    }
    if (refs.tbTitle) {
      refs.tbTitle.hidden = !cfg;
      refs.tbTitle.textContent = cfg ? cfg.title : '';
    }
  }

  /* 顶栏返回：先退出搜索态——搜索结果不换 hash，直接 history.back() 会离开当前页；
     再退站内历史；最后兜底回首页（WebView 冷启动直接落在深链时 history.length 为 1）。
     两处判断与 js/android.js 的系统返回键同序，硬件返回和这颗箭头走起来观感一致 */
  function goBack() {
    if (navLocked()) { toast(NAV_LOCK_TIP); return; }
    if (state.q) { route(); return; }
    if (location.hash && location.hash !== '#/' && history.length > 1) { history.back(); return; }
    go('#/');
  }

  function route() {
    /* 手势返回 / 前进键切页时收起「更多」这类浮层，别让它盖在新页面上 */
    closeMenu();
    popClose();
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const seg = h.split('/').filter(Boolean);
    state.q = '';
    state.qTab = 'album';
    refs.searchInput.value = '';
    refs.searchClear.hidden = true;
    /* 顺带刷一下占位：从搜索结果点进专辑时会 push 一条历史，回来后提示词要跟着换 */
    paintSearchHint();
    if (!seg.length) { state.view = 'home'; }
    else if (seg[0] === 'album') { state.view = 'album'; state.albumId = seg[1]; }
    else if (seg[0] === 'cat') { state.view = 'cat'; state.cat = seg[1]; }
    else if (seg[0] === 'downloads' && seg[2] === 'more') { state.view = 'dlMore'; state.albumId = seg[1]; }
    else if (seg[0] === 'downloads' && seg[2] === 'remove') { state.view = 'dlRemove'; state.albumId = seg[1]; }
    else if (seg[0] === 'downloads' && seg[1]) { state.view = 'dlAlbum'; state.albumId = seg[1]; }
    else if (seg[0] === 'fav' && seg[1] === 'tracks') { state.view = 'favTracks'; }
    else if (seg[0] === 'settings' && seg[1] === 'albums') { state.view = 'albumManage'; }
    else { state.view = seg[0]; }
    if (state.view === 'dlRemove') state.dlSel = {};
    if (state.view === 'dlMore') state.dlMoreSel = {};
    if (state.view.indexOf('dl') === 0 || state.view === 'downloads') {
      if (FM.android && FM.android.refreshDownloads) FM.android.refreshDownloads();
    }
    state.detailQ = '';
    state.page = 0;
    state.trackShown = PAGE;        // 手机端回到「只画第一批」
    state.gridShown = GRID_BATCH;   // 换页回到「只画第一批」
    gridTail = null;
    trackTail = null;
    if (bootVisible()) { bootPending = true; return; }   // 启动遮罩还在：等撤遮罩前再画
    renderMain();
    renderNav();
    renderCats();
    refs.view.scrollTop = 0;
    /* 刚按最新清单画好，别让半秒后的推送再重建一遍 */
    if (inDlView()) dlSig = dlKeysSignature();
  }

  /* 批量页列表在 .dl-scroll 里自己滚：重画后把内外两处 scrollTop 都还原，避免勾选一下跳回顶部 */
  function renderMainKeepScroll() {
    const sc = refs.view.querySelector('.dl-scroll');
    const inner = sc ? sc.scrollTop : 0;
    const outer = refs.view.scrollTop;
    renderMain({ quiet: true });   // 勾选不该让整页再播一遍入场动画
    refs.view.scrollTop = outer;
    const sc2 = refs.view.querySelector('.dl-scroll');
    if (sc2) sc2.scrollTop = inner;
  }

  function renderMain(opts) {
    const quiet = !!(opts && opts.quiet);
    /* 顶栏态跟视图走：这里覆盖所有视图与搜索态（含下面 renderWelcome 的早返回路径） */
    paintTopbar();
    const v = refs.view;
    /* 统计页有 tick 订阅和 30 秒定时器：必须在清空 DOM 前停掉，
       否则离开后仍会后台查库、写已卸载节点，反复进出还会叠加多个定时器 */
    if (statsViewTeardown) { try { statsViewTeardown(); } catch (e) {} statsViewTeardown = null; }
    if (albumViewTeardown) { try { albumViewTeardown(); } catch (e) {} albumViewTeardown = null; }
    /* 大图预览挂在 body 上，换页 / 刷新时必须手动收掉 */
    closeCoverViewer();
    v.innerHTML = '';
    gridTail = null;
    trackTail = null;
    searchTail = null;
    /* 批量下载/删除页：让页面铺满（没有播放条时不留底部空档） */
    if (!L.albums().length && state.view !== 'stats') { v.classList.remove('dl-view'); renderWelcome(); return; }
    v.classList.toggle('dl-view', state.view === 'dlMore' || state.view === 'dlRemove');
    /* 专辑管理：页面撑满、列表自己滚，底部操作条不浮在内容上 */
    v.classList.toggle('am-view', state.view === 'albumManage' && !state.q);
    let node;
    if (state.q) node = viewSearch(state.q);
    else if (state.view === 'album') node = viewAlbum(state.albumId);
    else if (state.view === 'cat') node = viewCat(state.cat);
    else if (state.view === 'fav') node = viewFav();
    else if (state.view === 'favTracks') node = viewFavTracks();
    else if (state.view === 'downloads') node = viewDownloads();
    else if (state.view === 'dlAlbum') node = viewDlAlbum(state.albumId);
    else if (state.view === 'dlRemove') node = viewDlRemove(state.albumId);
    else if (state.view === 'dlMore') node = viewDlMore(state.albumId);
    else if (state.view === 'continue') node = viewContinue();
    else if (state.view === 'recent') node = viewRecent();
    else if (state.view === 'stats') node = viewStats();
    else if (state.view === 'albumManage') node = viewAlbumManage();
    else node = viewHome();
    if (node) {
      /* 后台静默刷新：别让整页再播一遍入场动画，看起来像"跳"了一下 */
      if (quiet) node.style.animation = 'none';
      v.appendChild(node);
    }
    observeCards(v, quiet);
    applyPlayingState(v);
    syncLocateFab();
    centerActiveTab();
    if (state.view === 'album' && !state.q && state.albumId) {
      probeDurations(L.albumTracks(state.albumId));
    } else {
      probeToken++;
    }
  }

  /* ── 专辑卡片 ── */
  function initialOf(a) { return U.initials(a.title, true); }
  function albumType(a) { return a.videoCount ? '视频' : '本地有声书'; }

  /* 卡片只留封面 + 标题：集数 / 大小 / 进度等信息在专辑详情页展示（hero-meta），
     列表页少一层文字更干净，也省掉每张卡的 albumStat 计算 */
  /* opts.libId / opts.libName：跨库搜索结果。卡片带 data-lib，点击时先切库再进专辑；
     别的库的封面从各自那份索引里现查（FM.covers.forAlbum），查不到才退回首字渐变 */
  function albumCard(a, opts) {
    const o = opts || {};
    const foreign = !!o.libId && !o.self;
    const initial = initialOf(a);
    /* 别的库的专辑对象来自 index:<libId> 缓存，没有 cover 字段：按 libId 现查一份
       （covers.js 里按库存了索引，索引还没读到时返回 null，读完会补一次静默重绘） */
    const cover = a.cover || (foreign && FM.covers ? FM.covers.forAlbum(a, o.libId) : null);
    const art = cover
      ? '<img class="cover-img" loading="lazy" decoding="async" src="' + esc(cover) + '" alt="">'
      : '<div class="rings"><i></i><i></i><i></i></div><span class="card-char' + (initial.length > 2 ? ' word' : '') + '">' + esc(initial) + '</span>';
    const libAttr = foreign ? ' data-lib="' + esc(o.libId) + '"' : '';
    return '<article class="card' + (a.fav ? ' fav' : '') + (a.hidden ? ' is-hidden' : '') + '" data-id="' + a.id + '"' + libAttr + ' draggable="' + (foreign ? 'false' : 'true') + '" style="' +
      U.coverVars(a.seed) + '">' +
      '<div class="card-cover' + (cover ? ' has-photo' : '') + '">' +
        art +
        /* 打开「显示已隐藏」后隐藏专辑是混排在网格里的，靠这个角标区分，否则和普通专辑一模一样 */
        (a.hidden ? '<span class="card-hidden" title="已隐藏">' + icon('eye-off') + '</span>' : '') +
        (a.fav ? '<span class="card-fav" title="已收藏">' + icon('heart-fill') + '</span>' : '') +
        (foreign && o.libName ? '<span class="card-lib" title="所属资源库">' + esc(o.libName) + '</span>' : '') +
        '<button class="card-play" data-act="play-album" data-id="' + a.id + '"' + libAttr + ' title="播放全部">' + icon('play') + '</button>' +
      '</div>' +
      '<div class="card-body">' +
        '<h3 class="card-title" title="' + esc(a.title) + '">' + esc(a.title) + '</h3>' +
      '</div>' +
    '</article>';
  }

  function gridHtml(list) {
    if (!list.length) {
      gridTail = null;
      return '<div class="empty"><div class="empty-art">' + icon('folder') + '</div>' +
        '<h3>这里还没有专辑</h3><p>换个分类看看，或把专辑卡片拖到左侧分类里。</p></div>';
    }
    /* 首屏只画前 gridShown 张，剩下的滚到底（或点按钮）再追加，避免一次解析几百张卡 */
    const shown = Math.min(list.length, state.gridShown || GRID_BATCH);
    gridTail = list.length > shown ? list : null;
    return '<div class="grid">' + list.slice(0, shown).map(albumCard).join('') + '</div>' +
      (gridTail ? moreHtml(list.length - shown) : '');
  }

  function moreHtml(rest) {
    return '<div class="grid-more"><button class="btn" data-act="grid-more">加载更多（还有 ' + rest + ' 个）</button></div>';
  }

  /* 追加下一批：只往现有 .grid 里塞新卡，不重建已经画好的那些 */
  function appendGridBatch() {
    if (!gridTail) return;
    const host = refs.view.querySelector('.grid');
    if (!host) { gridTail = null; return; }
    const shown = host.children.length;
    const next = gridTail.slice(shown, shown + GRID_BATCH);
    if (!next.length) { gridTail = null; paintMoreLabel(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = next.map(albumCard).join('');
    const frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    host.appendChild(frag);
    state.gridShown = shown + next.length;
    observeCards(host, true);       // 追加的不播交错淡入，直接落终态
    applyPlayingState(host);
    paintMoreLabel();
  }

  function paintMoreLabel() {
    const box = refs.view.querySelector('.grid-more');
    if (!box) return;
    const rest = gridTail ? Math.max(0, gridTail.length - state.gridShown) : 0;
    if (!rest) { box.remove(); return; }
    const btn = box.querySelector('button');
    if (btn) btn.textContent = '加载更多（还有 ' + rest + ' 个）';
  }

  /* 滚到接近底部就自动加载下一批（手机上不必手动点）：专辑网格、手机端曲目列表共用 */
  let moreTick = 0;
  function maybeLoadMore() {
    if (moreTick) return;
    function searchHas() { return !!(searchTail && searchTail.items.length); }
    if (!gridTail && !trackTail && !searchHas()) return;
    const v = refs.view;
    if (v.scrollTop + v.clientHeight < v.scrollHeight - 900) return;
    moreTick = requestAnimationFrame(function () {
      moreTick = 0;
      if (gridTail) appendGridBatch();
      if (trackTail) appendTrackBatch();
      if (searchHas()) appendSearchBatch();
      /* 一批不够铺满（或机型很矮）时接着往下补，不然不会再触发 scroll 就卡住了 */
      if (gridTail || trackTail || searchHas()) maybeLoadMore();
    });
  }

  /* ── 各个视图 ── */
  /* 展示用的库名：优先用资源库的显示名（重命名后跟着变），退回扫描到的目录名 */
  function libLabel() {
    const lib = FM.fs.active();
    return (lib && lib.name) || L.rootName || '本地资源库';
  }

  /* 已隐藏的专辑数：页头的「已隐藏 N」和手机 tab 行的角标共用一份口径 */
  function hiddenAlbumCount() {
    const all = L.albums();
    let n = 0;
    for (let i = 0; i < all.length; i++) if (all[i].hidden) n++;
    return n;
  }

  /* ── 手机端首页工具区：分类 tab 行 + 快捷入口 ── */
  /* 单行分类 tab：全部 → 各分类 →（选中时）编辑 → + 新建。横向滑动，不折行 */
  function mobileCatTabs(activeId) {
    const tabs = [{ id: '', label: '全部' }].concat(L.cats().map(function (c) {
      return { id: c.id, label: c.name };
    }));
    const btns = tabs.map(function (t) {
      const on = (t.id || '') === (activeId || '');
      return '<button class="m-tab' + (on ? ' on' : '') + '" data-act="tab-cat" data-id="' + esc(t.id || '') + '">' +
        esc(t.label) + '</button>';
    }).join('');
    /* 手机上 .head-actions 被隐藏，分类的编辑入口挪到 tab 行里，紧跟「+」前面。
       网页端普通用户只读：不给编辑 / 新建入口 */
    const canEdit = canManageLib();
    const edit = (canEdit && activeId)
      ? '<button class="m-tabs-btn" data-act="edit-cat" data-id="' + esc(activeId) + '" title="编辑这个分类">' + icon('edit') + '</button>'
      : '';
    const add = canEdit
      ? '<button class="m-tabs-btn m-tabs-add" data-act="edit-cat" title="新建分类">' + icon('plus') + '</button>'
      : '';
    /* 已隐藏专辑的入口：手机上页头整行不渲染，只能放这条常驻的 tab 行里，
       放在最右（编辑 / + 之后）并带数量角标，滚到哪儿都点得到 */
    const hiddenN = hiddenAlbumCount();
    const hiddenBtn = hiddenN
      ? '<button class="m-tabs-btn m-tabs-hidden' + (state.showHidden ? ' on' : '') + '" data-act="toggle-hidden" title="' +
        (state.showHidden ? '收起已隐藏的专辑' : '显示 ' + hiddenN + ' 个已隐藏专辑') + '">' +
        icon('eye-off') + '<i class="m-tabs-badge">' + hiddenN + '</i></button>'
      : '';
    return '<div class="m-tabs">' +
      '<div class="m-tabs-scroll" id="mTabsScroll">' + btns + '</div>' +
      edit + add + hiddenBtn +
      '</div>';
  }

  /* 手机首页的快捷入口：承接原侧栏里的整页导航（首页本身不用出现在这里）。
     一行放图标 + 文案，不显示数量角标；收听统计不放手机入口，桌面侧栏的保留 */
  function mobileQuickRow() {
    const items = navItems({ count: false }).filter(function (it) { return it.key !== 'home' && it.key !== 'stats'; });
    return '<div class="m-quick">' + items.map(function (it) {
      return '<button class="m-quick-item" data-act="nav" data-hash="' + it.hash + '">' +
        icon(it.icon) + '<span>' + it.label + '</span>' +
        '</button>';
    }).join('') + '</div>';
  }

  /* 选中的 tab 可能在横向滚动条外：画完把它滚到可视区中间 */
  function centerActiveTab() {
    const box = refs.view.querySelector('.m-tabs-scroll');
    const on = box && box.querySelector('.m-tab.on');
    if (!box || !on) return;
    box.scrollLeft = Math.max(0, on.offsetLeft - box.clientWidth / 2 + on.offsetWidth / 2);
  }

  function viewHome() {
    const all = L.allAlbums({ showHidden: state.showHidden });
    const wrap = U.el('div');
    const hiddenN = hiddenAlbumCount();
    const phone = isPhone();

    /* 手机首页不出头部那一行（库名 / 专辑数 / 大小）：这些统计挪到「资源库设置」里看，
       手机上一进来就是 tab 行 + 内容，省掉一次 stats() 全遍历 */
    let head = '';
    if (!phone) {
      const s = L.stats();
      const stats = s.albums + ' 个专辑 · ' + s.tracks + ' 集 · ' + fmtS(s.size) +
        (s.done ? ' · 已听完 ' + s.done + ' 集' : '');
      /* 「已隐藏 N」放页头右侧（首屏可见），不再只在网格底部露一行。
         这里不用 .head-actions：那个类在 <980px 会被丢掉，而 761~979px 没有手机 tab 行，
         入口会整段消失。直接作为 .view-head 的第二个子元素，靠 space-between 自动靠右 */
      const chip = hiddenN
        ? '<button class="chip' + (state.showHidden ? ' on' : '') + '" data-act="toggle-hidden" title="' +
          (state.showHidden ? '收起已隐藏的专辑' : '显示 ' + hiddenN + ' 个已隐藏专辑') + '">' +
          icon('eye-off') + '已隐藏 <b>' + hiddenN + '</b>' + (state.showHidden ? ' · 显示中' : '') + '</button>'
        : '';
      head = '<div class="view-head"><div>' +
        '<div class="page-title">全部专辑<span class="accent"> · </span><span style="font-size:14px;color:var(--dim);font-weight:500">' + esc(libLabel()) + '</span></div>' +
        '<div class="page-sub">' + stats + '</div></div>' + chip + '</div>';
    }


    let resume = '';
    /* 手机上不再有「继续播放」大卡：继续听走快捷入口 + 底部播放条 */
    const cont = phone ? null : continueList(1)[0];
    if (cont) {
      const a = L.album(cont.albumId);
      const p = L.progressOf(cont.id) || {};
      const d = p.d || cont.duration || 0;
      const pct = d ? Math.min(100, Math.round((p.p || 0) / d * 100)) : 0;
      if (a) {
        resume = '<div class="resume-card" style="' + U.coverVars(a.seed) + '">' +
          '<div class="resume-cover" data-act="open-album" data-id="' + a.id + '" title="查看专辑">' + (a.cover
            ? '<img class="cover-img" loading="lazy" decoding="async" src="' + esc(a.cover) + '" alt="">'
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

    const hiddenLink = hiddenN
      ? '<div style="margin-top:22px;text-align:center"><button class="link-btn" data-act="toggle-hidden">' + (state.showHidden ? '隐藏 ' : '显示 ') + hiddenN + ' 个已隐藏专辑</button></div>'
      : '';

    wrap.innerHTML = head +
      (phone ? mobileCatTabs('') + mobileQuickRow() : '') +
      resume +
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

  /* ── 我的收藏：移动端用列表行（我收藏的声音 + 专辑），桌面仍用卡片 ── */
  function isNarrow() {
    try { return window.matchMedia('(max-width:979.98px)').matches; } catch (e) { return false; }
  }

  /* 手机断点：跟 css/mobile.css 里 #sheet 的布局断点一致。点节目行直接进详情页只在这个宽度下做 */
  function isPhone() {
    try { return window.matchMedia('(max-width:760px)').matches; } catch (e) { return false; }
  }

  /* 移动端 = 安卓壳或手机浏览器。按「设备」判断而不是窗口宽度——
     桌面浏览器窗口拉窄了也照样算桌面端 */
  function isMobileDevice() {
    if (FM.android) return true;
    if (FM.fs.desktop) return false;
    return /Android|iPhone|iPod|iPad|Mobile/i.test(navigator.userAgent || '');
  }
  /* 「按专辑 / 按分类」这种改整库结构的操作只在桌面端给：
     手机上一来一行小按钮容易误触，二来改完整库重扫较重，等回桌面端再改更稳 */
  function canEditGroup() {
    return !isMobileDevice();
  }
  /* 网页端（连服务端、多用户）下只有管理员能管理资源库；普通用户禁用「资源库设置」页面。
     以「连到了服务端」（serverReached）判定网页端，而不是 server（有资源库）——没有资源库的服务端用户同样算网页端。
     桌面端 / 纯浏览器本地目录没有角色概念，始终放行。 */
  function canManageLib() {
    return !(FM.fs.serverReached && !FM.fs.isAdmin);
  }
  /* 用户管理只属于「服务端 + 管理员 + 非免密」：桌面端单用户，--no-auth 没有真实身份 */
  function canManageUsers() {
    return !FM.fs.desktop && FM.fs.serverReached && !FM.fs.noAuth && !!FM.fs.isAdmin;
  }
  /* /api/alist/config 是 admin-only 且 --no-auth 下关闭；桌面本地库不接网盘 */
  function canConfigAlist() {
    return !!(FM.fs.serverReached && FM.fs.isAdmin && !FM.fs.noAuth);
  }

  /* 收藏页布局随宽度切换：跨过断点时重画一次（窗口拉宽回桌面卡片） */
  let favNarrow = isNarrow();
  /* 手机断点也记一份：跨过 760 时首页/分类页的结构（tab 行、快捷入口）要换一套 */
  let phoneWide = isPhone();
  window.addEventListener('resize', U.debounce(function () {
    if (!refs || !refs.view) return;
    const now = isNarrow();
    if (now !== favNarrow) {
      favNarrow = now;
      if (state.view === 'fav') renderMain({ quiet: true });
    }
    const nowPhone = isPhone();
    if (nowPhone !== phoneWide) {
      phoneWide = nowPhone;
      /* 跨 760px（手机上主要是横竖屏切换）：首页/分类的 tab 与快捷入口、子页的页内返回行
         都换了一套结构，整页重画一次；顶栏箭头/品牌也跟着切 */
      renderNav();
      renderMain({ quiet: true });
    }
  }, 200));

  /* 收藏的曲目：按收藏时间倒序（Set 保持写入顺序，最后一条最新） */
  function favTrackList() {
    const ids = FM.fs.favTrackIds ? Array.from(FM.fs.favTrackIds) : [];
    return ids.reverse().map(function (id) { return L.track(id); }).filter(Boolean);
  }

  /* 我收藏的声音：一条汇总入口，封面用最近收藏那集的专辑封面 + 心形角标 */
  function favSoundsRow(tracks) {
    const top = tracks[0];
    const a = top ? L.album(top.albumId) : null;
    const art = a && a.cover ? '<img class="cover-img" loading="lazy" decoding="async" src="' + esc(a.cover) + '" alt="">' : '';
    return '<div class="fav-row fav-sounds" data-act="open-fav-tracks">' +
      '<span class="fav-thumb"' + (a ? ' style="' + U.coverVars(a.seed) + '"' : '') + '>' +
        art + '<span class="fav-star">' + icon('heart-fill') + '</span>' +
      '</span>' +
      '<span class="fav-body">' +
        '<span class="fav-title">我收藏的声音</span>' +
        '<span class="fav-sub">' + esc(top ? top.title : '') + '</span>' +
        '<span class="fav-meta">' + tracks.length + ' 条声音</span>' +
      '</span>' +
      '<span class="fav-chev">' + icon('chevron') + '</span>' +
    '</div>';
  }

  function favAlbumRow(a) {
    const st = L.albumStat(a);
    const art = a.cover
      ? '<img class="cover-img" loading="lazy" decoding="async" src="' + esc(a.cover) + '" alt="">'
      : '<span class="fav-char' + (initialOf(a).length > 2 ? ' word' : '') + '">' + esc(initialOf(a)) + '</span>';
    const p = lastPlayed(L.albumTracks(a.id));
    return '<div class="fav-row" data-act="open-album" data-id="' + a.id + '">' +
      '<span class="fav-thumb" style="' + U.coverVars(a.seed) + '">' + art + '</span>' +
      '<span class="fav-body">' +
        '<span class="fav-title">' + esc(a.title) + '</span>' +
        (p ? '<span class="fav-sub">继续听：' + esc(p.title) + '</span>' : '') +
        '<span class="fav-meta">共 ' + a.count + ' 集 · 已听 ' + st.doneCount + ' 集</span>' +
      '</span>' +
      '<button class="fav-more" data-act="more-album" data-id="' + a.id + '" title="更多">' + icon('more') + '</button>' +
    '</div>';
  }

  function viewFav() {
    const albums = L.allAlbums({ fav: true, showHidden: state.showHidden });
    const tracks = favTrackList();
    const empty = '<div class="empty"><div class="empty-art">' + icon('heart') + '</div><h3>还是空的</h3><p>在专辑卡片或播放页点收藏，就会出现在这里。</p></div>';
    const wrap = U.el('div');
    if (!isNarrow()) {
      wrap.innerHTML = '<div class="view-head"><div><div class="page-title">我的收藏</div>' +
        '<div class="page-sub">' + albums.length + ' 个专辑' + (tracks.length ? ' · ' + tracks.length + ' 条声音' : '') + '</div></div></div>' +
        (tracks.length ? favSoundsRow(tracks) : '') +
        (albums.length ? gridHtml(albums) : '') +
        (!albums.length && !tracks.length ? empty : '');
      return wrap;
    }
    wrap.innerHTML = '<div class="view-head"><div><div class="page-title">我的收藏</div>' +
      '<div class="page-sub">' + albums.length + ' 个专辑 · ' + tracks.length + ' 条声音</div></div></div>' +
      (!albums.length && !tracks.length ? empty
        : '<div class="fav-list">' + (tracks.length ? favSoundsRow(tracks) : '') + albums.map(favAlbumRow).join('') + '</div>');
    return wrap;
  }

  function viewFavTracks() {
    const tracks = favTrackList();
    const wrap = U.el('div');
    wrap.innerHTML = backHead(tracks.length ? '<button class="btn btn-ghost" data-act="play-fav-tracks">' + icon('play') + '播放全部</button>' : '') +
      '<div class="view-head"><div><div class="page-title">我收藏的声音</div>' +
      '<div class="page-sub">' + tracks.length + ' 条</div></div></div>' +
      (tracks.length ? '<div class="track-list">' + tracks.map(function (t) { return flatTrack(t, { noIdx: true }); }).join('') + '</div>'
        : '<div class="empty"><div class="empty-art">' + icon('heart') + '</div><h3>还没有收藏的声音</h3><p>在播放页点心形，收藏的内容会出现在这里。</p></div>');
    return wrap;
  }

  function viewCat(catId) {
    const cat = L.cats().find(c => c.id === catId);
    if (!cat) return viewHome();   /* 分类已不存在（被删 / 切了模式）：回到「全部」 */
    const list = L.allAlbums({ cat: catId, showHidden: state.showHidden });
    const wrap = U.el('div');
    /* 手机端把分类 tab 行带进分类页，点别的 tab 就地换页，不用先退回首页 */
    wrap.innerHTML = (isPhone() ? mobileCatTabs(catId) : '') +
      '<div class="view-head"><div>' +
      '<div class="page-title"><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + cat.color + ';box-shadow:0 0 14px ' + cat.color + '"></i>' + esc(cat.name) + '</div>' +
      '<div class="page-sub">' + list.length + ' 个专辑</div></div>' +
      (canManageLib() ? '<div class="head-actions"><button class="btn btn-ghost" data-act="edit-cat" data-id="' + cat.id + '">' + icon('edit') + '编辑分类</button></div>' : '') + '</div>' +
      (list.length ? gridHtml(list) : '<div class="empty"><div class="empty-art">' + icon('grid') + '</div>' +
        '<h3>这个分类还没有专辑</h3><p>把首页的专辑卡片拖到这里，或点开专辑详情页右上角「更多」里的「归类…」。</p></div>');
    return wrap;
  }

  /* ── 下载页的文案 ──
   * 静态渲染和原地刷新共用一份，别写两套：下载中一秒变好几次，只有文案是同一个来源
   * 才不会出现「刚下完的集还写着下载中」这种错位。
   */
  /* 有下载记录的专辑（正在下的也算，别等下完才出现） */
  function dlGroups() {
    return L.allAlbums({ showHidden: state.showHidden }).map(function (a) {
      const tracks = dlAll(a.id);
      return { album: a, tracks: tracks, sum: dlSummary(tracks) };
    }).filter(function (x) { return x.tracks.length > 0; });
  }

  function dlPageSubText(groups) {
    let count = 0, running = 0;
    groups.forEach(function (x) { count += x.sum.done; running += x.sum.active; });
    return groups.length + ' 个专辑 · ' + count + ' 集' + (running ? ' · 下载中 ' + running : '');
  }

  function dlUsedSize(groups) {
    return groups.reduce(function (n, x) { return n + x.sum.size; }, 0);
  }

  function dlLiveHtml(s, albumId) {
    if (!s.active && !s.bad) return '';
    return '<span class="dl-live" data-album="' + albumId + '">' +
      (s.active ? '下载中 ' + s.active + ' 集 · ' + s.pct + '%' : '有 ' + s.bad + ' 集失败') + '</span>';
  }

  function dlAlbumMetaHtml(s, a) {
    return '<span>' + icon('folder') + fmtS(s.size) + '</span>' +
      '<span>' + icon('headphones') + s.done + ' 集' + (s.done < a.count ? '（共 ' + a.count + '）' : '') + '</span>' +
      dlLiveHtml(s, a.id);
  }

  function dlHeroSubText(doneCount, total, sum) {
    return '已下载 ' + doneCount + ' 条 / 共 ' + total + ' 条' +
      (sum.size ? ' · ' + fmtS(sum.size) : '') +
      (sum.active ? ' · 下载中 ' + sum.active + ' 条 ' + sum.pct + '%' : '');
  }

  function dlToolCountText(id) {
    const mine = dlAll(id);
    return dlSummary(mine).active ? dlTracks(id).length + ' / ' + mine.length + ' 集' : mine.length + ' 集';
  }

  function dlTrackMetaHtml(t, it) {
    const p = L.progressOf(t.id);
    const dur = t.duration || (p && p.d) || 0;
    const pct = p && dur ? Math.min(100, Math.round((p.p || 0) / dur * 100)) : 0;
    return '<span>' + icon('clock') + (dur ? fmtT(dur) : '—') + '</span>' +
      '<span>' + icon('folder') + fmtS(it.size || t.size) + '</span>' +
      (pct > 0 && !(p && p.done) ? '<span class="dl-pct">已播 ' + pct + '%</span>' : '') +
      '<span class="dl-state' + (it.state === 'error' ? ' bad' : '') + '" data-rel="' + esc(t.rel) + '">' + dlStateText(it) + '</span>';
  }

  /* 下载管理：占了多少 / 还剩多少 + 有下载内容的专辑列表（至少下一集才算） */
  function viewDownloads() {
    const albums = dlGroups();
    const used = dlUsedSize(albums);
    const free = (FM.android && FM.android.freeSpace) ? FM.android.freeSpace() : 0;

    const wrap = U.el('div');
    wrap.innerHTML = '<div class="view-head"><div>' +
      '<div class="page-title">下载管理</div>' +
      '<div class="page-sub dl-sub">' + dlPageSubText(albums) + '</div></div>' +
      '<div class="head-actions"><button class="btn btn-ghost" data-act="open-downloads">' + icon('download') + '管理 / 删除</button></div></div>' +
      (albums.length ? '<div class="dl-sum">' +
          '<b class="dl-used">已占用 ' + fmtS(used) + '</b>' +
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
    const art = a.cover
      ? '<img src="' + esc(a.cover) + '" alt="">'
      : '<span class="dl-char' + (initialOf(a).length > 2 ? ' word' : '') + '">' + esc(initialOf(a)) + '</span>';
    return '<div class="dl-item" data-act="open-dl-album" data-id="' + a.id + '">' +
      '<span class="dl-cover" style="' + U.coverVars(a.seed) + '">' + art + '</span>' +
      '<span class="dl-body">' +
        '<span class="dl-title" title="' + esc(a.title) + '">' + esc(a.title) + '</span>' +
        '<span class="dl-meta" data-album="' + a.id + '">' + dlAlbumMetaHtml(x.sum, a) + '</span>' +
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
      backHead('<button class="btn btn-ghost" data-act="open-downloads">' + icon('download') + '下载任务</button>') +
      '<div class="dl-hero">' +
        '<span class="dl-cover lg" style="' + U.coverVars(a.seed) + '">' + coverArt(a) + '</span>' +
        '<div class="dl-hero-body">' +
          '<div class="dl-hero-title">' + esc(a.title) + '</div>' +
          '<div class="dl-hero-sub">' + dlHeroSubText(done.length, a.count, sum) + '</div>' +
        '</div>' +
        (missing > 0 ? '<button class="btn btn-primary dl-hero-btn" data-act="dl-more-page" data-id="' + a.id + '">下载更多</button>' : '') +
      '</div>' +
      '<div class="dl-tools">' +
        '<button class="dl-tool" data-act="dl-batch" data-id="' + a.id + '">' + icon('trash') + '批量删除</button>' +
        '<button class="dl-tool" data-act="play-dl" data-id="' + a.id + '">' + icon('play') + '播放全部</button>' +
        '<span class="dl-tool-count">' + dlToolCountText(a.id) + '</span>' +
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
    const playing = P.current && P.current.id === t.id;
    /* 还没下完的不能点播：本地没文件，硬播会跳到别的集 */
    const ready = !it.state || it.state === 'done';
    return '<li class="track dl-track' + (playing ? ' playing' : '') + '" data-id="' + t.id +
      '" data-act="' + (ready ? 'row-play-dl' : 'dl-wait') + '">' +
      '<span class="dl-idx">' + (t.order + 1) + '</span>' +
      '<div class="dl-tk">' +
        '<div class="dl-tk-title">' + esc(t.title) + (p && p.done ? '<span class="tk-flag">已听</span>' : '') + '</div>' +
        '<div class="dl-tk-meta">' + dlTrackMetaHtml(t, it) + '</div>' +
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

    const filterHtml = pend.length
      ? '<div class="dl-filter">' +
          '<span>未下载 ' + pend.length + ' 集</span>' +
          '<button class="dl-chip' + (allOn ? ' on' : '') + '" data-act="dl-more-all">' + (allOn ? '取消全选' : '全选') + '</button>' +
        '</div>'
      : '';
    const groupsHtml = groups.map(dlGroup).join('');
    const barHtml = pend.length
      ? '<div class="dl-bar dl-bar-col">' +
          '<div class="dl-bar-row">' +
            '<button class="dl-bar-btn" data-act="dl-mine">我的下载</button>' +
            '<button class="dl-bar-btn primary" data-act="dl-more-go" data-id="' + a.id + '"' + (picked.length ? '' : ' disabled') + '>选集下载' +
              (picked.length ? '（' + picked.length + '）' : '') + '</button>' +
          '</div>' +
          '<div class="dl-bar-note">预计占用 ' + fmtS(need) + ' 空间 / 剩余 ' + (free > 0 ? fmtS(free) : '未知') + ' 可用</div>' +
        '</div>'
      : '';

    const wrap = U.el('div', { class: 'dl-page' });
    wrap.innerHTML =
      '<div class="dl-page-head">' + backBtn() +
        '<span class="dl-page-title">批量下载</span>' + backSpare() + '</div>' +
      (tight ? '<div class="dl-warn">手机空间可能不够，建议少选几集。</div>' : '') +
      (pend.length
        ? filterHtml + '<div class="dl-scroll">' + groupsHtml + '</div>' + barHtml
        : '<div class="dl-scroll"><div class="empty"><div class="empty-art">' + icon('download') + '</div><h3>已经全下完了</h3>' +
          '<p>这张专辑没有待下载的集。</p></div></div>');
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
    const wrap = U.el('div', { class: 'dl-page' });
    wrap.innerHTML =
      '<div class="dl-page-head">' + backBtn() +
        '<span class="dl-page-title">批量删除</span>' + backSpare() + '</div>' +
      '<div class="dl-sum"><b>已占用 ' + fmtS(size) + '</b><span>/ 可用 ' + (free > 0 ? fmtS(free) : '未知') + '</span></div>' +
      '<div class="dl-sel-head">' +
        '<button class="dl-ck-item" data-act="dl-sel-all">' + ck(allOn) + '全选</button>' +
        '<button class="dl-ck-item" data-act="dl-sel-done">' + ck(doneOn) + '选择已听完</button>' +
      '</div>' +
      '<div class="dl-scroll"><div class="dl-tracks">' + mine.map(function (t) { return dlSelRow(t, !!sel[t.id]); }).join('') + '</div></div>' +
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
          '<span class="dl-state' + (it.state === 'error' ? ' bad' : '') + '" data-rel="' + esc(t.rel) + '">' + dlStateText(it) + '</span>' +
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

  /* ── 搜索结果：标签页 + 按资源库分组 ──
     三种类型各占一个标签（专辑 / 音频 / 视频），三个标签内部都按资源库分组：
     当前库排最前，其它库跟上。所有匹配都是跨库的，点其它库的条目会先切库再打开
     （见 openAlbumIn / playTrackIn）。 */
  const SEARCH_TABS = [
    { key: 'album', field: 'albums', label: '专辑', unit: '个专辑' },
    { key: 'audio', field: 'audio', label: '音频', unit: '条音频' },
    { key: 'video', field: 'video', label: '视频', unit: '个视频' }
  ];
  const TAB_EMPTY = {
    album: ['没有找到相关专辑', '换个关键词，或试试拼音 / 首字母：santi、st 也能找到《三体》。'],
    audio: ['没有找到相关音频', '这个关键词只命中了专辑或视频，切到上方其它标签看看。'],
    video: ['没有找到相关视频', '这个关键词只命中了专辑或音频，切到上方其它标签看看。']
  };

  /* 单集按扩展名分音频 / 视频：kind 由 library.js 的 rowTrack 统一补齐，缺失时按音频算 */
  function tabOfTrack(t) { return t && t.kind === 'video' ? 'video' : 'audio'; }
  function tabField(tab) { return tab === 'audio' ? 'audio' : (tab === 'video' ? 'video' : 'albums'); }

  function searchCounts(res) {
    const c = { album: res.albums.length, audio: 0, video: 0 };
    res.tracks.forEach(function (r) { c[tabOfTrack(r.track)]++; });
    return c;
  }

  /* 换关键词 / 换资源库范围后：当前标签还有命中就留着（用户正顺着这一栏看），
     没了才落到第一个有命中的标签 */
  function resolveSearchTab(q, scope) {
    const res = L.searchAll(q, { scope: scope === 'cur' ? 'cur' : 'all', showHidden: state.showHidden });
    const c = searchCounts(res);
    if (c[state.qTab]) return;
    state.qTab = c.album ? 'album' : (c.audio ? 'audio' : (c.video ? 'video' : 'album'));
  }

  /* 按资源库分桶：专辑 / 音频 / 视频各一栏，标签切换时只取自己那栏 */
  function searchGroups(res) {
    const map = new Map();
    const list = [];
    function bucket(libId, libName, self) {
      let g = map.get(libId);
      if (!g) {
        g = { libId: libId, libName: libName, self: !!self, albums: [], audio: [], video: [] };
        map.set(libId, g);
        list.push(g);
      }
      return g;
    }
    res.albums.forEach(function (r) { bucket(r.libId, r.libName, r.self).albums.push(r); });
    res.tracks.forEach(function (r) {
      bucket(r.libId, r.libName, r.self)[tabOfTrack(r.track)].push(r);
    });
    return list;
  }

  /* 首屏预算按库均分：每个有命中的库先保底几张，剩下的再按相关度补，
     避免当前库命中多时把其它资源库全挤到「显示更多」后面 */
  function quotaFor(groups, field, budget) {
    const q = new Map();
    const hitGroups = groups.filter(function (g) { return g[field].length; });
    if (budget === Infinity) {
      hitGroups.forEach(function (g) { q.set(g.libId, g[field].length); });
      return q;
    }
    let left = budget;
    const base = Math.max(1, Math.min(4, Math.floor(budget / Math.max(1, hitGroups.length))));
    hitGroups.forEach(function (g) {
      const n = Math.min(base, g[field].length, Math.max(0, left));
      q.set(g.libId, n);
      left -= n;
    });
    hitGroups.forEach(function (g) {
      if (left <= 0) return;
      const extra = Math.min(left, g[field].length - q.get(g.libId));
      q.set(g.libId, q.get(g.libId) + extra);
      left -= extra;
    });
    return q;
  }

  /* 标签条 + 资源库筛选：宽屏同一行，窄屏由 CSS 折行 */
  function searchBarHtml(counts, tab, scope) {
    const tabs = SEARCH_TABS.map(function (t) {
      const n = counts[t.key];
      return '<button class="search-tab' + (t.key === tab ? ' on' : '') + (n ? '' : ' is-empty') +
        '" role="tab" aria-selected="' + (t.key === tab ? 'true' : 'false') + '"' +
        ' data-act="q-tab" data-tab="' + t.key + '">' + t.label + '<b>' + n + '</b></button>';
    }).join('');
    return '<div class="search-bar">' +
      '<div class="search-tabs" role="tablist">' + tabs + '</div>' +
      '<div class="search-scope">' +
        '<button class="chip' + (scope === 'all' ? ' on' : '') + '" data-act="q-scope" data-scope="all">全部资源库</button>' +
        '<button class="chip' + (scope === 'cur' ? ' on' : '') + '" data-act="q-scope" data-scope="cur">当前资源库</button>' +
      '</div></div>';
  }

  /* 一个资源库一节：库名 +「当前」徽标 + 本库命中数 */
  function searchSectionHead(libName, self, total) {
    return '<div class="section-head"><div class="section-title">' + esc(libName || '资源库') +
      (self ? '<span class="section-lib">当前</span>' : '') +
      '<span class="section-n">' + total + '</span></div></div>';
  }

  function searchRowHtml(r, kind, g) {
    if (kind === 'album') {
      return albumCard(r.album, { libId: g.libId, libName: g.libName, self: g.self });
    }
    /* 组标题已经写了库名，行里不再重复（libName 传空）；foreign 仍按 !self 传：
       跨库行的进度 / 下载标记 / 更多菜单要屏蔽掉 */
    return flatTrack(r.track, {
      foreign: !r.self, libId: r.self ? '' : g.libId, self: r.self, albumTitle: r.albumTitle
    });
  }

  function searchSectionHtml(g, kind, items) {
    if (!items.length) return '';
    const cls = kind === 'album' ? 'grid' : 'track-list';
    return '<div class="search-sec">' + searchSectionHead(g.libName, g.self, g[tabField(kind)].length) +
      '<div class="' + cls + '" data-lib="' + esc(g.libId) + '">' +
      items.map(function (r) { return searchRowHtml(r, kind, g); }).join('') + '</div></div>';
  }

  function viewSearch(q) {
    const scope = state.qScope === 'cur' ? 'cur' : 'all';
    const res = L.searchAll(q, { scope: scope, showHidden: state.showHidden });
    const counts = searchCounts(res);
    /* 空标签是允许停留的（用户自己点进去的，给该标签自己的空态）；
       只有取值非法时才兜回专辑，别把用户的点击静默改掉 */
    const kind = state.qTab === 'audio' || state.qTab === 'video' ? state.qTab : 'album';
    state.qTab = kind;
    const field = tabField(kind);
    const groups = searchGroups(res);
    /* 别的库的封面索引按需读：读到之前那几张卡片只有首字渐变，读完后补一次静默重绘。
       同一个库一个会话只读一次，之后都是同步查表 */
    const needCovers = groups
      .filter(function (g) { return !g.self && g.albums.length; })
      .map(function (g) { return g.libId; });
    if (needCovers.length && FM.covers) {
      Promise.all(needCovers.map(function (id) { return FM.covers.ensureLib(id); })).then(function (rs) {
        if (rs.indexOf(true) < 0) return;       /* 没读到新东西：不重绘，免得打断滚动 */
        if (state.q !== q) return;              /* 已经换了关键词 / 退出搜索 */
        renderMain({ quiet: true });
        /* 建议浮层里也有封面，一起补画（输入中浮层通常正开着） */
        if (refs.searchPop && !refs.searchPop.hidden) { popInvalidate(); popPaint(); }
      }).catch(function () {});
    }
    const budget = state.qMore ? Infinity : (kind === 'album' ? SEARCH_ALBUMS : SEARCH_TRACKS);
    const quota = quotaFor(groups, field, budget);
    const tail = [];
    let shown = 0;
    const body = groups.map(function (g) {
      const items = g[field].slice(0, quota.get(g.libId) || 0);
      shown += items.length;
      g[field].slice(items.length).forEach(function (r) {
        tail.push({ r: r, libId: g.libId, libName: g.libName, self: g.self, n: g[field].length });
      });
      return searchSectionHtml(g, kind, items);
    }).join('');

    const hit = counts[kind];
    searchTail = tail.length ? { kind: kind, items: tail } : null;
    /* 副标题里的「当前显示 x / y 条」：命中超过首屏预算才显示，
       展开到底之后继续显示满额，别让数字在半路消失 */
    searchTotal = hit;
    searchCountOn = hit > (kind === 'album' ? SEARCH_ALBUMS : SEARCH_TRACKS);
    const more = searchTail
      ? '<div id="searchMore" class="search-more"><button class="btn" data-act="search-more">显示更多 · 还有 ' +
        tail.length + ' 条</button></div>'
      : '';
    const pending = (scope === 'cur' || !res.pendingLibs.length) ? '' :
      '<div class="search-pending">' + res.pendingLibs.map(function (l) {
        return '<div class="search-pending-row">' + icon('library') + '<b>' + esc(l.name) + '</b><span>' +
          (l.missing ? '目录不可用，请先重新定位' : '未建立索引，切过去一次即可搜索') + '</span></div>';
      }).join('') + '</div>';
    const libTotal = (FM.fs.libs() || []).length;
    const others = SEARCH_TABS
      .filter(function (t) { return t.key !== kind && counts[t.key]; })
      .map(function (t) { return t.label + ' ' + counts[t.key]; }).join(' · ');
    const emptyText = TAB_EMPTY[kind];
    const empty = hit ? '' :
      '<div class="empty"><div class="empty-art">' + icon(kind === 'album' ? 'search' : 'headphones') + '</div>' +
      '<h3>' + emptyText[0] + '</h3><p>' + emptyText[1] + '</p>' +
      (others ? '<p class="search-others">其它标签里还有命中：' + others + '</p>' : '') + '</div>';

    const wrap = U.el('div');
    wrap.innerHTML = '<div class="view-head"><div><div class="page-title">搜索 “' + esc(q) + '”</div>' +
      '<div class="page-sub">' + SEARCH_TABS.map(function (t) { return counts[t.key] + ' ' + t.unit; }).join(' · ') +
      (scope === 'all' && libTotal > 1 ? ' · 搜索 ' + libTotal + ' 个资源库' : '') +
      '<span id="searchCount">' + (searchCountOn ? '（当前显示 ' + shown + ' / ' + hit + ' 条）' : '') + '</span>' +
      '</div></div></div>' +
      searchBarHtml(counts, kind, scope) +
      '<div class="search-results">' + body + more + empty + '</div>' +
      pending;
    return wrap;
  }

  /* 搜索结果滚到底追加下一批：按 data-lib 把卡片 / 单集塞回各自的分组容器，
     不重建已画好的部分，也不一次把几百条全铺出来 */
  function findSearchHost(cls, libId) {
    return U.$$('.' + cls, refs.view).find(function (el) { return el.dataset.lib === libId; });
  }

  /* 首屏预算按库均分时，库多的情况下排在后面的库可能一条都没画出来：
     追加时补建这一组的标题与容器，别让条目静默消失 */
  function ensureSearchHost(x, kind) {
    const cls = kind === 'album' ? 'grid' : 'track-list';
    const found = findSearchHost(cls, x.libId);
    if (found) return found;
    const host = refs.view.querySelector('.search-results');
    if (!host) return null;
    const sec = document.createElement('div');
    sec.className = 'search-sec';
    sec.innerHTML = searchSectionHead(x.libName, x.self, x.n || 0) +
      '<div class="' + cls + '" data-lib="' + esc(x.libId) + '"></div>';
    const more = host.querySelector('#searchMore');
    if (more) host.insertBefore(sec, more); else host.appendChild(sec);
    return sec.querySelector('.' + cls);
  }

  function paintSearchMore() {
    const rest = searchTail ? searchTail.items.length : 0;
    const box = refs.view.querySelector('#searchMore');
    if (!rest && box) box.remove();
    const btn = box && box.querySelector('button');
    if (btn && rest) btn.textContent = '显示更多 · 还有 ' + rest + ' 条';
    const cnt = refs.view.querySelector('#searchCount');
    if (!cnt) return;
    if (!searchCountOn || !searchTotal) { cnt.textContent = ''; return; }
    cnt.textContent = '（当前显示 ' + (searchTotal - rest) + ' / ' + searchTotal + ' 条）';
  }

  function appendSearchBatch() {
    if (!searchTail || !searchTail.items.length) return;
    const kind = searchTail.kind;
    const batch = searchTail.items.splice(0, kind === 'album' ? SEARCH_ALBUMS : SEARCH_TRACKS);
    const byLib = new Map();
    batch.forEach(function (x) {
      if (!byLib.has(x.libId)) byLib.set(x.libId, []);
      byLib.get(x.libId).push(x);
    });
    byLib.forEach(function (list) {
      const host = ensureSearchHost(list[0], kind);
      if (!host) return;
      host.insertAdjacentHTML('beforeend', list.map(function (x) {
        return searchRowHtml(x.r, kind, x);
      }).join(''));
      if (kind === 'album') observeCards(host, true);
      applyPlayingState(host);
    });
    if (!searchTail.items.length) searchTail = null;
    paintSearchMore();
  }

  /* ── 专辑详情 ── */
  function viewAlbum(id) {
    const a = L.album(id);
    if (!a) return viewGridPage('专辑不存在', '可能已被移除，请重新扫描资源库', L.albums());
    const st = L.albumStat(a);
    const filtered = albumTracksFiltered(a);
    const trackHtml = trackListHtml(filtered);
    /* 「按分类」分组下，一级文件夹自己会做成一张散集专辑（path 不带 /）。
       它的标题就是分类名，再挂一个同名分类 tag 等于自己标自己，纯噪音——
       这类专辑不显示 tag；二级专辑才挂分类 tag。 */
    const topCatAlbum = L.dirMode() === 'cat' && !!a.dirCat && String(a.path || '').indexOf('/') < 0;
    const cats = topCatAlbum ? [] : L.cats().filter(c => a.cats.indexOf(c.id) >= 0);
    const catTags = cats.map(c => '<span class="tag cat">' + esc(c.name) + '</span>').join('');
    const tagHtml = topCatAlbum ? '' : a.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('');
    const heroTags = (catTags + tagHtml)
      ? '<div class="hero-tags">' + catTags + tagHtml + '</div>' : '';
    const done = a.count > 0 && st.doneCount >= a.count;

    const wrap = U.el('div');
    wrap.innerHTML =
      backHead('') +
      '<section class="album-hero" style="' + U.coverVars(a.seed) + '">' +
        '<div class="hero-cover' + (a.cover ? ' has-photo' : '') + '">' +
          (a.cover ? '<img class="cover-img" loading="lazy" decoding="async" src="' + esc(a.cover) + '" alt="">' : '<span class="card-char' + (initialOf(a).length > 2 ? ' word' : '') + '">' + esc(initialOf(a)) + '</span>') +
        '</div>' +
        '<div class="hero-info">' +
          '<div class="hero-heading">' +
            '<div class="hero-kicker">ALBUM · ' + albumType(a) + '</div>' +
            '<h1 class="hero-title" title="' + esc(a.title) + '">' + esc(a.title) + '</h1>' +
            heroTags +
          '</div>' +
          '<div class="hero-meta"><span>' + a.count + ' 集</span><span class="dot"></span><span>' + fmtS(a.size) + '</span>' +
            (st.dur ? '<span class="dot"></span><span>' + fmtD(st.dur) + '</span>' : '') +
            '<span class="dot"></span><span>已听 ' + st.pct + '%</span>' +
            (done ? '<span class="dot"></span><span style="color:#7ef7d0">已听完</span>' : '') + '</div>' +
          '<div class="hero-actions">' +
            '<button class="btn btn-primary" data-act="album-play" data-id="' + a.id + '">' + icon(albumPlayLabel(a).icon) + albumPlayLabel(a).text + '</button>' +
            '<button class="btn hero-queue" data-act="queue-album" data-id="' + a.id + '">' + icon('list') + '加入队列</button>' +
            '<button class="btn' + (a.fav ? ' danger' : '') + '" data-act="fav" data-id="' + a.id + '">' + icon(a.fav ? 'heart-fill' : 'heart') + (a.fav ? '已收藏' : '收藏') + '</button>' +
            '<button class="btn" data-act="more-album" data-id="' + a.id + '">' + icon('more') + '更多</button>' +
          '</div>' +
        '</div>' +
      '</section>' +
      '<div class="track-toolbar">' +
        '<div class="tk-search">' + icon('search') + '<input id="tkSearch" placeholder="在本专辑中搜索…" value="' + esc(state.detailQ) + '"></div>' +
        '<button class="chip" data-act="sort">' + icon('sort') + (state.sortDesc ? '倒序' : '正序') + '</button>' +
        '<span class="tk-count">' + filtered.length + ' / ' + a.count + ' 集</span>' +
      '</div>' +
      '<div class="track-list" id="trackList">' + trackHtml + '</div>' +
      '<div id="trackPager">' + pagerHtml(filtered.length) + '</div>' +
      /* 手机端没有分页条，列表底部挂一条收尾提示，滚到底再填文案 */
      (isPhone() ? '<div class="track-end" id="trackEnd">' + (trackTail ? '' : TRACK_END) + '</div>' : '');

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
    /* 与全站搜索同一套匹配：拼音 / 首字母在专辑内也生效 */
    return list.filter(t => FM.search.matchText(t.title, state.detailQ));
  }

  /* 分页：页码越界时自动收敛，避免筛选后停在不存在的页 */
  function pageSlice(list) {
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    state.page = Math.min(Math.max(0, state.page), pages - 1);
    const from = state.page * PAGE;
    return { items: list.slice(from, from + PAGE), from: from, pages: pages };
  }

  /* 「加入队列」用：在专辑详情页只排当前这一页（手机端没有「页」，按已经滚出来的那些集），
     其它地方退回整张 */
  function currentQueueTracks(id) {
    const a = L.album(id);
    if (!a) return [];
    if (state.view === 'album' && state.albumId === id) {
      const list = albumTracksFiltered(a);
      return isPhone() ? list.slice(0, state.trackShown || PAGE) : pageSlice(list).items;
    }
    return L.albumTracks(id);
  }

  /* 页码窗口：总页数少就全列；否则「首页 + 当前页附近 5 个 + 末页」，缺的用 null 顶上（画成省略号） */
  function pageSeq(page, pages) {
    const WIN = 5;
    const out = [];
    if (pages <= WIN + 2) {
      for (let i = 0; i < pages; i++) out.push(i);
      return out;
    }
    let lo = page - 2, hi = page + 2;
    if (lo < 0) { lo = 0; hi = WIN - 1; }
    if (hi > pages - 1) { hi = pages - 1; lo = pages - WIN; }
    if (lo > 0) {
      out.push(0);
      if (lo === 2) out.push(1);      /* 只差一个页码时补上，别用省略号占位 */
      else if (lo > 2) out.push(null);
    }
    for (let i = lo; i <= hi; i++) out.push(i);
    if (hi < pages - 1) {
      if (hi === pages - 2) out.push(pages - 1);
      else { out.push(null); out.push(pages - 1); }
    }
    return out;
  }

  /* 分页条：网页/桌面版按喜马拉雅那套排 —— 上一页、首页、省略号、当前页附近、
     末页、下一页，右侧跟一个「输入页码 / 跳转」。手机端不出分页条，改滚动加载 */
  function pagerHtml(total) {
    if (isPhone()) return '';
    const pages = Math.max(1, Math.ceil(total / PAGE));
    if (pages <= 1) return '';
    const page = state.page;

    const from = page * PAGE + 1;
    const to = Math.min(total, (page + 1) * PAGE);

    /* 先排 token（箭头/页码/省略号），再按相邻关系给同一段里的按钮打圆角，缺口处自然断开 */
    const seq = [{ arrow: 'prev', n: page - 1, off: page === 0 }];
    pageSeq(page, pages).forEach(function (n) { seq.push(n === null ? { gap: true } : { n: n }); });
    seq.push({ arrow: 'next', n: page + 1, off: page === pages - 1 });

    const html = seq.map(function (tk, i) {
      if (tk.gap) return '<span class="pg-gap">···</span>';
      const prev = seq[i - 1], next = seq[i + 1];
      const cls = ['page-btn'];
      if (tk.arrow) cls.push('arrow', tk.arrow);
      if (!tk.arrow && tk.n === page) cls.push('on');
      if (!prev || prev.gap) cls.push('r1');
      if (!next || next.gap) cls.push('r2');
      const label = tk.arrow === 'prev' ? '上一页' : tk.arrow === 'next' ? '下一页' : '第 ' + (tk.n + 1) + ' 页';
      return '<button class="' + cls.join(' ') + '" data-act="page" data-page="' + tk.n + '"' +
        (tk.off ? ' disabled' : '') + (cls.indexOf('on') >= 0 ? ' aria-current="page"' : '') +
        ' aria-label="' + label + '">' +
        (tk.arrow ? icon('chevron') : (tk.n + 1)) + '</button>';
    }).join('');

    return '<div class="track-pager pg-bar">' +
      '<span class="pg-info">第 ' + from + '–' + to + ' 集 · 共 ' + total + ' 集</span>' +
      '<div class="pg-ctl">' + html + '</div>' +
      '<div class="pg-jump">' +
        '<input id="pageJump" type="text" inputmode="numeric" autocomplete="off" placeholder="请输入页码" aria-label="跳转到指定页">' +
        '<button data-act="page-jump">跳转</button>' +
      '</div>' +
    '</div>';
  }

  /* 曲目列表的首屏内容：桌面按页切，手机先画一批、剩下的留在 trackTail 里等滚动加载 */
  function trackListHtml(list) {
    if (!isPhone()) {
      trackTail = null;
      return pageSlice(list).items.map(t => trackRow(t)).join('');
    }
    const shown = Math.min(list.length, state.trackShown || PAGE);
    trackTail = list.length > shown ? list : null;
    return list.slice(0, shown).map(t => trackRow(t)).join('');
  }

  /* 手机端滚到底：往现有列表里追加下一批，画完最后一批就把「已经到底啦~」挂上 */
  function appendTrackBatch() {
    const host = document.getElementById('trackList');
    if (!host) { trackTail = null; return; }   /* 已经换了页面：清掉尾巴，别让滚动加载空转 */
    if (!trackTail) return;
    const shown = host.children.length;
    const next = trackTail.slice(shown, shown + PAGE);
    if (next.length) {
      const tmp = document.createElement('div');
      tmp.innerHTML = next.map(t => trackRow(t)).join('');
      const frag = document.createDocumentFragment();
      while (tmp.firstChild) frag.appendChild(tmp.firstChild);
      host.appendChild(frag);
      applyPlayingState(host);
      state.trackShown = shown + next.length;
    }
    if (shown + next.length >= trackTail.length) trackTail = null;
    paintTrackEnd();
  }

  /* 列表底部的收尾提示：还有没画出来的就留空（空元素在 css 里不占位） */
  function paintTrackEnd() {
    const el = document.getElementById('trackEnd');
    if (el) el.textContent = trackTail ? '' : TRACK_END;
  }

  /* 翻页统一入口：页码在这里收敛到有效范围，翻完把视口滚回列表顶部 */
  function gotoPage(n) {
    const a = L.album(state.albumId);
    if (!a) return;
    const pages = Math.max(1, Math.ceil(albumTracksFiltered(a).length / PAGE));
    const p = Math.min(Math.max(0, isNaN(n) ? 0 : n), pages - 1);
    if (p === state.page) return;
    state.page = p;
    renderMain();
    /* 滚到工具栏（sticky），避免首行被它盖住 */
    const anchor = refs.view.querySelector('.track-toolbar') || document.getElementById('trackList');
    if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ block: 'start' });
  }

  /* 专辑详情页的「定位当前播放」键：底栏正在放这张专辑的某一集时才浮出来。
     暂停也留着 —— 回来接着听时更需要知道听到哪了 */
  function syncLocateFab() {
    const btn = refs.locateFab;
    if (!btn) return;
    const t = P.current;
    btn.hidden = !(t && !state.q && state.view === 'album' && state.albumId && t.albumId === state.albumId);
  }

  /* 定位到当前播放这一集：先在列表里找到它的下标，把还没画出来的那页/那批补上，
     再滚到那一行（桌面按页、手机按已滚出来的批次；被专辑内搜索筛掉时先清搜索） */
  function locateCurrent() {
    const t = P.current;
    if (!t) return;
    const a = L.album(t.albumId);
    if (!a) return;
    let list = albumTracksFiltered(a);
    let idx = list.findIndex(function (x) { return x.id === t.id; });
    let needRender = false;
    if (idx < 0) {
      if (!state.detailQ) { toast('当前播放不在这张专辑的节目里'); return; }
      state.detailQ = '';
      state.page = 0;
      state.trackShown = 0;
      list = albumTracksFiltered(a);
      idx = list.findIndex(function (x) { return x.id === t.id; });
      if (idx < 0) { toast('当前播放不在这张专辑的节目里'); return; }
      needRender = true;
    }
    if (isPhone()) {
      const need = Math.min(list.length, (Math.floor(idx / PAGE) + 1) * PAGE);
      if (need > (state.trackShown || PAGE)) { state.trackShown = need; needRender = true; }
    } else {
      const page = Math.floor(idx / PAGE);
      if (page !== state.page) { state.page = page; needRender = true; }
    }
    if (needRender) renderMain();
    const rows = U.$$('#trackList .track');
    const row = rows.filter(function (el) { return el.dataset.id === t.id; })[0];
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* 专辑详情的曲目行：两行（标题 / 时长），不放播放按钮 —— 点整行就播（见 onViewClick 的 .track 分支）。
     第二行：没听过的只显示时长；听过一部分的显示「已听位置 / 时长」，一眼能看出听到哪了；
     听完的「已听」跟在时长后面，标题那行只留视频这类内容标记。 */
  function trackRow(t) {
    const p = L.progressOf(t.id);
    const playing = P.current && P.current.id === t.id;
    const dur = t.duration || (p && p.d) || 0;
    const flag = p && p.done ? '<span class="tk-flag">已听</span>' : '';
    const vid = t.kind === 'video' ? '<span class="tk-flag vid">' + icon('video') + '视频</span>' : '';
    /* 和以前一样只在「听过一点、又没听完」时显示进度；5 秒以内当作没听过 */
    const pos = (!p || !p.done) && p && p.p > 5 && dur ? Math.min(p.p, dur) : 0;
    /* 时长单独包一层 .tk-dur：后台探到时长后 probeDurations 按这个类就地刷新，
       滚动加载出来的行也能更新，不会一直显示「—」 */
    const sub = pos ? '<span class="tk-cur">' + fmtT(pos) + '</span> / <span class="tk-dur">' + fmtT(dur) + '</span>'
      : '<span class="tk-dur">' + (dur ? fmtT(dur) : '—') + '</span>';
    return '<li class="track' + (playing ? ' playing' : '') + '" data-id="' + t.id + '" data-album="' + t.albumId + '">' +
      '<span class="tk-idx">' + (t.order + 1) + '</span>' +
      '<span class="tk-eq"><i></i><i></i><i></i></span>' +
      '<div class="tk-main tk-col">' +
        '<span class="tk-title-row">' + dlFlag(t) + vid + '<span class="tk-name" title="' + esc(t.title) + '">' + esc(t.title) + '</span></span>' +
        '<span class="tk-sub">' + icon('clock') + sub + flag + '</span>' +
      '</div>' +
      '<button class="tk-more" data-act="more-track" data-id="' + t.id + '">' + icon('more') + '</button>' +
    '</li>';
  }

  /* opts.foreign：别的资源库的搜索结果。进度 / 下载标记 / 更多菜单都按 track id 查当前库，
     跨库时 id 可能撞上（rel 相同就同 id），一律不显示这些状态，避免张冠李戴 */
  function flatTrack(t, opts) {
    const o = opts || {};
    const foreign = !!o.foreign;
    const a = foreign ? null : L.album(t.albumId);
    const p = foreign ? null : L.progressOf(t.id);
    const dur = t.duration || (p && p.d) || 0;
    const playing = !foreign && P.current && P.current.id === t.id;
    const pct = p && dur ? Math.min(100, Math.round((p.p || 0) / dur * 100)) : 0;
    const albumTitle = o.albumTitle || (a ? a.title : '');
    const vid = t.kind === 'video' ? '<span class="tk-flag vid">' + icon('video') + '视频</span>' : '';
    const sub = albumTitle +
      (foreign && o.libName ? ' · ' + o.libName : '') +
      (!foreign && p && p.t ? ' · ' + U.fmtAgo(p.t) : '');
    const libAttr = (o.libId && !o.self) ? ' data-lib="' + esc(o.libId) + '"' : '';
    return '<li class="track' + (playing ? ' playing' : '') + '" data-id="' + t.id + '" data-album="' + t.albumId + '"' + libAttr + '>' +
      (o.noIdx ? '' : '<span class="tk-idx">' + (t.order + 1) + '</span>') +
      '<span class="tk-eq"><i></i><i></i><i></i></span>' +
      '<div class="tk-main" style="flex-direction:column;align-items:flex-start;gap:3px">' +
        '<span class="tk-title-row">' + (foreign ? '' : dlFlag(t)) + vid + '<span class="tk-name" title="' + esc(t.title) + '">' + esc(t.title) + '</span></span>' +
        '<span style="font-size:10.5px;color:var(--dim-2)">' + esc(sub) + '</span>' +
      '</div>' +
      (pct ? '<span class="tk-prog">' + pct + '%</span>' : '') +
      '<button class="tk-play" data-act="row-play" data-id="' + t.id + '"' + libAttr + ' title="' + (playing && P.playing ? '暂停' : '播放这一集') + '">' +
        icon(playing && P.playing ? 'pause' : 'play') + '</button>' +
      '<span class="tk-dur">' + (dur ? fmtT(dur) : '—') + '</span>' +
      (foreign ? '' : '<button class="tk-more" data-act="more-track" data-id="' + t.id + '">' + icon('more') + '</button>') +
    '</li>';
  }


  /* ── 时长探测（后台低并发） ──
     复用一个 <audio>/<video>：每集新建媒体元素，手机上光是初始化就要几十毫秒
     （实测 15 集就让主线程忙了 4 秒多），串行复用一个元素便宜得多。
     探不到时长的集记在 __noDur 上，同一会话不再重试（以前失败不记账，翻页/排序会重新探一遍）。 */
  let probeToken = 0;
  let probeAudio = null;
  let probeVideo = null;

  function readDuration(url, isVideo) {
    const el = isVideo
      ? (probeVideo || (probeVideo = document.createElement('video')))
      : (probeAudio || (probeAudio = document.createElement('audio')));
    return new Promise(function (res) {
      let done = false;
      let timer = 0;
      const finish = function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.onloadedmetadata = null;
        el.onerror = null;
        try { el.removeAttribute('src'); el.load(); } catch (e) {}
        res(v);
      };
      timer = setTimeout(function () { finish(0); }, 8000);
      el.preload = 'metadata';
      el.muted = true;
      el.onloadedmetadata = function () { finish(isFinite(el.duration) ? el.duration : 0); };
      el.onerror = function () { finish(0); };
      el.src = url;
      try { el.load(); } catch (e) {}
    });
  }

  async function probeDurations(list) {
    const token = ++probeToken;
    if (!FM.fs.hasSource) return;
    /* 网盘库：探一次时长就要换一次直链 + 拉一次元数据，500 集会打爆上游限流，
       还会和正在播的那一集抢连接。时长等真正播放时由 loadedmetadata 写回。 */
    if (FM.fs.isAlist) return;
    const pool = list.filter(t => !t.duration && !t.__noDur).slice(0, 500);
    if (!pool.length) return;
    /* 屏幕上正在显示的那一页先探，用户先看到的那几行先有时长 */
    const visible = new Set();
    U.$$('.track', refs.view || document).forEach(function (row) { visible.add(row.dataset.id); });
    pool.sort(function (a, b) { return (visible.has(b) ? 1 : 0) - (visible.has(a) ? 1 : 0); });
    const applyDur = function (t, dur) {
      if (!(dur > 0)) return false;
      L.setDuration(t.id, dur);
      const cell = document.querySelector('.track[data-id="' + t.id + '"] .tk-dur');
      if (cell) cell.textContent = U.fmtTime(dur);
      return true;
    };
    for (let i = 0; i < pool.length; i++) {
      const t = pool[i];
      if (token !== probeToken) return;
      try {
        /* 需要转码或干脆不支持的格式（flv / ape / wv / wma）只让后端读文件头取时长：
           走 src() 会触发转码、或者拿到一个根本放不出来的 blob。ape/wv/wma 虽然不能播，
           时长照样能从文件头读出来，列表里不至于全是 --:--。
           读不到就记 __noDur（本次会话不再试）：否则没装 ffmpeg 的机器上
           每进一次专辑页都要白发几十个 HTTP/IPC 请求 */
        if (FM.media.needsTranscode(t.ext) || FM.media.unsupported(t.ext)) {
          const d = await FM.fs.duration(t.rel);
          if (token !== probeToken) return;
          if (!applyDur(t, d)) t.__noDur = true;
          continue;
        }
        const s = await FM.fs.src(t.rel);
        const dur = await readDuration(s.url, t.kind === 'video');
        if (s.revoke) s.revoke();
        if (token !== probeToken) return;
        if (!applyDur(t, dur)) t.__noDur = true;
      } catch (e) {
        t.__noDur = true;
      }
    }
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

  /* ── 收听统计 ─────────────────────────────────────────── */
  function viewStats() {
    const wrap = U.el('div'); wrap.className = 'stats-view';
    let mode = 'day';
    let lastData = null;                 /* 最近一次 summary，liveTick 用它替换今日值 */
    let axisTop = 900;                   /* 纵轴顶端秒数：柱高按它归一，刻度也按它画 */
    let detailKeys = '';                 /* 明细表的行结构，结构没变就只改数字 */
    let detailOpen = false;              /* 明细默认折叠，展开后才生成表格 */
    let resyncing = false;               /* 今日档跨小时重绘中，避免每秒重复触发 */
    let liveTimer = null, unsub = null, alive = true;

    wrap.innerHTML =
      '<div class="stats-head">' +
        '<h1 class="stats-title">收听统计</h1>' +
        '<div class="seg" id="statsSeg">' +
          '<button class="seg-btn active" data-mode="day">今日</button>' +
          '<button class="seg-btn" data-mode="yday">昨天</button>' +
          '<button class="seg-btn" data-mode="d7">7 天</button>' +
          '<button class="seg-btn" data-mode="d30">30 天</button>' +
        '</div>' +
      '</div>' +
      '<section class="stats-hero">' +
        '<div class="hero-top"><div class="hero-label">收听时长 · <b id="scopeLabel">今日</b></div></div>' +
        '<div class="hero-num"><span class="val" id="durBig">0</span><span class="hero-unit" id="durUnit">分钟</span></div>' +
        '<div class="hero-sub" id="durSub">今天还没开始收听</div>' +
        '<div class="stats-chart">' +
          '<div class="chart-y" id="durY" aria-hidden="true"></div>' +
          '<div class="chart-plot">' +
            '<div class="chart-grid" id="durGrid" aria-hidden="true"></div>' +
            '<div class="hero-bars" id="durBars" aria-hidden="true"></div>' +
          '</div>' +
        '</div>' +
        '<div class="hero-foot">' +
          '<span id="rangeText">今天 · 0–23 时</span>' +
          '<span>共 <b id="countNum">0</b> <span id="countUnit">小时</span>有记录</span>' +
        '</div>' +
      '</section>' +
      '<section class="stats-detail" id="detailCard">' +
        '<button class="detail-head" id="detailToggle" type="button" aria-expanded="false" aria-controls="detailBody">' +
          '<span class="detail-title">明细数据</span>' +
          '<span class="detail-sub" id="detailSub"></span>' +
          '<span class="detail-caret" aria-hidden="true"></span>' +
        '</button>' +
        '<div class="detail-body" id="detailBody" hidden>' +
          '<div class="detail-list" id="detailList"></div>' +
        '</div>' +
      '</section>' +
      '<section class="stats-top">' +
        '<div class="top-head">' +
          '<div class="top-heading">' +
            '<h2 class="top-title">专辑 Top5</h2>' +
            '<span class="top-sub">历史累计</span>' +
          '</div>' +
          '<div class="seg seg-sm" id="topSeg">' +
            '<button class="seg-btn active" data-scope="all">全库</button>' +
            '<button class="seg-btn" data-scope="lib">当前库</button>' +
          '</div>' +
        '</div>' +
        '<div class="top-list" id="topList"></div>' +
        '<div class="top-foot">只统计历史累计收听时长，不随上方时间档变化</div>' +
      '</section>';

    const $ = function (id) { return wrap.querySelector('#' + id); };
    function hm(n) { return (n < 10 ? '0' : '') + n; }

    /* 明细折叠：默认收起，点开时先用手上的 summary 秒开，再取一次最新数据覆盖 */
    $('detailToggle').onclick = function () {
      detailOpen = !detailOpen;
      $('detailCard').classList.toggle('open', detailOpen);
      $('detailToggle').setAttribute('aria-expanded', detailOpen ? 'true' : 'false');
      $('detailBody').hidden = !detailOpen;
      if (!detailOpen) { detailKeys = ''; return; }
      if (lastData) renderDetail(lastData);
      const m = mode;
      FM.stats.summary(m).then(function (d) {
        if (!alive || !detailOpen || m !== mode || !d) return;
        renderDetail(d);
      }).catch(function () { });
    };

    /* 标签：今日/昨天档 0/6/12/18/23 时（今日额外标当前小时）；7 天每根日期；30 天每 5 天一个 */
    function labelsOf(bars, ti) {
      return bars.map(function (b, i) {
        if (mode === 'day' || mode === 'yday') {
          if (mode === 'day' && i === ti) return '现在';
          if (i % 6 === 0 || i === 23) return i + '时';
          return '';
        }
        if (i === ti) return '今天';
        if (mode === 'd30' && (bars.length - 1 - i) % 5 !== 0) return '';
        const d = new Date(String(b.day).replace(/-/g, '/'));
        return (d.getMonth() + 1) + '/' + d.getDate();
      });
    }

    /* 纵轴刻度：把峰值往上取到「整」时长，均分 4 格；候选步长都能整除成好看的分钟数 */
    const STEPS = [60, 120, 180, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400, 21600, 28800, 43200, 64800, 86400];
    function axisFor(maxSec) {
      const need = Math.max(maxSec, 60) / 4;
      for (let i = 0; i < STEPS.length; i++) if (STEPS[i] >= need) return STEPS[i] * 4;
      return STEPS[STEPS.length - 1] * 4;
    }
    function tickText(sec) {
      if (sec <= 0) return '0';
      if (sec < 3600) return Math.round(sec / 60) + '分';
      const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
      return m ? h + '小时' + m + '分' : h + '小时';
    }
    function drawAxis() {
      let y = '', g = '';
      for (let i = 0; i <= 4; i++) {
        y += '<span class="chart-tick" style="bottom:' + (i * 25) + '%">' + tickText(axisTop * i / 4) + '</span>';
        g += '<i class="chart-line' + (i === 0 ? ' base' : '') + '" style="bottom:' + (i * 25) + '%"></i>';
      }
      $('durY').innerHTML = y;
      $('durGrid').innerHTML = g;
    }

    /* 柱高按纵轴顶端归一；0 值不留桩，免得看着像「听过一点」。
       一条记录都没有时给 1 小时的固定刻度，别显示一条 0–4 分的怪轴 */
    function drawBars(bars, ti, labs) {
      const peak = Math.max.apply(null, bars.map(function (b) { return b.secs; }).concat([0]));
      axisTop = peak > 0 ? axisFor(peak) : 3600;
      drawAxis();
      const c = $('durBars');
      c.classList.toggle('dense', bars.length > 12);
      c.innerHTML = bars.map(function (b, i) {
        const h = b.secs > 0 ? Math.max(1.5, (b.secs / axisTop) * 100) : 0;
        return '<div class="hbar' + (i === ti ? ' on' : '') + '">' +
          '<div class="hbar-track"><div class="hbar-fill' + (b.secs > 0 ? '' : ' z') + '" style="height:' + h + '%">' +
          (i === ti ? '<span class="hbar-dot"></span>' : '') +
          '</div></div>' +
          '<div class="hbar-lab">' + labs[i] + '</div></div>';
      }).join('');
    }

    function scopeName(m) {
      if (m === 'day') return '今日';
      if (m === 'yday') return '昨天';
      return m === 'd7' ? '近 7 天' : '近 30 天';
    }
    function dayLabel(s) {
      const d = new Date(String(s).replace(/-/g, '/'));
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    function showDuration(total) {
      const big = $('durBig');
      if (total >= 3600) { big.textContent = (total / 3600).toFixed(1); $('durUnit').textContent = '小时'; }
      else { big.textContent = String(Math.floor(total / 60)); $('durUnit').textContent = '分钟'; }
      const empty = mode === 'day' ? '今天还没开始收听'
        : (mode === 'yday' ? '昨天没有收听记录'
          : (mode === 'd7' ? '最近 7 天还没开始收听' : '最近 30 天还没开始收听'));
      $('durSub').textContent = total > 0 ? scopeName(mode) + '已收听 ' + FM.stats.fmt(total) : empty;
    }

    /* ── 明细数据：今日按时段，7/30 天按天；只列有记录的，新的在前 ── */
    const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    function peakHour(byHour) {
      if (!byHour || !byHour.length) return -1;
      let bi = -1, bv = 0;
      for (let i = 0; i < 24; i++) {
        const v = Number(byHour[i]) || 0;
        if (v > bv) { bv = v; bi = i; }
      }
      return bi;
    }
    function rowsOf(data) {
      const out = [];
      const hourly = data.mode === 'day' || data.mode === 'yday';
      data.bars.forEach(function (b) {
        if (!(b.secs > 0)) return;
        if (hourly) {
          /* 单个小时桶最多 60 分钟：超了就是多设备重叠，标出来便于核对 */
          out.push({
            key: hm(b.hour) + ':00–' + hm(b.hour + 1) + ':00',
            secs: b.secs, warn: b.secs > 3600, tip: b.secs > 3600 ? '超 60 分' : ''
          });
          return;
        }
        const d = new Date(String(b.day).replace(/-/g, '/'));
        const ph = peakHour(b.byHour);
        out.push({
          key: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WD[d.getDay()],
          secs: b.secs, warn: false,
          tip: ph >= 0 ? '峰值 ' + hm(ph) + ':00' : ''
        });
      });
      return out.reverse();
    }
    /* 折叠头右侧那行小字：收起时也要显示（不然看不出有没有数据） */
    function detailSummary(data) {
      const n = data.bars.filter(function (b) { return b.secs > 0; }).length;
      if (!n) return '';
      const hourly = data.mode === 'day' || data.mode === 'yday';
      return scopeName(data.mode) + ' · ' + n + (hourly ? ' 个时段' : ' 天有记录');
    }
    function renderDetail(data) {
      const rows = rowsOf(data);
      detailKeys = rows.map(function (r) { return r.key; }).join('|');
      $('detailSub').textContent = detailSummary(data);
      const peak = Math.max.apply(null, rows.map(function (r) { return r.secs; }).concat([1]));
      $('detailList').innerHTML = rows.length ? rows.map(function (r) {
        return '<div class="drow' + (r.warn ? ' warn' : '') + '">' +
          '<span class="d-k">' + r.key + (r.tip ? '<em>' + r.tip + '</em>' : '') + '</span>' +
          '<span class="d-bar"><i style="width:' + Math.max(2, (r.secs / peak) * 100) + '%"></i></span>' +
          '<b class="d-v">' + FM.stats.fmt(r.secs) + '</b>' +
          '</div>';
      }).join('') : '<div class="d-empty">这个区间还没有记录</div>';
    }
    /* 结构没变时只改数字，避免每秒重建 DOM */
    function patchDetail(data) {
      const rows = rowsOf(data);
      const peak = Math.max.apply(null, rows.map(function (r) { return r.secs; }).concat([1]));
      const nodes = wrap.querySelectorAll('#detailList .drow');
      for (let i = 0; i < nodes.length && i < rows.length; i++) {
        const v = nodes[i].querySelector('.d-v');
        if (v) v.textContent = FM.stats.fmt(rows[i].secs);
        const bar = nodes[i].querySelector('.d-bar i');
        if (bar) bar.style.width = Math.max(2, (rows[i].secs / peak) * 100) + '%';
      }
    }

    function paint(data) {
      lastData = data;
      const hourly = data.mode === 'day' || data.mode === 'yday';
      $('scopeLabel').textContent = scopeName(mode);
      showDuration(data.total);
      drawBars(data.bars, data.todayIndex, labelsOf(data.bars, data.todayIndex));
      $('rangeText').textContent = hourly
        ? (data.mode === 'day' ? '今天 · 0–23 时' : '昨天 · 0–23 时')
        : dayLabel(data.from) + ' – ' + dayLabel(data.to);
      $('countNum').textContent = data.bars.filter(function (b) { return b.secs > 0; }).length;
      $('countUnit').textContent = hourly ? '小时' : '天';
      /* 明细默认收起：收起时只更新头部那行小字，不建表；展开时才生成/刷新 */
      $('detailSub').textContent = detailSummary(data);
      if (detailOpen) renderDetail(data);
      else detailKeys = '';
    }

    /* ── 专辑 Top5 榜 ──
       口径是历史累计（不受上面的今日 / 7 天 / 30 天影响），所以单独取数：
       进页与 30 秒定时各查一次，播放中不跟着 tick 重排 DOM。 */
    let topScope = 'all';
    let topSeq = 0;
    let topLoadedScope = '';     /* 哪个维度已经成功加载过：失败时据此决定保留旧列表还是给提示 */

    function hasLib() { return !!(FM.fs && FM.fs.activeId); }
    function curRoot() { return (FM.lib && FM.lib.rootKey) || ''; }
    /* 库根键归一：服务端落库时已经统一过大小写和斜杠，客户端这里只做比较用 */
    function normRoot(s) { return String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }

    /* 跨库榜单行：服务端/主进程已经补了 libId；旧版本再从库列表按目录反查兜底 */
    function libIdOfRow(r) {
      if (r.libId) return String(r.libId);
      if (!FM.fs || !FM.fs.libs) return '';
      const key = normRoot(r.libRoot);
      if (!key) return '';
      const hit = (FM.fs.libs() || []).find(function (l) { return normRoot(l.path) === key; });
      return hit ? hit.id : '';
    }

    /* 别的库的专辑不在内存模型里：从该库的本地索引缓存按 albumId 还原目录名。
       covers.js 的 forAlbum 靠 dirName / key 匹配，只有 title 是匹配不到精确条目的 */
    function foreignAlbum(libId, albumId) {
      if (!libId || !FM.db || !FM.db.index || !FM.lib || !FM.lib.indexAlbums) return null;
      try {
        const idx = FM.db.index(libId);
        if (!idx) return null;
        const list = FM.lib.indexAlbums(idx) || [];
        for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === albumId) return list[i];
      } catch (e) {}
      return null;
    }

    function topCatName(a) {
      if (!a || !Array.isArray(a.cats) || !a.cats.length) return '';
      const list = (FM.lib && FM.lib.cats) ? FM.lib.cats() : [];
      const hit = list.find(function (c) { return String(c.id) === String(a.cats[0]); });
      return hit ? hit.name : '';
    }

    function renderTop(rows) {
      const box = $('topList');
      if (!rows.length) {
        box.innerHTML = '<div class="top-empty">' +
          (topScope === 'lib'
            ? (hasLib() ? '当前资源库暂无收听记录' : '请先进入一个资源库')
            : '还没有专辑收听数据，本功能从当前版本开始累计') +
          '</div>';
        return;
      }
      const peak = Math.max.apply(null, rows.map(function (r) { return r.secs; }).concat([1]));
      const here = normRoot(curRoot());
      box.innerHTML = rows.map(function (r, i) {
        /* albumId 是目录路径哈希：两个库里同名目录会撞成同一个 id，
           所以先按 libRoot 判断是不是当前库，再决定能不能用内存里的专辑对象
           （跨库行用当前库的同名对象会拿错标题和封面） */
        const sameLib = !r.libRoot || !here || normRoot(r.libRoot) === here;
        const a = (sameLib && FM.lib) ? FM.lib.album(r.albumId) : null;
        const title = (a && a.title) || r.title || '未命名专辑';
        const initial = initialOf(a || { title: title });
        /* 跨库封面：该库索引缓存里有对应专辑就按目录名查；没有就退回标题快照做相似匹配 */
        let cover = a && a.cover;
        if (!cover && !sameLib && FM.covers) {
          const lid = libIdOfRow(r);
          if (lid) cover = FM.covers.forAlbum(foreignAlbum(lid, r.albumId) || { dirName: r.title || '' }, lid);
        }
        const art = cover
          ? '<img class="cover-img" loading="lazy" decoding="async" src="' + esc(cover) + '" alt="">'
          : '<span class="top-rings"><i></i><i></i><i></i></span>' +
            '<span class="top-char' + (initial.length > 2 ? ' word' : '') + '">' + esc(initial) + '</span>';
        const open = !!a && sameLib;
        const bits = [];
        const cn = topCatName(a);
        if (cn) bits.push(cn);
        if (a && a.count) bits.push(a.count + ' 集');
        if (!sameLib) bits.push('其他资源库');
        /* 跨库专辑没有内存对象：用 id 哈希当种子，保证同一条目每次颜色一致（coverVars 只吃数字） */
        const seed = (a && Number(a.seed)) || U.hash(r.albumId);
        const pct = Math.max(2, Math.round((r.secs / peak) * 100));
        return '<div class="top-row' + (i === 0 ? ' lead' : '') + '"' +
          ' data-id="' + esc(r.albumId) + '"' + (open ? ' data-open="1"' : '') + '>' +
          '<span class="top-rank r' + (i + 1) + '">' + (i + 1) + '</span>' +
          '<span class="top-cover" style="' + U.coverVars(seed) + '">' + art + '</span>' +
          '<span class="top-meta"><span class="top-name" title="' + esc(title) + '">' + esc(title) + '</span>' +
            (bits.length ? '<span class="top-desc">' + esc(bits.join(' · ')) + '</span>' : '') + '</span>' +
          '<b class="top-val">' + esc(FM.stats.fmt(r.secs)) + '</b>' +
          '<i class="top-bar" style="width:' + pct + '%"></i>' +
          '</div>';
      }).join('');
      /* 换维度时整组淡入上浮：只动列表，不重绘整页 */
      box.classList.remove('fade-in');
      void box.offsetWidth;
      box.classList.add('fade-in');
    }

    function renderTopError(msg) {
      $('topList').innerHTML = '<div class="top-empty top-fail">' + esc(msg) + '</div>';
    }

    function refreshTop() {
      const scope = topScope;
      const libId = scope === 'lib' ? ((FM.fs && FM.fs.activeId) || null) : null;
      if (scope === 'lib' && !libId) { topLoadedScope = ''; renderTop([]); return; }
      const seq = ++topSeq;
      /* 失败（断网 / 403 / 限流）不能显示成「还没有数据」：这个维度有过成功结果就保留旧列表 */
      const fail = function () {
        if (!alive || seq !== topSeq || scope !== topScope) return;
        if (topLoadedScope !== scope) renderTopError('榜单暂时加载不出来，稍后会自动重试');
      };
      Promise.resolve()
        /* 先把未落库的秒数冲出去，刚听完的专辑才可能出现在榜单里 */
        .then(function () { return FM.stats.flush(); })
        .then(function () { return FM.stats.albumTop(libId, 5); })
        .then(function (res) {
          /* 切维度期间返回的旧结果直接丢弃 */
          if (!alive || seq !== topSeq || scope !== topScope) return;
          if (!res || res.ok === false) { fail(); return; }
          topLoadedScope = scope;
          const rows = res.rows || [];
          renderTop(rows);
          warmTopCovers(rows, seq, scope);
        })
        .catch(fail);
    }

    /* 别的库的封面索引按需读一次：读到之前跨库条目只有首字渐变，读完后补一次静默重绘。
       同一个库一个会话只读一次，之后都是同步查表（和搜索页同一套机制） */
    function warmTopCovers(rows, seq, scope) {
      if (!FM.covers || !FM.covers.ensureLib) return;
      const hereKey = normRoot(curRoot());
      const ids = [];
      rows.forEach(function (r) {
        if (!r.libRoot || normRoot(r.libRoot) === hereKey) return;
        const id = libIdOfRow(r);
        if (id && id !== (FM.fs && FM.fs.activeId) && ids.indexOf(id) < 0) ids.push(id);
      });
      if (!ids.length) return;
      Promise.all(ids.map(function (id) { return FM.covers.ensureLib(id); })).then(function (rs) {
        if (rs.indexOf(true) < 0) return;         /* 没有新读到：不重绘，免得闪一下 */
        if (!alive || seq !== topSeq || scope !== topScope) return;
        renderTop(rows);
      }).catch(function () {});
    }

    async function refreshDuration(m) {
      let data = null;
      try { data = await FM.stats.summary(m); } catch (e) { data = null; }
      /* 请求期间切了档位就作废，避免用旧数据覆盖新档位 */
      if (!alive || !data || m !== mode) return;
      paint(data);
    }

    function setMode(m) {
      mode = m;
      /* 限定在时间档那组：页面上还有榜单的「全库 / 当前库」分段控件，
         全量遍历会把它的高亮一起清掉 */
      wrap.querySelectorAll('#statsSeg .seg-btn').forEach(function (x) { x.classList.toggle('active', x.dataset.mode === m); });
      refreshDuration(m);
    }

    /* 打开统计页 / 30 秒定时：先等基线刷新完，再取数重绘，避免首屏显示 0 或旧值 */
    async function refreshAll() {
      try { await FM.stats.refresh(); } catch (e) {}
      if (!alive) return;
      refreshDuration(mode);
      refreshTop();
    }

    /* 实时：只用内存里的今日数据，不触发后端请求。
       今日档的一根柱是「这一个小时」，7/30 天档最后一根才是「今天全天」——
       两者别混用，否则播放中当前小时会显示成全天总量（时长看着严重偏高）。 */
    function liveTick() {
      if (!alive || !lastData) return;
      if (mode === 'yday') return;          /* 昨天的数据已经定死，没有实时值 */
      const live = FM.stats.today();
      const nowH = new Date().getHours();

      /* 今日档跨小时：高亮该挪到新的一格，整组重绘一次 */
      if (mode === 'day' && lastData.todayIndex !== nowH) {
        if (!resyncing) {
          resyncing = true;
          refreshDuration('day').then(function () { resyncing = false; });
        }
        return;
      }

      const tSec = mode === 'day' ? (live.byHour[nowH] || 0) : live.secs;
      const ti = lastData.todayIndex;
      const bars = lastData.bars.map(function (b, i) { return i === ti ? tSec : b.secs; });
      const total = bars.reduce(function (a, v) { return a + v; }, 0);
      lastData.total = total;
      lastData.todaySec = live.secs;
      showDuration(total);

      /* 今日值顶破纵轴顶端就整组重画（刻度得跟着变），否则只改柱高 */
      if (tSec > axisTop) {
        drawBars(lastData.bars.map(function (b, i) { return Object.assign({}, b, { secs: bars[i] }); }),
          ti, labelsOf(lastData.bars, ti));
      } else {
        const nodes = wrap.querySelectorAll('.hbar');
        for (let i = 0; i < nodes.length; i++) {
          const f = nodes[i].querySelector('.hbar-fill');
          if (!f) continue;
          f.classList.toggle('z', !(bars[i] > 0));
          f.style.height = (bars[i] > 0 ? Math.max(1.5, Math.min(100, (bars[i] / axisTop) * 100)) : 0) + '%';
        }
      }

      /* 明细跟着走：把今日那根换成实时值。收起时只刷新头部那行小字，不建表 */
      const data = Object.assign({}, lastData, {
        bars: lastData.bars.map(function (b, i) { return Object.assign({}, b, { secs: bars[i] }); })
      });
      $('detailSub').textContent = detailSummary(data);
      if (!detailOpen) return;
      if (rowsOf(data).map(function (r) { return r.key; }).join('|') === detailKeys) patchDetail(data);
      else renderDetail(data);
    }

    /* 事件绑定 */
    $('statsSeg').onclick = function (e) { const b = e.target.closest('.seg-btn'); if (b) setMode(b.dataset.mode); };
    $('topSeg').onclick = function (e) {
      const b = e.target.closest('.seg-btn');
      if (!b || b.disabled || b.dataset.scope === topScope) return;
      /* 不在渲染时禁死按钮：进页那一刻库可能还没加载完，禁用了就再也不会恢复 */
      if (b.dataset.scope === 'lib' && !hasLib()) { toast('请先进入一个资源库', 'warn'); return; }
      topScope = b.dataset.scope;
      wrap.querySelectorAll('#topSeg .seg-btn').forEach(function (x) {
        x.classList.toggle('active', x.dataset.scope === topScope);
      });
      refreshTop();
    };
    /* 只有当前库里存在的专辑才能跳详情；跨库条目只展示 */
    $('topList').onclick = function (e) {
      const row = e.target.closest('.top-row');
      if (!row || row.dataset.open !== '1') return;
      go('#/album/' + row.dataset.id);
    };

    /* 初次填充：等基线刷新完成后统一重绘，避免首屏显示 0 或旧值 */
    refreshAll();

    /* 实时刷新：播放中随 tick 更新时长与当前柱；每 30 秒重新取数一次 */
    unsub = FM.stats.on('tick', liveTick);
    liveTimer = setInterval(refreshAll, 30000);

    /* 显式卸载：renderMain 换页前会调用，不依赖「下一次 tick」才清理 */
    statsViewTeardown = function () {
      alive = false;
      if (unsub) { unsub(); unsub = null; }
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    };

    return wrap;
  }

  /* ── 欢迎页 ── */
  function renderWelcome() {
    const v = refs.view;
    const srv = !!FM.fs.server;
    const secure = FM.fs.supportsPicker();
    const app = !srv && !!FM.android;      /* 安卓壳里但没读到库 */
    const web = !!FM.fs.serverReached && !FM.android && !FM.fs.desktop;  /* 连到服务端但还没资源库（网页端） */
    /* 四种空状态：远端有库 / 壳里读不到库 / 网页端连到服务端但没库 / 本机浏览器还没选目录 */
    let text, steps, actions;
    if (srv) {
      text = FM.android
        ? '远端模式：资源库由主机上的目录「' + esc(FM.fs.rootName || '远程资源库') + '」提供。<br>加书请在主机上放进这个目录并重新扫描，手机这边会自动同步。'
        : (canManageLib()
          ? '远端模式：资源库由主机上的目录「' + esc(FM.fs.rootName || '远程资源库') + '」提供。<br>加书请在主机上放进这个目录，再点下面的重新扫描。'
          : '远端模式：资源库由主机上的目录「' + esc(FM.fs.rootName || '远程资源库') + '」提供。<br>加书请在主机上放进这个目录，内容更新后会在你下次打开时自动同步。');
      steps = FM.android
        ? '<span class="step"><b>1</b>主机放入音频</span>' +
          '<span class="step"><b>2</b>主机重新扫描</span>' +
          '<span class="step"><b>3</b>手机自动同步</span>'
        : '<span class="step"><b>1</b>主机放入音频</span>' +
          '<span class="step"><b>2</b>重新扫描</span>' +
          '<span class="step"><b>3</b>分类、倍速、播放</span>';
      /* 手机端的扫描入口在顶栏设置里（「重新扫描」）；这里只留重试（连不上主机时用）。
         网页端普通用户禁用扫描（只读）。 */
      actions = FM.android
        ? '<button class="btn" data-act="retry" style="height:44px;padding:0 22px">' + icon('refresh') + '重试连接</button>'
        : (canManageLib()
          ? '<button class="btn btn-primary" data-act="rescan" style="height:44px;padding:0 26px">' + icon('refresh') + '重新扫描</button>'
          : '');
    } else if (app) {
      text = '还没读到电脑上的资源库。<br>先在电脑端添加一个有声书目录，或确认服务是否在运行。';
      steps = '<span class="step"><b>1</b>电脑上运行服务</span>' +
        '<span class="step"><b>2</b>添加资源库</span>' +
        '<span class="step"><b>3</b>手机自动读到</span>';
      actions = '<button class="btn btn-primary" data-act="retry" style="height:44px;padding:0 26px">' + icon('refresh') + '重试连接</button>' +
        /* 服务器地址同样只对管理员开放；连不上服务端无法判定角色时保留恢复入口 */
        (canManageLib()
          ? '<button class="btn" data-act="app-settings" style="height:44px;padding:0 20px">' + icon('edit') + '服务器地址</button>'
          : '');
    } else if (web) {
      /* 连到服务端但还没资源库：管理员可以给服务器指定目录，普通用户只能等管理员加 */
      if (FM.fs.isAdmin) {
        text = '还没有资源库。点下面的「添加资源库」，在运行服务的那台机器上指定一个存放音频的目录。';
        steps = '<span class="step"><b>1</b>指定服务器目录</span>' +
          '<span class="step"><b>2</b>自动扫描</span>' +
          '<span class="step"><b>3</b>分类、倍速、播放</span>';
        actions = '<button class="btn btn-primary" data-act="scan" style="height:44px;padding:0 26px">' + icon('folder') + '添加资源库</button>';
      } else {
        text = '还没有资源库，请联系管理员添加。';
        steps = '';
        actions = '';
      }
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
    /* 手机顶栏：子页左侧是返回箭头，首页左侧是品牌（看/切资源库），右侧设置菜单。
       箭头是原生 <button>，Enter/Space 自带激活，别再手写 keydown（否则会走两遍） */
    if (refs.tbBack) refs.tbBack.addEventListener('click', goBack);
    if (refs.tbBrand) {
      refs.tbBrand.addEventListener('click', openLibSwitch);
      refs.tbBrand.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLibSwitch(); }
      });
    }
    if (refs.btnSettings) refs.btnSettings.addEventListener('click', openSettingsMenu);
    refs.libSwitch.addEventListener('click', function () { openLibMenu(refs.libSwitch); });
    refs.btnSync.addEventListener('click', function () { doScan(); });
    if (refs.btnLogout) {
      refs.btnLogout.addEventListener('click', function () { location.href = '/__auth/logout'; });
    }
    refs.btnAddCat.addEventListener('click', function () { editCat(null); });
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
      if (id) { assignCat(id, item.dataset.cat, true); }
    });

    /* 非防抖：面板立刻标脏。防抖重绘前这段时间里，点击 / 回车都不许命中旧条目 */
    refs.searchInput.addEventListener('input', function () {
      if (!refs.searchPop.hidden) popInvalidate();
    });
    refs.searchInput.addEventListener('input', U.debounce(function () {
      const q = refs.searchInput.value.trim();
      refs.searchClear.hidden = !q;
      state.q = q;
      state.qMore = false;      /* 换了关键词就回到「只显示首屏」，别把上次的展开状态带过来 */
      /* 当前标签没命中了就自动换到有命中的那一栏，别让用户对着空列表继续打字 */
      if (q) {
        resolveSearchTab(q, state.qScope === 'cur' ? 'cur' : 'all');
        renderMain();
        popPaint();
      }
      else { route(); popPaint(); }   /* route 会关浮层，清空后重新给最近搜索 */
    }, 160));

    /* 聚焦即给建议：空输入看历史，有输入看实时命中 */
    refs.searchInput.addEventListener('focus', function () { popPaint(); });
    refs.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        popPaint();                  /* 内容变了就按输入框当前值重绘，别在旧结果上移动光标 */
        if (refs.searchPop.hidden || !popItems.length) return;
        e.preventDefault();
        popSelect(popIdx + (e.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = refs.searchInput.value;
        /* 面板标脏 / 内容与生成面板时不一致：一律按当前输入提交搜索 */
        if (!popStale && popQuery === v.trim() && popIdx >= 0 && popItems[popIdx]) popAct(popItems[popIdx]);
        else submitSearch(v);
        return;
      }
      if (e.key === 'Escape' && !refs.searchPop.hidden) {
        /* 第一下只收浮层，第二下交给全局的「Esc 失焦」 */
        e.stopPropagation();
        popClose();
      }
    });
    /* mousedown 先拦下默认行为：否则 input 先失焦，click 还没到面板就被关掉了 */
    refs.searchPop.addEventListener('mousedown', function (e) { e.preventDefault(); });
    refs.searchPop.addEventListener('click', function (e) {
      const el = e.target.closest('[data-sp]');
      if (el) popAct(el);
    });
    document.addEventListener('mousedown', function (e) {
      if (!refs.searchPop || refs.searchPop.hidden) return;
      if (refs.searchWrap && refs.searchWrap.contains(e.target)) return;
      popClose();
    });

    refs.searchClear.addEventListener('click', function () {
      refs.searchInput.value = '';
      refs.searchClear.hidden = true;
      state.q = '';
      state.qMore = false;
      route();
      refs.searchInput.focus();   /* 清空后停在搜索框上，方便接着输入 */
      popPaint();
    });

    refs.view.addEventListener('scroll', function () {
      refs.topbar.classList.toggle('scrolled', refs.view.scrollTop > 8);
      maybeLoadMore();
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
        state.trackShown = PAGE;      /* 换了关键词就从第一批重新滚 */
        const a = L.album(state.albumId);
        if (!a) return;
        const filtered = albumTracksFiltered(a);
        const box = document.getElementById('trackList');
        if (box) {
          box.innerHTML = trackListHtml(filtered);
          applyPlayingState(box);
          paintTrackEnd();
        }
        const pager = document.getElementById('trackPager');
        if (pager) pager.innerHTML = pagerHtml(filtered.length);
        const count = refs.view.querySelector('.tk-count');
        if (count) count.textContent = filtered.length + ' / ' + a.count + ' 集';
      }
    });
    /* 跳转框里按回车等于点「跳转」 */
    refs.view.addEventListener('keydown', function (e) {
      if (e.target.id === 'pageJump' && e.key === 'Enter') {
        e.preventDefault();
        const btn = refs.view.querySelector('[data-act="page-jump"]');
        if (btn) btn.click();
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
          if (state.q) FM.search.history.push(state.q);
          if (actEl.dataset.lib) { playAlbumIn(actEl.dataset.lib, id); break; }
          P.playAlbum(id); break;
        }
        case 'open-dl-album': if (id) go('#/downloads/' + id); break;
        case 'open-fav-tracks': go('#/fav/tracks'); break;
        case 'play-fav-tracks': { const list = favTrackList(); if (list.length) P.setQueue(list, 0, { autoplay: true }); break; }
        case 'dl-menu': dlAlbumMenu(id, actEl); break;
        case 'play-dl': playDlTracks(id); break;
        case 'row-play-dl': {
          const t = L.track(id);
          if (!t) break;
          if (P.current && P.current.id === id && P.media.src) P.toggle();
          else playDlTracks(t.albumId, id);
          /* 手机端点下载好的这一集，同样直接进详情页 */
          if (isPhone() && t.kind !== 'video') openSheet();
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
          renderMainKeepScroll();
          break;
        }
        case 'dl-more-all': {
          const sel = state.dlMoreSel || (state.dlMoreSel = {});
          const pend = L.albumTracks(state.albumId).filter(function (t) { return !dlMap()[t.rel]; });
          const all = pend.length > 0 && pend.every(function (t) { return !!sel[t.id]; });
          pend.forEach(function (t) { if (all) delete sel[t.id]; else sel[t.id] = true; });
          renderMainKeepScroll();
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
          renderMainKeepScroll();
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
          renderMainKeepScroll();
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
        case 'queue-album': { const list = currentQueueTracks(id); if (!list.length) break; P.addToQueue(list); toast('已加入播放队列（' + list.length + ' 集）'); break; }
        case 'fav': toggleFavorite(id); break;
        case 'assign': assignModal(id); break;
        case 'more-album': albumMenu(id, actEl); break;
        case 'more-track': trackMenu(id, actEl); break;
        case 'edit-cat': editCat(id); break;
        /* 专辑管理：一键抓取 / 停止 / 选候选 / 清空 / 批量保存 */
        case 'cover-fetch': startCoverFetch(); break;
        case 'cover-stop': stopCoverFetch(); break;
        case 'cover-pick': pickCoverCand(id, Number(actEl.dataset.c)); break;
        case 'cover-zoom': openCoverViewer(id, Number(actEl.dataset.c)); break;
        case 'cover-page': setCoverPage(Number(actEl.dataset.p)); break;
        case 'cover-clear': clearCoverPicks(); break;
        case 'cover-save': saveCoverPicks(); break;
        case 'tab-cat': if (id) go('#/cat/' + id); else go('#/'); break;
        case 'nav': if (actEl.dataset.hash) go(actEl.dataset.hash); break;
        case 'open-downloads': if (FM.android) FM.android.openDownloads(); break;
        case 'back': history.back(); break;
        case 'resume': { const t = L.track(id); if (t) P.playTrack(t); break; }
        case 'open-album':
          if (!id) break;
          if (state.q) FM.search.history.push(state.q);
          if (actEl.dataset.lib) openAlbumIn(actEl.dataset.lib, id);
          else go('#/album/' + id);
          break;
        case 'row-play': {
          if (state.q) FM.search.history.push(state.q);
          if (actEl.dataset.lib) { playTrackIn(actEl.dataset.lib, id, false); break; }
          const t = L.track(id);
          if (!t) break;
          if (P.current && P.current.id === id && P.media.src) P.toggle();
          else P.playTrack(t);
          break;
        }
        case 'sort': state.sortDesc = !state.sortDesc; state.page = 0; state.trackShown = PAGE; FM.db.setState(Object.assign(FM.db.state(), { sortDesc: state.sortDesc })); FM.store.touch('state'); FM.fs.pushMeta({ prefs: { sortDesc: state.sortDesc } }); renderMain(); break;
        case 'page': {
          const p = parseInt(actEl.dataset.page, 10);
          if (!isNaN(p)) gotoPage(p);
          break;
        }
        case 'page-jump': {
          const box = refs.view.querySelector('#pageJump');
          const p = parseInt(box ? box.value : '', 10);
          if (box) box.value = '';
          if (isNaN(p)) toast('请输入页码', 'warn');
          else gotoPage(p - 1);          /* 用户输入的是 1 起的页码 */
          break;
        }
        case 'search-more': state.qMore = true; renderMain(); break;
        case 'q-tab': {
          const tab = actEl.dataset.tab;
          if (tab !== 'album' && tab !== 'audio' && tab !== 'video') break;
          if (tab === state.qTab) break;
          state.qTab = tab;
          state.qMore = false;       /* 换标签回到「只显示首屏」，免得一进来就是几百条 */
          renderMain();
          refs.view.scrollTop = 0;
          break;
        }
        case 'q-scope': {
          state.qScope = actEl.dataset.scope === 'cur' ? 'cur' : 'all';
          state.qMore = false;
          /* 只看当前库时这一栏可能一条命中都没有：自动落到有命中的标签 */
          if (state.q) resolveSearchTab(state.q, state.qScope);
          renderMain();
          break;
        }
        case 'grid-more': appendGridBatch(); break;
        case 'scan': addLibFlow(); break;
        case 'rescan': doScan(); break;
        case 'retry': location.reload(); break;
        case 'app-settings': if (FM.android && canManageLib()) FM.android.openSettings(); break;
        case 'lib-menu': openLibMenu(actEl); break;
        case 'relocate-lib': relocateFlow(FM.fs.active(), null); break;
        case 'toggle-hidden': state.showHidden = !state.showHidden; FM.db.setState(Object.assign(FM.db.state(), { showHidden: state.showHidden })); FM.store.touch('state'); FM.fs.pushMeta({ prefs: { showHidden: state.showHidden } }); renderAll(); break;
        default: break;
      }
      return;
    }
    const card = e.target.closest('.card');
    if (card) {
      if (state.q) FM.search.history.push(state.q);
      if (card.dataset.lib) { openAlbumIn(card.dataset.lib, card.dataset.id); return; }
      go((state.view === 'downloads' ? '#/downloads/' : '#/album/') + card.dataset.id);
      return;
    }
    const tr = e.target.closest('.track');
    if (tr) {
      if (state.q) FM.search.history.push(state.q);
      if (tr.dataset.lib) { playTrackIn(tr.dataset.lib, tr.dataset.id, true); return; }
      const t = L.track(tr.dataset.id);
      if (!t) return;
      P.playTrack(t);
      /* 手机上点节目（单集）行 = 进这一集的详情页（全屏播放页），跟喜马拉雅一致；
         宽屏保持原来的「点了就播、不打断浏览」。视频集在壳内由原生播放器接管，这里不展开 */
      if (isPhone() && t.kind !== 'video') openSheet();
    }
  }

  function applyPlayingState(root) {
    const cur = P.current;
    U.$$('.track', root || document).forEach(function (row) {
      /* 跨库结果按 id 判断会撞车（同 rel 同 id），那些行的状态一律不标 */
      const on = !row.dataset.lib && cur && row.dataset.id === cur.id;
      row.classList.toggle('playing', !!on);
      row.classList.toggle('paused', !!on && !P.playing);
      const btn = row.querySelector('.tk-play');
      if (btn) {
        btn.innerHTML = icon(on && P.playing ? 'pause' : 'play');
        btn.title = on && P.playing ? '暂停' : '播放这一集';
      }
    });
    U.$$('.card', root || document).forEach(function (card) {
      card.classList.toggle('playing', !!(cur && !card.dataset.lib && cur.albumId === card.dataset.id));
    });
  }

  /* 卡片入场：全站共用一个 observer（以前每次渲染都新建一个、观察一整屏卡片，
     冷启动 trace 里光是 computeIntersections 就跑了 200 多次） */
  let cardIO = null;
  function cardObserver() {
    if (cardIO) return cardIO;
    cardIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); cardIO.unobserve(en.target); }
      });
    }, { root: refs.view, rootMargin: '0px 0px -30px 0px' });
    return cardIO;
  }

  function observeCards(root, instant) {
    const cards = U.$$('.card', root);
    if (!cards.length) return;
    if (instant) {
      /* 静默刷新/追加：直接落在终态，不走交错淡入 */
      cards.forEach(function (c) { c.style.transitionDelay = '0ms'; c.classList.add('in'); });
      return;
    }
    if (!('IntersectionObserver' in window)) { cards.forEach(c => c.classList.add('in')); return; }
    const io = cardObserver();
    io.disconnect();        // 上一屏的卡片已经全部换掉，别让它们继续挂在 observer 上
    cards.forEach(function (c, i) {
      c.style.transitionDelay = Math.min(i, 10) * 22 + 'ms';
      io.observe(c);
    });
  }

  /* ── 菜单 ── */
  function albumMenu(id, anchor) {
    const a = L.album(id);
    if (!a) return;
    /* 编辑资源库（分类、整理、封面）网页端只给管理员；桌面 / 自有服务端没有多用户概念，始终放行 */
    const canAssign = canManageLib();                             // 归类…
    const canModify = canManageLib();                             // 置顶 / 重命名 / 隐藏
    const canEditCover = canManageLib() && (FM.fs.native || FM.fs.server);  // 编辑封面（需要能写 .fm-covers/）
    /* 在专辑详情页点「更多」时，加入队列只排当前页；从卡片菜单进来才整张 */
    const queueTracks = currentQueueTracks(id);
    const items = [
      { label: '播放全部', icon: 'play', onClick: () => P.playAlbum(id) },
      { label: '加入队列（' + queueTracks.length + ' 集）', icon: 'list', onClick: () => { P.addToQueue(queueTracks); toast('已加入播放队列（' + queueTracks.length + ' 集）'); } }
    ];
    if (canDownload()) items.push({ label: '批量下载', icon: 'download', onClick: () => go('#/downloads/' + id + '/more') });
    items.push({ sep: true });
    items.push({ label: a.fav ? '取消收藏' : '收藏专辑', icon: 'heart', onClick: () => toggleFavorite(id) });
    if (canModify) items.push({ label: a.pinned ? '取消置顶' : '置顶专辑', icon: 'up', onClick: () => { L.setMeta(id, { pinned: !a.pinned }); renderAll(); } });
    if (canAssign) items.push({ label: '归类…', icon: 'folder', onClick: () => assignModal(id) });
    if (canModify) items.push({ label: '重命名…', icon: 'edit', onClick: () => renameAlbum(id) });
    if (canEditCover) items.push({ label: '编辑封面…', icon: 'image', onClick: () => coverEditModal(id) });
    items.push({ sep: true });
    if (canModify) items.push({ label: a.hidden ? '取消隐藏' : '隐藏专辑', icon: 'close', danger: !a.hidden, onClick: () => { const next = !a.hidden; L.setMeta(id, { hidden: next }); toast(next ? '已隐藏，可在首页底部找回' : '已取消隐藏'); renderAll(); } });
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

  /* 标记已听 / 未听：本地进度落盘 + 远程上报，列表徽标与专辑已听统计随重绘更新 */
  function toggleListened(t) {
    if (!t) return;
    const p = L.progressOf(t.id);
    const dur = t.duration || (p && p.d) || 0;
    const done = !(p && p.done);
    const rec = { id: t.id, p: done ? dur : 0, d: dur, t: Date.now(), done: done };
    L.setProgress(rec.id, rec.p, rec.d, rec.done);
    if (FM.fs.canSyncMeta()) FM.fs.pushProgress(rec);
    toast(done ? '已标记为已听' : '已标记为未听');
    renderMain();
    if (P.current && P.current.id === t.id) paintTrack(P.current);
  }

  function trackMenu(id, anchor) {
    const t = L.track(id);
    if (!t) return;
    const p = L.progressOf(id);
    const items = [
      { label: '从这集开始播放', icon: 'play', onClick: () => P.playTrack(t) },
      { label: '加入队列', icon: 'list', onClick: () => { P.addToQueue([t]); toast('已加入播放队列'); } },
      { label: t.fav ? '取消收藏这一集' : '收藏这一集', icon: 'heart', onClick: () => toggleTrackFav(id) },
      { sep: true },
      { label: p && p.done ? '标记为未听' : '标记为已听', icon: p && p.done ? 'undo' : 'check-circle', onClick: () => toggleListened(t) }
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
    if (!canManageLib()) { toast('只有管理员可以编辑封面', 'warn'); return; }
    if (!(FM.fs.native || FM.fs.server)) { toast('本地文件夹模式不支持改封面', 'warn'); return; }

    let pending = null;      // { kind:'upload', dataUrl } 或 { kind:'xmly', url, albumId, title }
    let deleteMode = false;
    let delBtn = null, saveBtn = null;
    /* 搜索结果分页：自动获取=第 0 屏；加载更多 page+1；换一换用新 seed 让后端打散同分档 */
    const PAGE_SIZE = 8;
    let page = 0, seed = 0, searching = false, lastKw = '';
    /* 上游每次翻页都会重新抓取，结果会漂移；按 url 去重，避免同一张图重复出现在两屏里 */
    const shownUrls = new Set();

    const preview = U.el('img', { class: 'cover-img', referrerpolicy: 'no-referrer', style: { display: a.cover ? 'block' : 'none' } });
    if (a.cover) preview.src = a.cover;
    const previewBox = U.el('div', { class: 'cover-edit-preview' }, [preview]);
    /* 没搜过之前不占位，免得弹窗一打开就是一块 64px 的空白 */
    const candsBox = U.el('div', { class: 'cover-edit-cands', style: { display: 'none' } });
    const hint = U.el('p', { class: 'cover-edit-hint', text: '点「保存」才会写入资源库的 .fm-covers/，不会自动生效。' });

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
    const shuffleBtn = U.el('button', { class: 'btn btn-ghost', text: '换一换', title: '用同一个关键词重新搜，换一批结果' });
    const moreBtn = U.el('button', { class: 'btn btn-ghost', text: '加载更多' });
    const moreBox = U.el('div', { class: 'cover-edit-more', style: { display: 'none' } }, [shuffleBtn, moreBtn]);

    async function searchCover(opt) {
      if (searching) return;
      const o = opt || {};
      const append = !!o.append;
      /* 加载更多必须沿用上一屏的关键词：用户可能改了输入框但还没点搜索，
         否则会把「新词的第 2 页」拼到「旧词的列表」后面 */
      const kw = (append && lastKw) ? lastKw : ((kwInput.value || '').trim() || a.title);
      lastKw = kw;
      /* 加载更多 → 下一页；其它 → 回到第 0 屏（换一换会带新 seed） */
      if (append) page += 1;
      else { page = 0; seed = o.shuffle ? (Date.now() % 2147483647) : 0; }
      searching = true;
      autoBtn.disabled = true;
      autoBtn.textContent = append ? '加载中…' : '搜索中…';
      shuffleBtn.disabled = true;
      moreBtn.disabled = true;
      let list = [];
      try { list = await FM.covers.search(kw, { page: page, seed: seed, limit: PAGE_SIZE }); } catch (e) {}
      searching = false;
      autoBtn.disabled = false;
      autoBtn.textContent = '自动获取';
      shuffleBtn.disabled = false;
      moreBtn.disabled = false;
      const added = renderCands(list || [], append);
      /* 拿到满满一屏「且真加进去了新图」才算还有下一页，否则按钮会一直点空 */
      const hasMore = !!(list && list.length >= PAGE_SIZE && added > 0);
      moreBtn.textContent = hasMore ? '加载更多' : '没有更多了';
      moreBtn.disabled = !hasMore;
      moreBox.style.display = candsBox.childElementCount ? '' : 'none';
      if (!append && (!list || !list.length)) {
        const why = (FM.covers && FM.covers.searchError) ? '：' + FM.covers.searchError : '';
        toast('没搜到匹配的封面' + why + '。换个关键词再试；若一直空，确认服务端/应用已重启', 'warn');
      }
    }
    autoBtn.addEventListener('click', function () { searchCover(); });
    shuffleBtn.addEventListener('click', function () { searchCover({ shuffle: true }); });
    moreBtn.addEventListener('click', function () { searchCover({ append: true }); });
    kwInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); searchCover(); }
    });

    function renderCands(list, append) {
      if (!append) { candsBox.innerHTML = ''; shownUrls.clear(); }
      let added = 0;
      list.forEach(function (c) {
        if (!c || !c.url || shownUrls.has(c.url)) return;
        shownUrls.add(c.url);
        added++;
        /* 缩略图下面带标题，一眼能看出这张图对应哪张专辑 */
        const cell = U.el('div', { class: 'cover-cand', title: c.title || '' }, [
          U.el('div', { class: 'cover-cand-pic' }, [
            U.el('img', { src: c.url, alt: '', referrerpolicy: 'no-referrer' })
          ]),
          U.el('span', { class: 'cover-cand-src', text: coverSrcLabel(c.source) }),
          U.el('div', { class: 'cover-cand-title', text: c.title || '' })
        ]);
        cell.addEventListener('click', function () {
          pending = { kind: c.source || 'xmly', url: c.url, albumId: c.id, title: c.title, source: c.source || 'xmly' };
          deleteMode = false;
          preview.src = c.url;
          preview.style.display = 'block';
          const prev = candsBox.querySelector('.cover-cand.active');
          if (prev) prev.classList.remove('active');
          cell.classList.add('active');
          updateActions();
        });
        candsBox.appendChild(cell);
      });
      if (candsBox.childElementCount) candsBox.style.display = '';
      return added;
    }

    const body = U.el('div', { class: 'cover-edit' }, [
      U.el('div', { class: 'cover-edit-main' }, [
        previewBox,
        U.el('div', { class: 'cover-edit-side' }, [
          kwInput,
          U.el('div', { class: 'cover-edit-tools' }, [uploadBtn, autoBtn]),
          candsBox
        ])
      ]),
      moreBox,
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
      cls: 'cover-edit-modal',
      body: body,
      actions: [
        {
          label: '删除封面', cls: 'btn-ghost', onClick: function () {
            deleteMode = !deleteMode;
            if (deleteMode) {
              pending = null;
              preview.src = a.cover || '';
              preview.style.display = a.cover ? 'block' : 'none';
              /* 预览已经退回原封面，候选图上的选中框也得去掉，否则看起来像还选了新图 */
              const on = candsBox.querySelector('.cover-cand.active');
              if (on) on.classList.remove('active');
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

  /* ── 专辑管理：批量补封面 ──────────────────────────────────────
   * 只处理「当前资源库里还没有封面」的专辑。一键抓取时：
   *   - 帆书官方 / 喜马拉雅候选相似度 ≥ AUTO_COVER_SCORE：直接写入（几乎同名才敢自动替换）
   *   - 其余：把候选图摆出来，用户点选后点「保存」才批量写入
   * 未选择的专辑一张都不写，这是需求的硬约束。
   * 搜索复用 FM.covers.search（网页端 /api/covers/search、桌面端 IPC），
   * 写入走 FM.covers.saveOne / saveMany —— 后者批量期间只刷新一次索引。 */
  const COVER_SRC_LABEL = { fanshu: '帆书', douban: '豆瓣', xmly: '喜马', geekbang: '极客', baidu: '百度' };
  function coverSrcLabel(src) { return COVER_SRC_LABEL[src] || '喜马'; }

  const AUTO_COVER_SCORE = 0.9;    /* 自动替换阈值：宁缺勿滥，只信几乎完全同名的帆书/喜马拉雅结果 */
  const COVER_WORKERS = 3;         /* 并发数：喜马拉雅对高频请求敏感，3 路够快也不容易被拦 */
  const COVER_PICK_MAX = 6;        /* 每行最多摆几张候选 */
  const COVER_PAGE_SIZE = 20;      /* 每页 20 条；一键抓取只处理当前页，避免一口气打几百个请求 */

  function coverAlbumList() {
    return L.allAlbums({ showHidden: true }).slice();
  }

  function newCoverJob() {
    return {
      libId: FM.fs.activeId || '', rows: [], page: 0,
      running: false, cancel: false, done: 0, total: 0,
      saving: false, saveText: ''
    };
  }

  function coverPageCount(job) {
    return Math.max(1, Math.ceil(job.rows.length / COVER_PAGE_SIZE));
  }

  /* 当前页要渲染 / 要抓取的那 20 条 */
  function pagedRows(job) {
    const start = job.page * COVER_PAGE_SIZE;
    return job.rows.slice(start, start + COVER_PAGE_SIZE);
  }

  function clampCoverPage(job) {
    const max = coverPageCount(job) - 1;
    if (job.page > max) job.page = max;
    if (job.page < 0) job.page = 0;
  }

  /* 把最新专辑清单并进任务：新出现的缺封面专辑补成 pending，
     已经有封面的（包括刚抓完 / 刚保存的）一律移出列表 —— 页面只显示缺封面的专辑 */
  function syncCoverJob(job) {
    const byId = new Map(job.rows.map(function (r) { return [r.albumId, r]; }));
    const next = [];
    coverAlbumList().forEach(function (a) {
      if (a.cover) return;
      const old = byId.get(a.id);
      if (old) {
        old.title = a.title;
        old.dirName = a.dirName || a.key;
        old.hidden = !!a.hidden;
        next.push(old);
      } else {
        next.push({
          albumId: a.id, dirName: a.dirName || a.key, title: a.title, hidden: !!a.hidden,
          status: 'pending', cands: [], picked: -1, score: '', error: '', saved: false
        });
      }
    });
    job.rows = next;
    if (job.done > job.rows.length) job.done = job.rows.length;
    return job;
  }

  function amCounts(job) {
    const c = { auto: 0, pick: 0, none: 0, fail: 0, picked: 0 };
    job.rows.forEach(function (r) {
      if (r.status === 'auto') c.auto++;
      else if (r.status === 'pick') { c.pick++; if (r.picked >= 0) c.picked++; }
      else if (r.status === 'none') c.none++;
      else if (r.status === 'failed') c.fail++;
    });
    return c;
  }

  function coverProgressText(job) {
    if (job.saveText) return job.saveText;
    if (job.running) return '正在抓取 ' + job.done + ' / ' + job.total;
    if (job.done && job.total) return '已处理 ' + job.done + ' / ' + job.total;
    return '尚未开始';
  }

  /* 按钮上的紧凑进度：窄屏按钮宽度有限，用「正在保存 3 / 12」会被挤断 */
  function coverSaveBtnText(job) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(job.saveText || '');
    return m ? '保存中 ' + m[1] + '/' + m[2] : '保存中…';
  }

  function coverBadge(r) {
    if (r.status === 'auto') return '<span class="am-badge ok">已自动替换</span>';
    if (r.status === 'searching') return '<span class="am-badge busy"><i class="am-dot"></i>搜索中…</span>';
    if (r.status === 'pick') return '<span class="am-badge warn">' + (r.picked >= 0 ? '已选择' : '待选择') + '</span>';
    if (r.status === 'failed') return '<span class="am-badge bad">抓取失败</span>';
    if (r.status === 'none') return '<span class="am-badge mute">未找到</span>';
    return '<span class="am-badge mute">待抓取</span>';
  }

  function coverRowSub(r) {
    if (r.status === 'auto' && r.score) return '相似度 ' + r.score + ' · 已写入 .fm-covers/';
    if (r.status === 'none') return '没搜到相似封面，可稍后重试';
    if (r.status === 'failed') return r.error || '抓取失败，可重试';
    if (r.status === 'searching') return '正在搜索候选封面…';
    /* 选了候选但写入失败：状态仍是「待选择」，原因得在这里说出来 */
    if (r.pickError) return r.pickError;
    return (r.dirName || '') + (r.hidden ? ' · 已隐藏' : '');
  }

  function coverRowHtml(r) {
    const a = L.album(r.albumId);
    /* 预览优先：点了候选就先把行缩略图换成那张，用户能立刻确认选的是哪张；
       没选或取消时 preview 为空，再回退到已有封面 / 占位 */
    const url = r.preview || (a && a.cover) || '';
    const thumb = url
      ? '<div class="am-thumb"><img src="' + esc(url) + '" alt="" referrerpolicy="no-referrer" loading="lazy"></div>'
      : '<div class="am-thumb is-empty">' + icon('image') + '</div>';
    let extra = '';
    if (r.status === 'searching') {
      extra = '<div class="am-cands">' + '<i class="am-sk"></i><i class="am-sk"></i><i class="am-sk"></i>' + '</div>';
    } else if (r.status === 'pick' && r.cands.length) {
      extra = '<div class="am-cands">' + r.cands.map(function (c, i) {
        const src = coverSrcLabel(c.source);
        /* 卡片本身点一下是选中；右下角的放大镜单独打开大图，用来确认这张到底合不合适 */
        return '<div class="am-cand' + (r.picked === i ? ' on' : '') + '"' +
          ' data-act="cover-pick" data-id="' + esc(r.albumId) + '" data-c="' + i + '"' +
          ' role="button" tabindex="0" title="' + esc(c.title || '') + '">' +
          '<span class="am-cand-pic">' +
            '<img src="' + esc(c.url) + '" alt="" referrerpolicy="no-referrer" loading="lazy"><em>' + src + '</em>' +
            '<button class="am-cand-zoom" data-act="cover-zoom" data-id="' + esc(r.albumId) +
              '" data-c="' + i + '" title="放大查看" aria-label="放大查看">' + icon('search') + '</button>' +
          '</span>' +
          (c.score ? '<span class="am-cand-score">' + Number(c.score).toFixed(2) + '</span>' : '') +
          '</div>';
      }).join('') + '</div>';
    }
    /* 副标题会省略：失败原因（例如 EACCES 的完整说明）挂到 title 上，悬停能看全 */
    const sub = coverRowSub(r);
    return '<div class="am-row" data-row="' + esc(r.albumId) + '" data-status="' + r.status + '">' +
      thumb +
      '<div class="am-info"><b>' + esc(r.title) + '</b><span title="' + esc(sub) + '">' + esc(sub) + '</span></div>' +
      coverBadge(r) + extra + '</div>';
  }

  function paintCoverRow(row) {
    const page = refs.view.querySelector('.am-page');
    if (!page) return;
    const el = page.querySelector('[data-row="' + row.albumId + '"]');
    if (!el) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = coverRowHtml(row);
    el.replaceWith(tmp.firstElementChild);
  }

  function paintCoverStat() {
    const job = coverJob;
    if (!job) return;
    const page = refs.view.querySelector('.am-page');
    if (!page) return;
    const c = amCounts(job);
    const set = function (k, v) {
      const el = page.querySelector('[data-am="' + k + '"]');
      if (el) el.textContent = String(v);
    };
    set('auto', c.auto); set('pick', c.pick); set('none', c.none); set('fail', c.fail); set('picked', c.picked);
    const total = job.total || 1;
    const fill = page.querySelector('[data-am="fill"]');
    if (fill) fill.style.width = Math.round(Math.min(1, job.done / total) * 100) + '%';
    const txt = page.querySelector('[data-am="text"]');
    if (txt) txt.textContent = coverProgressText(job);
    const saveBtn = page.querySelector('[data-act="cover-save"]');
    if (saveBtn) {
      saveBtn.disabled = !c.picked || job.running || job.saving;
      /* 保存中锁住按钮并显示进度：写入是逐张进行的，连点会重复提交同一批 */
      saveBtn.classList.toggle('is-busy', job.saving);
      saveBtn.textContent = job.saving
        ? coverSaveBtnText(job)
        : '保存 ' + c.picked + ' 张封面';
    }
    const clearBtn = page.querySelector('[data-act="cover-clear"]');
    if (clearBtn) clearBtn.disabled = !c.picked || job.saving;
  }

  async function fetchCoverForRow(job, row) {
    if (job.cancel) return;
    const a = L.album(row.albumId);
    if (!a) { row.status = 'failed'; row.error = '专辑已不在资源库里'; paintCoverRow(row); return; }
    row.status = 'searching';
    paintCoverRow(row);
    let list = [];
    try { list = await FM.covers.search(a.title || row.title, { limit: COVER_PICK_MAX, page: 0 }); } catch (e) { list = []; }
    if (job.cancel) { row.status = 'pending'; paintCoverRow(row); return; }
    const cands = (list || []).filter(function (c) { return c && c.url; });
    /* 只有帆书官方和喜马拉雅才允许自动写入：极客/豆瓣/百度是按词搜出来的图，标题对不上也不能信 */
    const autoSrc = { fanshu: 1, xmly: 1 };
    const best = cands.filter(function (c) {
      return autoSrc[c.source] && Number(c.score) >= AUTO_COVER_SCORE;
    }).sort(function (x, y) {
      /* 同分时官方优先：樊登/帆书库要的就是官方那张 */
      return (y.source === 'fanshu' ? 1 : 0) - (x.source === 'fanshu' ? 1 : 0)
        || (Number(y.score) || 0) - (Number(x.score) || 0);
    })[0];
    if (best) {
      const res = await FM.covers.saveOne(a, {
        kind: best.source, url: best.url, albumId: best.id, title: best.title, source: best.source
      });
      if (res.ok) {
        row.status = 'auto';
        row.saved = true;
        row.score = Number(best.score).toFixed(2);
        row.preview = best.url;
      } else {
        row.status = 'failed';
        row.error = res.reason || '写入失败';
      }
    } else if (cands.length) {
      row.status = 'pick';
      row.cands = cands.slice(0, COVER_PICK_MAX);
      row.picked = -1;
    } else if (FM.covers.searchError) {
      row.status = 'failed';
      row.error = FM.covers.searchError;
    } else {
      row.status = 'none';
    }
    job.done++;
    paintCoverRow(row);
    paintCoverStat();
  }

  async function runCoverWorkers(job, todo) {
    let cursor = 0;
    async function worker() {
      for (;;) {
        if (job.cancel) return;
        const row = todo[cursor++];
        if (!row) return;
        await fetchCoverForRow(job, row);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(COVER_WORKERS, todo.length); i++) workers.push(worker());
    await Promise.all(workers);
    job.running = false;
    if (job.cancel) return;
    /* 抓取期间自动写入的那批，到这里一次性重读索引（省掉几十次 load） */
    try { await FM.covers.reload(); } catch (e) {}
    renderAll({ quiet: true });
    const c = amCounts(job);
    toast('抓取完成：自动替换 ' + c.auto + ' 张，待选 ' + c.pick + ' 张' +
      (c.none ? '，未找到 ' + c.none + ' 张' : '') + (c.fail ? '，失败 ' + c.fail + ' 张' : ''));
  }

  function startCoverFetch() {
    const job = coverJob;
    if (!job || job.running || job.saving) return;
    /* 只抓当前页：几百张一起打会把喜马拉雅惹毛，用户也等不起 */
    const todo = pagedRows(job).filter(function (r) { return r.status === 'pending' || r.status === 'failed'; });
    if (!todo.length) { toast('本页没有待抓取的专辑'); return; }
    job.running = true;
    job.cancel = false;
    job.done = 0;
    job.total = todo.length;
    job.saveText = '';
    todo.forEach(function (r) { r.status = 'pending'; r.error = ''; r.cands = []; r.picked = -1; r.preview = ''; });
    renderMain({ quiet: true });
    runCoverWorkers(job, todo).catch(function (e) {
      console.warn('[cover] 批量抓取中断', e);
      const j = coverJob;
      if (!j) return;
      j.running = false;
      j.rows.forEach(function (r) { if (r.status === 'searching') r.status = 'pending'; });
      renderAll({ quiet: true });
      toast('抓取中断，可再点一次重试', 'warn');
    });
  }

  function setCoverPage(p) {
    const job = coverJob;
    if (!job || job.running || job.saving) return;
    const max = coverPageCount(job) - 1;
    const next = Math.min(Math.max(0, Number(p) || 0), max);
    if (next === job.page) return;
    job.page = next;
    /* 每页的抓取是独立批次：翻页后进度从「尚未开始」重新计 */
    job.done = 0;
    job.total = 0;
    job.saveText = '';
    renderMain({ quiet: true });
  }

  function stopCoverFetch() {
    const job = coverJob;
    if (!job || !job.running) return;
    job.cancel = true;
    job.running = false;
    /* 正在搜的那几行不会再回来（worker 看到 cancel 就退出），复位成待抓取，下次能接着跑 */
    job.rows.forEach(function (r) { if (r.status === 'searching') r.status = 'pending'; });
    renderMain({ quiet: true });
    toast('已停止抓取，已自动替换的封面已写入');
  }

  function pickCoverCand(albumId, idx) {
    const job = coverJob;
    if (!job || job.saving) return;
    const row = job.rows.find(function (r) { return r.albumId === albumId; });
    if (!row || row.saved || row.status !== 'pick' || !row.cands[idx]) return;
    row.picked = row.picked === idx ? -1 : idx;
    row.pickError = '';        /* 重选后旧的失败原因就过期了 */
    /* 同步行缩略图：选中就预览这张，取消就退回占位/原封面 */
    row.preview = row.picked >= 0 ? (row.cands[row.picked].url || '') : '';
    paintCoverRow(row);
    paintCoverStat();
  }

  function clearCoverPicks() {
    const job = coverJob;
    if (!job) return;
    job.rows.forEach(function (r) {
      if (r.saved) return;
      r.picked = -1;
      r.preview = '';
    });
    renderMain({ quiet: true });
  }

  /* ── 候选图放大：72px 缩略图看不出画质和字，点右下角放大镜看 600×600 原图 ──
     挂到 body 上（不在 #view 里），所以换页时必须显式关掉，否则会留在屏幕上。
     ← → 换同一行的下一张，Esc / 点空白处关闭。 */
  let coverViewerEl = null;
  let coverViewerKey = null;

  function closeCoverViewer() {
    if (coverViewerKey) { document.removeEventListener('keydown', coverViewerKey); coverViewerKey = null; }
    if (coverViewerEl) { coverViewerEl.remove(); coverViewerEl = null; }
  }

  function openCoverViewer(albumId, idx) {
    const job = coverJob;
    const row = job && job.rows.find(function (r) { return r.albumId === albumId; });
    if (!row || !row.cands || !row.cands.length) return;
    closeCoverViewer();
    const cands = row.cands;
    let cur = Math.max(0, Math.min(cands.length - 1, Number(idx) || 0));

    const mask = U.el('div', { class: 'cv-mask' });
    mask.innerHTML =
      '<div class="cv-box">' +
        '<button class="cv-x" data-cv="close" aria-label="关闭">' + icon('close') + '</button>' +
        '<img class="cv-img" alt="" referrerpolicy="no-referrer">' +
        '<div class="cv-foot">' +
          '<span class="cv-title"></span><span class="cv-src"></span><span class="cv-spare"></span>' +
          '<button class="btn btn-ghost" data-cv="prev">上一张</button>' +
          '<button class="btn btn-ghost" data-cv="next">下一张</button>' +
          '<button class="btn btn-primary" data-cv="close">关闭</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);
    coverViewerEl = mask;

    const img = mask.querySelector('.cv-img');
    const titleEl = mask.querySelector('.cv-title');
    const srcEl = mask.querySelector('.cv-src');
    const prevBtn = mask.querySelector('[data-cv="prev"]');
    const nextBtn = mask.querySelector('[data-cv="next"]');

    function paint() {
      const c = cands[cur] || {};
      img.src = c.url || '';
      titleEl.textContent = c.title || row.title || '';
      srcEl.textContent = coverSrcLabel(c.source) +
        (c.score ? ' · ' + Number(c.score).toFixed(2) : '');
      prevBtn.disabled = cur <= 0;
      nextBtn.disabled = cur >= cands.length - 1;
      mask.querySelector('.cv-box').classList.toggle('single', cands.length <= 1);
    }
    paint();

    mask.addEventListener('click', function (e) {
      const hit = e.target.closest('[data-cv]');
      if (hit) {
        const act = hit.dataset.cv;
        if (act === 'prev' && cur > 0) { cur--; paint(); }
        else if (act === 'next' && cur < cands.length - 1) { cur++; paint(); }
        else if (act === 'close') closeCoverViewer();
        return;
      }
      if (e.target === mask) closeCoverViewer();
    });

    coverViewerKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeCoverViewer(); }
      else if (e.key === 'ArrowLeft' && cur > 0) { e.preventDefault(); cur--; paint(); }
      else if (e.key === 'ArrowRight' && cur < cands.length - 1) { e.preventDefault(); cur++; paint(); }
    };
    document.addEventListener('keydown', coverViewerKey);
  }

  async function saveCoverPicks() {
    const job = coverJob;
    /* saving：上一次点下的写入还没结束，再点一次就是重复提交同一批 */
    if (!job || job.running || job.saving) return;
    const picked = job.rows.filter(function (r) {
      return r.status === 'pick' && r.picked >= 0 && r.cands[r.picked] && !r.saved;
    });
    if (!picked.length) { toast('先点选要用的候选封面', 'warn'); return; }
    const items = [];
    picked.forEach(function (r) {
      const a = L.album(r.albumId);
      if (!a) return;
      const c = r.cands[r.picked];
      items.push({
        row: r, album: a,
        payload: { kind: c.source || 'xmly', url: c.url, albumId: c.id, title: c.title, source: c.source || 'xmly' }
      });
    });
    if (!items.length) { toast('这些专辑已不在资源库里了', 'warn'); return; }
    job.saving = true;
    job.saveText = '正在保存 0 / ' + items.length;
    renderMain({ quiet: true });
    let res = null;
    try {
      res = await FM.covers.saveMany(items, function (ok, fail, i, total) {
        if (!coverJob) return;
        coverJob.saveText = '正在保存 ' + i + ' / ' + total;
        paintCoverStat();
      });
    } catch (e) {
      console.warn('[cover] 批量保存中断', e);
      toast('保存中断：' + ((e && e.message) || '未知原因'), 'warn');
    } finally {
      /* 成功失败都要解锁，否则按钮会一直停在「正在保存…」 */
      if (coverJob) { coverJob.saving = false; coverJob.saveText = ''; }
    }
    if (!res) { renderMain({ quiet: true }); return; }
    const failed = res.failed || [];
    const failReason = new Map(failed.map(function (f) { return [f.album && f.album.id, f.reason || '']; }));
    items.forEach(function (it) {
      if (failReason.has(it.album.id)) {
        /* 原因留在行副标题里：只写「保存失败」等于没说，权限问题得让用户看到路径和 EACCES */
        it.row.pickError = '保存失败：' + (failReason.get(it.album.id) || '未知原因');
        return;
      }
      it.row.status = 'auto';
      it.row.picked = -1;
      it.row.pickError = '';
    });
    renderAll({ quiet: true });
    const failN = failed.length;
    const why = failN ? String(failed[0].reason || '') : '';
    toast(failN
      ? ('已保存 ' + res.ok + ' 张，' + failN + ' 张失败' + (why ? '：' + (why.length > 60 ? why.slice(0, 60) + '…' : why) : ''))
      : ('已保存 ' + res.ok + ' 张封面'),
      failN ? 'warn' : undefined);
  }

  function viewAlbumManage() {
    const wrap = U.el('div', { class: 'am-page' });

    if (!canManageLib()) {
      wrap.innerHTML = '<div class="am-head"><h1 class="am-title">专辑管理</h1></div>' +
        '<div class="am-empty">' + icon('eye-off') + '<h3>只有管理员可以管理封面</h3>' +
        '<p>当前账号是只读的，补封面请让管理员在主机上操作。</p>' +
        '<button class="btn btn-primary" data-act="back">返回</button></div>';
      return wrap;
    }
    if (!(FM.fs.native || FM.fs.server)) {
      wrap.innerHTML = '<div class="am-head"><h1 class="am-title">专辑管理</h1></div>' +
        '<div class="am-empty">' + icon('image') + '<h3>当前模式不支持写入封面</h3>' +
        '<p>纯浏览器打开本地目录时没有写盘权限，请在桌面端或连到服务端后使用。</p></div>';
      return wrap;
    }

    if (!coverJob || coverJob.libId !== (FM.fs.activeId || '')) {
      coverJob = newCoverJob();
      amListScroll = 0;
      amScrollPage = -1;
    }
    /* 上一次被中断（切页 / 停止）时可能有行停在「搜索中」，这里复位，否则它会一直转圈 */
    if (!coverJob.running) {
      coverJob.rows.forEach(function (r) { if (r.status === 'searching') r.status = 'pending'; });
      syncCoverJob(coverJob);      /* 已经补上封面的专辑在这里移出列表 */
      clampCoverPage(coverJob);    /* 行数变少后页码可能越界 */
    }
    const job = coverJob;
    /* 换页 / 换库时就地取消；同一个库重绘（保存后刷新）要继续跑。
       顺手把 running 和「搜索中」行复位：worker 要等当前这张搜完才退出，
       不先复位的话切回来会看到按钮还写着「停止」、行一直转圈 */
    albumViewTeardown = function () {
      /* 记下列表内部滚动位置：保存 / 停止后重绘时还原，别让用户重新找刚才那一行 */
      const sc = refs.view.querySelector('.am-list');
      if (sc) amListScroll = sc.scrollTop;
      if (!coverJob) return;
      if (state.view !== 'albumManage' || coverJob.libId !== (FM.fs.activeId || '')) {
        coverJob.cancel = true;
        coverJob.running = false;
        coverJob.rows.forEach(function (r) { if (r.status === 'searching') r.status = 'pending'; });
      }
    };

    const c = amCounts(job);
    const pageRows = pagedRows(job);
    const pages = coverPageCount(job);
    /* 本页没有待抓取的行（都已出候选/未找到）就把主按钮置灰，免得点了只弹一句「本页没有待抓取」 */
    const todoN = pageRows.filter(function (r) {
      return r.status === 'pending' || r.status === 'failed';
    }).length;
    const pager = pages > 1
      ? '<span class="am-pager">' +
          '<button class="am-pager-btn prev" data-act="cover-page" data-p="' + (job.page - 1) + '"' +
            ((job.page <= 0 || job.running || job.saving) ? ' disabled' : '') + ' aria-label="上一页">' + icon('chevron') + '</button>' +
          '<b>' + (job.page + 1) + '</b><i>/</i>' + pages +
          '<button class="am-pager-btn" data-act="cover-page" data-p="' + (job.page + 1) + '"' +
            ((job.page >= pages - 1 || job.running || job.saving) ? ' disabled' : '') + ' aria-label="下一页">' + icon('chevron') + '</button>' +
        '</span>'
      : '';
    const head =
      '<div class="am-head">' +
        '<div class="am-head-txt">' +
          '<h1 class="am-title">专辑管理</h1>' +
          '<p class="am-desc">这里只列还没有封面的专辑，每页 ' + COVER_PAGE_SIZE +
            ' 条。一键抓取只处理当前页：帆书官方/喜马拉雅相似度 ≥ ' + AUTO_COVER_SCORE +
            ' 的自动写入，其余挑一张再保存，未选中的不会写入。</p>' +
        '</div>' +
        '<button class="btn ' + (job.running ? 'btn-ghost am-stop' : 'btn-primary') + '"' +
          ' data-act="' + (job.running ? 'cover-stop' : 'cover-fetch') + '"' +
          ((todoN || job.running) ? '' : ' disabled') + '>' +
          icon(job.running ? 'close' : 'wand') + (job.running ? '停止' : '一键抓取本页') + '</button>' +
      '</div>';

    if (!job.rows.length) {
      wrap.innerHTML = head + '<div class="am-empty">' + icon('check') + '<h3>所有专辑都有封面了</h3>' +
        '<p>新专辑加进资源库后，这里会自动出现待补清单。</p></div>';
      return wrap;
    }

    const stat =
      '<div class="am-stat">' +
        '<div class="am-nums">' +
          '<span><b data-am="total">' + job.rows.length + '</b> 张缺封面</span>' +
          '<span class="ok">已替换 <b data-am="auto">' + c.auto + '</b></span>' +
          '<span class="warn">待选 <b data-am="pick">' + c.pick + '</b></span>' +
          '<span class="mute">未找到 <b data-am="none">' + c.none + '</b></span>' +
          (c.fail ? '<span class="bad">失败 <b data-am="fail">' + c.fail + '</b></span>' : '') +
          pager +
        '</div>' +
        '<div class="am-track"><i data-am="fill" style="width:' +
          Math.round(Math.min(1, job.done / (job.total || 1)) * 100) + '%"></i></div>' +
        '<div class="am-prog" data-am="text">' + esc(coverProgressText(job)) + '</div>' +
      '</div>';

    const bar =
      '<div class="am-bar">' +
        '<span class="am-picked">已选 <b data-am="picked">' + c.picked + '</b> 张</span>' +
        '<button class="btn btn-ghost" data-act="cover-clear"' + (c.picked ? '' : ' disabled') + '>清空选择</button>' +
        '<span class="am-note">未选择的专辑不会写入</span>' +
        '<button class="btn btn-primary' + (job.saving ? ' is-busy' : '') + '" data-act="cover-save"' +
          ((c.picked && !job.running && !job.saving) ? '' : ' disabled') + '>' +
          (job.saving ? esc(coverSaveBtnText(job)) : '保存 ' + c.picked + ' 张封面') + '</button>' +
      '</div>';

    wrap.innerHTML = head + stat + '<div class="am-list">' + pageRows.map(coverRowHtml).join('') + '</div>' + bar;
    const listEl = wrap.querySelector('.am-list');
    if (listEl) {
      /* 翻页时回到顶部；同一页重绘（保存 / 停止）才还原滚动位置 */
      if (amScrollPage !== job.page) { amListScroll = 0; amScrollPage = job.page; }
      if (amListScroll) listEl.scrollTop = amListScroll;
    }
    return wrap;
  }

  function renameAlbum(id) {
    const a = L.album(id);
    if (!a) return;
    if (!canManageLib()) { toast('只有管理员可以重命名专辑', 'warn'); return; }
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
    if (!canManageLib()) { toast('只有管理员可以归类', 'warn'); return; }
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
    if (!canManageLib()) { toast('只有管理员可以归类', 'warn'); return; }
    if (a.cats.indexOf(catId) >= 0) { toast('该专辑已在此分类中'); return; }
    L.setMeta(albumId, { cats: a.cats.concat([catId]) });
    const cat = L.cats().find(c => c.id === catId);
    toast('已归入「' + (cat ? cat.name : '分类') + '」');
    renderCats(); renderNav(); renderMain();
  }

  function editCat(catId) {
    if (!canManageLib()) { toast('只有管理员可以管理分类', 'warn'); return; }
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
            m.close();
            /* 正在看这个分类：删掉后它已不存在，回到「全部」，别停在「分类不存在」页 */
            if (state.view === 'cat' && state.cat === catId) {
              state.cat = null;
              go('#/');
            } else {
              renderAll();
            }
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
      /* 无封面的黑胶只画盘面，盘心不写首字 */
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
    /* 竖屏锁只跟「播放页开着 + 当前是音频」有关：切到视频就放开，视频由原生播放器管横竖 */
    if (FM.android && FM.android.lockPortrait) {
      FM.android.lockPortrait(!isVideo && refs.sheet.classList.contains('open'));
    }
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

  /* 播放条显隐统一入口：body 挂 has-player，批量页据此让出/收回底部空间 */
  function setPlayerbarVisible(on) {
    refs.playerbar.hidden = !on;
    document.body.classList.toggle('has-player', !!on);
  }

  /* 把这个库「上次听到的那一集」放回底栏（不自动播放）。
     启动和切换资源库两条路都走它：切库时 P.stop() 会清空当前曲目，
     以前切回来就再也不恢复，底栏一直是空的，看着像播放器丢了。
     幂等：已有当前曲目（用户正在听 / 刚点了播放）就不覆盖。 */
  function restorePlayerBar() {
    if (P.current) {
      /* 底栏已经有这一集了（启动时按本机缓存先恢复的那次）：服务端按用户下发的进度
         可能刚到，这里补画一次。只补「还没挂媒体」的情况，正在放的不动，
         免得把实时位置改回去 */
      if (!P.loaded) refreshBarTime();
      return false;
    }
    try {
      /* 不要再手动 paintTrack：restoreLast 会 emit 'track'，界面自己画；
         多补一次反而把底栏里刚恢复出来的进度（paintTime 0）又抹成 0:00 */
      if (P.restoreLast()) return true;
    } catch (e) { console.warn('[ui] 恢复上次播放失败', e); }
    return false;
  }

  /* 只刷「心」相关的节点：播放条/全屏页的收藏键、专辑的「已收藏」tag、底部专辑卡的心。
     切收藏绝不能走整个 paintTrack —— 那里会重画封面/标题/进度整块，看着像被刷了一遍。 */
  function paintFavState(t) {
    if (!t) return;
    /* 收藏态以库里那份为准：播放队列可能还攥着重新扫描前的旧对象，只读 t.fav 会点了不刷新 */
    const fresh = L.track(t.id) || t;
    if (fresh !== t) t.fav = fresh.fav;
    const fav = !!fresh.fav;
    refs.pbFav.classList.toggle('on', fav);
    refs.pbFav.innerHTML = icon(fav ? 'heart-fill' : 'heart');
    refs.shFav.classList.toggle('on', fav);
    refs.shFav.innerHTML = icon(fav ? 'heart-fill' : 'heart') + '<span>' + (fav ? '已收藏' : '收藏') + '</span>';
    if (refs.shmFav) {
      refs.shmFav.classList.toggle('on', fav);
      refs.shmFav.innerHTML = icon(fav ? 'heart-fill' : 'heart');
    }
    const a = L.album(t.albumId);
    const albumFav = !!(a && a.fav);
    if (refs.shFavTag) refs.shFavTag.hidden = !albumFav;
    if (refs.shAlbumFav) {
      refs.shAlbumFav.classList.toggle('on', albumFav);
      refs.shAlbumFav.innerHTML = icon(albumFav ? 'heart-fill' : 'heart');
      refs.shAlbumFav.title = albumFav ? '已收藏，点击取消' : '收藏专辑';
    }
  }

  /* 底栏 / 详情页 / 视频页的时间：媒体真挂上了用实时位置（音频、网页视频、壳内视频
     都由播放内核回答），否则用上次听到的位置。以前进度被无脑刷成 0:00，
     启动后的任何一次重绘（补封面、换封面、重扫）都会把恢复出来的位置抹掉 */
  function paintTrackTime(t) {
    const p = L.progressOf(t.id);
    if (p && p.d && !t.duration) { t.duration = p.d; }
    const dur = t.duration || (p && p.d) || 0;
    let pos = 0;
    if (P.loaded && P.current && P.current.id === t.id) {
      pos = (P.media && P.media.currentTime) || 0;
    } else if (p && p.p > 0) {
      /* done 只是「已听完」的统计标记，不代表位置要归零：listen() 恢复播放位置时
         也不看它（见 player.load），这里跟着显示才对得上，否则点播放从中间续、
         底栏却写着 0:00 */
      pos = dur > 0 ? Math.min(p.p, dur) : p.p;
    }
    paintTime(pos, dur);
    return dur;
  }

  /* 只把「进度」这一块重画一次（不碰封面/标题/播放态，不会闪）。
     进度是异步到货的：本地缓存、服务端快照、原生播放器回传都可能晚于首帧，
     谁把它们写进 db 谁就喊一嗓子，别让底栏一直停在 0:00 */
  function refreshBarTime() {
    if (!P.current) return;
    paintTrackTime(P.current);
  }

  /* 底栏这一集没有时长时补探一次（同一集只试一次，探不到记 __noDur）。
     复用列表那套 readDuration，不新建常驻媒体元素 */
  let barProbeId = '';
  async function probeBarDuration(t) {
    if (!t || t.duration || t.__noDur || barProbeId === t.id || !FM.fs.hasSource) return;
    /* 网盘库不为底栏时长单独换一次直链：播放时拿到 metadata 会写回时长 */
    if (FM.fs.isAlist) return;
    barProbeId = t.id;
    try {
      let dur = 0;
      if (FM.media.needsTranscode(t.ext) || FM.media.unsupported(t.ext)) {
        dur = await FM.fs.duration(t.rel);
      } else {
        const s = await FM.fs.src(t.rel);
        dur = await readDuration(s.url, t.kind === 'video');
        if (s.revoke) s.revoke();
      }
      if (!(dur > 0)) { t.__noDur = true; return; }
      L.setDuration(t.id, dur);
      t.duration = dur;
      /* 期间的进度/位置可能变了：按当前状态重画一次（正在放的不碰） */
      if (!P.loaded && P.current && P.current.id === t.id) paintTrackTime(t);
    } catch (e) {
      t.__noDur = true;
    }
  }

  function paintTrack(t) {
    if (!t) return;
    const a = L.album(t.albumId);
    setPlayerbarVisible(true);
    refs.pbTitle.textContent = t.title;
    refs.pbSub.textContent = (a ? a.title : '') + (a ? ' · 第 ' + (t.order + 1) + ' 集' : '');
    paintCover(refs.pbCover, a, t);
    paintCover(refs.sheetCover, a, t);
    paintSheetArt(a);
    refs.shTitle.textContent = t.title;
    const shSub = (a ? a.title : '') + ' · ' + (t.ext || '').toUpperCase();
    if (refs.shSubText) refs.shSubText.textContent = shSub;
    else refs.shSub.textContent = shSub;
    refs.vTitle.textContent = t.title;
    refs.vSub.textContent = videoSub(a, t);
    if (refs.pbKind) refs.pbKind.hidden = P.kind !== 'video';
    /* 收藏态（单集心 + 专辑「已收藏」tag + 卡片上的心） */
    paintFavState(t);
    paintAlbumCard(a, t, !!(a && a.fav));
    if (refs.shmDownload) refs.shmDownload.hidden = !canDownload();
    const dur = paintTrackTime(t);
    /* 这一集从来没有时长（没播过、列表页也没探过）：单独补探一次，
       否则底栏总时长会一直停在 0:00 */
    if (!(dur > 0)) probeBarDuration(t);
    applyPlayingState();
    renderNav();
  }

  /* 专辑卡第三行：分类 + 集数，两枚小胶囊（没归过类就用目录名解析出的标签兜底） */
  function albumCardMeta(a) {
    const cats = L.cats().filter(function (c) { return (a.cats || []).indexOf(c.id) >= 0; })
      .map(function (c) { return c.name; });
    const tags = (a.tags && a.tags.length) ? a.tags : [];
    const kind = cats.length ? cats.join(' / ') : (tags.length ? tags.join(' / ') : albumType(a));
    const count = a.count ? (a.videoCount === a.count ? a.count + ' 视频' : a.count + ' 集') : '';
    const pills = [];
    if (kind) pills.push('<span class="ac-pill">' + esc(kind) + '</span>');
    if (count) pills.push('<span class="ac-pill">' + esc(count) + '</span>');
    return { html: pills.join(''), text: [kind, count].filter(Boolean).join(' · ') };
  }

  /* 移动端底部专辑卡：封面 + 专辑名（最多两行）+ 分类/集数胶囊 + 专辑收藏态，整卡可点进详情 */
  function paintAlbumCard(a, t, fav) {
    const card = refs.shAlbumCard;
    if (!card) return;
    card.hidden = !a;
    if (!a) return;
    paintCover(refs.shAlbumCover, a, t);
    refs.shAlbumTitle.textContent = a.title || '';
    refs.shAlbumTitle.title = a.title || '';
    const meta = albumCardMeta(a);
    refs.shAlbumSub.innerHTML = meta.html;
    refs.shAlbumSub.title = meta.text;
    if (refs.shAlbumFav) {
      refs.shAlbumFav.classList.toggle('on', !!fav);
      refs.shAlbumFav.innerHTML = icon(fav ? 'heart-fill' : 'heart');
      refs.shAlbumFav.title = fav ? '已收藏，点击取消' : '收藏专辑';
    }
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
    /* 手机端播放条第二行：当前/总时长 */
    refs.pbTime.textContent = fmtT(cur) + '/' + fmtT(dur);
    refs.shCur.textContent = fmtT(cur);
    refs.shDur.textContent = fmtT(dur);
    refs.vCur.textContent = fmtT(cur);
    refs.vDur.textContent = fmtT(dur);
    const pct = dur > 0 ? (cur / dur * 100) : 0;
    refs.pbScrub.style.setProperty('--p', pct + '%');
    refs.pbProgress.style.setProperty('--p', pct + '%');
    refs.shScrub.style.setProperty('--p', pct + '%');
    refs.vScrub.style.setProperty('--p', pct + '%');
    paintBuffer();
  }

  /* 取直链 / 等首包时的加载过渡：250ms 后才亮，快速加载不闪一下。
     这段等待在网盘库最明显（换链 + 302 + CDN 首包），之前界面完全没有反馈。 */
  let loadTimer = 0;
  function paintLoading(on) {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = 0; }
    if (on) {
      loadTimer = setTimeout(function () {
        loadTimer = 0;
        refs.sheet.classList.add('is-loading');
        refs.btnPlay.classList.add('is-loading');
        refs.shPlay.classList.add('is-loading');
        refs.vPlay.classList.add('is-loading');
        refs.vBigPlay.classList.add('is-loading');
        if (P.kind === 'video') refs.vLoading.hidden = false;
      }, 250);
      return;
    }
    refs.sheet.classList.remove('is-loading');
    refs.btnPlay.classList.remove('is-loading');
    refs.shPlay.classList.remove('is-loading');
    refs.vPlay.classList.remove('is-loading');
    refs.vBigPlay.classList.remove('is-loading');
    /* 不判 kind：切集瞬间 P.kind 可能还是旧值，残留的转圈层会盖在新画面上 */
    refs.vLoading.hidden = !!P.playing || !P.media.src;
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
    const txt = (Math.round(r * 100) / 100) + 'x';
    refs.btnRate.textContent = txt;
    refs.vRate.textContent = txt;
    const b = refs.shRate.querySelector('b');
    if (b) b.textContent = txt;
    if (refs.shmRate) {
      refs.shmRate.textContent = txt;
      refs.shmRate.classList.toggle('on', r !== 1);
    }
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
    if (refs.shmLoop) {
      refs.shmLoop.innerHTML = icon(P.loopIcon);
      refs.shmLoop.classList.toggle('on', l !== 'all');
      refs.shmLoop.title = '播放模式：' + P.loopLabel;
    }
  }

  function paintSleep(left, mode) {
    const label = refs.shSleep.querySelector('span');
    const mBtn = refs.shmSleep;
    if (!mode) {
      refs.shSleep.classList.remove('on');
      if (label) label.textContent = '定时关闭';
      if (mBtn) { mBtn.classList.remove('on'); mBtn.title = '定时关闭'; }
      return;
    }
    refs.shSleep.classList.add('on');
    const min = Math.max(1, Math.ceil((left || 0) / 60000));
    const txt = mode === 'chapter' ? '本集播完暂停' : min + ' 分钟后关闭';
    if (mBtn) { mBtn.classList.add('on'); mBtn.title = txt; }
    if (label) label.textContent = txt;
  }

  function bindPlayer() {
    P.on('track', function (t, opt) {
      paintTrack(t);
      syncAlbumPlayBtn();
      syncLocateFab();
      /* 用户主动点开视频集才展开播放页；启动恢复上次进度不弹。
         视频直接看画面：不自动弹选集列表，若之前开着（从音频队列过来）则关掉。 */
      if (t.kind === 'video' && !(opt && opt.restored)) {
        if (FM.android) return;   /* 壳内视频交给原生播放器，不展开网页播放页 */
        openSheet();
        if (queueOpen) toggleQueue();
      }
    });
    P.on('kind', applyKind);
    P.on('state', function (playing) { paintState(playing); syncAlbumPlayBtn(); syncLocateFab(); });
    P.on('time', paintTime);
    P.on('rate', paintRate);
    P.on('volume', paintVolume);
    P.on('loop', paintLoop);
    P.on('sleep', paintSleep);
    /* 取直链 / 等首包的过渡：按钮转圈 + 封面呼吸，避免「点了没反应」 */
    P.on('loading', paintLoading);
    /* flv 首次播放要先重封装：盖一层过渡层，转完自动收 */
    P.on('preparing', function (track) { if (track) showTc(track.title); else hideTc(); });
    P.on('tcProgress', function (info) { if (info && info.pct) setTcPct(info.pct); });
    /* 只有确实断网才用统一网络文案；本地文件损坏/编码问题不要误报成断网 */
    P.on('error', function (e) {
      const m = (e && e.message) ? String(e.message) : '';
      const code = e && e.code;
      hideTc();
      /* 取消是主动行为（切集 / 收起播放页），不是播放故障 */
      if (code === 'aborted') return;
      /* 媒体加载失败：文案由 player 按 el.error.code 区分（编码不支持 / 直链失效） */
      if (code === 'media') { toast(m || '媒体加载失败，请重试或重新扫描', 'warn'); return; }
      /* 明确不支持的格式（ape / wv / wma）：不走转码（一份要转几十秒），直接告诉用户换文件 */
      if (code === 'unsupported') {
        const ext = (e && e.ext) ? String(e.ext).toUpperCase() : '';
        toast('不支持' + (ext ? ' ' + ext + ' ' : '该') + '格式，请先转成 mp3 再放进资源库', 'warn');
        return;
      }
      /* 转码相关：格式本身没错，缺的是 ffmpeg 或文件坏了，给的提示要有指向性 */
      if (code === 'no-ffmpeg') {
        if (!ffmpegWarned) {
          ffmpegWarned = true;
          toast('该格式需要 ffmpeg 转换：安装 ffmpeg 或设置 FM_FFMPEG 后重启', 'warn');
        }
        return;
      }
      if (code === 'busy') { toast('服务端正忙，请稍后重试', 'warn'); return; }
      if (code === 'no-encoder') { toast('该格式需要转换成 mp3/mp4 才能播，请用桌面端或服务器模式', 'warn'); return; }
      if (code === 'ffmpeg-failed' || code === 'bad-format') { toast('转换失败，文件可能已损坏', 'warn'); return; }
      /* 浏览器端转码失败（wma 这类只有客户端这条路）：把具体原因带出来，
         否则用户只看到「播放失败」，分不清是超时、卡住还是文件不对 */
      if (code === 'client-tc-failed') { toast(m || '这个文件转不了，请先转成 mp3', 'warn'); return; }
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
      hideTc();                 /* 切库时停在转码过渡层上会像卡死 */
      if (refs.sheet.classList.contains('open')) closeSheet();
      setCinema(false);
      setPlayerbarVisible(false);
      syncLocateFab();
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
    if (refs.locateFab) refs.locateFab.addEventListener('click', locateCurrent);

    /* 播放条左侧整块（封面+标题+副标题）点击展开播放详情页；收藏键除外 */
    const pbLeft = refs.playerbar.querySelector('.pb-left');
    if (pbLeft) {
      pbLeft.addEventListener('click', function (e) {
        if (e.target.closest('#pbFav')) return;
        if (!P.current) return;
        /* 壳内视频没有网页播放页可展开：点封面/标题 = 把原生播放器叫回来。
           只是回到界面，别把暂停中的视频硬起播（接着播是播放键的事） */
        if (FM.android && P.current.kind === 'video') {
          if (P.openNative) P.openNative({ autoplay: false });
          return;
        }
        openSheet();
        /* 从播放条展开详情页时接着播，别一进去是暂停态 */
        if (!P.playing) P.toggle();
      });
    }

    refs.pbFav.addEventListener('click', toggleFavOfCurrent);
    refs.shFav.addEventListener('click', toggleFavOfCurrent);
    refs.shLoop.addEventListener('click', function () { P.cycleLoop(); toast('播放模式：' + P.loopLabel); });

    refs.btnExpand.addEventListener('click', openSheet);
    refs.btnCollapse.addEventListener('click', closeSheet);
    refs.btnSheetQueue.addEventListener('click', toggleQueue);
    refs.btnQueueClose.addEventListener('click', toggleQueue);
    /* 清空队列：同时把数据库里那份清掉，换设备不会再恢复旧队列 */
    if (refs.btnQueueClear) {
      refs.btnQueueClear.addEventListener('click', function () {
        P.clearQueue();
        renderQueue();
        toast('已清空播放队列');
      });
    }
    /* 手机端播放条上的队列键：队列面板挂在播放页里，先确保播放页打开。
       壳内视频没有网页播放页（画面在原生播放器里），改用「只托队列」的那层容器，
       否则这个键点了毫无反应 */
    refs.pbQueue.addEventListener('click', function () {
      if (FM.android && P.kind === 'video') { openQueueSolo(); return; }
      if (!refs.sheet.classList.contains('open')) openSheet();
      if (refs.sheet.classList.contains('open') && !queueOpen) toggleQueue();
    });
    /* 「只托队列」时点面板外的空白处收起：这时整层就只是块遮罩，不做反应很怪 */
    refs.sheet.addEventListener('click', function (e) {
      if (!refs.sheet.classList.contains('queue-solo')) return;
      if (!queueOpen || e.target.closest('#queuePanel')) return;
      toggleQueue();
    });

    refs.btnRate.addEventListener('click', function (e) { rateMenu(e.currentTarget); });
    refs.shRate.addEventListener('click', function (e) { rateMenu(e.currentTarget); });
    refs.shSleep.addEventListener('click', function (e) { sleepMenu(e.currentTarget); });

    /* 移动端播放页专属：操作行（下载/倍速/收藏/更多）+ 控制行（队列/定时）+ 底部专辑卡 */
    refs.shmQueue.addEventListener('click', toggleQueue);
    refs.shmSleep.addEventListener('click', function (e) { sleepMenu(e.currentTarget); });
    refs.shmRate.addEventListener('click', function (e) { rateMenu(e.currentTarget); });
    refs.shmFav.addEventListener('click', toggleFavOfCurrent);
    refs.shmLoop.addEventListener('click', function () { P.cycleLoop(); toast('播放模式：' + P.loopLabel); });
    /* 下载整张专辑：进「批量下载」勾选页，比无提示地丢进队列清楚 */
    refs.shmDownload.addEventListener('click', function () {
      const t = P.current;
      if (!t || !t.albumId) return;
      closeSheet();
      go('#/downloads/' + t.albumId + '/more');
    });
    refs.shmMore.addEventListener('click', function (e) { moreMenu(e.currentTarget); });

    refs.shAlbumFav.addEventListener('click', function (e) {
      e.stopPropagation();          /* 别冒泡到卡片，否则一边收藏一边跳走 */
      if (P.current) toggleFavorite(P.current.albumId);
    });
    refs.shAlbumCard.addEventListener('click', openAlbumOfCurrent);
    refs.shAlbumCard.addEventListener('keydown', function (e) {
      if (e.target.closest('#shAlbumFav')) return;   /* 焦点在心形上时别把回车/空格抢走 */
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAlbumOfCurrent(); }
    });

    paintRate(P.rate);
    paintVolume(P.volume, P.muted);
    paintLoop(P.loop);
    paintSleep(0);
    if (P.current) paintTrack(P.current);
  }

  /* 专辑收藏态的局部刷新：只改跟这张专辑有关的节点（卡片角标、详情页按钮、播放页 tag / 专辑卡）。
     以前这里是整页 renderAll，收藏一下列表闪一遍、滚动位置也会被顶回去。 */
  function paintAlbumFav(albumId) {
    const a = L.album(albumId);
    if (!a) return;
    const on = !!a.fav;
    U.$$('.card').forEach(function (card) {
      if (card.dataset.id !== albumId) return;
      card.classList.toggle('fav', on);
      const cover = card.querySelector('.card-cover');
      const badge = card.querySelector('.card-fav');
      if (on && cover && !badge) {
        const sp = document.createElement('span');
        sp.className = 'card-fav';
        sp.title = '已收藏';
        sp.innerHTML = icon('heart-fill');
        cover.appendChild(sp);
      } else if (!on && badge) {
        badge.remove();
      }
    });
    /* 专辑详情页那一排按钮里的「收藏 / 已收藏」 */
    U.$$('[data-act="fav"]').forEach(function (btn) {
      if (btn.dataset.id !== albumId) return;
      btn.classList.toggle('danger', on);
      btn.innerHTML = icon(on ? 'heart-fill' : 'heart') + (on ? '已收藏' : '收藏');
    });
  }

  /* 收藏变动后的收尾：侧栏计数、收藏页成员、播放条与播放页的心。
     只有「按收藏筛出来的页面」才需要真的重画，其余全靠局部更新 */
  function afterFavChange(albumId, trackId) {
    renderNav();
    if (state.view === 'fav' || state.view === 'favTracks') renderMainKeepScroll();
    const cur = P.current;
    /* 只刷心，不碰封面/进度/时长：整条 paintTrack 会把进度条归零重画 */
    if (cur && ((albumId && cur.albumId === albumId) || (trackId && cur.id === trackId))) paintFavState(cur);
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
    paintAlbumFav(albumId);
    afterFavChange(albumId);
    FM.fs.setFav(albumId, next).then(function (ok) {
      if (ok) return;
      a.fav = !next;
      toast('收藏失败，请稍后重试', 'warn');
      paintAlbumFav(albumId);
      afterFavChange(albumId);
    }).catch(function () {}).then(function () { favPending.delete(albumId); });
  }

  /* 播放器手里的曲目可能是重新扫描前的旧对象：一起改掉，播放条/播放页才不会各说各话 */
  function syncTrackFav(trackId, fav) {
    if (P.current && P.current.id === trackId) P.current.fav = fav;
    P.queue.forEach(function (q) { if (q.id === trackId) q.fav = fav; });
  }

  /* 播放条/全屏页的心：收藏的是「这一集」，不是专辑 */
  const trackFavPending = new Set();
  function toggleTrackFav(trackId) {
    const t = L.track(trackId);
    if (!t || trackFavPending.has(trackId)) return;
    const next = !t.fav;
    trackFavPending.add(trackId);
    t.fav = next;
    syncTrackFav(trackId, next);
    toast(next ? '已收藏这一集' : '已取消收藏');
    /* 先发起写入：favTrackIds 在调用瞬间就同步更新了，侧栏「我的收藏」计数才对得上 */
    const done = FM.fs.setFavTrack(trackId, next);
    afterFavChange(null, trackId);
    done.then(function (ok) {
      if (ok) return;
      t.fav = !next;
      syncTrackFav(trackId, !next);
      toast('收藏失败，请稍后重试', 'warn');
      afterFavChange(null, trackId);
    }).catch(function () {}).then(function () { trackFavPending.delete(trackId); });
  }

  function toggleFavOfCurrent() {
    const t = P.current;
    if (!t) return;
    toggleTrackFav(t.id);
  }

  /* 档位显示：整数补一位小数，1 → 1.0x、1.25 → 1.25x */
  function fmtRate(r) { return (r % 1 === 0 ? r.toFixed(1) : String(r)) + 'x'; }

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

  /* 播放页「更多」：播放模式已挪到操作行，这里留加入队列 + 标记已听/未听 */
  function moreMenu(anchor) {
    const t = P.current;
    if (!t) return;
    const p = L.progressOf(t.id);
    openMenu(anchor, [
      {
        label: '加入队列', icon: 'list',
        onClick: function () {
          if (!t) return;
          P.addToQueue([t]);
          toast('已加入播放队列');
        }
      },
      { sep: true },
      { label: p && p.done ? '标记为未听' : '标记为已听', icon: p && p.done ? 'undo' : 'check-circle', onClick: function () { toggleListened(t); } }
    ]);
  }

  /* 底部专辑卡：收起播放页再跳专辑详情，否则详情页被播放页盖着 */
  function openAlbumOfCurrent() {
    const t = P.current;
    if (!t || !t.albumId) return;
    closeSheet();
    go('#/album/' + t.albumId);
  }

  function openSheet() {
    /* 壳内视频由原生播放器负责，网页这层没有画面可展开：
       再打开只会得到一个空的黑页面，返回后还停在暂停态 */
    if (FM.android && P.kind === 'video') return;
    /* 播放页要出画面了，把媒体从 <audio> 换回 <video> */
    P.setAudioOnly(false);
    refs.sheet.classList.add('open');
    refs.sheet.setAttribute('aria-hidden', 'false');
    /* 盖住背景时把背景动画层停掉：它们每帧都在重算，会把视频拖到几帧 */
    document.body.classList.add('sheet-open');
    if (P.kind === 'video') { wakeUi(); return; }
    /* 音频播放详情页在壳里锁竖屏：这一页布局只按竖屏排，横过来会挤成一团 */
    if (FM.android && FM.android.lockPortrait) FM.android.lockPortrait(true);
    FM.viz.attach();
    FM.viz.resume();
    FM.viz.start();
  }

  /* 壳内视频：画面归原生播放器，网页这层没有播放页可展开，
     但底栏那个「播放列表」还得能用。单独把 sheet 拉起来当容器，
     只留队列面板（样式见 .sheet.queue-solo），点条目照常切集 */
  function openQueueSolo() {
    refs.sheet.classList.add('open', 'queue-solo');
    refs.sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
    if (!queueOpen) toggleQueue();
  }

  function closeSheet() {
    if (FM.android && FM.android.fullscreenOn) FM.android.fullscreen(false);
    /* 收起播放页就放开方向锁，列表页照旧跟随系统重力感应 */
    if (FM.android && FM.android.lockPortrait) FM.android.lockPortrait(false);
    setCinema(false);
    hideUiNow();
    /* 先摘掉「只托队列」的标记：下面的 toggleQueue 会回头调 closeSheet，不摘会互相递归 */
    refs.sheet.classList.remove('queue-solo');
    refs.sheet.classList.remove('open');
    refs.sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sheet-open');
    if (queueOpen) toggleQueue();
    FM.viz.stop();
    /* 画面看不见了：换成 <audio> 继续放声音，别再解码视频轨道 */
    P.setAudioOnly(true);
    /* audio 元素一旦被 WebAudio 接管过，上下文处于挂起状态就没声音了 */
    FM.viz.resume();
  }

  function toggleQueue() {
    queueOpen = !queueOpen;
    refs.queuePanel.hidden = !queueOpen;
    refs.queuePanel.classList.toggle('open', queueOpen);
    refs.sheet.classList.toggle('queue-open', queueOpen);
    if (queueOpen) renderQueue();
    /* 面板收起后别再留一层空的播放页：只有「只托队列」那种才需要连容器一起收 */
    else if (refs.sheet.classList.contains('queue-solo')) closeSheet();
  }

  function renderQueue() {
    const q = P.queue;
    const head = refs.queuePanel.querySelector('.queue-head strong');
    if (head) head.textContent = P.kind === 'video' ? '选集' : '播放队列';
    refs.queueCount.textContent = q.length ? (P.index + 1) + ' / ' + q.length : '空';
    refs.sheetQueue.innerHTML = q.map(function (t, i) {
      return '<div class="q-item' + (i === P.index ? ' on' : '') + '" data-qi="' + i + '">' +
        '<span class="q-idx"><i class="num">' + (i + 1) + '</i><svg class="i q-pico"><use href="#i-play"/></svg></span>' +
        (t.kind === 'video' ? '<span class="tk-flag vid">' + icon('video') + '视频</span>' : '') +
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
      /* 「只托队列」那层选完就收：壳内视频接下来由原生播放器接管 */
      if (refs.sheet.classList.contains('queue-solo')) closeSheet();
    });
  }

  /* ── 进度条拖动 ── */
  function bindScrubs() {
    /* 窄屏顶部细进度线：self 表示容器本身就是轨道 */
    setupScrub(refs.pbProgress, {
      self: true,
      seek: r => P.seekRatio(r),
      preview: (r, text) => { refs.pbProgressTip.textContent = text; refs.pbProgressTip.style.setProperty('--tipx', (r * 100) + '%'); }
    });
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
        case '[': P.cycleRate(-1); toast('倍速 ' + P.rate + 'x'); break;
        case ']': P.cycleRate(1); toast('倍速 ' + P.rate + 'x'); break;
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
    if (canManageLib()) items.push({ label: '资源库设置…', icon: 'edit', onClick: openLibDrawer });
    if (canManageUsers()) items.push({ label: '用户管理', icon: 'users', onClick: openUserDrawer });
    /* 服务器设置属于主机级配置，只有管理员能看到（同 openSettingsMenu 的口径） */
    if (canManageLib()) {
      if (FM.android) {
        items.push({ label: '服务器地址…', icon: 'server', onClick: function () { FM.android.openSettings(); } });
      }
      if (FM.fs.desktop) {
        items.push({ label: FM.fs.remote ? '远程服务器设置…' : '连接远程服务器…', icon: 'server', onClick: openRemoteDialog });
      }
    }
    openMenu(anchor, items);
  }

  /* ── 设置（顶栏齿轮，三端共用）──
     侧栏在手机上不出现，资源库 / 扫描 / 服务器入口全部收进这个菜单；
     资源 / 维护 / 其他三段只用分隔线隔开，不加分组标题（手机上标题太占高度） */
  function openSettingsMenu() {
    const resource = [];
    if (canManageLib()) resource.push({ label: '资源库设置', icon: 'library', onClick: openLibDrawer });
    if (canManageUsers()) resource.push({ label: '用户管理', icon: 'users', onClick: openUserDrawer });
    /* 目录结构只在桌面端改（canEditGroup 判定），dirModeItems 自带分组标题 */
    const curLib = FM.fs.active();
    if (curLib && canEditGroup()) {
      dirModeItems(curLib, function () { renderAll({ quiet: true }); })
        .forEach(function (it) { resource.push(it); });
    }
    /* 扫描是主机上的重活，只有管理权限才给入口（网页端普通用户只读）。
       三端统一叫「重新扫描」：主动触发一次主机重扫并即时拉取，
       不用等 30 秒轮询；sub 说明它只读取主机目录，不是上传同步 */
    if (canManageLib()) {
      resource.push({
        label: '重新扫描', icon: 'refresh', sub: '重新读取主机上的资源库目录', onClick: doScan
      });
    }
    /* 服务器设置属于主机级配置：只有管理员可见。
       连不上服务端时拿不到角色，保留入口以便管理员修正地址后恢复连接 */
    if (canManageLib()) {
      if (FM.fs.desktop) {
        resource.push({ label: FM.fs.remote ? '远程服务器设置…' : '连接远程服务器…', icon: 'server', onClick: openRemoteDialog });
      } else if (FM.android) {
        resource.push({ label: '服务器设置…', icon: 'server', onClick: function () { FM.android.openSettings(); } });
      }
    }

    const maintenance = [];
    /* 本机占空间的东西分三类：索引缓存（index:<libId>）、封面缓存、离线下载。
       索引随库变大，而所有库共用 WebView 那点 localStorage 配额，所以给个随时能清的出口；
       三类的体积统计和清理都在「存储管理」弹窗里（openStorageManager）。
       菜单不显示库数：数量得遍历键名，且在这里也没有决策价值 */
    maintenance.push({
      label: '存储管理', icon: 'broom',
      onClick: openStorageManager
    });
    /* 在线更新只在 APK 里有（下载/安装都得壳配合）。状态走右侧小字、不占第二行；
       静默查到新版本后直接改那行字，不用重开菜单 */
    if (FM.android && FM.android.native) {
      maintenance.push({
        label: '软件更新', icon: 'update', cls: 'upd-item', rightText: updMenuTail(),
        onClick: onUpdateMenu
      });
    }

    const other = [];
    /* 收听统计是整页视图，手机上不在首页快捷入口里，统一从设置菜单进 */
    other.push({ label: '收听统计', icon: 'chart', onClick: function () { go('#/stats'); } });
    const ver = appVersion();
    other.push({ label: '关于', icon: 'headphones', rightText: ver ? 'v' + ver : '', onClick: openAbout });
    /* 退出登录：安卓壳走原生桥（清会话回登录页），浏览器直连走服务端登出。
       Electron 界面没有登录态；serverReached 只约束网页端，安卓离线时也要能登出 */
    if (FM.android || (!FM.fs.desktop && FM.fs.serverReached)) {
      other.push({
        label: '退出登录', icon: 'logout', danger: true,
        onClick: function () {
          /* 旧 APK 没有 logout 桥：退回服务端登出，WebView 会显示登录页 */
          if (!(FM.android && FM.android.logout && FM.android.logout())) {
            location.href = '/__auth/logout';
          }
        }
      });
    }

    const items = [];
    function section(list) {
      if (!list.length) return;
      if (items.length) items.push({ sep: true });
      list.forEach(function (it) { items.push(it); });
    }
    section(resource);
    section(maintenance);
    section(other);
    updMenu = openMenu(refs.btnSettings, items);
    if (FM.android && FM.android.native && FM.android.canUpdate) {
      /* 展开菜单就查一次（60 秒内复用上次结果），回来后只改那行小字 */
      checkUpdate({}).then(updPaintMenu);
    }
  }

  /* ── 在线更新（只有 APK 有）─────────────────────────────
     更新源就是手机连的这台服务器：/api/app/version 扫 out/ 下最新的 APK。
     展开设置菜单静默问一次，有新版本把版本号写在菜单项上；不计费网络下顺手预下载，
     点开弹窗时可能已经是「安装」。下载/校验/安装都在壳里，网页只管展示与文案。 */
  const upd = {
    info: null,      /* /api/app/version 的结果 */
    at: 0,           /* 上次查询时间：60 秒内复用，别每次开菜单都请求 */
    fetching: null,  /* 进行中的请求（连点菜单不重复发） */
    state: null,     /* 原生下载状态（updateState / onUpdateProgress） */
    dialog: null     /* 打开着的更新弹窗 */
  };
  let updMenu = null;

  function updCode(v) {
    const p = String(v || '').split('.');
    return (parseInt(p[0], 10) || 0) * 10000 + (parseInt(p[1], 10) || 0) * 100 + (parseInt(p[2], 10) || 0);
  }

  /* 服务端版本必须严格大于当前壳版本才算更新：
     低版本装不上去（INSTALL_FAILED_VERSION_DOWNGRADE），别去撞那个错 */
  function updHasNew() {
    const s = upd.info;
    if (!s || !s.has || !s.code) return false;
    const cur = updCode(appVersion());
    return cur > 0 && s.code > cur;
  }

  function updPct(st) {
    const total = st && st.total > 0 ? st.total : 0;
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.floor((st.loaded || 0) * 100 / total)));
  }

  /* 进度里的小数位有意义（4.6 MB 和 5 MB 差别不小），fmtSize 只给整数就用这套 */
  function updSize(n) {
    if (!n) return '—';
    const mb = n / 1048576;
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  /* 菜单项右侧那行小字：版本号 / 下载中 / 待安装，单行显示不折行 */
  function updMenuTail() {
    if (!FM.android.canUpdate) return '需手动安装';
    const s = upd.info, st = upd.state;
    const fresh = updHasNew();
    if (fresh && st && st.version === s.version) {
      if (st.state === 'downloading') return '下载中 ' + updPct(st) + '%';
      if (st.state === 'ready' || st.state === 'installing' || st.state === 'need_permission') return '待安装';
    }
    if (fresh) return '可更新 v' + s.version;
    /* 服务端没放包时也归到「已是最新」：对使用者而言结论一致，不必区分内情 */
    if (s) return '已是最新';
    return '';
  }

  function updPaintMenu() {
    const el = updMenu;
    if (!el || !el.isConnected) return;
    const tail = el.querySelector('.upd-item .menu-tail');
    if (tail) tail.textContent = updMenuTail();
  }

  function updFetch(force) {
    if (!(FM.android && FM.android.canUpdate)) return Promise.resolve(null);
    const now = Date.now();
    if (!force && upd.info && now - upd.at < 60000) return Promise.resolve(upd.info);
    if (upd.fetching) return upd.fetching;
    upd.fetching = fetch('/api/app/version', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { upd.info = d || null; upd.at = Date.now(); return upd.info; })
      .catch(function () { return upd.info; })
      .then(function (d) { upd.fetching = null; return d; });
    return upd.fetching;
  }

  /* 静默预下载：查到新版且在不计费网络（Wi-Fi / 以太网）上就先下好。
     失败不打扰用户，状态留在壳里，点开弹窗看得见、可重试。 */
  function updPreDownload(s) {
    if (!s || !s.has) return;
    const st = upd.state;
    /* 下载中/已下好就别重复起任务；失败的也静默留着，等用户点重试 */
    if (st && st.version === s.version && st.state !== 'idle') return;
    let wifi = false;
    try { wifi = !!FM.android.isWifi(); } catch (e) {}
    if (!wifi) return;
    FM.android.downloadApk(s.url, s.version, s.etag || '');
  }

  /* 原生状态 → 网页。下载中每 300ms 一条，弹窗和菜单项跟着刷 */
  function updateProgress(data) {
    if (!data || !data.state) return;
    upd.state = data;
    updPaintMenu();
    if (upd.dialog) upd.dialog.paint();
  }

  function updPullState() {
    try {
      const raw = FM.android.updateState();
      const d = raw ? JSON.parse(raw) : null;
      if (d && d.state) upd.state = d;
    } catch (e) {}
  }

  /* 启动 / 展开菜单共用：查到新版可选弹一次轻提示（同一版本只提示一次） */
  function checkUpdate(opts) {
    const o = opts || {};
    if (!(FM.android && FM.android.canUpdate)) return Promise.resolve(null);
    return updFetch(!!o.force).then(function (s) {
      updPullState();
      if (!updHasNew()) return s;
      updPreDownload(s);
      if (o.notify) {
        try {
          if (localStorage.getItem('fm_upd_notified') === s.version) return s;
          localStorage.setItem('fm_upd_notified', s.version);
        } catch (e) {}
        /* 轻提示直接给出更新入口，不必让用户再找设置菜单 */
        toast('发现新版本 v' + s.version, null, {
          ms: 5000,
          action: { label: '更新', onPick: openUpdateDialog }
        });
      }
      return s;
    });
  }

  function toastLatest(s) {
    if (s == null) { toast('暂时无法检查更新，请检查网络后重试', 'warn'); return; }
    toast('已是最新版本 v' + appVersion());
  }

  /* 点菜单项：手动检查总是回源（服务器上刚放了新包也能立刻看到），
     但本地服务器通常几十毫秒就回来——先弹「检查中」再关掉会闪一下，
     所以给 300ms 宽限：结果先到就只弹 toast（或只弹下载框），不闪。 */
  function onUpdateMenu() {
    if (!FM.android.canUpdate) {
      toast('当前版本不支持在线更新，请手动安装最新版本', 'warn');
      return;
    }
    /* 缓存里已经有新版：不用再等，直接弹（里面能看进度/直接安装） */
    if (upd.info && upd.at && Date.now() - upd.at < 60000 && updHasNew()) {
      openUpdateDialog();
      return;
    }
    let timer = setTimeout(function () {
      timer = null;
      openUpdateDialog();      /* 慢到这么久还没结果：先给个「正在检查」的框 */
    }, 300);
    updFetch(true).then(function (s) {
      if (timer) { clearTimeout(timer); timer = null; }
      updPullState();
      if (updHasNew()) { openUpdateDialog(); return; }
      if (upd.dialog) return;  /* 检查框已经弹出来了：让它自己的收尾逻辑处理 */
      toastLatest(s);
    });
  }

  /* 原因码保持与安卓壳上报的一致（旧壳也会带 checksum / bad_apk），
     只是把语义重叠的两条合并成同一句，不让用户看到两种"校验失败" */
  const UPD_REASON = {
    network: '下载失败，请检查网络后重试',
    space: '存储空间不足，请清理后重试',
    checksum: '安装包校验未通过，请重新下载',
    auth: '登录已过期，请重新登录',
    bad: '服务器上的安装包暂不可用，请稍后重试',
    bad_apk: '安装包校验未通过，请重新下载',
    signature: '安装包签名与当前 App 不一致，请卸载后重装',
    io: '安装包无法打开，请重新下载'
  };

  /* ── 更新弹窗：检查中 / 下载中 / 待安装 / 需要权限 / 失败 都在同一个框里换按钮 ── */
  function openUpdateDialog() {
    if (upd.dialog) { upd.dialog.paint(); return; }
    const current = appVersion();
    const body = U.el('div', { class: 'upd-box' });
    const verBox = U.el('div', { class: 'upd-ver' });
    const sizeBox = U.el('span', { class: 'upd-size' });
    const bar = U.el('i');
    const left = U.el('span');
    const right = U.el('span');
    const note = U.el('p', { class: 'upd-note', text: '' });
    body.appendChild(U.el('div', { class: 'upd-head' }, [verBox, sizeBox]));
    body.appendChild(U.el('div', { class: 'upd-track' }, [bar]));
    body.appendChild(U.el('div', { class: 'upd-meta' }, [left, right]));
    body.appendChild(note);

    const modal = openModal({
      title: '软件更新',
      body: body,
      actions: [],
      onClose: function () { if (upd.dialog && upd.dialog.mask === modal.mask) upd.dialog = null; }
    });
    const foot = modal.box.querySelector('.modal-foot');

    function setActions(list) {
      foot.innerHTML = '';
      list.forEach(function (a) {
        const b = U.el('button', { class: 'btn ' + (a.cls || ''), text: a.label });
        b.onclick = function () {
          let keep = false;
          if (a.onClick) keep = a.onClick() === false;
          if (!keep) modal.close();
        };
        foot.appendChild(b);
      });
    }

    function phaseOf() {
      const s = upd.info || {}, st = upd.state || {};
      /* 服务端明确回了「没有包」也算查完，别一直停在「正在检查」 */
      if (!s.version) return s.has === false ? 'latest' : 'checking';
      if (!updHasNew()) return 'latest';
      if (!st.version || st.version !== s.version) return 'idle';
      const k = st.state;
      if (k === 'downloading') return 'download';
      if (k === 'ready' || k === 'installing') return 'ready';
      if (k === 'need_permission') return 'need';
      if (k === 'failed') return 'error';
      return 'idle';
    }

    function startDownload() {
      const s = upd.info;
      if (!s || !s.version) return false;
      FM.android.downloadApk(s.url, s.version, s.etag || '');
      paint();
      return false;
    }

    function paint() {
      const s = upd.info || {}, st = upd.state || {};
      const phase = phaseOf();
      const total = phase === 'checking' ? 0 : ((st.version === s.version && st.total > 0) ? st.total : (s.size || 0));
      const loaded = phase === 'ready' ? total : (st.version === s.version ? (st.loaded || 0) : 0);
      const pct = phase === 'ready' ? 100 : updPct(st);

      verBox.innerHTML = s.version
        ? '<b>v' + esc(s.version) + '</b><span>当前 v' + esc(current) + '</span>'
        : '<b>正在检查…</b><span>当前 v' + esc(current) + '</span>';
      sizeBox.textContent = total > 0 ? updSize(total) : '';
      bar.style.width = (phase === 'checking' ? 0 : Math.max(phase === 'ready' ? 100 : pct, phase === 'download' ? 2 : 0)) + '%';

      note.textContent = '';
      if (phase === 'checking') { left.textContent = '正在检查更新…'; right.textContent = ''; }
      else if (phase === 'latest') {
        left.textContent = '已是最新版本 v' + current;
        right.textContent = '';
      }
      else if (phase === 'download') {
        left.textContent = '下载中 ' + pct + '%';
        right.textContent = updSize(loaded) + ' / ' + updSize(total);
      } else if (phase === 'ready') {
        left.textContent = st.state === 'installing' ? '已交由系统安装' : '安装包已就绪，安装后将覆盖当前版本';
        right.textContent = updSize(total);
        if (st.state !== 'installing') note.textContent = '安装完成后将自动重启 App';
      } else if (phase === 'need') {
        left.textContent = '需允许安装未知应用';
        right.textContent = '';
        note.textContent = '授权后返回本页，再次点击安装';
      } else if (phase === 'error') {
        left.textContent = UPD_REASON[st.reason] || '下载失败，请重新下载';
        right.textContent = '';
      } else {
        left.textContent = '可下载';
        right.textContent = total > 0 ? updSize(total) : '';
      }

      const acts = [];
      if (phase === 'latest') acts.push({ label: '关闭', cls: 'btn-primary' });
      else if (phase === 'download') acts.push({ label: '取消', onClick: function () { FM.android.cancelUpdate(); } });
      else if (phase === 'idle') acts.push({ label: '下载', cls: 'btn-primary', onClick: startDownload });
      else if (phase === 'ready') {
        if (st.state === 'installing') {
          acts.push({ label: '关闭' });
        } else {
          acts.push({ label: '稍后安装' });
          acts.push({ label: '安装', cls: 'btn-primary', onClick: function () { FM.android.installApk(); return false; } });
        }
      } else if (phase === 'need') {
        acts.push({ label: '关闭' });
        acts.push({ label: '去开启权限', cls: 'btn-primary', onClick: function () { FM.android.installApk(); return false; } });
      } else if (phase === 'error') {
        acts.push({ label: '关闭' });
        acts.push({ label: '重试', cls: 'btn-primary', onClick: startDownload });
      }
      setActions(acts);
    }

    upd.dialog = { mask: modal.mask, paint: paint };

    /* 已有结果就直接按状态画；没有则强制查一次（缓存可能已经过期） */
    updPullState();
    paint();
    if (!upd.info || !updHasNew()) {
      checkUpdate({ force: true }).then(function (s) {
        if (!modal.mask.isConnected) return;
        if (!updHasNew()) {
          /* 不自动关窗：网络慢时「弹一下就消失」很跳，留着给用户看一眼结论 */
          if (!s) {
            left.textContent = '暂时无法检查更新，请检查网络后重试';
            right.textContent = '';
            bar.style.width = '0';
            note.textContent = '';
            setActions([{ label: '关闭', cls: 'btn-primary' }]);
            return;
          }
          paint();
          return;
        }
        updPullState();
        paint();
        const st = upd.state || {};
        if (st.version !== s.version || st.state === 'idle') startDownload();
        else if (st.state === 'failed') startDownload();   /* 上次失败的，点开就续传 */
      });
    } else {
      const st = upd.state || {};
      if (st.version !== upd.info.version || st.state === 'idle') startDownload();
    }
  }

  /* 版本号来源三端不同：Electron 读 app 版本，APK 读壳版本，浏览器读服务端 package.json */
  function appVersion() {
    if (window.fmNative && window.fmNative.version) return String(window.fmNative.version);
    if (FM.android && FM.android.native) { try { return String(FM.android.version() || ''); } catch (e) {} }
    if (FM.fs.server) return String(FM.fs.version || '');
    return '';
  }

  function openAbout() {
    const s = L.stats();
    const lib = FM.fs.active();
    const v = appVersion();
    /* 手机上不显示「运行形态」：App / 移动网页一眼可辨，这行只在桌面端用来区分本地与远程 */
    const form = isPhone() ? ''
      : ((FM.android && FM.android.native) ? '安卓 App'
        : (FM.fs.desktop ? '桌面版'
          : (FM.fs.server ? '网页版 · 直连服务器' : '网页版 · 本地目录')));
    const libText = !lib ? '未选择'
      : (lib.name + (FM.fs.remote ? ' · 远程 ' + remoteHost() : ''));
    /* 「资源库」那行可能带服务器地址 / 库路径，版本号也可能要报给作者：
       手机上只有标了 .selectable 的文字还能长按选中复制（其余界面文字禁选） */
    const body = U.el('div', { class: 'about' });
    body.innerHTML =
      '<div class="about-head">' +
        '<div class="brand-mark eq-mark about-mark"><span></span><span></span><span></span><span></span><span></span></div>' +
        '<div class="about-name"><b>星海 FM</b><small>你的私人资源库</small></div>' +
        (v ? '<span class="about-ver selectable">v' + esc(v) + '</span>' : '') +
      '</div>' +
      '<div class="about-rows">' +
        (form ? '<div class="about-row"><span>运行形态</span><b>' + esc(form) + '</b></div>' : '') +
        '<div class="about-row"><span>资源库</span><b class="selectable">' + esc(libText) + '</b></div>' +
        '<div class="about-row"><span>内容</span><b>' + s.albums + ' 个专辑 · ' + s.tracks + ' 集 · ' + fmtS(s.size) + '</b></div>' +
      '</div>' +
      '<p class="about-note">全部音频都留在你自己的磁盘或服务器上，星海 FM 不会上传任何内容。</p>';
    openModal({
      title: '关于',
      body: body,
      actions: [{ label: '关闭', cls: 'btn-primary' }]
    });
  }

  /* 资源库行的两段副文案：路径（远程库不暴露真实路径）与规模（专辑/集/占用）。
     选择弹窗和资源库设置抽屉共用，口径才不会漂。
     网盘库不再印「网盘目录 …」：库名后面已经有「网盘」胶囊，副标题只留规模 */
  function libPathText(l) {
    return (l.fixed || FM.fs.remote) ? '远程资源库' : String(l.path || '').replace(/\\/g, '/');
  }

  function libScaleText(l) {
    if (l.missing) return '';
    /* 当前库用内存里的索引（口径与其它页面一致），其它库读 localStorage 里按库缓存的索引快照；
       从没打开过的库没有缓存，就不显示这一行 */
    if (l.id === FM.fs.activeId && L.albums().length) {
      const s = L.stats();
      return s.albums + ' 个专辑 · ' + s.tracks + ' 集 · ' + fmtS(s.size);
    }
    const idx = FM.db.index(l.id);
    if (!idx || !idx.albums || !idx.albums.length) return '';
    let size = 0;
    FM.lib.indexAlbums(idx).forEach(function (a) { size += a.size || 0; });
    const tracks = (idx.tracks || []).length;
    return idx.albums.length + ' 个专辑' + (tracks ? ' · ' + tracks + ' 集' : '') + (size ? ' · ' + fmtS(size) : '');
  }

  /* 资源库单选行：选中态 / 缺失态 / 规模行都在这里画，弹窗与抽屉复用。
     库路径是纯文字信息，手机上要能长按复制，所以单独标 .selectable（其余界面文字禁选）。
     网盘库：类型胶囊跟在库名后面，不印路径行（网盘目录对用户没意义） */
  function libRowHtml(l) {
    const cur = l.id === FM.fs.activeId;
    const scale = libScaleText(l);
    const isAlist = l.type === 'alist';
    return '<span class="lib-ico">' + icon(l.missing ? 'moon' : ((l.fixed || FM.fs.remote) ? 'library' : 'folder')) + '</span>' +
      '<div class="lib-info"><div class="lib-name"><b>' + esc(l.name) + '</b>' +
      (isAlist ? '<span class="lib-share">网盘</span>' : '') + '</div>' +
      (isAlist ? '' : '<small class="selectable">' + esc(libPathText(l)) + '</small>') +
      (scale ? '<span class="lib-stats">' + esc(scale) + '</span>' : '') +
      (l.missing ? '<em>' + (isAlist ? '网盘连接未配置，请先编辑网盘连接' : '资源库目录不存在，需要重新定位') + '</em>' : '') + '</div>' +
      (l.shared ? '<span class="lib-share">共享</span>' : '') +
      (cur ? '<span class="lib-cur">当前</span>' : '');
  }

  /* 换个资源库：手机首页点 logo 弹出，居中显示当前库 + 其余可选库 */
  function openLibSwitch() {
    const list = FM.fs.libs();
    const body = U.el('div', { class: 'lib-pick' });
    if (!list.length) {
      body.innerHTML = canManageLib()
        ? '<div class="lib-empty">还没有资源库。点下面的「管理资源库」添加一个放音频的文件夹。</div>'
        : '<div class="lib-empty">还没有资源库，请联系管理员添加。</div>';
      openModal({
        title: '选择资源库',
        body: body,
        actions: (canManageLib()
          ? [{ label: '管理资源库', cls: 'btn-ghost', onClick: function () { openLibDrawer(); } }]
          : []).concat([{ label: '关闭', cls: 'btn-primary' }])
      });
      return;
    }
    /* 当前库排最前面，一眼就知道在听哪个库；其余按原顺序 */
    const ordered = list.slice().sort(function (a, b) {
      return (b.id === FM.fs.activeId ? 1 : 0) - (a.id === FM.fs.activeId ? 1 : 0);
    });
    body.innerHTML = '<p class="lib-pick-tip">点其它资源库即可切换' +
      (FM.fs.remote ? '（远程模式，无法在手机上修改资源库）' : '') + '</p>' +
      ordered.map(function (l) {
        return '<div class="lib-row' + (l.id === FM.fs.activeId ? ' current' : '') + (l.missing ? ' missing' : '') +
          '" data-lib="' + esc(l.id) + '">' + libRowHtml(l) + '</div>';
      }).join('');
    const m = openModal({
      title: '选择资源库',
      body: body,
      actions: (canManageLib()
        ? [{ label: '管理资源库', cls: 'btn-ghost', onClick: function () { openLibDrawer(); } }]
        : []).concat([{ label: '关闭', cls: 'btn-primary' }])
    });
    body.addEventListener('click', function (e) {
      const row = e.target.closest('.lib-row');
      if (!row) return;
      const id = row.dataset.lib;
      if (!id || id === FM.fs.activeId) return;
      const l = list.filter(function (x) { return x.id === id; })[0];
      if (!l) return;
      if (l.missing) { toast('资源库目录不存在，请先在「管理资源库」里重新定位', 'warn'); return; }
      m.close();
      switchLib(id);
    });
  }

  /* 资源库设置：右侧抽屉，不遮住主界面，切库的上下文还在 */
  function openLibDrawer() {
    /* 网页端普通用户：禁用资源库设置页（服务端已对写操作做管理员校验，这里前端再拦一道） */
    if (!canManageLib()) { toast('只有管理员可以管理资源库', 'warn'); return; }
    const list_ = U.el('div', { class: 'lib-list' });
    const mask = U.el('div', { class: 'lib-drawer-mask' });
    const panel = U.el('div', { class: 'lib-drawer' });
    let closed = false;

    const head = U.el('div', { class: 'lib-drawer-head' });
    const titleBox = U.el('div', { class: 'lib-drawer-title' }, [U.el('h3', { text: '资源库设置' })]);
    const x = U.el('button', { class: 'icon-btn', title: '关闭', html: icon('close') });
    x.onclick = function () { close(); };
    head.append(titleBox, x);

    /* 提示区只在真有内容时（远程只读等）才占位，平时不显示 */
    const tips = U.el('div', { class: 'lib-drawer-tips' });
    const body = U.el('div', { class: 'lib-drawer-body' }, [tips, list_]);

    const foot = U.el('div', { class: 'lib-drawer-foot' });
    /* 单目录模式、或服务端没开 --allow-lib-edit 时，列表是只读的，不给「添加」 */
    const canAdd = !FM.fs.server || FM.fs.libs().some(function (l) { return !l.fixed; });
    if (FM.fs.remote && !canAdd) {
      tips.appendChild(U.el('div', {
        class: 'lib-drawer-tip',
        text: '无法修改远程资源库。如需修改本地资源库，请先断开远程连接。'
      }));
    }
    /* 移动端不给「添加资源库」：要选主机目录，手机上误触成本高，等回桌面端再加 */
    if (canAdd && !isMobileDevice()) {
      const add = U.el('button', { class: 'btn', html: icon('plus') + '<span>添加资源库</span>' });
      add.onclick = function () { close(); addLibFlow(); };
      foot.appendChild(add);
    }
    /* 网盘库走 /api/alist/config（只改 fm.db，不挂主机目录），不受 --allow-lib-edit 限制 */
    if (canConfigAlist()) {
      const addNet = U.el('button', { class: 'btn btn-ghost', html: icon('plus') + '<span>添加网盘库</span>' });
      addNet.onclick = function () { openAlistConfigDialog(null, draw); };
      foot.appendChild(addNet);
    }
    /* 远端设置入口在资源库菜单里（「远程服务器设置…」），抽屉底部不再重复放一个 */
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
      dropLayer(close);     /* 节点还要留 380ms 播收起动画，但逻辑上已经关了 */
      document.removeEventListener('keydown', onKey);
      mask.classList.remove('show');
      panel.classList.remove('open');
      setTimeout(function () { mask.remove(); panel.remove(); }, 380);
    }
    pushLayer(close);
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
      list_.innerHTML = '';
      if (!list.length) {
        list_.innerHTML = '<div class="lib-empty">还没有资源库。添加一个放音频 / 视频的文件夹就能开始。</div>';
        return;
      }
      list.forEach(function (l) {
        const cur = l.id === FM.fs.activeId;
        const row = U.el('div', { class: 'lib-row' + (cur ? ' current' : '') + (l.missing ? ' missing' : '') });
        /* 分组口径按钮：文字写「当前是什么」而不是「点了会变成什么」，
           默认的平铺库显示「一层」，避免被误读成已经启用两层分组。
           只写 fm.db 的元数据、不碰主机目录，所以 fixed 库也允许点 */
        const lm = libDirMode(l);
        const lt = DIR_MODE_LABEL[lm];
        const modeTitle = '目录结构：' + lt[0] + '（' + lt[1] + '）。点击切换';
        /* 目录自动监听：桌面本地库走「更多」菜单；手机 / 网页端（fixed 库）在行上直接给按钮，
           否则默认没开 --allow-lib-edit 时那个菜单根本不出现，用户就没法打开监听。
           网盘库是虚拟目录，主机侧没法 chokidar，行上不给这个胶囊 */
        const showWatchBtn = l.type !== 'alist' && FM.fs.watchSupported && (FM.fs.native || FM.fs.server) &&
          canManageLib() && !l.shared && (FM.android || l.fixed);
        const watchTitle = '目录自动监听：' + (l.watch ? '已开启' : '已关闭') + '。点击' + (l.watch ? '关闭' : '开启');
        row.innerHTML = libRowHtml(l) +
          (canEditGroup()
            ? '<button class="lib-mode' + (lm !== 'flat' ? ' on' : '') + '" type="button" title="' + esc(modeTitle) + '">' +
              esc(lt[0]) + '</button>'
            : '') +
          (showWatchBtn
            ? '<button class="lib-mode lib-watch' + (l.watch ? ' on' : '') + '" type="button" title="' + esc(watchTitle) + '">' +
              (l.watch ? '监听中' : '监听关') + '</button>'
            : '') +
          (l.fixed ? '' : '<button class="icon-btn lib-more" title="更多">' + icon('more') + '</button>');
        const mode = row.querySelector('.lib-mode:not(.lib-watch)');
        if (mode) mode.addEventListener('click', function (e) {
          e.stopPropagation();
          openMenu(e.currentTarget, dirModeItems(l, draw));
        });
        const wbtn = row.querySelector('.lib-watch');
        if (wbtn) wbtn.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleWatchFlow(l, draw);
        });
        const more = row.querySelector('.lib-more');
        if (more) more.addEventListener('click', function (e) { e.stopPropagation(); libRowMenu(e.currentTarget, l, draw, handle); });
        row.addEventListener('click', function (e) {
          if (e.target.closest('.lib-more') || e.target.closest('.lib-mode') || cur) return;
          if (l.missing) {
            toast(l.type === 'alist' ? '网盘连接未配置，请先在「更多」里编辑网盘连接' : '资源库目录不存在，请先重新定位', 'warn');
            return;
          }
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
    if (l.type === 'alist' && canConfigAlist() && !l.shared) {
      items.push({ label: '编辑网盘连接…', icon: 'refresh', onClick: function () { openAlistConfigDialog(l, redraw); } });
    }
    if (FM.fs.native) {
      items.push({ label: '重新定位…', icon: 'folder', onClick: function () { relocateFlow(l, redraw); } });
      items.push({ label: '在文件夹中打开', icon: 'folder', onClick: function () { FM.fs.openLib(l.id); } });
    }
    /* 目录自动监听：默认关，按库手动打开；共享来的只读副本不让它替源库做主。
       纯网页本地目录没有主机侧监听，网盘库是虚拟目录也没有，都不给入口 */
    if (l.type !== 'alist' && FM.fs.watchSupported && (FM.fs.native || FM.fs.server) && canManageLib() && !l.fixed) {
      items.push({
        label: l.watch ? '关闭目录自动监听' : '开启目录自动监听',
        icon: l.watch ? 'check' : 'refresh',
        onClick: function () { toggleWatchFlow(l, redraw); }
      });
    }
    /* 共享：仅服务端多用户的管理员、且是自己名下可编辑的库才能指派给别人 */
    if (FM.fs.isAdmin && FM.fs.server && !FM.fs.noAuth && !l.fixed) {
      items.push({ label: '共享资源库', icon: 'share', onClick: function () { openShareDialog(l, redraw); } });
    }
    items.push({ sep: true });
    items.push({
      label: '移除资源库', icon: 'trash', danger: true,
      onClick: function () { removeLibFlow(l, redraw); }
    });
    /* 目录结构三档插在「移除」前面，单独一段标题，不容易误点到下面的红色按钮 */
    if (canEditGroup()) {
      const modeItems = dirModeItems(l, redraw);
      const at = items.length - 2;      // 指向「移除」前面那道分隔线
      items.splice(at, 0, { sep: true });
      items.splice.apply(items, [at + 1, 0].concat(modeItems));
    }
    openMenu(anchor, items);
  }

  /* ── Alist/OpenList 网盘库配置 ──
     凭据只提交给服务端加密落库，界面永不回填密码 / Token；编辑时留空即「不修改」。
     连接测试走只读的 /api/alist/test，保存走 PUT /api/alist/config。 */
  function openAlistConfigDialog(lib, redraw) {
    if (!canConfigAlist()) { toast('只有服务端管理员可以配置网盘库', 'warn'); return; }
    const id = lib ? lib.id : '';
    const editing = !!id;
    const name = U.el('input', { class: 'input', value: lib ? lib.name : '', placeholder: '例如：夸克网盘TV' });
    const host = U.el('input', { class: 'input', placeholder: 'http://服务器地址:5244', spellcheck: false });
    const base = U.el('input', { class: 'input', value: (lib && lib.basePath) || '/', placeholder: '/音乐/有声书', spellcheck: false });
    const username = U.el('input', { class: 'input', placeholder: 'OpenList 用户名', autocomplete: 'off', spellcheck: false });
    const keep = editing ? '留空表示不修改' : '';
    const pw = U.el('input', { class: 'input', type: 'password', placeholder: keep || '密码（与 Token 二选一）', autocomplete: 'new-password' });
    const token = U.el('input', { class: 'input', type: 'password', placeholder: keep || '长期 Token（可选，优先于密码）', autocomplete: 'off' });
    const dirPw = U.el('input', { class: 'input', type: 'password', placeholder: keep || '加密目录密码（可选）', autocomplete: 'off' });
    const cdn = U.el('input', { class: 'input', value: '*.drive.quark.cn', placeholder: '直链域名白名单，逗号分隔', spellcheck: false });
    const err = U.el('small', { class: 'drawer-sub', style: { color: '#ff8a65' } });
    const field = function (label, input) {
      return U.el('div', { class: 'field' }, [U.el('label', { text: label }), input]);
    };
    const body = U.el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
      field('资源库名称', name), field('OpenList 地址', host), field('网盘根目录', base),
      field('用户名', username), field('密码', pw), field('Token', token),
      field('目录密码', dirPw), field('CDN 白名单', cdn),
      U.el('small', { class: 'drawer-sub', text: '直链由服务端换取后 302 给播放器，媒体字节不经过 fm；改动会立即清掉旧扫描缓存。' }),
      err
    ]);
    const say = function (text, ok) {
      err.textContent = text;
      err.style.color = ok ? 'var(--dim)' : '#ff8a65';
    };
    function form() {
      return {
        libId: id, name: name.value.trim(),
        host: host.value.trim().replace(/\/+$/, ''),
        username: username.value.trim(),
        password: pw.value, token: token.value, dirPassword: dirPw.value,
        base: base.value.trim() || '/',
        cdn: cdn.value.split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean)
      };
    }
    async function errText(r) {
      let t = '';
      try { t = await r.text(); } catch (e) {}
      try {
        const j = JSON.parse(t);
        return (j.error && (j.error.message || j.error.code)) || j.reason || t;
      } catch (e) { return t; }
    }
    const post = function (url, method, payload) {
      return FM.fs.apiFetch(url, {
        method: method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    };

    const actions = [{ label: '取消', cls: 'btn-ghost' }];
    if (editing) actions.push({
      label: '清除凭据', cls: 'btn-ghost',
      onClick: function () {
        confirmModal({ title: '清除网盘凭据', message: '清除后该库将无法扫描和播放，确定继续？', danger: true })
          .then(function (ok) { if (ok) clear(); });
        return false;
      }
    });
    actions.push({ label: '测试连接', cls: 'btn-ghost', onClick: function () { testConn(); return false; } });
    actions.push({ label: '保存', cls: 'btn-primary', onClick: function () { save(); return false; } });
    const m = openModal({ title: editing ? '网盘连接 · ' + lib.name : '添加网盘库', body: body, actions: actions });

    if (editing) {
      (async function () {
        try {
          const r = await FM.fs.apiFetch('/api/alist/config?libId=' + encodeURIComponent(id), { cache: 'no-store' });
          if (!r.ok) {
            say(r.status === 404 ? '服务端版本过低，请升级后重试' : '读取配置失败（' + r.status + '）');
            return;
          }
          const c = await r.json();
          name.value = c.name || name.value;
          host.value = c.host || '';
          username.value = c.username || '';
          base.value = c.base || '/';
          cdn.value = (c.cdnHosts || []).join(', ');
          say(c.hasCredential ? '' : '该库没有可用凭据，请重新输入密码或 Token', !!c.hasCredential);
        } catch (e) { say(U.NET_FAIL); }
      })();
    }

    async function testConn() {
      const f = form();
      if (!f.host) { say('先填 OpenList 地址'); return; }
      if (!f.password && !f.token) { say('测试连接需要重新输入密码或 Token（保存时可留空）'); return; }
      say('正在测试连接…');
      try {
        const r = await post('/api/alist/test', 'POST', f);
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok) { say((j.error && (j.error.message || j.error.code)) || ('连接失败（' + r.status + '）')); return; }
        const bits = [j.serverTitle || 'OpenList'];
        (j.storages || []).forEach(function (s) { bits.push(s.mount + '（' + s.driver + '）'); });
        if (j.rangeOk === false) bits.push('上游不支持 Range');
        if (j.corsOk === false) bits.push('上游无 CORS 头（播放器已按无 CORS 处理）');
        if (!cdn.value.trim() && j.cdnSuggest && j.cdnSuggest.length) cdn.value = j.cdnSuggest.join(', ');
        say('连接正常：' + bits.join(' · '), true);
      } catch (e) { say(U.NET_FAIL); }
    }

    async function save() {
      const f = form();
      if (!f.host) { say('先填 OpenList 地址'); return; }
      if (!editing && !f.password && !f.token) { say('请填密码或 Token'); return; }
      say('正在保存…');
      try {
        const r = await post('/api/alist/config', 'PUT', f);
        if (!r.ok) { say((await errText(r)) || ('保存失败（' + r.status + '）')); return; }
        const j = await r.json().catch(function () { return {}; });
        await FM.fs.refreshLibs();
        if (redraw) redraw();
        m.close();
        toast(editing ? '网盘连接已更新' : '已添加网盘库「' + ((j.view && j.view.name) || f.name) + '」，请重新扫描');
      } catch (e) { say(U.NET_FAIL); }
    }

    async function clear() {
      try {
        const r = await FM.fs.apiFetch('/api/alist/config?libId=' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) { say((await errText(r)) || ('清除失败（' + r.status + '）')); return; }
        await FM.fs.refreshLibs();
        if (redraw) redraw();
        m.close();
        toast('已清除网盘凭据');
      } catch (e) { say(U.NET_FAIL); }
    }
  }

  /* ── 共享资源库：把当前库指派给「所有人」或「指定用户」 ──
     顶部只读展示库信息（和资源库设置页一致），下方选范围；选「指定用户」才展开多选。 */
  function openShareDialog(l, redraw) {
    /* 没共享过时默认「所有人」（与原型一致），共享过的按已有配置回填 */
    const cur = l.shares || { targetAll: true, targets: [] };
    const body = U.el('div', { class: 'share-dialog' });
    const info = U.el('div', { class: 'lib-row share-lib' });
    info.innerHTML = libRowHtml(l);
    body.appendChild(info);

    const scope = U.el('div', { class: 'share-scope' });
    scope.innerHTML =
      '<label class="share-opt"><input type="radio" name="share-scope" value="all"' + (cur.targetAll ? ' checked' : '') + '><span>所有人</span></label>' +
      '<label class="share-opt"><input type="radio" name="share-scope" value="users"' + (cur.targetAll ? '' : ' checked') + '><span>指定用户</span></label>';
    body.appendChild(scope);

    const usersBox = U.el('div', { class: 'share-users' + (cur.targetAll ? '' : ' show') });
    const search = U.el('input', { class: 'share-search', placeholder: '搜索用户…' });
    const tools = U.el('div', { class: 'share-tools' });
    tools.innerHTML = '<a data-act="all">全选</a><a data-act="none">清空</a>';
    const userList = U.el('div', { class: 'share-user-list' });
    usersBox.append(search, tools, userList);
    body.appendChild(usersBox);

    scope.addEventListener('change', function () {
      const all = (scope.querySelector('input[value="all"]') || {}).checked;
      usersBox.classList.toggle('show', !all);
    });
    search.addEventListener('input', function () {
      const q = String(search.value || '').trim().toLowerCase();
      userList.querySelectorAll('.share-user').forEach(function (row) {
        row.style.display = row.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
      });
    });
    tools.addEventListener('click', function (e) {
      const a = e.target.closest('a');
      if (!a) return;
      const on = a.dataset.act === 'all';
      userList.querySelectorAll('input[type="checkbox"]').forEach(function (c) { c.checked = on; });
    });

    const m = openModal({
      title: '共享资源库',
      body: body,
      actions: [
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '保存', cls: 'btn-primary',
          onClick: function () {
            const targetAll = !!(scope.querySelector('input[value="all"]') || {}).checked;
            const ids = [];
            userList.querySelectorAll('input[type="checkbox"]').forEach(function (c) { if (c.checked) ids.push(c.value); });
            if (!targetAll && !ids.length) { toast('请至少选择一个用户', 'warn'); return false; }
            FM.fs.share(l.id, targetAll, ids).then(function () {
              toast(targetAll ? '已共享给所有人' : '已共享给 ' + ids.length + ' 位用户');
              if (redraw) redraw();
              m.close();
            }, function (e) { toast((e && e.message) || '共享失败', 'warn'); });
            return false;      /* 不自动关，等请求回来再关 */
          }
        }
      ]
    });

    (async function () {
      let users = [];
      try {
        const r = await FM.fs.apiFetch('/api/users', { cache: 'no-store' });
        if (r.ok) users = await r.json();
      } catch (e) {}
      /* 已禁用账号不参与指派：即使勾上也登录不了 */
      users = (users || []).filter(function (u) { return !u.disabled; });
      const pre = cur.targets || [];
      userList.innerHTML = users.map(function (u) {
        const on = pre.indexOf(u.id) >= 0;
        return '<label class="share-user"><input type="checkbox" value="' + esc(u.id) + '"' + (on ? ' checked' : '') + '>' +
          '<span>' + esc(u.username) + (u.role === 'admin' ? '<i class="share-role">管理员</i>' : '') + '</span></label>';
      }).join('') || '<div class="share-empty">没有可选的用户</div>';
    })();
  }

  /* ── 用户管理：仅服务端管理员 ──
     列表 + 新增 + 启用/禁用 + 重置密码 + 删除；禁用与删除都要勾选「我已了解」二次确认。 */
  /* 账号规则（与 db.js 的 usernameError / passwordError 保持同一口径） */
  const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
  function usernameError(name) {
    const s = String(name || '');
    if (!s) return '请填写用户名';
    if (!USERNAME_RE.test(s)) return '用户名需字母开头，只能含字母、数字、_ . -，不含空格';
    return '';
  }
  function passwordError(username, password) {
    const p = String(password || '');
    if (p.length < 8) return '密码至少 8 位';
    if (p.length > 128) return '密码最多 128 位';
    if (/^\d+$/.test(p)) return '密码不能是纯数字';
    if (!/\S/.test(p)) return '密码不能全是空白字符';
    const u = String(username || '');
    if (u && p.toLowerCase() === u.toLowerCase()) return '密码不能和用户名相同';
    return '';
  }
  function passwordStrength(pw) {
    const p = String(pw || '');
    if (!p) return { pct: 0, label: '', cls: '' };
    let score = 0;
    if (p.length >= 8) score++;
    if (p.length >= 12) score++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
    if (/\d/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;
    let label = '弱', cls = 'weak';
    if (score >= 4) { label = '强'; cls = 'strong'; }
    else if (score >= 2) { label = '中'; cls = 'mid'; }
    /* 纯数字一律按弱处理 */
    if (/^\d+$/.test(p)) { label = '弱'; cls = 'weak'; }
    return { pct: cls === 'strong' ? 100 : (cls === 'mid' ? 66 : 33), label: label, cls: cls };
  }
  const PW_HINT = '至少 8 位，不能是纯数字，不能与用户名相同';
  /* 密码输入框 + 强度条 + 提示；usernameInput 用来实时提示「不能和用户名相同」 */
  function makePasswordField(placeholder, usernameInput) {
    const input = U.el('input', {
      class: 'share-search', type: 'password', placeholder: placeholder,
      autocomplete: 'new-password', 'aria-label': placeholder
    });
    const meter = U.el('div', { class: 'pw-meter' });
    meter.innerHTML = '<i></i>';
    const tip = U.el('div', { class: 'pw-tip', text: PW_HINT });
    function refresh() {
      const pw = String(input.value || '');
      const uname = usernameInput ? String(usernameInput.value || '').trim() : '';
      const fill = meter.querySelector('i');
      if (uname && pw && pw.toLowerCase() === uname.toLowerCase()) {
        if (fill) fill.style.width = '33%';
        meter.className = 'pw-meter weak';
        tip.textContent = '密码不能和用户名相同';
        return;
      }
      if (/^\d+$/.test(pw)) {
        if (fill) fill.style.width = '33%';
        meter.className = 'pw-meter weak';
        tip.textContent = '密码不能是纯数字';
        return;
      }
      const s = passwordStrength(pw);
      if (fill) fill.style.width = s.pct + '%';
      meter.className = 'pw-meter' + (s.cls ? ' ' + s.cls : '');
      tip.textContent = pw ? ('密码强度：' + s.label) : PW_HINT;
    }
    input.addEventListener('input', refresh);
    if (usernameInput) usernameInput.addEventListener('input', refresh);
    refresh();
    return { input: input, meter: meter, tip: tip, refresh: refresh };
  }

  function fmtWhen(iso) {
    if (!iso) return '从未登录';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 「我已了解」勾选式确认框：未勾选时确认按钮禁用 */
  function confirmWithCheckbox(opt) {
    opt = opt || {};
    const body = U.el('div', { class: 'confirm confirm-check' });
    body.appendChild(U.el('span', {
      class: 'confirm-ico' + (opt.danger ? ' danger' : ''),
      html: icon(opt.icon || (opt.danger ? 'trash' : 'moon'))
    }));
    const txt = U.el('div', { class: 'confirm-txt' });
    txt.appendChild(U.el('p', { class: 'confirm-msg', text: opt.message || '' }));
    if (opt.note) txt.appendChild(U.el('p', { class: 'confirm-note', text: opt.note }));
    body.appendChild(txt);
    const ack = U.el('label', { class: 'confirm-ack' });
    const cb = U.el('input', { type: 'checkbox' });
    ack.append(cb, U.el('span', { text: opt.ack || '我已了解' }));
    body.appendChild(ack);

    return new Promise(function (resolve) {
      let settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      const m = openModal({
        title: opt.title || '请确认',
        body: body,
        actions: [
          { label: opt.cancelText || '取消', cls: 'btn-ghost', onClick: function () { done(false); } },
          {
            label: opt.okText || '确定', cls: opt.danger ? 'danger' : 'btn-primary',
            onClick: function () { if (!cb.checked) return false; done(true); }
          }
        ],
        onClose: function () { done(false); }
      });
      const ok = m.box.querySelector('.modal-foot .btn:last-child');
      if (ok) {
        ok.disabled = true;
        cb.addEventListener('change', function () { ok.disabled = !cb.checked; });
      }
    });
  }

  /* 新增用户：用户名 / 密码 / 确认密码 + 可访问资源库多选（复用共享机制） */
  function openCreateUserDialog(onDone) {
    const body = U.el('div', { class: 'user-form' });
    const userIn = U.el('input', { class: 'share-search', placeholder: '用户名', autocomplete: 'off', 'aria-label': '用户名' });
    const uHint = U.el('div', { class: 'pw-tip', text: '字母开头，不含空格，区分大小写' });
    const pwField = makePasswordField('密码（至少 8 位）', userIn);
    const pw2In = U.el('input', { class: 'share-search', type: 'password', placeholder: '再次输入密码', autocomplete: 'new-password', 'aria-label': '再次输入密码' });
    body.append(userIn, uHint, pwField.input, pwField.meter, pwField.tip, pw2In);

    const libs = FM.fs.libs().filter(function (l) { return !l.shared; });
    const libWrap = U.el('div', { class: 'user-lib-box' });
    libWrap.innerHTML = '<div class="user-label">可访问的资源库</div>';
    const libList = U.el('div', { class: 'user-lib-list' });
    if (libs.length) {
      libList.innerHTML = libs.map(function (l) {
        return '<label class="user-lib"><input type="checkbox" value="' + esc(l.id) + '">' +
          '<span>' + esc(l.name) + '<i>只读</i></span></label>';
      }).join('');
    } else {
      libList.innerHTML = '<div class="share-empty">暂无可指派的资源库</div>';
    }
    libWrap.appendChild(libList);
    body.appendChild(libWrap);

    const m = openModal({
      title: '新增用户',
      body: body,
      actions: [
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '创建', cls: 'btn-primary',
          onClick: function () {
            const username = String(userIn.value || '').trim();
            const pw = String(pwField.input.value || '');
            const uErr = usernameError(username);
            if (uErr) { toast(uErr, 'warn'); return false; }
            const pErr = passwordError(username, pw);
            if (pErr) { toast(pErr, 'warn'); return false; }
            if (pw !== String(pw2In.value || '')) { toast('两次输入的密码不一致', 'warn'); return false; }
            const ids = [];
            libList.querySelectorAll('input[type="checkbox"]').forEach(function (c) { if (c.checked) ids.push(c.value); });
            const ok = m.box.querySelector('.modal-foot .btn:last-child');
            if (ok) ok.disabled = true;      /* 防重复提交 */
            FM.fs.createUser(username, pw, ids).then(function (res) {
              toast('已新增用户「' + username + '」');
              if (onDone) onDone(res);
              m.close();
            }, function (e) {
              if (ok) ok.disabled = false;
              toast((e && e.message) || '新增用户失败', 'warn');
            });
            return false;      /* 等请求回来再关 */
          }
        }
      ]
    });
  }

  /* 重置密码：管理员给某个用户设新密码；旧会话会被 token_version 自增踢下线 */
  function openResetPasswordDialog(u, onDone) {
    const body = U.el('div', { class: 'user-form' });
    body.appendChild(U.el('div', { class: 'user-label', text: '为「' + u.username + '」设置新密码' }));
    body.appendChild(U.el('div', { class: 'confirm-note', text: '重置后该用户所有已登录会话将立即失效。' }));
    const pwField = makePasswordField('新密码（至少 8 位）', null);
    const pw2In = U.el('input', { class: 'share-search', type: 'password', placeholder: '再次输入新密码', autocomplete: 'new-password', 'aria-label': '再次输入新密码' });
    body.append(pwField.input, pwField.meter, pwField.tip, pw2In);

    const m = openModal({
      title: '重置密码',
      body: body,
      actions: [
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '重置', cls: 'btn-primary',
          onClick: function () {
            const pw = String(pwField.input.value || '');
            const pErr = passwordError(u.username, pw);
            if (pErr) { toast(pErr, 'warn'); return false; }
            if (pw !== String(pw2In.value || '')) { toast('两次输入的密码不一致', 'warn'); return false; }
            const ok = m.box.querySelector('.modal-foot .btn:last-child');
            if (ok) ok.disabled = true;
            FM.fs.resetUserPassword(u.id, pw).then(function (res) {
              toast('已重置「' + u.username + '」的密码');
              if (onDone) onDone(res);
              m.close();
            }, function (e) {
              if (ok) ok.disabled = false;
              toast((e && e.message) || '重置密码失败', 'warn');
            });
            return false;
          }
        }
      ]
    });
  }

  function openUserDrawer() {
    if (!canManageUsers()) { toast('只有管理员可以管理用户', 'warn'); return; }
    const list_ = U.el('div', { class: 'user-list' });
    const mask = U.el('div', { class: 'lib-drawer-mask' });
    const panel = U.el('div', { class: 'lib-drawer user-drawer' });
    let closed = false;

    const head = U.el('div', { class: 'lib-drawer-head' });
    const titleBox = U.el('div', { class: 'lib-drawer-title' });
    titleBox.append(U.el('h3', { text: '用户管理' }), U.el('div', { class: 'user-count', text: '加载中…' }));
    const x = U.el('button', { class: 'icon-btn', title: '关闭', html: icon('close') });
    x.onclick = function () { close(); };
    head.append(titleBox, x);

    const body = U.el('div', { class: 'lib-drawer-body' }, [list_]);
    const foot = U.el('div', { class: 'lib-drawer-foot' });
    const add = U.el('button', { class: 'btn btn-primary', html: icon('plus') + '<span>新增用户</span>' });
    add.onclick = function () { openCreateUserDialog(apply); };
    const done = U.el('button', { class: 'btn', text: '完成' });
    done.onclick = function () { close(); };
    foot.append(add, done);

    panel.append(head, body, foot);
    refs.modalRoot.append(mask, panel);

    function onKey(e) {
      if (e.key !== 'Escape' || closed) return;
      if (refs.modalRoot.querySelector('.modal-mask')) return;
      close();
    }
    function close() {
      if (closed) return;
      closed = true;
      dropLayer(close);     /* 节点还要留 380ms 播收起动画，但逻辑上已经关了 */
      document.removeEventListener('keydown', onKey);
      mask.classList.remove('show');
      panel.classList.remove('open');
      setTimeout(function () { mask.remove(); panel.remove(); }, 380);
    }
    pushLayer(close);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(function () {
      if (closed) return;
      mask.classList.add('show');
      panel.classList.add('open');
    });

    function apply(res) {
      if (res && Array.isArray(res.users)) draw(res.users);
      else refresh();
    }

    async function refresh() {
      list_.innerHTML = '<div class="user-loading">加载中…</div>';
      try { draw(await FM.fs.listUsers()); }
      catch (e) { list_.innerHTML = '<div class="lib-empty">' + esc((e && e.message) || '读取用户失败') + '</div>'; }
    }

    function draw(users) {
      const sub = titleBox.querySelector('.user-count');
      if (sub) sub.textContent = users.length + ' 个账号';
      list_.innerHTML = '';
      if (!users.length) {
        list_.innerHTML = '<div class="lib-empty">还没有用户，点下方「新增用户」。</div>';
        return;
      }
      const enabledAdmins = users.filter(function (u) { return u.role === 'admin' && !u.disabled; }).length;
      users.forEach(function (u) {
        const self = u.id === FM.fs.uid;
        const lastAdmin = u.role === 'admin' && !u.disabled && enabledAdmins <= 1;
        const row = U.el('div', { class: 'user-row' + (u.disabled ? ' off' : '') });
        row.innerHTML =
          '<span class="user-avatar">' + esc((u.username || '?').slice(0, 1).toUpperCase()) + '</span>' +
          '<div class="user-info"><b>' + esc(u.username) + '</b>' +
            '<small>' + esc(fmtWhen(u.lastLoginAt)) + '</small></div>' +
          '<span class="user-role' + (u.role === 'admin' ? ' admin' : '') + '">' + (u.role === 'admin' ? '管理员' : '普通') + '</span>' +
          '<span class="user-state' + (u.disabled ? ' off' : '') + '">' + (u.disabled ? '已禁用' : '已启用') + '</span>';
        const ops = U.el('div', { class: 'user-ops' });
        const toggle = U.el('button', {
          class: 'user-op' + (u.disabled ? '' : ' warn'),
          text: u.disabled ? '启用' : '禁用'
        });
        if (self || (!u.disabled && lastAdmin)) {
          toggle.disabled = true;
          toggle.title = self ? '不能修改自己的账号状态' : '不能禁用最后一个管理员';
        }
        toggle.onclick = function () {
          if (u.disabled) {
            toggle.disabled = true;
            FM.fs.setUserDisabled(u.id, false).then(function (res) {
              toast('已启用「' + u.username + '」'); apply(res);
            }, function (e) { toggle.disabled = false; toast((e && e.message) || '操作失败', 'warn'); });
            return;
          }
          confirmWithCheckbox({
            title: '禁用用户', danger: true, okText: '禁用',
            icon: 'moon',
            message: '确定禁用「' + u.username + '」吗？',
            note: '禁用后该用户会立即退出登录，且无法再次登录；之后可以随时重新启用。'
          }).then(function (ok) {
            if (!ok) return;
            toggle.disabled = true;
            FM.fs.setUserDisabled(u.id, true).then(function (res) {
              toast('已禁用「' + u.username + '」'); apply(res);
            }, function (e) { toggle.disabled = false; toast((e && e.message) || '操作失败', 'warn'); });
          });
        };
        const key = U.el('button', { class: 'icon-btn user-key', title: '重置密码', html: icon('key') });
        key.onclick = function () { openResetPasswordDialog(u, apply); };
        ops.append(key, toggle);

        const del = U.el('button', { class: 'icon-btn user-del', title: '删除用户', html: icon('trash') });
        if (self || (!u.disabled && lastAdmin)) {
          del.disabled = true;
          del.title = self ? '不能删除自己' : '不能删除最后一个管理员';
        }
        del.onclick = function () {
          confirmWithCheckbox({
            title: '删除用户', danger: true, okText: '删除',
            icon: 'trash',
            message: '确定删除「' + u.username + '」吗？',
            note: '将永久删除该账号及其资源库、收藏与共享关系，无法恢复。'
          }).then(function (ok) {
            if (!ok) return;
            del.disabled = true;
            FM.fs.deleteUser(u.id).then(function (res) {
              toast('已删除「' + u.username + '」'); apply(res);
            }, function (e) { del.disabled = false; toast((e && e.message) || '删除失败', 'warn'); });
          });
        };
        ops.appendChild(del);
        row.appendChild(ops);
        list_.appendChild(row);
      });
    }

    refresh();
  }

  /* ── 目录结构三档：默认 / 二级目录 / 自动检测 ──
     只改分组口径，扫描缓存里的文件列表与口径无关，所以静默重扫一遍（读缓存、不走盘）就够。
     手机端不给入口（见 canEditGroup）：改口径会影响所有端看到的专辑数。 */
  const DIR_MODE_LABEL = {
    flat: ['默认', '每个文件夹是专辑', 'folder'],
    cat: ['二级目录', '一级文件夹是分类，二级是专辑', 'grid'],
    auto: ['自动检测', '自动识别分类和专辑', 'wand']
  };
  function libDirMode(l) {
    const m = l && l.dirMode;
    if (m === 'cat' || m === 'auto' || m === 'flat') return m;
    return l && l.dirGroup ? 'cat' : 'flat';
  }
  /* 菜单项：标题「目录结构」+ 三档，主标题加粗、括号说明弱化，当前档打勾 */
  function dirModeItems(l, after) {
    const cur = libDirMode(l);
    const items = [{ head: '目录结构' }];
    ['flat', 'cat', 'auto'].forEach(function (m) {
      const t = DIR_MODE_LABEL[m];
      items.push({
        label: t[0], sub: t[1], icon: t[2],
        right: cur === m ? 'check' : '',
        onClick: function () { if (cur !== m) setLibDirModeFlow(l, m, after); }
      });
    });
    return items;
  }
  async function setLibDirModeFlow(l, mode, after) {
    if (navLocked()) { toast('正在扫描资源库，请稍候'); return; }
    try {
      const val = await FM.fs.setDirMode(l.id, mode);
      l.dirMode = val;
      l.dirGroup = val !== 'flat';
      const t = DIR_MODE_LABEL[val] || DIR_MODE_LABEL.flat;
      toast('目录结构：' + t[0] + '（' + t[1] + '）');
      if (FM.fs.activeId === l.id) await runScan({ silent: true });
      else renderAll({ quiet: true });
      if (after) after();
    } catch (e) {
      toast(e.message || '切换失败', 'warn');
    }
  }

  /* 目录自动监听开关：开启后主机用 chokidar 盯住这个库，新增/删除音频会自动重扫 */
  async function toggleWatchFlow(l, after) {
    if (navLocked()) { toast('正在扫描资源库，请稍候'); return; }
    const next = !l.watch;
    try {
      await FM.fs.setWatch(l.id, next);
      toast(next ? '已开启目录自动监听' : '已关闭目录自动监听');
      if (after) after();
    } catch (e) {
      toast(e.message || '设置失败', 'warn');
    }
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
    /* 网页端普通用户：禁用「添加资源库」（服务端已对写操作做管理员校验，这里前端再拦一道） */
    if (!canManageLib()) { toast('只有管理员可以添加资源库', 'warn'); return; }
    /* 连到服务端一律用「填路径」的方式添加——浏览器弹不出服务器那边的目录选择框 */
    if (FM.fs.serverReached) { addLibByPath(); return; }
    runAddLib('');
  }

  /* 服务器模式：浏览器弹不出对方的目录选择框，改成让人填路径 */
  function addLibByPath() {
    const input = U.el('input', { class: 'input', placeholder: '例如 E:/学习资料/喜马拉雅mp3' });
    /* 添加时就能把目录结构定好：层级深的库（作者/系列/专辑）不用再回头找开关。
       手机上不给改，这个下拉也就不显示 */
    const sel = U.el('select', { class: 'input lib-dirmode-opt' });
    ['flat', 'cat', 'auto'].forEach(function (m) {
      const t = DIR_MODE_LABEL[m];
      const o = U.el('option', { text: t[0] + '（' + t[1] + '）' });
      o.value = m;
      sel.appendChild(o);
    });
    const opt = U.el('div', { class: 'field' }, [U.el('label', { text: '目录结构' }), sel]);
    const fields = [U.el('div', { class: 'field' }, [U.el('label', { text: '服务器上的目录' }), input])];
    if (canEditGroup()) fields.push(opt);
    const body = U.el('div', {}, fields);
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
            runAddLib(v, sel.value || 'flat');
          }
        }
      ]
    });
  }

  async function runAddLib(path, dirMode) {
    try {
      setScanBusy(true, '添加资源库…');
      const lib = await FM.fs.add(path || undefined);
      if (!lib) return;
      /* 口径只写元数据，失败不该拦住添加流程 */
      const m = libDirMode({ dirMode: dirMode });
      if (m !== 'flat') { try { await FM.fs.setDirMode(lib.id, m); lib.dirMode = m; lib.dirGroup = true; } catch (e) {} }
      P.stop();
      resetView();
      await enterLib({ force: true });
      renderAll();
      toast('已添加资源库「' + lib.name + '」' + (m === 'flat' ? '' : '（目录结构：' + DIR_MODE_LABEL[m][0] + '）'));
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

  /* ── 转码过渡层：flv 首次播放要先重封装成 mp4 ──
     转码在后台跑（主进程/服务端），这里只负责「让人知道为什么还没出声」。
     百分比来自主进程推的 fm:tc；拿不到百分比时停在「正在转换，请稍候…」。 */
  let tcHideTimer = 0;
  let ffmpegWarned = false;

  function showTc(name) {
    if (!refs.tcLoading) return;
    clearTimeout(tcHideTimer);
    if (refs.tcName) refs.tcName.textContent = name || '正在准备';
    if (refs.tcHint) refs.tcHint.textContent = '正在转换，请稍候…';
    refs.tcLoading.hidden = false;
    /* 先上屏再挂 show，样式过渡才有起点 */
    requestAnimationFrame(function () { if (refs.tcLoading) refs.tcLoading.classList.add('show'); });
  }

  function setTcPct(pct) {
    if (!refs.tcLoading || !refs.tcHint || !refs.tcLoading.classList.contains('show')) return;
    const n = Math.max(1, Math.min(99, Math.round(Number(pct) || 0)));
    refs.tcHint.textContent = '正在转换 ' + n + '%';
  }

  function hideTc() {
    if (!refs.tcLoading) return;
    clearTimeout(tcHideTimer);
    refs.tcLoading.classList.remove('show');
    tcHideTimer = setTimeout(function () {
      if (refs.tcLoading && !refs.tcLoading.classList.contains('show')) refs.tcLoading.hidden = true;
    }, 420);
  }

  async function switchLib(id) {
    if (!id || id === FM.fs.activeId) return;
    /* 扫描期间不切库：这份扫描结果会被作废，界面上还会再叠一层加载。遮罩已经挡住点击，
       这里兜住键盘 / 代码路径（跨库跳转、搜索命中另一库等） */
    if (navLocked()) { toast(NAV_LOCK_TIP); return; }
    const lib = FM.fs.libs().find(l => l.id === id);
    if (!lib) return;
    if (lib.missing) {
      toast(lib.type === 'alist'
        ? '「' + lib.name + '」网盘连接未配置，请先在「更多」里编辑网盘连接'
        : '「' + lib.name + '」资源库目录不存在，请先重新定位', 'warn');
      openLibDrawer();
      return;
    }
    const seq = beginLibSwitch(lib.name);
    const started = Date.now();
    setScanBusy(true, '切换资源库…');
    try {
      /* 先停播再切通道：activate() 之后 activeId 立刻变成新库，
         而 stop() 里的 saveProgress 是按「当前库」上报的，
         曲目 id 又只由库内相对路径派生 —— 两库有同名目录时，旧库这一集的位置会写进新库 */
      P.stop();
      await FM.fs.activate(id);
      /* 这个库断网期间没写进库的改动，切过来先补发，再进库拉快照（反了会被旧值盖回去） */
      try { await FM.fs.flushPending(); } catch (e) {}
      resetView();
      /* 服务端模式：切库时强制从服务端扫描缓存重建，不用手机本地索引——
         本地索引一旦串过库，切过去会一直显示错的专辑列表；服务端缓存读取很快，不重扫盘。
         桌面本地库仍用本地缓存秒切。 */
      await enterLib(FM.fs.server ? { force: true } : {});
      renderAll();
      /* 切库会 P.stop() 清空播放器：回到这个库时把上次听到的那集放回底栏（不自动播放） */
      restorePlayerBar();
      await endLibSwitch(seq, started);
      /* 占一个槽位：这条还挂着的时候缓存写失败，会把它换成合并文案（见 cacheBroken） */
      toast('已切换到「' + lib.name + '」', null, { key: TOAST_SWITCH });
    } catch (e) {
      await endLibSwitch(seq, started);
      toast(e.message || '切换资源库失败', 'warn');
    } finally {
      setScanBusy(false);
    }
  }

  /* ── 跨库跳转 ──
     搜索结果里其它库的专辑 / 单集：先切库（复用现有过渡层与 navLock），切完再打开。
     切库期间连点会重复触发，用 libNavBusy 挡住；切库失败时保持原页面不动。 */
  let libNavBusy = false;
  async function openAlbumIn(libId2, albumId) {
    if (!albumId) return;
    if (!libId2 || libId2 === FM.fs.activeId) { go('#/album/' + albumId); return; }
    if (libNavBusy) return;
    libNavBusy = true;
    try {
      await switchLib(libId2);
      if (FM.fs.activeId !== libId2) return;
      if (!L.album(albumId)) { toast('这张专辑在新资源库里找不到了', 'warn'); return; }
      go('#/album/' + albumId);
    } finally { libNavBusy = false; }
  }

  async function playAlbumIn(libId2, albumId) {
    if (!albumId) return;
    if (!libId2 || libId2 === FM.fs.activeId) { P.playAlbum(albumId); return; }
    if (libNavBusy) return;
    libNavBusy = true;
    try {
      await switchLib(libId2);
      if (FM.fs.activeId !== libId2) return;
      if (!L.album(albumId)) { toast('这张专辑在新资源库里找不到了', 'warn'); return; }
      P.playAlbum(albumId);
    } finally { libNavBusy = false; }
  }

  async function playTrackIn(libId2, trackId, fromSearch) {
    if (!trackId) return;
    if (!libId2 || libId2 === FM.fs.activeId) {
      const t = L.track(trackId);
      if (!t) return;
      if (P.current && P.current.id === trackId && P.media.src) P.toggle();
      else P.playTrack(t);
      if (fromSearch && isPhone() && t.kind !== 'video') openSheet();
      return;
    }
    if (libNavBusy) return;
    libNavBusy = true;
    try {
      await switchLib(libId2);
      if (FM.fs.activeId !== libId2) return;
      const t = L.track(trackId);
      if (!t) { toast('这一集在新资源库里找不到了', 'warn'); return; }
      P.playTrack(t);
      if (fromSearch && isPhone() && t.kind !== 'video') openSheet();
    } finally { libNavBusy = false; }
  }

  /* ── 扫描节流 ──
     切库、重启 App 一律用缓存（index:<libId>）直接出内容，本次会话内不再自动扫盘：
     全量扫描要递归 readdir 并对每个文件 stat，在 NAS/机械盘上要几秒到几十秒。
     外部新增/删除的音频不会自动出现，由用户点「重新扫描」强制刷新（见 doScan）。
     只有连缓存都没有（新加的库、缓存被清）时才自动扫一次，否则界面是空的。 */
  const scannedThisRun = new Set();
  function needRescan(id) {
    if (!id) return false;
    if (scannedThisRun.has(id)) return false;
    const c = FM.db.index(id);
    return !(c && c.albums && c.albums.length);
  }

  /* 服务端模式：别人（桌面 / 网页 / 主机自动监听）扫完写进服务端缓存后，把那份索引静默同步过来。
     全程 refresh=false，只是在服务端读缓存，不会触发走盘。
     调用时机：启动 / 回前台 / 切库 / 重连，以及前台每 60 秒的周期检查（js/app.js）。
     需要立刻刷新时也可以用顶栏设置里的「重新扫描」手动触发一次主机重扫。
     gap 是两次机会性检查之间的最小间隔：切库 / 启动用默认 30 秒，回前台用 5 分钟
     （回前台那几百毫秒是 WebView 重新出图的窗口，别在那儿做下载 + 解析 + 重绘的重活）。 */
  let stampCheckedAt = 0;
  async function syncScanIfNewer(gap) {
    if (!FM.fs.server || !FM.fs.activeId) return false;
    /* 手动扫描在跑的时候别插一脚 */
    if (navLocked()) return false;
    const now = Date.now();
    if (now - stampCheckedAt < (Number(gap) || 30000)) return false;
    stampCheckedAt = now;
    const id = FM.fs.activeId;
    /* 口径变了（别的设备改了「目录结构」）就立刻按新口径重算一遍，不必等服务端重扫 */
    const cached = FM.db.index(id);
    const cachedMode = cached ? (cached.dirMode === undefined ? (cached.dirGroup ? 'cat' : 'flat') : cached.dirMode) : 'flat';
    if (cached && cachedMode !== libDirMode(FM.fs.active())) {
      try { return await runScan({ silent: true, quiet: true, libId: id, background: true }); } catch (e) { return false; }
    }
    let at = 0;
    try { at = await FM.fs.scanStamp(); } catch (e) { return false; }
    /* 服务端那份比本地索引新才同步；期间切了库就作废。
       两边比的是「扫描方写的时间戳」（L.build 取 scan.scannedAt），不是本地时钟 */
    if (!at || at <= FM.lib.scannedAt || id !== FM.fs.activeId) return false;
    /* quiet：同步缓存不该弹「正在扫描资源库…」 */
    try { return await runScan({ silent: true, quiet: true, libId: id, background: true }); } catch (e) { return false; }
  }

  /* 进入当前库：有缓存直接秒出，不再后台补扫 */
  async function enterLib(opts) {
    const o = opts || {};
    const id = FM.fs.activeId;
    if (!id) { L.clear(); renderAll(); renderWelcome(); return; }
    /* 先把库模块的上下文切到当前库：pullMeta 的 applyMeta 用 rootKey 当前缀，
       不能等后面的 restore 才切，否则整理会写到上一个库的键下 */
    try { L.prime(id); } catch (e) {}
    /* 先把库里的元数据（分类 / 整理 / 进度）拉下来，分类才带得出来：桌面走 IPC、网页和手机走接口 */
    if (FM.fs.canSyncMeta()) { try { await FM.fs.pullMeta(); } catch (e) {} }
    const cached = o.force ? null : FM.db.index(id);
    /* 目录结构跟缓存对不上（另一台设备改过）：这份缓存是按旧口径算的，
       直接 restore 会显示错的专辑数，重扫一遍（读宿主扫描缓存，不走盘） */
    const cachedMode = cached && (cached.dirMode === undefined ? (cached.dirGroup ? 'cat' : 'flat') : cached.dirMode);
    if (cached && cached.albums && cached.albums.length && cachedMode !== libDirMode(FM.fs.active())) {
      await runScan({ silent: true, libId: id });
      return;
    }
    if (cached && cached.albums && cached.albums.length) {
      try { await FM.covers.load(); } catch (e) {}
      /* 拉封面期间已经切走了：这份索引属于旧库，再 restore + 渲染就会串到新库头上 */
      if (id !== FM.fs.activeId) return;
      L.restore(id);
      FM.store.write('lastLib', id);
      FM.store.touch('lastLib');
      renderAll();
      /* 切库后顺手把这库的元数据落一份，远程那边才有东西可读 */
      if (FM.app && FM.app.scheduleMetaWrite) FM.app.scheduleMetaWrite(1500, true);
      /* 只有这库完全没有缓存时才补扫；期间已经切走就不扫了 */
      if (needRescan(id)) setTimeout(function () { if (id === FM.fs.activeId) autoRescan(true); }, 1200);
      /* 主机那边可能刚扫过：顺手问一下时间戳，有更新的就静默同步（不触发扫描） */
      else syncScanIfNewer();
      return;
    }
    await runScan({ silent: true });
  }

  function resetView() {
    state.view = 'home'; state.cat = null; state.albumId = null;
    state.q = ''; state.detailQ = ''; state.page = 0; state.trackShown = PAGE;
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
  /* 手动扫描只允许一个在跑：连点会把整库 readdir + stat 叠成好几份，进度条也会互相掐 */
  let doScanBusy = false;
  async function doScan() {
    /* 没有资源库时「扫描」其实是引导去添加：普通用户这里也要拦（不能添加） */
    if (!FM.fs.hasSource) {
      if (!canManageLib()) { toast('只有管理员可以添加资源库', 'warn'); return; }
      addLibFlow(); return;
    }
    /* 网页端普通用户：禁用整库扫描（扫描是主机操作，普通用户只读） */
    if (!canManageLib()) { toast('只有管理员可以扫描资源库', 'warn'); return; }
    if (doScanBusy || navLocked()) { toast('正在扫描资源库，请稍候'); return; }
    doScanBusy = true;
    try {
      setScanBusy(true, '准备中…');
      if (FM.fs.canSyncMeta()) { try { await FM.fs.pullMeta(); } catch (e) {} }
      if (!FM.fs.granted) {
        const ok = await FM.fs.grant();
        if (!ok) throw new Error('目录授权被拒绝');
      }
      await runScan();
    } catch (e) {
      toast(e.message || '扫描失败', 'warn');
    } finally {
      doScanBusy = false;
      setScanBusy(false);
    }
  }

  /* 内容指纹：专辑集合、集数、时长、体积、分类、收藏，任一变化才算更新 */
  function libSignature() {
    /* 分类也算进指纹：远程只改了分类名/颜色时，专辑指纹不变也要重绘 */
    const catsSig = L.cats().map(function (c) { return [c.id, c.name, c.color, c.order].join(':'); }).join('|');
    return catsSig + '#' + L.albums().map(function (a) {
      return [a.id, a.count, a.duration, a.size, a.fav ? 1 : 0, a.hidden ? 1 : 0, (a.cats || []).join('+')].join(',');
    }).join('|');
  }

  let scanSeq = 0;
  /* stale 结果等后台扫完再读一次：一分钟一次，最多十次（覆盖服务端 10 分钟等待上限）。
     stale 只是「先给你旧的结果」，服务端/主进程那次 walk 还在跑，落盘后时间戳会变，
     所以判据用 scannedAt 有没有前进，而不是这次读到的数据看起来新不新
     （重试读的是缓存，缓存没更新时它照样能读出来，「不 stale」不等于「扫完了」） */
  let staleRetry = 0;
  function retryAfterStale(libId) {
    const my = ++staleRetry;
    const baseAt = FM.lib.scannedAt;
    let tries = 0;
    const timer = setInterval(async function () {
      if (my !== staleRetry || libId !== FM.fs.activeId || ++tries > 10) { clearInterval(timer); return; }
      if (navLocked()) return;
      /* refresh 不带：只读服务端/主进程的扫描缓存，不走盘 */
      try { await runScan({ silent: true, quiet: true, libId, background: true }); } catch (e) {}
      if (FM.lib.scannedAt > baseAt) clearInterval(timer);
    }, 60000);
  }

  async function runScan(opts) {
    const o = opts || {};
    const libId = o.libId || FM.fs.activeId;
    if (!libId || libId !== FM.fs.activeId) return false;
    /* quiet：只是后台同步一下缓存（比如回前台问时间戳），不弹扫描指示条，
       否则顶栏会闪一行「正在扫描资源库…」，用户以为在扫盘 */
    const showBusy = !o.quiet;
    /* 收藏可能在别的端刚改过：扫描前重拉一次，别让界面停在旧状态 */
    try { await FM.fs.loadFavs(libId); } catch (e) {}
    const my = ++scanSeq;
    /* 手动扫描 / 切库后的首次扫描会锁导航；后台静默同步不锁。
       locked 单独记一份：加锁后中途出错也只释放自己这一把 */
    const wantLock = !o.background;
    let locked = false;
    let progressTimer = 0;
    try {
      if (wantLock) { lockNav(); locked = true; showScanMask(); }
      /* 网盘库逐层列目录很慢：扫描期间并发轮询进度，用户能看出还在动 */
      const scanLib = FM.fs.libs().find(function (x) { return x.id === libId; });
      if (showBusy && FM.fs.server && scanLib && scanLib.type === 'alist') {
        setScanBusy(true, '正在扫描网盘，大库可能需要几分钟…');
        progressTimer = setInterval(function () {
          FM.fs.scanProgress(libId).then(function (p) {
            if (!p || !p.running) return;
            const tip = '网盘扫描中：' + (p.dirs || 0) + ' 个目录 · ' + (p.files || 0) + ' 个文件';
            setScanBusy(true, tip);
            if (refs.scanMaskHint) refs.scanMaskHint.textContent = tip;
          });
        }, 2000);
      } else if (showBusy) {
        setScanBusy(true, '正在扫描资源库…');
      }
      /* 只有手动「重新扫描」才让服务端/主进程真的走盘；静默补扫一律读它们的扫描缓存 */
      const scan = await FM.fs.scan(function (p) {
        const tip = p.phase === 'list'
          ? '发现 ' + p.count + ' 个音频…'
          : '读取文件信息 ' + p.done + ' / ' + p.total;
        if (showBusy) setScanBusy(true, tip);
        /* 静默扫描不弹顶栏提示，但遮罩在自己显示，进度照样要动 */
        else if (wantLock && refs.scanMaskHint) refs.scanMaskHint.textContent = tip;
      }, { refresh: !o.silent });
      /* 扫描期间切了库：这份结果属于上一个库，直接丢掉，别把界面串了 */
      if (libId !== FM.fs.activeId) return false;
      /* 换库或刚抓完封面时，索引会变，重新读一遍 */
      try { await FM.covers.load(); } catch (e) {}
      if (libId !== FM.fs.activeId) return false;
      /* 静默补扫先记内容指纹：扫完一模一样就不重绘，页面不会无端跳一下 */
      const before = o.silent ? libSignature() : '';
      L.build(scan);
      /* 这次会话已经完整扫过这个库了，后面切回来直接用缓存 */
      scannedThisRun.add(libId);
      if (FM.fs.activeId) {
        FM.store.write('lastLib', FM.fs.activeId);
        FM.store.touch('lastLib');
      }
      if (!o.silent) renderAll();
      else if (libSignature() !== before) renderAll({ quiet: true });
      if (scan.failed) {
        /* 后台那次扫描已经失败（不是超时）：不能把旧结果当成「扫描完成」 */
        if (!o.silent) toast('扫描失败（' + (scan.error || '网盘异常') + '），先显示上次的结果，请稍后重试', 'warn');
      } else if (scan.stale) {
        /* 服务端等满等待上限还没扫完，先给上次的结果；它还在后台接着扫，
           扫完会落盘，所以隔一分钟后重试读缓存，拿到新内容就自动换上去 */
        if (!o.silent) toast('库太大，扫描还在后台继续，先显示上次的结果', 'warn');
        retryAfterStale(libId);
      } else if (!o.silent) {
        toast('资源库已更新：' + L.albums().length + ' 个专辑 · ' + L.tracks().length + ' 集');
      }
      /* 服务端扫完也会在后台补封面，隔一会儿读一次索引，拿到新图就重绘 */
      if (FM.fs.server && scan.coversPending) watchCovers(libId);
      return true;
    } finally {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = 0; }
      if (locked) unlockNav();
      /* 只有最新那次扫描能收起进度，旧扫描收尾不许关掉新扫描的提示；
         quiet 的那次本来就没弹，别去关别人正在显示的进度 */
      if (showBusy && my === scanSeq) setScanBusy(false);
      if (wantLock) hideScanMask();
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
    /* 已经在扫了就别再排一次：叠着扫会互相覆盖结果 */
    if (navLocked()) return;
    const libId = FM.fs.activeId;
    try {
      /* 带上发起时的库 id：定时器到点时如果已经切走了，这次补扫直接作废 */
      await runScan({ silent: true, libId, background: true });
    } catch (e) {
      console.warn('[scan] 自动扫描失败', e);
      if (!silent) toast(U.NET_FAIL, 'warn');
    }
  }

  function syncMode() {
    document.body.classList.toggle('is-server', !!FM.fs.server);
    /* 退出登录只对浏览器直连服务器有意义：Electron 界面没有登录态。
       用 serverReached（是否连到服务端）而不是 server（是否有资源库）——没加库的网页用户也要能登出 */
    if (refs.btnLogout) {
      refs.btnLogout.hidden = !(!!FM.fs.serverReached && !FM.fs.desktop && !FM.android);
    }
    /* 网页端普通用户禁用扫描（只读）：侧栏同步按钮直接隐藏（连同 disabled / 置灰样式兜底） */
    if (refs.btnSync) {
      const canScan = canManageLib();
      refs.btnSync.hidden = !canScan;
      refs.btnSync.disabled = !canScan;
      refs.btnSync.classList.toggle('is-disabled', !canScan);
      refs.btnSync.title = canScan ? (refs.btnSync.title || '重新扫描当前资源库') : '只有管理员可以扫描资源库';
    }
    paintVersion();
  }

  /* 左侧 logo 旁显示当前程序版本：Electron 读 app 版本，APK 读壳版本，浏览器读服务端 package.json */
  function paintVersion() {
    const el = refs.brandVer;
    if (!el) return;
    const v = appVersion();
    el.textContent = v ? 'v' + v : '';
    el.hidden = !v;
  }

  /* 启动遮罩还盖着的时候不必真画：那几次整页重建用户一帧都看不见，
     攒到遮罩撤掉之前统一画一次（冷启动本来会重建 3 次，现在 1 次） */
  let bootPending = false;
  function bootVisible() {
    const b = document.getElementById('boot');
    return !!(b && !b.classList.contains('hide'));
  }

  function renderAll(opts) {
    if (bootVisible()) { bootPending = true; return; }
    bootPending = false;
    popSig = '';          /* 库数据可能刚变过，建议面板下次重绘别复用旧 DOM */
    syncMode();
    renderNav();
    renderCats();
    renderStat();
    renderMain(opts);
  }

  /* 账号级偏好从数据库回来（换设备 / 另一端刚改过）：跟着刷新排序与隐藏开关 */
  function applyPrefs() {
    state.sortDesc = !!FM.db.state().sortDesc;
    state.showHidden = !!FM.db.state().showHidden;
    if (FM.lib && FM.lib.albums().length) renderAll({ quiet: true });
  }

  /* 由 app.js 在撤遮罩前调用：把启动期间攒下的那一次渲染补上 */
  function flushBootRender() {
    if (!bootPending) return;
    bootPending = false;
    syncMode();
    renderNav();
    renderCats();
    renderStat();
    renderMain();
  }

  /* 返回键 / 手势的统一收口：从最上层浮层往下收，返回 true 表示这一下被界面吃掉了。
     弹窗和抽屉按打开顺序登记在 layerStack 里，直接调自己的 close()，不靠合成事件猜；
     菜单、封面预览、播放页这些各只有一处，按层级从高到低单独收。 */
  function closeTopLayer() {
    if (!refs.modalRoot) return false;   /* 还没 init 完，壳里按了返回 */
    if (coverViewerEl) { closeCoverViewer(); return true; }
    if (menuEl) { closeMenu(); return true; }
    if (layerStack.length) { layerStack[layerStack.length - 1](); return true; }
    if (queueOpen) { toggleQueue(); return true; }
    if (refs.sheet.classList.contains('open')) { closeSheet(); return true; }
    if (refs.sidebar.classList.contains('open')) { closeDrawer(); return true; }
    if (refs.searchPop && !refs.searchPop.hidden) { popClose(); return true; }
    return false;
  }

  FM.ui = {
    init, renderAll, flushBootRender, paintTrack, syncMode, downloadsChanged,
    closeTopLayer,
    autoRescan, runScan, enterLib, switchLib, addLibFlow, needRescan, syncScanIfNewer,
    openLibMenu, openLibDrawer, renderStat, renderWelcome, renderBrokenLib,
    restorePlayerBar, refreshBarTime, applyPrefs,
    toast, cacheBroken, clearLocalCache, openSheet, closeSheet,
    checkUpdate, updateProgress,
    get refs() { return refs; }
  };
})(window.FM);
