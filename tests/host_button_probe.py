"""Read-only probe for the installed one-click rebuild control on a live host."""
import json
import os
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ORIGIN = os.environ.get("FOLIO_ST_URL", "http://192.168.50.41:8000").rstrip("/")
READ_POSTS = {
    "/api/settings/get",
    "/api/characters/all",
    "/api/characters/get",
    "/api/characters/chats",
    "/api/chats/get",
    "/api/worldinfo/get",
    "/api/presets/get",
    "/api/avatars/get",
    "/api/groups/all",
    "/api/sd/comfy/workflows",
    "/api/secrets/read",
    "/api/backgrounds/all",
}


def guard(route):
    request = route.request
    path = urlparse(request.url).path
    if urlparse(request.url).netloc != urlparse(ORIGIN).netloc:
        route.abort()
    elif request.method in ("POST", "PUT", "PATCH", "DELETE") and path not in READ_POSTS and not path.startswith("/api/tokenizers/"):
        route.fulfill(status=403, body="Read-only Folio probe")
    else:
        route.continue_()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        context = browser.new_context(viewport={"width": 1440, "height": 1050})
        context.route("**/*", guard)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(ORIGIN, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#folio-wand", state="attached", timeout=60000)
        page.locator("#extensionsMenuButton").click()
        page.locator("#folio-wand").click()
        page.wait_for_timeout(2500)
        button = page.get_by_role("button", name="一鍵重新整理全部", exact=True).first
        button.wait_for(state="visible")
        result = button.evaluate("""button => {
            const rect = button.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            return {
                disabled: button.disabled,
                ariaDisabled: button.getAttribute('aria-disabled'),
                pointerEvents: getComputedStyle(button).pointerEvents,
                hitSelf: hit === button || button.contains(hit),
                hitTag: hit?.tagName ?? null,
                hitClass: hit?.className ?? null,
                label: button.textContent.trim(),
                status: document.querySelector('.folio-status')?.textContent.trim() ?? '',
                warning: document.querySelector('.folio-warning:not([hidden])')?.textContent.trim() ?? '',
                totalPages: document.querySelectorAll('.folio-page-link').length,
                contextMessages: SillyTavern.getContext().chat?.length ?? 0,
                rebuildButtons: [...document.querySelectorAll('.folio-rebuild button')].map(node => ({
                    label: node.textContent.trim(),
                    disabled: node.disabled,
                    hidden: node.hidden,
                })),
                generationEvents: Object.fromEntries(Object.entries(SillyTavern.getContext().eventTypes)
                    .filter(([key]) => key.includes('GENERATION'))),
            };
        }""")
        result["pageErrors"] = errors
        print(json.dumps(result, ensure_ascii=False))
    finally:
        browser.close()
