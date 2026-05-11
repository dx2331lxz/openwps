#!/usr/bin/env node

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')

const PORT = 5173
const BASE_URL = `http://127.0.0.1:${PORT}`
const DIST_DIR = path.join(__dirname, '..', 'dist')
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots')

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })

let workspaceMarkdown = [
    '# Workspace Markdown',
    '',
    '这是工作区 Markdown 正文。',
    '',
    '- 渲染为列表',
    '',
    ...Array.from({ length: 48 }, (_, index) => {
        const sectionNumber = index + 1
        return [
            `## Section ${sectionNumber}`,
            '',
            `这是第 ${sectionNumber} 个长文档段落，用来验证 Markdown 预览和源码切换时不会回到开头。`,
            '',
            `- Section ${sectionNumber} list item A`,
            `- Section ${sectionNumber} list item B`,
        ].join('\n')
    }),
].join('\n')
let memoryMarkdown = [
    '---',
    'name: Memory Metadata',
    'description: should not render',
    'type: project',
    '---',
    '',
    '# Memory Markdown',
    '',
    '这是记忆 Markdown 正文。',
].join('\n')

function sendJson(res, payload, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
}

function startStaticServer() {
    return new Promise((resolve, reject) => {
        const mime = {
            html: 'text/html',
            js: 'application/javascript',
            css: 'text/css',
            svg: 'image/svg+xml',
            png: 'image/png',
            ico: 'image/x-icon',
            json: 'application/json',
        }

        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url || '/', BASE_URL)
            const pathname = decodeURIComponent(url.pathname)

            if (pathname.startsWith('/api/templates')) {
                sendJson(res, [])
                return
            }

            if (pathname === '/api/workspaces') {
                sendJson(res, {
                    activeWorkspaceId: 'default',
                    workspaces: [{ id: 'default', name: '默认工作区' }],
                })
                return
            }

            if (pathname === '/api/workspaces/default/active' && req.method === 'POST') {
                sendJson(res, { activeWorkspaceId: 'default' })
                return
            }

            if (pathname === '/api/workspaces/default/tree') {
                sendJson(res, {
                    workspaceId: 'default',
                    root: {
                        name: 'default',
                        path: '',
                        kind: 'directory',
                        role: 'workspace',
                        children: [
                            {
                                name: '.openwps',
                                path: '.openwps',
                                kind: 'directory',
                                role: 'openwps',
                                isMemory: true,
                                children: [
                                    {
                                        name: 'memory',
                                        path: '.openwps/memory',
                                        kind: 'directory',
                                        role: 'memoryFolder',
                                        isMemory: true,
                                        children: [
                                            {
                                                name: 'notes.md',
                                                path: '.openwps/memory/notes.md',
                                                kind: 'file',
                                                role: 'memory',
                                                type: 'md',
                                                extension: '.md',
                                                editable: true,
                                                isMemory: true,
                                            },
                                        ],
                                    },
                                ],
                            },
                            {
                                name: 'docs',
                                path: 'docs',
                                kind: 'directory',
                                role: 'folder',
                                children: [
                                    {
                                        name: 'report.md',
                                        path: 'docs/report.md',
                                        kind: 'file',
                                        role: 'document',
                                        type: 'md',
                                        extension: '.md',
                                        editable: true,
                                    },
                                ],
                            },
                        ],
                    },
                })
                return
            }

            if (pathname === '/api/workspaces/default/files/docs/report.md/content' && req.method === 'GET') {
                sendJson(res, {
                    workspaceId: 'default',
                    path: 'docs/report.md',
                    name: 'report.md',
                    type: 'md',
                    content: workspaceMarkdown,
                })
                return
            }

            if (pathname === '/api/workspaces/default/files/docs/report.md' && req.method === 'PUT') {
                workspaceMarkdown = await readBody(req)
                sendJson(res, {
                    workspaceId: 'default',
                    path: 'docs/report.md',
                    name: 'report.md',
                    type: 'md',
                })
                return
            }

            if (pathname === '/api/workspaces/default/memory/files/notes.md' && req.method === 'GET') {
                sendJson(res, {
                    workspaceId: 'default',
                    path: '.openwps/memory/notes.md',
                    memoryPath: 'notes.md',
                    content: memoryMarkdown,
                })
                return
            }

            if (pathname === '/api/workspaces/default/memory/files/notes.md' && req.method === 'PUT') {
                memoryMarkdown = await readBody(req)
                sendJson(res, {
                    workspaceId: 'default',
                    path: '.openwps/memory/notes.md',
                    memoryPath: 'notes.md',
                    name: 'notes.md',
                    type: 'md',
                })
                return
            }

            if (pathname === '/api/doc-sessions' && req.method === 'POST') {
                await readBody(req)
                sendJson(res, { documentSessionId: 'doc_markdown_test', version: 1 })
                return
            }

            if (pathname === '/api/doc-sessions/doc_markdown_test/active' && req.method === 'POST') {
                await readBody(req)
                sendJson(res, { documentSessionId: 'doc_markdown_test', version: 1, active: true })
                return
            }

            if (pathname === '/api/doc-sessions/doc_markdown_test/client-patches' && req.method === 'POST') {
                await readBody(req)
                sendJson(res, { documentSessionId: 'doc_markdown_test', version: 2 })
                return
            }

            if (pathname === '/api/doc-sessions/doc_markdown_test/events') {
                res.writeHead(204)
                res.end()
                return
            }

            let filePath = path.join(DIST_DIR, pathname === '/' ? '/index.html' : pathname)
            const ext = path.extname(filePath).slice(1)

            fs.readFile(filePath, (err, data) => {
                if (err) {
                    fs.readFile(path.join(DIST_DIR, 'index.html'), (fallbackErr, fallbackData) => {
                        if (fallbackErr) {
                            res.writeHead(404)
                            res.end('Not found')
                            return
                        }
                        res.writeHead(200, { 'Content-Type': 'text/html' })
                        res.end(fallbackData)
                    })
                    return
                }

                res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' })
                res.end(data)
            })
        })

        server.listen(PORT, '127.0.0.1', () => resolve(server))
        server.on('error', reject)
    })
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function screenshot(page, name) {
    const file = path.join(SCREENSHOTS_DIR, `test-${name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}.png`)
    await page.screenshot({ path: file, fullPage: false })
    return file
}

async function run() {
    const server = await startStaticServer()
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
    const consoleErrors = []
    let lastDialogMessage = ''

    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (error) => {
        consoleErrors.push(error.message)
    })
    page.on('dialog', async (dialog) => {
        lastDialogMessage = dialog.message()
        await dialog.accept()
    })

    try {
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 })
        await page.waitForSelector('.ProseMirror', { timeout: 10000 })

        const markdown = [
            '# OpenAI 评价报告',
            '',
            '## 技术成就',
            '- **语言模型突破**：GPT-3（1750亿参数）和 GPT-4。',
            '- [ ] 待完成事项',
            '- [x] 已完成事项',
        ].join('\n')

        const importInput = page.locator('input[type="file"][accept*=".md"]')
        await importInput.setInputFiles({
            name: 'markdown-import-regression.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from(markdown, 'utf8'),
        })

        await page.waitForFunction(() => {
            return Array.from(document.querySelectorAll('.ProseMirror p')).some((paragraph) => {
                return paragraph.textContent?.includes('语言模型突破')
            })
        }, { timeout: 10000 })
        await page.waitForTimeout(400)
        await screenshot(page, 'markdown-import-regression')

        assert(lastDialogMessage === 'Markdown 导入成功', `导入提示异常: ${lastDialogMessage || '未收到提示'}`)

        const result = await page.evaluate(() => {
            const paragraphs = Array.from(document.querySelectorAll('.ProseMirror p'))
            const targetParagraph = paragraphs.find((paragraph) => paragraph.textContent?.includes('语言模型突破'))
            const pendingTask = paragraphs.find((paragraph) => paragraph.textContent?.includes('待完成事项'))
            const completedTask = paragraphs.find((paragraph) => paragraph.textContent?.includes('已完成事项'))
            if (!targetParagraph) {
                return { found: false }
            }

            const span = Array.from(targetParagraph.querySelectorAll('span')).find((item) => {
                return item.textContent?.includes('语言模型突破')
            })
            const weight = span ? window.getComputedStyle(span).fontWeight : null

            return {
                found: true,
                text: targetParagraph.textContent ?? '',
                containsRawMarkdown: (targetParagraph.textContent ?? '').includes('**'),
                boldText: span?.textContent ?? '',
                fontWeight: weight,
                pendingTask: pendingTask
                    ? {
                        className: pendingTask.className,
                        listType: pendingTask.getAttribute('data-list-type'),
                        checked: pendingTask.getAttribute('data-list-checked'),
                        text: pendingTask.textContent ?? '',
                    }
                    : null,
                completedTask: completedTask
                    ? {
                        className: completedTask.className,
                        listType: completedTask.getAttribute('data-list-type'),
                        checked: completedTask.getAttribute('data-list-checked'),
                        text: completedTask.textContent ?? '',
                    }
                    : null,
            }
        })

        assert(result.found, '未找到导入后的目标列表项段落')
        assert(!result.containsRawMarkdown, `正文仍包含 markdown 标记: ${result.text}`)
        assert(result.boldText === '语言模型突破', `粗体文本不符合预期: ${result.boldText}`)
        assert(result.fontWeight && (result.fontWeight === 'bold' || Number(result.fontWeight) >= 700), `粗体样式未生效: ${result.fontWeight}`)
        assert(result.pendingTask?.listType === 'task', `未完成任务项类型异常: ${JSON.stringify(result.pendingTask)}`)
        assert(result.pendingTask?.checked === 'false', `未完成任务项状态异常: ${JSON.stringify(result.pendingTask)}`)
        assert(!result.pendingTask?.text.includes('[ ]'), `未完成任务项仍保留原始 markdown: ${result.pendingTask?.text}`)
        assert(result.completedTask?.listType === 'task', `已完成任务项类型异常: ${JSON.stringify(result.completedTask)}`)
        assert(result.completedTask?.checked === 'true', `已完成任务项状态异常: ${JSON.stringify(result.completedTask)}`)
        assert(!result.completedTask?.text.includes('[x]'), `已完成任务项仍保留原始 markdown: ${result.completedTask?.text}`)

        console.log('✅ Markdown 导入列表粗体回归测试通过')

        await page.getByTitle('工作区').first().click()
        await page.getByTitle('docs').click()
        await page.getByTitle('docs/report.md').click()
        await page.waitForFunction(() => {
            const h1 = document.querySelector('[data-openwps-markdown-view="true"] h1')
            return h1?.textContent === 'Workspace Markdown'
        }, { timeout: 10000 })

        const workspaceRender = await page.evaluate(() => {
            const markdownRoot = document.querySelector('[data-openwps-markdown-view="true"]')
            const canvas = document.querySelector('[data-openwps-document-canvas="true"]')
            return {
                title: markdownRoot?.querySelector('h1')?.textContent ?? '',
                listItem: markdownRoot?.querySelector('li')?.textContent ?? '',
                canvasDisplay: canvas ? window.getComputedStyle(canvas).display : '',
            }
        })
        assert(workspaceRender.title === 'Workspace Markdown', `工作区 Markdown 标题未按 h1 渲染: ${JSON.stringify(workspaceRender)}`)
        assert(workspaceRender.listItem.includes('渲染为列表'), `工作区 Markdown 列表未渲染: ${JSON.stringify(workspaceRender)}`)
        assert(workspaceRender.canvasDisplay === 'none', `Markdown 模式下分页画布仍可见: ${workspaceRender.canvasDisplay}`)

        await page.evaluate(() => {
            const target = Array.from(document.querySelectorAll('[data-openwps-markdown-view="true"] h2'))
                .find((heading) => heading.textContent === 'Section 34')
            target?.scrollIntoView({ block: 'start' })
        })
        await page.waitForTimeout(100)
        const previewBeforeToggle = await page.evaluate(() => {
            const scroller = document.querySelector('[data-openwps-markdown-scroll="true"]')
            const target = Array.from(document.querySelectorAll('[data-openwps-markdown-view="true"] h2'))
                .find((heading) => heading.textContent === 'Section 34')
            return {
                scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : 0,
                targetTop: target instanceof HTMLElement ? target.getBoundingClientRect().top : 0,
            }
        })
        assert(previewBeforeToggle.scrollTop > 1000, `长 Markdown 预览没有滚到中后段: ${JSON.stringify(previewBeforeToggle)}`)

        await page.locator('[data-openwps-markdown-source-toggle="true"]').click()
        await page.waitForSelector('[data-openwps-markdown-source="true"]', { timeout: 10000 })
        await page.waitForTimeout(100)
        const sourceAfterToggle = await page.locator('[data-openwps-markdown-source="true"]').evaluate((textarea) => {
            const source = textarea instanceof HTMLTextAreaElement ? textarea : null
            return {
                scrollTop: source?.scrollTop ?? 0,
                maxScroll: source ? source.scrollHeight - source.clientHeight : 0,
            }
        })
        assert(sourceAfterToggle.maxScroll > 0, `长 Markdown 源码区域没有内部滚动空间: ${JSON.stringify(sourceAfterToggle)}`)
        assert(sourceAfterToggle.scrollTop > sourceAfterToggle.maxScroll * 0.45, `预览切到源码后位置回到了开头: ${JSON.stringify(sourceAfterToggle)}`)

        await page.locator('[data-openwps-markdown-preview-toggle="true"]').click()
        await page.waitForSelector('[data-openwps-markdown-view="true"] h2', { timeout: 10000 })
        await page.waitForTimeout(100)
        const previewAfterToggle = await page.evaluate(() => {
            const root = document.querySelector('[data-openwps-markdown-view="true"]')
            const scroller = document.querySelector('[data-openwps-markdown-scroll="true"]')
            const header = root?.querySelector('[data-openwps-markdown-header="true"]')
            const headerBottom = header instanceof HTMLElement ? header.getBoundingClientRect().bottom : 0
            const visibleHeading = Array.from(document.querySelectorAll('[data-openwps-markdown-view="true"] h2'))
                .find((heading) => {
                    if (!(heading instanceof HTMLElement)) return false
                    const rect = heading.getBoundingClientRect()
                    return rect.bottom > headerBottom + 8 && rect.top < window.innerHeight
                })
            const headingNumber = Number((visibleHeading?.textContent || '').replace(/^Section\s+/, ''))
            const scrollerTop = scroller instanceof HTMLElement ? scroller.getBoundingClientRect().top : 0
            return {
                scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : 0,
                visibleHeading: visibleHeading?.textContent ?? '',
                headingNumber,
                headerBottom,
                scrollerTop,
            }
        })
        assert(previewAfterToggle.scrollTop > 1000, `源码切回预览后位置回到了开头: ${JSON.stringify(previewAfterToggle)}`)
        assert(previewAfterToggle.headingNumber >= 18, `源码切回预览后没有保持在同一阅读区域: ${JSON.stringify(previewAfterToggle)}`)
        assert(previewAfterToggle.scrollerTop >= previewAfterToggle.headerBottom - 1, `Markdown 控制条遮挡了正文滚动区: ${JSON.stringify(previewAfterToggle)}`)
        console.log('✅ Markdown 预览/源码切换滚动位置保持回归测试通过')

        await page.waitForTimeout(700)
        await page.reload({ waitUntil: 'networkidle', timeout: 15000 })
        await page.waitForFunction(() => {
            const h1 = document.querySelector('[data-openwps-markdown-view="true"] h1')
            return h1?.textContent === 'Workspace Markdown'
        }, { timeout: 10000 })
        const restoredMarkdownRender = await page.evaluate(() => {
            const markdownRoot = document.querySelector('[data-openwps-markdown-view="true"]')
            const canvas = document.querySelector('[data-openwps-document-canvas="true"]')
            return {
                title: markdownRoot?.querySelector('h1')?.textContent ?? '',
                hasSource: Boolean(document.querySelector('[data-openwps-markdown-source="true"]')),
                canvasDisplay: canvas ? window.getComputedStyle(canvas).display : '',
            }
        })
        assert(restoredMarkdownRender.title === 'Workspace Markdown', `刷新后未恢复 Markdown 预览: ${JSON.stringify(restoredMarkdownRender)}`)
        assert(restoredMarkdownRender.canvasDisplay === 'none', `刷新后 Markdown 又回到分页文档视图: ${JSON.stringify(restoredMarkdownRender)}`)
        console.log('✅ Markdown 刷新缓存恢复回归测试通过')

        await page.locator('[data-openwps-markdown-source-toggle="true"]').click()
        await page.locator('[data-openwps-markdown-source="true"]').fill('# Workspace Markdown\n\n- saved from source\n')
        await page.locator('[data-openwps-markdown-save="true"]').click()
        await page.waitForFunction(() => {
            const button = document.querySelector('[data-openwps-markdown-save="true"]')
            return button instanceof HTMLButtonElement && button.disabled
        }, { timeout: 10000 })
        assert(workspaceMarkdown.includes('saved from source'), `源码保存没有写回 Markdown 文件: ${workspaceMarkdown}`)

        await page.getByTitle('工作区').first().click()
        await page.getByTitle('.openwps/memory/notes.md').click()
        await page.waitForFunction(() => {
            const h1 = document.querySelector('[data-openwps-markdown-view="true"] h1')
            return h1?.textContent === 'Memory Markdown'
        }, { timeout: 10000 })
        await page.locator('[data-openwps-markdown-source-toggle="true"]').click()
        await page.locator('[data-openwps-markdown-source="true"]').fill('---\nname: Memory Metadata\ndescription: should not render\ntype: project\n---\n\n# Memory Markdown\n\nmemory saved\n')
        await page.locator('[data-openwps-markdown-save="true"]').click()
        await page.waitForFunction(() => {
            const button = document.querySelector('[data-openwps-markdown-save="true"]')
            return button instanceof HTMLButtonElement && button.disabled
        }, { timeout: 10000 })
        assert(memoryMarkdown.includes('memory saved'), `记忆 Markdown 保存没有走 memory API: ${memoryMarkdown}`)

        await page.locator('[data-openwps-markdown-preview-toggle="true"]').click()
        await page.waitForFunction(() => {
            const h1 = document.querySelector('[data-openwps-markdown-view="true"] h1')
            return h1?.textContent === 'Memory Markdown'
        }, { timeout: 10000 })
        const frontmatterVisible = await page.locator('.openwps-markdown-body').evaluate((root) => {
            const text = root.textContent || ''
            return text.includes('Memory Metadata') || text.includes('type: project')
        })
        assert(!frontmatterVisible, 'Markdown 预览不应显示 YAML frontmatter')
        await screenshot(page, 'workspace-markdown-render')
        console.log('✅ 工作区 Markdown 默认渲染与源码保存回归测试通过')

        if (consoleErrors.length === 0) {
            console.log('✅ 无 Console 错误')
        } else {
            console.log('⚠️ Console 错误:')
            consoleErrors.forEach((error) => console.log(`  ${error}`))
        }
    } finally {
        await browser.close()
        server.close()
    }
}

run().catch((error) => {
    console.error(`❌ Markdown 导入列表粗体回归测试失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
