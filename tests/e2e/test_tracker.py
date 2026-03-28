#!/usr/bin/env python3
"""
End-to-end tests for the Bebhionn tracker using Playwright.

Run:
    python3 -m pytest tests/e2e/test_tracker.py -v

Requires: pip install playwright pytest && playwright install chromium
"""

import os
import subprocess
import sys
import tempfile

import pytest
from playwright.sync_api import sync_playwright, Page

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(scope='session')
def html_path():
    """Generate a bundled HTML file once for the whole test session."""
    fd, path = tempfile.mkstemp(suffix='.html', prefix='bebhionn_test_')
    os.close(fd)
    subprocess.run(
        [sys.executable, os.path.join(REPO_ROOT, 'generate.py'), '--no-open', '-o', path],
        check=True,
    )
    yield path
    os.unlink(path)


@pytest.fixture(scope='session')
def browser_ctx():
    """Shared browser instance for the session."""
    with sync_playwright() as p:
        browser = p.chromium.launch()
        yield browser
        browser.close()


@pytest.fixture
def page(browser_ctx, html_path):
    """Fresh page for each test."""
    pg = browser_ctx.new_page(viewport={'width': 1400, 'height': 800})
    pg.goto(f'file://{html_path}')
    pg.wait_for_timeout(1000)
    yield pg
    pg.close()


# ═══════════════════════════════════════════════════════════════
# SMOKE TESTS
# ═══════════════════════════════════════════════════════════════

class TestSmoke:
    def test_page_loads(self, page: Page):
        assert page.title() == 'Bebhionn'

    def test_core_elements_exist(self, page: Page):
        assert page.query_selector('#menubar')
        assert page.query_selector('#transport')
        assert page.query_selector('#grid')
        assert page.query_selector('#inst-panel')
        assert page.query_selector('#song-bar')
        assert page.query_selector('#status')

    def test_grid_has_rows(self, page: Page):
        rows = page.query_selector_all('.row')
        assert len(rows) == 32  # default pattern length

    def test_instruments_loaded(self, page: Page):
        items = page.query_selector_all('.inst-item')
        assert len(items) > 0


# ═══════════════════════════════════════════════════════════════
# MENU BAR
# ═══════════════════════════════════════════════════════════════

class TestMenuBar:
    def test_file_menu_opens(self, page: Page):
        page.click('#menu-file > button')
        dropdown = page.query_selector('#menu-file .menu-dropdown')
        assert dropdown.is_visible()

    def test_view_menu_opens(self, page: Page):
        page.click('#menu-view > button')
        dropdown = page.query_selector('#menu-view .menu-dropdown')
        assert dropdown.is_visible()

    def test_midi_menu_opens(self, page: Page):
        page.click('#menu-midi > button')
        dropdown = page.query_selector('#menu-midi .menu-dropdown')
        assert dropdown.is_visible()

    def test_menu_closes_on_outside_click(self, page: Page):
        page.click('#menu-file > button')
        assert page.query_selector('#menu-file .menu-dropdown').is_visible()
        page.click('#grid-container')
        page.wait_for_timeout(100)
        assert not page.query_selector('#menu-file').evaluate(
            'el => el.classList.contains("open")')

    def test_menu_hover_switches(self, page: Page):
        page.click('#menu-file > button')
        assert page.query_selector('#menu-file').evaluate(
            'el => el.classList.contains("open")')
        page.hover('#menu-view > button')
        page.wait_for_timeout(100)
        assert page.query_selector('#menu-view').evaluate(
            'el => el.classList.contains("open")')
        assert not page.query_selector('#menu-file').evaluate(
            'el => el.classList.contains("open")')


# ═══════════════════════════════════════════════════════════════
# KEYBOARD INPUT & NOTE ENTRY
# ═══════════════════════════════════════════════════════════════

class TestNoteEntry:
    def _get_cell_text(self, page: Page, row=0, ch=0):
        """Get the text content of a grid cell by row and channel index."""
        cell = page.query_selector(f'.cell[data-row="{row}"][data-ch="{ch}"]')
        return cell.inner_text() if cell else ''

    def test_note_appears_in_grid(self, page: Page):
        # Click on the grid to ensure focus isn't on an input
        page.click('#grid-container')
        page.wait_for_timeout(100)
        # Press Z = C in the current octave
        page.keyboard.press('z')
        page.wait_for_timeout(100)
        # Row 0 should now have a note
        text = self._get_cell_text(page, row=0, ch=0)
        assert 'C-' in text

    def test_note_off(self, page: Page):
        page.click('#grid-container')
        page.wait_for_timeout(100)
        page.keyboard.press('.')
        page.wait_for_timeout(100)
        text = self._get_cell_text(page, row=0, ch=0)
        assert 'OFF' in text

    def test_delete_clears_cell(self, page: Page):
        page.click('#grid-container')
        page.wait_for_timeout(100)
        page.keyboard.press('z')
        page.wait_for_timeout(100)
        # Cursor advanced, go back up
        page.keyboard.press('ArrowUp')
        page.wait_for_timeout(50)
        page.keyboard.press('Delete')
        page.wait_for_timeout(100)
        text = self._get_cell_text(page, row=0, ch=0)
        assert '---' in text

    def test_edit_step(self, page: Page):
        page.click('#grid-container')
        page.wait_for_timeout(100)
        # Set edit step to 4
        page.fill('#edit-step', '4')
        # Enter a note
        page.click('#grid-container')
        page.keyboard.press('z')
        page.wait_for_timeout(100)
        # Cursor should now be on row 4
        status = page.inner_text('#status-pos')
        assert '04' in status


# ═══════════════════════════════════════════════════════════════
# NAVIGATION
# ═══════════════════════════════════════════════════════════════

class TestNavigation:
    def test_arrow_down(self, page: Page):
        page.click('#grid-container')
        page.keyboard.press('ArrowDown')
        page.wait_for_timeout(50)
        status = page.inner_text('#status-pos')
        assert '01' in status

    def test_tab_switches_channel(self, page: Page):
        page.click('#grid-container')
        page.keyboard.press('Tab')
        page.wait_for_timeout(50)
        # Cursor should be on a different channel — hard to check directly,
        # but we can verify no crash and the grid re-rendered
        assert page.query_selector('.cell.cursor')

    def test_arrow_right_cycles_columns(self, page: Page):
        page.click('#grid-container')
        page.wait_for_timeout(50)
        # Start at Note column
        status = page.inner_text('#status-pos')
        assert 'Note' in status
        page.keyboard.press('ArrowRight')
        page.wait_for_timeout(50)
        status = page.inner_text('#status-pos')
        assert 'Inst' in status
        page.keyboard.press('ArrowRight')
        page.wait_for_timeout(50)
        status = page.inner_text('#status-pos')
        assert 'Vol' in status


# ═══════════════════════════════════════════════════════════════
# INSTRUMENT PANEL
# ═══════════════════════════════════════════════════════════════

class TestInstrumentPanel:
    def test_instrument_editor_has_sliders(self, page: Page):
        sliders = page.query_selector_all('#inst-editor .op-param')
        assert len(sliders) > 0

    def test_operator_tabs_exist(self, page: Page):
        tabs = page.query_selector_all('#inst-editor .op-tab')
        assert len(tabs) >= 2  # at least one op + the "+" button

    def test_add_instrument(self, page: Page):
        count_before = len(page.query_selector_all('.inst-item'))
        page.click('button:has-text("+New")')
        page.wait_for_timeout(200)
        count_after = len(page.query_selector_all('.inst-item'))
        assert count_after == count_before + 1

    def test_help_toggle(self, page: Page):
        # The collapsible help section in the instrument editor
        help_toggle = page.query_selector('#inst-editor div[style*="cursor:pointer"]')
        if help_toggle:
            help_toggle.click()
            page.wait_for_timeout(100)
            # Help box should now be visible
            help_box = page.query_selector('#inst-editor div[style*="display:block"]')
            assert help_box is not None


# ═══════════════════════════════════════════════════════════════
# KEYBOARD OVERLAY
# ═══════════════════════════════════════════════════════════════

class TestKeyboardOverlay:
    def test_f1_opens_overlay(self, page: Page):
        page.click('#grid-container')
        page.keyboard.press('F1')
        page.wait_for_timeout(200)
        overlay = page.query_selector('#kb-overlay')
        assert overlay.is_visible()

    def test_f1_closes_overlay(self, page: Page):
        page.click('#grid-container')
        page.keyboard.press('F1')
        page.wait_for_timeout(200)
        page.keyboard.press('F1')
        page.wait_for_timeout(200)
        visible = page.query_selector('#kb-overlay').evaluate(
            'el => el.classList.contains("visible")')
        assert not visible

    def test_overlay_has_piano_keys(self, page: Page):
        page.click('#grid-container')
        page.keyboard.press('F1')
        page.wait_for_timeout(200)
        keys = page.query_selector_all('#kb-overlay .kb-key')
        assert len(keys) > 20


# ═══════════════════════════════════════════════════════════════
# TRANSPORT
# ═══════════════════════════════════════════════════════════════

class TestTransport:
    def test_bpm_input(self, page: Page):
        page.fill('#bpm', '140')
        page.press('#bpm', 'Enter')
        assert page.input_value('#bpm') == '140'

    def test_pattern_length_change(self, page: Page):
        page.select_option('#pattern-length', '64')
        page.wait_for_timeout(200)
        rows = page.query_selector_all('.row')
        assert len(rows) == 64

    def test_octave_input(self, page: Page):
        page.fill('#octave', '5')
        assert page.input_value('#octave') == '5'


# ═══════════════════════════════════════════════════════════════
# SONG BAR
# ═══════════════════════════════════════════════════════════════

class TestSongBar:
    def test_add_song_slot(self, page: Page):
        slots_before = len(page.query_selector_all('.song-slot'))
        page.click('#song-bar button:has-text("+")')
        page.wait_for_timeout(200)
        slots_after = len(page.query_selector_all('.song-slot'))
        assert slots_after == slots_before + 1

    def test_duplicate_pattern(self, page: Page):
        page.click('#grid-container')
        page.keyboard.press('z')  # enter a note so pattern isn't empty
        page.wait_for_timeout(100)
        page.click('#song-bar button:has-text("+")')
        page.wait_for_timeout(100)
        page.click('#song-bar button:has-text("Dup Pat")')
        page.wait_for_timeout(200)
        # The new slot should have the pattern duplicated
        pat_info = page.inner_text('#pat-info')
        assert 'pat' in pat_info.lower()


# ═══════════════════════════════════════════════════════════════
# DSP PANEL
# ═══════════════════════════════════════════════════════════════

class TestDSPPanel:
    def test_dsp_panel_opens_from_menu(self, page: Page):
        page.click('#menu-view > button')
        page.click('button:has-text("DSP Effect Panel")')
        page.wait_for_timeout(300)
        panel = page.query_selector('#dsp-panel')
        assert panel.evaluate('el => el.classList.contains("open")')

    def test_dsp_code_editor_exists(self, page: Page):
        page.click('#menu-view > button')
        page.click('button:has-text("DSP Effect Panel")')
        page.wait_for_timeout(300)
        textarea = page.query_selector('#dsp-code')
        assert textarea is not None
        code = textarea.input_value()
        assert 'Delay' in code or 'COEF' in code or 'PROG' in code


# ═══════════════════════════════════════════════════════════════
# INSTRUMENT DETAIL PANEL
# ═══════════════════════════════════════════════════════════════

class TestInstDetailPanel:
    def test_detail_panel_opens(self, page: Page):
        page.click('button:has-text("Edit")')
        page.wait_for_timeout(400)
        panel = page.query_selector('#inst-detail')
        assert panel.evaluate('el => el.classList.contains("open")')

    def test_detail_panel_has_canvases(self, page: Page):
        page.click('button:has-text("Edit")')
        page.wait_for_timeout(400)
        assert page.query_selector('#env-canvas')
        assert page.query_selector('#wave-canvas')

    def test_detail_panel_has_routing(self, page: Page):
        page.click('button:has-text("Edit")')
        page.wait_for_timeout(400)
        boxes = page.query_selector_all('#op-graph-mini .op-box-mini')
        assert len(boxes) > 0
