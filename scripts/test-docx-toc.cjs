#!/usr/bin/env node

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')
const JSZip = require('jszip')
const {
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    TableOfContents,
    TextRun,
} = require('docx')

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

async function createTocDocxBuffer() {
    const doc = new Document({
        sections: [{
            children: [
                new TableOfContents('目录', {
                    headingStyleRange: '1-3',
                    hyperlink: true,
                }),
                new Paragraph({
                    text: '第一章 引言',
                    heading: HeadingLevel.HEADING_1,
                }),
                new Paragraph({
                    children: [new TextRun('这里是引言正文。')],
                }),
                new Paragraph({
                    text: '1.1 研究背景',
                    heading: HeadingLevel.HEADING_2,
                }),
                new Paragraph({
                    children: [new TextRun('这里是研究背景正文。')],
                }),
            ],
        }],
    })
    return Packer.toBuffer(doc)
}

async function readDocumentXml(buffer) {
    const zip = await JSZip.loadAsync(buffer)
    return zip.file('word/document.xml')?.async('string')
}

function assertToolingSchema() {
    const frontendTools = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'tools.ts'), 'utf8')
    const backendTools = fs.readFileSync(path.join(__dirname, '..', 'server', 'app', 'tooling.py'), 'utf8')
    const prompts = fs.readFileSync(path.join(__dirname, '..', 'server', 'app', 'prompts_modular.py'), 'utf8')

    for (const [name, source] of [
        ['前端工具定义', frontendTools],
        ['后端工具定义', backendTools],
        ['系统提示词', prompts],
    ]) {
        assert(source.includes('insert_table_of_contents'), `${name} 缺少 insert_table_of_contents`)
    }
    assert(frontendTools.includes('headingLevel'), '前端工具定义缺少 headingLevel')
    assert(backendTools.includes('headingLevel'), '后端工具定义缺少 headingLevel')
    assert(prompts.includes('不要用普通正文、点线和手写页码模拟目录'), '系统提示词缺少禁止文字目录的约束')
}

async function run() {
    assertToolingSchema()

    const server = await startStaticServer()
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1200 },
        acceptDownloads: true,
    })
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
        const inputBuffer = await createTocDocxBuffer()
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 })
        await page.waitForSelector('.ProseMirror', { timeout: 10000 })

        const importInput = page.locator('input[type="file"][accept*=".docx"]')
        await importInput.setInputFiles({
            name: 'toc-regression.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            buffer: inputBuffer,
        })

        await page.waitForFunction(() => {
            return Boolean(document.querySelector('.ProseMirror [data-table-of-contents]'))
                && Boolean(Array.from(document.querySelectorAll('[data-pretext-toc-entry]')).find((entry) => {
                    return entry.textContent?.includes('第一章 引言')
                }))
                && Array.from(document.querySelectorAll('.ProseMirror p')).some((paragraph) => {
                    return paragraph.getAttribute('data-heading-level') === '1'
                        && paragraph.textContent?.includes('第一章 引言')
                })
        }, { timeout: 10000 })
        assert(lastDialogMessage === 'DOCX 导入成功', `导入提示异常: ${lastDialogMessage || '未收到提示'}`)

        const imported = await page.evaluate(() => {
            const toc = document.querySelector('.ProseMirror [data-table-of-contents]')
            const paragraphs = Array.from(document.querySelectorAll('.ProseMirror p')).map((paragraph) => ({
                text: paragraph.textContent ?? '',
                headingLevel: paragraph.getAttribute('data-heading-level'),
            }))
            const visibleTocEntries = Array.from(document.querySelectorAll('[data-pretext-toc-entry]')).map((entry) => ({
                text: entry.textContent ?? '',
                level: entry.getAttribute('data-pretext-toc-level'),
                page: entry.getAttribute('data-pretext-toc-page'),
            }))
            return {
                hasTocNode: Boolean(toc),
                tocText: toc?.textContent ?? '',
                headings: paragraphs.filter((paragraph) => paragraph.headingLevel),
                visibleTocEntries,
                fakeTocParagraphs: paragraphs.filter((paragraph) => /\\.{5,}\\d+$/.test(paragraph.text)),
            }
        })

        assert(imported.hasTocNode, '导入后未形成 table_of_contents 节点')
        assert(imported.visibleTocEntries.some((item) => item.level === '1' && item.text.includes('第一章 引言') && item.page), `可见目录未生成一级标题条目: ${JSON.stringify(imported.visibleTocEntries)}`)
        assert(imported.visibleTocEntries.some((item) => item.level === '2' && item.text.includes('1.1 研究背景') && item.page), `可见目录未生成二级标题条目: ${JSON.stringify(imported.visibleTocEntries)}`)
        assert(imported.headings.some((item) => item.headingLevel === '1' && item.text.includes('第一章 引言')), `一级标题未保留: ${JSON.stringify(imported.headings)}`)
        assert(imported.headings.some((item) => item.headingLevel === '2' && item.text.includes('1.1 研究背景')), `二级标题未保留: ${JSON.stringify(imported.headings)}`)
        assert(imported.fakeTocParagraphs.length === 0, `导入后仍存在文字目录段落: ${JSON.stringify(imported.fakeTocParagraphs)}`)

        const exportedBytes = await page.evaluate(async () => {
            if (!window.__OPENWPS_TEST_EXPORT_DOCX__) {
                throw new Error('缺少本地测试导出钩子')
            }
            const blob = await window.__OPENWPS_TEST_EXPORT_DOCX__()
            return Array.from(new Uint8Array(await blob.arrayBuffer()))
        })

        const exportedXml = await readDocumentXml(Buffer.from(exportedBytes))
        assert(exportedXml, '导出的 DOCX 缺少 word/document.xml')
        const hasTocField = /<w:instrText[^>]*>[^<]*TOC[^<]*<\/w:instrText>/.test(exportedXml)
            && exportedXml.includes('\\h')
            && /\\o (?:&quot;|")1-3(?:&quot;|")/.test(exportedXml)
        assert(hasTocField, '导出的 DOCX 未包含真实 TOC 字段')
        assert(exportedXml.includes('w:val="Heading1"'), '导出的 DOCX 未保留 Heading1 样式')
        assert(exportedXml.includes('w:val="Heading2"'), '导出的 DOCX 未保留 Heading2 样式')
        assert(exportedXml.includes('w:val="TOC1"'), '导出的 DOCX 未包含一级目录缓存样式')
        assert(exportedXml.includes('w:val="TOC2"'), '导出的 DOCX 未包含二级目录缓存样式')
        assert((exportedXml.match(/第一章 引言/g) || []).length >= 2, '导出的 DOCX 目录缓存未包含一级标题文本')
        assert((exportedXml.match(/1\.1 研究背景/g) || []).length >= 2, '导出的 DOCX 目录缓存未包含二级标题文本')
        assert(!/第一章 引言\\.{5,}1/.test(exportedXml), '导出的 DOCX 中出现了手写点线页码目录')

        console.log('✅ DOCX 自动目录导入导出端到端测试通过')
        console.log('✅ AI 目录工具定义与提示词约束测试通过')
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
    console.error(`❌ DOCX 自动目录端到端测试失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
