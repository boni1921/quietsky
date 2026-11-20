const KEYS = [
  'hideLikes',
  'hideReposts',
  'hideBookmarks',
  'hideComments',
  'showOwnOnly',
  'quickReactions',
  'autoRenewMutes',
];
const DEFAULTS = {
  hideLikes: true,
  hideReposts: true,
  hideBookmarks: true,
  hideComments: true,
  showOwnOnly: false,
  quickReactions: false,
  autoRenewMutes: true,
  commentWhitelist: [],
};

const whitelistEl = document.getElementById('commentWhitelist');
let whitelistDirty = false;

/** Split the textarea into a clean, unique list of handles / DIDs. */
function parseWhitelist(text) {
  const seen = new Set();
  const result = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}

function whitelistToText(list) {
  return Array.isArray(list) ? list.join('\n') : '';
}

async function load() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  for (const key of KEYS) {
    const el = document.getElementById(key);
    if (key === 'showOwnOnly' || key === 'quickReactions') {
      el.checked = Boolean(data[key]);
    } else {
      el.checked = data[key] !== false;
    }
  }
  // Never clobber text the user is currently typing or has already edited.
  if (!whitelistDirty && document.activeElement !== whitelistEl) {
    whitelistEl.value = whitelistToText(data.commentWhitelist);
  }
}

for (const key of KEYS) {
  document.getElementById(key).addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ [key]: e.target.checked });
  });
}

whitelistEl.addEventListener('input', async () => {
  whitelistDirty = true;
  await chrome.storage.sync.set({
    commentWhitelist: parseWhitelist(whitelistEl.value),
  });
});

load();

const countEl = document.getElementById('expired-count');
const listEl = document.getElementById('expired-list');
const muteStatusEl = document.getElementById('mute-status');
const muteActionsEl = document.getElementById('mute-actions');
const viewBtn = document.getElementById('view-expired');
const renewBtn = document.getElementById('renew-all');
const openModerationBtn = document.getElementById('open-moderation');

function formatExpiry(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toLocaleString();
}

function renderScan(scan) {
  const expired = Array.isArray(scan?.expired) ? scan.expired : [];
  countEl.textContent = `${expired.length} expired`;
  listEl.replaceChildren(
    ...expired.map((word) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = word.value || '(empty)';
      const when = document.createElement('small');
      when.textContent = formatExpiry(word.expiresAt);
      li.append(name, when);
      return li;
    }),
  );
  const hasExpired = expired.length > 0;
  muteActionsEl.hidden = !hasExpired;
  if (!hasExpired) {
    listEl.classList.remove('open');
    viewBtn.textContent = 'View';
  } else {
    renewBtn.disabled = false;
  }
  muteStatusEl.classList.toggle('error', Boolean(scan?.error));
  muteStatusEl.textContent = scan?.error || '';
}

async function loadScan() {
  const data = await chrome.storage.local.get('mutedWordScan');
  renderScan(data.mutedWordScan);
}

async function bskyTab() {
  const tabs = await chrome.tabs.query({ url: 'https://bsky.app/*' });
  return tabs.find((tab) => tab.id != null) || null;
}

openModerationBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://bsky.app/moderation' });
});

viewBtn.addEventListener('click', () => {
  const open = listEl.classList.toggle('open');
  viewBtn.textContent = open ? 'Hide' : 'View';
});

renewBtn.addEventListener('click', async () => {
  const tab = await bskyTab();
  if (!tab) {
    muteStatusEl.classList.add('error');
    muteStatusEl.textContent = 'Open bsky.app first';
    return;
  }
  renewBtn.disabled = true;
  muteStatusEl.classList.remove('error');
  muteStatusEl.textContent = 'Renewing…';
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: 'quietsky-renew-mutes',
    });
    if (!res?.ok) {
      muteStatusEl.classList.add('error');
      muteStatusEl.textContent = res?.error || 'Renew failed';
      renewBtn.disabled = false;
      return;
    }
    renderScan(res.result);
    muteStatusEl.classList.remove('error');
    muteStatusEl.textContent = 'Renewed';
  } catch (err) {
    muteStatusEl.classList.add('error');
    muteStatusEl.textContent = 'Open bsky.app and reload it';
    renewBtn.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mutedWordScan) {
    renderScan(changes.mutedWordScan.newValue);
  }
});

loadScan();
