# openwps 仓库特定指导

## 架构概述
- **前端**：React + TypeScript + Vite（开发端口 5173）
- **后端**：Python FastAPI + LangGraph（端口 5174），生产环境挂载在 `/api`
- **运行时**：单端口部署（后端托管 `dist/` 于 5174）
- **文本布局**：使用 `@chenglou/pretext` 实现精确分页/A4 布局（不依赖 DOM 重排）

## 关键目录边界
- `src/` — 前端源码（React 组件、编辑器、布局、AI 工具）
- `server/` — Python FastAPI 后端（`app/` 路由、`config/`、`data/`）
- `dist/` — 构建输出（已忽略）；由 `npm run build` 生成
- `server/config/ai.json` 和 `server/data/` 已添加至 `.gitignore`，不应提交

## 核心 npm 脚本
- `npm run dev` — 前端开发服务器（Vite，端口 5173）
- `npm run build` — 构建前端（`tsc -b` + `vite build`）输出至 `dist/`
- `npm run lint` — ESLint 检查
- `npm run start:prod` — 构建并仅启动后端（用于生产）
- `npm run preview` — 预览生产构建

## 开发规范
- **每次修改代码后必须执行 `npm run build`**，确保 TypeScript 编译与打包无误后再进行后续操作（如启动或部署）。

## Python 后端说明
- 使用 `.venv` 虚拟环境；入口 `server/main.py`（uvicorn 在 5174 运行）
- 安装依赖：`pip3 install -r server/requirements.txt --break-system-packages`
- 配置（`server/config/ai.json`）与数据（`server/data/`）仅限本地使用
- 开发代理：前端 5173 → 后端 5174 通过 Vite 的 `server.proxy`

## 开发流程
1. 启动后端：`nohup python3 server/main.py &>/tmp/openwps-server.log &`
2. 启动前端：`npx vite --host 0.0.0.0 --port 5173`
3. 访问：前端 `http://localhost:5173`，健康检查 `http://localhost:5174/api/health`

## 生产部署（关键）
- 部署前必须运行 `npm run build`
- 重启顺序：`pkill -f "python3 server/main.py"` → 启动服务 → `sleep 3` → 用 `curl` 健康检查
- 完整流程请参考 `DEPLOY.md`

## 测试与验证
- package.json 未定义单元测试；请通过手动流程验证
- 构建后应校验：`curl -s http://localhost:5174/api/health` 返回 `{"status":"ok","service":"openwps-backend"}`
- 代码质量：`npm run lint`（ESLint + TypeScript 检查）

## TypeScript / ESLint
- 严格模式启用（`tsconfig.app.json`），禁止未使用的参数与局部变量
- ESLint 配置继承 `@eslint/js`、`tseslint`、React 钩子、Vite 插件
- 未配置 Prettier；代码风格由 ESLint 与严格 tsconfig 保证

## Pretext 布局引擎
- 主依赖：`@chenglou/pretext`
- 入口点：`prepareWithSegments`、`layoutWithLines` / `layoutNextLine`
- 自定义切分：`text.split('').join('\u200b')` 用于改善中文/英文断行表现
- 位置：`src/layout/paginator.ts` 与 `src/components/PretextPageRenderer.tsx`

## AI / 工具链（LangGraph）
- 工具定义于 `src/ai/tools.ts`，通过 `src/ai/executor.ts` 执行
- 服务提供：
  - `/api/ai/chat`（流式 ReAct）
  - `/api/ai/stream/`（SSE 端点）
- 默认提供商：siliconflow；配置位于 `server/config/ai.json`（已忽略）

## 重用与默认值
- 默认字体：`'14px -apple-system, BlinkMacSystemFont, sans-serif'`（在 `AISidebar.tsx` 使用）
- 行高常量：`20`（AISidebar）
- 附件大小限制：单个文件 ≤10 MB，总计 ≤20 MB（AISidebar 常量）