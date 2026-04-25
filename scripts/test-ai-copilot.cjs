#!/usr/bin/env node

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')

const PORT = 5176
const BASE_URL = `http://127.0.0.1:${PORT}`
const DIST_DIR = path.join(__dirname, '..', 'dist')

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function startStaticServer() {
    let completeCallCount = 0
    let abortedCompleteCount = 0
    const completeRequests = []

    const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/api/ai/settings')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ activeProviderId: 'mock', model: 'mock-model' }))
            return
        }

        if (req.url?.startsWith('/api/ai/complete')) {
            let rawBody = ''
            req.on('data', chunk => { rawBody += chunk })
            req.on('end', () => {
                completeCallCount += 1
                const body = JSON.parse(rawBody || '{}')
                completeRequests.push(body)
                const prefixText = body.prefixText || ''
                const contextText = `${prefixText}\n${body.paragraphText || ''}`
                const markers = [
                    ['多候选测试', 'multi'],
                    ['空结果测试', 'empty'],
                    ['刷新测试', 'refresh'],
                    ['取消测试', 'cancel'],
                    ['继续测试', 'continue'],
                    ['伴写测试', 'first'],
                ]
                const markerSource = markers.some(([text]) => prefixText.includes(text)) ? prefixText : contextText
                const latest = markers
                    .map(([text, type]) => ({ type, index: markerSource.lastIndexOf(text) }))
                    .filter(item => item.index >= 0)
                    .sort((a, b) => b.index - a.index)[0]?.type || 'first'
                let completion = '，并在写作时保持语气连贯。'
                let completions = null
                let delayMs = 0

                if (latest === 'multi') {
                    completions = ['，第一条候选。', '，第二条候选。', '，第三条候选。'].slice(0, Math.max(1, Math.min(Number(body.candidateCount || 1), 3)))
                    completion = completions[0]
                } else if (latest === 'empty') {
                    completion = ''
                    completions = []
                } else if (latest === 'refresh') {
                    completion = '，刷新后仍然显示。'
                    delayMs = 700
                } else if (latest === 'cancel') {
                    completion = '，形成更完整的表达。'
                } else if (latest === 'continue') {
                    completion = '，同时补充关键背景。'
                }

                let finished = false
                res.on('close', () => {
                    if (!finished) abortedCompleteCount += 1
                })
                setTimeout(() => {
                    if (res.destroyed) return
                    finished = true
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({
                        completion,
                        completions: completions ?? (completion ? [completion] : []),
                        model: 'mock-model',
                    }))
                }, delayMs)
            })
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
        server.listen(PORT, '127.0.0.1', () => resolve({
            server,
            getStats: () => ({ completeCallCount, abortedCompleteCount, completeRequests }),
        }))
        server.on('error', reject)
    })
}

function waitUntil(predicate, message, timeout = 5000) {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) {
                resolve()
                return
            }
            if (Date.now() - startedAt > timeout) {
                reject(new Error(message))
                return
            }
            setTimeout(tick, 50)
        }
        tick()
    })
}

async function focusFirstLine(page) {
    await page.locator('[data-pretext-hit="text-line"]').first().click()
    await page.keyboard.press('End')
}

async function waitForGhost(page, expectedText) {
    await page.waitForFunction((text) => {
        return Array.from(document.querySelectorAll('[data-openwps-ai-ghost="true"]')).some((node) =>
            (node.textContent || '').includes(text)
        )
    }, expectedText, { timeout: 5000 })
}

async function run() {
    const { server, getStats } = await startStaticServer()
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })

    page.on('dialog', async (dialog) => {
        await dialog.accept()
    })

    try {
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 })
        await page.waitForSelector('.ProseMirror', { timeout: 10000 })
        await page.waitForSelector('[data-pretext-hit="text-line"]', { timeout: 10000 })

        await page.locator('button[title="开启 AI 伴写"]').click()
        await focusFirstLine(page)
        await page.keyboard.type('伴写测试')
        await waitForGhost(page, '并在写作时保持语气连贯')
        assert(getStats().completeRequests.at(-1)?.activity === 'standard', '默认活跃程度应为 standard')
        assert(getStats().completeRequests.at(-1)?.candidateCount === 1, '默认候选数量应为 1')

        await page.keyboard.press('Tab')
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('并在写作时保持语气连贯'))
        assert(await page.locator('[data-openwps-ai-ghost="true"]').count() === 0, 'Tab 接受后 ghost text 未清除')

        await focusFirstLine(page)
        await page.keyboard.type('继续测试')
        await waitForGhost(page, '同时补充关键背景')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
        const textAfterEscape = await page.locator('.ProseMirror').textContent()
        assert(!(textAfterEscape || '').includes('同时补充关键背景'), 'Esc 后候选文本被写入文档')
        assert(await page.locator('[data-openwps-ai-ghost="true"]').count() === 0, 'Esc 后 ghost text 未清除')

        await focusFirstLine(page)
        await page.keyboard.type('取消测试')
        await waitForGhost(page, '形成更完整的表达')
        await page.keyboard.type('X')
        await page.waitForTimeout(200)
        const textAfterTyping = await page.locator('.ProseMirror').textContent()
        assert(!(textAfterTyping || '').includes('形成更完整的表达'), '继续输入后候选文本被写入文档')
        assert(await page.locator('[data-openwps-ai-ghost="true"]').count() === 0, '继续输入后 ghost text 未清除')

        await focusFirstLine(page)
        const beforeRefreshCount = getStats().completeCallCount
        await page.keyboard.type('刷新测试')
        await waitUntil(() => getStats().completeCallCount > beforeRefreshCount, '刷新测试未触发 AI 伴写接口')
        const abortedBeforeSelectionRefresh = getStats().abortedCompleteCount
        await page.keyboard.press('End')
        await page.waitForTimeout(250)
        assert(
            getStats().abortedCompleteCount === abortedBeforeSelectionRefresh,
            '同位置 selection 刷新不应中断在途 AI 伴写请求'
        )
        const callsBeforeCursorClick = getStats().completeCallCount
        await page.locator('[data-pretext-hit="text-line"]').first().click()
        await page.waitForTimeout(1000)
        assert(
            getStats().completeCallCount === callsBeforeCursorClick,
            '仅点击光标不应触发新的 AI 伴写请求'
        )

        await focusFirstLine(page)
        const beforeEmptyCount = getStats().completeCallCount
        await page.keyboard.type('空结果测试')
        await waitUntil(() => getStats().completeCallCount > beforeEmptyCount, '空结果测试未触发 AI 伴写接口')
        await page.waitForTimeout(250)
        const textAfterEmpty = await page.locator('.ProseMirror').textContent()
        assert(!(textAfterEmpty || '').includes('空结果测试，'), '空补全不应写入任何候选文本')
        assert(await page.locator('[data-openwps-ai-ghost="true"]').count() === 0, '空补全不应显示 ghost text')

        await page.locator('[data-openwps-ai-copilot-settings="true"]').click()
        await page.locator('[data-openwps-ai-activity="active"]').click()
        await page.locator('[data-openwps-ai-candidate-count="3"]').click()
        await focusFirstLine(page)
        const beforeMultiCount = getStats().completeCallCount
        await page.keyboard.type('多候选测试')
        await waitUntil(() => getStats().completeCallCount > beforeMultiCount, '多候选测试未触发 AI 伴写接口')
        await waitForGhost(page, '第一条候选')
        const multiRequest = getStats().completeRequests.at(-1)
        assert(multiRequest?.activity === 'active', '设置后请求 payload 应包含 active 活跃程度')
        assert(multiRequest?.candidateCount === 3, '设置后请求 payload 应包含 candidateCount=3')
        const candidatesPanelText = await page.locator('[data-openwps-ai-candidates="true"]').innerText()
        assert(candidatesPanelText.includes('第一条候选'), '多候选列表应显示第 1 条候选')
        assert(candidatesPanelText.includes('第二条候选'), '多候选列表应显示第 2 条候选')
        assert(candidatesPanelText.includes('第三条候选'), '多候选列表应显示第 3 条候选')
        await page.locator('[data-openwps-ai-candidate-item="2"]').click()
        await waitForGhost(page, '第二条候选')
        await page.locator('[data-openwps-ai-candidate-accept="3"]').click()
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('第三条候选'))
        const textAfterMultiAccept = await page.locator('.ProseMirror').textContent()
        assert(!(textAfterMultiAccept || '').includes('第一条候选'), '点击第 3 条接受后不应写入第 1 条候选')
        assert(!(textAfterMultiAccept || '').includes('第二条候选'), '点击第 3 条接受后不应写入第 2 条候选')
        assert(await page.locator('[data-openwps-ai-ghost="true"]').count() === 0, '多候选接受后 ghost text 未清除')

        await focusFirstLine(page)
        const beforeMultiTabCount = getStats().completeCallCount
        await page.keyboard.type('多候选测试')
        await waitUntil(() => getStats().completeCallCount > beforeMultiTabCount, '多候选 Tab 测试未触发 AI 伴写接口')
        await waitForGhost(page, '第一条候选')
        await page.locator('[data-openwps-ai-candidate-item="2"]').click()
        await waitForGhost(page, '第二条候选')
        await page.keyboard.press('Tab')
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('第二条候选'))

        await focusFirstLine(page)
        const beforeMultiEscCount = getStats().completeCallCount
        await page.keyboard.type('多候选测试')
        await waitUntil(() => getStats().completeCallCount > beforeMultiEscCount, '多候选 Esc 测试未触发 AI 伴写接口')
        await waitForGhost(page, '第一条候选')
        const textBeforeMultiEscape = await page.locator('.ProseMirror').textContent()
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
        const textAfterMultiEscape = await page.locator('.ProseMirror').textContent()
        assert(await page.locator('[data-openwps-ai-candidates="true"]').count() === 0, 'Esc 后多候选列表未关闭')
        assert(textAfterMultiEscape === textBeforeMultiEscape, 'Esc 后不应写入候选文本')
        assert(getStats().completeCallCount >= 8, '未按预期调用 AI 伴写接口')

        console.log('✅ AI 伴写自动补全测试通过')
    } catch (error) {
        console.error('AI copilot test stats:', JSON.stringify(getStats(), null, 2))
        throw error
    } finally {
        await browser.close()
        server.close()
    }
}

run().catch((error) => {
    console.error(`❌ AI 伴写自动补全测试失败: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
})
