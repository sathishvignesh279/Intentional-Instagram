/**
 * Intentional Instagram - Content Script
 * Manifest V3 - Vanilla JavaScript
 *
 * Implements:
 * 1. Hide Reels navigation button from desktop sidebar & navigation areas.
 * 2. Filter Search and Explore recommendations safely.
 * 3. Allow one Reel, block the next with a full-viewport black blocking screen.
 * 4. Handle direct navigation to /reels/ and internal SPA route changes.
 * 5. Dynamic page handling with scoped observers and zero memory leaks.
 * 6. Local privacy: No data collection, remote code, or cookie access.
 * 7. Home Feed Time Limit & Unique Post Counter with viewing dwell threshold.
 * 8. Persistent session state across page refreshes and tab reloads.
 * 9. Isolation: Direct Messages, Profile pages, and Search remain accessible.
 */

(function () {
  'use strict';

  // Prevent multiple initializations in the same frame
  if (window.__INTENTIONAL_INSTAGRAM_INITIALIZED__) {
    return;
  }
  window.__INTENTIONAL_INSTAGRAM_INITIALIZED__ = true;

  /* ==========================================================================
     Configuration & State Defaults
     ========================================================================== */

  const DEFAULT_SETTINGS = {
    hideReelsNav: true,
    filterExplore: true,
    limitReels: true,
    enableFeedLimits: true,
    feedPostLimit: 15,          // Max unique posts per session
    feedTimeLimit: 10,          // Max active session minutes
    postViewThreshold: 1.5,     // Seconds a post must remain visible to be counted
    blockedReelsCount: 0
  };

  const DEFAULT_SESSION = {
    elapsedSeconds: 0,
    viewedPostIds: [],          // Deduplicated array of post shortcodes/IDs
    isBlocked: false,           // True if home feed limit reached
    blockReason: null,          // 'time' | 'posts'
    lastActiveTimestamp: Date.now()
  };

  const SESSION_INACTIVITY_TIMEOUT_MS = 45 * 60 * 1000; // 45 min inactivity resets session

  // Active runtime state
  const settings = { ...DEFAULT_SETTINGS };
  let currentSession = { ...DEFAULT_SESSION };

  let currentPath = window.location.pathname;
  let allowedReelCode = null; // Shortcode of the single allowed reel
  let isReelBlockActive = false; // True when full-viewport reel blocking screen is shown
  let videoSuppressInterval = null;
  let sessionTimerInterval = null;

  // DOM Elements cache
  let blockingOverlayEl = null;      // Reels full-viewport overlay
  let feedBlockingOverlayEl = null;  // Home feed persistent overlay
  let explorePlaceholderEl = null;   // Calm explore banner

  /* ==========================================================================
     Storage & Session Initialization
     ========================================================================== */

  function initSettingsAndSession() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      applyAllFeatures();
      return;
    }

    chrome.storage.local.get(['ii_settings', 'ii_session', ...Object.keys(DEFAULT_SETTINGS)], (stored) => {
      if (chrome.runtime.lastError) {
        console.warn('[Intentional IG] Storage read error:', chrome.runtime.lastError);
      } else if (stored) {
        // Support both bundled 'ii_settings' and individual keys for backwards compatibility
        const storedSettings = stored.ii_settings || {};
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (storedSettings[key] !== undefined) {
            settings[key] = storedSettings[key];
          } else if (stored[key] !== undefined) {
            settings[key] = stored[key];
          }
        }

        // Load or initialize persistent session
        if (stored.ii_session) {
          const loadedSession = stored.ii_session;
          const now = Date.now();
          // Reset if user has been away longer than inactivity timeout
          if (loadedSession.lastActiveTimestamp && (now - loadedSession.lastActiveTimestamp > SESSION_INACTIVITY_TIMEOUT_MS)) {
            currentSession = {
              elapsedSeconds: 0,
              viewedPostIds: [],
              isBlocked: false,
              blockReason: null,
              lastActiveTimestamp: now
            };
            persistSession();
          } else {
            currentSession = {
              elapsedSeconds: loadedSession.elapsedSeconds || 0,
              viewedPostIds: Array.isArray(loadedSession.viewedPostIds) ? loadedSession.viewedPostIds : [],
              isBlocked: Boolean(loadedSession.isBlocked),
              blockReason: loadedSession.blockReason || null,
              lastActiveTimestamp: now
            };
          }
        } else {
          currentSession = { ...DEFAULT_SESSION, lastActiveTimestamp: Date.now() };
          persistSession();
        }
      }

      startSessionTimer();
      applyAllFeatures();
    });

    // Real-time synchronization from popup controls
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        let settingsChanged = false;
        let sessionChanged = false;

        if (changes.ii_settings && changes.ii_settings.newValue) {
          Object.assign(settings, changes.ii_settings.newValue);
          settingsChanged = true;
        }

        for (const [key, change] of Object.entries(changes)) {
          if (key in settings) {
            settings[key] = change.newValue;
            settingsChanged = true;
          }
        }

        if (changes.ii_session && changes.ii_session.newValue) {
          currentSession = {
            ...currentSession,
            ...changes.ii_session.newValue,
            viewedPostIds: Array.isArray(changes.ii_session.newValue.viewedPostIds)
              ? changes.ii_session.newValue.viewedPostIds
              : currentSession.viewedPostIds
          };
          sessionChanged = true;
        }

        if (settingsChanged || sessionChanged) {
          applyAllFeatures();
        }
      }
    });
  }

  /**
   * Persists the current session state to chrome.storage.local
   */
  function persistSession() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      currentSession.lastActiveTimestamp = Date.now();
      chrome.storage.local.set({ ii_session: currentSession }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Intentional IG] Session persist error:', chrome.runtime.lastError);
        }
      });
    }
  }

  /* ==========================================================================
     Session Timer (Feature 2 & 5)
     ========================================================================== */

  function startSessionTimer() {
    if (sessionTimerInterval) return;

    sessionTimerInterval = setInterval(() => {
      // Accumulate time only when the tab is actively visible to the user
      if (document.visibilityState === 'visible') {
        currentSession.elapsedSeconds += 1;
        currentSession.lastActiveTimestamp = Date.now();

        // Check if session time limit has been reached
        if (
          settings.enableFeedLimits &&
          !currentSession.isBlocked &&
          currentSession.elapsedSeconds >= settings.feedTimeLimit * 60
        ) {
          triggerFeedBlock('time');
        }

        // Persist periodically every 5 seconds to minimize storage writes
        if (currentSession.elapsedSeconds % 5 === 0) {
          persistSession();
        }
      }
    }, 1000);
  }

  // Ensure state is safely persisted when user switches tabs or closes page
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persistSession();
    }
  });

  window.addEventListener('beforeunload', () => {
    persistSession();
  });

  /* ==========================================================================
     URL Parsing & Route Helpers
     ========================================================================== */

  function isHomeFeed(pathname) {
    return pathname === '/' || pathname === '';
  }

  function getReelShortcode(pathname) {
    const match = pathname.match(/^\/(?:reel|reels)\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  }

  function isDedicatedReelsFeed(pathname) {
    return /^\/reels\/?$/.test(pathname) || /^\/reels\/videos\/?$/.test(pathname);
  }

  function isIndividualReel(pathname) {
    return Boolean(getReelShortcode(pathname));
  }

  function isExplorePage(pathname) {
    return pathname === '/explore' || pathname === '/explore/';
  }

  /* ==========================================================================
     Feature 1: Hide Reels Navigation Link
     ========================================================================== */

  function applyHideReelsNav() {
    if (!settings.hideReelsNav) {
      document.querySelectorAll('.ii-hidden-nav').forEach((el) => {
        el.classList.remove('ii-hidden-nav');
        el.style.removeProperty('display');
      });
      return;
    }

    const reelLinks = document.querySelectorAll(
      'a[href="/reels/"], a[href="/reels"], a[href^="/reels/?"]'
    );

    reelLinks.forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('/reels/') || href === '/reels') {
        link.classList.add('ii-hidden-nav');
        link.style.setProperty('display', 'none', 'important');
      }
    });
  }

  /* ==========================================================================
     Feature 2: Filter Search & Explore
     ========================================================================== */

  function applyExploreFilter() {
    const onExplore = isExplorePage(window.location.pathname);

    if (settings.filterExplore && onExplore) {
      document.documentElement.setAttribute('data-ii-page', 'explore');
      injectExplorePlaceholder();
    } else {
      document.documentElement.removeAttribute('data-ii-page');
      removeExplorePlaceholder();
    }

    if (settings.filterExplore) {
      filterSearchDrawerRecommendations();
    }
  }

  function injectExplorePlaceholder() {
    if (explorePlaceholderEl && explorePlaceholderEl.isConnected) {
      return;
    }

    const mainEl = document.querySelector('main[role="main"]');
    if (!mainEl) return;

    if (!explorePlaceholderEl) {
      explorePlaceholderEl = document.createElement('div');
      explorePlaceholderEl.id = 'ii-explore-placeholder';
      explorePlaceholderEl.innerHTML = `
        <div class="ii-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </div>
        <h2>Explore Feed Hidden</h2>
        <p>Intentional Instagram hides algorithmic exploration grids to preserve your focus. Use the Search bar above to look up specific accounts or topics directly.</p>
      `;
    }

    if (!mainEl.contains(explorePlaceholderEl)) {
      mainEl.appendChild(explorePlaceholderEl);
    }
  }

  function removeExplorePlaceholder() {
    if (explorePlaceholderEl && explorePlaceholderEl.parentNode) {
      explorePlaceholderEl.parentNode.removeChild(explorePlaceholderEl);
    }
  }

  function filterSearchDrawerRecommendations() {
    const searchContainers = document.querySelectorAll(
      'div[role="dialog"], div[data-testid="search-box"] ~ div, div:has(> input[placeholder*="Search" i])'
    );

    searchContainers.forEach((container) => {
      const reelLinks = container.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"]');
      reelLinks.forEach((link) => {
        const tile = link.closest('div[style*="flex"], div[role="listitem"]') || link;
        tile.style.setProperty('display', 'none', 'important');
      });
    });
  }

  /* ==========================================================================
     Post Detection, Viewing Dwell Threshold & Deduplication (Feature 1 & 4)
     ========================================================================== */

  // Tracks active dwell timers for articles currently in viewport
  const postDwellTimers = new Map(); // Element -> timerId

  /**
   * Extracts a unique post identifier from an <article> element.
   * Prioritizes canonical /p/<id>/ or /reel/<id>/ links.
   */
  function extractPostIdentifier(articleEl) {
    if (!articleEl) return null;

    // Check existing cached identifier
    if (articleEl.dataset.iiPostId) {
      return articleEl.dataset.iiPostId;
    }

    // 1. Check for permalink anchors: /p/<shortcode>/ or /reel/<shortcode>/
    const permalinks = articleEl.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    for (const link of permalinks) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
      if (match && match[1]) {
        articleEl.dataset.iiPostId = match[1];
        return match[1];
      }
    }

    // 2. Check time tag's ancestor link
    const timeEl = articleEl.querySelector('time');
    if (timeEl) {
      const timeLink = timeEl.closest('a');
      if (timeLink) {
        const href = timeLink.getAttribute('href') || '';
        const match = href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
        if (match && match[1]) {
          articleEl.dataset.iiPostId = match[1];
          return match[1];
        }
      }
    }

    // 3. Fallback: Author + first media source signature
    const authorLink = articleEl.querySelector('header a[href^="/"]');
    if (authorLink) {
      const author = (authorLink.getAttribute('href') || '').replace(/\//g, '');
      const media = articleEl.querySelector('img[src*="instagram"], video');
      if (media && media.src) {
        const srcSignature = media.src.split('?')[0].slice(-25);
        const fallbackId = `${author}_${srcSignature}`;
        articleEl.dataset.iiPostId = fallbackId;
        return fallbackId;
      }
    }

    return null;
  }

  /**
   * Records that an eligible post has satisfied the viewing threshold.
   * Deduplicates by checking whether postId is already in viewedPostIds.
   */
  function recordPostViewed(articleEl) {
    if (!settings.enableFeedLimits || currentSession.isBlocked) return;

    const postId = extractPostIdentifier(articleEl);
    if (!postId) return;

    // Deduplication check: ignore if already viewed in this session
    if (currentSession.viewedPostIds.includes(postId)) {
      return;
    }

    currentSession.viewedPostIds.push(postId);
    persistSession();

    // Check if post limit has been reached
    if (currentSession.viewedPostIds.length >= settings.feedPostLimit) {
      triggerFeedBlock('posts');
    }
  }

  /**
   * High-performance IntersectionObserver:
   * Requires the post to be at least 50% visible in the viewport.
   * Enforces a dwell timer: if the user rapidly scrolls past, the timer is
   * cancelled before the post can be counted.
   */
  const postIntersectionObserver = new IntersectionObserver((entries) => {
    if (!settings.enableFeedLimits || currentSession.isBlocked) return;
    if (!isHomeFeed(window.location.pathname)) return;

    entries.forEach((entry) => {
      const article = entry.target;

      // Condition: Post is intersecting and covers at least 50% of viewport area
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        if (!postDwellTimers.has(article)) {
          const thresholdMs = Math.max(500, (settings.postViewThreshold || 1.5) * 1000);
          const timerId = setTimeout(() => {
            postDwellTimers.delete(article);
            recordPostViewed(article);
          }, thresholdMs);

          postDwellTimers.set(article, timerId);
        }
      } else {
        // Post scrolled out before dwell threshold was reached: cancel timer!
        if (postDwellTimers.has(article)) {
          clearTimeout(postDwellTimers.get(article));
          postDwellTimers.delete(article);
        }
      }
    });
  }, {
    threshold: [0.5]
  });

  /**
   * Scans for new unobserved feed articles rendered dynamically by Instagram.
   */
  function observeNewArticles() {
    if (!settings.enableFeedLimits || currentSession.isBlocked) return;
    if (!isHomeFeed(window.location.pathname)) return;

    const articles = document.querySelectorAll('main[role="main"] article');
    articles.forEach((art) => {
      if (!art.dataset.iiObserved) {
        art.dataset.iiObserved = 'true';
        postIntersectionObserver.observe(art);
      }
    });
  }

  /* ==========================================================================
     Home Feed Limit Blocking Screen (Feature 3 & 6)
     ========================================================================== */

  /**
   * Activates the persistent home-feed blocking state.
   */
  function triggerFeedBlock(reason) {
    currentSession.isBlocked = true;
    currentSession.blockReason = reason;
    persistSession();
    applyFeedBlockingScreen();
  }

  /**
   * Renders the persistent blocking overlay over the home feed.
   * Keeps navigation, DMs, and profiles 100% available.
   */
  function applyFeedBlockingScreen() {
    const onHome = isHomeFeed(window.location.pathname);

    // Only display over the home feed when limits are enabled and session is blocked
    if (!settings.enableFeedLimits || !currentSession.isBlocked || !onHome) {
      document.documentElement.removeAttribute('data-ii-feed-blocked');
      if (feedBlockingOverlayEl && feedBlockingOverlayEl.parentNode) {
        feedBlockingOverlayEl.parentNode.removeChild(feedBlockingOverlayEl);
      }
      return;
    }

    document.documentElement.setAttribute('data-ii-feed-blocked', 'true');

    const mainEl = document.querySelector('main[role="main"]');
    if (!mainEl) return;

    if (!feedBlockingOverlayEl) {
      feedBlockingOverlayEl = document.createElement('div');
      feedBlockingOverlayEl.id = 'ii-feed-blocking-overlay';
    }

    const isTimeReason = currentSession.blockReason === 'time';
    const titleText = isTimeReason
      ? 'Session Time Limit Reached'
      : 'Post Viewing Limit Reached';

    const descText = isTimeReason
      ? `You've spent ${settings.feedTimeLimit} minutes browsing Instagram. Take a mindful break from the feed.`
      : `You've viewed your session limit of ${settings.feedPostLimit} posts. Protect your focus and step away from the feed.`;

    const elapsedMinutes = Math.floor(currentSession.elapsedSeconds / 60);
    const elapsedSecondsRemainder = currentSession.elapsedSeconds % 60;
    const timeFormatted = `${elapsedMinutes}m ${elapsedSecondsRemainder < 10 ? '0' : ''}${elapsedSecondsRemainder}s`;

    feedBlockingOverlayEl.innerHTML = `
      <div class="ii-feed-badge">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      </div>
      <h2 class="ii-feed-title">${titleText}</h2>
      <p class="ii-feed-desc">${descText}</p>
      <div class="ii-feed-stats-pill">
        <span>Posts viewed: <strong>${currentSession.viewedPostIds.length} / ${settings.feedPostLimit}</strong></span>
        <span>•</span>
        <span>Active time: <strong>${timeFormatted}</strong></span>
      </div>
      <div class="ii-feed-actions">
        <a href="https://www.instagram.com/direct/inbox/" class="ii-btn-primary" id="ii-feed-btn-dms">
          💬 Open Direct Messages
        </a>
        <button type="button" class="ii-btn-secondary" id="ii-feed-btn-reset">
          🔄 Start New Session
        </button>
      </div>
    `;

    // Ensure action handlers
    const dmsBtn = feedBlockingOverlayEl.querySelector('#ii-feed-btn-dms');
    if (dmsBtn) {
      dmsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = 'https://www.instagram.com/direct/inbox/';
      });
    }

    const resetBtn = feedBlockingOverlayEl.querySelector('#ii-feed-btn-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        resetSessionState();
      });
    }

    if (!mainEl.contains(feedBlockingOverlayEl)) {
      mainEl.prepend(feedBlockingOverlayEl);
    }
  }

  /**
   * Resets the session counters and unblocks the home feed.
   */
  function resetSessionState() {
    currentSession = {
      elapsedSeconds: 0,
      viewedPostIds: [],
      isBlocked: false,
      blockReason: null,
      lastActiveTimestamp: Date.now()
    };
    persistSession();
    applyAllFeatures();
  }

  /* ==========================================================================
     Feature 3 & 4: Allow One Reel, Block Next & Dedicated Route Handling
     ========================================================================== */

  function getOrCreateBlockingOverlay() {
    if (blockingOverlayEl && document.body.contains(blockingOverlayEl)) {
      return blockingOverlayEl;
    }

    blockingOverlayEl = document.getElementById('ii-blocking-overlay');
    if (!blockingOverlayEl) {
      blockingOverlayEl = document.createElement('div');
      blockingOverlayEl.id = 'ii-blocking-overlay';
      blockingOverlayEl.innerHTML = `
        <div class="ii-overlay-card">
          <div class="ii-overlay-badge">
            <svg viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1"></rect>
              <rect x="14" y="4" width="4" height="16" rx="1"></rect>
            </svg>
          </div>
          <h1 class="ii-overlay-title" id="ii-overlay-title">You've seen one. Stop here.</h1>
          <p class="ii-overlay-subtitle" id="ii-overlay-subtitle">
            Intentional Instagram paused further scrolling to protect your time and attention.
          </p>
          <div class="ii-overlay-actions">
            <button type="button" class="ii-btn-primary" id="ii-btn-exit">Exit Reel Viewer</button>
            <button type="button" class="ii-btn-secondary" id="ii-btn-home">Return to Home Feed</button>
          </div>
        </div>
      `;

      blockingOverlayEl.querySelector('#ii-btn-exit').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        exitReelViewer();
      });

      blockingOverlayEl.querySelector('#ii-btn-home').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = 'https://www.instagram.com/';
      });

      const swallowEvent = (e) => {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
      };
      blockingOverlayEl.addEventListener('wheel', swallowEvent, { passive: false });
      blockingOverlayEl.addEventListener('touchmove', swallowEvent, { passive: false });
      blockingOverlayEl.addEventListener('keydown', swallowEvent);
    }

    if (!document.body.contains(blockingOverlayEl)) {
      document.body.appendChild(blockingOverlayEl);
    }

    return blockingOverlayEl;
  }

  function showReelBlockingScreen(titleText, subtitleText) {
    if (!settings.limitReels) return;

    isReelBlockActive = true;
    document.documentElement.classList.add('ii-blocking-active');

    const overlay = getOrCreateBlockingOverlay();
    const titleEl = overlay.querySelector('#ii-overlay-title');
    const subtitleEl = overlay.querySelector('#ii-overlay-subtitle');

    if (titleText && titleEl) titleEl.textContent = titleText;
    if (subtitleText && subtitleEl) subtitleEl.textContent = subtitleText;

    overlay.classList.add('ii-active');

    pauseAndMuteAllVideos();

    if (!videoSuppressInterval) {
      videoSuppressInterval = setInterval(pauseAndMuteAllVideos, 250);
    }

    incrementBlockedStats();
  }

  function hideReelBlockingScreen() {
    isReelBlockActive = false;
    document.documentElement.classList.remove('ii-blocking-active');

    if (blockingOverlayEl) {
      blockingOverlayEl.classList.remove('ii-active');
    }

    if (videoSuppressInterval) {
      clearInterval(videoSuppressInterval);
      videoSuppressInterval = null;
    }
  }

  function exitReelViewer() {
    hideReelBlockingScreen();
    allowedReelCode = null;

    if (window.history.length > 1) {
      window.history.back();
      setTimeout(() => {
        if (isDedicatedReelsFeed(window.location.pathname) || isIndividualReel(window.location.pathname)) {
          window.location.href = 'https://www.instagram.com/';
        }
      }, 300);
    } else {
      window.location.href = 'https://www.instagram.com/';
    }
  }

  function pauseAndMuteAllVideos() {
    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      try {
        if (!video.paused) {
          video.pause();
        }
        video.muted = true;
      } catch (err) {
        // Ignore playback controller exceptions
      }
    });
  }

  function incrementBlockedStats() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ blockedReelsCount: 0 }, (data) => {
        const nextCount = (data.blockedReelsCount || 0) + 1;
        chrome.storage.local.set({ blockedReelsCount: nextCount });
      });
    }
  }

  function isInsideNonReelInteractive(target) {
    if (!target || !(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        'input, textarea, [contenteditable="true"], form, [role="dialog"], [aria-label*="Comments" i], ul[class*="comment" i]'
      )
    );
  }

  /* ==========================================================================
     Reel Event Interceptors (Capture Phase)
     ========================================================================== */

  function handleWheelEvent(e) {
    if (!settings.limitReels) return;

    const path = window.location.pathname;

    if (isDedicatedReelsFeed(path)) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showReelBlockingScreen(
        "Reels feed is blocked.",
        "Mindful pause: Intentional Instagram has blocked endless Reels scrolling."
      );
      return;
    }

    if (!isIndividualReel(path)) return;

    if (isReelBlockActive) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }

    if (isInsideNonReelInteractive(e.target)) {
      return;
    }

    if (e.deltaY > 15) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      showReelBlockingScreen(
        "You've seen one. Stop here.",
        "Intentional Instagram stopped further scrolling to protect your time and attention."
      );
    }
  }

  function handleKeyDownEvent(e) {
    if (!settings.limitReels) return;

    const path = window.location.pathname;
    if (!isIndividualReel(path) && !isDedicatedReelsFeed(path)) return;

    if (
      e.target &&
      (e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA' ||
        e.target.isContentEditable)
    ) {
      return;
    }

    const advanceKeys = ['ArrowDown', 'PageDown', 'Down', 'j', 'J'];
    if (advanceKeys.includes(e.key)) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      showReelBlockingScreen(
        "You've seen one. Stop here.",
        "Intentional Instagram stopped further scrolling to protect your time and attention."
      );
    }
  }

  let touchStartY = null;

  function handleTouchStart(e) {
    if (e.touches && e.touches.length > 0) {
      touchStartY = e.touches[0].clientY;
    }
  }

  function handleTouchMove(e) {
    if (!settings.limitReels || touchStartY === null) return;

    const path = window.location.pathname;
    if (!isIndividualReel(path) && !isDedicatedReelsFeed(path)) return;

    if (isReelBlockActive) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }

    if (isInsideNonReelInteractive(e.target)) {
      return;
    }

    if (e.touches && e.touches.length > 0) {
      const currentY = e.touches[0].clientY;
      const diffY = currentY - touchStartY;

      if (diffY < -35) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        showReelBlockingScreen(
          "You've seen one. Stop here.",
          "Intentional Instagram stopped further scrolling to protect your time and attention."
        );
      }
    }
  }

  function handleTouchEnd() {
    touchStartY = null;
  }

  function handleClickCapture(e) {
    if (!settings.limitReels) return;

    const path = window.location.pathname;
    if (!isIndividualReel(path) && !isDedicatedReelsFeed(path)) return;

    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const nextBtn = target.closest(
      'button[aria-label*="Next" i], button[aria-label*="Down" i], svg[aria-label*="Next" i], svg[aria-label*="Down" i]'
    );

    if (nextBtn && !isInsideNonReelInteractive(target)) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      showReelBlockingScreen(
        "You've seen one. Stop here.",
        "Intentional Instagram stopped further scrolling to protect your time and attention."
      );
    }
  }

  window.addEventListener('wheel', handleWheelEvent, { capture: true, passive: false });
  window.addEventListener('keydown', handleKeyDownEvent, { capture: true, passive: false });
  window.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
  window.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
  window.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });
  window.addEventListener('click', handleClickCapture, { capture: true });

  /* ==========================================================================
     Route State & SPA Navigation Monitor
     ========================================================================== */

  function handleRouteChange() {
    const newPath = window.location.pathname;
    currentPath = newPath;

    applyHideReelsNav();
    applyExploreFilter();
    applyFeedBlockingScreen();

    // Dedicated reels feed
    if (isDedicatedReelsFeed(newPath)) {
      if (settings.limitReels) {
        showReelBlockingScreen(
          "Reels feed is blocked.",
          "Mindful pause: Intentional Instagram has blocked endless Reels scrolling."
        );
      }
      return;
    }

    // Individual reel viewer
    const currentReel = getReelShortcode(newPath);
    if (currentReel) {
      if (allowedReelCode === null) {
        allowedReelCode = currentReel;
        hideReelBlockingScreen();
      } else if (allowedReelCode !== currentReel) {
        if (settings.limitReels) {
          showReelBlockingScreen(
            "You've seen one. Stop here.",
            "Intentional Instagram stopped further scrolling to protect your time and attention."
          );
        }
      }
      return;
    }

    // Not on a reel viewer: reset reel tracking state
    allowedReelCode = null;
    hideReelBlockingScreen();

    // If on home feed, attach observer to existing articles
    if (isHomeFeed(newPath)) {
      observeNewArticles();
    }
  }

  window.addEventListener('popstate', handleRouteChange);

  let lastCheckedHref = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastCheckedHref) {
      lastCheckedHref = window.location.href;
      handleRouteChange();
    }
  }, 120);

  /* ==========================================================================
     Scoped MutationObserver
     ========================================================================== */

  let mutationScheduled = false;

  const observer = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const target = mutations[i].target;
      if (
        target &&
        target instanceof Element &&
        (target.id === 'ii-blocking-overlay' ||
          target.id === 'ii-feed-blocking-overlay' ||
          target.id === 'ii-explore-placeholder' ||
          target.closest('#ii-blocking-overlay') ||
          target.closest('#ii-feed-blocking-overlay') ||
          target.closest('#ii-explore-placeholder'))
      ) {
        return;
      }
    }

    if (!mutationScheduled) {
      mutationScheduled = true;
      requestAnimationFrame(() => {
        mutationScheduled = false;
        applyHideReelsNav();

        if (isExplorePage(window.location.pathname) && settings.filterExplore) {
          injectExplorePlaceholder();
        }
        if (settings.filterExplore) {
          filterSearchDrawerRecommendations();
        }
        if (isReelBlockActive) {
          pauseAndMuteAllVideos();
        }

        // Observe dynamically loaded home feed articles
        if (isHomeFeed(window.location.pathname)) {
          if (settings.enableFeedLimits && currentSession.isBlocked) {
            applyFeedBlockingScreen();
          } else {
            observeNewArticles();
          }
        }
      });
    }
  });

  /* ==========================================================================
     Master Feature Orchestrator
     ========================================================================== */

  function applyAllFeatures() {
    applyHideReelsNav();
    applyExploreFilter();
    applyFeedBlockingScreen();
    handleRouteChange();
  }

  function startObserver() {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      initSettingsAndSession();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
        initSettingsAndSession();
      });
    }
  }

  startObserver();

})();
