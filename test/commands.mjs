// 命令 + 工具进度测试
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockIlink } from './mock-ilink.mjs';
import { removeTestSessions } from './cleanup.mjs';

const HOME = os.homedir();
const PKG = path.resolve(import.meta.dirname, '..');
const TEST_ROOT = path.join(PKG, '.test-cmd');
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'weixin-cmd-test');
const logFile = path.join(TEST_ROOT, 'dsh.log');

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_ROOT, 'accounts'), { recursive: true });

const mock = await startMockIlink({ text: '/status' });
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
      name: 'dsh-profile-weixin-cmd-test',
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
    sessionPrefix: session-weixin-cmd-
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
const child = spawn('dsh', ['--profile', 'weixin-cmd-test'], { cwd: HOME, stdio: ['ignore', out, out] });

const texts = () => mock.sent.map((s) => s?.msg?.item_list?.[0]?.text_item?.text ?? '');
const types = () => mock.sent.flatMap((s) => (s?.msg?.item_list ?? []).map((i) => i.type));
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

const status = await waitFor((s) => (s?.msg?.item_list?.[0]?.text_item?.text ?? '').includes('会话：'), 60_000);
mock.push('/help');
const help = await waitFor((s) => (s?.msg?.item_list?.[0]?.text_item?.text ?? '').includes('可用命令'), 30_000);
mock.push(`读一下 ${PKG}/README.md，然后只回复 DONE，不要做别的事。`);
const done = await waitFor((s) => (s?.msg?.item_list?.[0]?.text_item?.text ?? '').includes('DONE'), 120_000);

const ok = Boolean(status && help && done) && types().includes(11) && types().includes(12);
console.log('status:', Boolean(status), '| help:', Boolean(help), '| done:', Boolean(done));
console.log('item types:', JSON.stringify(types()));
console.log('last text:', JSON.stringify(texts().slice(-1)));
if (!ok) console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n'));

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
fs.closeSync(out);
await mock.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
removeTestSessions(['session-weixin-cmd-']);
console.log(ok ? 'TEST PASS' : 'TEST FAIL');
process.exit(ok ? 0 : 1);
