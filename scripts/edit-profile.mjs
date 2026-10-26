#!/usr/bin/env node
// 把 dsh-channel-weixin 加进目标 profile：依赖 + bundle 选择。幂等。
import fs from 'node:fs';
import path from 'node:path';

const [profileDir, pkgDir] = process.argv.slice(2);
if (!profileDir || !pkgDir) {
  console.error('usage: edit-profile.mjs <profile-dir> <plugin-dir>');
  process.exit(2);
}

const manifestPath = path.join(profileDir, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dependencies['dsh-channel-weixin'] = `link:${pkgDir}`;
const profile = (manifest.dsh ??= {}).profile ??= {};
profile.bundles ??= [];
if (!profile.bundles.includes('dsh-channel-weixin')) profile.bundles.push('dsh-channel-weixin');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`已在 ${manifestPath} 注册 dsh-channel-weixin`);
