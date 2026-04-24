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

async function importMarkdown(page, markdown, name = 'task-list-regression.md', minParagraphCount = 3) {
    const importInput = page.locator('input[type="file"][accept*=".md"]')
    await importInput.setInputFiles({
        name,
        mimeType: 'text/markdown',
        buffer: Buffer.from(markdown, 'utf8'),
    })

    await page.waitForFunction((count) => {
        return document.querySelectorAll('.ProseMirror p').length >= count
    }, minParagraphCount, { timeout: 10000 })
    await page.waitForTimeout(200)
}

async function readParagraphs(page) {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('.ProseMirror p')).map((paragraph) => ({
            text: paragraph.textContent ?? '',
            listType: paragraph.getAttribute('data-list-type'),
            listChecked: paragraph.getAttribute('data-list-checked'),
            className: paragraph.className,
        }))
    })
}

async function clickTaskCheckbox(page, lineIndex) {
    const hitLine = page.locator('[data-pretext-hit="text-line"]').nth(lineIndex)
    const box = await hitLine.boundingBox()
    assert(box, `未找到第 ${lineIndex + 1} 行任务列表命中区域`)
    await page.mouse.click(box.x + 22, box.y + box.height / 2)
    await page.waitForTimeout(120)
}

async function clickTaskText(page, lineIndex) {
    const hitLine = page.locator('[data-pretext-hit="text-line"]').nth(lineIndex)
    const box = await hitLine.boundingBox()
    assert(box, `未找到第 ${lineIndex + 1} 行任务列表命中区域`)
    await page.mouse.click(box.x + 60, box.y + box.height / 2)
    await page.waitForTimeout(120)
}

async function placeCaretAtParagraphEnd(page, paragraphIndex) {
    await page.evaluate((index) => {
        const editor = document.querySelector('.ProseMirror')
        const paragraph = document.querySelectorAll('.ProseMirror p').item(index)
        if (!(editor instanceof HTMLElement) || !(paragraph instanceof HTMLElement)) {
            throw new Error(`未找到第 ${index + 1} 个段落`)
        }

        editor.focus()
        const selection = window.getSelection()
        const range = document.createRange()

        if (paragraph.lastChild) {
            const lastChild = paragraph.lastChild
            const offset = lastChild.textContent?.length ?? 0
            range.setStart(lastChild, offset)
        } else {
            range.setStart(paragraph, 0)
        }
        range.collapse(true)
        selection?.removeAllRanges()
        selection?.addRange(range)
    }, paragraphIndex)
    await page.waitForTimeout(120)
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
            '- [ ] 第一项',
            '- [ ]',
            '- [x] 第三项',
        ].join('\n')

        await importMarkdown(page, markdown)
        assert(lastDialogMessage === 'Markdown 导入成功', `导入提示异常: ${lastDialogMessage || '未收到提示'}`)

        const initial = await readParagraphs(page)
        assert(initial.length >= 3, `导入后段落数量异常: ${JSON.stringify(initial)}`)
        assert(initial[0]?.listType === 'task' && initial[0]?.listChecked === 'false', `第一项初始状态异常: ${JSON.stringify(initial[0])}`)
        assert(initial[1]?.listType === 'task' && initial[1]?.listChecked === 'false' && initial[1]?.text === '', `空任务项初始状态异常: ${JSON.stringify(initial[1])}`)
        assert(initial[2]?.listType === 'task' && initial[2]?.listChecked === 'true', `第三项初始状态异常: ${JSON.stringify(initial[2])}`)

        await clickTaskCheckbox(page, 0)
        const afterToggle = await readParagraphs(page)
        assert(afterToggle[0]?.listChecked === 'true', `点击任务框后未切换为已完成: ${JSON.stringify(afterToggle[0])}`)
        assert(afterToggle[0]?.className.includes('list-task-checked'), `点击任务框后样式未更新: ${JSON.stringify(afterToggle[0])}`)

        await clickTaskText(page, 1)
        await page.keyboard.press('Home')
        await page.keyboard.press('Delete')
        await page.waitForTimeout(120)
        const afterDeleteMarker = await readParagraphs(page)
        assert(afterDeleteMarker[1]?.listType == null, `段首 Delete 后未删除任务列表标记: ${JSON.stringify(afterDeleteMarker[1])}`)
        assert(afterDeleteMarker[1]?.listChecked == null, `段首 Delete 后仍保留任务勾选属性: ${JSON.stringify(afterDeleteMarker[1])}`)
        assert(afterDeleteMarker[1]?.className === '', `段首 Delete 后仍保留任务列表样式: ${JSON.stringify(afterDeleteMarker[1])}`)
        assert(afterDeleteMarker[1]?.text === '', `段首 Delete 不应删除正文内容: ${JSON.stringify(afterDeleteMarker[1])}`)

        await importMarkdown(page, '- [ ] 第一项', 'task-list-regression-enter.md', 1)
        await placeCaretAtParagraphEnd(page, 0)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(120)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(120)
        const afterRepeatEnter = await readParagraphs(page)
        assert(afterRepeatEnter.length >= 3, `连续回车后未新增足够的任务项: ${JSON.stringify(afterRepeatEnter)}`)
        assert(afterRepeatEnter[0]?.text === '第一项' && afterRepeatEnter[0]?.listType === 'task', `原始任务项在连续回车后异常: ${JSON.stringify(afterRepeatEnter[0])}`)
        assert(afterRepeatEnter[1]?.listType === 'task', `第一次回车后新增行不是任务列表: ${JSON.stringify(afterRepeatEnter[1])}`)
        assert(afterRepeatEnter[2]?.listType === 'task', `第二次回车后当前空行不是任务列表: ${JSON.stringify(afterRepeatEnter[2])}`)
        assert(afterRepeatEnter[1]?.text === '', `第一次回车后新增任务行应为空: ${JSON.stringify(afterRepeatEnter[1])}`)
        assert(afterRepeatEnter[2]?.text === '', `第二次回车后新增任务行应为空: ${JSON.stringify(afterRepeatEnter[2])}`)

        console.log('✅ 任务列表交互测试通过')
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
    console.error(`❌ 任务列表交互测试失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})