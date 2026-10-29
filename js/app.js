/* ── app.js · 启动流程 ───────────────────────────────── */
(function (FM) {
  'use strict';

  function hideBoot() {
    const node = document.getElementById('boot');
    if (!node) return;
    node.classList.add('hide');
    setTimeout(function () { node.remove(); }, 400);
  }

  /* ── 元数据快照：写到每个库目录下的 .fm-meta.json（远程端读这份） ── */
  let metaTimer = 0;
  let wantFull = true;     /* 启动后第一次、以及分类/元数据变化时写全部库 */

  function scheduleMetaWrite(delay, full) {
    if (!FM.fs.native) return;
    if (full) wantFull = true;
    if (metaTimer) return;              /* 已经在排队，别一直往后推 */
    metaTimer = setTimeout(function () {
      metaTimer = 0;
      writeMetaNow();
    }, delay == null ? 5000 : delay);
  }

  async function writeMetaNow() {
    if (!FM.fs.native) return;
    const full = wantFull;
    wantFull = false;
    /* 只有播放进度变了就别惊动其它库：它们的内容一个字都没变 */
    const libs = full ? FM.fs.libs() : [FM.fs.active()].filter(Boolean);
    if (!libs.length) return;
    const cats = FM.db.cats();
    const metas = FM.db.albumMeta();
    const prog = FM.db.progress();
    const durs = FM.db.durations();
    for (let i = 0; i < libs.length; i++) {
      const lib = libs[i];
      const root = String(lib.path || '');
      if (!root) continue;
      const snap = { v: 1, libId: lib.id, root: root, cats: cats, albumMeta: {}, progress: {}, durations: {} };
      const prefix = root + '|';
      Object.keys(metas).forEach(function (k) { if (k.indexOf(prefix) === 0) snap.albumMeta[k] = metas[k]; });
      /* 进度/时长按本库曲目 id 过滤；没缓存就先不传，服务端会保留文件里已有的 */
      const idx = FM.db.index(lib.id);
      if (idx && idx.tracks) {
        const set = new Set(idx.tracks.map(function (r) { return r[0]; }));
        Object.keys(prog).forEach(function (k) { if (set.has(k)) snap.progress[k] = prog[k]; });
        Object.keys(durs).forEach(function (k) { if (set.has(k)) snap.durations[k] = durs[k]; });
      }
      try { await window.fmNative.saveMeta(root, JSON.stringify(snap)); } catch (e) {}
    }
  }

  /* 反向：把文件里更新的进度（手机听出来的）合并回本地 */
  async function pullMetaFromDisk() {
    if (!FM.fs.native) return;
    const lib = FM.fs.active();
    if (!lib || !lib.path) return;
    let data = null;
    try { data = await window.fmNative.loadMeta(lib.path); } catch (e) {}
    if (!data) return;
    let changed = false;
    const prog = FM.db.progress();
    Object.keys(data.progress || {}).forEach(function (k) {
      const b = data.progress[k];
      if (!b) return;
      const a = prog[k];
      if (!a || (Number(b.t) || 0) > (Number(a.t) || 0)) { prog[k] = b; changed = true; }
    });
    if (changed) { FM.db.setProgress(prog); FM.db.touch('progress'); }
    const durs = FM.db.durations();
    let dch = false;
    Object.keys(data.durations || {}).forEach(function (k) {
      const v = Number(data.durations[k]) || 0;
      if (v > 0 && durs[k] !== v) { durs[k] = v; dch = true; }
    });
    if (dch) { FM.db.setDurations(durs); FM.db.touch('durations'); }
    if (changed || dch) FM.ui.renderAll();
  }

  function boot() {
    /* 兜底：初始化万一抛错，也不能让启动画面一直糊在屏幕上 */
    const guard = setTimeout(hideBoot, 8000);
    /* 首屏真正有东西可看了才收启动画面，别让它闪一下就留个空壳 */
    function reveal() { clearTimeout(guard); hideBoot(); }
    const lastId = FM.store.read('lastLib', null);
    let hasLib = false;
    if (lastId) {
      try { hasLib = FM.lib.restore(lastId); } catch (e) { console.warn('[boot] 恢复索引失败', e); }
    }

    FM.ui.init();

    /* 分类/收藏/进度/时长有变化就攒着写一次盘 */
    FM.store.onPersist(function (keys) {
      if (keys.indexOf('cats') >= 0 || keys.indexOf('albumMeta') >= 0 || keys.indexOf('durations') >= 0) {
        scheduleMetaWrite(5000, true);       /* 整理结果变了：所有库都刷新 */
      } else if (keys.indexOf('progress') >= 0) {
        scheduleMetaWrite(5000, false);      /* 只是听了会儿：只写当前库 */
      }
    });
    window.addEventListener('pagehide', function () { writeMetaNow(); });

    if (hasLib) {
      try {
        if (FM.player.restoreLast()) {
          FM.ui.paintTrack(FM.player.current);
        }
      } catch (e) { console.warn('[boot] 恢复上次播放失败', e); }
    }

    FM.fs.load().then(function (r) {
      /* 封面索引是独立文件，先加载再渲染一次，卡片就能直接显示真封面 */
      return FM.covers.load().then(function (n) {
        if (n) {
          FM.covers.apply();
          if (hasLib) FM.ui.renderAll();
          if (FM.player.current) FM.ui.paintTrack(FM.player.current);
        }
      }).catch(function () {}).then(function () {
        FM.ui.syncMode();
        FM.ui.renderStat();
        if (!r || !r.active) { FM.ui.renderWelcome(); reveal(); return; }
        if (r.missing) { FM.ui.renderBrokenLib(); reveal(); return; }
        const ready = function () {
          pullMetaFromDisk();
          scheduleMetaWrite(2000, true);
        };
        if (r.active !== lastId) {
          Promise.resolve(FM.ui.enterLib({ force: true })).then(function () { ready(); reveal(); });
        } else if (hasLib) {
          setTimeout(function () { FM.ui.autoRescan(); }, 1200);
          ready();
          reveal();
        } else {
          Promise.resolve(FM.ui.enterLib({})).then(function () { ready(); reveal(); });
        }
      });
    }).catch(function (e) { console.warn('[boot] 资源库载入失败', e); reveal(); });
  }

  /* 远程页面：桌面端刚加的库不用重启服务，切回来就能看到 */
  let libsAt = 0;
  async function refreshServerLibs() {
    if (!FM.fs.server) return;
    const now = Date.now();
    if (now - libsAt < 20000) return;
    libsAt = now;
    const changed = await FM.fs.refreshLibs();
    if (changed) {
      FM.ui.renderAll();
      FM.ui.toast('资源库列表已更新');
    }
  }

  /* 回到窗口时补一次：手机上刚听的位置能接上 */
  let focusAt = 0;
  window.addEventListener('focus', function () {
    const now = Date.now();
    if (now - focusAt < 60000) return;
    focusAt = now;
    if (FM.fs.native) pullMetaFromDisk();
    else refreshServerLibs();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshServerLibs();
  });

  /* 调试/自检用：手动触发一次元数据读写 */
  window.FM = window.FM || {};
  window.FM.app = { writeMetaNow, pullMetaFromDisk, scheduleMetaWrite };

  window.addEventListener('error', function (e) {
    if (e && e.message && /Script error/i.test(e.message)) return;
    console.error('[fm] 未捕获错误', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    console.warn('[fm] Promise 未被处理', e.reason);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.FM);
