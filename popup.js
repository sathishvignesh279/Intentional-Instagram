/**
 * Intentional Instagram - Popup Controller
 * Manifest V3 - Local Settings & Live Session Synchronization
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const toggleHideNav = document.getElementById('toggle-hide-nav');
  const toggleFilterExplore = document.getElementById('toggle-filter-explore');
  const toggleLimitReels = document.getElementById('toggle-limit-reels');
  const toggleFeedLimits = document.getElementById('toggle-feed-limits');

  const limitsConfigPanel = document.getElementById('limits-config-panel');
  const inputPostLimit = document.getElementById('input-post-limit');
  const inputTimeLimit = document.getElementById('input-time-limit');
  const inputViewThreshold = document.getElementById('input-view-threshold');

  const sessionBadge = document.getElementById('session-badge');
  const sessionPostsDisplay = document.getElementById('session-posts-display');
  const sessionTimeDisplay = document.getElementById('session-time-display');
  const btnResetSession = document.getElementById('btn-reset-session');

  const blockedCountEl = document.getElementById('blocked-count');
  const btnResetStats = document.getElementById('btn-reset-stats');

  const defaultSettings = {
    hideReelsNav: true,
    filterExplore: true,
    limitReels: true,
    enableFeedLimits: true,
    feedPostLimit: 15,
    feedTimeLimit: 10,
    postViewThreshold: 1.5,
    blockedReelsCount: 0
  };

  const defaultSession = {
    elapsedSeconds: 0,
    viewedPostIds: [],
    isBlocked: false,
    blockReason: null,
    lastActiveTimestamp: Date.now()
  };

  let activeSettings = { ...defaultSettings };
  let activeSession = { ...defaultSession };

  // 1. Load initial values from chrome.storage.local
  chrome.storage.local.get(['ii_session', ...Object.keys(defaultSettings)], (items) => {
    activeSettings.hideReelsNav = items.hideReelsNav !== false;
    activeSettings.filterExplore = items.filterExplore !== false;
    activeSettings.limitReels = items.limitReels !== false;
    activeSettings.enableFeedLimits = items.enableFeedLimits !== false;
    activeSettings.feedPostLimit = Number(items.feedPostLimit) || 15;
    activeSettings.feedTimeLimit = Number(items.feedTimeLimit) || 10;
    activeSettings.postViewThreshold = Number(items.postViewThreshold) || 1.5;
    activeSettings.blockedReelsCount = Number(items.blockedReelsCount) || 0;

    if (items.ii_session) {
      activeSession = {
        ...defaultSession,
        ...items.ii_session,
        viewedPostIds: Array.isArray(items.ii_session.viewedPostIds) ? items.ii_session.viewedPostIds : []
      };
    }

    renderUI();
  });

  function renderUI() {
    toggleHideNav.checked = activeSettings.hideReelsNav;
    toggleFilterExplore.checked = activeSettings.filterExplore;
    toggleLimitReels.checked = activeSettings.limitReels;
    toggleFeedLimits.checked = activeSettings.enableFeedLimits;

    inputPostLimit.value = activeSettings.feedPostLimit;
    inputTimeLimit.value = activeSettings.feedTimeLimit;
    inputViewThreshold.value = activeSettings.postViewThreshold;

    limitsConfigPanel.style.display = activeSettings.enableFeedLimits ? 'flex' : 'none';

    // Render session status
    const postCount = activeSession.viewedPostIds.length;
    sessionPostsDisplay.textContent = `${postCount} / ${activeSettings.feedPostLimit}`;

    const elapsedMin = Math.floor(activeSession.elapsedSeconds / 60);
    const elapsedSec = activeSession.elapsedSeconds % 60;
    const formattedSec = elapsedSec < 10 ? `0${elapsedSec}` : elapsedSec;
    sessionTimeDisplay.textContent = `${elapsedMin}m ${formattedSec}s / ${activeSettings.feedTimeLimit}m`;

    if (activeSession.isBlocked) {
      sessionBadge.textContent = activeSession.blockReason === 'time' ? 'Time Limit' : 'Post Limit';
      sessionBadge.className = 'session-status-badge blocked';
    } else {
      sessionBadge.textContent = 'Active';
      sessionBadge.className = 'session-status-badge';
    }

    blockedCountEl.textContent = activeSettings.blockedReelsCount;
  }

  // 2. Settings Change Handlers
  toggleHideNav.addEventListener('change', () => {
    activeSettings.hideReelsNav = toggleHideNav.checked;
    chrome.storage.local.set({ hideReelsNav: activeSettings.hideReelsNav });
  });

  toggleFilterExplore.addEventListener('change', () => {
    activeSettings.filterExplore = toggleFilterExplore.checked;
    chrome.storage.local.set({ filterExplore: activeSettings.filterExplore });
  });

  toggleLimitReels.addEventListener('change', () => {
    activeSettings.limitReels = toggleLimitReels.checked;
    chrome.storage.local.set({ limitReels: activeSettings.limitReels });
  });

  toggleFeedLimits.addEventListener('change', () => {
    activeSettings.enableFeedLimits = toggleFeedLimits.checked;
    limitsConfigPanel.style.display = activeSettings.enableFeedLimits ? 'flex' : 'none';
    chrome.storage.local.set({ enableFeedLimits: activeSettings.enableFeedLimits });
  });

  inputPostLimit.addEventListener('change', () => {
    const val = Math.max(1, Math.min(200, parseInt(inputPostLimit.value, 10) || 15));
    inputPostLimit.value = val;
    activeSettings.feedPostLimit = val;
    chrome.storage.local.set({ feedPostLimit: val });
    renderUI();
  });

  inputTimeLimit.addEventListener('change', () => {
    const val = Math.max(1, Math.min(240, parseInt(inputTimeLimit.value, 10) || 10));
    inputTimeLimit.value = val;
    activeSettings.feedTimeLimit = val;
    chrome.storage.local.set({ feedTimeLimit: val });
    renderUI();
  });

  inputViewThreshold.addEventListener('change', () => {
    const val = Math.max(0.5, Math.min(10, parseFloat(inputViewThreshold.value) || 1.5));
    inputViewThreshold.value = val;
    activeSettings.postViewThreshold = val;
    chrome.storage.local.set({ postViewThreshold: val });
  });

  // 3. Reset Session Button
  btnResetSession.addEventListener('click', () => {
    activeSession = {
      elapsedSeconds: 0,
      viewedPostIds: [],
      isBlocked: false,
      blockReason: null,
      lastActiveTimestamp: Date.now()
    };
    chrome.storage.local.set({ ii_session: activeSession }, () => {
      renderUI();
    });
  });

  // 4. Reset All-time Blocked Reels Stats
  btnResetStats.addEventListener('click', () => {
    chrome.storage.local.set({ blockedReelsCount: 0 }, () => {
      activeSettings.blockedReelsCount = 0;
      blockedCountEl.textContent = '0';
    });
  });

  // 5. Live update when background or content script updates session/settings
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      let shouldRender = false;

      if (changes.ii_session && changes.ii_session.newValue) {
        activeSession = {
          ...activeSession,
          ...changes.ii_session.newValue,
          viewedPostIds: Array.isArray(changes.ii_session.newValue.viewedPostIds)
            ? changes.ii_session.newValue.viewedPostIds
            : activeSession.viewedPostIds
        };
        shouldRender = true;
      }

      if (changes.blockedReelsCount !== undefined) {
        activeSettings.blockedReelsCount = changes.blockedReelsCount.newValue || 0;
        shouldRender = true;
      }

      for (const key of Object.keys(activeSettings)) {
        if (changes[key] !== undefined) {
          activeSettings[key] = changes[key].newValue;
          shouldRender = true;
        }
      }

      if (shouldRender) {
        renderUI();
      }
    }
  });
});
