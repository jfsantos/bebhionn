#!/usr/bin/env python3
"""Generate screenshots of the tracker for the README.

Usage:
    python3 tests/e2e/screenshot.py [output_dir]

Produces:
    screenshot.png          Full tracker interface
    screenshot_inst.png     Instrument editor panel (sidebar)
    screenshot_detail.png   Instrument detail panel (envelope, waveform, routing)
    screenshot_dsp.png      DSP effect editor
"""

import os
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def screenshot_element(page, selector, path, crop_to=None):
    """Screenshot a single element by selector.

    If crop_to is a CSS selector, clips the screenshot from the element's
    top-left to the bottom of the crop_to element (plus padding).
    """
    el = page.query_selector(selector)
    if not el:
        print(f'  WARNING: {selector} not found, skipping {os.path.basename(path)}')
        return

    if crop_to:
        clip = page.evaluate('''([sel, cropSel]) => {
            var el = document.querySelector(sel);
            var cropEl = document.querySelector(cropSel);
            var rect = el.getBoundingClientRect();
            var cropRect = cropEl ? cropEl.getBoundingClientRect() : rect;
            return {
                x: rect.x, y: rect.y,
                width: rect.width,
                height: cropRect.bottom - rect.y + 10
            };
        }''', [selector, crop_to])
        page.screenshot(path=path, clip=clip)
    else:
        el.screenshot(path=path)

    print(f'  {os.path.basename(path)}')


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else REPO_ROOT

    # Generate bundled HTML
    fd, html_path = tempfile.mkstemp(suffix='.html', prefix='bebhionn_')
    os.close(fd)
    subprocess.run(
        [sys.executable, os.path.join(REPO_ROOT, 'generate.py'), '--no-open', '-o', html_path],
        check=True,
    )

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1400, 'height': 900})
        page.goto(f'file://{html_path}')
        page.wait_for_timeout(1500)

        print('Screenshots:')

        # Full interface
        full_path = os.path.join(out_dir, 'screenshot.png')
        page.screenshot(path=full_path)
        print(f'  screenshot.png')

        # Select a multi-operator instrument for a more interesting sidebar
        # Click on "Brass" (index 2) which has 2 ops with modulation
        page.evaluate('''() => {
            var items = document.querySelectorAll(".inst-item");
            if (items[2]) items[2].click();
        }''')
        page.wait_for_timeout(300)
        # Switch to Op2 to show modulation routing
        page.evaluate('''() => {
            var tabs = document.querySelectorAll("#inst-editor .op-tab");
            if (tabs[1]) tabs[1].click();
        }''')
        page.wait_for_timeout(200)

        # Instrument editor (sidebar panel, cropped to visible content)
        screenshot_element(page, '#inst-panel', os.path.join(out_dir, 'screenshot_inst.png'), crop_to='#inst-editor button:last-child')

        # Open instrument detail panel (envelope, waveform, routing)
        page.evaluate('toggleInstDetail()')
        page.wait_for_timeout(500)
        screenshot_element(page, '#inst-detail', os.path.join(out_dir, 'screenshot_detail.png'))
        # Close it before opening DSP
        page.evaluate('toggleInstDetail()')
        page.wait_for_timeout(300)

        # Open DSP panel, init the SCSP engine, then compile the default delay program
        page.evaluate('toggleDspPanel()')
        page.wait_for_timeout(500)
        page.evaluate('SCSPEngine.init().then(function() { dspCompile(); })')
        page.wait_for_timeout(1000)
        screenshot_element(page, '#dsp-panel', os.path.join(out_dir, 'screenshot_dsp.png'))

        browser.close()

    os.unlink(html_path)
    print(f'Done — saved to {out_dir}/')


if __name__ == '__main__':
    main()
