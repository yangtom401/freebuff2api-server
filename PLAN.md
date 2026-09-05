# freebuff2api-server 自托管方案

> 基于 worker.js 移植的自托管 Node.js 服务，带 Web 管理界面
> 目标：部署到 PVE LXC 容器，通过 systemd 管理

---

## 一、项目目标

把 Cloudflare Worker 版的 freebuff2api 改造为**自托管服务器**：
- 完整复刻 worker.js 的 API 代理功能（OpenAI / Anthropic 协议）
- 增加 Web 管理界面（账号管理、日志、状态、用量统计）
- SQLite 持久化数据
- systemd 管理进程（开机自启、崩溃重启）
- 部署到 PVE LXC 容器

---

## 二、架构

```
用户/客户端
    │
    ▼
┌─────────────────────────────────┐
│  PVE LXC 容器 (10.0.0.x:3000)  │
│                                 │
│  ┌───────────────────────────┐  │
│  │   Node.js Express 服务    │  │
│  │                           │  │
│  │   ┌───────────────────┐   │  │
│  │   │  API 代理层       │   │  │  ◄── OpenAI / Anthropic 兼容
│  │   │  /v1/chat/...     │   │  │
│  │   │  /v1/messages     │   │  │
│  │   │  /v1/models       │   │  │
│  │   └───────┬───────────┘   │  │
│  │           │               │  │
│  │   ┌───────▼───────────┐   │  │
│  │   │  账号管理器       │   │  │  ◄── token 轮换、冷却、session
│  │   │  session 缓存     │   │  │
│  │   │  run 生命周期     │   │  │
│  │   └───────┬───────────┘   │  │
│  │           │               │  │
│  │   ┌───────▼───────────┐   │  │
│  │   │  Web 管理界面     │   │  │  ◄── Dashboard、日志、用量
│  │   │  (静态 HTML)      │   │  │
│  │   └───────────────────┘   │  │
│  │                           │  │
│  │   ┌───────────────────┐   │  │
│  │   │  SQLite 数据库    │   │  │  ◄── 账号、日志、用量持久化
│  │   └───────────────────┘   │  │
│  └───────────────────────────┘  │
│                                 │
│  systemd: freebuff2api.service  │
└─────────────────────────────────┘
    │
    ▼
  freebuff API (codebuff.com)
```

---

## 三、目录结构

```
LXC/
├── server.js                  # 入口文件
├── package.json               # 依赖
├── .env                       # 配置（端口、API Key 等）
├── src/
│   ├── database.js            # SQLite 数据库（建表、CRUD）
│   ├── freebuff-client.js     # freebuff API 客户端
│   ├── account-manager.js     # 账号管理（轮换、冷却、session）
│   ├── models.js              # 模型定义与动态刷新
│   ├── routes/
│   │   ├── api.js             # OpenAI/Anthropic API 路由
│   │   ├── admin.js           # 管理 API（Web 界面用）
│   │   └── health.js          # 健康检查
│   └── middleware/
│       └── auth.js            # API Key 鉴权
├── public/
│   ├── index.html             # Dashboard 主页
│   ├── css/style.css          # 样式
│   └── js/app.js              # 前端逻辑
├── data/
│   └── freebuff.db            # SQLite 数据库文件
├── deploy.sh                  # PVE LXC 部署脚本
└── freebuff2api.service       # systemd 服务文件
```

---

## 四、功能模块详细设计

### 4.1 API 代理层（复刻 worker.js）

保留 worker.js 的全部协议支持：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/healthz` | 健康检查（免鉴权） |
| `GET` | `/v1/models` | 模型列表 |
| `POST` | `/v1/chat/completions` | OpenAI 对话（流式/非流式） |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/messages/count_tokens` | Anthropic token 计数 |

**请求流程（复刻 worker.js）：**
1. 验证 API Key（`Authorization: Bearer` 或 `x-api-key`）
2. 选择账号（session 缓存优先 → 轮换 → 冷却跳过）
3. 确保 session（GET → POST → 轮询 queued）
4. 启动 run 链（主 agent + context-pruner 子 run）
5. 构建上游请求（注入 Buffy 前缀、codebuff_metadata）
6. 转发到 freebuff API
7. 流式透传 / 聚合非流式响应
8. 结束 run、记录日志、更新用量

### 4.2 账号管理器

| 功能 | 实现 |
|------|------|
| **token 存储** | SQLite accounts 表 |
| **添加 token** | Web 界面手动添加 / API 添加 |
| **token 轮换** | session 缓存优先 → round-robin → 最早冷却 |
| **冷却机制** | 429/428/403 → 根据 retryAfterMs 设置冷却，最大 6 小时 |
| **session 缓存** | 内存 Map，key=`${token}:${model}`，TTL ~55 分钟 |
| **run 缓存** | 内存 Map，key=`${token}:${agentId}`，TTL 10 分钟 |
| **账号健康** | 内存 Map + DB，记录 state（ok/banned/blocked/rate_limited） |
| **请求队列** | 串行执行，300ms 间隔，避免并发 |

### 4.3 OAuth 半自动登录（核心功能）

复刻 `extract_freebuff.py` 的登录流程，做成 Web 界面半自动：

**用户操作：**
1. 点击「添加账号」按钮
2. 弹窗显示「前往登录」按钮 + 状态提示
3. 点击后自动打开新窗口跳转到 freebuff 登录页
4. 用户在浏览器里完成 Google/GitHub 登录
5. 系统自动轮询捕获 token，自动保存，无需手动复制

**后台流程：**
```
用户点击「添加账号」
    │
    ▼
前端调用 POST /admin/api/oauth/start
    │
    ▼
服务端生成 fingerprintId
→ POST https://www.codebuff.com/api/auth/cli/code
→ 拿到 loginUrl + fingerprintHash + expiresAt
    │
    ▼
返回给前端，前端 window.open(loginUrl) 打开新窗口
    │
    ▼
前端每 3 秒轮询 GET /admin/api/oauth/poll?fingerprintId=xxx
    │
    ▼
服务端每 3 秒调用 GET /api/auth/cli/status?fingerprintId=xxx&fingerprintHash=xxx&expiresAt=xxx
    │
    ├─ 401 → 还没登录，继续轮询
    ├─ 200 → 拿到 authToken + user info
    │         → 自动存入 SQLite accounts 表
    │         → 返回 { ok: true, email, token }
    │
    ▼
前端收到成功响应 → 刷新账号列表 → 显示「添加成功」
```

**关键接口：**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin/api/oauth/start` | 发起登录，返回 `{ loginUrl, fingerprintId }` |
| `GET` | `/admin/api/oauth/poll?fingerprintId=xxx` | 轮询状态，返回 `{ status, email?, token? }` |
| `GET` | `/admin/api/oauth/status` | 查看当前是否有进行中的登录 |

**前端交互：**
```
┌─────────────────────────────────────┐
│  添加账号                           │
│                                     │
│  ┌─────────────────────────────┐    │
│  │  方式一：OAuth 登录（推荐）  │    │
│  │                             │    │
│  │  [前往 freebuff 登录]       │    │
│  │                             │    │
│  │  状态：等待登录...          │    │
│  │  （自动轮询中）             │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │  方式二：手动粘贴 token     │    │
│  │                             │    │
│  │  [token 输入框]             │    │
│  │  [确认添加]                 │    │
│  └─────────────────────────────┘    │
│                                     │
└─────────────────────────────────────┘
```

**注意：**
- 轮询超时 5 分钟后自动结束
- 同时只允许一个进行中的登录流程
- token 自动存入数据库，无需手动复制

### 4.4 Web 管理界面

**页面：**

| 页面 | 功能 |
|------|------|
| **仪表盘** | 总览：账号数、在线数、今日请求量、错误率、可用模型数 |
| **账号管理** | 列表展示所有 token、状态（绿/红/黄）、邮箱、额度、操作（删除/刷新） |
| **添加账号** | 输入 token 或发起 OAuth 登录流程 |
| **请求日志** | 实时滚动展示请求记录，支持按账号/模型筛选 |
| **用量统计** | 按日/模型/账号维度的 token 消耗图表 |
| **模型列表** | 所有可用模型、分类、上游 agentId |

**管理 API（供前端调用）：**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin/api/dashboard` | 仪表盘数据 |
| `GET` | `/admin/api/accounts` | 账号列表 |
| `POST` | `/admin/api/accounts` | 添加账号（token） |
| `DELETE` | `/admin/api/accounts/:id` | 删除账号 |
| `POST` | `/admin/api/accounts/:id/refresh` | 刷新账号状态 |
| `GET` | `/admin/api/logs` | 请求日志（分页） |
| `GET` | `/admin/api/usage` | 用量统计 |
| `GET` | `/admin/api/models` | 模型列表 |
| `GET` | `/admin/api/oauth/start` | 发起 OAuth 登录（返回 loginUrl + fingerprintId） |
| `GET` | `/admin/api/oauth/poll?fingerprintId=xxx` | 轮询登录状态（每 3 秒调一次） |
| `GET` | `/admin/api/oauth/status` | 查看当前登录流程状态 |

### 4.4 数据库设计

```sql
-- 账号表
accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  token TEXT UNIQUE NOT NULL,
  uid TEXT,
  state TEXT DEFAULT 'unknown',  -- ok/banned/blocked/rate_limited/token_invalid
  alive INTEGER DEFAULT 1,
  cooldown_until INTEGER DEFAULT 0,
  quota_json TEXT,
  created_at TEXT,
  updated_at TEXT
)

-- 请求日志
request_logs (
  id INTEGER PRIMARY KEY,
  account_id TEXT,
  model TEXT,
  endpoint TEXT,
  status_code INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  error_message TEXT,
  created_at TEXT
)

-- 每日用量汇总
usage_daily (
  id INTEGER PRIMARY KEY,
  account_id TEXT,
  model TEXT,
  date TEXT,
  session_count INTEGER,
  request_count INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  UNIQUE(account_id, model, date)
)

-- 配置
settings (
  key TEXT PRIMARY KEY,
  value TEXT
)
```

---

## 五、配置项

`.env` 文件：

```ini
# 服务配置
PORT=3000
HOST=0.0.0.0

# API 鉴权（客户端调用时用的 key）
API_KEY=your-api-key-here

# 管理界面密码（可选，为空则不启用登录）
ADMIN_PASSWORD=

# 调试模式
DEBUG=false
```

---

## 六、部署方案

### 6.1 本地开发

```bash
cd LXC
npm install
node server.js
# 访问 http://localhost:3000
```

### 6.2 PVE LXC 部署

沿用 DEPLOY_GUIDE_GENERIC.md 的方案：

1. **GitHub Actions 编译**：`npm ci && npm run build`（打包为 tar.gz）
2. **下载 artifact** → 上传到 PVE → push 到 LXC 容器
3. **容器内安装**：`npm ci --production`
4. **systemd 服务**：开机自启、崩溃重启
5. **配置 .env**：端口、API Key

**一键更新脚本 `deploy.sh`：**
- 下载最新 artifact
- 上传到 PVE → push 到 LXC
- 重启服务

### 6.3 systemd 服务

```ini
[Unit]
Description=Freebuff2API Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/freebuff2api
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/freebuff2api/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

---

## 七、与 worker.js 的差异

| 方面 | worker.js (CF) | 自托管 (LXC) |
|------|----------------|--------------|
| 运行环境 | Cloudflare 边缘 | PVE LXC 容器 |
| 数据存储 | 内存（冷启动丢失） | SQLite 持久化 |
| 账号管理 | 环境变量 | Web 界面 + API |
| 日志 | CF 日志 | SQLite + Web 查看 |
| 用量统计 | 无 | 按日/账号/模型统计 |
| OAuth 登录 | GitHub Actions | Web 界面发起 |
| 部署 | CF 控制台粘贴 | GitHub Actions + LXC |
| 扩展性 | CF 限制 | 自由扩展 |

---

## 八、待确认问题

1. **Web 界面登录** — 管理界面要不要加密码保护？（`.env` 配 `ADMIN_PASSWORD`）
2. **OAuth 登录** — 要不要在 Web 界面集成浏览器 OAuth 流程？（需要 PVE 有公网或隧道）
3. **端口** — 默认 3000 还是其他？
4. **额外功能** — 还有什么需求要加的？

---

*方案版本：v1.0 | 创建时间：2026-09-04*
