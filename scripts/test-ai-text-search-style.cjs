#!/usr/bin/env node

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')

const PORT = 5173
const BASE_URL = `http://127.0.0.1:${PORT}`
const DIST_DIR = path.join(__dirname, '..', 'dist')

function sendSse(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function startStaticServer() {
    let postedToolResults = null
    let resolvePostedToolResults = null
    const toolResultsPosted = new Promise((resolve) => {
        resolvePostedToolResults = resolve
    })

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
            if (req.url?.startsWith('/api/templates')) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('[]')
                return
            }
            if (req.method === 'GET' && (req.url === '/api/workspace' || req.url === '/api/conversations')) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('[]')
                return
            }
            if (req.url === '/api/ai/settings') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ activeProviderId: '', providers: [], ocr: {} }))
                return
            }
            if (req.method === 'GET' && req.url?.match(/^\/api\/conversations\/[^/]+\/tasks$/)) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ tasks: [] }))
                return
            }
            if (req.url?.startsWith('/api/ai/models')) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('[]')
                return
            }
            if (req.url === '/api/conversations' && req.method === 'POST') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ id: 'conv-text-style', title: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
                return
            }
            if (req.url?.startsWith('/api/conversations/') && req.method === 'POST') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('{}')
                return
            }
            if (req.url === '/api/ai/react/stream' && req.method === 'POST') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                })

                const params = {
                    color: '#FF0000',
                    range: {
                        type: 'contains_text',
                        text: 'yangmei',
                        caseSensitive: false,
                        matchMode: 'exact',
                        textOccurrence: 'all',
                    },
                }
                sendSse(res, { type: 'session_created', sessionId: 'session-text-style' })
                sendSse(res, { type: 'round_start', round: 1 })
                sendSse(res, { type: 'tool_call', id: 'tc-style', name: 'set_text_style', params })
                sendSse(res, {
                    type: 'tool_plan',
                    planId: 'plan-style',
                    round: 1,
                    executions: [{
                        executionId: 'exec-style',
                        toolName: 'set_text_style',
                        params,
                        sourceToolCallIds: ['tc-style'],
                        mergeStrategy: 'single',
                        continueOnError: true,
                        parallelGroup: null,
                    }],
                })
                sendSse(res, { type: 'awaiting_tool_results' })
                await toolResultsPosted
                sendSse(res, { type: 'content', content: '已完成。' })
                sendSse(res, { type: 'done' })
                res.end()
                return
            }
            if (req.url === '/api/ai/react/session-text-style/tool-results' && req.method === 'POST') {
                const chunks = []
                req.on('data', chunk => chunks.push(chunk))
                req.on('end', () => {
                    postedToolResults = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    resolvePostedToolResults(postedToolResults)
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end('{}')
                })
                return
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

        server.listen(PORT, '127.0.0.1', () => resolve({ server, getPostedToolResults: () => postedToolResults }))
        server.on('error', reject)
    })
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function run() {
    const { server, getPostedToolResults } = await startStaticServer()
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

        const importInput = page.locator('input[type="file"][accept*=".md"]')
        await importInput.setInputFiles({
            name: 'ai-text-style-regression.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from('Yangmei yangmei yangmeiX\n\n杨梅 杨梅汁', 'utf8'),
        })
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('yangmeiX'), { timeout: 10000 })
        await page.waitForTimeout(200)
        assert(lastDialogMessage === 'Markdown 导入成功', `导入提示异常: ${lastDialogMessage || '未收到提示'}`)

        await page.getByTitle('AI 助手').click()
        await page.waitForSelector('textarea', { timeout: 10000 })
        const textarea = page.locator('textarea').last()
        await textarea.fill('把所有 yangmei 精确匹配变红，包容大小写')
        await page.getByTitle('发送 (Enter)').click()

        await page.waitForFunction(() => {
            return Array.from(document.querySelectorAll('.ProseMirror span')).filter((span) => {
                return getComputedStyle(span).color === 'rgb(255, 0, 0)'
            }).length >= 2
        }, { timeout: 10000 })

        const result = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.ProseMirror span')).map((span) => ({
                text: span.textContent ?? '',
                color: getComputedStyle(span).color,
            }))
        })
        const redTexts = result.filter(item => item.color === 'rgb(255, 0, 0)').map(item => item.text)
        assert(redTexts.includes('Yangmei'), `未命中大小写不同的 Yangmei: ${JSON.stringify(redTexts)}`)
        assert(redTexts.includes('yangmei'), `未命中小写 yangmei: ${JSON.stringify(redTexts)}`)
        assert(!redTexts.some(text => text.includes('yangmeiX')), `exact 模式误命中了词内子串: ${JSON.stringify(redTexts)}`)

        const postedToolResults = getPostedToolResults()
        const content = postedToolResults?.results?.[0]?.content
        const payload = content ? JSON.parse(content) : null
        assert(payload?.success === true, `工具执行失败: ${content}`)
        assert(payload?.result?.data?.matchedTextCount === 2 || payload?.data?.matchedTextCount === 2, `匹配数量异常: ${content}`)

        console.log('✅ AI 精确文字匹配与样式修改回归测试通过')
        if (consoleErrors.length === 0) {
            console.log('✅ 无 Console 错误')
        } else {
            console.log('⚠️ Console 错误:')
            consoleErrors.forEach(error => console.log(`  ${error}`))
        }
    } finally {
        await browser.close()
        server.close()
    }
}

run().catch((error) => {
    console.error(`❌ AI 精确文字匹配与样式修改回归测试失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
