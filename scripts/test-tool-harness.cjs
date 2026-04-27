#!/usr/bin/env node

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')

const PORT = 5175
const BASE_URL = `http://127.0.0.1:${PORT}`
const DIST_DIR = path.join(__dirname, '..', 'dist')

function sendSse(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function readRequestJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('error', reject)
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8')
                resolve(raw ? JSON.parse(raw) : {})
            } catch (error) {
                reject(error)
            }
        })
    })
}

function createDeferred() {
    let resolve
    const promise = new Promise((nextResolve) => {
        resolve = nextResolve
    })
    return { promise, resolve }
}

function startStaticServer() {
    const roundOneToolResults = createDeferred()
    const roundTwoToolResults = createDeferred()
    const agentToolResults = createDeferred()
    const postedToolResults = []

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
            if (req.method === 'GET' && req.url === '/api/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ status: 'ok', service: 'openwps-test' }))
                return
            }
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
            if (req.method === 'GET' && req.url === '/api/ai/agents') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ agents: [] }))
                return
            }
            if (req.method === 'GET' && req.url?.match(/^\/api\/conversations\/[^/]+\/agents/)) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ runs: [] }))
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
                res.end(JSON.stringify({
                    id: 'conv-weekly-brief',
                    title: 'weekly brief',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }))
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

                const titleStyleParams = {
                    range: { type: 'paragraph', paragraphIndex: 0 },
                    headingLevel: 1,
                    align: 'center',
                    spaceAfter: 12,
                }
                const replaceRiskParams = {
                    paragraphIndex: 3,
                    text: '主要风险：验收材料尚未归档，可能影响客户周五确认；需在周三前完成补齐并同步项目经理。',
                }
                const replaceSummaryParams = {
                    paragraphIndex: 4,
                    text: '执行摘要：本周接口联调已完成，核心阻塞点转为验收材料整理和客户确认，需要按责任人推进闭环。',
                }
                const actionParams = {
                    afterParagraph: 4,
                    text: '下一步行动：周三前完成验收材料归档，周四完成内部复核，周五前提交客户确认。',
                }
                const tableParams = {
                    afterParagraph: 5,
                    headerRow: true,
                    data: [
                        ['事项', '负责人', '截止时间'],
                        ['验收材料归档', '产品/研发', '周三'],
                        ['内部复核', '测试负责人', '周四'],
                        ['客户确认', '项目经理', '周五'],
                    ],
                }
                const verificationReadParams = { fromParagraph: 0, toParagraph: 8, includeTextRuns: false }
                const forbiddenDeleteParams = { index: 0 }

                sendSse(res, { type: 'session_created', sessionId: 'session-weekly-brief' })
                sendSse(res, { type: 'round_start', round: 1 })
                sendSse(res, { type: 'thinking', content: '需要先读取文档结构，再决定标题和正文改写顺序。' })
                sendSse(res, {
                    type: 'tooling_delta',
                    loadedToolNames: [],
                    loadedDeferredToolCount: 0,
                    deferredToolCount: 3,
                })
                sendSse(res, {
                    type: 'tool_call',
                    id: 'tc-outline',
                    name: 'get_document_outline',
                    params: {},
                })
                sendSse(res, {
                    type: 'tool_call',
                    id: 'tc-title-style',
                    name: 'set_paragraph_style',
                    params: titleStyleParams,
                })
                sendSse(res, {
                    type: 'tool_plan',
                    planId: 'plan-intake-and-title',
                    round: 1,
                    executions: [
                        {
                            executionId: 'exec-outline',
                            toolName: 'get_document_outline',
                            params: {},
                            sourceToolCallIds: ['tc-outline'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: null,
                            executorLocation: 'client',
                            readOnly: true,
                            allowedForAgent: true,
                            parallelSafe: true,
                        },
                        {
                            executionId: 'exec-title-style',
                            toolName: 'set_paragraph_style',
                            params: titleStyleParams,
                            sourceToolCallIds: ['tc-title-style'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: null,
                            executorLocation: 'client',
                            readOnly: false,
                            allowedForAgent: false,
                            parallelSafe: false,
                        },
                    ],
                })
                sendSse(res, { type: 'awaiting_tool_results', round: 1, planId: 'plan-intake-and-title', count: 2 })
                await roundOneToolResults.promise

                sendSse(res, { type: 'round_start', round: 2 })
                sendSse(res, { type: 'thinking', content: '已拿到初始结构，先生成管理层简报正文，再追加责任表。' })
                sendSse(res, { type: 'content', content: '已读取原始周报结构，下面整理为管理层简报。' })
                sendSse(res, {
                    type: 'tooling_delta',
                    loadedToolNames: ['insert_table'],
                    loadedDeferredToolCount: 1,
                    deferredToolCount: 2,
                })
                sendSse(res, {
                    type: 'tool_call',
                    id: 'tc-toolsearch-table',
                    name: 'ToolSearch',
                    params: { query: 'select:insert_table' },
                })
                sendSse(res, {
                    type: 'tool_result',
                    id: 'tc-toolsearch-table',
                    name: 'ToolSearch',
                    executionId: 'exec-toolsearch-table',
                    params: { query: 'select:insert_table' },
                    originalParams: { query: 'select:insert_table' },
                    sourceToolCallIds: ['tc-toolsearch-table'],
                    mergeStrategy: 'single',
                    result: {
                        success: true,
                        message: '已加载 1 个延迟工具：insert_table',
                        data: { loadedToolNames: ['insert_table'] },
                    },
                })
                sendSse(res, { type: 'tool_call', id: 'tc-risk', name: 'replace_paragraph_text', params: replaceRiskParams })
                sendSse(res, { type: 'tool_call', id: 'tc-summary', name: 'replace_paragraph_text', params: replaceSummaryParams })
                sendSse(res, { type: 'tool_call', id: 'tc-action', name: 'insert_paragraph_after', params: actionParams })
                sendSse(res, { type: 'tool_call', id: 'tc-table', name: 'insert_table', params: tableParams })
                sendSse(res, {
                    type: 'tool_plan',
                    planId: 'plan-brief-body',
                    round: 2,
                    executions: [
                        {
                            executionId: 'exec-risk',
                            toolName: 'replace_paragraph_text',
                            params: replaceRiskParams,
                            sourceToolCallIds: ['tc-risk'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: null,
                            executorLocation: 'client',
                            readOnly: false,
                            allowedForAgent: false,
                            parallelSafe: false,
                        },
                        {
                            executionId: 'exec-summary',
                            toolName: 'replace_paragraph_text',
                            params: replaceSummaryParams,
                            sourceToolCallIds: ['tc-summary'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: null,
                            executorLocation: 'client',
                            readOnly: false,
                            allowedForAgent: false,
                            parallelSafe: false,
                        },
                        {
                            executionId: 'exec-action',
                            toolName: 'insert_paragraph_after',
                            params: actionParams,
                            sourceToolCallIds: ['tc-action'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: null,
                            executorLocation: 'client',
                            readOnly: false,
                            allowedForAgent: false,
                            parallelSafe: false,
                        },
                        {
                            executionId: 'exec-table',
                            toolName: 'insert_table',
                            params: tableParams,
                            sourceToolCallIds: ['tc-table'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: null,
                            executorLocation: 'client',
                            readOnly: false,
                            allowedForAgent: false,
                            parallelSafe: false,
                        },
                    ],
                })
                sendSse(res, { type: 'awaiting_tool_results', round: 2, planId: 'plan-brief-body', count: 4 })
                await roundTwoToolResults.promise

                sendSse(res, {
                    type: 'agent_start',
                    agentId: 'agent-brief-verification',
                    agentType: 'verification',
                    description: '验收管理层周报简报',
                    runMode: 'sync',
                    tools: ['get_document_content', 'get_document_outline'],
                    maxTurns: 2,
                })
                sendSse(res, {
                    type: 'agent_progress',
                    agentId: 'agent-brief-verification',
                    agentType: 'verification',
                    phase: 'thinking',
                    content: '检查正文是否包含执行摘要、风险、行动项和责任人表格。',
                })
                sendSse(res, {
                    type: 'agent_tool_call',
                    agentId: 'agent-brief-verification',
                    agentType: 'verification',
                    id: 'tc-agent-content',
                    name: 'get_document_content',
                    params: verificationReadParams,
                })
                sendSse(res, {
                    type: 'agent_tool_call',
                    agentId: 'agent-brief-verification',
                    agentType: 'verification',
                    id: 'tc-agent-outline',
                    name: 'get_document_outline',
                    params: {},
                })
                sendSse(res, {
                    type: 'agent_tool_call',
                    agentId: 'agent-brief-verification',
                    agentType: 'verification',
                    id: 'tc-agent-forbidden-delete',
                    name: 'delete_paragraph',
                    params: forbiddenDeleteParams,
                })
                sendSse(res, {
                    type: 'agent_tool_plan',
                    agentId: 'agent-brief-verification',
                    agentType: 'verification',
                    planId: 'plan-agent-verify-brief',
                    round: 1,
                    executions: [
                        {
                            executionId: 'exec-agent-content',
                            toolName: 'get_document_content',
                            params: verificationReadParams,
                            sourceToolCallIds: ['tc-agent-content'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: 'parallel_verify_reads',
                            executorLocation: 'client',
                            readOnly: true,
                            allowedForAgent: true,
                            parallelSafe: true,
                        },
                        {
                            executionId: 'exec-agent-outline',
                            toolName: 'get_document_outline',
                            params: {},
                            sourceToolCallIds: ['tc-agent-outline'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: 'parallel_verify_reads',
                            executorLocation: 'client',
                            readOnly: true,
                            allowedForAgent: true,
                            parallelSafe: true,
                        },
                        {
                            executionId: 'exec-agent-forbidden-delete',
                            toolName: 'delete_paragraph',
                            params: forbiddenDeleteParams,
                            sourceToolCallIds: ['tc-agent-forbidden-delete'],
                            mergeStrategy: 'single',
                            continueOnError: true,
                            parallelGroup: null,
                            executorLocation: 'client',
                            readOnly: false,
                            allowedForAgent: false,
                            parallelSafe: false,
                        },
                    ],
                })
                sendSse(res, {
                    type: 'agent_progress',
                    agentId: 'agent-brief-verification',
                    agentType: 'verification',
                    phase: 'awaiting_tool_results',
                    round: 1,
                    planId: 'plan-agent-verify-brief',
                    count: 3,
                })
                await agentToolResults.promise
                sendSse(res, {
                    type: 'agent_done',
                    agentId: 'agent-brief-verification',
                    agentType: 'verification',
                    description: '验收管理层周报简报',
                    result: 'PASS：简报已包含执行摘要、主要风险、下一步行动和责任表；子代理只读验收完成，写入工具已被拒绝。',
                })
                sendSse(res, { type: 'content', content: '已整理为管理层简报，并完成 verification 验收。' })
                sendSse(res, { type: 'done', reason: 'complete' })
                res.end()
                return
            }
            if (req.url === '/api/ai/react/session-weekly-brief/tool-results' && req.method === 'POST') {
                const payload = await readRequestJson(req)
                postedToolResults.push(payload)
                if (payload.agent_id) {
                    agentToolResults.resolve(payload)
                } else if (payload.plan_id === 'plan-intake-and-title') {
                    roundOneToolResults.resolve(payload)
                } else if (payload.plan_id === 'plan-brief-body') {
                    roundTwoToolResults.resolve(payload)
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('{}')
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

        server.listen(PORT, '127.0.0.1', () => resolve({
            server,
            getPostedToolResults: () => postedToolResults,
        }))
        server.on('error', reject)
    })
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function parseResultContent(post, executionId) {
    const result = post?.results?.find(item => item.execution_id === executionId)
    return result?.content ? JSON.parse(result.content) : null
}

async function importMarkdown(page, markdown) {
    const importInput = page.locator('input[type="file"][accept*=".md"]')
    await importInput.setInputFiles({
        name: 'weekly-brief-source.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(markdown, 'utf8'),
    })
    await page.waitForFunction(() => {
        return document.querySelector('.ProseMirror')?.textContent?.includes('结论待补充')
    }, { timeout: 10000 })
    await page.waitForTimeout(200)
}

async function readDocumentState(page) {
    return page.evaluate(() => {
        const paragraphs = Array.from(document.querySelectorAll('.ProseMirror p')).map((paragraph) => ({
            text: paragraph.textContent ?? '',
            headingLevel: paragraph.getAttribute('data-heading-level'),
            align: paragraph.getAttribute('data-align'),
        }))
        const tableTexts = Array.from(document.querySelectorAll('.ProseMirror table')).map(table => table.textContent ?? '')
        return {
            text: document.querySelector('.ProseMirror')?.textContent ?? '',
            paragraphs,
            tableTexts,
        }
    })
}

async function run() {
    if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        throw new Error('缺少 dist/index.html，请先运行 npm run build')
    }

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

        await importMarkdown(page, [
            '# 项目周报',
            '',
            '一、背景',
            '',
            '本周完成接口联调，但验收材料还没有整理。',
            '',
            '风险：交付延期',
            '',
            '结论待补充',
        ].join('\n'))
        assert(lastDialogMessage === 'Markdown 导入成功', `导入提示异常: ${lastDialogMessage || '未收到提示'}`)

        await page.getByTitle('AI 助手').click()
        await page.waitForSelector('textarea', { timeout: 10000 })
        const textarea = page.locator('textarea').last()
        await textarea.fill('把这份项目周报整理成给管理层看的简报：标题正式化，补齐执行摘要、风险和下一步行动，最后自查是否满足要求。')
        await page.getByTitle('发送 (Enter)').click()

        await page.waitForFunction(() => {
            const text = document.querySelector('.ProseMirror')?.textContent ?? ''
            return text.includes('执行摘要：本周接口联调已完成')
                && text.includes('下一步行动：周三前完成验收材料归档')
                && text.includes('验收材料归档')
        }, { timeout: 12000 })

        await page.waitForFunction(() => {
            return document.body.textContent?.includes('PASS：简报已包含执行摘要')
                && document.body.textContent?.includes('已整理为管理层简报')
        }, { timeout: 12000 })
        await page.waitForFunction(() => {
            const text = document.body.textContent ?? ''
            return text.includes('思考过程')
                && text.includes('需要先读取文档结构')
                && text.includes('子代理 verification 思考过程')
        }, { timeout: 12000 })

        const documentState = await readDocumentState(page)
        assert(documentState.paragraphs[0]?.text === '项目周报', `标题段落异常: ${JSON.stringify(documentState.paragraphs[0])}`)
        assert(documentState.paragraphs[0]?.headingLevel === '1', `标题未设置为一级标题: ${JSON.stringify(documentState.paragraphs[0])}`)
        assert(documentState.text.includes('主要风险：验收材料尚未归档'), `风险段未被改写: ${documentState.text}`)
        assert(documentState.text.includes('执行摘要：本周接口联调已完成'), `执行摘要未补齐: ${documentState.text}`)
        assert(documentState.text.includes('下一步行动：周三前完成验收材料归档'), `行动项未插入: ${documentState.text}`)
        assert(documentState.tableTexts.some(text => text.includes('客户确认') && text.includes('项目经理')), `责任表未插入: ${JSON.stringify(documentState.tableTexts)}`)
        assert(documentState.paragraphs.some(item => item.text.includes('结论待补充')) === false, `旧占位结论未替换: ${JSON.stringify(documentState.paragraphs)}`)

        const postedToolResults = getPostedToolResults()
        assert(postedToolResults.length === 3, `tool-results POST 次数异常: ${postedToolResults.length}`)

        const roundOnePost = postedToolResults.find(item => item.plan_id === 'plan-intake-and-title')
        const roundTwoPost = postedToolResults.find(item => item.plan_id === 'plan-brief-body')
        const agentPost = postedToolResults.find(item => item.agent_id === 'agent-brief-verification')
        assert(roundOnePost, `缺少第一轮工具结果: ${JSON.stringify(postedToolResults)}`)
        assert(roundTwoPost, `缺少第二轮工具结果: ${JSON.stringify(postedToolResults)}`)
        assert(agentPost, `缺少子代理工具结果: ${JSON.stringify(postedToolResults)}`)

        const outlinePayload = parseResultContent(roundOnePost, 'exec-outline')
        const titlePayload = parseResultContent(roundOnePost, 'exec-title-style')
        const tablePayload = parseResultContent(roundTwoPost, 'exec-table')
        assert(outlinePayload?.success === true, `读取结构失败: ${JSON.stringify(outlinePayload)}`)
        assert(titlePayload?.success === true, `标题排版失败: ${JSON.stringify(titlePayload)}`)
        assert(tablePayload?.success === true, `插入责任表失败: ${JSON.stringify(tablePayload)}`)
        assert(outlinePayload?.executionId === 'exec-outline', `读取结果缺少 executionId: ${JSON.stringify(outlinePayload)}`)
        assert(Array.isArray(tablePayload?.sourceToolCallIds) && tablePayload.sourceToolCallIds.includes('tc-table'), `插表结果缺少 sourceToolCallIds: ${JSON.stringify(tablePayload)}`)

        assert(agentPost.plan_id === 'plan-agent-verify-brief', `子代理计划 ID 异常: ${JSON.stringify(agentPost)}`)
        assert(agentPost.results?.length === 3, `子代理结果数量异常: ${JSON.stringify(agentPost)}`)
        const agentContentPayload = parseResultContent(agentPost, 'exec-agent-content')
        const agentOutlinePayload = parseResultContent(agentPost, 'exec-agent-outline')
        const rejectedPayload = parseResultContent(agentPost, 'exec-agent-forbidden-delete')
        assert(agentContentPayload?.success === true, `子代理正文读取失败: ${JSON.stringify(agentContentPayload)}`)
        assert(agentOutlinePayload?.success === true, `子代理结构读取失败: ${JSON.stringify(agentOutlinePayload)}`)
        assert(rejectedPayload?.success === false, `子代理删除工具未被拒绝: ${JSON.stringify(rejectedPayload)}`)
        assert(String(rejectedPayload?.message || '').includes('子代理只允许执行只读工具'), `拒绝原因异常: ${JSON.stringify(rejectedPayload)}`)
        assert(documentState.text.includes('项目周报'), '子代理删除工具不应删除标题')

        const unexpectedConsoleErrors = consoleErrors.filter(error => {
            return !error.includes('子代理只允许执行只读工具，已拒绝：delete_paragraph')
        })
        assert(unexpectedConsoleErrors.length === 0, `存在未预期 Console 错误: ${unexpectedConsoleErrors.join('\n')}`)

        console.log('✅ 复杂周报改写端到端测试通过')
        console.log('✅ 覆盖多轮读取/写入/deferred ToolSearch/插表/verification 子代理/子代理写入拒绝')
    } finally {
        await browser.close()
        server.close()
    }
}

run().catch((error) => {
    console.error(`❌ 复杂周报改写端到端测试失败: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
})
