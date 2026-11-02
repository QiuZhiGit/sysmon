// 验证布局：进程 Top N 是否真的嵌在「内存利用率」卡片内部
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

// 取 body 部分做结构分析
const bodyStart = html.indexOf('<div class="grid grid-2">');
const bodyEnd = html.indexOf('<footer>');
const body = html.slice(bodyStart, bodyEnd);

const checks = [];

// 1) 温度模块已删除
checks.push(['温度模块已删除', !/温度|风扇|thermal|sensor-chip/.test(body)]);

// 2) 进程区块在内存卡片内
const memCardStart = body.indexOf('<span>内存利用率</span>');
const procSection = body.indexOf('class="proc-section"');
const memCardEnd = body.indexOf('</section>', memCardStart);
checks.push([
  '进程区块位于内存卡片内',
  memCardStart > 0 && procSection > memCardStart && procSection < memCardEnd,
  `memCard@${memCardStart} proc@${procSection} sectionEnd@${memCardEnd}`,
]);

// 3) 运行信息是最后一个卡片
const allSections = [...body.matchAll(/<h2><span>([^<]+)<\/span>/g)].map((m) => m[1]);
checks.push(['运行信息在最后', allSections[allSections.length - 1] === '运行信息', allSections.join(' > ')]);

// 4) CPU 与内存并排：取第一个 grid 容器到下一个 grid 容器之间的内容
const firstGridOpen = body.indexOf('<div class="grid grid-2">');
const secondGridOpen = body.indexOf('<div class="grid', firstGridOpen + 10);
const firstGridBlock = firstGridOpen >= 0 && secondGridOpen > firstGridOpen
  ? body.slice(firstGridOpen, secondGridOpen)
  : '';
checks.push([
  'CPU 与内存在同一行',
  firstGridBlock.includes('CPU 利用率') && firstGridBlock.includes('内存利用率'),
  firstGridBlock ? `区块长度 ${firstGridBlock.length}` : '未找到 grid 边界',
]);

// 5) 磁盘 I/O 与磁盘占用并排
const dioIdx = body.indexOf('磁盘 I/O 利用率');
const diskIdx = body.indexOf('磁盘占用');
const gridBlock = body.slice(Math.min(dioIdx, diskIdx), Math.max(dioIdx, diskIdx) + 100);
checks.push(['磁盘I/O与磁盘占用相邻', Math.abs(dioIdx - diskIdx) < 2000 && dioIdx > 0 && diskIdx > 0, `dio@${dioIdx} disk@${diskIdx}`]);

// 6) 没有孤立的 grid 空容器
const gridCount = (body.match(/<div class="grid/g) || []).length;
checks.push(['grid 容器数量合理', gridCount >= 3 && gridCount <= 6, `${gridCount} 个`]);

let pass = 0;
console.log('=== 布局结构验证 ===');
for (const [n, ok, d] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : ' -> ' + d}`);
  if (ok) pass++;
}
console.log(`\n卡片顺序: ${allSections.join(' → ')}`);
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
