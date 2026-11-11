/* ── wma → 边解码边编码 Worker（classic worker）────────────────────
 *
 * 两种模式：
 *   stream  → 分块解码 + LAME 编码成 MP3，边转边把块发回主线程，
 *             主线程塞进 MSE（audio/mpeg）即时播放。首块只要几百 KB。
 *   blob    → 整段转成 Ogg Vorbis（体积最小），供 MSE 不可用时降级。
 *
 * 为什么是 classic worker：编码器只有 UMD 包，它在顶层用 `this` 挂全局，
 * module 作用域里 this 是 undefined 会直接抛错。解码器是 ESM，用动态 import 进来。
 */
importScripts('./encoder.min.js');

const Enc = self.WasmMediaEncoder;
const CHUNK = 256 * 1024;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

self.onmessage = async function (ev) {
  const m = ev.data || {};
  if (m.type !== 'start') return;
  try {
    if (m.mode === 'stream') await runStream(m);
    else await runBlob(m);
  } catch (e) {
    post({ type: 'error', message: (e && e.message) || String(e) });
  }
};

async function rangeRead(url, start, end) {
  const r = await fetch(url, { headers: { range: 'bytes=' + start + '-' + end }, cache: 'no-store' });
  if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
  return await r.arrayBuffer();
}

async function probeSize(url) {
  const r = await fetch(url, { headers: { range: 'bytes=0-1' }, cache: 'no-store' });
  const cr = r.headers.get('content-range');
  try { await r.arrayBuffer(); } catch (e) {}
  const n = cr && cr.indexOf('/') > 0 ? Number(cr.split('/')[1]) : 0;
  if (!n) throw new Error('无法确定文件大小');
  return n;
}

/* ── 流式：wma → mp3 —— */
async function runStream(m) {
  const { decoder, demuxASF } = await import('./decoder.js');
  const size = m.size || await probeSize(m.url);

  /* 先读头部拿时长/声道/采样率：主线程要用时长设 MediaSource.duration，
     否则进度条和 seekable 都是 NaN */
  const headLen = Math.min(65536, size);
  const head = new Uint8Array(await rangeRead(m.url, 0, headLen - 1));
  let asf = null;
  try { asf = demuxASF(head); } catch (e) {}
  const inRate = (asf && asf.sampleRate) || 44100;
  const channels = (asf && asf.channels) || 1;
  post({
    type: 'meta',
    duration: (asf && asf.duration) || 0,
    sampleRate: inRate,
    channels: channels,
    bitRate: (asf && asf.bitRate) || 0,
    packetSize: (asf && asf.packetSize) || 0
  });

  const outRate = (m.targetRate && m.targetRate < inRate) ? m.targetRate : inRate;
  /* 码率按实际声道定：单声道 48k 对语音够用（10 分钟 3.6MB），
     立体声给 80k，否则音乐类 WMA 会糊成一片（10 分钟约 6MB）。
     LAME 在 MPEG-2（22050Hz）下 8~160kbps 都合法 */
  const bitrate = m.bitrate || (channels > 1 ? 80 : 48);
  const wasmAb = await (await fetch('./mp3.wasm')).arrayBuffer();
  const enc = await Enc.createEncoder('audio/mpeg', wasmAb);
  enc.configure({ sampleRate: outRate, channels: channels, bitrate: bitrate });

  const dec = await decoder();
  /* 每声道一个跨块连续的重采样器：块边界不能重新起相位，否则每 30 秒一个采样
     的断裂，听感上是轻微的「咔」 */
  const mkRs = outRate === inRate ? null : makeResampler(inRate, outRate);
  const rs = mkRs ? [] : null;
  function toOutRate(channelData) {
    if (!mkRs) return channelData;
    return channelData.map(function (c, i) {
      if (!rs[i]) rs[i] = mkRs();
      return rs[i](c);
    });
  }

  let read = 0;
  let totalOut = 0;

  while (read < size) {
    const end = Math.min(read + CHUNK, size) - 1;
    const bytes = new Uint8Array(await rangeRead(m.url, read, end));
    const r = dec.decode(bytes);
    read = end + 1;
    if (r.channelData.length && r.channelData[0].length) {
      const pcm = toOutRate(r.channelData);
      if (pcm[0].length) emit(enc, pcm);
    }
    post({ type: 'progress', stage: 'encode', done: read, total: size });
  }

  const tail = dec.flush();
  if (tail.channelData.length && tail.channelData[0].length) {
    const pcm = toOutRate(tail.channelData);
    if (pcm[0].length) emit(enc, pcm);
  }
  const fin = enc.finalize();
  if (fin && fin.length) {
    const copy = fin.slice();
    totalOut += copy.length;
    post({ type: 'chunk', bytes: copy.buffer, n: copy.length }, [copy.buffer]);
  }
  dec.free();
  post({ type: 'done', bytes: totalOut, duration: (asf && asf.duration) || 0, sampleRate: outRate });

  function emit(encoder, pcm) {
    const out = encoder.encode(pcm);
    if (!out || !out.length) return;
    const copy = out.slice();          // 编码器持有这块内存，必须复制
    totalOut += copy.length;
    post({ type: 'chunk', bytes: copy.buffer, n: copy.length }, [copy.buffer]);
  }
}

/* ── 整段：wma → ogg vorbis —— */
async function runBlob(m) {
  const { decoder } = await import('./decoder.js');
  const size = m.size || await probeSize(m.url);
  const buf = new Uint8Array(size);
  let read = 0;
  while (read < size) {
    const end = Math.min(read + 512 * 1024, size) - 1;
    buf.set(new Uint8Array(await rangeRead(m.url, read, end)), read);
    read = end + 1;
    post({ type: 'progress', stage: 'read', done: read, total: size });
  }

  const dec = await decoder();
  const r = dec.decode(buf);
  const tail = dec.flush();
  dec.free();
  const sr = r.sampleRate;
  let chs = [];
  for (let c = 0; c < r.channelData.length; c++) {
    const a = r.channelData[c];
    const b = tail.channelData[c] || new Float32Array(0);
    const o = new Float32Array(a.length + b.length);
    o.set(a); o.set(b, a.length);
    chs.push(o);
  }
  const dur = chs[0].length / sr;

  let outSr = sr;
  if (m.targetRate && m.targetRate < sr) {
    outSr = m.targetRate;
    chs = chs.map(function (c) { return resampleLinear(c, sr, outSr); });
  }

  const wasmAb = await (await fetch('./ogg.wasm')).arrayBuffer();
  const enc = await Enc.createEncoder('audio/ogg', wasmAb);
  enc.configure({ sampleRate: outSr, channels: chs.length, vbrQuality: m.quality == null ? 3 : m.quality });

  const parts = [];
  const STEP = outSr * 2;
  for (let i = 0; i < chs[0].length; i += STEP) {
    const e = Math.min(i + STEP, chs[0].length);
    const out = enc.encode(chs.map(function (c) { return c.subarray(i, e); }));
    if (out && out.length) parts.push(out.slice());
    post({ type: 'progress', stage: 'encode', done: e, total: chs[0].length });
  }
  const fin = enc.finalize();
  if (fin && fin.length) parts.push(fin.slice());

  let total = 0;
  for (const p of parts) total += p.length;
  const ogg = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { ogg.set(p, off); off += p.length; }

  post({
    type: 'done', bytes: ogg.buffer, bytesLen: ogg.length,
    duration: dur, sampleRate: outSr
  }, [ogg.buffer]);
}

/* 整段线性重采样：blob 模式一次性处理全部 PCM，没有块边界问题 */
function resampleLinear(input, from, to) {
  const ratio = to / from;
  const len = Math.max(0, Math.floor(input.length * ratio));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const p = i / ratio;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = input[i0] === undefined ? 0 : input[i0];
    const b = input[i0 + 1] === undefined ? a : input[i0 + 1];
    out[i] = a + (b - a) * f;
  }
  return out;
}

/* 跨块连续的线性重采样器工厂：每声道一个实例，块与块之间保留相位和上一个样本。
   之前每块独立重采样，块边界（约每 30 秒）会有一个采样的相位断裂，听感上轻微「咔」。
   用法：const mk = makeResampler(44100, 22050); const rs = mk(); rs(pcmChunk) */
function makeResampler(from, to) {
  const step = from / to;           // 每输出一个采样，输入前进多少
  return function () {
    let pos = 0;                    // 下一个输出采样在「当前块」里的位置（负数 = 落在上一块）
    let prev = 0;                   // 上一块最后一个输入采样
    return function (input) {
      const len = input.length;
      if (!len) return input;
      /* 输出点数最多 ceil(len / step) + 1（跨块那一个点），多留一个不会截断 */
      const out = new Float32Array(Math.ceil(len / step) + 2);
      let n = 0;
      let p = pos;
      for (;;) {
        const i0 = Math.floor(p);
        if (i0 + 1 >= len) break;   // 还差下一个采样才能插值：留到下一块接着算
        const a = i0 < 0 ? prev : input[i0];
        const b = (i0 + 1) < 0 ? prev : input[i0 + 1];
        out[n++] = a + (b - a) * (p - i0);
        p += step;
      }
      prev = input[len - 1];
      pos = p - len;                // 换到下一块的坐标系
      return n === out.length ? out : out.subarray(0, n);
    };
  };
}
