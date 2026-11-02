// 实测 SSE 推送间隔，确认没有重复推送
const base = 'http://127.0.0.1:8090';
const ac = new AbortController();
const rs = await fetch(base + '/api/stream', { signal: ac.signal });
const rd = rs.body.getReader();
const dec = new TextDecoder();
let buf = '';
const stamps = [];
const t0 = Date.now();

while (Date.now() - t0 < 5000) {
  const { value, done } = await rd.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop();
  for (const p of parts) {
    if (!p.startsWith('data: ')) continue;
    const m = JSON.parse(p.slice(6));
    if (m.type === 'snapshot') stamps.push({ at: Date.now() - t0, ts: m.data.ts });
  }
}
ac.abort();

console.log('snapshot 帧数:', stamps.length);
console.log('到达时刻(ms):', stamps.map((s) => s.at).join(', '));
console.log('数据 ts 间隔(ms):', stamps.slice(1).map((s, i) => s.ts - stamps[i].ts).join(', '));
if (stamps.length > 1) {
  // 首帧是连接时补发的即时快照，之后才是周期推送，比较时跳过首帧
  const gaps = stamps.slice(2).map((s, i) => s.ts - stamps[i + 1].ts);
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  console.log('周期帧数据 ts 间隔(ms):', gaps.join(', '));
  // setInterval 有正常抖动，容忍 ±15%
  const ok = gaps.length > 0 && min >= 850 && max <= 1150;
  console.log(
    ok
      ? `PASS 推送周期稳定在 1s 左右（抖动 ${min}~${max}ms），且无重复帧`
      : `FAIL 推送间隔异常（${min}~${max}ms），可能存在重复推送或阻塞`
  );
  process.exit(ok ? 0 : 1);
}
