#!/usr/bin/env python3
"""排版功能自动化测试脚本"""
import asyncio, os
from playwright.async_api import async_playwright

BASE = "http://localhost:5173"
SS = os.path.join(os.path.dirname(__file__), '..', 'screenshots')
os.makedirs(SS, exist_ok=True)

results = []

async def type_and_select(page, text="测试文字 Test 123"):
    editor = page.locator(".ProseMirror").first
    await editor.click()
    await page.keyboard.press("Control+a")
    await page.keyboard.press("Delete")
    await page.keyboard.type(text)
    await page.wait_for_timeout(200)
    await page.keyboard.press("Control+a")

async def check_style(page, prop, expected):
    style = await page.evaluate(f"""() => {{
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return '';
        const el = sel.getRangeAt(0).startContainer.parentElement;
        return window.getComputedStyle(el)['{prop}'];
    }}""")
    ok = expected.lower() in str(style).lower()
    return ok, f"{prop}='{style}'"

async def run(page, name, action, verify):
    try:
        await action(page)
        ok, detail = await verify(page)
        await page.screenshot(path=f"{SS}/test-{name}.png")
        results.append((name, ok, detail))
        print(f"{'✅' if ok else '❌'} {name:16s} {detail}")
    except Exception as e:
        results.append((name, False, str(e)[:100]))
        try:
            await page.screenshot(path=f"{SS}/test-{name}-error.png")
        except:
            pass
        print(f"❌ {name:16s} ERROR: {e}")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.set_viewport_size({"width": 1280, "height": 900})
        await page.goto(BASE, wait_until="networkidle")
        await page.screenshot(path=f"{SS}/00-init.png")
        print("页面已加载，开始测试...\n")

        # 1. 加粗
        async def t1(p):
            await type_and_select(p)
            await p.click('[title="加粗 (Ctrl+B)"]')
        await run(page, "加粗", t1, lambda p: check_style(p, "fontWeight", "700"))

        # 2. 斜体
        async def t2(p):
            await type_and_select(p)
            await p.click('[title="斜体 (Ctrl+I)"]')
        await run(page, "斜体", t2, lambda p: check_style(p, "fontStyle", "italic"))

        # 3. 下划线
        async def t3(p):
            await type_and_select(p)
            await p.click('[title="下划线 (Ctrl+U)"]')
        await run(page, "下划线", t3, lambda p: check_style(p, "textDecoration", "underline"))

        # 4. 删除线
        async def t4(p):
            await type_and_select(p)
            btn = p.locator('[title*="删除线"]')
            if await btn.count() == 0:
                raise Exception("按钮未找到")
            await btn.first.click()
        await run(page, "删除线", t4, lambda p: check_style(p, "textDecoration", "line-through"))

        # 5. 居中
        async def t5(p):
            await type_and_select(p)
            await p.click('[title="居中"]')
        async def v5(p):
            s = await p.evaluate("() => { const el = document.querySelector('.ProseMirror p'); return el ? window.getComputedStyle(el).textAlign : ''; }")
            return "center" in s.lower(), f"textAlign='{s}'"
        await run(page, "居中对齐", t5, v5)

        # 6. 右对齐
        async def t6(p):
            await type_and_select(p)
            await p.click('[title="右对齐"]')
        async def v6(p):
            s = await p.evaluate("() => { const el = document.querySelector('.ProseMirror p'); return el ? window.getComputedStyle(el).textAlign : ''; }")
            return "right" in s.lower(), f"textAlign='{s}'"
        await run(page, "右对齐", t6, v6)

        # 7. 首行缩进
        async def t7(p):
            await type_and_select(p)
            btn = p.locator('[title="增加首行缩进"]')
            if await btn.count() == 0:
                raise Exception("按钮未找到")
            await btn.first.click()
        async def v7(p):
            s = await p.evaluate("() => { const el = document.querySelector('.ProseMirror p'); return el ? window.getComputedStyle(el).textIndent : ''; }")
            ok = s not in ("", "0px")
            return ok, f"textIndent='{s}'"
        await run(page, "首行缩进", t7, v7)

        # 8. 行距
        async def t8(p):
            await type_and_select(p)
            sel = p.locator('select[title*="行距"]')
            if await sel.count() == 0:
                sel = p.locator('select').nth(2)
            if await sel.count() == 0:
                raise Exception("行距下拉未找到")
            opts = await sel.locator('option').all_text_contents()
            target = "1.5" if "1.5" in str(opts) else opts[0] if opts else None
            if target:
                await sel.select_option(label=target)
        async def v8(p):
            s = await p.evaluate("() => { const el = document.querySelector('.ProseMirror p'); return el ? window.getComputedStyle(el).lineHeight : ''; }")
            return s != "", f"lineHeight='{s}'"
        await run(page, "行距", t8, v8)

        # 9. 字号
        async def t9(p):
            await type_and_select(p)
            sel = p.locator('select').first
            await sel.select_option(value="18")
        async def v9(p):
            s = await p.evaluate("() => { const sel = window.getSelection(); if (!sel || !sel.rangeCount) return ''; return window.getComputedStyle(sel.getRangeAt(0).startContainer.parentElement).fontSize; }")
            ok = "24px" in s or "18pt" in s
            return ok, f"fontSize='{s}'"
        await run(page, "字号18pt", t9, v9)

        # 10. 字体
        async def t10(p):
            await type_and_select(p)
            sel = p.locator('select').nth(1)
            opts = await sel.locator('option').all_text_contents()
            print(f"   [字体选项: {opts[:5]}]")
            if "黑体" in str(opts):
                await sel.select_option(label="黑体")
            else:
                raise Exception(f"黑体选项未找到，选项: {opts[:5]}")
        await run(page, "字体黑体", t10, lambda p: check_style(p, "fontFamily", "黑体"))

        # 11. 文字颜色
        async def t11(p):
            await type_and_select(p)
            btn = p.locator('[title*="颜色"]').first
            if await btn.count() == 0:
                raise Exception("颜色按钮未找到")
            await btn.click()
            await p.wait_for_timeout(400)
            red = p.locator('[data-color="#FF0000"], [data-color="red"], [style*="FF0000"]')
            if await red.count() > 0:
                await red.first.click()
            else:
                raise Exception("红色色板未找到")
        await run(page, "文字颜色", t11, lambda p: check_style(p, "color", "255"))

        # 12. 清除格式
        async def t12(p):
            await type_and_select(p)
            await p.click('[title="加粗 (Ctrl+B)"]')
            await p.keyboard.press("Control+a")
            btn = p.locator('[title*="清除格式"], [title*="清除"]')
            if await btn.count() == 0:
                raise Exception("清除格式按钮未找到")
            await btn.first.click()
        async def v12(p):
            fw = await p.evaluate("() => { const span = document.querySelector('.ProseMirror span'); return span ? window.getComputedStyle(span).fontWeight : '400'; }")
            ok = str(fw) in ("400", "normal", "")
            return ok, f"fontWeight after clear='{fw}'"
        await run(page, "清除格式", t12, v12)

        # 13. 撤销
        async def t13(p):
            await type_and_select(p)
            await p.click('[title="加粗 (Ctrl+B)"]')
            await p.wait_for_timeout(100)
            await p.keyboard.press("Control+z")
            await p.wait_for_timeout(100)
        async def v13(p):
            fw = await p.evaluate("() => { const span = document.querySelector('.ProseMirror span'); return span ? window.getComputedStyle(span).fontWeight : '400'; }")
            ok = str(fw) in ("400", "normal", "")
            return ok, f"fontWeight after undo='{fw}'"
        await run(page, "撤销 Ctrl+Z", t13, v13)

        # 14. 无序列表
        async def t14(p):
            await type_and_select(p)
            btn = p.locator('[title*="无序列表"]')
            if await btn.count() == 0:
                raise Exception("无序列表按钮未找到")
            await btn.first.click()
        async def v14(p):
            cnt = await p.locator('.ProseMirror ul li, .ProseMirror [data-list-type="bullet"]').count()
            return cnt > 0, f"list items={cnt}"
        await run(page, "无序列表", t14, v14)

        # 15. 有序列表
        async def t15(p):
            await type_and_select(p)
            btn = p.locator('[title*="有序列表"]')
            if await btn.count() == 0:
                raise Exception("有序列表按钮未找到")
            await btn.first.click()
        async def v15(p):
            cnt = await p.locator('.ProseMirror ol li, .ProseMirror [data-list-type="ordered"]').count()
            return cnt > 0, f"list items={cnt}"
        await run(page, "有序列表", t15, v15)

        # 16. 分页符
        async def t16(p):
            editor = p.locator(".ProseMirror").first
            await editor.click()
            await p.keyboard.press("End")
            btn = p.locator('[title*="分页符"]')
            if await btn.count() == 0:
                raise Exception("分页符按钮未找到")
            await btn.first.click()
        async def v16(p):
            cnt = await p.locator('.page-break, [data-page-break], .ProseMirror hr').count()
            return cnt > 0, f"page-break count={cnt}"
        await run(page, "分页符", t16, v16)

        # 最终截图
        editor = page.locator(".ProseMirror").first
        await editor.click()
        await page.keyboard.press("Control+a")
        await page.keyboard.press("Delete")
        await page.keyboard.type("排版功能测试完成！")
        await page.screenshot(path=f"{SS}/99-final.png", full_page=True)
        await browser.close()

        # 报告
        print("\n" + "="*50)
        print("排版功能测试报告")
        print("="*50)
        passed = sum(1 for _, ok, _ in results if ok)
        failed = [(n, d) for n, ok, d in results if not ok]
        for name, ok, detail in results:
            print(f"{'✅' if ok else '❌'} {name:16s} {detail}")
        print(f"\n通过: {passed}/{len(results)}")
        print(f"失败: {len(results)-passed}/{len(results)}")
        if errs:
            print(f"\nConsole errors ({len(errs)}):")
            for e in errs[:5]:
                print(f"  {e}")
        else:
            print("\nConsole: 无报错 ✅")
        if failed:
            print("\n失败项目：")
            for n, d in failed:
                print(f"  - {n}: {d}")

asyncio.run(main())
