#!/usr/bin/env node
// 微信扫码登录：把凭证写入 accountsDir，供插件下次启动读取。
import os from 'node:os';
import path from 'node:path';
import { loginWithQr } from '../src/ilink.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = path.resolve(flag('--accounts-dir', path.join(os.homedir(), '.dsh', 'weixin')));
console.log(`账号目录：${root}`);
try {
  await loginWithQr({ root });
  console.log('完成。如果 DSH 已在运行，重启宿主进程（如 systemctl --user restart dsh-web）后生效。');
} catch (err) {
  console.error(`登录失败：${err.message}`);
  process.exit(1);
}
