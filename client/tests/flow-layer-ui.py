# Prevent moving task cards from hiding behind nodes or blocking clicks outside the card.
# Run against a running Studio with a completed task: python tests/flow-layer-ui.py [URL]
import sys
from playwright.sync_api import sync_playwright, expect


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(viewport={"width": 1920, "height": 1010}, reduced_motion="no-preference")
    page.set_default_timeout(8000)
    page.route("**/api/**", lambda route: route.continue_() if route.request.method in ("GET", "HEAD") else route.abort())
    page.goto(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3360")
    page.locator('[data-wb="replay"]').click()
    token = page.locator(".fc-token").first
    expect(token).to_be_visible()
    page.locator('[data-wb="motion"]').click()
    result = token.evaluate("""token => {
        const r = token.querySelector('rect').getBoundingClientRect();
        let overlap = null;
        for (let x = r.left + 10; x < r.right - 10; x += 10) {
            for (let y = r.top + 6; y < r.bottom - 6; y += 6) {
                const stack = document.elementsFromPoint(x, y);
                if (stack.some(el => el.closest('.fc-node'))) {
                    if (!stack[0].closest('.fc-token')) return {covered: true};
                    overlap = {x, y};
                }
            }
        }
        const node = document.querySelector('[data-node="gateway"]');
        const n = node.getBoundingClientRect();
        return {overlap, nodeClickable: !!document.elementFromPoint(n.left + n.width / 2, n.top + n.height / 2).closest('.fc-node')};
    }""")
    assert not result.get("covered"), "Task card is covered by a flow node"
    assert result.get("overlap"), "Replay must overlap a node to reproduce the reported failure"
    assert result["nodeClickable"], "Empty overlay area must let clicks through to nodes"
    page.mouse.click(**result["overlap"])
    drawer = page.locator("#drawer")
    expect(drawer).to_be_visible()
    expect(drawer.get_by_role("region", name="任务对话")).to_be_visible()
    browser.close()
    print("Task card stays above nodes, opens details, and leaves other nodes clickable.")
