'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

function loadWma() {
  const workers = [];
  const urls = [];
  global.window = {
    FM: {
      fs: {
        activeId: 'local-lib',
        src: async () => ({ url: 'blob:source', size: 123, version: '123|1000' })
      }
    }
  };
  global.MediaSource = undefined;
  global.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) {
      this.message = message;
      queueMicrotask(() => this.onmessage({ data: { type: 'done', bytes: new ArrayBuffer(1) } }));
    }
    terminate() { this.terminated = true; }
  };
  global.URL.createObjectURL = function () {
    const url = 'blob:output-' + urls.length;
    urls.push(url);
    return url;
  };
  global.URL.revokeObjectURL = function () {};
  vm.runInThisContext(fs.readFileSync(require.resolve('../js/wma.js'), 'utf8'), {
    filename: 'js/wma.js'
  });
  return { wma: window.FM.wma, workers, urls };
}

test('客户端 WMA：本地文件大小传给 Worker，文件版本变化不会复用旧缓存', async () => {
  const { wma, workers } = loadWma();

  const first = await wma.ensure('book/01.wma', { version: '123|1000' });
  assert.equal(first.cached, false);
  assert.equal(workers[0].message.size, 123);

  const second = await wma.ensure('book/01.wma', { version: '456|2000' });
  assert.equal(second.cached, false);
  assert.equal(workers.length, 2, '文件版本变化必须启动新的转码任务');
  assert.equal(workers[1].message.size, 123);
});
