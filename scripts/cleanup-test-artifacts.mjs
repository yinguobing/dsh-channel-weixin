#!/usr/bin/env node
// 清掉测试产生的会话与 workspace 成员记录（只删测试前缀）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const DSH = path.join(HOME, '.dsh');
const prefixes = ['session-weixin-test-', 'session-weixin-new-', 'session-weixin-approval-', 'session-weixin-ws-'];

for (const dir of fs.readdirSync(path.join(DSH, 'sessions'))) {
  const full = path.join(DSH, 'sessions', dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const name of fs.readdirSync(full)) {
    if (prefixes.some((p) => name.startsWith(p))) fs.rmSync(path.join(full, name), { recursive: true, force: true });
  }
}

const wsFile = path.join(DSH, 'storages', 'workspace.json');
if (fs.existsSync(wsFile)) {
  const doc = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
  for (const ws of Object.values(doc.tables?.workspaces ?? {})) {
    ws.sessionIds = (ws.sessionIds ?? []).filter((id) => !prefixes.some((p) => String(id).startsWith(p)));
  }
  // 空的“微信”workspace（测试创建过的话）一并移除
  const empty = Object.entries(doc.tables?.workspaces ?? {})
    .filter(([, ws]) => ws.title === '微信' && (ws.sessionIds?.length ?? 0) === 0)
    .map(([id]) => id);
  for (const id of empty) {
    delete doc.tables.workspaces[id];
    doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== id);
  }
  fs.writeFileSync(wsFile, JSON.stringify(doc, null, 1));
}

for (const name of ['weixin-web-test', 'weixin-base-test', 'weixin-approval-test', 'weixin-new-test', 'weixin-ws-test']) {
  fs.rmSync(path.join(DSH, 'profiles', name), { recursive: true, force: true });
}
console.log('cleanup done');
