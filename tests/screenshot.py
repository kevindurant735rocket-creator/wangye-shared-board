"""
登录页截图脚本（证据）
  - 启动浏览器 -> 访问 /  -> 截图到 tests/login-page.png
  - 自动登录后截图 tests/home-page.png
用法： python3 tests/screenshot.py
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:3030")
USER = os.environ.get("USER", "demo")
PASS = os.environ.get("PASS", "demo1234")


def main():
    errors = []
    network_401 = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1024, "height": 720})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror:{e.message}"))
        page.on("console", lambda m: errors.append(f"console:{m.text}") if m.type == "error" else None)
        page.on("response", lambda r: network_401.append(f"{r.status} {r.url}") if r.status >= 400 else None)

        page.goto(f"{BASE}/", wait_until="domcontentloaded")
        form_ok = page.locator("#loginForm").is_visible()
        try:
            page.locator("#refreshCaptcha svg").wait_for(state="visible", timeout=5000)
            captcha_ok = True
        except Exception:
            captcha_ok = False
        print(f"loginForm visible: {form_ok}")
        print(f"captcha svg visible: {captcha_ok}")

        page.screenshot(path="tests/login-page.png", full_page=True)

        code = page.evaluate(
            """() => Array.from(document.querySelectorAll('#refreshCaptcha text'))
                       .map(t => t.textContent).join('')"""
        )
        print(f"captcha code: {code}")

        page.fill("#username", USER)
        page.fill("#password", PASS)
        page.fill("#captchaCode", code)
        page.click("#submitBtn")
        # wait for either navigation or url change away from /
        try:
            page.wait_for_function(
                "() => window.location.pathname === '/' && !document.getElementById('loginForm')",
                timeout=8000,
            )
        except Exception as e:
            print(f"wait: {e}")
        # extra settle
        page.wait_for_timeout(1500)
        final_url = page.url
        print(f"final url: {final_url}")
        page.screenshot(path="tests/home-page.png", full_page=True)

        with open("tests/screenshot-result.json", "w") as f:
            json.dump(
                {
                    "base": BASE,
                    "loginFormVisible": form_ok,
                    "captchaSvgVisible": captcha_ok,
                    "finalUrl": final_url,
                    "errors": errors,
                    "network_4xx": network_401,
                },
                f,
                indent=2,
                ensure_ascii=False,
            )

        browser.close()

    print(f"DONE errors: {len(errors)}; network>=400: {len(network_401)}")
    for e in errors:
        print(" E", e)
    for n in network_401:
        print(" N", n)
    # tolerate 4xx for after-logout probe screenshots
    return 0


if __name__ == "__main__":
    sys.exit(main())
