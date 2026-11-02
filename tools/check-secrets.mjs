// 推送前安全检查：扫描暂存内容中的凭据、隐私信息
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const files = execSync(`"${git}" diff --cached --name-only`, {
  cwd: process.cwd(),
  encoding: 'utf8',
})
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  // git 输出对非 ASCII 文件名做了转义，这里还原
  .map((s) => {
    if (!s.includes('"')) return s;
    const inner = s.slice(1, -1);
    return Buffer.from(
      inner.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))),
      'latin1'
    ).toString('utf8');
  });

const rules = [
  { name: 'GitHub Token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub PAT (classic)', re: /github_pat_[A-Za-z0-9_]{40,}/g },
  { name: '私钥', re: /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/g },
  { name: '密码/口令', re: /(password|passwd|pwd)\s*[:=]\s*["'][^"']{3,}["']/gi },
  { name: 'API Key 赋值', re: /(api[_-]?key|secret|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/gi },
  { name: 'AWS Key', re: /AKIA[0-9A-Z]{16}/g },
  { name: '内网 IPv4', re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'Windows 默认主机名', re: /\bWIN-[A-Z0-9]{11}\b/g },
  { name: '用户目录绝对路径', re: /C:\\\\?Users\\\\?Administrator/gi },
];

const findings = [];

for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue; // 二进制或读不了
  }
  for (const r of rules) {
    r.re.lastIndex = 0;
    const m = text.match(r.re);
    if (m) {
      // 去重并截断展示
      const uniq = [...new Set(m)].slice(0, 5);
      findings.push({ file: f, rule: r.name, hits: uniq });
    }
  }
}

console.log(`扫描 ${files.length} 个文件\n`);

if (!findings.length) {
  console.log('未发现凭据或隐私信息');
} else {
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  for (const [rule, list] of byRule) {
    console.log(`[${rule}] 出现在 ${list.length} 个文件:`);
    for (const it of list) {
      console.log(`  ${it.file}: ${it.hits.join(', ')}`);
    }
    console.log('');
  }
}
