# openwps 部署与发布流程

## 架构说明

前后端合并为单端口（5174）部署：

```
浏览器 → http://host:5174
           ├── / (前端静态文件，由 FastAPI 托管)
           └── /api/* (后端 API)
```

开发时：前端 5173 + 后端 5174，通过 vite proxy 转发 `/api`
生产时：只启动后端 5174，前端 `dist/` 由后端直接托管

---

## 标准发布流程（每次改动完成后执行）

```bash
cd ~/projects/openwps

# 1. 构建前端
npm run build

# 2. 重启后端（自动托管新的 dist/）
pkill -f "python3 server/main.py" 2>/dev/null
nohup python3 server/main.py &>/tmp/openwps-server.log &
sleep 3

# 3. 验证
curl -s http://localhost:5174/api/health
curl -s http://localhost:5174/ | head -3

# 4. 提交代码
git add -A
git commit -m "描述改动内容"
git push
```

## 开发模式（本地开发时）

```bash
cd ~/projects/openwps

# 后端
nohup python3 server/main.py &>/tmp/openwps-server.log &

# 前端（热更新）
npx vite --host 0.0.0.0 --port 5173
```

开发时访问 `http://localhost:5173`，vite proxy 自动转发 `/api` 到 5174。

---

## 访问地址

| 环境 | 地址 |
|---|---|
| 内网 | http://192.168.1.192:5174 |
| 公网（内网穿透） | http://47.117.124.93:5174 |

---

## 目录结构

```
openwps/
├── src/                  # 前端源码（React + TypeScript）
│   ├── components/
│   │   ├── AISidebar.tsx      # AI 侧边栏（历史+对话双视图）
│   │   ├── Editor.tsx         # 编辑器主组件
│   │   ├── Toolbar.tsx        # 工具栏
│   │   └── SettingsModal.tsx  # 设置弹窗（页面+AI配置）
│   ├── editor/
│   │   └── schema.ts          # ProseMirror Schema
│   ├── layout/
│   │   └── paginator.ts       # Pretext 分页引擎
│   ├── ai/
│   │   ├── tools.ts           # AI 工具调用 Schema
│   │   ├── executor.ts        # 工具执行器
│   │   └── presets.ts         # 预设样式（公文/论文/合同）
│   └── main.tsx
├── server/               # Python FastAPI 后端
│   ├── main.py                # 主服务（API + 静态文件托管）
│   ├── config/
│   │   └── ai.json            # AI 配置（端点/Key/模型）
│   └── data/
│       └── conversations/     # 会话历史持久化
├── docs/
│   └── PRETEXT.md             # Pretext 排版原理与项目接入说明
├── dist/                 # 构建产物（npm run build 生成）
└── package.json
```

---

## 后端 API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 健康检查 |
| GET | /api/ai/settings | 获取 AI 配置 |
| PUT | /api/ai/settings | 保存 AI 配置 |
| POST | /api/ai/react/stream | AI 流式对话（SSE，ReAct架构） |
| GET | /api/conversations | 获取会话列表 |
| POST | /api/conversations | 新建会话 |
| GET | /api/conversations/{id} | 获取会话详情 |
| DELETE | /api/conversations/{id} | 删除会话 |

---

## 注意事项

- `server/config/ai.json` 包含 API Key，不要提交到 GitHub（已加 .gitignore）
- `server/data/` 会话数据也不提交（已加 .gitignore）
- 每次 `npm run build` 前确保前端代码无 TypeScript 错误：`npx tsc --noEmit`
- 公网端口 5174 已通过内网穿透暴露，注意不要在公网暴露 API Key
