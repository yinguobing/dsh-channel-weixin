// 入站图片：mock CDN（AES-128-ECB）-> 插件解密 -> DSH attachment -> 模型回复
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startMockIlink } from './mock-ilink.mjs';

const HOME = os.homedir();
const PKG = path.resolve(import.meta.dirname, '..');
const TEST_HOME = path.join(PKG, '.test-media-home');
const TEST_ROOT = path.join(PKG, '.test-media');
const PROFILE = path.join(TEST_HOME, 'profiles', 'weixin-media-test');
const logFile = path.join(TEST_ROOT, 'dsh.log');

fs.rmSync(TEST_HOME, { recursive: true, force: true });
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_ROOT, 'accounts'), { recursive: true });
fs.mkdirSync(TEST_HOME, { recursive: true });
for (const f of ['.credentials.yaml', '.anonymous-user-id']) {
  fs.copyFileSync(path.join(HOME, '.dsh', f), path.join(TEST_HOME, f));
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);

const filePlain = Buffer.from('hello from weixin\n');
const fileCipher = crypto.createCipheriv('aes-128-ecb', key, null);
const fileEncrypted = Buffer.concat([fileCipher.update(filePlain), fileCipher.final()]);

const cdn = http.createServer((req, res) => {
  if (req.url.startsWith('/download')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(req.url.includes('file=1') ? fileEncrypted : encrypted);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
const cdnUrl = `http://127.0.0.1:${cdn.address().port}`;

const items = [{
  type: 4,
  file_item: {
    media: {
      full_url: `${cdnUrl}/download?encrypted_query_param=f&file=1`,
      aes_key: Buffer.from(key.toString('hex')).toString('base64'),
      encrypt_type: 1,
    },
    file_name: 'note.txt',
    len: String(filePlain.length),
  },
}, {
  type: 2,
  image_item: {
    media: {
      full_url: `${cdnUrl}/download?encrypted_query_param=x`,
      aes_key: Buffer.from(key.toString('hex')).toString('base64'),
      encrypt_type: 1,
    },
    aeskey: key.toString('hex'),
    mid_size: encrypted.length,
  },
}];

const mock = await startMockIlink({ items });
console.log('mock:', mock.baseUrl, '| cdn:', cdnUrl);

fs.writeFileSync(
  path.join(TEST_ROOT, 'accounts', 'bot-test.json'),
  JSON.stringify({ token: 'test-token', accountId: 'bot-test', baseUrl: mock.baseUrl, userId: 'wxid_test_user', savedAt: new Date().toISOString() }),
);

fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(
  path.join(PROFILE, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-profile-weixin-media-test',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-channel-weixin'] } },
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
    sessionPrefix: session-weixin-media-
    cwd: ${HOME}
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
const child = spawn('dsh', ['--profile', 'weixin-media-test', '--no-open', '--host', '127.0.0.1', '--port', '3095'], {
  cwd: HOME,
  stdio: ['ignore', out, out],
  env: { ...process.env, DSH_HOME: TEST_HOME },
});

const deadline = Date.now() + 180_000;
let reply = '';
let failed = false;
while (Date.now() < deadline) {
  const text = mock.sent.map((s) => s?.msg?.item_list?.[0]?.text_item?.text ?? '').filter(Boolean);
  const hit = text.find((t) => t.length > 0 && !t.includes('下载失败'));
  if (hit) { reply = hit; break; }
  if (text.some((t) => t.includes('处理失败') || t.includes('下载失败'))) { failed = true; reply = text[text.length - 1]; break; }
  if (child.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 500));
}

const walk = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
const attachments = walk(path.join(TEST_HOME, 'attachments')).length + walk(path.join(TEST_HOME, 'storages')).filter((f) => f.includes('attach')).length;
const ok = Boolean(reply) && !failed && attachments >= 2;

console.log('reply:', JSON.stringify(reply.slice(0, 160)));
console.log('attachment files:', attachments);
if (!ok) console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n'));

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
fs.closeSync(out);
await mock.close();
await new Promise((r) => cdn.close(r));
if (ok) { fs.rmSync(TEST_HOME, { recursive: true, force: true }); fs.rmSync(TEST_ROOT, { recursive: true, force: true }); }
else console.log('kept:', TEST_HOME, TEST_ROOT);
fs.rmSync(PROFILE, { recursive: true, force: true });

console.log(ok ? 'TEST PASS' : 'TEST FAIL');
process.exit(ok ? 0 : 1);
