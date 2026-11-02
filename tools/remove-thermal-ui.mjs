// 从 index.html 中移除 renderThermal 函数（温度模块已从页面删除）
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'public', 'index.html');
let s = fs.readFileSync(file, 'utf8');

const startMarker = '/** 硬件区块：温度 / 风扇 */';
const start = s.indexOf(startMarker);
if (start < 0) {
  console.log('FAIL: start marker not found');
  process.exit(1);
}

// 从函数开头往后找，定位到该函数的收尾（下一个顶格 '}' 后跟空行）
const afterStart = s.slice(start);
// 函数体以 "\n}\n" 结束，取第一个出现在 "function renderThermal" 之后的 "\n}\n"
const fnStart = afterStart.indexOf('function renderThermal');
const closeIdx = afterStart.indexOf('\n}\n', fnStart);
if (fnStart < 0 || closeIdx < 0) {
  console.log('FAIL: function bounds not found');
  process.exit(1);
}

const end = start + closeIdx + '\n}\n'.length;
const removed = s.slice(start, end);
s = s.slice(0, start) + s.slice(end);

fs.writeFileSync(file, s, 'utf8');
console.log(`removed ${removed.length} chars (${removed.split('\n').length} lines)`);
console.log('first line removed:', removed.split('\n')[0]);
console.log('last line removed :', removed.trimEnd().split('\n').pop());
