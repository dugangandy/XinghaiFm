/* ── media.js · 媒体格式白名单 ───────────────────────── */
(function (FM) {
  'use strict';

  /* 视频只收 Chromium 能直接解的容器；mkv / avi / rmvb 一律跳过。
     flv 能扫进来，但 Chromium 啃不动 FLV 容器，播放前要 remux 成 mp4（见 NEEDS_TC）。 */
  const VIDEO = { mp4: 1, m4v: 1, mov: 1, webm: 1, ogv: 1, flv: 1 };
  const AUDIO = { m4a: 1, m4b: 1, mp3: 1, aac: 1, flac: 1, wav: 1, ogg: 1, opus: 1, wma: 1, ape: 1, wv: 1 };

  /* Chromium 没有这些解码器（WMA / Monkey's Audio / WavPack），容器也认不全（FLV）：
     服务端或主进程先用 ffmpeg 转成 mp3 / mp4 再播，值就是目标容器。 */
  const NEEDS_TC = { wma: 'mp3', ape: 'mp3', wv: 'mp3', flv: 'mp4' };

  function isVideo(ext) {
    return !!VIDEO[String(ext || '').toLowerCase()];
  }

  function needsTranscode(ext) {
    return !!NEEDS_TC[String(ext || '').toLowerCase()];
  }

  FM.media = {
    VIDEO,
    AUDIO,
    ALL: Object.assign({}, AUDIO, VIDEO),
    NEEDS_TC,
    isVideo,
    needsTranscode,
    kindOf: ext => (isVideo(ext) ? 'video' : 'audio')
  };
})(window.FM);
