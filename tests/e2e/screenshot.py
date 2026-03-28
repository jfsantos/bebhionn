#!/usr/bin/env python3
"""Generate screenshots and a demo GIF of the tracker for the README.

Usage:
    python3 tests/e2e/screenshot.py [output_dir]

Produces:
    screenshot.png          Full tracker interface
    screenshot_inst.png     Instrument editor panel (sidebar)
    screenshot_detail.png   Instrument detail panel (envelope, waveform, routing)
    screenshot_dsp.png      DSP effect editor
    demo.gif                Short clip of tracker playing the demo song
"""

import os
import shutil
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


def record_demo_gif(html_path, out_dir, duration_sec=6):
    """Record a short video of the tracker playing, convert to GIF."""
    gif_path = os.path.join(out_dir, 'demo.gif')
    video_dir = tempfile.mkdtemp(prefix='bebhionn_vid_')

    has_ffmpeg = shutil.which('ffmpeg') is not None
    if not has_ffmpeg:
        print('  WARNING: ffmpeg not found, skipping demo.gif')
        return

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            viewport={'width': 1400, 'height': 800},
            record_video_dir=video_dir,
            record_video_size={'width': 1400, 'height': 800},
        )
        page = context.new_page()
        page.goto(f'file://{html_path}')
        page.wait_for_timeout(1500)

        # Init engine and start playback
        page.evaluate('SCSPEngine.init().then(function() { SCSPEngine.startAudio(playback); togglePlay(); })')
        page.wait_for_timeout(duration_sec * 1000)

        # Stop playback
        page.evaluate('stopPlayback()')
        page.wait_for_timeout(300)

        page.close()
        context.close()
        browser.close()

    # Find the recorded webm
    videos = [f for f in os.listdir(video_dir) if f.endswith('.webm')]
    if not videos:
        print('  WARNING: no video recorded, skipping demo.gif')
        shutil.rmtree(video_dir)
        return

    webm_path = os.path.join(video_dir, videos[0])

    # Convert to GIF via ffmpeg: generate palette for quality, then render
    palette_path = os.path.join(video_dir, 'palette.png')
    subprocess.run([
        'ffmpeg', '-y', '-i', webm_path,
        '-vf', 'fps=12,scale=700:-1:flags=lanczos,palettegen=stats_mode=diff',
        palette_path,
    ], capture_output=True)
    subprocess.run([
        'ffmpeg', '-y', '-i', webm_path, '-i', palette_path,
        '-lavfi', 'fps=12,scale=700:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer',
        gif_path,
    ], capture_output=True)

    shutil.rmtree(video_dir)

    size_kb = os.path.getsize(gif_path) / 1024
    print(f'  demo.gif ({size_kb:.0f} KB)')


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

    # Record demo GIF (separate browser context with video recording)
    print('Recording demo:')
    record_demo_gif(html_path, out_dir)

    os.unlink(html_path)
    print(f'Done — saved to {out_dir}/')


if __name__ == '__main__':
    main()
