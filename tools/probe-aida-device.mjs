// 探测 AIDA64 驱动设备接口能否打开，以及暴露的 IOCTL 能力
// \Device\AIDA64Driver -> \DosDevices\AIDA64Driver
import fs from 'node:fs';

const candidates = [
  String.raw`\\.\AIDA64Driver`,
  String.raw`\\.\Global\AIDA64Driver`,
];

for (const dev of candidates) {
  try {
    const fd = fs.openSync(dev, 'r+');
    console.log(`OPEN OK   : ${dev}  (fd=${fd})`);
    fs.closeSync(fd);
  } catch (e) {
    console.log(`OPEN FAIL : ${dev}  -> ${e.code} ${e.message.slice(0, 90)}`);
  }
}

// 也尝试只读打开
for (const dev of candidates) {
  try {
    const fd = fs.openSync(dev, 'r');
    console.log(`READ-ONLY OK : ${dev}  (fd=${fd})`);
    fs.closeSync(fd);
  } catch (e) {
    console.log(`READ-ONLY FAIL : ${dev}  -> ${e.code}`);
  }
}
