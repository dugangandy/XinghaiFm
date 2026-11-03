/* ── app.js · 启动流程 ───────────────────────────────── */
(function (FM) {
  'use strict';

  /* 有硬件加速时，背景漂移和 logo 跳动都交给 CSS（见 css 里的 .hw 规则）：
     原生合成路径最平滑，也不用 JS 每帧写样式。没加速的机器才用下面这套低频驱动。 */
  const HW = document.documentElement.classList.contains('hw');

  /* 真实设备方向：软键盘弹出时视口被压矮、手机竖屏甚至会被压成「宽 > 高」，
     于是 CSS 的 (orientation:landscape) 和 max-height:560px 会把键盘当成手机横屏，
     横屏那套紧凑样式（专辑页封面 118 → 96、标题行数变少）就凭空生效，一点搜索框就抖。
     screen.orientation 跟软键盘无关，用它给 html 打类，横屏专用样式一律挂 .orient-land 前缀。 */
  function syncOrient() {
    const o = window.screen && window.screen.orientation;
    let land;
    if (o && typeof o.type === 'string' && o.type) land = o.type.indexOf('landscape') === 0;
    else land = Math.abs(Number(window.orientation) || 0) === 90;
    document.documentElement.classList.toggle('orient-land', land);
  }
  syncOrient();
  window.addEventListener('resize', syncOrient);
  window.addEventListener('orientationchange', syncOrient);

  function hideBoot() {
    const node = document.getElementById('boot');
    if (!node) return;
    /* 遮罩盖着的时候界面不真画，撤之前把攒下的那一次渲染补上 */
    if (FM.ui && FM.ui.flushBootRender) {
      try { FM.ui.flushBootRender(); } catch (e) { console.warn('[boot] 首屏渲染失败', e); }
    }
    node.classList.add('hide');
    setTimeout(function () { node.remove(); }, 400);
  }

  /* ── 元数据导出快照：写到每个库目录下的 .fm-meta.json
     真数据在 fm.db（网页/手机/桌面共用），这份只用于排查和回滚，程序不再读它 ── */
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
    const metas = FM.db.albumMeta();
    const prog = FM.db.progress();
    const durs = FM.db.durations();
    for (let i = 0; i < libs.length; i++) {
      const lib = libs[i];
      const root = String(lib.path || '');
      if (!root) continue;
      const snap = { v: 2, libId: lib.id, root: root, albumMeta: {}, progress: {}, durations: {} };
      /* 分类各自写各自的；这个库还没初始化过（null）就别写字段，免得拿空值盖掉别人写的 */
      const own = FM.db.catsFor(lib.id);
      if (own !== null) snap.cats = own;
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

  /* 反向：把数据库里更新的数据（网页/手机改的分类、手机听出来的进度）拉回本地缓存。
     名字沿用 pullMetaFromDisk：调用点（启动、回前台）不用改，数据源已经换成 fm.db。 */
  async function pullMetaFromDisk() {
    let touched = false;
    try { touched = await FM.fs.pullMeta(); } catch (e) {}
    if (!touched) return;
    /* 拉到新数据就同步内存模型（分类/标题/置顶/隐藏），再重绘 */
    try { FM.lib.refreshMeta(); } catch (e) {}
    try { FM.ui.renderAll(); } catch (e) {}
  }

  /* ── 背景漂移 ──
     CSS 无限动画在软件渲染的机器上会让合成器每帧重绘整个背景层，空闲就吃掉半个核。
     这里改成低频跳格：每 2 秒推进一次 --drift，帧与帧之间画面完全静止。
     50 步走完一个来回（约 100 秒），每步位移不到 3px，肉眼看不出来。 */
  const DRIFT_STEP_MS = 2000;
  const DRIFT_STEP = 0.02;
  let driftPhase = 0;
  let driftTimer = 0;

  function stepDrift() {
    driftPhase = (driftPhase + DRIFT_STEP) % 1;
    /* 余弦让两端速度归零，折返处不会顿一下 */
    const p = (1 - Math.cos(driftPhase * Math.PI * 2)) / 2;
    document.documentElement.style.setProperty('--drift', p.toFixed(3));
  }
  function startDrift() {
    if (HW || driftTimer) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    stepDrift();
    driftTimer = setInterval(stepDrift, DRIFT_STEP_MS);
  }
  function stopDrift() {
    if (driftTimer) { clearInterval(driftTimer); driftTimer = 0; }
  }

  /* ── 品牌 logo 的声波跳动 ──
     同样不用 CSS 动画：任何无限动画都会让合成器以 60fps 出帧，软件渲染下整屏每帧
     重新合成。这里每 100ms 写一次 scaleY，1.9s 一个来回，观感和原动画基本一致，
     合成开销只有原来的 1/6。曲线也照搬原来的 keyframes：0.5 → 1 → 0.5。 */
  const EQ_PERIOD_MS = 1900;
  const EQ_STEP_MS = 100;
  const EQ_DELAY_MS = [0, 160, 320, 480, 640];   /* 五根柱子依次起跳 */
  let eqBars = null;
  let eqTimer = 0;
  let eqT0 = 0;

  function stepEq() {
    if (!eqBars) {
      /* 侧栏品牌 mark + 开屏大 logo 都一起跳 */
      eqBars = document.querySelectorAll('.brand-mark.eq-mark span, .rc-logo.eq-mark span');
      if (!eqBars.length) return;
    }
    const now = Date.now();
    for (let i = 0; i < eqBars.length; i++) {
      /* 每个标记 5 根柱子：按组取延迟，多处方标按同一节拍起跳 */
      const delay = EQ_DELAY_MS[i % EQ_DELAY_MS.length];
      const phase = ((now - eqT0 - delay) / EQ_PERIOD_MS) * Math.PI * 2;
      const v = 0.75 - 0.25 * Math.cos(phase);
      eqBars[i].style.transform = 'scaleY(' + v.toFixed(3) + ')';
    }
  }
  function startEq() {
    if (HW || eqTimer) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    eqT0 = Date.now();
    stepEq();
    eqTimer = setInterval(stepEq, EQ_STEP_MS);
  }
  function stopEq() {
    if (eqTimer) { clearInterval(eqTimer); eqTimer = 0; }
  }

  /* 窗口失焦 / 切到后台时把这些装饰动画全停掉：被别的窗口盖住时合成器不会自己省电，
     照样重算，等于后台白烧一个核。只影响装饰层，音频和交互都不受牵连。
     两个状态函数做成幂等的：切回前台时 visibilitychange 早于 focus，hasFocus() 还是 false，
     老写法会先 idle() 再 live()，等于把三块 blur(90px) 的极光层停一下又立刻重启
     （--drift 被重写、EQ 重新起跳）。
     另外「不可见」时把最贵的几层装饰一起摘掉（bg-off，见 css 里的说明）：Chromium 在后台
     会回收已栅格化的瓦片，回前台那一次整屏重画因此又慢又黑，先摘掉它们能明显缩短这一下。 */
  function bindBgMotion() {
    const body = document.body;
    const idle = function () {
      if (body.classList.contains('bg-idle')) return;
      body.classList.add('bg-idle'); stopDrift(); stopEq();
    };
    const live = function () {
      if (!body.classList.contains('bg-idle')) return;
      body.classList.remove('bg-idle'); startDrift(); startEq();
    };
    /* 装饰层回挂要等恢复的那一帧过去：两帧之后再多给 300ms，别让它抢首帧的绘制预算 */
    function restoreDecor() {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          setTimeout(function () { body.classList.remove('bg-off'); }, 300);
        });
      });
    }
    window.addEventListener('blur', idle);
    window.addEventListener('focus', live);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        /* 只在真的不可见时摘：桌面上只是被别的窗口盖住时，背景不该突然少一块 */
        body.classList.add('bg-off');
        idle();
        hiddenAt = Date.now();
        hideResumeCover();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      restoreDecor();
      if (document.hasFocus()) live();
      else idle();
      /* 离开够久才铺过渡页：短暂切换本来就干净，不该每次回微信都糊一张图 */
      if (away >= COVER_AFTER_MS) showResumeCover();
    });
    startDrift();
    startEq();
  }

  /* ── 回到前台的过渡页 ─────────────────────────────────────
   * 安卓壳里切后台久了，系统会回收窗口表面 / 降级渲染进程，回来先黑一下才出内容。
   * 这是平台行为，网页改不了；学喜马拉雅的做法：恢复瞬间先铺一张品牌页，把那段空白
   * 变成过场，等真实界面画好再淡出。只给 APK 用 —— 桌面端切回来本来就是完整的。 */
  const COVER_AFTER_MS = 6000;   /* 后台超过这么久才铺 */
  const COVER_HOLD_MS = 1000;    /* 铺上之后停留多久（从可见起算）：给真实界面留足重绘时间，
                                    太短会出现「slogan 一闪就没了」再接着闪一下的感觉 */
  const COVER_FADE_MS = 240;     /* 淡出时长，必须和 css 里 .rc-gate 的 transition 一致 */
  const COVER_ENABLED = !!(typeof window !== 'undefined' && window.fmAndroid);
  let hiddenAt = 0;
  let coverTimers = [];

  function clearCoverTimers() {
    for (let i = 0; i < coverTimers.length; i++) clearTimeout(coverTimers[i]);
    coverTimers = [];
  }

  function showResumeCover() {
    if (!COVER_ENABLED) return;
    const node = document.getElementById('resumeCover');
    if (!node) return;
    clearCoverTimers();
    node.classList.remove('out');
    node.classList.add('on');          /* 立刻铺满：恢复后的第一帧就是它 */
    coverTimers.push(setTimeout(function () {
      node.classList.add('out');
      coverTimers.push(setTimeout(function () {
        node.classList.remove('on', 'out');   /* display:none 回去，别再占一层合成 */
      }, COVER_FADE_MS));
    }, COVER_HOLD_MS));
  }

  function hideResumeCover() {
    clearCoverTimers();
    const node = document.getElementById('resumeCover');
    if (node) node.classList.remove('on', 'out');
  }

  function boot() {
    /* 兜底：初始化万一抛错，也不能让启动画面一直糊在屏幕上 */
    const guard = setTimeout(hideBoot, 8000);
    bindBgMotion();
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
      const catsChanged = keys.some(function (k) { return k === 'cats' || k.indexOf('cats:') === 0; });
      if (catsChanged || keys.indexOf('albumMeta') >= 0 || keys.indexOf('durations') >= 0) {
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

    /* 后台补完封面：重读索引，卡片换成真封面，界面不闪 */
    if (window.fmNative && window.fmNative.onCovers) {
      window.fmNative.onCovers(function (info) {
        /* 补封面期间切了库，这次结果和当前库无关，忽略 */
        if (info && info.libId && FM.fs.activeId && info.libId !== FM.fs.activeId) return;
        FM.covers.load().then(function (n) {
          if (!n) return;
          FM.covers.apply();
          FM.ui.renderAll({ quiet: true });
          if (FM.player.current) FM.ui.paintTrack(FM.player.current);
        }).catch(function () {});
      });
    }

    FM.fs.load().then(function (r) {
      /* 老版本只有一份全局分类：按库名认「喜马拉雅」，一次性迁过去，迁完备份并删旧键 */
      let mig = { ran: false, reason: '' };
      try { mig = FM.lib.migrateCats(FM.fs.libs()); } catch (e) { console.warn('[boot] 分类迁移失败', e); }
      if (mig.ran) {
        /* 启动时那次 restore 用旧分类过滤过 a.cats，迁完要按新分类重算一次 */
        if (hasLib && mig.libId === FM.fs.activeId) { try { FM.lib.restore(FM.fs.activeId); } catch (e) {} }
        scheduleMetaWrite(1200, true);
        setTimeout(function () { FM.ui.toast('分类已迁移到「' + mig.libName + '」'); }, 900);
      } else if (mig.reason === 'nolib') {
        const st = FM.db.state();
        if (!st.catMigrateWarn) {
          st.catMigrateWarn = 1; FM.db.setState(st); FM.db.touch('state');
          setTimeout(function () { FM.ui.toast('没找到「喜马拉雅」资源库，分类暂未迁移', 'warn'); }, 900);
        }
      }
      /* 上一版把喜马拉雅库的分类写成空的：从备份补回来（只做一次，且专辑还指着这些分类时才补） */
      let rep = null;
      try { rep = FM.lib.repairCats(FM.fs.libs()); } catch (e) { console.warn('[boot] 分类恢复失败', e); }
      if (rep) {
        if (hasLib && rep.libId === FM.fs.activeId) { try { FM.lib.restore(FM.fs.activeId); } catch (e) {} }
        scheduleMetaWrite(1200, true);
        setTimeout(function () { FM.ui.toast('已把 ' + rep.count + ' 个分类恢复到「' + rep.libName + '」'); }, 900);
      }
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
          /* 有缓存就直接用，本次会话内不再自动扫盘（有变更点「重新扫描」） */
          if (FM.ui.needRescan(FM.fs.activeId)) setTimeout(function () { FM.ui.autoRescan(); }, 1200);
          /* 服务端模式下主机可能刚扫过：问一下时间戳，有更新就静默同步（不触发扫描） */
          else setTimeout(function () { FM.ui.syncScanIfNewer(); }, 1200);
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
    if (!changed) return;
    /* 请求飞行期间又切走了：这次不重建，但 refreshLibs() 已经把 libs/activeId 换成新的了，
       必须把节流时间戳清掉，否则 20 秒内界面还停在旧库列表上 */
    if (document.visibilityState === 'hidden') { libsAt = 0; return; }
    FM.ui.renderAll({ quiet: true });                     /* 恢复路径上别播入场动画 */
    FM.ui.toast('资源库列表已更新');
  }

  /* 回到窗口时补一次：手机上刚听的位置能接上。
     统一延后 600ms 再做：一回来就发请求、解析、甚至整页重建，会和 WebView 重新出图
     抢同一个主线程，那几帧正好是「切回来闪一下」的地方。 */
  function deferResume(fn) {
    setTimeout(function () {
      if (document.visibilityState === 'hidden') return;   /* 期间又切走了就别做 */
      try { fn(); } catch (e) { console.warn('[resume] 补数据失败', e); }
    }, 600);
  }
  let metaPullAt = 0;   /* 上次回前台补元数据的时间，用于节流 */

  let focusAt = 0;
  window.addEventListener('focus', function () {
    const now = Date.now();
    if (now - focusAt < 60000) return;
    focusAt = now;
    if (FM.fs.native) deferResume(pullMetaFromDisk);
    else deferResume(refreshServerLibs);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    deferResume(refreshServerLibs);
    /* 主机那边可能刚扫过新书（手机端没有扫描入口）：问一下时间戳，有就静默同步。
       回前台这条路径间隔拉长到 5 分钟——刚回到前台这几百毫秒要和 WebView 重新出图抢主线程 */
    deferResume(function () { FM.ui.syncScanIfNewer(5 * 60 * 1000); });
    /* 切回来再补一次分类/进度：别的端刚改过的东西能立刻看到。
       整份快照不小，一分钟内只拉一次 */
    const now = Date.now();
    if (now - metaPullAt < 60000) return;
    metaPullAt = now;
    deferResume(pullMetaFromDisk);
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
