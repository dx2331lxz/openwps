# openwps 仓库特定指导

**默认使用中文回答。**

## 架构概述
- **前端**：React 19 + TypeScript + Vite（开发端口 5173）
- **后端**：Python FastAPI + LangGraph（端口 5174），生产环境挂载在 `/api`
- **运行时**：单端口部署（后端托管 `dist/` 于 5174）
- **文档模型**：ProseMirror（schema 在 `src/editor/schema.ts`）
- **布局引擎**：`@chenglou/pretext`（纯算术分页，不依赖 DOM 重排），详见 `docs/PRETEXT.md`
- **样式**：Tailwind CSS v4（通过 `@tailwindcss/vite` 插件，非 PostCSS）

## AI / 控制器职责边界
- **所有 AI 与控制器逻辑以后端为准**：ReAct 主循环、是否继续/停止、工具调度、任务状态门、子代理、上下文 delta、workspace manifest、OCR、联网搜索、文档写入和写后验证都应放在 `server/`。
- **前端只负责展示与用户手动编辑**：`src/` 侧负责编辑器交互、分页可视层、AI SSE 事件展示、工具/子代理轨迹展示，以及用户通过 UI 直接修改文档。
- **不要把 AI 状态机放回前端**：前端不得判断工作区文件是否“新增”、不得驱动 ReAct 是否继续、不得根据任务列表强制续跑、不得决定是否搜索/读取工作区资料。
- **workspace 是后端事实来源**：工作区文件上传、存储、manifest 和 delta 判断都由后端负责；前端可以展示 `/api/workspace` 返回的列表，但不要在 AI 请求中注入 `context.workspaceDocs`。
- **文档状态同步原则**：用户手动编辑可以发生在前端 ProseMirror/Pretext；AI 运行时需要的文档状态必须通过后端文档会话和工具接口读取/写入，避免前端与后端各自维护一套 AI 事实。

## 双层渲染注意事项
- 当前编辑器是**双层结构**：隐藏的 ProseMirror DOM 负责真实文档状态、selection、transaction；可见层 `PretextPageRenderer` 负责分页绘制、命中区域和可视反馈。
- 任何交互或样式改动都必须同时检查这两层，否则很容易出现两类问题：
  1. **底层状态已变，但可见层没显示**，例如工具栏状态切换成功，但分页页内没有渲染对应标记。
  2. **可见层点中了，但底层没同步**，例如点击命中区域后视觉上有反馈，但 ProseMirror selection/attrs 没更新，或副作用被触发两次。
- 排查这类问题时，优先分清问题发生在：
  - ProseMirror 文档模型 / schema / transaction
  - `paginator.ts` 生成的分页数据
  - `PretextPageRenderer.tsx` 的可见绘制与命中层
- 结论：只改 DOM 层或只改分页层通常都不够，涉及光标、列表、图片、点击、选区、批注这类功能时，必须做双层联调与验证。

### 图片 / DOCX 导入专项经验
- 症状如果是“DOCX 已经导入成功，图片也存在，但图片覆盖正文、文字顶到图片下面、光标位置和可视层不一致”，优先怀疑**隐藏 DOM 与分页层的盒模型不一致**，不要只盯着导入解析逻辑。
- 这次问题的根因不是 DOCX 没解析出图片，而是 `imageNodeView.ts` 中图片 wrapper 存在上下各 2px 的透明边框，导致隐藏 DOM 实际占高比分页层估算多 4px；分页层当时只按图片内容高度排版，最终出现可视层文字提前上移，被上层 DOM 图片压住。
- 结论：图片节点的**可见高度**、**命中高度**、**DOM 实际占高**、**分页估算高度**必须保持一致；只要其中一个口径不同，就会出现“看起来像重叠、其实是两层高度不一致”的问题。
- 这类问题的优先排查顺序：
  1. 先确认 DOCX 是否真的把图片节点导入进 ProseMirror JSON，而不是先假设导入失败。
  2. 再确认 `imageNodeView.ts` 里真实 DOM 结构是否额外引入 border、padding、wrapper 或 resize handle 占高。
  3. 然后核对 `paginator.ts` 对图片高度的估算是否把这些额外像素算进去。
  4. 最后检查 `PretextPageRenderer.tsx` 是否重复渲染了图片，或者遗漏了图片后的段间距。
- 这类问题的验证方式不要只靠肉眼。应该同时做两件事：
  1. 浏览器里量 `img`、包裹它的段落、下一段正文的 `getBoundingClientRect()`，看图片段落底部和下一段顶部是否严格衔接。
  2. 再结合截图确认最终视觉上没有“字钻到图下面”的现象。
- 对图片相关改动，默认要做四项回归：
  1. 普通插入图片。
  2. 导入 DOCX 内联图片。
  3. 图片后紧跟正文、标题、列表。
  4. 图片缩放后重新分页，确认不会重新出现压字、光标漂移或点击区域错位。
- 对 DOCX 问题要避免一个常见误判：**“导入成功但显示异常”并不等于“importer 有问题”**。如果图片资源和节点都在，只是显示层错位，通常应该先查双层渲染同步，而不是先重写解析器。

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
