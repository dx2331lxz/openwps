# openwps

openwps 当前同时包含两条实现线：

1. Web 版编辑器：React + Vite + FastAPI，是目前功能最完整、可直接使用的主线。
2. Native V2 原型：Rust workspace，正在按原生桌面软件规格逐步实现 document-core、storage、app-shell 等模块。

## 当前状态

- Web 版可运行，可用于现有编辑、排版和 AI 助手能力验证。
- Native V2 已完成第一批基础设施：文档模型、命令系统、Undo/Redo、native-storage 第一版。
- Native V2 现在还不是完整办公软件，当前可运行的是原生窗口壳和底层 crate 测试闭环。

## 运行环境

建议环境：

- Node.js 20+
- Python 3.11+
- Rust stable
- macOS 当前优先验证，Windows 为下一阶段目标

## 运行 Web 版

首次安装依赖：

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt
```

配置 AI：

- 编辑 server/config/ai.json
- 填入兼容 OpenAI 接口的 base URL、model 和 API key

开发模式：

```bash
source .venv/bin/activate
python3 server/main.py
```

另开一个终端：

```bash
npm run dev -- --host
```

默认端口：

- 前端：http://localhost:5173
- 后端：http://localhost:5174

生产构建：

```bash
npm run build
source .venv/bin/activate
python3 server/main.py
```

然后访问 http://localhost:5174。

## 运行 Native V2

Native V2 位于 native 目录，当前适合做 crate 级验证和基础窗口运行。

先进入原生 workspace：

```bash
cd native
```

运行关键测试：

```bash
cargo test -p document-core
cargo test -p native-storage
```

启动当前原生窗口壳：

```bash
cargo run -p app-shell
```

你现在会看到一个原生窗口，标题和状态行会展示 Native V2 当前接入的文档运行时状态。

## 仓库结构

```text
openwps/
├── src/                     # Web 前端
├── server/                  # Python 后端
├── docs/                    # 设计与规格文档
├── native/                  # Rust 原生 workspace
│   ├── crates/
│   │   ├── document-core/
│   │   ├── native-storage/
│   │   ├── app-shell/
│   │   ├── editor-runtime/
│   │   ├── layout-engine/
│   │   ├── renderer-skia/
│   │   ├── docx-interop/
│   │   └── ai-bridge/
│   └── specs/
└── public/
```

## 常用命令

Web：

```bash
npm run dev
npm run build
```

Native：

```bash
cd native
cargo test -p document-core
cargo test -p native-storage
cargo run -p app-shell
```

## 相关文档

- [DEPLOY.md](./DEPLOY.md)
- [docs/PRETEXT.md](./docs/PRETEXT.md)
- [docs/NATIVE_SOFTWARE_PLAN.md](./docs/NATIVE_SOFTWARE_PLAN.md)
- [native/specs/01-document-model.md](./native/specs/01-document-model.md)
- [native/specs/02-command-protocol.md](./native/specs/02-command-protocol.md)

## GitHub

https://github.com/dx2331lxz/openwps
