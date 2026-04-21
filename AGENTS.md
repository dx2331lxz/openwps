# openwps 仓库特定指导

**默认使用中文回答。**

## 架构概述
- **前端**：React 19 + TypeScript + Vite（开发端口 5173）
- **后端**：Python FastAPI + LangGraph（端口 5174），生产环境挂载在 `/api`
- **运行时**：单端口部署（后端托管 `dist/` 于 5174）
- **文档模型**：ProseMirror（schema 在 `src/editor/schema.ts`）
- **布局引擎**：`@chenglou/pretext`（纯算术分页，不依赖 DOM 重排），详见 `docs/PRETEXT.md`
- **样式**：Tailwind CSS v4（通过 `@tailwindcss/vite` 插件，非 PostCSS）

## 关键目录边界
- `src/` — 前端源码
  - `components/` — React 组件（Editor、Toolbar、AISidebar、PretextPageRenderer 等）
  - `editor/` — ProseMirror schema 与 imageNodeView
  - `layout/` — Pretext 分页引擎（`paginator.ts`）
  - `ai/` — AI 工具定义、执行器、预设样式（`tools.ts`、`executor.ts`、`presets.ts`）
  - `docx/` — DOCX 导入/导出（mammoth + docx 库）
  - `markdown/` — Markdown 导入（marked）
  - `templates/` — 模板分析器与类型
- `server/` — Python FastAPI 后端
  - `app/factory.py` — 路由注册、静态文件托管、SPA fallback（核心接线文件）
  - `app/ai.py` — LangGraph ReAct 图、流式 SSE、OCR
  - `app/config.py` — 配置读写、provider 合并
  - `config/ai.json` — AI 配置（含 API Key，已 gitignore）
  - `data/` — 会话/文档/模板持久化（已 gitignore）
- `scripts/` — 部署与测试脚本
  - `deploy.sh` — 生产部署（build + restart + health check）
  - `test-typography.cjs` / `test-comment-dialog.cjs` — Playwright E2E 测试
  - `run-tests.py` — Python 版 Playwright 排版测试
- `dist/` — 构建输出（已 gitignore）

## 核心命令
- `npm run dev` — 前端开发服务器（Vite，端口 5173，代理 `/api` → 5174）
- `npm run build` — `tsc -b` + `vite build` → `dist/`
- `npm run lint` — ESLint 检查
- `bash scripts/deploy.sh` — 一键生产部署（build + restart + health check）

## 开发流程
1. 启动后端：`python3 server/main.py`（端口 5174；自动检测 `.venv` 并 re-exec）
2. 启动前端：`npm run dev`（端口 5173）
3. 前端通过 Vite proxy 转发 `/api` 到后端

## 修改后的必做步骤
1. **前端代码改动** → 必须 `npm run build` 验证 TypeScript 编译
2. **后端代码改动** → 必须重启后端并清除 `__pycache__`：
   ```bash
   pkill -f "python3 server/main.py"
   find server -type d -name __pycache__ -exec rm -rf {} +
   python3 server/main.py
   ```
3. **前后端都改了** → 先 build 再重启后端

## TypeScript 严格约束
- `strict: true` + `noUnusedLocals` + `noUnusedParameters`（编译错误级别）
- `verbatimModuleSyntax: true` — **必须用 `import type` 导入纯类型**
- `erasableSyntaxOnly: true` — 不能用 TS enum、namespace 等有运行时代码的 TS 语法

## E2E 测试（Playwright）
- 前提：`dist/` 已构建，或 `npm run dev` 在 5173 运行
- `node scripts/test-typography.cjs` — 排版功能测试（29 项，自带静态文件服务器）
- `node scripts/test-comment-dialog.cjs` — 批注弹框交互测试（默认连 4173 端口，可通过 `BASE_URL` 环境变量覆盖）
- `python3 scripts/run-tests.py` — Python 版排版测试（需前端在 5173 运行）
- 截图输出到 `screenshots/`

## Python 后端注意
- `server/main.py` 入口：若 `uvicorn` 缺失且 `.venv/bin/python3` 存在，自动 re-exec 到 venv
- 安装依赖：`pip3 install -r server/requirements.txt --break-system-packages`
- `server/config/ai.json` 和 `server/data/` 已 gitignore，不得提交
- 主 API 端点：
  - `POST /api/ai/react/stream` — AI 流式对话（SSE，ReAct 多轮工具调用）
  - `POST /api/ai/chat` — 单轮 AI 对话
  - `POST /api/ai/ocr` — OCR 图片分析
  - `GET/PUT /api/ai/settings` — AI 配置读写
  - `GET /api/ai/models` / `POST /api/ai/models/discover` — 模型列表
  - `CRUD /api/conversations` — 会话管理
  - `CRUD /api/documents` — 文档管理
  - `CRUD /api/templates` + `POST /api/templates/analyze` — 模板管理

## 生产部署
- 部署前必须 `npm run build`
- 重启：`pkill -f "python3 server/main.py"` → 启动 → `sleep 3` → 健康检查
- 健康检查：`curl -s http://localhost:5174/api/health` 应返回 `{"status":"ok","service":"openwps-backend"}`
- 或一键：`bash scripts/deploy.sh`
- 完整流程见 `DEPLOY.md`

## ESLint / 代码风格
- 未配置 Prettier；代码风格由 ESLint + 严格 tsconfig 保证
- ESLint 配置：`@eslint/js` + `tseslint` + React hooks + React Refresh (Vite)
