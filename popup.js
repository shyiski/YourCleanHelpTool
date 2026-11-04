/**
 * YourCleanHelpTool: Activity Cleaner
 * Popup Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initActions();
});

// ==========================================
// THEME MANAGER
// ==========================================

function initTheme() {
  const toggleBtn = document.getElementById('themeToggleBtn');

  chrome.storage.local.get(['theme'], (data) => {
    const isDark = (data.theme || 'dark') === 'dark';
    applyTheme(isDark);
  });

  toggleBtn.addEventListener('click', () => {
    const isDarkNow = document.body.classList.contains('dark-mode');
    const nextDark = !isDarkNow;
    chrome.storage.local.set({ theme: nextDark ? 'dark' : 'light' });
    applyTheme(nextDark);
  });
}

function applyTheme(isDark) {
  const toggleBtn = document.getElementById('themeToggleBtn');
  document.body.classList.toggle('dark-mode', isDark);
  if (toggleBtn) {
    toggleBtn.textContent = isDark ? '☀️' : '🌙';
  }
}

// ==========================================
// ACTION BUTTONS
// ==========================================

function initActions() {
  const actions = [
    { btnId: 'startLikesBtn', task: 'likes', targetUrl: 'https://www.instagram.com/your_activity/interactions/likes' },
    { btnId: 'startCommentsBtn', task: 'comments', targetUrl: 'https://www.instagram.com/your_activity/interactions/comments' },
    { btnId: 'startRepliesBtn', task: 'story_replies', targetUrl: 'https://www.instagram.com/your_activity/interactions/story_replies' }
  ];

  actions.forEach(({ btnId, task, targetUrl }) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.addEventListener('click', async () => {
      btn.disabled = true;

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab || !tab.url || !tab.url.includes('instagram.com')) {
          showNotice('Opening Instagram page...');
          await chrome.tabs.create({ url: targetUrl });
          window.close();
          return;
        }

        // Send start command to content script
        chrome.tabs.sendMessage(tab.id, { type: 'START_CLEANER', task: task }, (response) => {
          if (chrome.runtime.lastError) {
            showNotice('Please refresh the Instagram page (Cmd + R) first.');
            btn.disabled = false;
            return;
          }

          if (response && response.started) {
            showNotice('YourCleanHelpTool started!');
            setTimeout(() => window.close(), 600);
          } else {
            btn.disabled = false;
          }
        });
      } catch (err) {
        console.error('[YourCleanHelpTool] Error starting cleaner:', err);
        showNotice('Error starting. Please refresh page.');
        btn.disabled = false;
      }
    });
  });
}

function showNotice(msg) {
  const box = document.getElementById('noticeBox');
  if (!box) return;
  box.textContent = msg;
  box.style.display = 'block';
  setTimeout(() => {
    box.style.display = 'none';
  }, 4000);
}
