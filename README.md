# dsh-channel-weixin

> 非微信/腾讯官方项目，与腾讯无关联。基于腾讯开源的 `openclaw-weixin` 所公开的 iLink/ClawBot 协议文档实现，仅供个人自用。
> 该协议不是公开开放平台：微信可能随时调整或限制，使用第三方客户端存在账号被限制的风险，请自行评估。
> 不要用于群发、营销或骚扰。

DSH 的微信通道插件：通过微信官方 **ClawBot / iLink** 通道（扫码登录 + 长轮询）把微信消息接进 DSH Agent。

- 不依赖 GUI、web server 或任何 app；可以挂进任意 profile
- 不需要公网 IP、域名、备案、80/443
- 文本消息、typing、长回复分片、审批转发、工具错误回传

```
微信客户端 ──> 微信 iLink (ilinkai.weixin.qq.com)
                    ▲  长轮询 getupdates / sendmessage
                    │
              dsh-channel-weixin  (宿主进程内)
                    │  agents.create / followup / session events
                    ▼
                 DSH Agent
```

## 能力

| 能力 | 说明 |
|---|---|
| 扫码登录 | `dsh-weixin-login`，凭证写 `~/.dsh/weixin/accounts/`（0600） |
| 收消息 | `getupdates` 长轮询，游标持久化，断点续传 |
| 回消息 | 按 `context_token` 回复，2000 字符分片 |
| typing | 正在输入状态，长任务每 4s 保活 |
| 会话 | 每个微信用户一个 DSH session，重启后自动 resume |
| 审批 | `approval/request` 转成微信消息，回复 `1` 允许一次 / `2` 拒绝 |
| 工具进度 | `tool/call`/`tool/result` 映射为微信原生工具卡片（type 11/12） |
| 命令 | `/new`、`/status`、`/stop`、`/help` |
| 入站媒体 | 图片（CDN 下载 + AES 解密）、文件（存为附件）、语音（用转写文本） |
| 出站媒体 | `weixin_send_file` 工具 + `/send <路径>`：工作区内文件/图片上传 CDN 后发送 |
| 工作区 | 会话自动挂进 cwd 对应的 workspace，Web 侧边栏可见 |
| 安全 | `allowFrom` 白名单；默认只允许扫码绑定的本人 |

## 安装到 web profile

```bash
cd ~/dsh-channel-weixin
./scripts/install-web.sh
```

脚本会：备份 profile → 停 `dsh-web.service` → 写入依赖和 bundle → `pnpm install` → 起服务。
**注意**：停服务会断开当前 GUI 会话，浏览器重连即可。

然后扫码：

```bash
~/.dsh/profiles/web/node_modules/.bin/dsh-weixin-login
systemctl --user restart dsh-web.service
```

日志：`journalctl --user -u dsh-web -f | grep weixin-channel`

### 手动安装（等价）

1. `~/.dsh/profiles/web/package.json`
   - `dependencies` 加 `"dsh-channel-weixin": "link:~/dsh-channel-weixin"`（替换成实际路径）
   - `dsh.profile.bundles` 末尾加 `"dsh-channel-weixin"`
2. `cd ~/.dsh/profiles/web && pnpm install`
3. `systemctl --user restart dsh-web`

## 在另一台机器安装

前置：Node 22+、已安装 `dsh`（`npm i -g @deepseek-ai/dsh`）、`pnpm`、私有仓库访问权限（`gh auth login` 或 SSH key）。

```bash
# 1. 克隆（仓库是 private）
gh repo clone yinguobing/dsh-channel-weixin ~/dsh-channel-weixin

# 2. 确保 web profile 已初始化
dsh web --help >/dev/null 2>&1 || true

# 3. 注册到 web profile
cd ~/.dsh/profiles/web
node ~/dsh-channel-weixin/scripts/edit-profile.mjs "$PWD" ~/dsh-channel-weixin
pnpm install --ignore-scripts

# 4. 重启宿主
systemctl --user restart dsh-web   # 或手动重启 dsh web

# 5. 扫码登录
~/.dsh/profiles/web/node_modules/.bin/dsh-weixin-login
systemctl --user restart dsh-web
```

默认配置即可用：`accountsDir` 跟随 `$DSH_HOME`（默认 `~/.dsh/weixin`），`cwd` 为 `~`，preset 用宿主默认。需要覆盖时在 profile 的 `cordis.patch.yml` 加：

```yaml
- id: weixin-channel
  config:
    cwd: '~'
    agentPreset: standard   # 换成该机器上存在的 preset
    approval: true
```

**同一个微信 bot 只能有一个 poller**。迁移机器时先停掉旧机器，再把 `~/.dsh/weixin/accounts/*.json` 复制过去（扫码可能返回 `binded_redirect`）；想保留会话绑定，连 `sessions-*.json` 一起复制。会话历史在 `~/.dsh/sessions/`，可选复制。

## 配置

默认值见 `src/plugin.mjs` 的 `DEFAULTS`，可在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: weixin-channel
  config:
    accountsDir: '~/.dsh/weixin'
    accountId: ''            # 多账号时指定
    allowFrom: []            # 空 = 只允许扫码绑定的 userId
    cwd: '~'                 # agent 工作目录
    provider: ''             # 空 = 用宿主默认模型
    model: ''
    agentPreset: ''          # 空 = 用宿主默认 preset；'none' = 不挂 preset；例如 standard
    approval: true
    approvalTimeoutMs: 120000
    maxChars: 2000
    sessionPrefix: 'session-weixin-'
    cdnBase: 'https://novac2c.cdn.weixin.qq.com/c2c'
```

## 命令

| 命令 | 作用 |
|---|---|
| `/new` | 换一个新会话（旧会话保留） |
| `/status` | 显示会话、模式、模型、目录、工作区、运行状态 |
| `/stop` | 取消当前 turn |
| `/send <路径>` | 把工作区文件/图片发到微信（agent 也可用同名工具） |
| `/help` | 命令列表 |

## 安全模型

微信消息是不可信输入，而 agent 有工具权限。建议：

- 保持 `allowFrom` 为默认（只允许本人）；不要随意放开
- 工作目录用独立 workspace，不要指向家目录根
- `approval` 保持开启；审批超时/非白名单一律 `unavailable`（fail-closed）
- 不要把 `bot_token` 提交到仓库；账号目录权限保持 0600

## 测试

```bash
node test/run.mjs          # web profile：mock 微信 -> 插件 -> 真实模型 -> 回复
node test/run-base.mjs     # 任意 profile：base 最小组合
node test/approval.mjs     # 审批：read-only 沙箱 -> 写文件审批 -> 回复 1 放行
node test/approval-web.mjs # 同上，在 web profile + 默认 preset 下
node test/new-command.mjs  # /new 换会话
node test/commands.mjs     # /status /help + 工具进度 item 11/12
node test/workspace-attach.mjs # 会话挂进 workspace
node test/media.mjs        # 入站图片 + 文件（mock CDN + AES）
node test/outbound.mjs     # 出站图片：agent 工具 -> 上传 -> sendmessage
```

测试会临时创建 `weixin-*-test` profile、mock 后端和测试会话，结束后清理。

## 限制

- **视频未支持**：入站视频只回提示
- **出站限制**：只能发工作区内文件、单文件 ≤ 25MB；需要已有入站消息提供 `context_token`
- **无流式**：微信普通会话不渲染 `GENERATING`，只能 typing + 最终消息
- **单 poller**：同一个 bot 只能有一个进程在轮询；如果你同时跑 OpenClaw，会互相抢游标
- **-14**：session 过期需要重新扫码；插件会暂停并打日志
- **写锁**：turn 进行中，GUI 打不开该会话（`session/writer-held`）；结束后可以看历史
- **审批范围**：只接管本插件创建的 agent；GUI 里打开的会话仍由浏览器审批
- 插件在无账号时只打日志、不阻塞宿主启动；登录后需要重启宿主进程

## 协议来源

- 腾讯官方插件：https://github.com/Tencent/openclaw-weixin
- 协议文档：https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/docs/protocol.md
- 本实现按该文档 + 社区实测（2000 字符分片、`-14`、`GENERATING` 不渲染）编写
