// 微信 iLink (ClawBot) 协议客户端。按腾讯官方 openclaw-weixin 的 docs/protocol.md 实现。
// 只依赖 Node 内置模块。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CHANNEL_VERSION = '0.1.0';
export const BOT_AGENT = 'DSH-Channel-Weixin/0.1.0';
const APP_ID = 'bot';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 0x00MMNNPP */
function clientVersion(v) {
  const [a = 0, b = 0, c = 0] = v.split('.').map((x) => parseInt(x, 10) || 0);
  return String(((a & 0xff) << 16) | ((b & 0xff) << 8) | (c & 0xff));
}

function randomWechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

export function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

function commonHeaders() {
  return {
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': clientVersion(CHANNEL_VERSION),
  };
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...commonHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function post(baseUrl, endpoint, body, { token, timeoutMs = 15000, signal } = {}) {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function get(baseUrl, endpoint, { timeoutMs = 15000 } = {}) {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const res = await fetch(url, { method: 'GET', headers: commonHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text.trim() ? JSON.parse(text) : {};
}

export class IlinkClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, token, accountId, log = () => {} } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.accountId = accountId;
    this.log = log;
    this.typingTickets = new Map();
  }

  async getUpdates(getUpdatesBuf, { timeoutMs = 35000, signal } = {}) {
    try {
      return await post(
        this.baseUrl,
        'ilink/bot/getupdates',
        { get_updates_buf: getUpdatesBuf ?? '', base_info: baseInfo() },
        { token: this.token, timeoutMs, signal },
      );
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw err;
    }
  }

  async sendItems(to, items, { contextToken, clientId } = {}) {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId ?? `dsh-weixin-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: items?.length ? items : undefined,
      },
      base_info: baseInfo(),
    };
    const r = await post(this.baseUrl, 'ilink/bot/sendmessage', body, { token: this.token });
    if (r.ret && r.ret !== 0) throw new Error(`sendmessage ret=${r.ret} ${r.errmsg ?? ''}`);
    return r;
  }

  async sendText(to, text, opts = {}) {
    return this.sendItems(to, text ? [{ type: 1, text_item: { text } }] : [], opts);
  }

  /** 工具进度：type 11 = start，12 = result（微信客户端原生渲染）。 */
  async sendToolProgress(to, { phase, name, callId, status }, { contextToken } = {}) {
    const item = phase === 'start'
      ? {
          type: 11,
          create_time_ms: Date.now(),
          is_completed: false,
          tool_call_start_item: { tool_name: name, tool_call_id: callId },
        }
      : {
          type: 12,
          create_time_ms: Date.now(),
          is_completed: true,
          tool_call_result_item: { tool_name: name, tool_call_id: callId, status: status ?? 'completed' },
        };
    return this.sendItems(to, [item], { contextToken });
  }

  /** 申请上传参数（图片/文件）。 */
  async getUploadUrl({ filekey, mediaType, toUserId, rawsize, rawmd5, filesize, aeskey }) {
    const r = await post(
      this.baseUrl,
      'ilink/bot/getuploadurl',
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5: rawmd5,
        filesize,
        no_need_thumb: true,
        aeskey,
        base_info: baseInfo(),
      },
      { token: this.token, timeoutMs: 20000 },
    );
    if (r.ret && r.ret !== 0) throw new Error(`getuploadurl ret=${r.ret} ${r.errmsg ?? ''}`);
    return r;
  }

  /** 上传 AES-128-ECB 密文，返回 x-encrypted-param。 */
  async uploadCipher(encrypted, { uploadFullUrl, uploadParam, filekey, cdnBase }) {
    const url = uploadFullUrl
      || `${cdnBase.replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam ?? '')}&filekey=${encodeURIComponent(filekey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`CDN 上传失败 HTTP ${res.status}`);
    const param = res.headers.get('x-encrypted-param');
    if (!param) throw new Error('CDN 上传缺少 x-encrypted-param');
    return param;
  }

  /** 上传并发送一张图片或一个文件。 */
  async sendMedia(to, { data, name, kind, contextToken, cdnBase }) {
    const rawsize = data.length;
    const rawmd5 = crypto.createHash('md5').update(data).digest('hex');
    const key = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString('hex');
    const filesize = Math.ceil((rawsize + 1) / 16) * 16;
    const aeskey = key.toString('hex');
    const mediaType = kind === 'image' ? 1 : 3;

    const up = await this.getUploadUrl({ filekey, mediaType, toUserId: to, rawsize, rawmd5, filesize, aeskey });
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const encryptParam = await this.uploadCipher(encrypted, {
      uploadFullUrl: up.upload_full_url,
      uploadParam: up.upload_param,
      filekey,
      cdnBase,
    });

    const media = {
      encrypt_query_param: encryptParam,
      aes_key: Buffer.from(aeskey, 'utf8').toString('base64'),
      encrypt_type: 1,
    };
    const item = kind === 'image'
      ? { type: 2, image_item: { media, mid_size: filesize } }
      : { type: 4, file_item: { media, file_name: name, len: String(rawsize), md5: rawmd5 } };
    return this.sendItems(to, [item], { contextToken });
  }

  async getTypingTicket(ilinkUserId, contextToken) {
    const cached = this.typingTickets.get(ilinkUserId);
    if (cached) return cached;
    const r = await post(
      this.baseUrl,
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: baseInfo() },
      { token: this.token, timeoutMs: 10000 },
    );
    if (r.ret === 0 && r.typing_ticket) this.typingTickets.set(ilinkUserId, r.typing_ticket);
    return r.typing_ticket;
  }

  async sendTyping(ilinkUserId, typingTicket, status = 1) {
    await post(
      this.baseUrl,
      'ilink/bot/sendtyping',
      { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: baseInfo() },
      { token: this.token, timeoutMs: 10000 },
    ).catch((err) => this.log(`sendtyping failed: ${err.message}`));
  }

  notify(kind) {
    return post(this.baseUrl, `ilink/bot/msg/notify${kind}`, { base_info: baseInfo() }, { token: this.token, timeoutMs: 10000 }).catch(
      (err) => this.log(`notify${kind} failed: ${err.message}`),
    );
  }
}

// ---------------------------------------------------------------------------
// 本地账号 / 游标
// ---------------------------------------------------------------------------

const ACCOUNTS = 'accounts';

function accountsPath(root) {
  return path.join(root, ACCOUNTS);
}

export function ensureDirs(root) {
  fs.mkdirSync(accountsPath(root), { recursive: true });
}

export function listAccounts(root) {
  ensureDirs(root);
  return fs
    .readdirSync(accountsPath(root))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(accountsPath(root), f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((a) => a?.token)
    .sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
}

export function saveAccount(root, accountId, data) {
  ensureDirs(root);
  const file = path.join(accountsPath(root), `${accountId}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  return file;
}

export function loadSyncBuf(root, accountId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, `sync-${accountId}.json`), 'utf8')).get_updates_buf ?? '';
  } catch {
    return '';
  }
}

export function saveSyncBuf(root, accountId, buf) {
  ensureDirs(root);
  fs.writeFileSync(path.join(root, `sync-${accountId}.json`), JSON.stringify({ get_updates_buf: buf }));
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------

function printQr(qrcodeUrl) {
  try {
    process.stdout.write(execFileSync('qrencode', ['-t', 'ANSIUTF8', '-m', '1', qrcodeUrl], { encoding: 'utf8' }) + '\n');
  } catch {
    /* qrencode 不存在时只打印 URL */
  }
  console.log(qrcodeUrl);
}

/**
 * 扫码登录并保存凭证。
 * @returns {Promise<{token, accountId, baseUrl, userId, savedAt}>}
 */
export async function loginWithQr({ root, log = console.log, onQr = printQr } = {}) {
  ensureDirs(root);
  let baseUrl = DEFAULT_BASE_URL;
  const qr = await post(baseUrl, 'ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { timeoutMs: 15000 });
  log('请用微信扫码并确认授权：');
  onQr(qr.qrcode_img_content);

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await get(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, { timeoutMs: 35000 });
    } catch {
      await sleep(1500);
      continue;
    }
    switch (status.status) {
      case 'confirmed': {
        const accountId = status.ilink_bot_id || `bot-${Date.now()}`;
        const account = {
          token: status.bot_token,
          accountId,
          baseUrl: status.baseurl || baseUrl,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        const file = saveAccount(root, accountId, account);
        log(`登录成功，凭证已保存：${file}`);
        return account;
      }
      case 'scaned_but_redirect':
        if (status.redirect_host) baseUrl = `https://${status.redirect_host}`;
        break;
      case 'expired':
        throw new Error('二维码已过期，请重新运行登录');
      case 'verify_code_blocked':
        throw new Error('验证码错误次数过多，请稍后重试');
      case 'binded_redirect':
        throw new Error('该微信已绑定其他实例（请先停掉 OpenClaw 或旧实例）');
      default:
        break;
    }
    await sleep(1000);
  }
  throw new Error('登录超时');
}
