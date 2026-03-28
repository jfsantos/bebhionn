#!/usr/bin/env python3
"""Generate a screenshot of the tracker for the README."""

import os
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    output = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO_ROOT, 'screenshot.png')

    # Generate bundled HTML
    fd, html_path = tempfile.mkstemp(suffix='.html', prefix='bebhionn_')
    os.close(fd)
    subprocess.run(
        [sys.executable, os.path.join(REPO_ROOT, 'generate.py'), '--no-open', '-o', html_path],
        check=True,
    )

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1400, 'height': 800})
        page.goto(f'file://{html_path}')
        page.wait_for_timeout(1500)
        page.screenshot(path=output)
        browser.close()

    os.unlink(html_path)
    print(f'Screenshot saved to {output}')


if __name__ == '__main__':
    main()
