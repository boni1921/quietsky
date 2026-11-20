(() => {
  'use strict';

  const DEFAULTS = {
    hideLikes: true,
    hideReposts: true,
    hideBookmarks: true,
    hideComments: true,
    showOwnOnly: false,
    commentWhitelist: [],
  };

  const KEYS = [
    'hideLikes',
    'hideReposts',
    'hideBookmarks',
    'hideComments',
    'showOwnOnly',
    'commentWhitelist',
  ];

  const CLASS_MAP = {
    hideLikes: 'quietsky-hide-likes',
    hideReposts: 'quietsky-hide-reposts',
    hideBookmarks: 'quietsky-hide-bookmarks',
    hideComments: 'quietsky-hide-comments',
    showOwnOnly: 'quietsky-show-own-only',
  };

  const POST_SELECTOR =
    '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]';
  const POST_CLASS = 'quietsky-post';
  const OWN_CLASS = 'quietsky-own-post';
  // Author is on the comment-count whitelist (comment count only, never likes etc.).
  const WHITELIST_CLASS = 'quietsky-comment-whitelisted';
  // Tag applied to the reply-count text element inside [data-testid="replyBtn"].
  const REPLY_COUNT_CLASS = 'quietsky-reply-count';
  const REPLY_BTN_SELECTOR = '[data-testid="replyBtn"]';
  /**
   * Bluesky web renders the reply count with a react-native-web <Text>, i.e.
   * `<div dir="auto">12</div>`, as the ONLY [dir="auto"] direct child of
   * [data-testid="replyBtn"] (the icon is an <svg>). Verified against the
   * deployed web bundle: PostControls passes `testID="replyBtn"` but the
   * count's PostControlButtonText has no testID at all. This structural hook
   * lets CSS hide the count directly, without relying on JS text matching.
   */
  const REPLY_COUNT_STRUCTURAL_SELECTOR = '[data-testid="replyBtn"] > [dir="auto"]';
  // Compact counts from useFormatPostStatCount: "12", "1.2K", "1,234",
  // and locale variants such as "1,2 mil". Tolerates a short letter suffix.
  const COUNT_TEXT_RE = /^\d[\d.,]*(?:\s*[\p{L}.]{1,10})?$/u;
  const BSKY_STORAGE_KEY = 'BSKY_STORAGE';
  // Fallback sweep catches virtualized-list recycling and text-only updates
  // that a childList-only MutationObserver cannot see.
  const SWEEP_INTERVAL_MS = 2000;

  /** @type {Set<string>} */
  let selfActors = new Set();
  /** @type {Set<string>} */
  let commentWhitelist = new Set();
  let showOwnOnly = false;
  let hideComments = true;
  let observerStarted = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let retryTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let sweepTimer = null;
  let diagnosticLogged = false;
  const diagStats = { buttons: 0, marked: 0, structural: 0 };

  /**
   * Post marking is needed for showOwnOnly (own-post restore for the existing
   * count toggles) and, independently, for hideComments (reply-count tagging
   * and whitelist restore). Either one active keeps the observer/marking alive.
   */
  function isMarkingActive() {
    return showOwnOnly || hideComments;
  }

  function applyClasses(settings) {
    const root = document.documentElement;
    for (const [key, className] of Object.entries(CLASS_MAP)) {
      const on =
        key === 'showOwnOnly'
          ? Boolean(settings[key])
          : settings[key] !== false;
      root.classList.toggle(className, on);
    }
  }

  function normalizeActor(value) {
    if (!value) return null;
    let s = String(value).trim().toLowerCase();
    if (!s) return null;
    if (s.startsWith('@')) s = s.slice(1);
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep raw
    }
    if (s.startsWith('did:')) return s;
    return s.replace(/^\/profile\//, '').split(/[/?#]/)[0] || null;
  }

  /**
   * Store an actor in both its short and full-handle forms so that
   * `alice` and `alice.bsky.social` compare equal. DIDs are stored verbatim.
   */
  function addActorToSet(set, value) {
    const key = normalizeActor(value);
    if (!key) return;
    set.add(key);
    if (!key.startsWith('did:') && key.endsWith('.bsky.social')) {
      set.add(key.slice(0, -'.bsky.social'.length));
    } else if (!key.startsWith('did:') && !key.includes('.')) {
      set.add(`${key}.bsky.social`);
    }
  }

  function addSelfActor(value) {
    addActorToSet(selfActors, value);
  }

  function isActorInSet(set, actor) {
    const key = normalizeActor(actor);
    if (!key || set.size === 0) return false;
    if (set.has(key)) return true;
    if (!key.startsWith('did:')) {
      if (key.endsWith('.bsky.social')) {
        return set.has(key.slice(0, -'.bsky.social'.length));
      }
      return set.has(`${key}.bsky.social`);
    }
    return false;
  }

  function isSelfActor(actor) {
    return isActorInSet(selfActors, actor);
  }

  function isWhitelistedActor(actor) {
    return isActorInSet(commentWhitelist, actor);
  }

  function setCommentWhitelist(list) {
    commentWhitelist = new Set();
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      addActorToSet(commentWhitelist, entry);
    }
  }

  /**
   * Bluesky web: localStorage BSKY_STORAGE.session =
   * { accounts, currentAccount } (see social-app persisted/index.web.ts)
   */
  function readSelfFromStorage() {
    try {
      const raw = localStorage.getItem(BSKY_STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      const session = data?.session;
      if (!session) return false;

      const current = session.currentAccount;
      const accounts = Array.isArray(session.accounts) ? session.accounts : [];

      let did = current?.did ? String(current.did) : null;
      let handle = current?.handle ? String(current.handle) : null;

      if (did) {
        const full = accounts.find(
          (a) => String(a?.did || '').toLowerCase() === did.toLowerCase(),
        );
        if (full?.did) did = String(full.did);
        if (full?.handle) handle = String(full.handle);
      }

      if (!did && !handle && accounts.length === 1) {
        did = accounts[0]?.did ? String(accounts[0].did) : null;
        handle = accounts[0]?.handle ? String(accounts[0].handle) : null;
      }

      if (did) addSelfActor(did);
      if (handle) addSelfActor(handle);
      return Boolean(did || handle);
    } catch {
      return false;
    }
  }

  const INSIDE_POST =
    '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]';

  function isShellProfileHref(href) {
    const path = String(href || '').split('?')[0];
    return /^\/profile\/[^/]+\/?$/.test(path);
  }

  /**
   * Desktop left nav Profile is an <a href="/profile/{handle}"> with an icon,
   * not an avatar (LeftNav NavItem next to /settings). Bottom bar may wrap
   * UserAvatar. Never use translated aria-labels.
   */
  function readSelfFromDom() {
    let found = false;

    const anchor =
      document.querySelector('a[href="/settings"]') ||
      document.querySelector('a[href="/saved"]');
    const shell =
      anchor?.closest('nav') ||
      anchor?.parentElement?.parentElement ||
      anchor?.parentElement;
    if (shell) {
      for (const link of shell.querySelectorAll('a[href^="/profile/"]')) {
        if (link.closest(INSIDE_POST)) continue;
        const href = link.getAttribute('href') || '';
        if (!isShellProfileHref(href)) continue;
        addSelfActor(href);
        found = true;
        const img = link.querySelector('img[src]');
        const didMatch = (img?.getAttribute('src') || '').match(
          /\/(did:[^/]+)\//i,
        );
        if (didMatch) addSelfActor(didMatch[1]);
      }
    }

    const shellAvatars = document.querySelectorAll(
      'a[href^="/profile/"] img[src*="/did:"]',
    );
    for (const img of shellAvatars) {
      if (img.closest(INSIDE_POST)) continue;
      const link = img.closest('a[href^="/profile/"]');
      if (!link || link.closest(INSIDE_POST)) continue;
      const href = link.getAttribute('href') || '';
      if (!isShellProfileHref(href)) continue;
      const didMatch = (img.getAttribute('src') || '').match(
        /\/(did:[^/]+)\//i,
      );
      if (didMatch) addSelfActor(didMatch[1]);
      addSelfActor(href);
      found = true;
    }

    return found;
  }

  function refreshSelf() {
    selfActors = new Set();
    const fromStorage = readSelfFromStorage();
    const fromDom = readSelfFromDom();
    return fromStorage || fromDom || selfActors.size > 0;
  }

  function handleFromTestId(el) {
    const id = el.getAttribute('data-testid') || '';
    const match = id.match(/^(?:feedItem|postThreadItem)-by-(.+)$/);
    return match ? match[1] : null;
  }

  function didFromAvatar(root) {
    const img =
      root.querySelector?.('[data-testid="userAvatarImage"] img[src]') ||
      root.querySelector?.('img[src*="/did:"]');
    const src = img?.getAttribute('src') || '';
    const match = src.match(/\/(did:[^/]+)\//i);
    return match ? match[1] : null;
  }

  function authorHrefInPost(root) {
    const author = normalizeActor(handleFromTestId(root));
    const links = root.querySelectorAll?.('a[href^="/profile/"]') || [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!isShellProfileHref(href)) continue;
      const actor = normalizeActor(href);
      if (author && actor) {
        const same =
          actor === author ||
          actor === `${author}.bsky.social` ||
          `${actor}.bsky.social` === author;
        if (!same) continue;
      }
      return href;
    }
    return null;
  }

  /**
   * Collect the reply buttons relevant to `root` (the root itself, its owner,
   * or any descendant) without duplicates.
   * @param {Node} root
   * @returns {Element[]}
   */
  function collectReplyButtons(root) {
    /** @type {Element[]} */
    const buttons = [];
    const add = (btn) => {
      if (btn && !buttons.includes(btn)) buttons.push(btn);
    };
    if (root.nodeType === 1) {
      if (root.matches?.(REPLY_BTN_SELECTOR)) add(root);
      add(root.closest?.(REPLY_BTN_SELECTOR));
    }
    for (const btn of root.querySelectorAll?.(REPLY_BTN_SELECTOR) || []) {
      add(btn);
    }
    return buttons;
  }

  /**
   * Tag reply-count elements so CSS can hide them. Two complementary paths:
   *
   * 1. Structural fast path — the RNW <Text> count is the direct
   *    `[dir="auto"]` child of [data-testid="replyBtn"]. This matches the
   *    real Bluesky DOM regardless of number formatting or wrapper nesting.
   * 2. Text fallback — the deepest descendant whose trimmed text looks like
   *    a compact count, for layout variations that lack dir="auto".
   *
   * The button itself is never modified, so it stays fully clickable.
   * @param {Node} root
   */
  function findAndMarkReplyCounts(root) {
    for (const btn of collectReplyButtons(root)) {
      // Fast path: direct [dir="auto"] children (RNW Text renders the count).
      // Skip any that are inside an <svg> just in case.
      for (const el of btn.querySelectorAll(':scope > [dir="auto"]')) {
        if (el.closest('svg')) continue;
        el.classList.add(REPLY_COUNT_CLASS);
      }

      // Fallback: deepest numeric-text descendant (existing heuristic).
      for (const el of btn.querySelectorAll('*')) {
        if (el.classList.contains(REPLY_COUNT_CLASS)) continue;
        if (el.closest('svg')) continue;
        const text = (el.textContent || '').trim();
        if (!text || !COUNT_TEXT_RE.test(text)) continue;

        // Skip wrapper elements whose child already carries the same text.
        let nested = false;
        for (const child of el.children) {
          if ((child.textContent || '').trim() === text) {
            nested = true;
            break;
          }
        }
        if (nested) continue;

        el.classList.add(REPLY_COUNT_CLASS);
      }
    }
  }

  /**
   * One-time, non-UI diagnostic: expose detection counts on <html> as a data
   * attribute and log a single console line so users can self-check.
   */
  function refreshDiagnostic() {
    if (!hideComments) return;
    const buttons = document.querySelectorAll(REPLY_BTN_SELECTOR).length;
    const structural = document.querySelectorAll(REPLY_COUNT_STRUCTURAL_SELECTOR).length;
    const marked = document.querySelectorAll(`.${REPLY_COUNT_CLASS}`).length;
    diagStats.buttons = Math.max(diagStats.buttons, buttons);
    diagStats.structural = Math.max(diagStats.structural, structural);
    diagStats.marked = Math.max(diagStats.marked, marked);
    const html = document.documentElement;
    html.setAttribute(
      'data-quietsky-replydiag',
      `hideComments=${hideComments ? 'on' : 'off'} replyBtns=${diagStats.buttons} structuralCounts=${diagStats.structural} markedCounts=${diagStats.marked}`,
    );
    if (!diagnosticLogged && diagStats.buttons > 0) {
      diagnosticLogged = true;
      console.info(
        '[Quietsky] reply-count check:',
        `html.quietsky-hide-comments=${html.classList.contains('quietsky-hide-comments')}`,
        `replyBtns=${diagStats.buttons}`,
        `structuralCounts=${diagStats.structural}`,
        `taggedCounts=${diagStats.marked}`,
        `(see html[data-quietsky-replydiag])`,
      );
    }
  }

  function markPost(el) {
    el.classList.add(POST_CLASS);
    const handle = handleFromTestId(el);
    const did = didFromAvatar(el);
    const authorHref = authorHrefInPost(el);
    const own =
      isSelfActor(handle) || isSelfActor(did) || isSelfActor(authorHref);
    el.classList.toggle(OWN_CLASS, own);
    // Whitelist is evaluated for every post and only affects reply counts.
    const whitelisted =
      isWhitelistedActor(handle) ||
      isWhitelistedActor(did) ||
      isWhitelistedActor(authorHref);
    el.classList.toggle(WHITELIST_CLASS, whitelisted);
  }

  function markAllPosts(root = document) {
    if (!isMarkingActive()) return;
    // Re-read self if still unknown so late BSKY_STORAGE / shell avatar works.
    if (showOwnOnly && selfActors.size === 0) refreshSelf();

    findAndMarkReplyCounts(root);

    for (const el of root.querySelectorAll?.(POST_SELECTOR) || []) {
      markPost(el);
    }
    if (root.nodeType === 1) {
      if (root.matches?.(POST_SELECTOR)) {
        markPost(root);
      } else {
        const ownerPost = root.closest?.(POST_SELECTOR);
        if (ownerPost) markPost(ownerPost);
      }
    }
  }

  function clearMarks() {
    for (const el of document.querySelectorAll(`.${POST_CLASS}`)) {
      el.classList.remove(POST_CLASS, OWN_CLASS, WHITELIST_CLASS);
    }
    for (const el of document.querySelectorAll(`.${REPLY_COUNT_CLASS}`)) {
      el.classList.remove(REPLY_COUNT_CLASS);
    }
  }

  function remarkAll() {
    if (!isMarkingActive()) return;
    if (showOwnOnly) refreshSelf();
    markAllPosts();
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;
    const obs = new MutationObserver((mutations) => {
      if (!isMarkingActive()) return;
      let needMark = false;
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) {
              // Element subtree — the common React feed-insert path.
              needMark = true;
              markAllPosts(node);
            } else if (node.nodeType === 3) {
              // Text node inserted later (e.g. React fills count text).
              const owner = node.parentElement?.closest?.(REPLY_BTN_SELECTOR);
              if (owner) {
                needMark = true;
                markAllPosts(owner);
              }
            }
          }
        } else if (m.type === 'characterData') {
          // React may update an existing count via textContent / nodeValue.
          const owner = m.target.parentElement?.closest?.(REPLY_BTN_SELECTOR);
          if (owner) {
            needMark = true;
            markAllPosts(owner);
          }
        }
      }
      // Shell avatar may appear after posts — refresh self occasionally.
      if (needMark && showOwnOnly && selfActors.size === 0) {
        remarkAll();
      }
    });
    const target = document.body || document.documentElement;
    obs.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  /** Stop the periodic fallback sweep. */
  function stopSweep() {
    if (sweepTimer != null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  /**
   * Periodic safety net: React virtualized lists recycle DOM nodes and can
   * leave newly-created counts untagged. Re-marking the whole document is
   * idempotent and cheap enough at this cadence.
   */
  function startSweep() {
    stopSweep();
    if (!hideComments) return;
    sweepTimer = setInterval(() => {
      if (!isMarkingActive()) return;
      markAllPosts();
      refreshDiagnostic();
    }, SWEEP_INTERVAL_MS);
  }

  function stopRetry() {
    if (retryTimer != null) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  function startRetryUntilSelf() {
    stopRetry();
    if (!showOwnOnly) return;
    let attempts = 0;
    retryTimer = setInterval(() => {
      attempts += 1;
      const ok = refreshSelf();
      markAllPosts();
      if (ok || attempts >= 20) stopRetry();
    }, 500);
  }

  async function load() {
    const data = await chrome.storage.sync.get(DEFAULTS);
    const settings = { ...DEFAULTS, ...data };
    showOwnOnly = Boolean(settings.showOwnOnly);
    hideComments = settings.hideComments !== false;
    applyClasses(settings);
    setCommentWhitelist(settings.commentWhitelist);

    if (isMarkingActive()) {
      if (showOwnOnly) refreshSelf();
      markAllPosts();
      startObserver();
      if (hideComments) {
        refreshDiagnostic();
        startSweep();
      } else {
        stopSweep();
      }
      if (showOwnOnly) {
        startRetryUntilSelf();
      } else {
        stopRetry();
      }
    } else {
      stopRetry();
      stopSweep();
      clearMarks();
    }
    // Clear the diagnostic attribute on every hideComments-off path, whether
    // or not showOwnOnly keeps the marking machinery active (otherwise a
    // stale "hideComments=on" value would linger and mislead self-checks).
    if (!hideComments) {
      document.documentElement.removeAttribute('data-quietsky-replydiag');
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (!KEYS.some((key) => key in changes)) return;
    load();
  });

  // Account switch / session write from another tab
  window.addEventListener('storage', (e) => {
    if (!showOwnOnly) return;
    if (e.key && e.key !== BSKY_STORAGE_KEY) return;
    remarkAll();
  });

  // Same-tab writes don't fire `storage`; refresh on focus while marking is on.
  window.addEventListener('focus', () => {
    if (isMarkingActive()) remarkAll();
  });

  load();
})();
