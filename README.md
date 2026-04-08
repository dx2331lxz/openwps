# openwps

AI 驱动的 WPS 级排版 Web 文档编辑器。

## 功能

- **精确分页**：基于 [@chenglou/pretext](https://github.com/chenglou/pretext)，A4 精确布局，不依赖 CSS
- **完整排版工具栏**：字体/字号/颜色/对齐/缩进/行距/列表/表格等 16+ 功能
- **AI 排版助手**：类 VS Code Copilot 侧边栏，自然语言驱动排版
- **流式 AI 输出**：SSE 逐 token 推送，思考过程可折叠显示
- **ReAct 架构**：AI 多轮工具调用，默认 50 轮
- **会话历史**：对话持久化，支持切换历史会话
- **Markdown 渲染**：AI 回复支持 Markdown 格式
- **多模型支持**：硅基流动 / OpenAI / Claude / Ollama 自定义端点

## 快速开始

```bash
# 安装依赖
npm install
pip3 install fastapi uvicorn httpx --break-system-packages

# 配置 AI（在设置界面或直接编辑）
# server/config/ai.json 填写端点和 API Key

# 开发模式
python3 server/main.py &    # 后端 5174
npx vite --host             # 前端 5173

# 生产模式（单端口）
npm run build
python3 server/main.py
# 访问 http://localhost:5174
```

## 发布流程

**每次改动完成后必须执行：**

```bash
cd ~/projects/openwps
npm run build
pkill -f "python3 server/main.py" 2>/dev/null
nohup python3 server/main.py &>/tmp/openwps-server.log &
sleep 3 && curl -s http://localhost:5174/api/health
git add -A && git commit -m "描述" && git push
```

详细说明见 [DEPLOY.md](./DEPLOY.md)

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | React + TypeScript + Vite |
| 文档模型 | ProseMirror |
| 布局引擎 | @chenglou/pretext |
| 后端 | Python FastAPI |
| AI | OpenAI 兼容接口（硅基流动/OpenAI/Claude/Ollama） |
| Markdown | marked |

## 排版引擎说明

项目的文本测量与分页都以 `@chenglou/pretext` 为基础。

- `prepare/prepareWithSegments`：对文本做一次性预处理与宽度测量缓存
- `layout/layoutWithLines`：在给定宽度下做纯算术断行与高度计算
- `walkLineRanges/layoutNextLine`：支持更细粒度的逐行排版，适合分页、多栏、绕排

详细原理和在本项目中的接入方式见 [docs/PRETEXT.md](./docs/PRETEXT.md)

## 目录结构

```
openwps/
├── src/              # 前端源码
├── server/           # Python 后端
│   ├── main.py       # FastAPI 入口
│   ├── config/       # AI 配置（不提交）
│   └── data/         # 会话数据（不提交）
├── docs/             # 项目设计说明
└── dist/             # 构建产物
```

## GitHub

https://github.com/dx2331lxz/openwps
