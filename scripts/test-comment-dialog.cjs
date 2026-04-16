#!/usr/bin/env node

const { chromium } = require('playwright')

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function openInsertTab(page) {
  await page.getByRole('button', { name: '插入' }).click()
  await page.waitForTimeout(100)
}

async function selectInitialText(page, charCount = 6) {
  const editor = page.locator('.ProseMirror')
  const box = await editor.boundingBox()
  assert(box, '未找到编辑器区域')

  await page.mouse.click(box.x + 30, box.y + 20)
  await page.keyboard.down('Shift')
  for (let index = 0; index < charCount; index += 1) {
    await page.keyboard.press('ArrowRight')
  }
  await page.keyboard.up('Shift')
  await page.waitForTimeout(120)

  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

async function selectTextFromOffset(page, offset, charCount = 4) {
  const editor = page.locator('.ProseMirror')
  const box = await editor.boundingBox()
  assert(box, '未找到编辑器区域')

  await page.mouse.click(box.x + 30, box.y + 20)
  for (let index = 0; index < offset; index += 1) {
    await page.keyboard.press('ArrowRight')
  }

  await page.keyboard.down('Shift')
  for (let index = 0; index < charCount; index += 1) {
    await page.keyboard.press('ArrowRight')
  }
  await page.keyboard.up('Shift')
  await page.waitForTimeout(120)

  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

async function getCollapsedCaretLeft(page) {
  return page.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0).cloneRange()
    range.collapse(true)
    const rect = range.getBoundingClientRect()
    return Number.isFinite(rect.left) ? rect.left : null
  })
}

async function dragSelectInEditor(page, startOffsetX, endOffsetX) {
  const editor = page.locator('.ProseMirror')
  const box = await editor.boundingBox()
  assert(box, '未找到编辑器区域')

  await page.mouse.move(box.x + startOffsetX, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + endOffsetX, box.y + 20, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(120)

  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

async function clickCommentButton(page) {
  await page.getByRole('button', { name: /批注/ }).click()
  await page.waitForTimeout(250)
}

async function pressAndReleaseCommentButton(page) {
  const button = page.getByRole('button', { name: /批注/ })
  const box = await button.boundingBox()
  assert(box, '未找到批注按钮')

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(80)
  const dialogWhileHolding = await page.locator('text=添加批注').count()
  await page.mouse.up()
  await page.waitForTimeout(250)
  const dialogAfterRelease = await page.locator('text=添加批注').count()
  return { dialogWhileHolding, dialogAfterRelease }
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
  const debugLog = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') debugLog.push(`console-error:${msg.text()}`)
  })
  page.on('pageerror', (error) => {
    debugLog.push(`pageerror:${error.message}`)
  })
  page.on('dialog', async (dialog) => {
    debugLog.push(`dialog:${dialog.message()}`)
    await dialog.dismiss()
  })

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 })
    await page.waitForSelector('.ProseMirror', { timeout: 10000 })

    const paragraphText = await page.locator('.ProseMirror p').first().innerText()
    debugLog.push(`paragraphText:${JSON.stringify(paragraphText)}`)

    const editor = page.locator('.ProseMirror')
    const editorBox = await editor.boundingBox()
    assert(editorBox, '未找到编辑器边界')

    await page.mouse.click(editorBox.x + 28, editorBox.y + 20)
    await page.waitForTimeout(100)
    const caretLeftNearStart = await getCollapsedCaretLeft(page)
    await page.mouse.click(editorBox.x + 150, editorBox.y + 20)
    await page.waitForTimeout(100)
    const caretLeftFurther = await getCollapsedCaretLeft(page)
    debugLog.push(`caretLeftNearStart:${caretLeftNearStart}`)
    debugLog.push(`caretLeftFurther:${caretLeftFurther}`)
    assert(caretLeftNearStart != null && caretLeftFurther != null && caretLeftFurther > caretLeftNearStart + 20, '单击不同横向位置时光标未按可见位置移动')

    const shortDragSelection = await dragSelectInEditor(page, 30, 120)
    debugLog.push(`shortDragSelection:${JSON.stringify(shortDragSelection)}`)
    assert(shortDragSelection.length > 0, '短距离拖选未选中任何文字')
    assert(shortDragSelection.length < paragraphText.length, '短距离拖选仍错误地选中了整段正文')

    await openInsertTab(page)
    const selectionText = await selectInitialText(page)
    debugLog.push(`selection:${JSON.stringify(selectionText)}`)
    assert(selectionText.length > 0, '未能选中文档初始文字')

    const heldOpenState = await pressAndReleaseCommentButton(page)
    debugLog.push(`dialogPresentWhileHolding:${heldOpenState.dialogWhileHolding}`)
    debugLog.push(`dialogPresentAfterRelease:${heldOpenState.dialogAfterRelease}`)
    assert(heldOpenState.dialogWhileHolding > 0, '按下“批注”按钮时弹框未出现')
    assert(heldOpenState.dialogAfterRelease > 0, '松开“批注”按钮后弹框未保持显示')

    await page.mouse.click(20, 20)
    await page.waitForTimeout(150)
    const dialogAfterOutsideClick = await page.locator('text=添加批注').count()
    debugLog.push(`dialogPresentAfterOutsideClick:${dialogAfterOutsideClick}`)
    assert(dialogAfterOutsideClick === 0, '点击弹框外部后弹框未关闭')

    await openInsertTab(page)
    const selectionTextAgain = await selectInitialText(page)
    debugLog.push(`selectionAgain:${JSON.stringify(selectionTextAgain)}`)
    assert(selectionTextAgain.length > 0, '二次打开前未能重新选中文字')

    await clickCommentButton(page)
    await page.getByPlaceholder('输入批注内容…').fill('自动化批注测试')
    await page.getByRole('button', { name: '确定' }).click()
    await page.waitForTimeout(200)

    const commentMarkCount = await page.locator('.ProseMirror .pm-comment').count()
    const dialogAfterConfirm = await page.locator('text=添加批注').count()
    const sidebarCommentVisible = await page.getByText('自动化批注测试', { exact: true }).count()
    debugLog.push(`commentMarkCount:${commentMarkCount}`)
    debugLog.push(`dialogPresentAfterConfirm:${dialogAfterConfirm}`)
    debugLog.push(`sidebarCommentVisible:${sidebarCommentVisible}`)
    assert(commentMarkCount > 0, '确认批注后未写入 comment mark')
    assert(dialogAfterConfirm === 0, '确认批注后弹框未关闭')
    assert(sidebarCommentVisible > 0, '确认批注后右侧边注未默认显示')

    await openInsertTab(page)
    const secondSelectionText = await selectTextFromOffset(page, 9, 2)
    debugLog.push(`secondSelection:${JSON.stringify(secondSelectionText)}`)
    assert(secondSelectionText.length > 0, '未能选中第二段批注文字')

    await clickCommentButton(page)
    await page.getByPlaceholder('输入批注内容…').fill('第二条批注')
    await page.getByRole('button', { name: '确定' }).click()
    await page.waitForTimeout(200)

    const cardsBeforeActivate = await page.locator('[data-comment-card=\"true\"]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute('data-comment-id'),
        active: node.getAttribute('data-active'),
        zIndex: window.getComputedStyle(node).zIndex,
        text: node.textContent,
      })),
    )
    debugLog.push(`commentCardsBeforeActivate:${JSON.stringify(cardsBeforeActivate)}`)

    await page.getByText('第二条批注', { exact: true }).click()
    await page.waitForTimeout(120)

    const cardsAfterActivate = await page.locator('[data-comment-card=\"true\"]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute('data-comment-id'),
        active: node.getAttribute('data-active'),
        zIndex: window.getComputedStyle(node).zIndex,
        text: node.textContent,
      })),
    )
    debugLog.push(`commentCardsAfterActivate:${JSON.stringify(cardsAfterActivate)}`)
    assert(cardsAfterActivate.some((card) => card.text?.includes('第二条批注') && card.active === 'true' && Number(card.zIndex) >= 2), '点击下层批注后未提升到上层')

    await page.mouse.click(editorBox.x + 28, editorBox.y + 20)
    await page.waitForTimeout(100)
    const caretLeftWithCommentsStart = await getCollapsedCaretLeft(page)
    await page.mouse.click(editorBox.x + 150, editorBox.y + 20)
    await page.waitForTimeout(100)
    const caretLeftWithCommentsFurther = await getCollapsedCaretLeft(page)
    const shortDragSelectionWithComments = await dragSelectInEditor(page, 30, 120)
    debugLog.push(`caretLeftWithCommentsStart:${caretLeftWithCommentsStart}`)
    debugLog.push(`caretLeftWithCommentsFurther:${caretLeftWithCommentsFurther}`)
    debugLog.push(`shortDragSelectionWithComments:${JSON.stringify(shortDragSelectionWithComments)}`)
    assert(caretLeftWithCommentsStart != null && caretLeftWithCommentsFurther != null && caretLeftWithCommentsFurther > caretLeftWithCommentsStart + 20, '已有批注时单击正文仍未按可见位置移动')
    assert(shortDragSelectionWithComments.length > 0 && shortDragSelectionWithComments.length < paragraphText.length, '已有批注时短距离拖选仍错误地选中了整段正文')

    console.log('批注弹框自动化测试通过')
    console.log(debugLog.join('\n'))
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error('批注弹框自动化测试失败')
  console.error(error)
  process.exitCode = 1
})
