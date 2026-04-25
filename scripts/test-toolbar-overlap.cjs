#!/usr/bin/env node

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')

const PORT = 5177
const BASE_URL = `http://127.0.0.1:${PORT}`
const DIST_DIR = path.join(__dirname, '..', 'dist')

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function startStaticServer() {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/api/ai/settings')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ activeProviderId: 'mock', model: 'mock-model' }))
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
            await page.locator('button[title="AI 助手"]').click()
            await page.waitForSelector('aside, [class*="border-l"]', { timeout: 5000 }).catch(() => {})
            await page.waitForTimeout(200)
            await assertNoTopBarOverlap(page, `${viewport.width}px AI 面板打开`)
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
