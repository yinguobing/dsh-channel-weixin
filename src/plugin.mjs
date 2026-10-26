// DSH 微信通道插件：iLink 长轮询 <-> DSH Agent 会话。
// 不依赖任何 app / webserver；可挂进任意 profile（web / sdk / acp / 自定义）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import util from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { IlinkClient, listAccounts, loadSyncBuf, saveSyncBuf } from './ilink.mjs';
import { fetchInboundFile, fetchInboundImage, sniffMime, DEFAULT_CDN_BASE } from './media.mjs';

export const name = 'weixin-channel';
export const inject = ['agents'];

function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
}

const DEFAULTS = {
  accountsDir: '',
  accountId: '',
  allowFrom: [],
  cwd: '~',
  provider: '',
  model: '',
  approval: true,
  approvalTimeoutMs: 120_000,
  turnTimeoutMs: 600_000,
  maxChars: 2000,
  typingKeepaliveMs: 4000,
  sessionPrefix: 'session-weixin-',
  agentPreset: '',
  cdnBase: DEFAULT_CDN_BASE,
};

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...raw };
  cfg.accountsDir = cfg.accountsDir ? expandHome(cfg.accountsDir) : path.join(dshHome(), 'weixin');
  cfg.cwd = expandHome(cfg.cwd);
  cfg.allowFrom = Array.isArray(cfg.allowFrom) ? cfg.allowFrom.filter((x) => typeof x === 'string' && x) : [];
  cfg.maxChars = Number.isFinite(cfg.maxChars) && cfg.maxChars > 200 ? cfg.maxChars : DEFAULTS.maxChars;
  return cfg;
}

function sessionIdFor(prefix, accountId, userId) {
  const h = crypto.createHash('sha1').update(`${accountId}:${userId}`).digest('hex').slice(0, 16);
  return `${prefix}${h}`;
}

function assistantText(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function splitText(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

class WeixinChannel {
  constructor(ctx, cfg, account, ilink, log) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.account = account;
    this.ilink = ilink;
    this.log = log;
    this.abort = new AbortController();
    this.seen = new Set();
    this.agents = new Map(); // userId -> { handle, sessionId, chain, turn }
    this.owned = new Set(); // Agent instances created by this channel
    this.ownedSessions = new Set();
    this.pendingApprovals = new Map(); // userId -> { resolve, timer, agent }
    this.contextTokens = new Map(); // userId -> 最近一次 context_token
    this.sessionToUser = new Map(); // sessionId -> userId
    this.toolNames = new Map(); // `${sessionId}:${callId}` -> tool name
    this.allowFrom = cfg.allowFrom.length ? new Set(cfg.allowFrom) : new Set([account.userId].filter(Boolean));
    this.buf = loadSyncBuf(cfg.accountsDir, account.accountId);
    this.sessionFile = path.join(cfg.accountsDir, `sessions-${account.accountId}.json`);
    this.sessionMap = this.loadSessionMap();
  }

  loadSessionMap() {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
    } catch {
      return {};
    }
  }

  saveSessionMap() {
    try {
      fs.writeFileSync(this.sessionFile, JSON.stringify(this.sessionMap, null, 2));
    } catch (err) {
      this.log(`save session map failed: ${err.message}`);
    }
  }

  sessionIdForUser(userId) {
    const existing = this.sessionMap[userId];
    if (existing) return existing;
    const id = sessionIdFor(this.cfg.sessionPrefix, this.account.accountId, userId);
    this.sessionMap[userId] = id;
    this.saveSessionMap();
    return id;
  }

  isArchived(sessionId) {
    const ids = this.ctx.get('workspaceRegistry')?.archivedSessionIds;
    return Array.isArray(ids) && ids.includes(sessionId);
  }

  /** 归档/用户主动 /new 后换一个新会话，旧会话留在持久化存储里。 */
  async rotateSession(userId, reason) {
    const rec = this.agents.get(userId);
    if (rec) {
      if (rec.handle) await Promise.resolve(rec.handle.dispose()).catch(() => {});
      this.owned.delete(rec.handle?.agent);
      this.ownedSessions.delete(rec.sessionId);
      this.sessionToUser.delete(rec.sessionId);
      this.agents.delete(userId);
    }
    const next = `${this.cfg.sessionPrefix}${crypto.createHash('sha1').update(`${this.account.accountId}:${userId}:${Date.now()}`).digest('hex').slice(0, 12)}`;
    this.sessionMap[userId] = next;
    this.saveSessionMap();
    this.log(`session rotated user=${userId} -> ${next} (${reason})`);
    return next;
  }

  /** 配置未指定时跟随宿主默认模型；persona 的 {{model}} 需要创建时就确定路由。 */
  resolveModel() {
    if (this.cfg.provider && this.cfg.model) {
      return { provider: this.cfg.provider, model: this.cfg.model };
    }
    const current = this.ctx.get('agentDefaultModel')?.currentSelection();
    if (current?.provider && current?.model) return current;
    return undefined;
  }

  async start() {
    this.log(`channel v0.5.0 starting (inbound+outbound media)`);
    this.attachmentsReady = new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.ctx.inject(['attachments'], (scope) => {
        clearTimeout(timer);
        this.attachments = scope.attachments;
        resolve();
      });
    });
    this.workspaceReady = new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.ctx.inject(['workspaceRegistry'], (scope) => {
        clearTimeout(timer);
        this.workspaceRegistry = scope.workspaceRegistry;
        this.log('workspaceRegistry ready');
        resolve();
      });
    });
    const route = this.resolveModel();
    if (route) {
      try {
        await this.ctx.get('llm')?.resolveCallConfig({ provider: route.provider, model: route.model });
      } catch (err) {
        this.log(`resolveCallConfig failed: ${err.message}`);
      }
    }
    this.offEvent = this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event));
    this.offReqErr = this.ctx.on('agent/request-error', (payload, next) => {
      if (this.owned.has(payload.agent)) this.log('request error:', payload.failure?.message ?? 'unknown');
      return next();
    });
    this.offError = this.ctx.on('agent/error', ({ agent, error }) => {
      if (!this.owned.has(agent)) return;
      let cause = error?.cause;
      const chain = [];
      for (let i = 0; cause && i < 4; i += 1) {
        chain.push(`${cause.name ?? 'Error'}: ${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
        cause = cause.cause;
      }
      this.log('agent error:', util.inspect(error, { depth: 3 }), chain.length ? `| cause: ${chain.join(' -> ')}` : '');
    });
    this.offApproval = this.cfg.approval
      ? this.ctx.on('approval/request', (req, next) => this.onApproval(req, next))
      : undefined;
    this.loop().catch((err) => this.log(`monitor stopped: ${err.message}`));
  }

  async dispose() {
    this.abort.abort();
    this.offEvent?.();
    this.offReqErr?.();
    this.offError?.();
    this.offApproval?.();
    for (const { resolve } of this.pendingApprovals.values()) resolve('unavailable');
    this.pendingApprovals.clear();
    for (const rec of this.agents.values()) {
      if (!rec.handle) continue;
      await Promise.resolve(rec.handle.dispose()).catch((err) => this.log(`dispose agent failed: ${err.message}`));
    }
    this.agents.clear();
    this.owned.clear();
    this.ownedSessions.clear();
  }

  async loop() {
    await this.ilink.notify('start');
    this.log(`monitor started base=${this.ilink.baseUrl} account=${this.account.accountId} buf=${this.buf.length}B`);
    let failures = 0;
    while (!this.abort.signal.aborted) {
      let resp;
      try {
        resp = await this.ilink.getUpdates(this.buf, { timeoutMs: 35000, signal: this.abort.signal });
      } catch (err) {
        failures += 1;
        this.log(`getUpdates failed (${failures}): ${err.message}`);
        await new Promise((r) => setTimeout(r, failures >= 3 ? 30_000 : 2_000));
        if (failures >= 3) failures = 0;
        continue;
      }
      failures = 0;
      const errcode = resp.errcode ?? resp.ret ?? 0;
      if (errcode === -14) {
        this.log('session expired (-14)：需要重新扫码登录，通道暂停');
        return;
      }
      if (resp.get_updates_buf) {
        this.buf = resp.get_updates_buf;
        saveSyncBuf(this.cfg.accountsDir, this.account.accountId, this.buf);
      }
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== 1) continue;
        this.onInbound(msg).catch((err) => this.log(`inbound failed: ${err.message}`));
      }
    }
    await this.ilink.notify('stop');
  }

  async onInbound(msg) {
    const from = msg.from_user_id;
    const id = String(msg.message_id ?? msg.svr_id ?? msg.client_id ?? '');
    if (!from || !id || this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 5000) this.seen.clear();

    if (!this.allowFrom.has(from)) {
      this.log(`ignored message from non-allowlisted user ${from}`);
      return;
    }

    if (msg.context_token) this.contextTokens.set(from, msg.context_token);

    const built = await this.buildPromptParts(msg);
    const text = built.text;
    if (built.parts.length === 0) {
      await this.ilink.sendText(from, '没有可处理的内容（支持文本、图片、文件、语音转写）。', { contextToken: msg.context_token });
      return;
    }

    if (text.startsWith('/') || text.startsWith('／')) {
      if (await this.handleCommand(from, text.replace('／', '/').trim(), msg)) return;
    }

    const existing = this.agents.get(from);
    if (existing && this.isArchived(existing.sessionId)) {
      await this.rotateSession(from, 'archived');
      await this.ilink.sendText(from, '原会话已在 Web 中归档，已自动开始新会话。', { contextToken: msg.context_token });
    }

    // 审批回复优先，直接唤醒等待中的 turn，不进入队列
    const pending = text ? this.pendingApprovals.get(from) : undefined;
    if (pending) {
      this.pendingApprovals.delete(from);
      clearTimeout(pending.timer);
      pending.resolve(text.trim());
      return;
    }

    this.enqueue(from, { text, parts: built.parts, contextToken: msg.context_token }).catch((err) => this.log(`queue failed: ${err.message}`));
  }

  async buildPromptParts(msg) {
    const parts = [];
    const texts = [];
    const notice = (text) =>
      this.ilink.sendText(msg.from_user_id, text, { contextToken: msg.context_token }).catch((err) => this.log(`notice failed: ${err.message}`));
    for (const item of msg.item_list ?? []) {
      switch (item?.type) {
        case 1:
          texts.push(item.text_item?.text ?? '');
          break;
        case 3: {
          const transcript = item.voice_item?.text;
          if (transcript) texts.push(transcript);
          else await notice('语音消息没有转写文本，暂不支持。');
          break;
        }
        case 2: {
          try {
            const image = await fetchInboundImage(item, { cdnBase: this.cfg.cdnBase });
            parts.push({ type: 'image', data: image.data.toString('base64'), mediaType: image.mimeType });
          } catch (err) {
            this.log(`image download failed: ${err.message}`);
            await notice(`图片下载失败：${err.message}`);
          }
          break;
        }
        case 4: {
          try {
            await this.attachmentsReady;
            if (!this.attachments) throw new Error('附件服务不可用');
            const file = await fetchInboundFile(item, { cdnBase: this.cfg.cdnBase });
            const ref = await this.attachments.saveFile({ data: file.data, name: file.name });
            parts.push({ type: 'file', attachment: ref });
          } catch (err) {
            this.log(`file download failed: ${err.message}`);
            await notice(`文件下载失败：${err.message}`);
          }
          break;
        }
        case 5:
          await notice('视频暂不支持。');
          break;
        default:
          break;
      }
    }
    const text = texts.join('').trim();
    if (text) parts.unshift({ type: 'text', text });
    return { text, parts };
  }

  enqueue(userId, job) {
    let rec = this.agents.get(userId);
    if (!rec) {
      rec = {
        handle: undefined,
        sessionId: this.sessionIdForUser(userId),
        chain: Promise.resolve(),
        turn: undefined,
      };
      this.agents.set(userId, rec);
    }
    rec.pending = (rec.pending ?? 0) + 1;
    rec.chain = rec.chain.catch(() => {}).then(() => this.runTurn(userId, job)).finally(() => {
      rec.pending = Math.max(0, (rec.pending ?? 0) - 1);
    });
    return rec.chain;
  }

  async ensureAgent(rec, userId) {
    if (rec.handle) return rec.handle;
    const route = this.resolveModel();
    const agentOptions = route
      ? { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) }
      : undefined;
    const preset = this.resolvePreset();
    const registry = preset ? this.ctx.get('agentPresets') : undefined;
    const meta = { cwd: this.cfg.cwd, ...(preset ? { agentPreset: preset } : {}) };
    const setup = async (agentCtx) => {
      if (registry && preset) await registry.mount(agentCtx, preset);
      try {
        agentCtx.tools.register(this.makeSendTool(userId));
      } catch (err) {
        this.log(`send tool registration failed: ${err.message}`);
      }
    };
    try {
      rec.handle = await this.ctx.agents.create({
        sessionId: rec.sessionId,
        meta,
        agentOptions,
        setup,
      });
    } catch (err) {
      if (!/already exists/i.test(String(err?.message ?? ''))) throw err;
      rec.handle = await this.ctx.agents.resume({ resumeSessionId: rec.sessionId, agentOptions, setup });
    }
    this.owned.add(rec.handle.agent);
    this.ownedSessions.add(rec.sessionId);
    this.sessionToUser.set(rec.sessionId, userId);
    await this.ensureWorkspace(rec.sessionId);
    return rec.handle;
  }

  async handleCommand(userId, text, msg) {
    const contextToken = msg.context_token ?? this.contextTokens.get(userId);
    if (text === '/new' || text === '新会话') {
      await this.rotateSession(userId, 'user /new');
      await this.ilink.sendText(userId, '已开始新会话。', { contextToken });
      return true;
    }
    if (text === '/help' || text === '帮助') {
      await this.ilink.sendText(
        userId,
        ['可用命令：', '/new 新会话', '/status 当前状态', '/stop 停止当前任务', '/send <路径> 发送文件或图片', '/help 本帮助'].join('\n'),
        { contextToken },
      );
      return true;
    }
    if (text === '/status' || text === '状态') {
      const rec = this.agents.get(userId);
      const sessionId = rec?.sessionId ?? this.sessionMap[userId] ?? '（尚未创建）';
      const running = rec?.handle?.agent?.status === 'running';
      const route = this.resolveModel();
      const workspace = this.workspaceRegistry?.list?.().find((w) => path.resolve(w.path) === path.resolve(this.cfg.cwd));
      await this.ilink.sendText(
        userId,
        [
          `会话：${sessionId}`,
          `模式：${this.cfg.agentPreset || '宿主默认'}`,
          `模型：${route ? `${route.provider}/${route.model}` : '宿主默认'}`,
          `目录：${this.cfg.cwd}`,
          `工作区：${workspace ? `${workspace.title} (${workspace.path})` : '未挂载'}`,
          `状态：${running ? '运行中' : '空闲'}${rec?.pending ? `（排队 ${rec.pending}）` : ''}`,
        ].join('\n'),
        { contextToken },
      );
      return true;
    }
    if (text.startsWith('/send ') || text.startsWith('/file ')) {
      const rest = text.replace(/^\/(send|file)\s+/, '').trim();
      const [target, ...captionParts] = rest.split(/\s+/);
      try {
        const result = await this.sendFileToUser(userId, target, captionParts.join(' '));
        await this.ilink.sendText(userId, result, { contextToken });
      } catch (err) {
        await this.ilink.sendText(userId, `发送失败：${err.message}`, { contextToken });
      }
      return true;
    }
    if (text === '/stop' || text === '停止') {
      const rec = this.agents.get(userId);
      if (!rec?.handle || rec.handle.agent.status !== 'running') {
        await this.ilink.sendText(userId, '当前没有运行中的任务。', { contextToken });
        return true;
      }
      rec.stopping = true;
      rec.handle.agent.cancel({ kind: 'user' });
      await this.ilink.sendText(userId, '已停止当前任务。', { contextToken });
      return true;
    }
    await this.ilink.sendText(userId, `未知命令：${text}。发送 /help 查看可用命令。`, { contextToken });
    return true;
  }

  makeSendTool(userId) {
    const channel = this;
    return {
      name: 'weixin_send_file',
      description:
        '把工作区里的本地文件或图片发送到当前微信对话。用户说“发给我 / 发张图 / 把文件传过来”时使用。path 必须在工作区内。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径，或相对于工作区的路径' },
          caption: { type: 'string', description: '可选的文字说明，会先于文件发送' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        return channel.sendFileToUser(userId, args.path, args.caption, exec?.signal);
      },
    };
  }

  async sendFileToUser(userId, filePath, caption, signal) {
    if (signal?.aborted) throw new Error('已取消');
    const cwd = path.resolve(this.cfg.cwd);
    const abs = path.resolve(cwd, filePath);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      throw new Error(`文件不存在：${abs}`);
    }
    if (real !== cwd && !real.startsWith(`${cwd}${path.sep}`)) throw new Error(`只允许发送工作区内的文件：${cwd}`);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error(`不是文件：${real}`);
    if (stat.size > 25 * 1024 * 1024) throw new Error('文件超过 25MB，暂不支持');
    const data = fs.readFileSync(real);
    const mime = sniffMime(data);
    const kind = mime.startsWith('image/') ? 'image' : 'file';
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) throw new Error('没有可用的会话上下文，请先在微信里发一条消息');
    if (caption) await this.ilink.sendText(userId, caption, { contextToken });
    await this.ilink.sendMedia(userId, {
      data,
      name: path.basename(real),
      kind,
      contextToken,
      cdnBase: this.cfg.cdnBase,
    });
    return `已发送 ${path.basename(real)}（${stat.size} 字节${kind === 'image' ? '，图片' : ''}）到微信。`;
  }

  /** 把会话挂进 cwd 对应的 workspace，Web 侧边栏才会列出它。 */
  async ensureWorkspace(sessionId) {
    await this.workspaceReady;
    const registry = this.workspaceRegistry ?? this.ctx.get('workspaceRegistry');
    if (!registry?.list) { this.log('workspaceRegistry unavailable; session not attached'); return; }
    try {
      const target = path.resolve(this.cfg.cwd);
      let workspace = registry.list().find((w) => path.resolve(w.path) === target);
      if (!workspace) workspace = await registry.create(this.cfg.cwd, '微信');
      await workspace.attachSession(sessionId);
      this.log(`attached ${sessionId} -> workspace ${workspace.path}`);
    } catch (err) {
      this.log(`workspace attach failed: ${err.message}`);
    }
  }

  resolvePreset() {
    if (this.cfg.agentPreset === 'none') return undefined;
    if (this.cfg.agentPreset) return this.cfg.agentPreset;
    return this.ctx.get('agentPresets')?.defaultId;
  }

  async runTurn(userId, { text, parts, contextToken }) {
    const rec = this.agents.get(userId);
    if (!rec) throw new Error('session was rotated before the turn started');
    let ticket;
    let typingTimer;
    try {
      const handle = await this.ensureAgent(rec, userId);
      ticket = await this.ilink.getTypingTicket(userId, contextToken).catch(() => undefined);
      if (ticket) {
        await this.ilink.sendTyping(userId, ticket, 1);
        typingTimer = setInterval(() => this.ilink.sendTyping(userId, ticket, 1), this.cfg.typingKeepaliveMs);
      }

      rec.lastText = '';
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          rec.turn = undefined;
          reject(new Error('turn timeout'));
        }, this.cfg.turnTimeoutMs);
        rec.turn = {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        };
      });

      let content;
      if (parts?.length) {
        await this.attachmentsReady;
        content = this.attachments
          ? await this.attachments.admitPromptContent(parts)
          : [{ type: 'text', text: text || '[媒体消息]' }];
      } else {
        content = [{ type: 'text', text }];
      }
      handle.agent.followup({
        id: crypto.randomUUID(),
        role: 'user',
        content,
        source: { kind: 'user' },
      });
      const answer = await done;
      if (rec.turn) rec.turn = undefined;

      const body = answer?.trim() || '（本轮没有文本输出）';
      for (const part of splitText(body, this.cfg.maxChars)) {
        await this.ilink.sendText(userId, part, { contextToken });
      }
      this.log(`replied to=${userId} chars=${body.length}`);
    } catch (err) {
      if (rec?.stopping) {
        rec.stopping = false;
        this.log('turn stopped by user');
        return;
      }
      this.log(`turn failed: ${err.message}`);
      const archived = rec && this.isArchived(rec.sessionId);
      if (archived) await this.rotateSession(userId, 'archived during turn');
      const note = archived ? '会话已在 Web 中归档，下一条消息会开始新会话。' : `处理失败：${err.message}`;
      await this.ilink.sendText(userId, note, { contextToken: contextToken ?? this.contextTokens.get(userId) }).catch(() => {});
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      if (ticket) await this.ilink.sendTyping(userId, ticket, 2);
    }
  }

  onSessionEvent(session, event) {
    const sessionId = String(session.id);
    const userId = this.sessionToUser.get(sessionId);
    if (!userId) return;
    const rec = this.agents.get(userId);
    if (!rec) return;
    if (event.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '');
      const name = event.data?.name ?? 'tool';
      if (callId) {
        this.toolNames.set(`${sessionId}:${callId}`, name);
        if (this.toolNames.size > 500) this.toolNames.clear();
      }
      this.ilink
        .sendToolProgress(userId, { phase: 'start', name, callId }, { contextToken: this.contextTokens.get(userId) })
        .catch((err) => this.log(`tool progress failed: ${err.message}`));
    } else if (event.type === 'tool/result') {
      const callId = String(event.data?.message?.toolCallId ?? event.data?.message?.callId ?? '');
      const name = this.toolNames.get(`${sessionId}:${callId}`) ?? 'tool';
      const status = event.data?.message?.isError ? 'failed' : 'completed';
      this.toolNames.delete(`${sessionId}:${callId}`);
      this.ilink
        .sendToolProgress(userId, { phase: 'end', name, callId, status }, { contextToken: this.contextTokens.get(userId) })
        .catch((err) => this.log(`tool progress failed: ${err.message}`));
    } else if (event.type === 'assistant/message') {
      const text = assistantText(event);
      if (text.trim()) rec.lastText = text;
    } else if (event.type === 'turn/end') {
      const reason = event.data?.reason?.kind;
      const turn = rec.turn;
      if (!turn) return;
      rec.turn = undefined;
      if (reason === 'completed' || reason === 'stop' || reason === 'max-tokens') {
        turn.resolve(rec.lastText ?? '');
      } else {
        turn.reject(new Error(`turn ${reason ?? 'failed'}: ${JSON.stringify(event.data?.reason ?? {})}`));
      }
    }
  }

  async onApproval(req, next) {
    const rootSession = this.sessionRootOf(req.agent);
    if (!rootSession || !this.ownedSessions.has(rootSession)) return next();
    const userId = this.sessionToUser.get(rootSession) ?? this.userOfSession(rootSession);
    if (!userId) return next();

    const reason = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason ?? '';
    const text = `需要授权：${req.toolName}\n${reason ? reason + '\n' : ''}回复 1 允许一次，回复 2 拒绝（${Math.round(this.cfg.approvalTimeoutMs / 1000)} 秒内有效）`;
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(userId);
        resolve('');
      }, this.cfg.approvalTimeoutMs);
      this.pendingApprovals.set(userId, { resolve, timer, agent: req.agent });
      req.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.pendingApprovals.delete(userId);
        resolve('');
      }, { once: true });
    });

    try {
      await this.ilink.sendText(userId, text, { contextToken: this.contextTokens.get(userId) });
    } catch (err) {
      this.log(`approval notify failed: ${err.message}`);
      this.pendingApprovals.delete(userId);
      return 'unavailable';
    }

    const choice = (await answer).trim();
    if (choice === '1' || choice.toLowerCase() === 'y' || choice === '允许') return 'allowed-once';
    if (choice === '2' || choice.toLowerCase() === 'n' || choice === '拒绝') return 'rejected';
    return 'unavailable';
  }

  sessionRootOf(agent) {
    const session = agent?.session;
    if (!session) return undefined;
    const parent = session.header?.parentSession;
    return parent ? String(parent) : String(session.id);
  }

  userOfSession(sessionId) {
    for (const [userId, rec] of this.agents) if (rec.sessionId === sessionId) return userId;
    return undefined;
  }
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const log = (...args) => console.error(new Date().toISOString(), '[weixin-channel]', ...args);

  const accounts = listAccounts(cfg.accountsDir);
  const account = cfg.accountId ? accounts.find((a) => a.accountId === cfg.accountId) : accounts[accounts.length - 1];
  if (!account) {
    log(`未找到微信账号（${cfg.accountsDir}/accounts）。请先运行 dsh-weixin-login 扫码。`);
    return;
  }

  const ilink = new IlinkClient({ baseUrl: account.baseUrl, token: account.token, accountId: account.accountId, log });
  const channel = new WeixinChannel(ctx, cfg, account, ilink, log);

  ctx.effect(() => {
    channel.start();
    return () => channel.dispose();
  }, 'weixin-channel.serve');
}
