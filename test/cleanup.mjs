// 删除测试会话（扫描 sessions 下所有工作区目录，不假设用户名）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function removeTestSessions(prefixes, home = os.homedir()) {
  const root = path.join(home, '.dsh', 'sessions');
  if (!fs.existsSync(root)) return;
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full)) {
      if (prefixes.some((p) => name.startsWith(p))) fs.rmSync(path.join(full, name), { recursive: true, force: true });
    }
  }
}
