# openwps Docker 部署方案

## 部署架构

Docker 生产部署采用单容器模式：

```text
浏览器 -> http://host:5174
          |-- /api/*  FastAPI 后端
          |-- /       dist 前端静态资源
```

镜像构建分两阶段：

- `frontend-builder`：安装 Node 依赖，执行 `npm run build`，生成 `dist/` 和 `server/node/.generated/`。
- `runtime`：基于 Node 20，安装 Python venv、后端依赖、Node 运行时依赖和 Chromium。后端运行时会调用 Node worker 处理 DOCX、Markdown、TXT、文档工具、Mermaid 和页面截图，所以运行镜像必须同时包含 Python、Node 和 Playwright Chromium。

## 持久化目录

compose 默认使用命名卷：

| 卷 | 容器路径 | 用途 |
| --- | --- | --- |
| `openwps_data` | `/app/server/data` | 工作区、文档、会话、模板、任务等数据 |
| `openwps_config` | `/app/server/config` | AI 配置，包含 `ai.json` 和 API Key |

不要把 `server/config/ai.json` 打进镜像，也不要提交到 Git。

## 启动

```bash
docker compose up -d --build
```

访问：

```text
http://localhost:5174
```

健康检查：

```bash
curl -s http://localhost:5174/api/health
```

期望返回：

```json
{"status":"ok","service":"openwps-backend"}
```

查看日志：

```bash
docker compose logs -f openwps
```

停止：

```bash
docker compose down
```

停止并删除数据卷：

```bash
docker compose down -v
```

## 更新发布

```bash
git pull
docker compose up -d --build
docker image prune -f
```

## 配置模型服务

在页面设置里配置 OpenAI 兼容服务商、模型和 API Key。配置会写入 `openwps_config` 卷中的 `/app/server/config/ai.json`。

如果要连接宿主机 Ollama，不要在容器内使用 `http://localhost:11434/v1`，因为 `localhost` 指向容器自身。compose 已配置 `host.docker.internal`，建议填：

```text
http://host.docker.internal:11434/v1
```

Linux Docker 需要 Docker 20.10+ 才支持 `host-gateway`。

## 反向代理建议

生产环境建议用 Nginx / Caddy / Traefik 终止 HTTPS，然后代理到容器 5174：

```nginx
location / {
  proxy_pass http://127.0.0.1:5174;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

AI 流式对话使用 SSE。Nginx 建议额外关闭代理缓冲：

```nginx
proxy_buffering off;
proxy_read_timeout 3600s;
```

## 资源建议

- CPU：2 核起，推荐 4 核。
- 内存：2GB 起，推荐 4GB 以上。
- `shm_size`：compose 默认设置为 `1gb`，用于 Chromium 截图和 Mermaid 渲染。
- 磁盘：工作区文档、版本快照和缓存会增长，建议定期备份 `openwps_data` 和 `openwps_config`。
