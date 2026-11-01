/* ── safe.js · 登录页那点安全工具 ────────────────────
 * 单独放一个模块，方便用 node:test 直接测：
 *   node --test test
 */
'use strict';

/* HTML 转义：外部输入插进标签前必须过一遍 */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

/* 登录后跳回哪儿：只认站内单斜杠开头的相对路径。
   挡掉 //evil.com 这类协议相对跳转（浏览器会当外站），顺手去掉控制字符防头部注入 */
function safeNext(v) {
  const s = String(v || '').replace(/[\u0000-\u001f\u007f]/g, '');
  return /^\/(?![/\\])/.test(s) ? s : '/';
}

module.exports = { escHtml, safeNext };
