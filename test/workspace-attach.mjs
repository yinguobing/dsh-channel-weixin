// 验证微信会话会被挂进 cwd 对应的 workspace（Web 侧边栏可见）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockIlink } from './mock-ilink.mjs';

const HOME = os.homedir();
const PKG = path.resolve(import.meta.dirname, '..');
const TEST_HOME = path.join(PKG, '.test-home');
const TEST_ROOT = path.join(PKG, '.test-ws');
const PROFILE = path.join(TEST_HOME, 'profiles', 'weixin-ws-test');
const logFile = path.join(TEST_ROOT, 'dsh.log');

fs.rmSync(TEST_HOME, { recursive: true, force: true });
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_ROOT, 'accounts'), { recursive: true });
fs.mkdirSync(TEST_HOME, { recursive: true });
for (const f of ['.credentials.yaml', '.anonymous-user-id']) {
  fs.copyFileSync(path.join(HOME, '.dsh', f), path.join(TEST_HOME, f));
}

const mock = await startMockIlink({ text: '你好，只回复两个字：收到。不要调用工具。' });
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
      name: 'dsh-profile-weixin-ws-test',
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
    sessionPrefix: session-weixin-ws-
    cwd: ${HOME}
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
const child = spawn('dsh', ['--profile', 'weixin-ws-test', '--no-open', '--host', '127.0.0.1', '--port', '3096'], {
  cwd: HOME,
  stdio: ['ignore', out, out],
  env: { ...process.env, DSH_HOME: TEST_HOME },
});

const deadline = Date.now() + 180_000;
let replied = false;
while (Date.now() < deadline) {
  if (mock.sent.some((s) => (s?.msg?.item_list?.[0]?.text_item?.text ?? '').includes('收到'))) {
    replied = true;
    break;
  }
  if (child.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 500));
}

const wsFile = path.join(TEST_HOME, 'storages', 'workspace.json');
const ws = fs.existsSync(wsFile) ? JSON.parse(fs.readFileSync(wsFile, 'utf8')) : {};
const rows = Object.values(ws.tables?.workspaces ?? {});
const row = rows.find((w) => w.path === path.resolve(HOME));
const attached = Boolean(row?.sessionIds?.some((id) => String(id).startsWith('session-weixin-ws-')));
const ok = replied && attached;

console.log('replied:', replied, '| workspace:', JSON.stringify(row));
if (!ok) console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n'));

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
fs.closeSync(out);
await mock.close();
if (ok) {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
} else {
  console.log('kept test home for inspection:', TEST_HOME);
}

console.log(ok ? 'TEST PASS' : 'TEST FAIL');
process.exit(ok ? 0 : 1);
