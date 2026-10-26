// /new 指令测试：先发 /new 换会话，再正常提问
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockIlink } from './mock-ilink.mjs';
import { removeTestSessions } from './cleanup.mjs';

const HOME = os.homedir();
const PKG = path.resolve(import.meta.dirname, '..');
const TEST_ROOT = path.join(PKG, '.test-new');
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'weixin-new-test');
const logFile = path.join(TEST_ROOT, 'dsh.log');

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_ROOT, 'accounts'), { recursive: true });

const mock = await startMockIlink({ text: '/new' });
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
      name: 'dsh-profile-weixin-new-test',
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
    sessionPrefix: session-weixin-new-
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
const child = spawn('dsh', ['--profile', 'weixin-new-test'], { cwd: HOME, stdio: ['ignore', out, out] });

const waitFor = async (pred, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = mock.sent.find(pred);
    if (hit) return hit;
    if (child.exitCode !== null) return undefined;
    await new Promise((r) => setTimeout(r, 400));
  }
  return undefined;
};

const texts = () => mock.sent.map((s) => s?.msg?.item_list?.[0]?.text_item?.text ?? '');
const reset = await waitFor((s) => (s?.msg?.item_list?.[0]?.text_item?.text ?? '').includes('已开始新会话'), 60_000);
mock.push('只回复两个字：收到。不要调用工具。');
const answer = await waitFor((s) => (s?.msg?.item_list?.[0]?.text_item?.text ?? '').includes('收到'), 120_000);

const mapFile = path.join(TEST_ROOT, 'sessions-bot-test.json');
const map = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {};
const ok = Boolean(reset && answer) && Object.keys(map).length === 1;

console.log('reset reply:', Boolean(reset), '| answer:', JSON.stringify(texts().slice(-1)));
console.log('session map:', JSON.stringify(map));
if (!ok) {
  console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n'));
}

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
fs.closeSync(out);
await mock.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
removeTestSessions(['session-weixin-new-']);
console.log(ok ? 'TEST PASS' : 'TEST FAIL');
process.exit(ok ? 0 : 1);
