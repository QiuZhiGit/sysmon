// 静态自检：内联脚本语法 + DOM id 引用完整性
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
console.log(`script blocks: ${blocks.length}`);
let ok = true;
blocks.forEach((b, i) => {
  try {
    new Function(b[1]);
    console.log(`  block ${i}: syntax OK (${b[1].length} chars)`);
  } catch (e) {
    ok = false;
    console.log(`  block ${i}: SYNTAX ERROR -> ${e.message}`);
  }
});

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));
const js = blocks.map((b) => b[1]).join('\n');
const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((x) => x[1]));
const missing = [...used].filter((u) => !ids.has(u));

console.log(`ids defined: ${ids.size}, referenced via $('id'): ${used.size}`);
console.log(`missing ids: ${missing.length ? missing.join(', ') : 'none'}`);

// canvas id 必须存在，否则图表直接崩
for (const need of ['cpuchart', 'memchart', 'diochart', 'netchart', 'cores', 'disks', 'sysinfo',
                    'events-body',
                    'net-rx', 'net-tx', 'net-ifaces', 'net-ts',
                    'proc-body', 'proc-ts']) {
  if (!ids.has(need)) { console.log(`MISSING required id: ${need}`); ok = false; }
}
console.log(ok && missing.length === 0 ? '\nRESULT: PASS' : '\nRESULT: FAIL');
process.exit(ok && missing.length === 0 ? 0 : 1);
