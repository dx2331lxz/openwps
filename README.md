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
pip3 install -r server/requirements.txt --break-system-packages

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

## 架构边界

openwps 的 AI 与控制器逻辑以后端为准：

- **后端负责 AI 编排**：ReAct 主循环、工具选择与执行、上下文注入、工作区 manifest、任务/停止条件、子代理调度、OCR/联网搜索、文档写入和验证都放在 `server/`。
- **前端负责展示与手动编辑**：React 侧只渲染编辑器、分页视图、AI 流式事件、工具/子代理轨迹和用户可直接操作的编辑控件。
- **前端不做 AI 状态机判断**：不要在前端判断“工作区新增”、任务是否完成、是否继续 ReAct、是否该搜索/读取资料，也不要把后端已有的 workspace manifest 每轮塞进 AI context。
- **用户手动编辑仍在前端发生**：ProseMirror/Pretext 负责交互和可视编辑；需要 AI 使用的文档状态通过后端文档会话与工具接口同步，由后端作为 AI 运行时的事实来源。

## AI 联网搜索

项目已集成 Tavily web search，AI 可以在需要最新外部信息时自动调用联网搜索。

### 配置方式

1. 启动后端与前端后，打开设置弹窗。
2. 在 AI 设置中正常配置一个可用的大模型提供商。
3. 在新增的 Tavily 配置区域填写 API Key，并按需设置：
	- `Search Depth`：`basic` 或 `advanced`
	- `Topic`：`general` 或 `news`
	- `Max Results`
	- `Timeout Seconds`

### 说明

- Tavily API Key 仅保存在后端配置中，不会下发到浏览器。
- `web_search` 工具由后端执行，前端只接收工具调用结果与最终回答。
- 后端健康检查地址为 `http://localhost:5174/api/health`。

### 验证是否生效

在 AI 侧边栏发送类似问题：

```text
请联网搜索今天的 OpenAI 最新新闻，并简短总结。
```

如果配置正确，AI 会自动触发 `web_search`，并基于 Tavily 返回的实时结果生成回答。

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

| 层       | 技术                                             |
| -------- | ------------------------------------------------ |
| 框架     | React + TypeScript + Vite                        |
| 文档模型 | ProseMirror                                      |
| 布局引擎 | @chenglou/pretext                                |
| 后端     | Python FastAPI + LangGraph                       |
| AI       | OpenAI 兼容接口（硅基流动/OpenAI/Claude/Ollama） |
| Markdown | marked                                           |

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
│   ├── main.py       # FastAPI 入口壳
│   ├── app/          # LangGraph/路由/配置/存储
│   ├── requirements.txt
│   ├── config/       # AI 配置（不提交）
│   └── data/         # 会话数据（不提交）
├── docs/             # 项目设计说明
└── dist/             # 构建产物
```

## GitHub

https://github.com/dx2331lxz/openwps
