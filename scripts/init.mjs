import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
try {
  const password = randomBytes(24).toString('base64url');
  const secret = randomBytes(48).toString('base64url');
  await writeFile('.env', `HOST=127.0.0.1\nPORT=3210\nPUBLIC_URL=http://localhost:3210\nHOMEAGENT_DB=./data/server.sqlite\nADMIN_PASSWORD=${password}\nSESSION_SECRET=${secret}\nTRUST_PROXY_HOPS=0\nAUDIT_RETENTION_DAYS=90\n`, { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env。管理员密码保存在 ADMIN_PASSWORD 中，请用本地编辑器查看。部署前设置 PUBLIC_URL。');
} catch (error) {
  if (error.code === 'EEXIST') { console.error('.env 已存在，未覆盖。'); process.exitCode = 1; }
  else throw error;
}
