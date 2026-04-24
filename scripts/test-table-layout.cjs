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

async function assertTableLayout(page, label) {
    const result = await page.evaluate(() => {
        const editor = document.querySelector('.ProseMirror')
        if (!editor) return { ok: false, reason: 'missing editor' }
        const flowBlocks = Array.from(editor.children).filter((element) => (
            element instanceof HTMLElement
            && ['P', 'TABLE'].includes(element.tagName)
            && element.getBoundingClientRect().height > 0
        ))
        const failures = []
        for (let index = 0; index < flowBlocks.length; index += 1) {
            const block = flowBlocks[index]
            if (!(block instanceof HTMLElement) || block.tagName !== 'TABLE') continue
            const next = flowBlocks.slice(index + 1).find((item) => item instanceof HTMLElement && item.tagName !== 'TABLE')
            if (!(next instanceof HTMLElement)) continue
            const tableRect = block.getBoundingClientRect()
            const nextRect = next.getBoundingClientRect()
            if (tableRect.bottom > nextRect.top + 0.5) {
                failures.push({
                    tableText: block.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                    nextText: next.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                    tableBottom: tableRect.bottom,
                    nextTop: nextRect.top,
                })
            }
        }
        return { ok: failures.length === 0, failures }
    })

    assert(result.ok, `${label} 表格与后续内容重叠: ${JSON.stringify(result.failures ?? result)}`)
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

        const longChinese = '这是一段用于触发表格单元格自动换行的中文内容，包含教学评价、学习支持、个性化反馈、课堂管理和数据分析等多个主题。'
        const longEnglish = 'Artificial intelligence assisted learning analytics and formative assessment feedback should wrap inside the table cell without changing the following paragraph position.'
        const markdown = [
            '表格前置段落一',
            '表格前置段落二',
            '',
            '| 评估类型 | 传统方式 | AI 赋能方式 |',
            '| --- | --- | --- |',
            `| 作业批改助手 | ${longChinese} | ${longEnglish} |`,
            `| 学习规划顾问 | ${longEnglish} | ${longChinese} |`,
            `| 情感陪伴机器人 | ${longChinese}${longChinese} | ${longEnglish}${longEnglish} |`,
            '',
            '表格后正文不会覆盖',
            '',
            '# 表格后标题不会覆盖',
            '',
            '- 表格后列表不会覆盖',
        ].join('\n')

        const importInput = page.locator('input[type="file"][accept*=".md"]')
        await importInput.setInputFiles({
            name: 'table-layout-regression.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from(markdown, 'utf8'),
        })

        await page.waitForFunction(() => {
            return Boolean(document.querySelector('.ProseMirror table'))
                && Array.from(document.querySelectorAll('.ProseMirror p')).some((paragraph) => {
                    return paragraph.textContent?.includes('表格后正文不会覆盖')
                })
        }, { timeout: 10000 })
        assert(lastDialogMessage === 'Markdown 导入成功', `导入提示异常: ${lastDialogMessage || '未收到提示'}`)
        await page.waitForTimeout(600)
        await assertTableLayout(page, '导入后')

        const firstCellParagraph = page.locator('.ProseMirror td p').first()
        await firstCellParagraph.click()
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
        await page.keyboard.type(`${longChinese}${longEnglish}`, { delay: 0 })
        await page.waitForTimeout(700)
        await assertTableLayout(page, '编辑单元格后')

        console.log('✅ 表格 DOM 度量分页布局测试通过')
    } finally {
        await browser.close()
        server.close()
    }
}

run().catch((error) => {
    console.error(`❌ 表格 DOM 度量分页布局测试失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
