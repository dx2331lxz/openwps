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
            if (req.url?.startsWith('/api/ai/settings')) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ activeProviderId: 'mock', model: 'mock-model' }))
                return
            }

            if (req.url?.startsWith('/api/ai/chat')) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ reply: 'AI 只修改了当前文本块' }))
                return
            }

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

async function clickHandle(page, type, index = 0) {
    const handle = page.locator(`[data-openwps-block-handle="${type}"]`).nth(index)
    await handle.waitFor({ state: 'visible', timeout: 10000 })
    await handle.click()
}

async function clickMenuButton(page, title) {
    const button = page.locator(`[data-openwps-block-menu] button[title="${title}"]`).first()
    await button.waitFor({ state: 'visible', timeout: 5000 })
    await button.click()
    await page.waitForTimeout(150)
}

async function importMarkdown(page, markdown, name = 'block-controls.md') {
    await page.locator('input[type="file"][accept*=".md"]').setInputFiles({
        name,
        mimeType: 'text/markdown',
        buffer: Buffer.from(markdown, 'utf8'),
    })
    await page.waitForTimeout(400)
}

async function run() {
    const server = await startStaticServer()
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    const pngA = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
    const pngB = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAAD93J2aAAAADElEQVR42mNk+M8AAwUBAZV3A4gAAAAASUVORK5CYII=', 'base64')

    page.on('dialog', async (dialog) => {
        await dialog.accept()
    })

    try {
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 })
        await page.waitForSelector('.ProseMirror', { timeout: 10000 })
        await page.waitForFunction(() => document.querySelectorAll('[data-openwps-block-handle]').length === 0)
        await page.locator('[data-pretext-hit="text-line"]').first().click()
        await page.waitForSelector('[data-openwps-block-handle="text"]', { timeout: 10000 })
        await page.waitForFunction(() => document.querySelectorAll('[data-openwps-block-menu]').length === 0)
        await page.waitForFunction(() => document.querySelectorAll('[data-openwps-block-outline]').length === 0)
        await page.locator('[data-openwps-style-button="true"]').click()
        await page.locator('[data-openwps-style-option="heading-4"]').click()
        await page.waitForFunction(() => {
            const paragraph = document.querySelector('.ProseMirror p')
            if (!(paragraph instanceof HTMLElement)) return false
            return paragraph.getAttribute('data-heading-level') === '4' && paragraph.style.fontSize === '14pt'
        })
        await page.locator('[data-openwps-style-button="true"]').click()
        await page.locator('[data-openwps-style-option="body"]').click()
        await page.waitForFunction(() => document.querySelector('.ProseMirror p')?.getAttribute('data-heading-level') === null)

        await clickHandle(page, 'text')
        await page.waitForSelector('[data-openwps-block-outline="text"]', { timeout: 5000 })
        await clickMenuButton(page, '用 WPS AI 修改此文本块')
        await page.waitForSelector('[data-openwps-block-ai-popover="true"]', { timeout: 5000 })
        await page.locator('[data-openwps-block-ai-input="true"]').fill('只改这一段')
        await page.locator('[data-openwps-block-ai-popover="true"] button:has-text("替换块")').click()
        await page.waitForFunction(() => document.querySelector('.ProseMirror p')?.textContent?.includes('AI 只修改了当前文本块'))

        await clickHandle(page, 'text')
        await clickMenuButton(page, '标题 1')
        await page.waitForFunction(() => document.querySelector('.ProseMirror p')?.getAttribute('data-heading-level') === '1')
        await page.waitForFunction(() => {
            const paragraph = document.querySelector('.ProseMirror p')
            if (!(paragraph instanceof HTMLElement)) return false
            return paragraph.style.fontSize === '22pt' && paragraph.style.fontWeight === '700'
        })

        await clickHandle(page, 'text')
        await clickMenuButton(page, '重复块')
        await page.waitForFunction(() => document.querySelectorAll('.ProseMirror p').length >= 2)

        await clickMenuButton(page, '剪切块')
        await page.waitForFunction(() => document.querySelectorAll('.ProseMirror p').length === 1)

        await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
            name: 'source.png',
            mimeType: 'image/png',
            buffer: pngA,
        })
        await page.locator('[data-pm-image-wrapper="true"]').first().click({ force: true })
        await page.waitForSelector('[data-openwps-block-handle="image"]', { timeout: 10000 })
        await clickHandle(page, 'image')

        const chooserPromise = page.waitForEvent('filechooser')
        await clickMenuButton(page, '替换图片')
        const chooser = await chooserPromise
        await chooser.setFiles({
            name: 'replacement.png',
            mimeType: 'image/png',
            buffer: pngB,
        })
        await page.waitForFunction(() => {
            return Array.from(document.querySelectorAll('.ProseMirror img')).some((image) => image.getAttribute('alt') === 'replacement.png')
        })
        await clickHandle(page, 'image')
        await clickMenuButton(page, '删除块')
        await page.waitForFunction(() => document.querySelectorAll('.ProseMirror img').length === 0)

        await importMarkdown(page, [
            '表格前文本',
            '',
            '| 姓名 | 分数 |',
            '| --- | --- |',
            '| 张三 | 90 |',
            '| 李四 | 88 |',
            '',
            '表格后文本',
        ].join('\n'))
        await page.locator('.ProseMirror table td').first().click({ force: true })
        await page.waitForSelector('[data-openwps-block-handle="table"]', { timeout: 10000 })
        await clickHandle(page, 'table')

        const fillInput = page.locator('[data-openwps-block-menu="table"] input[type="color"]').first()
        await fillInput.evaluate((element) => {
            const input = element
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setter?.call(input, '#ffcccc')
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await page.waitForFunction(() => {
            const cell = document.querySelector('.ProseMirror td, .ProseMirror th')
            return cell instanceof HTMLElement && cell.style.backgroundColor !== ''
        })

        await clickMenuButton(page, '复制块')
        await clickMenuButton(page, '重复块')
        await page.waitForFunction(() => document.querySelectorAll('.ProseMirror table').length >= 2)
        await clickMenuButton(page, '删除块')
        await page.waitForFunction(() => document.querySelectorAll('.ProseMirror table').length === 1)

        console.log('✅ 块级操作控件测试通过')
    } finally {
        await browser.close()
        server.close()
    }
}

run().catch((error) => {
    console.error(`❌ 块级操作控件测试失败: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
})
