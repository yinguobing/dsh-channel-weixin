// 微信 CDN 媒体：下载 + AES-128-ECB 解密 + 类型识别。
import crypto from 'node:crypto';

export const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

function keyFromHex(hex) {
  if (typeof hex === 'string' && /^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex');
  return undefined;
}

/** 兼容 base64(raw16) / base64(hex32) / 裸 hex 三种 key 编码。 */
export function decodeAesKey(raw) {
  if (!raw) return undefined;
  const fromHex = keyFromHex(raw);
  if (fromHex) return fromHex;
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return undefined;
  }
  if (buf.length === 16) return buf;
  if (buf.length === 32) return keyFromHex(buf.toString('utf8'));
  return undefined;
}

export function decryptAesEcb(data, key) {
  if (!key) return data;
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    return data; // 未加密或 key 不匹配时按明文处理
  }
}

export function sniffMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'application/octet-stream';
}

export async function downloadMedia(media, { cdnBase = DEFAULT_CDN_BASE, signal, timeoutMs = 60_000 } = {}) {
  if (!media) throw new Error('消息里没有 media');
  const url = media.full_url
    || `${cdnBase.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? '')}`;
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDN 下载失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 入站图片：下载、解密、识别 mime。 */
export async function fetchInboundImage(item, opts = {}) {
  const image = item?.image_item ?? {};
  const raw = await downloadMedia(image.media ?? { full_url: image.url }, opts);
  const key = keyFromHex(image.aeskey) ?? decodeAesKey(image.media?.aes_key);
  const data = decryptAesEcb(raw, key);
  return { data, mimeType: sniffMime(data) };
}

/** 入站文件：下载、解密，返回明文与文件名。 */
export async function fetchInboundFile(item, opts = {}) {
  const file = item?.file_item ?? {};
  const raw = await downloadMedia(file.media, opts);
  const key = decodeAesKey(file.media?.aes_key);
  const data = decryptAesEcb(raw, key);
  return { data, name: file.file_name || 'weixin-file' };
}
