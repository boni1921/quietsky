(() => {
  'use strict';

  const STORAGE_KEY = 'BSKY_STORAGE';
  const DEFAULT_PDS = 'https://bsky.social';
  const FOR_YOU_DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
  // Generator service from getFeedGenerator, not the bsky.app account DID.
  // That account has no #bsky_fg service, so proxying to it fails with
  // "could not resolve proxy did service url".
  const FOR_YOU_PROXY = 'did:web:discover.bsky.app#bsky_fg';
  const FOR_YOU_FEED = `at://${FOR_YOU_DID}/app.bsky.feed.generator/whats-hot`;
  // Native menu press. Set false to use sendInteractions again.
  const USE_NATIVE_MENU = true;
  const SILENT_CLASS = 'quietsky-feedback-silent';
  const NATIVE_ITEM = {
    more: 'postDropdownShowMoreBtn',
    less: 'postDropdownShowLessBtn',
  };

  const POST_SELECTOR = '[data-testid^="feedItem-by-"]';
  const HOST_CLASS = 'quietsky-feedback-host';
  const META_CLASS = 'quietsky-feedback-meta';
  const GROUP_CLASS = 'quietsky-feedback';
  const LESS_CLASS = 'quietsky-feedback-less';
  const NOTE_CLASS = 'quietsky-feedback-note';

  const MORE_EVENT = 'app.bsky.feed.defs#requestMore';
  const LESS_EVENT = 'app.bsky.feed.defs#requestLess';

  const ICON_UP =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/></svg>';
  const ICON_DOWN =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>';

  /** @type {Set<string>} */
  const lessUris = new Set();
  /** @type {Set<string>} */
  const moreUris = new Set();
  /** @type {Set<string>} */
  const inflight = new Set();

  let scheduled = false;
  let quickReactions = false;

  function isWhatsHotPath(path) {
    return /^\/profile\/(?:bsky\.app|did:plc:z72i7hdynmk6r22z27h6tvur)\/feed\/whats-hot\/?$/.test(
      path,
    );
  }

  /**
   * Home Discover is labeled Discover or For You. The document title tracks
   * the selected home tab, so other pinned feeds on `/` stay undecorated.
   */
  function isForYouPage() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    if (isWhatsHotPath(path)) return true;
    if (path !== '/') return false;
    const title = document.title.replace(/^\(\d+\)\s*/, '');
    return /^(?:Discover|For You)(?:\s|$|[—–\-|])/.test(title);
  }

  function sessionAuth() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const session = data?.session;
      if (!session) return null;
      const current = session.currentAccount;
      const accounts = Array.isArray(session.accounts) ? session.accounts : [];
      const did = current?.did ? String(current.did) : null;
      const account =
        (did &&
          accounts.find(
            (a) => String(a?.did || '').toLowerCase() === did.toLowerCase(),
          )) ||
        (accounts.length === 1 ? accounts[0] : null);
      const accessJwt = account?.accessJwt || current?.accessJwt;
      if (!accessJwt) return null;
      const pds = String(
        account?.pdsUrl || account?.service || current?.service || DEFAULT_PDS,
      ).replace(/\/$/, '');
      return { accessJwt, pds };
    } catch {
      return null;
    }
  }

  function feedContextOf(el) {
    return (el.getAttribute('data-feed-context') || '').trim();
  }

  function didFromAvatar(root) {
    const img =
      root.querySelector?.('[data-testid="userAvatarImage"] img[src]') ||
      root.querySelector?.('img[src*="/did:"]');
    const src = img?.getAttribute('src') || '';
    const match = src.match(/\/(did:[^/]+)\//i);
    return match ? match[1] : null;
  }

  function postUri(el) {
    const link = [...(el.querySelectorAll?.('a[href*="/post/"]') || [])].find(
      (a) => /\/post\/[^/?#]+/.test(a.getAttribute('href') || ''),
    );
    const href = link?.getAttribute('href') || '';
    const rkey = href.match(/\/post\/([^/?#]+)/)?.[1];
    const did = didFromAvatar(el);
    if (!rkey || !did) return null;
    return `at://${did}/app.bsky.feed.post/${rkey}`;
  }

  function headerRow(card) {
    const time = [...card.querySelectorAll('a[href*="/post/"]')].find((a) =>
      /\/post\/[^/?#]+/.test(a.getAttribute('href') || ''),
    );
    // Name cluster, then the full header row (display name, handle, time).
    const row = time?.parentElement?.parentElement;
    if (!row || row === card || !card.contains(row)) return null;
    return row;
  }

  function stopNav(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function makeButton(kind, label, icon) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quietsky-feedback-btn';
    button.dataset.quietskyFeedback = kind;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'false');
    button.title = label;
    button.innerHTML = icon;
    for (const type of ['pointerdown', 'mousedown', 'auxclick']) {
      button.addEventListener(type, stopNav, true);
    }
    button.addEventListener(
      'click',
      (event) => {
        stopNav(event);
        const card = button.closest(POST_SELECTOR);
        if (card) onPress(card, kind);
      },
      true,
    );
    return button;
  }

  function ensureButtons(el) {
    el.classList.add(HOST_CLASS);
    const row = headerRow(el);
    if (!row) return null;
    row.classList.add(META_CLASS);

    let group = el.querySelector(`.${GROUP_CLASS}`);
    if (!group) {
      group = document.createElement('div');
      group.className = GROUP_CLASS;
      group.append(
        makeButton('more', 'Show more like this', ICON_UP),
        makeButton('less', 'Show less like this', ICON_DOWN),
      );
    }
    if (group.parentElement !== row) row.append(group);
    return group;
  }

  function ensureNote(el) {
    let note = el.querySelector(`:scope > .${NOTE_CLASS}`);
    if (!note) {
      note = document.createElement('p');
      note.className = NOTE_CLASS;
      note.textContent = 'Feedback sent';
      el.append(note);
    }
    return note;
  }

  function applyPressed(el, uri) {
    const more = el.querySelector('[data-quietsky-feedback="more"]');
    if (!more) return;
    const on = moreUris.has(uri);
    more.setAttribute('aria-pressed', on ? 'true' : 'false');
    more.disabled = inflight.has(`${uri}:more`);
    const less = el.querySelector('[data-quietsky-feedback="less"]');
    if (less) less.disabled = inflight.has(`${uri}:less`);
  }

  function applyLess(el) {
    el.classList.add(LESS_CLASS);
    ensureNote(el);
  }

  function clearCard(el) {
    el.classList.remove(HOST_CLASS, LESS_CLASS);
    el.querySelector(`.${GROUP_CLASS}`)?.remove();
    el.querySelector(`:scope > .${NOTE_CLASS}`)?.remove();
    el.querySelector(`.${META_CLASS}`)?.classList.remove(META_CLASS);
  }

  async function sendInteraction(uri, feedContext, event) {
    const auth = sessionAuth();
    if (!auth) throw new Error('no session');
    const res = await fetch(`${auth.pds}/xrpc/app.bsky.feed.sendInteractions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessJwt}`,
        'Content-Type': 'application/json',
        'atproto-proxy': FOR_YOU_PROXY,
      },
      body: JSON.stringify({
        feed: FOR_YOU_FEED,
        interactions: [
          {
            item: uri,
            event,
            feedContext,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`sendInteractions ${res.status}`);
  }

  function setSilent(on) {
    document.documentElement.classList.toggle(SILENT_CLASS, on);
  }

  function openMenuItem(testId) {
    const menu = document.querySelector(
      '[role="menu"].dropdown-menu-transform-origin',
    );
    return menu?.querySelector(`[data-testid="${testId}"]`) || null;
  }

  function waitForMenuItem(testId, timeout = 1500) {
    const found = openMenuItem(testId);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        const item = openMenuItem(testId);
        if (!item) return;
        obs.disconnect();
        clearTimeout(timer);
        resolve(item);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(openMenuItem(testId));
      }, timeout);
    });
  }

  function dismissOpenMenu() {
    if (!document.querySelector('[role="menu"].dropdown-menu-transform-origin')) {
      return;
    }
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
      }),
    );
  }

  async function pressNativeMenu(card, kind) {
    const testId = NATIVE_ITEM[kind];
    const trigger = card.querySelector('[data-testid="postDropdownBtn"]');
    if (!trigger) throw new Error('no menu');
    setSilent(true);
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      let item = openMenuItem(testId);
      if (!item) {
        trigger.click();
        item = await waitForMenuItem(testId);
      }
      if (!item) throw new Error('missing item');
      item.click();
      await pause(50);
    } finally {
      dismissOpenMenu();
      await pause(50);
      if (document.querySelector('[role="menu"].dropdown-menu-transform-origin')) {
        trigger.click();
        await pause(50);
      }
    }
  }

  async function onPress(el, kind) {
    if (USE_NATIVE_MENU) {
      const button = el.querySelector(`[data-quietsky-feedback="${kind}"]`);
      const key = `${postUri(el) || 'card'}:${kind}`;
      if (inflight.has(key)) return;
      inflight.add(key);
      if (button) button.disabled = true;
      try {
        await pressNativeMenu(el, kind);
      } catch {
        if (button) button.title = "Couldn't open menu";
      } finally {
        inflight.delete(key);
        if (button && button.isConnected) button.disabled = false;
        setSilent(false);
      }
      return;
    }

    const uri = postUri(el);
    const feedContext = feedContextOf(el);
    if (!uri || !feedContext || !isForYouPage()) return;
    if (lessUris.has(uri)) return;
    const key = `${uri}:${kind}`;
    if (inflight.has(key)) return;

    const event = kind === 'less' ? LESS_EVENT : MORE_EVENT;
    inflight.add(key);
    applyPressed(el, uri);
    const button = el.querySelector(`[data-quietsky-feedback="${kind}"]`);
    if (button) button.title = kind === 'less' ? 'Show less like this' : 'Show more like this';

    try {
      await sendInteraction(uri, feedContext, event);
      if (kind === 'less') {
        lessUris.add(uri);
        applyLess(el);
      } else {
        moreUris.add(uri);
        applyPressed(el, uri);
      }
    } catch {
      if (button) button.title = "Couldn't send feedback";
      applyPressed(el, uri);
    } finally {
      inflight.delete(key);
      applyPressed(el, uri);
    }
  }

  async function loadSettings() {
    const data = await chrome.storage.sync.get({ quickReactions: false });
    quickReactions = data.quickReactions === true;
    schedule();
  }

  function scan() {
    const onPage = quickReactions && isForYouPage() && Boolean(sessionAuth());
    for (const el of document.querySelectorAll(POST_SELECTOR)) {
      const context = feedContextOf(el);
      const uri = postUri(el);
      if (!onPage || !context || !uri) {
        if (el.classList.contains(HOST_CLASS) || el.querySelector(`.${GROUP_CLASS}`)) {
          clearCard(el);
        }
        continue;
      }
      ensureButtons(el);
      if (lessUris.has(uri)) applyLess(el);
      else el.classList.remove(LESS_CLASS);
      applyPressed(el, uri);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  }

  function hookHistory() {
    for (const method of ['pushState', 'replaceState']) {
      const orig = history[method];
      if (!orig || orig.__quietskyFeedback) continue;
      const wrapped = function (...args) {
        const result = orig.apply(this, args);
        schedule();
        return result;
      };
      wrapped.__quietskyFeedback = true;
      history[method] = wrapped;
    }
  }

  hookHistory();
  window.addEventListener('popstate', schedule);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target;
      if (
        target.nodeName === 'TITLE' ||
        target.parentElement?.nodeName === 'TITLE'
      ) {
        schedule();
        return;
      }
      if (mutation.type === 'childList') {
        schedule();
        return;
      }
      const el = target.nodeType === 1 ? target : target.parentElement;
      if (el && (el.matches?.(POST_SELECTOR) || el.closest?.(POST_SELECTOR))) {
        schedule();
        return;
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-feed-context', 'data-testid', 'src'],
  });
  const titleEl = document.querySelector('title');
  if (titleEl) {
    observer.observe(titleEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.quickReactions) return;
    quickReactions = changes.quickReactions.newValue === true;
    schedule();
  });

  loadSettings();
})();
