/* ── util.js ─────────────────────────────────────────── */
window.FM = window.FM || {};
(function (FM) {
  'use strict';
  const U = FM.util = {};

  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  U.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null || c === false) return;
        node.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c)) : c);
      });
    }
    return node;
  };

  U.icon = function (name, cls) {
    return '<svg class="i ' + (cls || '') + '"><use href="#i-' + name + '"/></svg>';
  };

  U.fmtTime = function (sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  };

  U.fmtDur = function (sec) {
    if (!sec) return '0 分钟';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h > 0) return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
    return m + ' 分钟';
  };

  U.fmtSize = function (bytes) {
    if (!bytes) return '—';
    const gb = bytes / 1073741824;
    if (gb >= 1) return gb.toFixed(gb >= 10 ? 1 : 2) + ' GB';
    return Math.max(1, Math.round(bytes / 1048576)) + ' MB';
  };

  U.fmtAgo = function (ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    const min = Math.floor(d / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' 小时前';
    const day = Math.floor(h / 24);
    if (day < 30) return day + ' 天前';
    const dt = new Date(ts);
    return (dt.getMonth() + 1) + ' 月 ' + dt.getDate() + ' 日';
  };

  /* 自然排序：第2集 < 第10集 */
  const RE = /(\d+)|(\D+)/g;
  U.naturalCompare = function (a, b) {
    a = String(a); b = String(b);
    const ax = a.match(RE) || [], bx = b.match(RE) || [];
    const n = Math.min(ax.length, bx.length);
    for (let i = 0; i < n; i++) {
      const x = ax[i], y = bx[i];
      const xn = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57;
      const yn = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57;
      if (xn && yn) {
        const d = Number(x) - Number(y);
        if (d) return d;
      } else {
        const d = x.localeCompare(y, 'zh-Hans-CN', { sensitivity: 'variant' });
        if (d) return d;
      }
    }
    return ax.length - bx.length;
  };

  U.hash = function (s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  U.uid = (prefix, s) => prefix + U.hash(s).toString(36);

  U.PALETTE = [
    ['#22d3ee', '#4f46e5', '#8b5cf6'],
    ['#a855f7', '#6d28d9', '#ec4899'],
    ['#ec4899', '#8b5cf6', '#6366f1'],
    ['#0ea5e9', '#22d3ee', '#14b8a6'],
    ['#14b8a6', '#0ea5e9', '#6366f1'],
    ['#6366f1', '#a855f7', '#ec4899'],
    ['#f59e0b', '#ef4444', '#a855f7'],
    ['#10b981', '#0ea5e9', '#4f46e5'],
    ['#f472b6', '#a855f7', '#6366f1'],
    ['#38bdf8', '#6366f1', '#a855f7']
  ];

  U.coverColors = function (seed) {
    const p = U.PALETTE[seed % U.PALETTE.length];
    return [p[0], p[1]];
  };

  U.coverVars = function (seed) {
    const c = U.coverColors(seed);
    return '--c1:' + c[0] + ';--c2:' + c[1] + ';--c3:' + U.PALETTE[seed % U.PALETTE.length][2];
  };

  U.stripExt = n => n.replace(/\.[^.]+$/, '');

  U.initials = function (title) {
    let t = String(title || '').trim();
    if (!t) return '声';
    const m = t.match(/《([^》]+)》/);
    if (m) return m[1].slice(0, 2);
    t = t.replace(/[\s·・|丨—\-:：《》]/g, '');
    if (t.length > 3 && /^[被第]/.test(t)) t = t.slice(1);
    return t.slice(0, 2) || '声';
  };

  U.escape = function (s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  U.clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  U.debounce = function (fn, wait) {
    let t = 0;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), wait);
    };
  };

  U.throttle = function (fn, wait) {
    let last = 0, timer = 0;
    return function () {
      const now = Date.now(), args = arguments, self = this;
      const rest = wait - (now - last);
      if (rest <= 0) { last = now; fn.apply(self, args); }
      else if (!timer) {
        timer = setTimeout(() => { timer = 0; last = Date.now(); fn.apply(self, args); }, rest);
      }
    };
  };

  U.emitter = function () {
    const map = new Map();
    return {
      on(k, fn) {
        if (!map.has(k)) map.set(k, new Set());
        map.get(k).add(fn);
        return () => map.get(k) && map.get(k).delete(fn);
      },
      emit(k) {
        const set = map.get(k);
        if (!set) return;
        const args = Array.prototype.slice.call(arguments, 1);
        set.forEach(fn => { try { fn.apply(null, args); } catch (e) { console.error('[emit]', k, e); } });
      }
    };
  };

  U.raf = () => new Promise(r => requestAnimationFrame(() => r()));
  U.sleep = ms => new Promise(r => setTimeout(r, ms));
})(window.FM);
