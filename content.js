/**
 * YourCleanHelpTool: Activity Cleaner
 * Content Engine
 */

(() => {
  // Prevent duplicate execution
  if (window.__YourCleanHelpToolLoaded) return;
  window.__YourCleanHelpToolLoaded = true;

  // ==========================================
  // ENGINE STATE
  // ==========================================
  let isTaskRunning = false;
  let activeTask = 'comments'; // 'comments' | 'likes' | 'story_replies'
  let sessionCleanedCount = 0;
  let taskStartTime = null;
  let elapsedTimerInterval = null;

  const BATCH_SIZE = 15;

  // ==========================================
  // MESSAGE LISTENER
  // ==========================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'START_CLEANER') {
      startCleaner(request.task || 'comments');
      sendResponse({ started: true });
    } else if (request.type === 'STOP_CLEANER') {
      stopCleaner();
      sendResponse({ stopped: true });
    }
  });

  // ==========================================
  // MAIN ENGINE RUNNER
  // ==========================================
  async function startCleaner(task) {
    if (isTaskRunning) return;

    activeTask = task;
    isTaskRunning = true;
    taskStartTime = taskStartTime || Date.now();

    await chrome.storage.local.set({
      isTaskRunning: true,
      activeTask: activeTask,
      sessionCleanedCount: sessionCleanedCount
    });

    renderOverlay();
    startElapsedTimer();

    console.log(`[YourCleanHelpTool] Started cleaning task: ${activeTask}`);

    try {
      if (activeTask === 'likes') {
        await runLikesLoop();
      } else {
        await runDeletionLoop();
      }
    } catch (err) {
      console.error('[YourCleanHelpTool] Error during task execution:', err);
      updateStatus('Error encountered. Please refresh page.');
      stopCleaner();
    }
  }

  function stopCleaner() {
    isTaskRunning = false;
    stopElapsedTimer();

    chrome.storage.local.set({
      isTaskRunning: false,
      autoResume: false
    });

    const overlay = document.getElementById('cleaner-overlay');
    if (overlay) {
      overlay.classList.remove('minimized');
    }

    const stopBtn = document.getElementById('cleaner-stop-btn');
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping...';
    }

    updateStatus('Finished.');
    setTimeout(() => {
      showSummaryScreen();
    }, 800);
  }

  // ==========================================
  // DELETION LOOP (COMMENTS & STORY REPLIES)
  // ==========================================
  async function runDeletionLoop() {
    const itemName = activeTask === 'story_replies' ? 'story replies' : 'comments';
    let consecutiveEmptyBatches = 0;

    while (isTaskRunning) {
      // 1. Check if error modal is present before starting batch
      const initialError = detectInstagramErrorModal();
      if (initialError) {
        await triggerErrorReloadAndResume(initialError);
        return;
      }

      updateStatus(`Searching for ${itemName}...`);

      // 2. Ensure selection mode is active
      let checkboxes = getCheckboxes(new Set());
      if (checkboxes.length === 0) {
        const selectTrigger = findSelectTrigger();
        if (selectTrigger) {
          await clickElement(selectTrigger);
          await sleep(1000);
        } else {
          window.scrollTo(0, 0);
          await sleep(1000);
        }
      }

      // 3. Select items in batch
      let selectedInBatch = 0;
      let scrollAttempts = 0;
      const alreadySelected = new Set();
      let noNewItemsAttempts = 0;

      while (selectedInBatch < BATCH_SIZE && isTaskRunning) {
        checkboxes = getCheckboxes(alreadySelected);

        if (checkboxes.length === 0) {
          noNewItemsAttempts++;
          if (noNewItemsAttempts >= 5 || scrollAttempts >= 10) break;
          updateStatus(`Loading more ${itemName}...`);
          await scrollPageDown();
          scrollAttempts++;
          continue;
        }

        noNewItemsAttempts = 0;
        const toSelect = Math.min(checkboxes.length, BATCH_SIZE - selectedInBatch);

        for (let i = 0; i < toSelect && isTaskRunning; i++) {
          const cb = checkboxes[i];
          alreadySelected.add(cb);
          await clickElement(cb);
          selectedInBatch++;
          updateProgress(selectedInBatch, BATCH_SIZE);
          updateStatus(`Selecting ${selectedInBatch}/${BATCH_SIZE}...`);
          await sleep(randomRange(160, 260));
        }

        if (selectedInBatch < BATCH_SIZE) {
          await scrollPageDown();
          scrollAttempts++;
        }
      }

      if (!isTaskRunning) return;

      // 4. If nothing was selected, check if complete
      if (selectedInBatch === 0) {
        const deleteBtnCheck = findActiveDeleteButton();
        if (!deleteBtnCheck) {
          consecutiveEmptyBatches++;
          if (consecutiveEmptyBatches >= 4) {
            console.log('[YourCleanHelpTool] No more items found. Completed!');
            stopCleaner();
            return;
          }
          await scrollPageDown();
          continue;
        }
      }

      consecutiveEmptyBatches = 0;
      updateStatus(`Deleting ${selectedInBatch} ${itemName}...`);
      await sleep(800);

      // 5. Find and click Delete button
      let deleteBtn = findActiveDeleteButton();
      for (let attempt = 0; attempt < 6 && !deleteBtn; attempt++) {
        await sleep(500);
        deleteBtn = findActiveDeleteButton();
      }

      if (!deleteBtn) {
        console.warn('[YourCleanHelpTool] Delete button not ready, retrying batch...');
        await sleep(1000);
        continue;
      }

      await clickElement(deleteBtn);
      await sleep(1500);

      // Check if error modal popped up right after delete
      let errorMsg = detectInstagramErrorModal();
      if (errorMsg) {
        await triggerErrorReloadAndResume(errorMsg);
        return;
      }

      // 6. Confirm deletion dialog
      let isConfirmed = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        errorMsg = detectInstagramErrorModal();
        if (errorMsg) {
          await triggerErrorReloadAndResume(errorMsg);
          return;
        }

        const confirmBtn = findConfirmationButton();
        if (confirmBtn) {
          console.log('[YourCleanHelpTool] Confirming delete in dialog...');
          confirmBtn.click();
          isConfirmed = true;
          break;
        }
        await sleep(500);
      }

      // 7. Poll for potential Instagram deletion failure modal
      if (isConfirmed) {
        for (let poll = 0; poll < 8; poll++) {
          await sleep(500);
          errorMsg = detectInstagramErrorModal();
          if (errorMsg) {
            await triggerErrorReloadAndResume(errorMsg);
            return;
          }
        }

        sessionCleanedCount += selectedInBatch;
        await chrome.storage.local.set({ sessionCleanedCount });
        chrome.runtime.sendMessage({ type: 'UPDATE_STATS', count: selectedInBatch, sessionCount: sessionCleanedCount });

        updateCountDisplay(sessionCleanedCount);
        updateStatus(`Deleted ${sessionCleanedCount} ${itemName} total`);
        await sleep(1500);
      }
    }
  }

  // ==========================================
  // UNLIKING LOOP (LIKES)
  // ==========================================
  async function runLikesLoop() {
    let consecutiveEmptyBatches = 0;

    while (isTaskRunning) {
      const initialError = detectInstagramErrorModal();
      if (initialError) {
        await triggerErrorReloadAndResume(initialError);
        return;
      }

      updateStatus('Searching for liked posts...');

      let checkboxes = getCheckboxes(new Set());
      if (checkboxes.length === 0) {
        const selectTrigger = findSelectTrigger();
        if (selectTrigger) {
          await clickElement(selectTrigger);
          await sleep(1000);
        } else {
          window.scrollTo(0, 0);
          await sleep(1000);
        }
      }

      let selectedInBatch = 0;
      let scrollAttempts = 0;
      const alreadySelected = new Set();
      let noNewItemsAttempts = 0;

      while (selectedInBatch < BATCH_SIZE && isTaskRunning) {
        checkboxes = getCheckboxes(alreadySelected);

        if (checkboxes.length === 0) {
          noNewItemsAttempts++;
          if (noNewItemsAttempts >= 5 || scrollAttempts >= 10) break;
          await scrollPageDown();
          scrollAttempts++;
          continue;
        }

        noNewItemsAttempts = 0;
        const toSelect = Math.min(checkboxes.length, BATCH_SIZE - selectedInBatch);

        for (let i = 0; i < toSelect && isTaskRunning; i++) {
          const cb = checkboxes[i];
          alreadySelected.add(cb);
          await clickElement(cb);
          selectedInBatch++;
          updateProgress(selectedInBatch, BATCH_SIZE);
          updateStatus(`Selecting ${selectedInBatch}/${BATCH_SIZE}...`);
          await sleep(randomRange(160, 260));
        }

        if (selectedInBatch < BATCH_SIZE) {
          await scrollPageDown();
          scrollAttempts++;
        }
      }

      if (!isTaskRunning) return;

      if (selectedInBatch === 0) {
        const unlikeBtnCheck = findActiveUnlikeButton();
        if (!unlikeBtnCheck) {
          consecutiveEmptyBatches++;
          if (consecutiveEmptyBatches >= 4) {
            console.log('[YourCleanHelpTool] No more liked posts found. Completed!');
            stopCleaner();
            return;
          }
          await scrollPageDown();
          continue;
        }
      }

      consecutiveEmptyBatches = 0;
      updateStatus(`Unliking ${selectedInBatch} posts...`);
      await sleep(800);

      const unlikeBtn = findActiveUnlikeButton();
      if (!unlikeBtn) {
        await sleep(1000);
        continue;
      }

      await clickElement(unlikeBtn);
      await sleep(1500);

      let isConfirmed = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        const errorMsg = detectInstagramErrorModal();
        if (errorMsg) {
          await triggerErrorReloadAndResume(errorMsg);
          return;
        }

        const confirmBtn = findConfirmationButton();
        if (confirmBtn) {
          confirmBtn.click();
          isConfirmed = true;
          break;
        }
        await sleep(500);
      }

      if (isConfirmed) {
        for (let poll = 0; poll < 8; poll++) {
          await sleep(500);
          const errorMsg = detectInstagramErrorModal();
          if (errorMsg) {
            await triggerErrorReloadAndResume(errorMsg);
            return;
          }
        }

        sessionCleanedCount += selectedInBatch;
        await chrome.storage.local.set({ sessionCleanedCount });
        chrome.runtime.sendMessage({ type: 'UPDATE_STATS', count: selectedInBatch, sessionCount: sessionCleanedCount });

        updateCountDisplay(sessionCleanedCount);
        updateStatus(`Unliked ${sessionCleanedCount} posts total`);
        await sleep(1500);
      }
    }
  }

  // ==========================================
  // DOM SELECTORS & DETECTORS
  // ==========================================
  function findSelectTrigger() {
    const candidates = Array.from(document.querySelectorAll('span, div, button'));
    // 1. Text search: "Выбрать" or "Select"
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (text === 'Выбрать' || text === 'Select') {
        return el.closest('div[style*="cursor: pointer"], div[role="button"], button') || el;
      }
    }
    // 2. Color search: Instagram signature blue
    for (const el of candidates) {
      const color = (el.style && el.style.color) || window.getComputedStyle(el).color || '';
      if (color.includes('74, 93, 249') || color.includes('0, 149, 246')) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.includes('выбрать') || text.includes('select')) {
          return el.closest('div[style*="cursor: pointer"], div[role="button"], button') || el;
        }
      }
    }
    return null;
  }

  function getCheckboxes(alreadySelected) {
    const items = [];
    const selectors = [
      'div[role="button"][aria-label*="флажок"]',
      'div[role="button"][aria-label*="checkbox"]',
      'div[role="button"][aria-label*="check"]',
      'div[aria-label="Переключить флажок"]',
      'div[aria-label="Toggle checkbox"]',
      '[role="checkbox"]'
    ];
    const nodes = document.querySelectorAll(selectors.join(', '));
    for (const node of nodes) {
      if (!alreadySelected.has(node)) {
        items.push(node);
      }
    }
    return items;
  }

  function findActiveDeleteButton() {
    const candidates = Array.from(document.querySelectorAll('div[role="button"], button, span'));
    for (const el of candidates) {
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase();
      if (aria === 'удалить' || aria === 'delete' || text === 'удалить' || text === 'delete') {
        const btn = el.closest('div[role="button"], button') || el;
        const style = window.getComputedStyle(btn);
        // Exclude disabled button (has pointer-events: none)
        if (style.pointerEvents !== 'none') {
          return btn;
        }
      }
    }
    return null;
  }

  function findActiveUnlikeButton() {
    const candidates = Array.from(document.querySelectorAll('div[role="button"], button, span'));
    for (const el of candidates) {
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase();
      if (aria === 'не нравится' || aria === 'unlike' || text === 'не нравится' || text === 'unlike') {
        const btn = el.closest('div[role="button"], button') || el;
        if (window.getComputedStyle(btn).pointerEvents !== 'none') {
          return btn;
        }
      }
    }
    return null;
  }

  function findConfirmationButton() {
    const dialogButtons = document.querySelectorAll('div[role="dialog"] button, div[role="dialog"] div[role="button"], div[role="presentation"] button, div._a9-v button, button._a9--');
    for (const btn of dialogButtons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();

      // STRICT SAFETY: Ignore OK / Dismiss / Cancel buttons
      if (text === 'ок' || text === 'ok' || text === 'закрыть' || text === 'close' || text === 'отмена' || text === 'cancel') {
        continue;
      }

      if (text === 'удалить' || text === 'delete' || text === 'не нравится' || text === 'unlike' ||
          aria === 'удалить' || aria === 'delete' || aria === 'unlike') {
        return btn;
      }
    }

    // Fallback: Red danger action button in modal
    for (const btn of dialogButtons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text === 'ок' || text === 'ok' || text === 'отмена' || text === 'cancel') continue;
      const color = window.getComputedStyle(btn).color || '';
      if (color.startsWith('rgb(') && parseInt(color.split('(')[1]) > 200) {
        return btn;
      }
    }
    return null;
  }

  function detectInstagramErrorModal() {
    const targets = document.querySelectorAll('div._a9-v, div._a9-y, div.xs83m0k, div[role="dialog"], div[role="presentation"], h3');
    for (const el of targets) {
      if (el.id === 'cleaner-overlay' || el.closest('#cleaner-overlay')) continue;
      const text = (el.textContent || '').toLowerCase();
      if (text.includes('произошла ошибка') ||
          text.includes('ошибка при удалении') ||
          text.includes('повторите попытку') ||
          text.includes('ошибка') ||
          text.includes('не удалось') ||
          text.includes('попробуйте позже') ||
          text.includes('something went wrong') ||
          text.includes('an error occurred') ||
          text.includes('couldn\'t delete') ||
          text.includes('try again') ||
          text.includes('действие заблокировано') ||
          text.includes('action blocked')) {
        return el.textContent.trim().slice(0, 90);
      }
    }
    return null;
  }

  async function triggerErrorReloadAndResume(errorMsg) {
    console.warn('[YourCleanHelpTool] Instagram error detected:', errorMsg);
    updateStatus(`⚠️ ${errorMsg}. Reloading & continuing in 3s...`);

    await chrome.storage.local.set({
      autoResume: true,
      activeTask: activeTask,
      sessionCleanedCount: sessionCleanedCount,
      taskStartTime: taskStartTime || Date.now(),
      isTaskRunning: true
    });

    await sleep(3000);
    window.location.reload();
  }

  // ==========================================
  // UI & OVERLAY BUILDER
  // ==========================================
  function renderOverlay() {
    let overlay = document.getElementById('cleaner-overlay');
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = 'cleaner-overlay';
    overlay.innerHTML = `
      <div class="cleaner-backdrop"></div>
      <div class="cleaner-modal" id="cleaner-modal">
        <!-- Minimized Floating Widget -->
        <div class="cleaner-mini-widget" id="cleaner-mini-widget" title="Expand YourCleanHelpTool">
          <div class="mini-widget-top">
            <div class="mini-widget-total" id="mini-total-box" title="Total Cleaned">
              <span class="mini-widget-dot"></span>
              <span class="mini-widget-total-val" id="mini-total-val">${sessionCleanedCount.toLocaleString()}</span>
            </div>
            <span class="mini-widget-timer" id="mini-timer">00:00</span>
          </div>
          <div class="mini-widget-center">
            <div class="mini-widget-count" id="mini-count">0</div>
            <div class="mini-widget-label" id="mini-sub">SELECTED</div>
          </div>
          <button class="mini-widget-stop-btn" id="mini-stop-btn" title="Stop Cleaning">
            <span>⏹</span> Stop
          </button>
        </div>

        <!-- Full Modal Header -->
        <div class="cleaner-header">
          <div class="cleaner-brand">
            <img src="${chrome.runtime.getURL('logo.png')}" class="cleaner-logo-img" alt="YourCleanHelpTool">
            <span class="cleaner-brand-name">YourCleanHelpTool</span>
            <span class="cleaner-active-indicator"></span>
          </div>
          <button class="cleaner-minimize-btn" id="cleaner-min-btn" title="Minimize">⎯</button>
        </div>

        <!-- Full Modal Content -->
        <div class="cleaner-body">
          <div class="cleaner-animation-box">
            <div class="cleaner-circle-wrap">
              <svg viewBox="0 0 100 100" class="cleaner-ring-svg">
                <circle cx="50" cy="50" r="45" class="ring-bg"/>
                <circle cx="50" cy="50" r="45" class="ring-fg" id="cleaner-ring"/>
              </svg>
              <div class="cleaner-center-icon">
                <img src="${chrome.runtime.getURL('broom-icon.png')}" alt="YourCleanHelpTool">
              </div>
            </div>
          </div>

          <h2 class="cleaner-title">Cleaning...</h2>
          <div class="cleaner-elapsed-time" id="cleaner-elapsed">00:00</div>

          <div class="cleaner-counter-box">
            <span class="cleaner-number" id="cleaner-total-num">0</span>
            <span class="cleaner-label">${activeTask === 'likes' ? 'Likes Removed' : activeTask === 'story_replies' ? 'Story Replies Deleted' : 'Comments Deleted'}</span>
          </div>

          <div class="cleaner-progress-bar">
            <div class="cleaner-progress-fill" id="cleaner-progress-fill"></div>
          </div>
          <div class="cleaner-progress-info">
            <span id="cleaner-progress-text">Selecting 0/${BATCH_SIZE}</span>
            <span id="cleaner-batch-num">Batch 1</span>
          </div>

          <div class="cleaner-status-line" id="cleaner-status">
            <span class="status-pulse-dot"></span>
            <span class="status-msg">Initializing...</span>
          </div>

          <button class="cleaner-stop-button" id="cleaner-stop-btn">
            <span>⏹</span> Stop Cleaning
          </button>

          <div class="cleaner-warning-tip">
            <span>⚠️</span> Do not close this tab during the process.
          </div>
        </div>
      </div>
    `;

    // Inject Styles
    const style = document.createElement('style');
    style.id = 'cleaner-styles';
    style.textContent = `
      #cleaner-overlay {
        position: fixed;
        inset: 0;
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      .cleaner-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(10, 14, 20, 0.75);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
      }

      .cleaner-modal {
        position: relative;
        background: #11141C;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 24px;
        width: 390px;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
        overflow: hidden;
        color: #F0F4F8;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .cleaner-header {
        background: linear-gradient(135deg, #1C0A24 0%, #15091D 50%, #11141C 100%);
        padding: 16px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }

      .cleaner-brand {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .cleaner-logo-img {
        width: 30px;
        height: 30px;
        object-fit: contain;
      }

      .cleaner-brand-name {
        font-weight: 700;
        font-size: 1.05rem;
        background: linear-gradient(135deg, #833AB4, #E1306C, #FD1D1D);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .cleaner-active-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #34C759;
        box-shadow: 0 0 8px #34C759;
      }

      .cleaner-minimize-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #F0F4F8;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 700;
        transition: all 0.2s;
      }

      .cleaner-minimize-btn:hover {
        background: rgba(255, 255, 255, 0.22);
        transform: scale(1.08);
      }

      .cleaner-body {
        padding: 26px 24px;
        text-align: center;
      }

      .cleaner-animation-box {
        margin-bottom: 16px;
      }

      .cleaner-circle-wrap {
        position: relative;
        width: 110px;
        height: 110px;
        margin: 0 auto;
      }

      .cleaner-ring-svg {
        position: absolute;
        inset: 0;
        transform: rotate(-90deg);
      }

      .ring-bg {
        fill: none;
        stroke: rgba(255, 255, 255, 0.08);
        stroke-width: 6;
      }

      .ring-fg {
        fill: none;
        stroke: #E1306C;
        stroke-width: 6;
        stroke-linecap: round;
        stroke-dasharray: 283;
        stroke-dashoffset: 283;
        transition: stroke-dashoffset 0.3s;
      }

      .cleaner-center-icon {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 54px;
        height: 54px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .cleaner-center-icon img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        filter: drop-shadow(0 4px 10px rgba(225, 48, 108, 0.4));
      }

      .cleaner-title {
        font-size: 1.35rem;
        font-weight: 700;
        margin-bottom: 2px;
      }

      .cleaner-elapsed-time {
        font-size: 0.78rem;
        color: rgba(240, 244, 248, 0.55);
        margin-bottom: 16px;
        font-variant-numeric: tabular-nums;
      }

      .cleaner-counter-box {
        margin-bottom: 18px;
      }

      .cleaner-number {
        font-size: 2.8rem;
        font-weight: 800;
        line-height: 1;
        background: linear-gradient(135deg, #FFDC80 0%, #FD1D1D 50%, #E1306C 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .cleaner-label {
        display: block;
        font-size: 0.8rem;
        color: rgba(240, 244, 248, 0.65);
        margin-top: 4px;
      }

      .cleaner-progress-bar {
        height: 7px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 100px;
        overflow: hidden;
        margin-bottom: 6px;
      }

      .cleaner-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #833AB4, #E1306C, #FD1D1D);
        border-radius: 100px;
        width: 0%;
        transition: width 0.25s;
      }

      .cleaner-progress-info {
        display: flex;
        justify-content: space-between;
        font-size: 0.72rem;
        color: rgba(240, 244, 248, 0.5);
        margin-bottom: 16px;
      }

      .cleaner-status-line {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        font-size: 0.85rem;
        color: #34C759;
        font-weight: 500;
        margin-bottom: 20px;
      }

      .status-pulse-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #34C759;
        box-shadow: 0 0 6px #34C759;
        flex-shrink: 0;
      }

      .cleaner-stop-button {
        width: 100%;
        padding: 12px;
        border-radius: 12px;
        border: 2px solid #E1306C;
        background: transparent;
        color: #E1306C;
        font-size: 0.9rem;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all 0.2s;
      }

      .cleaner-stop-button:hover {
        background: #E1306C;
        color: #FFFFFF;
        box-shadow: 0 6px 20px rgba(225, 48, 108, 0.4);
      }

      .cleaner-warning-tip {
        margin-top: 14px;
        font-size: 0.74rem;
        color: rgba(240, 244, 248, 0.5);
      }

      /* =====================================
         MINIMIZED FLOATING CORNER WIDGET
         ===================================== */
      .cleaner-mini-widget {
        display: none;
      }

      #cleaner-overlay.minimized {
        position: fixed !important;
        inset: auto 24px 24px auto !important;
        width: auto !important;
        height: auto !important;
        pointer-events: none !important;
        z-index: 9999999 !important;
      }

      #cleaner-overlay.minimized .cleaner-backdrop,
      #cleaner-overlay.minimized .cleaner-header,
      #cleaner-overlay.minimized .cleaner-body {
        display: none !important;
      }

      #cleaner-overlay.minimized .cleaner-modal {
        pointer-events: auto !important;
        width: 104px !important;
        height: 104px !important;
        min-width: 104px !important;
        max-width: 104px !important;
        min-height: 104px !important;
        max-height: 104px !important;
        border-radius: 22px !important;
        padding: 8px 10px !important;
        box-sizing: border-box !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        background: #11141C !important;
        border: 2px solid #E1306C !important;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 16px rgba(225, 48, 108, 0.4) !important;
      }

      #cleaner-overlay.minimized .cleaner-modal:hover {
        transform: scale(1.06) !important;
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.7), 0 0 24px rgba(225, 48, 108, 0.6) !important;
      }

      #cleaner-overlay.minimized .cleaner-mini-widget {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: space-between !important;
        width: 100% !important;
        height: 100% !important;
        box-sizing: border-box !important;
      }

      .mini-widget-top {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        width: 100% !important;
        padding: 0 1px !important;
        box-sizing: border-box !important;
      }

      .mini-widget-total {
        display: inline-flex !important;
        align-items: center !important;
        gap: 4px !important;
      }

      .mini-widget-dot {
        width: 7px !important;
        height: 7px !important;
        border-radius: 50% !important;
        background: #34C759 !important;
        box-shadow: 0 0 6px #34C759, 0 0 10px rgba(52, 199, 89, 0.6) !important;
        flex-shrink: 0 !important;
      }

      .mini-widget-total-val {
        font-size: 11px !important;
        font-weight: 700 !important;
        color: #34C759 !important;
        font-variant-numeric: tabular-nums !important;
        line-height: 1 !important;
        text-shadow: 0 0 8px rgba(52, 199, 89, 0.4) !important;
      }

      .mini-widget-timer {
        font-size: 11px !important;
        font-weight: 700 !important;
        color: rgba(240, 244, 248, 0.85) !important;
        font-variant-numeric: tabular-nums !important;
        letter-spacing: 0.5px !important;
        line-height: 1 !important;
      }

      .mini-widget-center {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        line-height: 1 !important;
        margin: 1px 0 !important;
      }

      .mini-widget-count {
        font-size: 21px !important;
        font-weight: 800 !important;
        color: #E1306C !important;
        line-height: 1.1 !important;
        font-variant-numeric: tabular-nums !important;
      }

      .mini-widget-label {
        font-size: 9px !important;
        font-weight: 700 !important;
        color: rgba(240, 244, 248, 0.5) !important;
        text-transform: uppercase !important;
        letter-spacing: 0.8px !important;
      }

      .mini-widget-stop-btn {
        background: rgba(255, 71, 87, 0.18) !important;
        border: 1px solid rgba(255, 71, 87, 0.45) !important;
        color: #ff6b81 !important;
        border-radius: 8px !important;
        padding: 4px 0 !important;
        width: 100% !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 4px !important;
        transition: all 0.2s ease !important;
        font-family: inherit !important;
        box-sizing: border-box !important;
      }

      .mini-widget-stop-btn:hover {
        background: #ff4757 !important;
        border-color: #ff4757 !important;
        color: #FFFFFF !important;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(overlay);

    // Event listeners
    document.getElementById('cleaner-stop-btn').addEventListener('click', stopCleaner);

    const miniStopBtn = document.getElementById('mini-stop-btn');
    if (miniStopBtn) {
      miniStopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        stopCleaner();
      });
    }

    const minBtn = document.getElementById('cleaner-min-btn');
    if (minBtn) {
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        overlay.classList.add('minimized');
      });
    }

    const miniWidget = document.getElementById('cleaner-mini-widget');
    if (miniWidget) {
      miniWidget.addEventListener('click', (e) => {
        if (e.target.closest('#mini-stop-btn')) return;
        e.stopPropagation();
        overlay.classList.remove('minimized');
      });
    }
  }

  function showSummaryScreen() {
    const modal = document.getElementById('cleaner-modal');
    if (!modal) return;

    modal.innerHTML = `
      <div class="cleaner-header" style="background: linear-gradient(135deg, #34C759, #2ECC71); justify-content: center;">
        <span style="font-weight: 700; font-size: 1.1rem; color: #fff;">Cleaning Completed!</span>
      </div>
      <div class="cleaner-body" style="padding: 24px;">
        <div style="font-size: 42px; margin-bottom: 12px;">🎉</div>
        <div style="font-size: 2.4rem; font-weight: 800; color: #34C759; margin-bottom: 4px;">${sessionCleanedCount}</div>
        <div style="font-size: 0.85rem; color: rgba(240, 244, 248, 0.7); margin-bottom: 24px;">Total items cleaned in this session</div>
        <button id="cleaner-close-summary-btn" style="width: 100%; padding: 12px; border-radius: 12px; border: none; background: #34C759; color: #fff; font-weight: 700; font-size: 0.95rem; cursor: pointer;">
          Close
        </button>
      </div>
    `;

    const closeBtn = document.getElementById('cleaner-close-summary-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        const overlay = document.getElementById('cleaner-overlay');
        const style = document.getElementById('cleaner-styles');
        if (overlay) overlay.remove();
        if (style) style.remove();
      });
    }
  }

  // ==========================================
  // TIMERS & PROGRESS UPDATERS
  // ==========================================
  function startElapsedTimer() {
    if (elapsedTimerInterval) clearInterval(elapsedTimerInterval);
    elapsedTimerInterval = setInterval(() => {
      const elapsed = Date.now() - (taskStartTime || Date.now());
      const mins = Math.floor(elapsed / 60000);
      const secs = Math.floor((elapsed % 60000) / 1000);
      const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

      const el = document.getElementById('cleaner-elapsed');
      if (el) el.textContent = timeStr;

      const miniTimer = document.getElementById('mini-timer');
      if (miniTimer) miniTimer.textContent = timeStr;
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimerInterval) {
      clearInterval(elapsedTimerInterval);
      elapsedTimerInterval = null;
    }
  }

  function updateCountDisplay(count) {
    const el = document.getElementById('cleaner-total-num');
    if (el) el.textContent = count.toLocaleString();

    const totalVal = document.getElementById('mini-total-val');
    if (totalVal) totalVal.textContent = count.toLocaleString();

    const miniEl = document.getElementById('mini-count');
    if (miniEl) miniEl.textContent = count.toLocaleString();

    const miniSub = document.getElementById('mini-sub');
    if (miniSub) miniSub.textContent = 'CLEANED';
  }

  function updateStatus(msg) {
    const el = document.getElementById('cleaner-status');
    if (el) {
      const span = el.querySelector('.status-msg');
      if (span) span.textContent = msg;
    }
  }

  function updateProgress(current, total) {
    const fill = document.getElementById('cleaner-progress-fill');
    if (fill) fill.style.width = `${(current / total) * 100}%`;

    const text = document.getElementById('cleaner-progress-text');
    if (text) text.textContent = `Selecting ${current}/${total}`;

    const ring = document.getElementById('cleaner-ring');
    if (ring) {
      const circumference = 283;
      ring.style.strokeDashoffset = circumference - (current / total) * circumference;
    }

    const miniEl = document.getElementById('mini-count');
    if (miniEl) miniEl.textContent = `${current}/${total}`;

    const miniSub = document.getElementById('mini-sub');
    if (miniSub) miniSub.textContent = 'SELECTED';
  }

  // ==========================================
  // HELPERS
  // ==========================================
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function clickElement(el) {
    if (!el) return;
    const target = el.closest('button, div[role="button"]') || el;
    target.click();
  }

  async function scrollPageDown() {
    window.scrollBy({ top: 900, behavior: 'smooth' });
    await sleep(1400);
  }

  // ==========================================
  // AUTO-RESUME
  // ==========================================
  async function checkAutoResume() {
    try {
      const data = await new Promise(resolve => {
        chrome.storage.local.get(['autoResume', 'activeTask', 'sessionCleanedCount', 'taskStartTime'], resolve);
      });

      if (data.autoResume && data.activeTask) {
        console.log('[YourCleanHelpTool] Resuming task after reload:', data.activeTask);
        await chrome.storage.local.set({ autoResume: false });

        activeTask = data.activeTask;
        sessionCleanedCount = data.sessionCleanedCount || 0;
        taskStartTime = data.taskStartTime || Date.now();

        renderOverlay();
        updateCountDisplay(sessionCleanedCount);
        updateStatus('Resuming after reload...');

        setTimeout(() => {
          startCleaner(activeTask);
        }, 2500);
      }
    } catch (e) {
      console.error('[YourCleanHelpTool] Auto-resume check failed:', e);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(checkAutoResume, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(checkAutoResume, 1500));
  }

})();
