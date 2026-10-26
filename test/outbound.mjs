// 出站图片：agent 调用 weixin_send_file -> getuploadurl -> CDN 上传 -> sendmessage(type 2)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockIlink } from './mock-ilink.mjs';

const HOME = os.homedir();
const PKG = path.resolve(import.meta.dirname, '..');
const TEST_HOME = path.join(PKG, '.test-out-home');
const TEST_ROOT = path.join(PKG, '.test-out');
const PROFILE = path.join(TEST_HOME, 'profiles', 'weixin-out-test');
const logFile = path.join(TEST_ROOT, 'dsh.log');

fs.rmSync(TEST_HOME, { recursive: true, force: true });
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_ROOT, 'accounts'), { recursive: true });
fs.mkdirSync(TEST_HOME, { recursive: true });
for (const f of ['.credentials.yaml', '.anonymous-user-id']) {
  fs.copyFileSync(path.join(HOME, '.dsh', f), path.join(TEST_HOME, f));
}
fs.writeFileSync(
  path.join(TEST_ROOT, 'out.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

const mock = await startMockIlink({ text: '把工作区的 out.png 文件发给我，用 weixin_send_file 工具。' });
console.log('mock:', mock.baseUrl);

fs.writeFileSync(
  path.join(TEST_ROOT, 'accounts', 'bot-test.json'),
  JSON.stringify({ token: 'test-token', accountId: 'bot-test', baseUrl: mock.baseUrl, userId: 'wxid_test_user', savedAt: new Date().toISOString() }),
);

fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(
  path.join(PROFILE, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-profile-weixin-out-test',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-channel-weixin'] } },
      dependencies: { 'dsh-channel-weixin': `link:${PKG}` },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(PROFILE, 'cordis.patch.yml'),
  `- id: weixin-channel
  config:
    accountsDir: ${TEST_ROOT}
    sessionPrefix: session-weixin-out-
    cwd: ${TEST_ROOT}
    provider: deepseek-official
    model: deepseek-flash
    approval: false
`,
);

const runtimeDir = path.join(TEST_ROOT, 'pnpm-runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const install = spawn('pnpm', ['install', '--ignore-scripts', '--prefer-offline'], {
  cwd: PROFILE,
  stdio: 'inherit',
  env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
});
if ((await new Promise((r) => install.on('exit', r))) !== 0) process.exit(1);

const out = fs.openSync(logFile, 'w');
const child = spawn('dsh', ['--profile', 'weixin-out-test'], {
  cwd: HOME,
  stdio: ['ignore', out, out],
  env: { ...process.env, DSH_HOME: TEST_HOME },
});

const deadline = Date.now() + 180_000;
let imageSent;
let failed;
while (Date.now() < deadline) {
  imageSent = mock.sent.find((s) => (s?.msg?.item_list ?? []).some((i) => i.type === 2));
  const texts = mock.sent.map((s) => s?.msg?.item_list?.[0]?.text_item?.text ?? '').filter(Boolean);
  failed = texts.find((t) => t.includes('发送失败') || t.includes('处理失败'));
  if (imageSent || failed) break;
  if (child.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 500));
}

const item = imageSent?.msg?.item_list?.find((i) => i.type === 2);
const ok = Boolean(item?.image_item?.media?.encrypt_query_param) && mock.uploads > 0 && !failed;
console.log('image item:', JSON.stringify(item)?.slice(0, 200));
console.log('uploads:', mock.uploads, '| failed:', failed ?? 'no');
if (!ok) console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n'));

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
fs.closeSync(out);
await mock.close();
if (ok) { fs.rmSync(TEST_HOME, { recursive: true, force: true }); fs.rmSync(TEST_ROOT, { recursive: true, force: true }); }
else console.log('kept:', TEST_HOME, TEST_ROOT);
fs.rmSync(PROFILE, { recursive: true, force: true });

console.log(ok ? 'TEST PASS' : 'TEST FAIL');
process.exit(ok ? 0 : 1);
