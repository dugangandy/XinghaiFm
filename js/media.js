/* ── media.js · 媒体格式白名单 ───────────────────────── */
(function (FM) {
  'use strict';

  /* 视频只收 Chromium 能直接解的容器；mkv / avi / rmvb 一律跳过。
     flv 能扫进来，但 Chromium 啃不动 FLV 容器，播放前要 remux 成 mp4（见 NEEDS_TC）。 */
  const VIDEO = { mp4: 1, m4v: 1, mov: 1, webm: 1, ogv: 1, flv: 1 };
  const AUDIO = { m4a: 1, m4b: 1, mp3: 1, aac: 1, flac: 1, wav: 1, ogg: 1, opus: 1, wma: 1, ape: 1, wv: 1 };

  /* Chromium 认不全的容器（FLV）：服务端或主进程先用 ffmpeg 重封装成 mp4 再播，
     值就是目标容器。 */
  const NEEDS_TC = { flv: 'mp4' };

  /* 浏览器自己也能救的格式：前端 WASM 解码 + 重编码成 mp3，经 MSE 边转边播
     （见 js/wma.js）。只是**兜底**：桌面/服务端有 ffmpeg 时优先让 ffmpeg 转成
     真 mp3 文件（更快、拖动/续播都省心），只有没有 ffmpeg 时才走这条路。 */
  const CLIENT_TC = { wma: 1 };

  /* 能扫进来、但不做播放支持的格式：点了直接提示「不支持的文件格式」。
     ape / wv 缺少成熟的 WASM 解码器（同一套机制后续可以补），
     所以只保留在列表里（时长照常显示），点播放明确告诉你换格式。 */
  const UNSUPPORTED = { ape: 1, wv: 1 };

  function isVideo(ext) {
    return !!VIDEO[String(ext || '').toLowerCase()];
  }

  function needsTranscode(ext) {
    const e = String(ext || '').toLowerCase();
    return !!NEEDS_TC[e] || !!CLIENT_TC[e];
  }

  function clientTranscode(ext) {
    return !!CLIENT_TC[String(ext || '').toLowerCase()];
  }

  function unsupported(ext) {
    return !!UNSUPPORTED[String(ext || '').toLowerCase()];
  }

  FM.media = {
    VIDEO,
    AUDIO,
    ALL: Object.assign({}, AUDIO, VIDEO),
    NEEDS_TC,
    CLIENT_TC,
    UNSUPPORTED,
    isVideo,
    needsTranscode,
    clientTranscode,
    unsupported,
    kindOf: ext => (isVideo(ext) ? 'video' : 'audio')
  };
})(window.FM);
