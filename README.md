# Intentional Instagram — Chrome Extension (Manifest V3)

> A lightweight, privacy-first Chrome Extension designed to eliminate mindless doomscrolling, hide distracting exploration grids, limit home-feed consumption by time and unique posts viewed, and enforce healthy boundaries while keeping all genuine messaging, profile viewing, and account search functional.

---

## 📁 File Structure

```text
intentional-instagram/
├── manifest.json       # Manifest V3 extension configuration & permission definitions
├── content.js          # Core engine: session timer, post counter, dwell observer, gesture interceptors
├── styles.css          # Scoped CSS: navigation removal, explore hiding, and feed/reels blocking screens
├── popup.html          # Extension popup user interface with live session monitor
├── popup.js            # Controller: loads & persists user preferences and session via chrome.storage
├── popup.css           # Modern dark-mode styling for popup UI
├── icons/              # Extension icons (16x16, 48x48, 128x128)
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md           # Documentation & Testing Guide
```

---

## ⚙️ Features & Architecture

### 1. Home Feed Post Limit (Default: 15 Posts)
- Tracks each unique post loaded into the home feed (`main[role="main"] article`).
- Extracts canonical shortcodes from `/p/<shortcode>/` or `/reel/<shortcode>/` permalinks.
- **Deduplication:** Uses a persistent set of viewed post IDs (`viewedPostIds`). Scrolling back up past an already-viewed post will never count it a second time.
- When the post limit is reached, a persistent blocking screen is mounted over the home feed.

### 2. Session Time Limit (Default: 10 Minutes)
- Tracks active time spent browsing Instagram.
- Ticks only when the Instagram tab is **active and visible** (`document.visibilityState === 'visible'`).
- Pauses when you switch tabs, minimize the window, or lock your computer.
- When the active duration reaches the configured time limit, the home feed blocking screen activates immediately.

### 3. Viewing Dwell Threshold (Default: 1.5 Seconds)
- Uses `IntersectionObserver` configured to trigger only when a post occupies at least **50% of the viewport**.
- When a post enters sufficient visibility, a dwell timer is initiated (`postViewThreshold * 1000` ms).
- **Fast-Scroll Cancellation:** If you quickly scroll past a post without pausing (less than 1.5 seconds), the timer is immediately cancelled and the post is **not** counted.

### 4. Persistent Local Session State
- Session metrics (`elapsedSeconds`, `viewedPostIds`, `isBlocked`, `blockReason`) are saved in `chrome.storage.local`.
- **Refresh Resistance:** Refreshing Instagram (`F5`, `Ctrl+R`) does not reset the timer or post count.
- **Inactivity Expiration:** A period of 45+ minutes away from Instagram automatically initiates a fresh session.
- **Manual Reset:** A "Start New Session" button is available both in the extension popup and directly on the home-feed blocking overlay.

### 5. Isolation of Non-Feed Features (Direct Messages, Profiles, Search)
- The feed blocking overlay is strictly scoped to the Home Feed (`/`).
- Direct Messages (`/direct/inbox/`), user profile pages (`/<username>/`), account search, and single post view modals remain **100% accessible and functional**.

### 6. Preserved Existing Protections
- **Hide Reels Navigation:** Desktop sidebar links to `/reels/` are removed. Profile reel tabs (`/<username>/reels/`) are untouched.
- **Filter Search & Explore:** Hides the algorithmic post grid on `/explore/` and replaces it with a calm placeholder. Strips recommendation tiles from the Search drawer.
- **One-Reel Limit:** Plays the first intentionally opened Reel; blocks navigation (wheel down, Down arrow, PageDown, swipe) to subsequent reels with a full-viewport black screen ("You've seen one. Stop here.").

---

## 🔍 Limitations in Detecting a Genuinely Viewed Post

1. **Physical Attention vs. Viewport Presence:**  
   Web browser APIs (`IntersectionObserver`) can only detect whether a post's DOM element occupies >= 50% of the visible browser window for the specified dwell duration (e.g., 1.5 seconds). Software cannot verify whether the human user is actively reading the post or looking away from the monitor.
2. **Tall Posts on Smaller Viewports:**  
   Some portrait posts with extended captions exceed the height of smaller laptop screens or split windows. Requiring 100% visibility would cause these posts to never be counted. The 50% intersection threshold provides balanced, reliable detection across different screen resolutions.
3. **Carousel Slides:**  
   Swiping through multiple photos within the same carousel post belongs to a single post permalink and is counted as 1 unique post.
4. **Virtualization & DOM Recycling:**  
   Instagram's React engine may unmount off-screen posts during long scrolling sessions. By tracking IDs in a persistent session array rather than relying on in-memory DOM nodes, re-mounted posts are never counted twice.

---

## 🧪 Testing Checklist

### Static Checks Performed
- `manifest.json`: Valid MV3 schema, minimal local storage permissions.
- `styles.css` & `popup.css`: All braces balanced, scoped isolation.
- `content.js` & `popup.js`: Token and bracket balance verified.
- Unit logic simulations: Regex matching for post IDs, route detection, and deduplication verified.

### Manual Verification Checklist (In Chrome)

- [ ] **1. Session Timer Count**
  1. Open Instagram home feed (`https://www.instagram.com/`).
  2. Click the extension popup icon and check "Active Time".
  3. Keep the tab open for 30 seconds; reopen the popup and verify elapsed time increased by ~30s.
  4. Switch to another tab for 20 seconds, return, and verify the timer did **not** count the inactive background time.

- [ ] **2. Fast Scroll vs. Slow Dwell Post Count**
  1. In the popup, set "Max Posts per Session" to 5 and "View Threshold" to 1.5s.
  2. Scroll rapidly down past 10 posts in 2 seconds without stopping.
  3. Check the popup: verify the post count did **not** increment for quickly skipped posts.
  4. Scroll to a post and let it stay centered in view for 2+ seconds.
  5. Check the popup: verify the post count increments by 1.

- [ ] **3. Deduplication**
  1. Scroll down until post count is at least 3.
  2. Scroll back up to the top post and linger on it for 3 seconds.
  3. Check the popup: verify the count remains unchanged (deduplication succeeded).

- [ ] **4. Post Limit Activation & Refresh Resistance**
  1. View posts until you hit the limit (e.g. 5 / 5).
  2. Verify the home-feed blocking screen immediately appears: **"Post Viewing Limit Reached"**.
  3. Press `F5` / reload the page.
  4. Verify the blocking screen persists and does not reset.

- [ ] **5. Time Limit Activation**
  1. Set time limit to 1 minute in the popup.
  2. Browse until 1:00 has elapsed.
  3. Verify the home-feed blocking screen activates: **"Session Time Limit Reached"**.

- [ ] **6. Navigation & Direct Messages Accessibility**
  1. While the home-feed blocking screen is active, click "Messages" in the left sidebar (or click "Open Direct Messages" on the overlay).
  2. Verify you are navigated to `/direct/inbox/` and your messages are fully accessible without any blocking overlay.
  3. Navigate to a profile (e.g. `/natgeo/`): verify the profile's posts render normally.
  4. Return to Home (`/`): verify the feed blocking screen re-appears.

- [ ] **7. Session Reset**
  1. Click "Start New Session" (either on the blocking overlay or in the popup).
  2. Verify the feed unblocks immediately, timer resets to 0m 00s, and post count resets to 0.
