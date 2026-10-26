// 集成测试：mock 微信后端 -> 真实 dsh web 实例（挂载本插件）-> 校验回复
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockIlink } from './mock-ilink.mjs';
import { removeTestSessions } from './cleanup.mjs';

const HOME = os.homedir();
const PKG = path.resolve(import.meta.dirname, '..');
const TEST_ROOT = path.join(PKG, '.test');
const ACCOUNTS = path.join(TEST_ROOT, 'accounts'); // 插件内部会再拼一层 accounts
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'weixin-base-test');
const PORT = 3099;
const SESSION_PREFIX = 'session-weixin-test-';
const logFile = path.join(TEST_ROOT, 'dsh.log');

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(ACCOUNTS, { recursive: true });

const mock = await startMockIlink({ text: '只回复两个字：收到。不要调用任何工具。' });
console.log('mock:', mock.baseUrl);

fs.mkdirSync(ACCOUNTS, { recursive: true });
fs.writeFileSync(
  path.join(ACCOUNTS, 'bot-test.json'),
  JSON.stringify({
    token: 'test-token',
    accountId: 'bot-test',
    baseUrl: mock.baseUrl,
    userId: 'wxid_test_user',
    savedAt: new Date().toISOString(),
  }),
);

fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(
  path.join(PROFILE, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-profile-weixin-web-test',
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
    sessionPrefix: ${SESSION_PREFIX}
    cwd: ${HOME}
    provider: deepseek-official
    model: deepseek-flash
    approval: false
- id: session-title-llm
  disabled: true
- id: session-log-deepseek
  disabled: true
`,
);

console.log('pnpm install …');
const runtimeDir = path.join(TEST_ROOT, 'pnpm-runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const install = spawn('pnpm', ['install', '--ignore-scripts', '--prefer-offline'], {
  cwd: PROFILE,
  stdio: 'inherit',
  env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
});
const installCode = await new Promise((r) => install.on('exit', r));
if (installCode !== 0) {
  console.error('pnpm install failed');
  process.exit(1);
}

const out = fs.openSync(logFile, 'w');
const child = spawn('dsh', ['--profile', 'weixin-base-test'], {
  cwd: HOME,
  stdio: ['ignore', out, out],
});

const deadline = Date.now() + 180_000;
let ok = false;
let replyText = '';
while (Date.now() < deadline) {
  const reply = mock.sent.find((s) => s?.msg?.item_list?.some((i) => i.type === 1));
  if (reply) {
    replyText = reply.msg.item_list.map((i) => i.text_item?.text ?? '').join('');
    ok = replyText.includes('收到') && reply.msg.context_token === 'ctx-token-1';
    break;
  }
  if (child.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 500));
}

console.log('reply:', JSON.stringify(replyText));
console.log('typing frames:', JSON.stringify(mock.typing.map((t) => t.status)));
if (!ok) {
  console.error('--- dsh.log tail ---');
  console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n'));
}

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
fs.closeSync(out);
await mock.close();

// 清理：测试 profile、账号、测试会话
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
removeTestSessions([SESSION_PREFIX]);

console.log(ok ? 'TEST PASS' : 'TEST FAIL');
process.exit(ok ? 0 : 1);
