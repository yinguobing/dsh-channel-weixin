// 审批链路测试：read-only 沙箱 -> 工具触发审批 -> 微信回复 1 -> 放行
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockIlink } from './mock-ilink.mjs';
import { removeTestSessions } from './cleanup.mjs';

const HOME = os.homedir();
const PKG = path.resolve(import.meta.dirname, '..');
const TEST_ROOT = path.join(PKG, '.test-approval');
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'weixin-approval-test');
const TARGET = path.join(TEST_ROOT, 'approval.txt');
const logFile = path.join(TEST_ROOT, 'dsh.log');

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_ROOT, 'accounts'), { recursive: true });
fs.writeFileSync(TARGET, '', { flag: 'w' });
fs.rmSync(TARGET);

const prompt = `请用 write 工具把内容 hello 写入文件 ${TARGET}，完成后只回复 DONE，不要做别的事。`;
const mock = await startMockIlink({ text: prompt });
console.log('mock:', mock.baseUrl);

fs.writeFileSync(
  path.join(TEST_ROOT, 'accounts', 'bot-test.json'),
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
      name: 'dsh-profile-weixin-approval-test',
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
    sessionPrefix: session-weixin-approval-
    cwd: ${HOME}
    provider: deepseek-official
    model: deepseek-flash
    approval: true
    approvalTimeoutMs: 60000
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
const child = spawn('dsh', ['--profile', 'weixin-approval-test'], {
  cwd: HOME,
  stdio: ['ignore', out, out],
  env: { ...process.env, DSH_PERMISSION_MODE: 'read-only' },
});

const deadline = Date.now() + 180_000;
let approved = false;
let replied = false;
while (Date.now() < deadline) {
  if (!approved) {
    const asked = mock.sent.find((s) => JSON.stringify(s).includes('需要授权'));
    if (asked) {
      console.log('approval prompt:', asked.msg.item_list?.[0]?.text_item?.text?.slice(0, 120));
      mock.push('1');
      approved = true;
    }
  }
  const final = mock.sent.find((s) => {
    const t = s?.msg?.item_list?.[0]?.text_item?.text ?? '';
    return t.includes('DONE');
  });
  if (final) {
    replied = true;
    break;
  }
  if (child.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 400));
}

const fileOk = fs.existsSync(TARGET) && fs.readFileSync(TARGET, 'utf8').includes('hello');
console.log('approved prompt seen:', approved, '| DONE replied:', replied, '| file written:', fileOk);
if (!(approved && replied && fileOk)) {
  console.error('--- dsh.log tail ---');
  console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n'));
}

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
fs.closeSync(out);
await mock.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
removeTestSessions(['session-weixin-approval-']);

const ok = approved && replied && fileOk;
console.log(ok ? 'TEST PASS' : 'TEST FAIL');
process.exit(ok ? 0 : 1);
