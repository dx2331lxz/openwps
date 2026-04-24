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

        const server = http.createServer((req, res) => {
            if (req.url?.startsWith('/api/templates')) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('[]')
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