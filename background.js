/**
 * YourCleanHelpTool: Activity Cleaner
 * Background Service Worker
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    theme: 'dark',
    totalCleanedEver: 0,
    sessionCleanedCount: 0,
    isTaskRunning: false,
    activeTask: null
  });
  console.log('[YourCleanHelpTool] Extension installed and initialized.');
});

// Relay messages between content script and storage
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'UPDATE_STATS') {
    chrome.storage.local.get(['totalCleanedEver'], (data) => {
      const updatedTotal = (data.totalCleanedEver || 0) + (request.count || 0);
      chrome.storage.local.set({
        totalCleanedEver: updatedTotal,
        sessionCleanedCount: request.sessionCount || 0
      });
      sendResponse({ success: true, total: updatedTotal });
    });
    return true;
  }
});
