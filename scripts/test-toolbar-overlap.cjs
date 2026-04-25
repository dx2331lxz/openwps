#!/usr/bin/env node

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')

const PORT = 5177
const BASE_URL = `http://127.0.0.1:${PORT}`
const DIST_DIR = path.join(__dirname, '..', 'dist')
const initialWorkspaceDocs = [
    {
        id: 'mock-pdf',
        name: '初试成绩.pdf',
        type: 'pdf',
        size: 572518,
        textLength: 769,
        uploadedAt: '2026-04-25T08:00:00.000Z',
    },
    {
        id: 'mock-docx',
        name: '项目申报参考材料.docx',
        type: 'docx',
        size: 183224,
        textLength: 4216,
        uploadedAt: '2026-04-25T08:10:00.000Z',
    },
]

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function startStaticServer() {
    let workspaceDocs = [...initialWorkspaceDocs]
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/api/ai/settings')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                activeProviderId: 'mock',
                model: 'mock-model',
                providers: [{ id: 'mock', name: 'Mock', apiKey: '', baseUrl: '', models: ['mock-model'] }],
            }))
            return
        }

        if (req.url?.startsWith('/api/ai/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ models: [{ id: 'mock-model', name: 'mock-model' }], defaultModel: 'mock-model' }))
            return
        }

        if (req.url === '/api/conversations' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('[]')
            return
        }

        if (req.url === '/api/workspace' && req.method === 'GET') {
            if (workspaceDocs.length < initialWorkspaceDocs.length) workspaceDocs = [...initialWorkspaceDocs]
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(workspaceDocs))
            return
        }

        if (req.url?.startsWith('/api/workspace/upload') && req.method === 'POST') {
            const newDoc = {
                id: `mock-upload-${Date.now()}`,
                name: '上传测试文档.txt',
                type: 'txt',
                size: 1200,
                textLength: 120,
                uploadedAt: new Date().toISOString(),
            }
            workspaceDocs = [newDoc, ...workspaceDocs]
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(newDoc))
            return
        }

        if (req.url?.startsWith('/api/workspace/') && req.method === 'DELETE') {
            const docId = decodeURIComponent(req.url.split('/').pop() || '')
            workspaceDocs = workspaceDocs.filter((doc) => doc.id !== docId)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
            return
        }

        if (req.url?.startsWith('/api/templates')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('[]')
            return
        }

        const mime = {
            html: 'text/html',
            js: 'application/javascript',
            css: 'text/css',
            svg: 'image/svg+xml',
            png: 'image/png',
            ico: 'image/x-icon',
            json: 'application/json',
        }

        let filePath = path.join(DIST_DIR, req.url === '/' ? '/index.html' : req.url)
        filePath = filePath.split('?')[0]
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

    return new Promise((resolve, reject) => {
        server.listen(PORT, '127.0.0.1', () => resolve(server))
        server.on('error', reject)
    })
}

function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

async function getToolbarRects(page) {
    return page.evaluate(() => {
        const rectOf = (element) => {
            const rect = element.getBoundingClientRect()
            return {
                text: element.textContent || element.getAttribute('title') || '',
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
            }
        }
        const buttons = Array.from(document.querySelectorAll('button'))
            .filter((button) => {
                const rect = button.getBoundingClientRect()
                return rect.top < 54 && rect.height > 0 && rect.width > 0
            })
            .map(rectOf)
        return buttons
    })
}

async function assertNoTopBarOverlap(page, label) {
    const rects = await getToolbarRects(page)
    for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
            assert(!intersects(rects[i], rects[j]), `${label}: 顶部按钮重叠：${rects[i].text} / ${rects[j].text}`)
        }
    }
}

async function assertWorkspaceBelowToolbar(page, label) {
    const { toolbar, workspace, viewportHeight } = await page.evaluate(() => {
        const rectOf = (selector) => {
            const element = document.querySelector(selector)
            if (!element) return null
            const rect = element.getBoundingClientRect()
            return {
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height,
            }
        }
        return {
            toolbar: rectOf('[data-openwps-toolbar-shell="true"]'),
            workspace: rectOf('[data-openwps-workspace-panel="true"]'),
            viewportHeight: window.innerHeight,
        }
    })
    assert(toolbar, `${label}: 未找到顶部工具栏`)
    assert(workspace, `${label}: 未找到工作区面板`)
    assert(workspace.top >= toolbar.bottom - 1, `${label}: 工作区没有位于工具栏下方 toolbar.bottom=${toolbar.bottom} workspace.top=${workspace.top}`)
    assert(workspace.height <= viewportHeight - toolbar.bottom + 1, `${label}: 工作区高度超出内容区`)
}

async function assertWorkspacePanelUsable(page, label) {
    await page.waitForSelector('[data-openwps-workspace-panel="true"]', { timeout: 5000 })
    await assertWorkspaceBelowToolbar(page, label)
    await page.waitForSelector('[data-openwps-workspace-doc-row="true"]', { timeout: 5000 })
    const rows = await page.locator('[data-openwps-workspace-doc-row="true"]').count()
    assert(rows >= 2, `${label}: 工作区文档列表未渲染`)
    await page.waitForSelector('[data-openwps-workspace-upload-button="true"]', { timeout: 5000 })
    const uploadButtonText = await page.locator('[data-openwps-workspace-upload-button="true"]').innerText()
    assert(uploadButtonText.includes('上传文件'), `${label}: 上传按钮文案未完整显示`)
    const uploadButtonBox = await page.locator('[data-openwps-workspace-upload-button="true"]').boundingBox()
    assert(uploadButtonBox && uploadButtonBox.height <= 38, `${label}: 上传按钮高度异常，疑似文字换行`)
    const accept = await page.locator('[data-openwps-workspace-panel="true"] input[type="file"]').getAttribute('accept')
    assert(accept === '.docx,.txt,.md,.markdown,.pdf,.ppt,.pptx', `${label}: 上传格式 accept 不正确`)

    const firstRow = page.locator('[data-openwps-workspace-doc-row="true"]').first()
    await firstRow.hover()
    await firstRow.locator('[data-openwps-workspace-delete="true"]').click()
    await page.waitForTimeout(100)
    const rowsAfterDelete = await page.locator('[data-openwps-workspace-doc-row="true"]').count()
    assert(rowsAfterDelete === rows - 1, `${label}: 删除工作区文档后列表未更新`)
}

async function run() {
    const server = await startStaticServer()
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })

    try {
        for (const viewport of [
            { width: 1440, height: 900 },
            { width: 1024, height: 720 },
        ]) {
            const page = await browser.newPage({ viewport })
            await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 })
            await page.waitForSelector('button[title="AI 助手"]', { timeout: 10000 })
            await assertNoTopBarOverlap(page, `${viewport.width}px 默认状态`)
            await page.locator('button[title="工作区"]').click()
            await assertNoTopBarOverlap(page, `${viewport.width}px 工作区打开`)
            await assertWorkspacePanelUsable(page, `${viewport.width}px 工作区打开`)
            await page.locator('button[title="AI 助手"]').click()
            await page.waitForSelector('aside, [class*="border-l"]', { timeout: 5000 }).catch(() => {})
            await page.waitForTimeout(200)
            await assertNoTopBarOverlap(page, `${viewport.width}px 工作区和 AI 面板打开`)
            await assertWorkspaceBelowToolbar(page, `${viewport.width}px 工作区和 AI 面板打开`)
            fs.mkdirSync(path.join(__dirname, '..', 'screenshots'), { recursive: true })
            await page.screenshot({
                path: path.join(__dirname, '..', 'screenshots', `toolbar-overlap-${viewport.width}.png`),
                fullPage: false,
            })
            await page.close()
        }
        console.log('✅ 顶部工具栏重叠测试通过')
    } finally {
        await browser.close()
        server.close()
    }
}

run().catch((error) => {
    console.error('❌ 顶部工具栏重叠测试失败:', error.message)
    process.exit(1)
})
