/* 硬件加速状态：preload 早已就绪，这里在样式表之前挂好 class，避免首帧从轻特效闪到全特效。
   改成外部脚本，服务端 CSP 是 script-src 'self'，内联脚本会被拦下。 */
try {
  if (window.fmNative && window.fmNative.gpuAccel) document.documentElement.classList.add('hw');
} catch (e) {}
