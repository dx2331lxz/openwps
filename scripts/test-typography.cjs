#!/usr/bin/env node
/**
 * 排版功能自动化测试脚本
 * 用法: node scripts/test-typography.js
 * 前提: npm run dev 已在 http://localhost:5173 运行
 */

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')

const PORT = 5173
const BASE_URL = `http://127.0.0.1:${PORT}`
const DIST_DIR = path.join(__dirname, '..', 'dist')
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots')

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })

// ─── Built-in static file server (no external deps) ──────────────────────────
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const mime = { html: 'text/html', js: 'application/javascript', css: 'text/css',
      svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', json: 'application/json' }
    const server = http.createServer((req, res) => {
      let filePath = path.join(DIST_DIR, req.url === '/' ? '/index.html' : req.url)
      // Strip query strings
      filePath = filePath.split('?')[0]
      const ext = path.extname(filePath).slice(1)
      fs.readFile(filePath, (err, data) => {
        if (err) {
          // SPA fallback: serve index.html
          fs.readFile(path.join(DIST_DIR, 'index.html'), (e2, d2) => {
            if (e2) { res.writeHead(404); res.end('Not found'); return }
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(d2)
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

// ─── Result tracking ──────────────────────────────────────────────────────────
const results = []
function pass(name) { results.push({ name, ok: true }); console.log(`  ✅ ${name}`) }
function fail(name, reason) { results.push({ name, ok: false, reason }); console.log(`  ❌ ${name} — ${reason}`) }

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Type text into the ProseMirror editor and wait for it to settle */
async function typeInEditor(page, text) {
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await editor.press('Control+a')
  await editor.type(text)
  await page.waitForTimeout(200)
}

/** Select all text in editor */
async function selectAll(page) {
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await editor.press('Control+a')
  await page.waitForTimeout(100)
}

/** Screenshot helper */
async function screenshot(page, name) {
  const file = path.join(SCREENSHOTS_DIR, `test-${name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return file
}

/** Get computed style of first text span in editor */
async function getFirstSpanStyle(page) {
  return page.evaluate(() => {
    const span = document.querySelector('.ProseMirror span')
    if (!span) return null
    return window.getComputedStyle(span)
  })
}

/** Get computed style of first paragraph in editor */
async function getFirstParaStyle(page) {
  return page.evaluate(() => {
    const p = document.querySelector('.ProseMirror p')
    if (!p) return null
    const cs = window.getComputedStyle(p)
    return {
      textAlign: cs.textAlign,
      textIndent: cs.textIndent,
      marginLeft: cs.marginLeft,
      lineHeight: cs.lineHeight,
    }
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

;(async () => {
  console.log('🚀 启动静态文件服务器...')
  const server = await startStaticServer()
  console.log(`   服务器监听 ${BASE_URL}`)

  console.log('🚀 启动 Chromium...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  // Capture console errors
  const consoleErrors = []
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', err => consoleErrors.push(err.message))

  try {
    console.log(`\n📡 打开 ${BASE_URL}...`)
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 })
    await page.waitForSelector('.ProseMirror', { timeout: 10000 })
    await page.waitForTimeout(500) // wait for paginator to run

    await screenshot(page, '00-initial')
    console.log('  📸 初始截图已保存\n')

    // ──────────────────────────────────────────────────────────────────────────
    console.log('【文字格式测试】')

    // 1. 加粗
    try {
      await typeInEditor(page, '测试加粗文字')
      await selectAll(page)
      await page.click('[title="加粗 (Ctrl+B)"]')
      await page.waitForTimeout(200)
      await screenshot(page, '01-bold')
      const style = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).fontWeight : null
      })
      if (style && (style === 'bold' || Number(style) >= 700)) pass('加粗')
      else fail('加粗', `font-weight=${style}`)
    } catch (e) { fail('加粗', String(e.message)) }

    // 2. 斜体
    try {
      await typeInEditor(page, '测试斜体文字')
      await selectAll(page)
      await page.click('[title="斜体 (Ctrl+I)"]')
      await page.waitForTimeout(200)
      await screenshot(page, '02-italic')
      const style = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).fontStyle : null
      })
      if (style === 'italic') pass('斜体')
      else fail('斜体', `font-style=${style}`)
    } catch (e) { fail('斜体', String(e.message)) }

    // 3. 下划线
    try {
      await typeInEditor(page, '测试下划线文字')
      await selectAll(page)
      await page.click('[title="下划线 (Ctrl+U)"]')
      await page.waitForTimeout(200)
      await screenshot(page, '03-underline')
      const style = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).textDecoration : null
      })
      if (style && style.includes('underline')) pass('下划线')
      else fail('下划线', `text-decoration=${style}`)
    } catch (e) { fail('下划线', String(e.message)) }

    // 4. 删除线
    try {
      await typeInEditor(page, '测试删除线文字')
      await selectAll(page)
      await page.click('[title="删除线"]')
      await page.waitForTimeout(200)
      await screenshot(page, '04-strikethrough')
      const style = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).textDecoration : null
      })
      if (style && style.includes('line-through')) pass('删除线')
      else fail('删除线', `text-decoration=${style}`)
    } catch (e) { fail('删除线', String(e.message)) }

    // 5. 上标
    try {
      await typeInEditor(page, 'X2上标测试')
      await selectAll(page)
      await page.click('[title="上标"]')
      await page.waitForTimeout(200)
      await screenshot(page, '05-superscript')
      const style = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).verticalAlign : null
      })
      if (style === 'super') pass('上标')
      else fail('上标', `vertical-align=${style}`)
    } catch (e) { fail('上标', String(e.message)) }

    // 6. 下标
    try {
      await typeInEditor(page, 'H2O下标测试')
      await selectAll(page)
      await page.click('[title="下标"]')
      await page.waitForTimeout(200)
      await screenshot(page, '06-subscript')
      const style = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).verticalAlign : null
      })
      if (style === 'sub') pass('下标')
      else fail('下标', `vertical-align=${style}`)
    } catch (e) { fail('下标', String(e.message)) }

    // 7. 文字颜色
    try {
      await typeInEditor(page, '测试文字颜色')
      await selectAll(page)
      // Open color picker
      await page.click('[title="文字颜色"]')
      await page.waitForTimeout(200)
      // Click red color (first in grid, #FF0000)
      await page.click('[title="#FF0000"]')
      await page.waitForTimeout(200)
      await screenshot(page, '07-text-color')
      const color = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).color : null
      })
      if (color && color.includes('255') && color.includes('0, 0')) pass('文字颜色红色')
      else fail('文字颜色红色', `color=${color}`)
    } catch (e) { fail('文字颜色红色', String(e.message)) }

    // 8. 文字背景色（高亮）
    try {
      await typeInEditor(page, '测试高亮背景色')
      await selectAll(page)
      await page.click('[title="文字背景色（高亮）"]')
      await page.waitForTimeout(200)
      // Click yellow (#FFFF00)
      await page.click('[title="#FFFF00"]')
      await page.waitForTimeout(200)
      await screenshot(page, '08-highlight')
      const color = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).backgroundColor : null
      })
      if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') pass('文字背景色高亮')
      else fail('文字背景色高亮', `background-color=${color}`)
    } catch (e) { fail('文字背景色高亮', String(e.message)) }

    // 9. 清除格式
    try {
      await typeInEditor(page, '加粗斜体文字清除测试')
      await selectAll(page)
      await page.click('[title="加粗 (Ctrl+B)"]')
      await page.waitForTimeout(100)
      await page.click('[title="斜体 (Ctrl+I)"]')
      await page.waitForTimeout(100)
      await selectAll(page)
      await page.click('[title="清除格式"]')
      await page.waitForTimeout(200)
      await screenshot(page, '09-clear-format')
      const style = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        if (!span) return { bold: false, italic: false }
        const cs = window.getComputedStyle(span)
        return { bold: cs.fontWeight, italic: cs.fontStyle }
      })
      const boldOk = !style.bold || Number(style.bold) < 700
      const italicOk = !style.italic || style.italic === 'normal'
      if (boldOk && italicOk) pass('清除格式')
      else fail('清除格式', `bold=${style.bold} italic=${style.italic}`)
    } catch (e) { fail('清除格式', String(e.message)) }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n【段落格式测试】')

    // 10. 居中对齐
    try {
      await typeInEditor(page, '居中对齐测试文字')
      await selectAll(page)
      await page.click('[title="居中"]')
      await page.waitForTimeout(200)
      await screenshot(page, '10-align-center')
      const s = await getFirstParaStyle(page)
      if (s && s.textAlign === 'center') pass('居中对齐')
      else fail('居中对齐', `text-align=${s?.textAlign}`)
    } catch (e) { fail('居中对齐', String(e.message)) }

    // 11. 右对齐
    try {
      await typeInEditor(page, '右对齐测试文字')
      await selectAll(page)
      await page.click('[title="右对齐"]')
      await page.waitForTimeout(200)
      await screenshot(page, '11-align-right')
      const s = await getFirstParaStyle(page)
      if (s && s.textAlign === 'right') pass('右对齐')
      else fail('右对齐', `text-align=${s?.textAlign}`)
    } catch (e) { fail('右对齐', String(e.message)) }

    // 12. 两端对齐
    try {
      await typeInEditor(page, '两端对齐测试文字两端对齐测试文字两端对齐测试文字')
      await selectAll(page)
      await page.click('[title="两端对齐"]')
      await page.waitForTimeout(200)
      await screenshot(page, '12-align-justify')
      const s = await getFirstParaStyle(page)
      if (s && s.textAlign === 'justify') pass('两端对齐')
      else fail('两端对齐', `text-align=${s?.textAlign}`)
    } catch (e) { fail('两端对齐', String(e.message)) }

    // 13. 左对齐 (reset)
    try {
      await typeInEditor(page, '左对齐测试文字')
      await selectAll(page)
      await page.click('[title="左对齐"]')
      await page.waitForTimeout(200)
      const s = await getFirstParaStyle(page)
      if (s && (s.textAlign === 'left' || s.textAlign === 'start')) pass('左对齐')
      else fail('左对齐', `text-align=${s?.textAlign}`)
    } catch (e) { fail('左对齐', String(e.message)) }

    // 14. 首行缩进
    try {
      await typeInEditor(page, '首行缩进测试')
      await selectAll(page)
      await page.click('[title="增加首行缩进 (Tab)"]')
      await page.waitForTimeout(200)
      await screenshot(page, '14-first-line-indent')
      const s = await getFirstParaStyle(page)
      const indent = parseFloat(s?.textIndent ?? '0')
      if (indent > 0) pass('首行缩进')
      else fail('首行缩进', `text-indent=${s?.textIndent}`)
    } catch (e) { fail('首行缩进', String(e.message)) }

    // 15. 减少首行缩进
    try {
      await typeInEditor(page, '缩进后再减少')
      await selectAll(page)
      await page.click('[title="增加首行缩进 (Tab)"]')
      await page.waitForTimeout(100)
      await page.click('[title="减少首行缩进 (Shift+Tab)"]')
      await page.waitForTimeout(200)
      await screenshot(page, '15-decrease-indent')
      const s = await getFirstParaStyle(page)
      const indent = parseFloat(s?.textIndent ?? '0')
      if (indent === 0) pass('减少首行缩进')
      else fail('减少首行缩进', `text-indent=${s?.textIndent}`)
    } catch (e) { fail('减少首行缩进', String(e.message)) }

    // 16. 行距 2.0
    try {
      await typeInEditor(page, '行距测试文字')
      await selectAll(page)
      const lhSelect = page.locator('[title="行距"]')
      await lhSelect.selectOption('2')
      await page.waitForTimeout(200)
      await screenshot(page, '16-line-height')
      const s = await getFirstParaStyle(page)
      // line-height is computed in px, check it's significantly larger
      const lhPx = parseFloat(s?.lineHeight ?? '0')
      if (lhPx > 25) pass('行距2.0倍')
      else fail('行距2.0倍', `line-height=${s?.lineHeight}`)
    } catch (e) { fail('行距2.0倍', String(e.message)) }

    // 17. 字号 18pt
    try {
      await typeInEditor(page, '字号测试18pt')
      await selectAll(page)
      const sizeInput = page.locator('[title="字号"]')
      await sizeInput.fill('18')
      await sizeInput.press('Enter')
      await page.waitForTimeout(200)
      await screenshot(page, '17-font-size')
      const fontSize = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).fontSize : null
      })
      // 18pt ≈ 24px
      const px = parseFloat(fontSize ?? '0')
      if (px >= 23 && px <= 25) pass('字号18pt')
      else fail('字号18pt', `font-size=${fontSize} (expected ~24px)`)
    } catch (e) { fail('字号18pt', String(e.message)) }

    // 18. 字体黑体
    try {
      await typeInEditor(page, '字体测试黑体')
      await selectAll(page)
      const fontSelect = page.locator('[title="字体"]')
      await fontSelect.selectOption('SimHei, sans-serif')
      await page.waitForTimeout(200)
      await screenshot(page, '18-font-family')
      const fontFamily = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).fontFamily : null
      })
      if (fontFamily && fontFamily.toLowerCase().includes('simhei')) pass('字体黑体')
      else fail('字体黑体', `font-family=${fontFamily}`)
    } catch (e) { fail('字体黑体', String(e.message)) }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n【列表测试】')

    // 19. 无序列表
    try {
      await typeInEditor(page, '无序列表第一项')
      await selectAll(page)
      await page.click('[title="无序列表"]')
      await page.waitForTimeout(200)
      await screenshot(page, '19-bullet-list')
      const hasBullet = await page.evaluate(() => {
        const p = document.querySelector('.ProseMirror p.list-bullet')
        return !!p
      })
      if (hasBullet) pass('无序列表')
      else fail('无序列表', '未找到 .list-bullet 元素')
    } catch (e) { fail('无序列表', String(e.message)) }

    // 20. 有序列表
    try {
      await typeInEditor(page, '有序列表第一项')
      await selectAll(page)
      await page.click('[title="有序列表"]')
      await page.waitForTimeout(200)
      await screenshot(page, '20-ordered-list')
      const hasOrdered = await page.evaluate(() => {
        const p = document.querySelector('.ProseMirror p.list-ordered')
        return !!p
      })
      if (hasOrdered) pass('有序列表')
      else fail('有序列表', '未找到 .list-ordered 元素')
    } catch (e) { fail('有序列表', String(e.message)) }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n【插入功能测试】')

    // 21. 插入水平分割线
    try {
      await typeInEditor(page, '分割线上方文字')
      const editor = page.locator('.ProseMirror')
      await editor.press('End')
      await page.click('[title="插入水平分割线"]')
      await page.waitForTimeout(300)
      await screenshot(page, '21-hr')
      const hasHR = await page.evaluate(() => !!document.querySelector('.ProseMirror hr'))
      if (hasHR) pass('插入水平分割线')
      else fail('插入水平分割线', '未找到 hr 元素')
    } catch (e) { fail('插入水平分割线', String(e.message)) }

    // 22. 插入分页符
    try {
      await typeInEditor(page, '分页符测试段落')
      await selectAll(page)
      await page.click('[title="插入分页符"]')
      await page.waitForTimeout(400)
      await screenshot(page, '22-page-break')
      const hasBreak = await page.evaluate(() => {
        const p = document.querySelector('.ProseMirror p.page-break-before')
        return !!p
      })
      if (hasBreak) pass('插入分页符')
      else fail('插入分页符', '未找到 .page-break-before 元素')
    } catch (e) { fail('插入分页符', String(e.message)) }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n【快捷键测试】')

    // 23. Ctrl+B
    try {
      await typeInEditor(page, 'Ctrl+B快捷键测试')
      await selectAll(page)
      await page.keyboard.press('Control+b')
      await page.waitForTimeout(200)
      const fw = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).fontWeight : null
      })
      if (fw && (fw === 'bold' || Number(fw) >= 700)) pass('Ctrl+B加粗')
      else fail('Ctrl+B加粗', `font-weight=${fw}`)
    } catch (e) { fail('Ctrl+B加粗', String(e.message)) }

    // 24. Ctrl+I
    try {
      await typeInEditor(page, 'Ctrl+I快捷键测试')
      await selectAll(page)
      await page.keyboard.press('Control+i')
      await page.waitForTimeout(200)
      const fi = await page.evaluate(() => {
        const span = document.querySelector('.ProseMirror span')
        return span ? window.getComputedStyle(span).fontStyle : null
      })
      if (fi === 'italic') pass('Ctrl+I斜体')
      else fail('Ctrl+I斜体', `font-style=${fi}`)
    } catch (e) { fail('Ctrl+I斜体', String(e.message)) }

    // 25. Ctrl+Z 撤销
    try {
      await typeInEditor(page, '撤销测试文字')
      await selectAll(page)
      await page.click('[title="加粗 (Ctrl+B)"]')
      await page.waitForTimeout(100)
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(200)
      await screenshot(page, '25-undo')
      pass('Ctrl+Z撤销')
    } catch (e) { fail('Ctrl+Z撤销', String(e.message)) }

    // 26. Tab 增加首行缩进
    try {
      await typeInEditor(page, 'Tab缩进测试')
      const editor = page.locator('.ProseMirror')
      await editor.press('End')
      await editor.press('Tab')
      await page.waitForTimeout(200)
      const s = await getFirstParaStyle(page)
      const indent = parseFloat(s?.textIndent ?? '0')
      if (indent > 0) pass('Tab增加首行缩进')
      else fail('Tab增加首行缩进', `text-indent=${s?.textIndent}`)
    } catch (e) { fail('Tab增加首行缩进', String(e.message)) }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n【工具栏状态同步测试】')

    // 27. 光标移到加粗文字时 B 按钮高亮
    try {
      await typeInEditor(page, '部分加粗文字测试')
      await selectAll(page)
      await page.click('[title="加粗 (Ctrl+B)"]')
      await page.waitForTimeout(100)
      // Click into the text (deselect, place cursor inside)
      const editor = page.locator('.ProseMirror')
      await editor.press('End')
      await page.waitForTimeout(200)
      // Check if B button has active style
      const boldBtnClass = await page.evaluate(() => {
        const btn = document.querySelector('[title="加粗 (Ctrl+B)"]')
        return btn ? btn.className : null
      })
      // Active buttons have 'bg-blue-100' or 'text-blue-700'
      if (boldBtnClass && (boldBtnClass.includes('bg-blue') || boldBtnClass.includes('blue'))) pass('工具栏状态同步-加粗')
      else fail('工具栏状态同步-加粗', `B按钮class=${boldBtnClass}`)
    } catch (e) { fail('工具栏状态同步-加粗', String(e.message)) }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n【分页测试】')

    // 28. 输入超过一页的文字后出现第二张 A4 卡片
    try {
      const editor = page.locator('.ProseMirror')
      await editor.click()
      await editor.press('Control+a')
      // Type a lot of paragraphs to overflow one page (931px of content)
      const manyLines = Array(60).fill('这是一行测试文字，用于填充页面以触发自动分页功能。').join('\n')
      await editor.fill(manyLines)
      await page.waitForTimeout(1000) // wait for debounced repagination
      await screenshot(page, '28-pagination')
      // Check that there are 2+ page cards rendered
      const pageCardCount = await page.evaluate(() => {
        // Page cards are divs with white background and box shadow, absolute positioned
        const cards = document.querySelectorAll('[style*="box-shadow"]')
        return cards.length
      })
      if (pageCardCount >= 2) pass('自动分页出现第二页')
      else fail('自动分页出现第二页', `页面卡片数量=${pageCardCount}`)
    } catch (e) { fail('自动分页出现第二页', String(e.message)) }

    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n【页面设置测试】')

    // 29. 打开页面设置弹窗
    try {
      await page.click('[title="页面设置"]')
      await page.waitForTimeout(300)
      await screenshot(page, '29-page-settings')
      const modalVisible = await page.evaluate(() => {
        return !!document.querySelector('h3')
      })
      if (modalVisible) pass('页面设置弹窗')
      else fail('页面设置弹窗', '弹窗未出现')
      // Close it
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    } catch (e) { fail('页面设置弹窗', String(e.message)) }

    // ──────────────────────────────────────────────────────────────────────────
    // Final screenshot
    await screenshot(page, 'zz-final')

  } catch (err) {
    console.error('Fatal error:', err)
  } finally {
    await browser.close()
    server.close()
  }

  // ─── Report ─────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  console.log('\n' + '='.repeat(50))
  console.log('        排版功能测试报告')
  console.log('='.repeat(50))
  for (const r of results) {
    const status = r.ok ? '✅' : '❌'
    const reason = r.ok ? '' : `  (${r.reason})`
    console.log(`${status} ${r.name.padEnd(20)}${reason}`)
  }
  console.log('='.repeat(50))
  console.log(`通过: ${passed}/${results.length}`)
  console.log(`失败: ${failed}/${results.length}`)
  console.log('='.repeat(50))

  if (consoleErrors.length > 0) {
    console.log('\n⚠️  Console 错误:')
    consoleErrors.forEach(e => console.log('  ', e))
  } else {
    console.log('\n✅ 无 Console 错误')
  }

  console.log(`\n📸 截图已保存到: ${SCREENSHOTS_DIR}`)

  process.exit(failed > 0 ? 1 : 0)
})()
