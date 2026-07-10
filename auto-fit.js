// Auto-fit SVG viewer - runs in page context to bypass content script isolation
// Clicks RESET, then fits the document to a comfortable viewing level (0.90 multiplier).
(function() {
  try {
    console.log('[Duke] auto-fit.js: Starting');
    const iframe = document.getElementById('svgedit');
    console.log('[Duke] auto-fit.js: iframe found:', !!iframe);
    if (!iframe) {
      console.log('[Duke] auto-fit.js: ERROR - iframe not found');
      return;
    }

    const iw = iframe.contentWindow;
    console.log('[Duke] auto-fit.js: svgEditor available:', !!iw?.svgEditor);
    console.log('[Duke] auto-fit.js: panzoom available:', !!iw?.panzoom);

    if (!iw || !iw.svgEditor || !iw.panzoom) {
      console.log('[Duke] auto-fit.js: ✗ Components NOT available');
      return;
    }

    console.log('[Duke] auto-fit.js: Calling svgEditor.ready()');
    iw.svgEditor.ready(function() {
      // STEP 1: Click RESET button to ensure clean state
      console.log('[Duke] auto-fit.js: ══════════════════════════════════════════════════════════');
      console.log('[Duke] auto-fit.js: STEP 1: CLICKING RESET BUTTON');
      console.log('[Duke] auto-fit.js: ══════════════════════════════════════════════════════════');

      try {
        const resetBtn = iframe.contentDocument?.getElementById('svg-pan-zoom-reset-pan-zoom');
        if (resetBtn) {
          // SVG elements have no .click() — dispatch a MouseEvent instead
          const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe.contentWindow });
          resetBtn.dispatchEvent(clickEvent);
          console.log('[Duke] auto-fit.js: ✓ RESET button clicked - document reset to default state');
        } else {
          console.log('[Duke] auto-fit.js: ⚠ RESET button not found, continuing anyway');
        }
      } catch (e) {
        console.error('[Duke] auto-fit.js: Error clicking RESET:', e);
      }

      // STEP 2: Auto-fit to comfortable viewing level (0.90 multiplier)
      console.log('[Duke] auto-fit.js: ══════════════════════════════════════════════════════════');
      console.log('[Duke] auto-fit.js: STEP 2: AUTO-FIT TO COMFORTABLE VIEWING LEVEL');
      console.log('[Duke] auto-fit.js: ══════════════════════════════════════════════════════════');

      const iRect = iframe.getBoundingClientRect();
      const visibleW = Math.min(iRect.right, window.innerWidth) - Math.max(iRect.left, 0);
      const visibleH = Math.min(iRect.bottom, window.innerHeight) - Math.max(iRect.top, 0);

      const viewportG = iw.document.querySelector('.svg-pan-zoom_viewport');
      if (!viewportG) {
        console.log('[Duke] auto-fit.js: ✗ viewport group not found');
        return;
      }

      const bbox = viewportG.getBBox();
      const currentZoom = iw.panzoom.getZoom();

      // Calculate target zoom with 0.90 multiplier (scales dynamically for any doc size)
      const targetZoom = Math.min(
        visibleW / (bbox.width * currentZoom),
        visibleH / (bbox.height * currentZoom)
      ) * 0.90 * currentZoom;

      console.log('[Duke] auto-fit.js: visible viewport=' + visibleW.toFixed(0) + 'x' + visibleH.toFixed(0));
      console.log('[Duke] auto-fit.js: current zoom=' + currentZoom.toFixed(4) + ', target zoom=' + targetZoom.toFixed(4));

      // Calculate pan to center content (bbox may be offset from origin)
      const panX = visibleW / 2 - (bbox.x + bbox.width / 2) * targetZoom;
      const panY = visibleH / 2 - (bbox.y + bbox.height / 2) * targetZoom;

      // Apply zoom first, then pan via panBy (pan() has a bug in this version)
      iw.panzoom.zoom(targetZoom);
      const afterZoomPan = iw.panzoom.getPan();
      iw.panzoom.panBy({ x: panX - afterZoomPan.x, y: panY - afterZoomPan.y });

      const zoomAfter = iw.panzoom.getZoom();
      console.log('[Duke] auto-fit.js: ══════════════════════════════════════════════════════════');
      console.log('[Duke] auto-fit.js: ✓ AUTO-FIT COMPLETE! zoom ' + currentZoom.toFixed(4) + ' → ' + zoomAfter.toFixed(4));
      console.log('[Duke] auto-fit.js: Document is now positioned at comfortable viewing level');
      console.log('[Duke] auto-fit.js: ══════════════════════════════════════════════════════════');
    });
  } catch (e) {
    console.error('[Duke] auto-fit.js: ✗ Error:', e);
  }
})();
