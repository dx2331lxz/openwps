#!/usr/bin/env node

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')

const PORT = 5173
const BASE_URL = `http://127.0.0.1:${PORT}`
const DIST_DIR = path.join(__dirname, '..', 'dist')

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

async function run() {
    const server = await startStaticServer()
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
    let lastDialogMessage = ''

    page.on('dialog', async (dialog) => {
        lastDialogMessage = dialog.message()
        await dialog.accept()
    })

    try {
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 })
        await page.waitForSelector('.ProseMirror', { timeout: 10000 })

        const markdown = [
            '| 产品/技术 | 功能描述 |',
            '| --- | --- |',
            '| GPT | 文本生成 |',
            '',
            '表格外下一行',
        ].join('\n')

        const importInput = page.locator('input[type="file"][accept*=".md"]')
        await importInput.setInputFiles({
            name: 'table-boundary-delete.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from(markdown, 'utf8'),
        })

        await page.waitForFunction(() => {
            return Array.from(document.querySelectorAll('.ProseMirror p')).some((paragraph) => {
                return paragraph.textContent?.includes('表格外下一行')
            })
        }, { timeout: 10000 })

        assert(lastDialogMessage === 'Markdown 导入成功', `导入提示异常: ${lastDialogMessage || '未收到提示'}`)

        const targetParagraph = page.locator('.ProseMirror p', { hasText: '表格外下一行' }).first()
        const box = await targetParagraph.boundingBox()
        assert(box, '未找到表格后的目标段落位置')
        await page.mouse.click(box.x + 4, box.y + Math.min(10, box.height / 2))
        await page.keyboard.press('Home')
        await page.waitForTimeout(100)
        await page.keyboard.press('Backspace')
        await page.waitForTimeout(150)

        const result = await page.evaluate(() => {
            const paragraphs = Array.from(document.querySelectorAll('.ProseMirror p')).map((paragraph) => paragraph.textContent ?? '')
            const table = document.querySelector('.ProseMirror table')
            const nextParagraph = Array.from(document.querySelectorAll('.ProseMirror p')).find((paragraph) => {
                return paragraph.textContent?.includes('表格外下一行')
            })
            const tableRect = table?.getBoundingClientRect()
            const nextRect = nextParagraph?.getBoundingClientRect()
            return {
                paragraphs,
                tableText: table?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                tableBottom: tableRect?.bottom ?? null,
                nextParagraphTop: nextRect?.top ?? null,
            }
        })

        assert(result.paragraphs.includes('表格外下一行'), `表格后的正文段落被删除或合并: ${JSON.stringify(result.paragraphs)}`)
        assert(!result.tableText.includes('表格外下一行'), `表格后的正文被吸入表格: ${result.tableText}`)
        assert(
            typeof result.tableBottom === 'number'
                && typeof result.nextParagraphTop === 'number'
                && result.tableBottom <= result.nextParagraphTop + 0.5,
            `表格与后续正文发生视觉重叠: table.bottom=${result.tableBottom}, next.top=${result.nextParagraphTop}`,
        )

        console.log('✅ 表格边界删除保护测试通过')
    } finally {
        await browser.close()
        server.close()
    }
}

run().catch((error) => {
    console.error(`❌ 表格边界删除保护测试失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
