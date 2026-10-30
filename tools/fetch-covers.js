#!/usr/bin/env node
/* 旧命令的兼容入口：实现在根目录 cover-fetch.js（要打进安装包，所以不能放在 tools/），
 * 用法不变：node tools/fetch-covers.js --root "D:/有声书" [--force] [--only 关键字]
 */
require('../cover-fetch').cli();
