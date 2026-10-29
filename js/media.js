/* ── media.js · 可收录的媒体扩展名 ───────────────────── */
(function (FM) {
  'use strict';

  /* 视频只收 Chromium 能直接解的容器，mkv / avi / flv / rmvb 一律跳过 */
  const VIDEO = { mp4: 1, m4v: 1, mov: 1, webm: 1, ogv: 1 };
  const AUDIO = { m4a: 1, m4b: 1, mp3: 1, aac: 1, flac: 1, wav: 1, ogg: 1, opus: 1, wma: 1, ape: 1 };

  function isVideo(ext) {
    return !!VIDEO[String(ext || '').toLowerCase()];
  }

  FM.media = {
    VIDEO,
    AUDIO,
    ALL: Object.assign({}, AUDIO, VIDEO),
    isVideo,
    kindOf: ext => (isVideo(ext) ? 'video' : 'audio')
  };
})(window.FM);
