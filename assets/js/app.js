/**
 * Swiggy Pro — SPA Engine
 * Tabs: home · address · cart · orders · tools
 */

let state = {
    theme: 'light',
    activeTab: 'home',
    sessions: [],
    activeMobile: null,
    activeSession: null,
    addresses: [],
    orders: [],
    activeOrderTagFilter: 'ALL',
    accessKey: ''
};

const TAB_INDEX = { home: 0, address: 1, 'add-address': 1, search: 2, cart: 3, orders: 4, tools: 5, offers: 5 };

/* ── INIT ──────────────────────────────────────────── */

/* ── AUTH (access key / Telegram mini app) ─────────── */

const KEY_STORAGE = 'swiggy_access_key';
// path the app is served under ('' at the root, '/swiggy_web' behind the VPS proxy)
const BASE_PATH = location.pathname.replace(/\/[^/]*$/, '');
const _origFetch = window.fetch.bind(window);
const _rawFetch = (url, opts) => _origFetch(typeof url === 'string' && url.startsWith('/api/') ? BASE_PATH + url : url, opts);

// a request that never answers must not freeze the app: give up after `ms`
const _nativeFetch = (url, opts = {}, ms = 20000) => {
    if (opts.signal) return _rawFetch(url, opts);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return _rawFetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
};
window.fetch = (url, opts = {}) => {
    if (typeof url === 'string' && url.startsWith('/api/')) {
        if (state.accessKey) opts = { ...opts, headers: { ...(opts.headers || {}), 'x-user-key': state.accessKey } };
        return _nativeFetch(url, opts, 60000);
    }
    return _rawFetch(url, opts);
};

function hideAppLoader() {
    const loader = document.getElementById('appLoader');
    if (!loader || loader.style.display === 'none') return;
    loader.style.opacity = '0';
    loader.style.transition = 'opacity 0.4s ease';
    setTimeout(() => loader.style.display = 'none', 400);
}

async function _validateKey(key) {
    try {
        const res = await _nativeFetch('/api/auth/validate_key/' + encodeURIComponent(key));
        const data = await res.json();
        return data.valid ? data.access_key : null;
    } catch { return 'NET'; }   // server unreachable / too slow: not the same as a wrong key
}

async function ensureAuth() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initData) {
        try {
            tg.ready(); tg.expand();
            const res = await _nativeFetch('/api/auth/validate_webapp', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ init_data: tg.initData })
            });
            const data = await res.json();
            if (data.valid && data.access_key) { state.accessKey = data.access_key; localStorage.setItem(KEY_STORAGE, data.access_key); return true; }
        } catch {}
    }
    const saved = localStorage.getItem(KEY_STORAGE);
    if (saved) {
        const ok = await _validateKey(saved);
        if (ok === 'NET') { state.accessKey = saved; showToast('Server is slow to answer, retrying…', true, 1500); return true; }
        if (ok) { state.accessKey = ok; return true; }
        localStorage.removeItem(KEY_STORAGE);
    }
    document.getElementById('authGate').style.display = 'flex';
    return false;
}

async function submitAuthKey() {
    const input = document.getElementById('authKeyInput');
    const err = document.getElementById('authGateError');
    const ok = await _validateKey((input.value || '').trim().toUpperCase());
    if (ok === 'NET') { err.textContent = 'Cannot reach the server. Check your connection and try again.'; return; }
    if (!ok) { err.textContent = 'Invalid access key. Get yours from the bot.'; return; }
    localStorage.setItem(KEY_STORAGE, ok);
    location.reload();
}

/* ── MAINTENANCE (polled so the web reflects /mode) ── */

async function pollMaintenance() {
    try {
        const res = await _nativeFetch('/api/maintenance');
        const data = await res.json();
        document.getElementById('maintenanceOverlay').style.display = data.maintenance ? 'flex' : 'none';
    } catch {}
}

document.addEventListener('DOMContentLoaded', async () => {
    setTimeout(hideAppLoader, 12000);   // whatever happens below, never stay on the loader
    try {
        await bootApp();
    } catch (e) {
        console.error('boot failed', e);
        showToast('Something went wrong while loading, try refreshing', true, 1500);
    } finally {
        hideAppLoader();
    }
});

async function bootApp() {
    initTheme();
    pollMaintenance();
    setInterval(pollMaintenance, 60000);   // once a minute is enough; this was ~1 req/s on the server with many tabs open
    if (!(await ensureAuth())) return;
    // read the tab from the URL first: loading the sessions re-renders the current tab and would overwrite the hash
    // Check URL hash navigation (#accounts, #address, #cart, #orders, #offers, #tools)
    const initialHash = (new URLSearchParams(window.location.search).get('tab') || window.location.hash || '').replace('#', '').trim();
    state.activeTab = 'home';
    await loadSavedSessions();

    const validTabs = ['home', 'accounts', 'address', 'add-address', 'search', 'cart', 'orders', 'offers', 'tools'];
    let startTab = 'home';
    if (initialHash === 'payment' || initialHash === 'success') {
        startTab = 'cart';
    } else if (initialHash && validTabs.includes(initialHash)) {
        startTab = initialHash === 'accounts' ? 'home' : initialHash;
    }
    switchTab(startTab, true);

    window.addEventListener('hashchange', () => {
        const curHash = (window.location.hash || '').replace('#', '').trim();
        if (curHash && validTabs.includes(curHash)) {
            const targetTab = curHash === 'accounts' ? 'home' : curHash;
            if (targetTab !== state.activeTab) {
                switchTab(targetTab, false);
            }
        }
    });

}

/* ── THEME ─────────────────────────────────────────── */

function initTheme() {
    setTheme(localStorage.getItem('swiggy_theme') || 'light');
}

function toggleTheme() {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function setTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('swiggy_theme', state.theme);
    const icon = document.querySelector('#themeToggleBtn i');
    if (icon) icon.className = state.theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#0b1220' : '#38bdf8');
}

/* ── LOGIN TAB SWITCHER ────────────────────────────── */

/* ── TAB NAV ───────────────────────────────────────── */

function switchTab(tabId, updateHash = true) {
    state.activeTab = tabId;

    if (updateHash) {
        const hashVal = tabId === 'home' ? 'accounts' : tabId;
        if (window.location.hash !== '#' + hashVal) {
            history.replaceState(null, '', '#' + hashVal);
        }
    }

    const header = document.querySelector('.app-header');
    if (header) {
        if (tabId === 'add-address') {
            header.style.display = 'none';
        } else {
            header.style.display = 'flex';
        }
    }

    document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${tabId}`);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const mainNavId = tabId === 'add-address' ? 'address' : tabId;
    const navBtn = document.getElementById(`nav-${mainNavId}`);
    if (navBtn) navBtn.classList.add('active');

    if (tabId === 'tools')       renderToolsPage();
    if (tabId === 'offers')      renderToolsView();
    if (tabId === 'address')     fetchAddressesForActiveAccount(true);
    if (tabId === 'add-address') initAddAddressPageMap();
    if (tabId === 'cart')        renderCartView();
    if (tabId === 'orders')      fetchOrdersForActiveAccount();
}

/* ── LOADER & TOAST ────────────────────────────────── */

let TOAST_TIMER = null;

function showLoader(show, text = "swiggy pro") {
    const loader = document.getElementById("appLoader");
    const msgEl = document.querySelector(".loader-msg");
    if (!loader) return;
    if (msgEl && text) msgEl.innerText = text;
    if (show) {
        loader.style.display = "flex";
        loader.style.opacity = "1";
    } else {
        loader.style.opacity = "0";
        setTimeout(() => loader.style.display = "none", 300);
    }
}

function showToast(msg, isErrorOrIcon = false, duration = 1000, keepDuration = false) {
    if (!keepDuration) duration = Math.max(duration, 3000);   // every notification stays at least 3 seconds
    const popup = document.getElementById("topToastNotification");
    const msgEl = document.getElementById("topToastMsg");
    const iconBox = document.getElementById("topToastIconBox");
    const iconEl = document.getElementById("topToastIcon");
    const progressEl = document.getElementById("topToastProgress");

    let isError = false;
    let customIcon = null;

    if (typeof isErrorOrIcon === 'boolean') {
        isError = isErrorOrIcon;
    } else if (typeof isErrorOrIcon === 'string') {
        const lower = isErrorOrIcon.toLowerCase();
        if (lower.includes('xmark') || lower.includes('exclamation') || lower.includes('triangle') || lower.includes('error') || lower.includes('danger')) {
            isError = true;
        } else {
            isError = false;
        }
        if (isErrorOrIcon.startsWith('fa-')) {
            customIcon = isErrorOrIcon;
        }
    }

    if (popup && msgEl) {
        msgEl.innerText = msg;
        if (iconBox && iconEl) {
            if (isError) {
                iconBox.style.background = "rgba(239, 68, 68, 0.14)";
                iconBox.style.color = "#ef4444";
                iconEl.className = customIcon ? `fa-solid ${customIcon}` : "fa-solid fa-circle-xmark";
                if (progressEl) progressEl.style.background = "#ef4444";
            } else {
                iconBox.style.background = "rgba(16, 185, 129, 0.14)";
                iconBox.style.color = "#10b981";
                iconEl.className = customIcon ? `fa-solid ${customIcon}` : "fa-solid fa-circle-check";
                if (progressEl) progressEl.style.background = "#10b981";
            }
        }
        if (progressEl) {
            progressEl.style.transition = "none";
            progressEl.style.width = "100%";
        }

        popup.classList.add("show");

        if (TOAST_TIMER) clearTimeout(TOAST_TIMER);

        setTimeout(() => {
            if (progressEl) {
                progressEl.style.transition = `width ${duration}ms linear`;
                progressEl.style.width = "0%";
            }
        }, 10);

        TOAST_TIMER = setTimeout(() => {
            popup.classList.remove("show");
        }, duration);
    } else {
        const container = document.getElementById("toast-container");
        if (container) {
            const toast = document.createElement("div");
            toast.className = "toast";
            if (isError) toast.style.borderLeft = "4px solid #ef4444";
            else toast.style.borderLeft = "4px solid var(--swiggy-blue)";
            toast.innerHTML = `<span>${msg}</span>`;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = "0";
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }
    }
}

function formatRawServerError(data, fallbackMsg = "Operation failed") {
    if (!data) return fallbackMsg;
    if (typeof data === 'string') return data;

    let parts = [];
    if (data.statusMessage) parts.push(data.statusMessage);
    if (data.error) parts.push(data.error);
    if (data.message) parts.push(data.message);
    if (data.detail) parts.push(data.detail);

    if (data.raw) {
        if (typeof data.raw === 'string') parts.push(data.raw);
        else if (typeof data.raw === 'object') {
            const rawMsg = data.raw.statusMessage || data.raw.message || data.raw.error || JSON.stringify(data.raw);
            parts.push("Raw: " + rawMsg);
        }
    }

    if (parts.length === 0) {
        try {
            return JSON.stringify(data);
        } catch (e) {
            return fallbackMsg;
        }
    }

    return Array.from(new Set(parts)).join(" | ");
}

/* ── ACCOUNT SELECTOR MODAL ────────────────────────── */

let SHEET_ACCOUNT_FILTER = 'all';
let SHEET_SEARCH_QUERY = '';

function setSheetAccountFilter(filterName) {
    SHEET_ACCOUNT_FILTER = filterName;
    document.querySelectorAll('.sheet-acc-tabs .acc-tab').forEach(b => b.classList.toggle('on', b.dataset.stab === filterName));
    renderAccountSelectorModalList();
}

function filterAccountsInSheet(q) {
    SHEET_SEARCH_QUERY = (q || '').toLowerCase().trim();
    const clearBtn = document.getElementById('sheetClearSearchBtn');
    if (clearBtn) clearBtn.style.display = SHEET_SEARCH_QUERY ? 'block' : 'none';
    renderAccountSelectorModalList();
}

function clearSheetSearch() {
    const input = document.getElementById('sheetAccountSearchInput');
    if (input) input.value = '';
    SHEET_SEARCH_QUERY = '';
    const clearBtn = document.getElementById('sheetClearSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    renderAccountSelectorModalList();
}

function openAccountSelectorModal() {
    SHEET_SEARCH_QUERY = '';
    SHEET_ACCOUNT_FILTER = 'all';
    const input = document.getElementById('sheetAccountSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('sheetClearSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';

    setSheetAccountFilter('all');   // also draws the list
    document.getElementById('accountSelectorModal').style.display = 'flex';
}

// same cards, search and All / Fresh / Used tabs as the Saved Accounts page
function renderAccountSelectorModalList() {
    const filtered = state.sessions.filter(s => {
        if (SHEET_ACCOUNT_FILTER === 'used' && !accIsOrdered(s)) return false;
        if (SHEET_ACCOUNT_FILTER === 'fresh' && (accIsOrdered(s) || accIsExpired(s))) return false;
        if (!SHEET_SEARCH_QUERY) return true;
        const mob = String(s.mobile || s.phone || '').toLowerCase();
        const nm = String(s.name || '').toLowerCase();
        return mob.includes(SHEET_SEARCH_QUERY) || nm.includes(SHEET_SEARCH_QUERY);
    });
    _renderAccountCards('modalAccountList', filtered);
}

function closeAccountSelectorModal(e) {
    if (e && e.target !== e.currentTarget) return;
    const modal = document.getElementById('accountSelectorModal');
    if (modal) modal.style.display = 'none';
}

/* ── SESSIONS ──────────────────────────────────────── */

async function loadSavedSessions() {
    try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        if (data.success) {
            state.sessions = data.sessions || [];
            updateAccountHeaderUI();
            renderAccountsList();
        }
    } catch { showToast('Cannot connect to backend', true); }
}

async function setActiveAccount(mobile, skipVerification = false) {
    const session = state.sessions.find(s => String(s.mobile) === String(mobile));
    if (session) {
        if (session.is_expired || session.status === 'expired' || session.valid === false) {
            showToast(`Session expired for +91 ${mobile}`, true);
            _autoFallbackToNextValidSession(mobile);
            return;
        }

        state.activeMobile = mobile;
        state.activeSession = session;
        if (window.srAccountChanged) srAccountChanged(mobile);   // new account: fresh search, cart and addresses
        showToast(`Switched to +91 ${mobile}`, false);

        if (!skipVerification) {
            verifySessionSilently(mobile);
        }
    } else {
        state.activeMobile = null;
        state.activeSession = null;
    }
    updateAccountHeaderUI();
    renderAccountsList();
    closeAccountSelectorModal();
    switchTab(state.activeTab);
}

async function verifySessionSilently(mobile) {
    try {
        const res = await fetch(`/api/profile/${mobile}`);
        const data = await res.json();
        const session = state.sessions.find(s => String(s.mobile) === String(mobile));
        if (session) {
            if (!data.success || data.expired) {
                session.is_expired = true;
                session.status = 'expired';
                showToast(`Session expired for +91 ${mobile}`, true);
                renderAccountsList();
                updateAccountHeaderUI();
                _autoFallbackToNextValidSession(mobile);
            }
        }
    } catch (e) {
        console.error("Silent session verification error:", e);
    }
}

function _autoFallbackToNextValidSession(currentExpiredMobile) {
    const validSession = state.sessions.find(s => 
        String(s.mobile) !== String(currentExpiredMobile) && 
        !s.is_expired && 
        s.status !== 'expired' && 
        s.valid !== false
    );
    if (validSession) {
        showToast(`Auto-switched to active account +91 ${validSession.mobile}`, false);
        setActiveAccount(validSession.mobile, true);
    } else {
        state.activeMobile = null;
        state.activeSession = null;
        updateAccountHeaderUI();
        renderAccountsList();
    }
}

function updateAccountHeaderUI() {
    const badge = document.getElementById('headerAccountDisplay');
    if (!badge) return;

    if (state.activeSession && state.activeMobile) {
        badge.classList.add('active');
        badge.innerHTML = `<i class="fa-solid fa-user-check" style="color:var(--swiggy-blue); margin-right:4px;"></i>+91 ${state.activeMobile} <i class="fa-solid fa-chevron-down" style="font-size:9px; margin-left:5px; opacity:.6;"></i>`;
    } else if (state.sessions.length > 0) {
        setActiveAccount(state.sessions[0].mobile);
    } else {
        badge.classList.remove('active');
        badge.innerHTML = `<i class="fa-solid fa-user-slash" style="color:var(--text-muted); margin-right:4px;"></i>No Account`;
    }
}

function handleAccountSearchInput(q) {
    const clearBtn = document.getElementById('clearAccountSearchBtn');
    if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
    filterAccounts(q);
}

function clearAccountSearch() {
    const input = document.getElementById('accountSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('clearAccountSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    filterAccounts('');
}

// Saved Accounts tabs: all (default) / fresh / used
let accTab = 'all';
const accIsExpired = s => !!(s.is_expired || s.status === 'expired' || s.valid === false);
const accIsOrdered = s => !!(s.is_done || s.is_ordered || s.status === 'ordered' || s.status === 'done' || (s.orders_count > 0));

function setAccountTab(tab) {
    accTab = tab;
    document.querySelectorAll('.acc-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    const input = document.getElementById('accountSearchInput');
    filterAccounts(input ? input.value : '');
}

function filterAccounts(q) {
    const query = (q || '').toLowerCase().trim();
    const filtered = state.sessions.filter(s => {
        if (accTab === 'used' && !accIsOrdered(s)) return false;
        if (accTab === 'fresh' && (accIsOrdered(s) || accIsExpired(s))) return false;
        if (!query) return true;
        const mob = String(s.mobile || s.phone || '').toLowerCase();
        const nm = String(s.name || '').toLowerCase();
        return mob.includes(query) || nm.includes(query);
    });
    _renderAccountCards('savedAccountsList', filtered);
}

function renderAccountsList() {
    const input = document.getElementById('accountSearchInput');
    filterAccounts(input ? input.value : '');
    const el = document.getElementById('savedAccountsCount');
    if (el) el.textContent = state.sessions.length;
    const tabsRow = document.getElementById('accTabsRow');
    if (tabsRow) tabsRow.style.display = state.sessions.length ? 'flex' : 'none';   // tabs + delete-all only with accounts
    const sheet = document.getElementById('accountSelectorModal');
    if (sheet && sheet.style.display !== 'none') renderAccountSelectorModalList();   // keep an open switcher in sync
}

function _renderAccountCards(elId, sessions) {
    const listEl = document.getElementById(elId);
    if (!listEl) return;

    if (sessions.length === 0) {
        const isSearchFilter = state.sessions.length > 0;
        const titleText = isSearchFilter ? "No Accounts Found" : "No Accounts Logged In";
        const iconSvg = isSearchFilter ? `
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>` : `
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
            </svg>`;

        listEl.innerHTML = `
            <div class="full-page-empty" style="min-height:22vh; padding: 24px 16px;">
                <div class="fpe-ring ${isSearchFilter ? '' : 'big'}">
                    ${iconSvg}
                </div>
                <div class="fpe-title">${titleText}</div>
                ${isSearchFilter ? '<div class="fpe-sub">No saved account matches your search query.</div>' : ''}
            </div>`;
        return;
    }

    // selecting an account never moves it; the server order (newest login first) is kept
    const sorted = [...sessions].sort((a, b) => {
        const aExp = a.is_expired || a.status === 'expired' || a.valid === false;
        const bExp = b.is_expired || b.status === 'expired' || b.valid === false;
        if (aExp && !bExp) return 1;
        if (!aExp && bExp) return -1;

        const aOrd = a.is_done || a.is_ordered || a.status === 'ordered' || a.status === 'done' || (a.orders_count > 0);
        const bOrd = b.is_done || b.is_ordered || b.status === 'ordered' || b.status === 'done' || (b.orders_count > 0);
        if (aOrd && !bOrd) return 1;
        if (!aOrd && bOrd) return -1;

        return 0;
    });

    listEl.innerHTML = sorted.map(s => {
        const isActive = String(s.mobile) === String(state.activeMobile);
        const isExpired = s.is_expired || s.status === 'expired' || s.valid === false;
        const isOrdered = s.is_done || s.is_ordered || s.status === 'ordered' || s.status === 'done' || (s.orders_count > 0);

        let statusClass = isActive ? 'active' : '';
        if (isExpired) statusClass += ' expired';
        else if (isOrdered) statusClass += ' ordered';

        let avatarHtml = `<div class="acc-avatar" title="Saved account"><i class="fa-solid fa-user"></i></div>`;
        if (isExpired) {
            avatarHtml = `<div class="acc-avatar expired" title="Login expired"><i class="fa-solid fa-user-slash"></i></div>`;
        } else if (isOrdered) {
            avatarHtml = `<div class="acc-avatar ordered" title="Has placed an order"><i class="fa-solid fa-user"></i></div>`;
        } else if (isActive) {
            avatarHtml = `<div class="acc-avatar active" title="Active account"><i class="fa-solid fa-user"></i></div>`;
        }

        const titleText = isExpired ? `+91 ${s.mobile}` : (s.name ? s.name : `+91 ${s.mobile}`);
        const subText = isExpired ? '<span style="color:var(--accent-red);">Login expired</span>' : (s.name ? `+91 ${s.mobile}` : `${s.device_model || 'Swiggy Session'}`);

        return `
        <div class="account-card ${statusClass}" onclick="handleAccountCardClick('${s.mobile}', ${isExpired})">
            <div class="acc-main">
                <div class="acc-av-wrap">
                    ${avatarHtml}
                    <span class="acc-tick ${isActive ? 'on' : ''}" title="${isActive ? 'Selected' : 'Select'}"><i class="fa-solid fa-check"></i></span>
                </div>
                <div class="acc-text">
                    <div class="acc-title-text">${titleText}</div>
                    <div class="acc-sub-text">${subText}</div>
                </div>
            </div>
            <div class="acc-actions">
                <div class="acc-fc-col">
                    <button type="button" class="acc-status-toggle ${isOrdered ? 'to-fresh' : 'to-used'}" onclick="toggleAccountUsedStatus('${s.mobile}', ${isOrdered ? 'true' : 'false'}, event)" title="${isOrdered ? 'Mark Fresh' : 'Mark Used'}">
                        <i class="fa-solid ${isOrdered ? 'fa-recycle' : 'fa-bag-shopping'}"></i>${isOrdered ? 'Mark Fresh' : 'Mark Used'}
                    </button>
                    ${isExpired ? '' : `<button type="button" class="acc-status-toggle acc-fc-btn" onclick="checkAccountFc('${s.mobile}', event)" title="Check free cash"><i class="fa-solid fa-wallet"></i>Check FC</button>`}
                </div>
                ${s.key_login ? '' : `<button type="button" class="export-pill-btn icon-only" onclick="exportAccountSession('${s.mobile}', event)" title="Export Session JSON" aria-label="Export">
                    <i class="fa-solid fa-file-export"></i>
                </button>`}
                <button type="button" class="account-card-delete-btn" onclick="deleteAccountSession('${s.mobile}', event)" title="Delete Account">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>`;
    }).join('');
}

function handleAccountCardClick(mobile, isExpired) {
    if (isExpired) {
        showToast(`Session expired for +91 ${mobile}. Please login or import fresh session JSON.`, true);
        return;
    }
    setActiveAccount(mobile);
}

// ─── Custom Confirm Modal (same as blinkit_bot) ───
function customConfirm(title, desc, onOk, okText = "Confirm", onCancel = null, cancelText = "Cancel") {
    const modal = document.getElementById('customConfirmModal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-desc').textContent = desc;
    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    okBtn.innerHTML = okText;
    cancelBtn.innerHTML = cancelText;
    okBtn.onclick = () => { modal.classList.add('hidden'); if (onOk) onOk(); };
    cancelBtn.onclick = () => { modal.classList.add('hidden'); if (onCancel) onCancel(); };
    modal.classList.remove('hidden');
}

// the trash icon: remove from our list, or really delete the Swiggy account (needs an OTP)
function deleteAccountSession(mobile, event) {
    if (event) event.stopPropagation();
    adOpen(mobile);
}

async function removeAccountSession(mobile) {
    try {
        const res = await fetch('/api/accounts/' + encodeURIComponent(mobile), { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) { showToast(data.message || 'Failed to remove', true, 2000); return false; }
        adDropLocal(mobile);
        showToast('Account removed');
        return true;
    } catch (err) {
        showToast('Error: ' + err.message, true, 2000);
        return false;
    }
}

// Manual Used/Fresh toggle on an account card. Flips the same is_done/order_count fields the whole app already
// reads (badge, avatar, tabs, offer sheet), so the card jumps tab instantly with no extra status logic anywhere.
async function toggleAccountUsedStatus(mobile, currentlyUsed, event) {
    if (event) event.stopPropagation();
    const session = state.sessions.find(s => String(s.mobile) === String(mobile));
    if (!session) return;
    const toUsed = !currentlyUsed;
    const prev = { is_done: session.is_done, is_ordered: session.is_ordered, status: session.status, order_count: session.order_count };
    session.is_done = toUsed;
    session.order_count = toUsed ? 1 : 0;
    if (!toUsed) {
        session.is_ordered = false;
        if (session.status === 'ordered' || session.status === 'done') session.status = '';
    }
    renderAccountsList();   // move it to the right tab right away
    try {
        const res = await fetch(`/api/accounts/${encodeURIComponent(mobile)}/${toUsed ? 'mark_used' : 'mark_fresh'}`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || data.detail || 'Failed');
        showToast(toUsed ? `Marked +91 ${mobile} as Used` : `Marked +91 ${mobile} as Fresh`);
    } catch (e) {
        Object.assign(session, prev);   // server rejected it: put the card back
        renderAccountsList();
        showToast('Could not update status: ' + e.message, true, 2500);
    }
}

async function checkAccountFc(mobile, event) {
    if (event) event.stopPropagation();
    const btn = event && event.currentTarget;
    const label = btn ? btn.innerHTML : '';
    if (btn) { if (btn.disabled) return; btn.disabled = true; btn.querySelector('i').className = 'fa-solid fa-rotate fa-spin'; }
    try {
        const res = await fetch('/api/accounts/' + encodeURIComponent(mobile) + '/check_fc', { method: 'POST' });
        const d = await res.json();
        if (!d.success) showToast(d.error || d.detail || 'Could not check FC', true, 3000, true);
        else if (d.fc && d.fc.amount) showToast(`Free cash ₹${d.fc.amount}${d.fc.mov ? ` on ₹${d.fc.mov}` : ''} found`, false, 3000, true);
        else showToast('No free cash found', true, 3000, true);
    } catch (err) {
        showToast('Error: ' + err.message, true, 3000, true);
    }
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
}

// trash icon on the tabs row: remove every account (they all move to the transfer user, same as one by one)
function adAllOpen() {
    if (!state.sessions.length) return;
    customConfirm('Remove all accounts?', 'Do you want to remove your all accounts from Bot?', async () => {
        try {
            const res = await fetch('/api/accounts/remove_all', { method: 'POST' });
            const d = await res.json();
            if (!d.success) { showToast(d.message || 'Failed to remove', true, 2000); return; }
            state.sessions = [];
            state.activeMobile = null;
            state.activeSession = null;
            updateAccountHeaderUI();
            renderAccountsList();
            showToast('All accounts removed');
        } catch (err) {
            showToast('Error: ' + err.message, true, 2000);
        }
    }, 'Yes, remove');
}

function adDropLocal(mobile) {
    state.sessions = state.sessions.filter(s => String(s.mobile) !== String(mobile));
    if (String(state.activeMobile) === String(mobile)) {
        state.activeMobile = null;
        state.activeSession = null;
        const usable = state.sessions.find(s => !(s.is_expired || s.status === 'expired' || s.valid === false));
        if (usable) setActiveAccount(usable.mobile, true);
    }
    updateAccountHeaderUI();
    renderAccountsList();
}

function adBox() {
    let m = document.getElementById('accDelModal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'accDelModal';
        m.className = 'confirm-backdrop hidden';
        m.innerHTML = '<div class="confirm-box" id="accDelBox"></div>';
        m.addEventListener('click', e => { if (e.target === m && !m.dataset.busy) adClose(); });
        document.body.appendChild(m);
    }
    return m;
}

function adClose() { const m = document.getElementById('accDelModal'); if (m) { m.classList.add('hidden'); delete m.dataset.busy; } }

function adOpen(mobile) {
    const m = adBox();
    m.classList.remove('hidden');
    document.getElementById('accDelBox').innerHTML = `
        <div class="confirm-ico"><i class="fa-solid fa-trash-can"></i></div>
        <h3 class="confirm-title">Remove account</h3>
        <p class="confirm-desc">+91 ${mobile}</p>
        <div class="ad-opts">
            <button type="button" class="ad-opt" onclick="adRemove('${mobile}')">
                <span class="ad-opt-ico"><i class="fa-solid fa-user-minus"></i></span>
                <span class="ad-opt-text"><b>Remove</b><small>Take it off from database. The Swiggy account stays.</small></span>
            </button>
            <button type="button" class="ad-opt danger" onclick="adDeleteAsk('${mobile}')">
                <span class="ad-opt-ico"><i class="fa-solid fa-user-xmark"></i></span>
                <span class="ad-opt-text"><b>Delete <em>(OTP needed)</em></b><small>Permanently delete the Swiggy account and remove it everywhere.</small></span>
            </button>
        </div>
        <div class="confirm-btns"><button type="button" class="confirm-btn cancel" onclick="adClose()">Cancel</button></div>`;
}

async function adRemove(mobile) {
    adClose();
    await removeAccountSession(mobile);
}

function adDeleteAsk(mobile) {
    document.getElementById('accDelBox').innerHTML = `
        <div class="confirm-ico danger"><i class="fa-solid fa-triangle-exclamation"></i></div>
        <h3 class="confirm-title">Delete Swiggy account?</h3>
        <p class="confirm-desc">+91 ${mobile} will be deleted from Swiggy for good, with its orders, addresses and Swiggy One. This can't be undone. Swiggy will text an OTP to this number.</p>
        <div class="confirm-btns">
            <button type="button" class="confirm-btn cancel" onclick="adOpen('${mobile}')">Back</button>
            <button type="button" class="confirm-btn ok danger" id="adSendBtn" onclick="adSendOtp('${mobile}')">Send OTP</button>
        </div>`;
}

async function adPost(path, body) {
    const res = await fetch('/api/accounts/' + encodeURIComponent(path), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    });
    return res.json().catch(() => ({ success: false, error: 'Unexpected answer from the server' }));
}

async function adSendOtp(mobile) {
    const btn = document.getElementById('adSendBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending'; }
    adBox().dataset.busy = '1';
    const d = await adPost(mobile + '/delete/start').catch(() => ({ success: false, error: 'Network error' }));
    delete adBox().dataset.busy;
    if (!d.success) {
        if (btn) { btn.disabled = false; btn.textContent = 'Send OTP'; }
        showToast(d.error || 'Could not send the OTP', true, 3500);
        return;
    }
    document.getElementById('accDelBox').innerHTML = `
        <div class="confirm-ico danger"><i class="fa-solid fa-comment-sms"></i></div>
        <h3 class="confirm-title">Enter the OTP</h3>
        <p class="confirm-desc">Swiggy sent an OTP to +91 ${mobile}. Enter it to delete the account.</p>
        <input id="adOtp" class="ad-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" oninput="this.value=this.value.replace(/\\D/g,'')">
        <div class="confirm-btns">
            <button type="button" class="confirm-btn cancel" onclick="adClose()">Cancel</button>
            <button type="button" class="confirm-btn ok danger" id="adDelBtn" onclick="adConfirm('${mobile}')">Delete account</button>
        </div>`;
    setTimeout(() => { const i = document.getElementById('adOtp'); if (i) i.focus(); }, 50);
}

async function adConfirm(mobile) {
    const otp = (document.getElementById('adOtp').value || '').trim();
    if (otp.length < 4) { showToast('Enter the OTP', true); return; }
    const btn = document.getElementById('adDelBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting';
    adBox().dataset.busy = '1';
    const d = await adPost(mobile + '/delete/confirm', { otp }).catch(() => ({ success: false, error: 'Network error' }));
    delete adBox().dataset.busy;
    if (!d.success) {
        btn.disabled = false; btn.textContent = 'Delete account';
        showToast(d.error || 'Could not delete the account', true, 3500);
        if (d.expired) adClose();
        return;
    }
    adClose();
    adDropLocal(mobile);
    showToast('Account deleted', false, 2500);
}

async function exportAccountSession(mobile, event) {
    if (event) event.stopPropagation();
    const session = state.sessions.find(s => String(s.mobile) === String(mobile));
    if (!session) {
        showToast('Session not found', true);
        return;
    }
    if (session.key_login) {   // key-login accounts can never be exported
        showToast('Key-login accounts cannot be exported', true);
        return;
    }

    // the server decides: forbidden if this number is in keys_accounts (or added by a login key)
    let res, data;
    try {
        res = await fetch(`/api/accounts/${encodeURIComponent(mobile)}/export`, { method: 'POST' });
        data = await res.json();
    } catch (err) {
        showToast('Export failed. Try again.', true);
        return;
    }
    if (res.status === 403) {
        showToast('Forbidden: this account cannot be exported', true);
        return;
    }
    if (!res.ok || !data.success) {
        showToast(data.detail || 'Export failed', true);
        return;
    }
    const jsonStr = JSON.stringify(data.export, null, 2);

    try {
        await navigator.clipboard.writeText(jsonStr);
        showToast(`Session JSON for +91 ${mobile} copied!`);
    } catch (err) {
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `swiggy_session_${mobile}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Downloaded session JSON for +91 ${mobile}!`);
    }
}

/* ── LOGIN: JSON ───────────────────────────────────── */

async function handleSaveJsonSession() {
    const inputEl = document.getElementById('jsonPayloadInput');
    if (!inputEl) return;
    const rawVal = inputEl.value.trim();
    if (!rawVal) {
        showToast('Please paste Encrypted Key or Session JSON first', true);
        return;
    }

    // Check if input is Encrypted Access Key (e.g. SWG-XXXX-XXXX-XXXX)
    if (/^(SWG|TNG)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(rawVal)) {
        showLoader(true, 'Logging in via Encrypted Key...');
        try {
            const res = await fetch('/api/login/json', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ json_data: rawVal })
            });
            const data = await res.json();
            if (data.success && data.mobile) {
                const mobile = data.mobile;
                showToast(`Key Authenticated! Logged in as +91 ${mobile}`);
                inputEl.value = '';
                await loadSavedSessions();
                setActiveAccount(mobile);
            } else {
                showToast(data.error || 'Invalid Encrypted Key', true);
            }
        } catch (e) {
            showToast('Error validating key', true);
        } finally {
            showLoader(false);
        }
        return;
    }

    let payload = null;
    let jsonText = rawVal.replace(/,\s*$/, "");
    if (!jsonText.startsWith("{") && !jsonText.startsWith("[")) {
        jsonText = "{" + jsonText;
    }
    if (!jsonText.endsWith("}") && !jsonText.endsWith("]")) {
        jsonText = jsonText + "}";
    }
    jsonText = jsonText.replace(/,\s*([\}\]])/g, "$1");

    try {
        payload = JSON.parse(jsonText);
    } catch (err) {
        try {
            payload = JSON.parse(rawVal);
        } catch (e2) {
            showToast('Invalid Encrypted Key or JSON format', true);
            return;
        }
    }

    showLoader(true, 'Logging in via JSON...');
    try {
        const res = await fetch('/api/auth/import_json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            const mobile = data.mobile;
            showToast(`JSON Login successful for +91 ${mobile}!`);
            inputEl.value = '';
            await loadSavedSessions();
            setActiveAccount(mobile);
        } else {
            showToast(data.error || 'Invalid JSON format', true);
        }
    } catch (e) {
        showToast('Error importing JSON session', true);
    } finally {
        showLoader(false);
    }
}

/* ── LOGIN: OTP ────────────────────────────────────── */

function cleanMobileDigits(m) {
    if (!m) return '';
    const digits = String(m).replace(/[^0-9]/g, '');
    return digits.slice(-10);
}

let otpState = { sid: '', tid: '', deviceId: '', mobile: '', isNew: false };

function showOtpStep(step) {
    const step1 = document.getElementById('otpStep1');
    const step2 = document.getElementById('otpStep2');
    if (!step1 || !step2) return;
    if (step === 1) {
        step1.style.display = 'flex';
        step2.style.display = 'none';
    } else {
        step1.style.display = 'none';
        step2.style.display = 'flex';
    }
}

// a button that is working: spinner + what it is doing, disabled so it can't be tapped twice
// (found by its click handler too, in case the webview still shows an older page without the ids)
const BTN_FALLBACK = { loginSendBtn: '[onclick^="handleCheckMobileAndSendOtp"]', loginVerifyBtn: '[onclick^="handleVerifyOtp"]' };
const btnEl = id => document.getElementById(id) || (BTN_FALLBACK[id] ? document.querySelector(BTN_FALLBACK[id]) : null);

function btnBusy(id, text) {
    const b = btnEl(id);
    if (!b) return;
    if (!b.dataset.idle) b.dataset.idle = b.innerHTML;
    b.disabled = true;
    b.classList.add('busy');
    b.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${text}`;
}

function btnIdle(id) {
    const b = btnEl(id);
    if (!b || !b.dataset.idle) return;
    b.innerHTML = b.dataset.idle;
    delete b.dataset.idle;
    b.disabled = false;
    b.classList.remove('busy');
}

async function handleCheckMobileAndSendOtp() {
    const mobile = document.getElementById('otpMobileInput').value.trim();
    if (!mobile || mobile.length !== 10) {
        showToast('Enter a valid 10-digit number', true);
        return;
    }
    const btn = btnEl('loginSendBtn');
    if (btn && btn.disabled) return;

    const cleanTarget = cleanMobileDigits(mobile);
    btnBusy('loginSendBtn', 'Checking number…');

    let isExisting = false;
    try {
        const checkRes = await fetch('/api/auth/check_mobile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile })
        });
        const checkData = await checkRes.json();
        if (checkData.success && checkData.registered === true) {
            isExisting = true;
        }
    } catch (e) {
        console.error("Check mobile API error:", e);
    }

    if (!isExisting) {
        isExisting = state.sessions.some(s => cleanMobileDigits(s.mobile) === cleanTarget || cleanMobileDigits(s.phone) === cleanTarget);
    }

    if (isExisting) {
        btnIdle('loginSendBtn');   // the "already registered" popup asks first
        showConfirmRegisterModal(mobile);
    } else {
        showToast('New number found! Sending OTP…', 'fa-user-plus', 2000);
        btnBusy('loginSendBtn', 'Sending OTP…');
        await sendOtpApi(mobile, true);
    }
}

let currentLoginTab = 'otp';

function switchLoginTab(mode) {
    currentLoginTab = mode;
    const tabs = {
        otp: ['loginTabOtp', 'loginContentOtp'],
        json: ['loginTabJson', 'loginContentJson'],
    };
    for (const [name, [btnId, contentId]] of Object.entries(tabs)) {
        const on = name === mode;
        const btn = document.getElementById(btnId);
        const content = document.getElementById(contentId);
        if (content) content.style.display = on ? 'block' : 'none';
        if (btn) btn.classList.toggle('active', on);
    }
}

function toggleLoginTab() {
    const nextMode = currentLoginTab === 'otp' ? 'json' : 'otp';
    switchLoginTab(nextMode);
}

function showConfirmRegisterModal(mobile) {
    const modal = document.getElementById('confirmRegisterModal');
    const submsg = document.getElementById('confirmRegisterSubmsg');
    const continueBtn = document.getElementById('confirmRegisterContinueBtn');

    if (submsg) submsg.textContent = `This mobile number (+91 ${mobile}) is already registered.`;
    if (modal) modal.style.display = 'flex';

    if (continueBtn) {
        continueBtn.onclick = async () => {
            closeConfirmRegisterModal();
            btnBusy('loginSendBtn', 'Sending OTP…');
            await sendOtpApi(mobile, false);
        };
    }
}

function closeConfirmRegisterModal(e) {
    if (e && e.target !== e.currentTarget) return;
    const modal = document.getElementById('confirmRegisterModal');
    if (modal) modal.style.display = 'none';
}

async function sendOtpApi(mobile, isNew = false) {
    try {
        const res = await fetch('/api/auth/send_otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile })
        });
        const data = await res.json();
        if (data.success) {
            otpState = { sid: data.sid, tid: data.tid, deviceId: data.device_id || '', mobile, isNew };
            showOtpStep(2);
            document.getElementById('otpMobileDisplay').textContent = `+91 ${mobile}`;
            showToast('OTP sent successfully!');
        } else {
            showToast(data.error || 'OTP failed', true);
        }
    } catch {
        showToast('Error sending OTP', true);
    } finally {
        btnIdle('loginSendBtn');
    }
}

async function handleVerifyOtp() {
    const otpInput = document.getElementById('otpCodeInput');
    const otp = otpInput ? otpInput.value.trim() : '';
    if (!otp) { showToast('Enter the 6-digit OTP', true); return; }
    const vbtn = btnEl('loginVerifyBtn');
    if (vbtn && vbtn.disabled) return;

    btnBusy('loginVerifyBtn', 'Verifying…');
    try {
        const res = await fetch('/api/auth/verify_otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mobile: otpState.mobile,
                otp,
                sid: otpState.sid,
                tid: otpState.tid,
                device_id: otpState.deviceId,
                is_new: otpState.isNew || false
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Login successful!', false);
            showOtpStep(1);
            if (otpInput) otpInput.value = '';
            document.getElementById('otpMobileInput').value = '';
            await loadSavedSessions();
            setActiveAccount(data.mobile);
        } else {
            showToast(data.error || 'Verification failed. Invalid OTP.', true);
            if (otpInput) otpInput.value = '';
        }
    } catch {
        showToast('Verification error', true);
        if (otpInput) otpInput.value = '';
    } finally {
        btnIdle('loginVerifyBtn');
    }
}

/* ── OFFERS / TOOLS ────────────────────────────────── */

function renderOffersView() {
    const banner = document.getElementById('offersNoAccountBanner');
    const content = document.getElementById('offersContent');
    const phone = document.getElementById('offerAccountPhone');
    if (!banner || !content) return;

    if (!state.activeSession) {
        banner.style.display = 'flex';
        content.style.display = 'none';
    } else {
        banner.style.display = 'none';
        content.style.display = 'block';
        if (phone) phone.textContent = `+91 ${state.activeMobile}`;
    }
}

async function handleClaimBreakfast() {
    if (!state.activeMobile) return;
    showToast('Claiming breakfast deal...', 'fa-wand-magic-sparkles');
    try {
        const res = await fetch('/api/deals/breakfast', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile: state.activeMobile })
        });
        const data = await res.json();
        showToast(data.success ? 'Breakfast deal claimed!' : (data.error || 'Unavailable'), data.success ? 'fa-circle-check' : 'fa-circle-info');
    } catch { showToast('Error claiming deal', 'fa-triangle-exclamation'); }
}

async function handleClaimNight() {
    if (!state.activeMobile) return;
    showToast('Claiming night deal...', 'fa-fire');
    try {
        const res = await fetch('/api/deals/night', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile: state.activeMobile })
        });
        const data = await res.json();
        showToast(data.success ? 'Night deal claimed!' : (data.error || 'Unavailable'), data.success ? 'fa-circle-check' : 'fa-circle-info');
    } catch { showToast('Error claiming deal', 'fa-triangle-exclamation'); }
}

/* ── ADDRESS ───────────────────────────────────────── */

async function fetchAddressesForActiveAccount(isSilent = false, isManual = false) {
    const banner = document.getElementById('addressNoAccountBanner');
    const content = document.getElementById('addressContent');
    const listEl = document.getElementById('addressListContainer');
    const refreshIcon = document.getElementById('addrRefreshIcon');
    if (!content || !listEl) return;

    if (!state.activeSession) {
        if (banner) banner.style.display = 'flex';
        content.style.display = 'none';
        return;
    }

    if (banner) banner.style.display = 'none';
    content.style.display = 'block';

    // the cached list only counts for the account it was loaded for
    const hasCached = state.addrOwner === String(state.activeMobile)
        && ((state.globalAddresses && state.globalAddresses.length > 0) || (state.accountAddresses && state.accountAddresses.length > 0));

    if (isManual) {
        showToast('Refreshing addresses...', 'fa-rotate-right');
    }

    if (refreshIcon) refreshIcon.classList.add('fa-spin');

    // this account's list at once if we have it, else loading blocks until it comes
    if (hasCached) { if (isSilent) renderAddressesList(); }
    else listEl.innerHTML = addrSkeleton();

    const targetMobile = state.activeMobile || 'global';
    try {
        const res = await fetch(`/api/addresses/${targetMobile}${isManual ? '?force=true' : ''}`);
        const data = await res.json();

        if (data.is_expired) {
            showToast(`Session expired for +91 ${targetMobile}`, true);
            const session = state.sessions.find(s => String(s.mobile) === String(targetMobile));
            if (session) {
                session.is_expired = true;
                session.status = 'expired';
                renderAccountsList();
                updateAccountHeaderUI();
                _autoFallbackToNextValidSession(targetMobile);
            }
        }

        if (data.success) {
            state.globalAddresses = data.global_addresses || [];
            state.accountAddresses = data.account_addresses || [];
            state.addrOwner = String(targetMobile);
            state.addresses = data.addresses || [];
            renderAddressesList();
            if (isManual && !data.is_expired) showToast('Addresses updated!', false);
        }
    } catch {
        if (!hasCached) {
            listEl.innerHTML = `<div class="fpe-sub" style="text-align:center;">Error loading addresses.</div>`;
        }
    } finally {
        if (refreshIcon) refreshIcon.classList.remove('fa-spin');
    }
}

function renderAddressesList() {
    const listEl = document.getElementById('addressListContainer');
    if (!listEl) return;

    const globalAddrs = state.globalAddresses || [];
    const accountAddrs = state.accountAddresses || [];

    let html = `
    <div class="section-head">
        <span class="section-head-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5"/><path d="M15 6.5v5"/><path d="M18.5 14.2c0 2.2-3 4.8-3 4.8s-3-2.6-3-4.8a3 3 0 0 1 6 0z" fill="currentColor" stroke="none"/><circle cx="15.5" cy="14.2" r="1" fill="var(--bg-card)" stroke="none"/></svg></span>
        <span class="section-head-title">Saved Addresses</span>
        <span class="section-head-line"></span>
        <button type="button" class="section-head-action" onclick="fetchAddressesForActiveAccount(false, true)" title="Refresh Addresses">
            <i class="fa-solid fa-arrows-rotate" id="addrRefreshIcon"></i> Refresh
        </button>
    </div>`;

    if (globalAddrs.length === 0 && accountAddrs.length === 0) {
        html += `
            <div class="full-page-empty" style="min-height:24vh;">
                <div class="fpe-ring">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/>
                        <circle cx="12" cy="10" r="3"/>
                    </svg>
                </div>
                <div class="fpe-title">No Saved Addresses</div>
                <div class="fpe-sub">Add a delivery location or import via link.</div>
            </div>`;
        listEl.innerHTML = html;
        return;
    }

    // 1. Global Web Addresses Section
    if (globalAddrs.length > 0) {
        html += globalAddrs.map(a => renderSingleAddressCard(a, true)).join('');
    }

    // Very thin simple inline line divider between global addresses and account addresses
    if (globalAddrs.length > 0 && accountAddrs.length > 0) {
        html += `<div style="border-top: 1px solid var(--border-color); margin: 10px 0;"></div>`;
    }

    // 2. Swiggy Account Saved Addresses Section
    if (accountAddrs.length > 0) {
        html += accountAddrs.map(a => renderSingleAddressCard(a, false)).join('');
    }

    listEl.innerHTML = html;
}

function formatTitleCase(str) {
    if (!str) return 'Receiver';
    return String(str)
        .toLowerCase()
        .split(' ')
        .map(word => word ? word.charAt(0).toUpperCase() + word.slice(1) : '')
        .join(' ');
}

function renderSingleAddressCard(a, isGlobal) {
    const recName = a.receiver_name || a.name || (state.activeSession ? state.activeSession.name : '') || 'Receiver';
    const recPhone = a.receiver_mobile || a.phone || a.mobile || state.activeMobile || '';
    const fullAddrText = a.display || a.address || `${a.house || a.building || ''} ${a.area || a.locality || ''}`.trim() || 'Saved Address';
    const rawTag = a.annotation || a.address_type || a.label || 'Home';
    const displayTag = String(rawTag);
    const tagClass = displayTag.toLowerCase() === 'home' ? 'home' : 'work';
    const deleteTitle = isGlobal ? 'Delete from DB' : 'Delete from Account';

    return `
    <div class="addr-card">
        <div class="addr-card-content">
            <div class="addr-card-info">
                <span class="addr-label ${tagClass}">${displayTag}</span>${isGlobal ? '' : '<span class="addr-acc-tag">Account address</span>'}
                <div class="addr-name-row">${recName} ${recPhone ? `| <span style="font-weight:normal; color:var(--text-muted);">+91 ${recPhone}</span>` : ''}</div>
                <div class="addr-details-row">${fullAddrText}</div>
            </div>
            <div class="addr-card-actions">
                <button type="button" class="addr-delete-btn" onclick="handleDeleteAddress('${a.id}', ${isGlobal})" title="${deleteTitle}">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>
    </div>`;
}

function handleDeleteAddress(addressId, isGlobal) {
    const desc = isGlobal
        ? 'Are you sure you want to delete this address?'
        : 'Delete this address from the account +91 ' + (state.activeMobile || '') + '?';
    customConfirm('Delete Address', desc, () => _deleteAddressNow(addressId, isGlobal));
}

async function _deleteAddressNow(addressId, isGlobal) {
    showToast('Deleting address...', false);
    try {
        const res = await fetch('/api/addresses/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mobile: state.activeMobile || '',
                address_id: addressId,
                is_global: isGlobal
            })
        });
        const data = await res.json();
        if (data.statusCode === 0 || data.success) {
            showToast('Address deleted!', false);
            fetchAddressesForActiveAccount(false, true);
        } else {
            showToast(data.error || 'Failed to delete address', true);
            if (data.statusCode === 401 || (data.error && data.error.includes('expired'))) {
                const session = state.sessions.find(s => String(s.mobile) === String(state.activeMobile));
                if (session) {
                    session.is_expired = true;
                    session.status = 'expired';
                    renderAccountsList();
                    updateAccountHeaderUI();
                    _autoFallbackToNextValidSession(state.activeMobile);
                }
            }
        }
    } catch {
        showToast('Error deleting address', true);
    }
}

/* ── ADDRESS DEDICATED PAGE & LEAFLET MAP ENGINE ────────── */

let addressMap = null;
let addressMarker = null;
let currentSelectedLat = 22.5726; // Kolkata fallback
let currentSelectedLng = 88.3639;
let currentSelectedAnnotation = 'Home';
let currentGeoInfo = {};  // reverse-geocode details of the pinned spot (city, pincode, ...)
let mapSearchDebounceTimer = null;
let selectedInstructionPills = new Set();

function openAddAddressPage() {
    if (!state.activeSession) {
        showToast('Please select an active account first', true);
        return;
    }
    // Switch to the add-address tab (which will call initAddAddressPageMap)
    switchTab('add-address');
}

function initAddAddressPageMap() {
    // receiver name and phone are typed by the user (never pre-filled: people save other people's numbers)

    // Wait for the tab to be fully visible before initializing Leaflet
    setTimeout(() => {
        initLeafletMap(currentSelectedLat, currentSelectedLng);
        // Silently attempt GPS location lookup without popping error toasts
        getCurrentGpsLocation(true);
    }, 200);

    // Force resize after map is fully rendered
    setTimeout(() => {
        if (addressMap) {
            addressMap.invalidateSize();
            addressMap.setView([currentSelectedLat, currentSelectedLng], 16);
        }
    }, 500);

    // One more invalidate for safety (some browsers need extra time)
    setTimeout(() => {
        if (addressMap) addressMap.invalidateSize();
    }, 1000);
}

function openLinkImportModal() {
    if (!state.activeSession) {
        showToast('Please select an active account first', true);
        return;
    }
    const modal = document.getElementById('linkImportModal');
    if (modal) modal.style.display = 'flex';
}

function closeLinkImportModal(e) {
    if (e && e.target !== e.currentTarget) return;
    const modal = document.getElementById('linkImportModal');
    if (modal) modal.style.display = 'none';
}

function selectAnnotationTag(tag, btnEl) {
    currentSelectedAnnotation = tag;
    document.querySelectorAll('.annotation-tags-row .tag-pill').forEach(el => el.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
}

function toggleInstructionPill(text, btnEl) {
    if (selectedInstructionPills.has(text)) {
        selectedInstructionPills.delete(text);
        if (btnEl) btnEl.classList.remove('active');
    } else {
        selectedInstructionPills.add(text);
        if (btnEl) btnEl.classList.add('active');
    }
    const instrInput = document.getElementById('addrInstructions');
    if (instrInput) {
        instrInput.value = Array.from(selectedInstructionPills).join(', ');
    }
}

function initLeafletMap(lat, lng) {
    if (!window.L) {
        console.error('[Map] Leaflet library not loaded');
        return;
    }
    const mapEl = document.getElementById('addressLeafletMap');
    if (!mapEl) {
        console.error('[Map] Map container element not found');
        return;
    }

    // If map already exists, just reposition and resize
    if (addressMap) {
        addressMap.invalidateSize();
        addressMap.setView([lat, lng], 16);
        if (addressMarker) addressMarker.setLatLng([lat, lng]);
        reverseGeocodeCoords(lat, lng);
        return;
    }

    // Destroy any stale Leaflet instance on the element
    if (mapEl._leaflet_id) {
        try { mapEl._leaflet_id = undefined; } catch(e) {}
    }

    addressMap = L.map('addressLeafletMap', {
        zoomControl: true,
        attributionControl: true
    }).setView([lat, lng], 16);

    // Use OpenStreetMap tiles with proper HTTPS
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        subdomains: ['a', 'b', 'c'],
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(addressMap);

    const customIcon = L.divIcon({
        className: 'custom-map-pin',
        html: `<div style="background:#FC8019; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; box-shadow:0 4px 14px rgba(252,128,25,0.6); border:2.5px solid #fff;"><i class="fa-solid fa-location-dot" style="font-size:16px;"></i></div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 34]
    });

    addressMarker = L.marker([lat, lng], { draggable: true, icon: customIcon }).addTo(addressMap);

    addressMarker.on('dragend', function (e) {
        const coord = e.target.getLatLng();
        currentSelectedLat = coord.lat;
        currentSelectedLng = coord.lng;
        reverseGeocodeCoords(coord.lat, coord.lng);
    });

    addressMap.on('click', function (e) {
        currentSelectedLat = e.latlng.lat;
        currentSelectedLng = e.latlng.lng;
        addressMarker.setLatLng(e.latlng);
        reverseGeocodeCoords(e.latlng.lat, e.latlng.lng);
    });

    // Force invalidate after small delays to ensure tiles render
    setTimeout(() => { if (addressMap) addressMap.invalidateSize(); }, 100);
    setTimeout(() => { if (addressMap) addressMap.invalidateSize(); }, 300);
    setTimeout(() => { if (addressMap) addressMap.invalidateSize(); }, 600);

    reverseGeocodeCoords(lat, lng);
}

function getCurrentGpsLocation(isSilent = false) {
    if (!navigator.geolocation) {
        if (!isSilent) showToast('Geolocation is not supported by your browser', true);
        return;
    }

    if (!isSilent) showToast('Locating your GPS position...', false);
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            currentSelectedLat = pos.coords.latitude;
            currentSelectedLng = pos.coords.longitude;

            if (addressMap && addressMarker) {
                addressMap.setView([currentSelectedLat, currentSelectedLng], 17);
                addressMarker.setLatLng([currentSelectedLat, currentSelectedLng]);
            }
            reverseGeocodeCoords(currentSelectedLat, currentSelectedLng);
            if (!isSilent) showToast('GPS Location pinned!', false);
        },
        (err) => {
            if (!isSilent) {
                showToast('Could not retrieve GPS position. Please search or pick on map.', true);
            }
        },
        { enableHighAccuracy: true, timeout: 8000 }
    );
}

async function reverseGeocodeCoords(lat, lng) {
    const titleEl = document.getElementById('selectedLocTitle');
    const subEl = document.getElementById('selectedLocSub');
    const areaInput = document.getElementById('addrArea');

    if (titleEl) titleEl.innerText = "Fetching location details...";

    try {
        const res = await fetch(`/api/location/reverse?lat=${lat}&lng=${lng}&mobile=${encodeURIComponent(state.activeMobile || '')}`);
        const data = await res.json();

        if (data.success && data.location) {
            const loc = data.location;
            currentGeoInfo = loc;
            const mainName = loc.area || "Selected Location";
            const fullStr = loc.address || `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`;

            if (titleEl) titleEl.innerText = mainName;
            if (subEl) subEl.innerText = fullStr;
            if (areaInput) {
                areaInput.value = fullStr;
            }
        } else {
            if (titleEl) titleEl.innerText = "Pinned Location";
            if (subEl) subEl.innerText = `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`;
        }
    } catch {
        if (titleEl) titleEl.innerText = "Location Pinned";
        if (subEl) subEl.innerText = `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`;
    }
}
async function fetchMapSearchSuggestions(query) {
    const dropdown = document.getElementById('mapSearchResults');
    if (!dropdown) return;

    dropdown.style.display = 'block';
    dropdown.innerHTML = `<div class="map-search-item"><i class="fa-solid fa-spinner fa-spin"></i> Searching locations...</div>`;

    try {
        const res = await fetch(`/api/location/search?query=${encodeURIComponent(query)}`);
        const data = await res.json();
        const items = data.results || [];

        if (items.length === 0) {
            dropdown.innerHTML = `<div class="map-search-item">No matching locations found</div>`;
            return;
        }

        dropdown.innerHTML = items.map((item, idx) => {
            const safeDesc = (item.description || item.main_text || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const hasCoords = item.lat && item.lng;
            const placeId = (item.place_id || '').replace(/'/g, "\\'");
            const clickHandler = hasCoords
                ? `selectMapSearchSuggestion(${item.lat}, ${item.lng}, '${safeDesc}')`
                : `selectMapSearchByPlaceId('${placeId}', '${safeDesc}')`;
            return `
            <div class="map-search-item" onclick="${clickHandler}">
                <i class="fa-solid fa-location-dot" style="color:var(--swiggy-blue); font-size:13px;"></i>
                <div>
                    <div style="font-weight:700; font-size:12.5px; color:var(--text-main);">${item.main_text || item.description}</div>
                    <div style="font-size:11px; color:var(--text-muted);">${item.secondary_text || item.description}</div>
                </div>
            </div>`;
        }).join('');
    } catch {
        dropdown.innerHTML = `<div class="map-search-item">Error fetching suggestions</div>`;
    }
}

async function selectMapSearchByPlaceId(placeId, fullAddress) {
    const dropdown = document.getElementById('mapSearchResults');
    if (dropdown) dropdown.style.display = 'none';

    showToast('Fetching location coordinates...', false);

    try {
        const res = await fetch(`/api/location/details?place_id=${encodeURIComponent(placeId)}`);
        const data = await res.json();
        if (data.success && data.details && data.details.lat && data.details.lng) {
            selectMapSearchSuggestion(data.details.lat, data.details.lng, data.details.address || fullAddress);
            return;
        }
    } catch (e) {
        console.error('[Map] Place details error:', e);
    }

    // Fallback: just set the address text
    const areaInput = document.getElementById('addrArea');
    if (areaInput) areaInput.value = fullAddress;
    showToast('Could not get exact coordinates for this place', true);
}

function selectMapSearchSuggestion(lat, lng, fullAddress) {
    const dropdown = document.getElementById('mapSearchResults');
    if (dropdown) dropdown.style.display = 'none';

    if (lat && lng) {
        currentSelectedLat = parseFloat(lat);
        currentSelectedLng = parseFloat(lng);

        if (addressMap && addressMarker) {
            addressMap.setView([currentSelectedLat, currentSelectedLng], 16);
            addressMarker.setLatLng([currentSelectedLat, currentSelectedLng]);
        }
    }

    const areaInput = document.getElementById('addrArea');
    if (areaInput) areaInput.value = fullAddress;

    const searchInput = document.getElementById('mapSearchInput');
    if (searchInput) searchInput.value = fullAddress;

    if (lat && lng) {
        reverseGeocodeCoords(currentSelectedLat, currentSelectedLng);
    }
}

function handleMapSearchInput(q) {
    const query = (q || '').trim();
    const clearBtn = document.getElementById('mapClearSearchBtn');
    const dropdown = document.getElementById('mapSearchResults');

    if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';

    if (query.length < 2) {
        if (dropdown) dropdown.style.display = 'none';
        return;
    }

    if (mapSearchDebounceTimer) clearTimeout(mapSearchDebounceTimer);
    mapSearchDebounceTimer = setTimeout(() => {
        fetchMapSearchSuggestions(query);
    }, 300);
}

function clearMapSearch() {
    const input = document.getElementById('mapSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('mapClearSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    const dropdown = document.getElementById('mapSearchResults');
    if (dropdown) dropdown.style.display = 'none';
}

async function handleSaveManualAddress() {
    const house = document.getElementById('addrHouse') ? document.getElementById('addrHouse').value.trim() : '';
    const area = document.getElementById('addrArea') ? document.getElementById('addrArea').value.trim() : '';
    const landmark = document.getElementById('addrLandmark') ? document.getElementById('addrLandmark').value.trim() : '';
    const annotation = currentSelectedAnnotation || 'Home';
    const name = document.getElementById('addrReceiverName') ? document.getElementById('addrReceiverName').value.trim() : '';
    const receiver_mobile = document.getElementById('addrReceiverPhone') ? document.getElementById('addrReceiverPhone').value.trim() : '';
    const instructions = document.getElementById('addrInstructions') ? document.getElementById('addrInstructions').value.trim() : '';

    if (!house || !area) {
        showToast('House number & Area required', true);
        return;
    }
    if (!name) {
        showToast('Receiver Name is required', true);
        return;
    }
    if (!receiver_mobile || receiver_mobile.length !== 10 || !/^\d+$/.test(receiver_mobile)) {
        showToast('Valid 10-digit Receiver Phone required', true);
        return;
    }

    showToast('Saving delivery address...', false);
    try {
        const res = await fetch('/api/addresses/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mobile: state.activeMobile,
                house,
                area,
                landmark,
                annotation,
                lat: currentSelectedLat,
                lng: currentSelectedLng,
                name,
                receiver_mobile,
                instructions,
                formatted_address: currentGeoInfo.address || '',
                locality: currentGeoInfo.locality || currentGeoInfo.area || '',
                city: currentGeoInfo.city || '',
                state: currentGeoInfo.state || '',
                postal_code: currentGeoInfo.postal_code || ''
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Address saved! It is added to the account when you pick it in the cart.', false, 2200);
            switchTab('address');
            fetchAddressesForActiveAccount();
        } else {
            showToast(data.error || 'Failed to save address', true);
        }
    } catch {
        showToast('Error saving address', true);
    }
}

async function handleAddAddressByLink() {
    const linkInput = document.getElementById('addrLinkInput');
    const link = linkInput ? linkInput.value.trim() : '';
    if (!link) { showToast('Paste a link first', true); return; }

    // Close the modal first so errors/toasts appear on top
    closeLinkImportModal();
    showToast('Importing address from link...', false);

    try {
        const res = await fetch('/api/addresses/add_link', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile: state.activeMobile || '', link })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Global address imported successfully!', false);
            if (linkInput) linkInput.value = '';
            fetchAddressesForActiveAccount();
        } else {
            showToast(data.error || 'Failed to import address', true);
        }
    } catch {
        showToast('Error importing address', true);
    }
}

/* ── CART ───────────────────────────────────────────── */

function renderCartView() {
    const banner = document.getElementById('cartNoAccountBanner');
    const content = document.getElementById('cartContent');
    if (!banner || !content) return;
    if (!state.activeSession) {
        banner.style.display = 'flex';
        content.style.display = 'none';
    } else {
        banner.style.display = 'none';
        content.style.display = 'block';
    }
}

/* ── ORDERS ─────────────────────────────────────────── */

let ordersTab = 'acc';

function setOrdersTab(tab) {
    ordersTab = tab;
    document.getElementById('odTabAcc').classList.toggle('active', tab === 'acc');
    document.getElementById('odTabHour').classList.toggle('active', tab === 'hour');
    document.getElementById('odSeg').classList.toggle('right', tab === 'hour');
    fetchOrdersForActiveAccount();
}

function ordersRefresh() {
    if (ordersTab === 'hour') loadHourOrders(true);
    else fetchOrdersForActiveAccount(true);
}

function setHourCount(n) {
    const c = document.getElementById('odHourCount');
    if (c) { c.textContent = n; c.classList.toggle('hot', n > 0); }
}

async function loadHourOrdersCount() {
    try {
        const d = await (await fetch('/api/orders_recent?minutes=60&live=false')).json();
        setHourCount((d.orders || []).length);
    } catch (e) { /* ignore */ }
}

// loading blocks while the address list comes (same shimmer blocks as restaurant search)
function addrSkeleton(n = 4) {
    return '<div class="sr-skel addr-skel-head"></div>' + Array.from({ length: n }, () => '<div class="sr-skel addr-skel-block"></div>').join('');
}

function ordersSkeleton(n = 3) {
    return Array.from({ length: n }, () => `<div class="oc oc-skel">
        <div class="oc-head"><span class="oc-ico sk"></span><div class="oc-headtext"><div class="sk-l w60"></div><div class="sk-l w35"></div></div><span class="sk-l pill"></span></div>
        <div class="oc-line"></div>
        <div class="oc-rail"><span class="sk-l chip"></span><span class="sk-l chip"></span></div>
        <div class="oc-bottom"><span class="sk-l w30"></span><span class="sk-l w20"></span></div></div>`).join('');
}

const odEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


// one order card for both lists (This Account / Last 1 Hour); tap = full details
const ocStore = {};

// order stage from the status text: decides colour, icon, progress and which sections the details page shows
const OC_STEPS = ['Placed', 'Confirmed', 'Partner assigned', 'Out for delivery', 'Delivered'];

function ocStage(status) {
    const s = String(status || '').toLowerCase();
    const T = {
        cancelled: { key: 'cancelled', tone: 'bad', icon: 'fa-circle-xmark', title: 'Order Cancelled', sub: 'This order was cancelled', step: -1 },
        delivered: { key: 'delivered', tone: 'ok', icon: 'fa-circle-check', title: 'Order Delivered', sub: 'Enjoy your meal!', step: 4 },
        reached: { key: 'reached', tone: 'live', icon: 'fa-location-dot', title: 'Partner Arrived', sub: 'Your delivery partner is at your location', step: 3 },
        pickedup: { key: 'pickedup', tone: 'live', icon: 'fa-motorcycle', title: 'Out for Delivery', sub: 'Your order is on the way', step: 3 },
        arrived: { key: 'arrived', tone: 'live', icon: 'fa-store', title: 'Partner at Restaurant', sub: 'Waiting to pick up your order', step: 2 },
        assigned: { key: 'assigned', tone: 'live', icon: 'fa-user-check', title: 'Partner Assigned', sub: 'A delivery partner is on the way to the restaurant', step: 2 },
        confirmed: { key: 'confirmed', tone: 'live', icon: 'fa-utensils', title: 'Order Confirmed', sub: 'The restaurant is preparing your food', step: 1 },
        placed: { key: 'placed', tone: 'live', icon: 'fa-bag-shopping', title: 'Order Placed', sub: 'Waiting for the restaurant to confirm', step: 0 },
    };
    let k = 'placed';
    if (/cancel|fail|reject/.test(s)) k = 'cancelled';
    else if (/deliver|complet/.test(s) && !/out for|partner|assign|on the way/.test(s)) k = 'delivered';
    else if (/reached|arrived at (your|the )?(location|door|doorstep)|at your (location|door)/.test(s)) k = 'reached';
    else if (/out for|pick|on the way|way to you/.test(s)) k = 'pickedup';
    else if (/restaurant|arrived/.test(s)) k = 'arrived';
    else if (/assign|partner|rider|executive/.test(s)) k = 'assigned';
    else if (/confirm|prepar|accepted/.test(s)) k = 'confirmed';
    return T[k];
}

// item names for the pills on the outer card
function ocItemNames(o) {
    const L = Array.isArray(o.item_lines) ? o.item_lines : [];
    if (L.length) return L.map(i => ({ name: `${i.name}${Number(i.quantity) > 1 ? ' × ' + i.quantity : ''}`, veg: i.veg }));
    return String(o.items || '').split(/,\s*/).map(x => x.trim()).filter(Boolean).map(name => ({ name }));
}

// Swiggy's veg / non-veg square (a fork when Swiggy didn't say)
function odVegMark(veg) {
    if (veg === true) return '<span class="odi-mark veg"><i></i></span>';
    if (veg === false) return '<span class="odi-mark nonveg"><i></i></span>';
    return '<span class="odi-mark none"><i class="fa-solid fa-utensils"></i></span>';
}

function ocCard(o) {
    ocStore[o.order_id] = o;
    const st = ocStage(o.status);
    const sub = [o.ago || odTime(o.time_short), o.show_account && o.account ? '+91 ' + o.account : ''].filter(Boolean).join(' · ');
    const names = ocItemNames(o);
    const pills = names.slice(0, 3).map(n => `<span class="oc-pill">${odVegMark(n.veg)}<span class="oc-pill-t">${odEsc(n.name)}</span></span>`).join('')
        + (names.length > 3 ? `<span class="oc-pill more">+${names.length - 3}</span>` : '');
    const label = String(o.status || st.title).replace(/_/g, ' ');
    return `<div class="oc oc-click ${st.tone}" onclick="openOrderDetail('${odEsc(o.order_id)}')">
        <div class="oc-head">
            <span class="oc-ico ${st.tone}"><i class="fa-solid ${st.icon}"></i></span>
            <div class="oc-headtext">
                <div class="oc-name">${odEsc(o.restaurant)}</div>
                <div class="oc-sub">${odEsc(sub || 'Swiggy food order')}</div>
            </div>
            <span class="oc-badge ${st.tone}">${st.tone === 'live' ? '<i class="oc-dot"></i>' : ''}${odEsc(label)}</span>
        </div>
        <div class="oc-line"></div>
        ${pills ? `<div class="oc-rail">${pills}</div>` : ''}
        <div class="oc-bottom">
            <span class="oc-id">#${odEsc(o.order_id)}</span>
            <span class="oc-right">${o.link && st.tone === 'live' ? '<span class="oc-live-chip"><i class="fa-solid fa-location-crosshairs"></i> Track</span>' : ''}<b class="oc-amt">₹${odEsc(o.amount)}</b><i class="fa-solid fa-arrow-up-right-from-square"></i></span>
        </div>
    </div>`;
}

/* ── ORDER DETAIL PAGE ── */

let odOpenId = null;

function odRow(label, value, cls = '') {
    return `<div class="odp-row ${cls}"><span>${odEsc(label)}</span><b>${odEsc(value)}</b></div>`;
}

// confetti for a delivered order (same idea as blinkit_bot)
function odConfetti(on) {
    if (!on) return '';
    const colors = ['#38bdf8', '#fc8019', '#10b981', '#f2d74e', '#e879f9'];
    return `<div class="odp-confetti">${Array.from({ length: 26 }, () =>
        `<i style="left:${(Math.random() * 100).toFixed(1)}%;background:${colors[Math.floor(Math.random() * colors.length)]};animation-duration:${(2 + Math.random()).toFixed(2)}s;animation-delay:${(Math.random() * 2).toFixed(2)}s"></i>`).join('')}</div>`;
}

function renderOrderDetail(o, loading) {
    const page = document.getElementById('orderDetailPage');
    const st = ocStage(o.status);
    const lines = Array.isArray(o.item_lines) ? o.item_lines : [];
    const bill = Array.isArray(o.bill_lines) ? o.bill_lines : [];
    const addr = o.address || {};
    const live = st.tone === 'live';
    const label = String(o.status || '').replace(/_/g, ' ').trim();
    const cap = t => String(t || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    // live orders show Swiggy's own words ("Arrived at location"); finished ones the clean title
    const title = live && label && !/^(placed|order placed)$/i.test(label) ? label : st.title;
    const sub = live ? (o.eta ? 'Arriving in ' + o.eta : (o.substatus || st.sub))
        : (st.key === 'delivered' && o.delivered_at ? 'Delivered on ' + odTime(o.delivered_at) : st.sub);
    const person = (name, phone) => [cap(name), phone].filter(Boolean).map(odEsc).join(' | ');
    const row = (k, v, cls = '') => `<div class="sp-row ${cls}"><span>${k}</span><b>${v}</b></div>`;

    // ── Order Information (same rows as the Order Placed page) ──
    const info = [];
    info.push(row('Order ID', `<span class="sp-id">#${odEsc(o.order_id)}</span><button type="button" class="odk-copy" onclick="copyOrderId()" title="Copy"><i class="fa-regular fa-copy"></i></button>`));
    if (o.payment) info.push(row('Paid Via', `<span class="odk-pay">${odEsc(odPayName(o.payment))}</span>`));
    if (o.time_raw) info.push(row('Placed On', odEsc(odTime(o.time_raw))));
    if (st.key !== 'cancelled') {
        if (o.link) {
            info.push(row('Tracking', `<span class="od-trk"><button type="button" class="sp-track" onclick="odOpenLink(ocStore['${odEsc(o.order_id)}'].link)"><i class="fa-solid fa-location-crosshairs"></i> ${live ? 'Track order' : 'Open link'}</button>
                <button type="button" class="odk-copy" onclick="copyOrderLink()" title="Copy link"><i class="fa-regular fa-copy"></i></button></span>`));
        } else if (live) {
            info.push(row('Tracking', `<button type="button" class="sp-track ghost" onclick="openOrderDetail('${odEsc(o.order_id)}', true)"><i class="fa-solid fa-arrows-rotate"></i> Get link</button>`));
        }
        if (o.de_name || o.de_phone) info.push(row(st.key === 'delivered' ? 'Delivered By' : 'Delivery Partner', person(o.de_name || 'Partner', o.de_phone)));
        else if (live) info.push(row('Delivery Partner', '<span class="od-muted">Not assigned yet</span>'));
    }

    // ── Delivery Address: Deliver To, then Receiver Contact under a dashed line ──
    const addrHtml = (addr.text || addr.name || addr.phone) ? `<div class="sp-addr">
        ${addr.text ? `<div class="sp-addr-row"><span>Deliver To:</span><div>${odEsc(addr.text)}</div></div>` : ''}
        ${addr.name || addr.phone ? `<div class="sp-addr-row sp-addr-recv"><span>Receiver Contact:</span><div>${person(addr.name, addr.phone)}</div></div>` : ''}
    </div>` : '';

    // ── Ordered Items Summary (same lines as the Order Placed page) ──
    const itemsHtml = lines.length ? lines.map(i => {
        const extra = [...(i.variants || []), ...(i.addons || []).map(a => typeof a === 'string' ? a : a.name + (a.price ? ` (+₹${a.price})` : ''))].filter(Boolean);
        return `<div class="sc-line sp-line">
            ${odVegMark(i.veg)}
            <div class="sc-line-info"><div class="sc-line-name">${odEsc(i.name)}</div>
            ${extra.length ? `<div class="sc-line-addons">${odEsc(extra.join(', '))}</div>` : ''}</div>
            <span class="sp-qty">× ${odEsc(i.quantity)}</span>
            <div class="sc-line-price">${i.price ? '₹' + Number(i.price).toLocaleString('en-IN') : ''}</div>
        </div>`;
    }).join('')
        : (o.items ? `<div class="od-items-text">${odEsc(o.items)}</div>` : '<div class="od-muted">Item details are not available for this order.</div>');

    // ── Payment & Bill Summary ──
    const billHtml = bill.length ? bill.map(l => `<div class="sc-bill-row ${l.total ? 'total' : ''} ${l.negative ? 'save' : ''}">
            <span>${odEsc(l.label)}</span><span>${l.negative ? '−' : ''}${odEsc(l.value)}</span></div>`).join('')
        : `<div class="sc-bill-row total"><span>Total Paid</span><span>₹${odEsc(o.amount)}</span></div>`;

    page.innerHTML = `
        ${odConfetti(st.key === 'delivered' && !loading)}
        <div class="odp-wrap">
            <div class="odp-top">
                <button type="button" class="od-refresh" onclick="closeOrderDetail()"><i class="fa-solid fa-arrow-left"></i> Back to Orders</button>
                <button type="button" class="od-refresh" onclick="openOrderDetail('${odEsc(o.order_id)}', true)"><i class="fa-solid fa-arrows-rotate ${loading ? 'fa-spin' : ''}"></i> ${loading ? 'Loading' : 'Refresh'}</button>
            </div>
            <div class="odp-hero">
                <div class="odp-ring ${st.tone}"><i class="fa-solid ${st.key === 'delivered' ? 'fa-check' : st.key === 'cancelled' ? 'fa-xmark' : st.icon}"></i><span class="odp-pulse"></span></div>
                <h2 class="odp-big">${odEsc(title)}</h2>
                <div class="odp-rest"><i class="fa-solid fa-store"></i>${odEsc(o.restaurant)}${o.area ? `<span>· ${odEsc(o.area)}</span>` : ''}</div>
                <div class="odp-small ${st.tone}">${odEsc(sub)}</div>
            </div>
            ${o.load_failed && !loading ? `<div class="od-fail"><i class="fa-solid fa-triangle-exclamation"></i>
                <span>Could not load the full bill and items from Swiggy.</span>
                <button type="button" onclick="openOrderDetail('${odEsc(o.order_id)}', true)">Retry</button></div>` : ''}
            <div class="card sp-card odp-in"><div class="sp-card-title"><i class="fa-solid fa-file-invoice"></i> Order Information</div><div class="od-info">${info.join('')}</div></div>
            ${addrHtml ? `<div class="card sp-card odp-in"><div class="sp-card-title"><i class="fa-solid fa-location-dot"></i> Delivery Address</div>${addrHtml}</div>` : ''}
            <div class="card sp-card odp-in"><div class="sp-card-title"><i class="fa-solid fa-basket-shopping"></i> Ordered Items Summary</div>${itemsHtml}</div>
            <div class="card sp-card odp-in"><div class="sp-card-title"><i class="fa-solid fa-receipt"></i> Payment &amp; Bill Summary</div>${billHtml}</div>
            <button type="button" class="sp-btn primary sp-full od-back" onclick="closeOrderDetail()"><i class="fa-solid fa-clock-rotate-left"></i> Back to Orders</button>
        </div>`;
}

// Swiggy's payment codes ("UPIIntent", "SwiggyPay", "CashOnDelivery"...) -> what a person reads
function odPayName(raw) {
    const s = String(raw || '').trim();
    const k = s.toLowerCase().replace(/[\s_-]/g, '');
    if (!k) return '';
    if (k.includes('upi')) return 'UPI';
    if (k.includes('cod') || k.includes('cash')) return 'Cash on Delivery';
    if (k.includes('swiggypay') || k.includes('swiggymoney')) return 'Swiggy Money';
    if (k.includes('netbank')) return 'Net Banking';
    if (k.includes('credit') || k.includes('debit') || k.includes('card')) return 'Card';
    if (k.includes('paylater') || k.includes('lazypay') || k.includes('simpl')) return 'Pay Later';
    const wallets = { paytm: 'Paytm', phonepe: 'PhonePe', amazonpay: 'Amazon Pay', mobikwik: 'MobiKwik', freecharge: 'Freecharge', googlepay: 'Google Pay', gpay: 'Google Pay' };
    for (const w in wallets) if (k.includes(w)) return wallets[w];
    // anything else: split "SomeNewMethod" into "Some New Method"
    return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

// any time we get -> "22/10/26 9:16 PM" (India time)
//   "2026-10-22 21:16:24" (Swiggy, already IST) | epoch seconds/ms | ISO with Z (our DB, UTC)
const _odFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true });
function odTime(v) {
    if (v === null || v === undefined || v === '' || v === 0) return '';
    let d;
    const str = String(v).trim();
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (/^\d{9,13}$/.test(str)) {
        const n = Number(str);
        d = new Date(n < 1e12 ? n * 1000 : n);
    } else if (m) {
        d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 330 * 60000);
    } else {
        d = new Date(str);
    }
    // a format we do not know (or no year in it, which Date would guess wrong): show it as it is
    if (isNaN(d.getTime()) || (!m && !/^\d{9,13}$/.test(str) && !/\b(19|20)\d{2}\b/.test(str))) return str;
    const p = Object.fromEntries(_odFmt.formatToParts(d).map(x => [x.type, x.value]));
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod || '').toUpperCase()}`;
}

// open a link in the real browser (Telegram mini app: openLink, else a new tab)
function odOpenLink(url) {
    if (!url) return;
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initData && tg.openLink) { tg.openLink(url); return; }
    const w = window.open(url, '_blank', 'noopener');
    if (!w) location.href = url;
}

function copyOrderId() {
    const id = odOpenId;
    if (!id) return;
    (navigator.clipboard ? navigator.clipboard.writeText(id) : Promise.reject()).then(() => showToast('Order ID copied', 'fa-circle-check')).catch(() => showToast(id, 'fa-hashtag'));
}

function copyOrderLink() {
    const o = ocStore[odOpenId];
    if (!o || !o.link) return;
    (navigator.clipboard ? navigator.clipboard.writeText(o.link) : Promise.reject()).then(() => showToast('Tracking link copied', 'fa-circle-check')).catch(() => showToast(o.link, 'fa-link'));
}

function closeOrderDetail() {
    odOpenId = null;
    document.getElementById('orderDetailPage').style.display = 'none';
    document.body.style.overflow = '';
}

async function openOrderDetail(orderId, refreshOnly) {
    const base = ocStore[orderId];
    if (!base) return;
    odOpenId = orderId;
    const page = document.getElementById('orderDetailPage');
    page.style.display = 'block';
    document.body.style.overflow = 'hidden';
    renderOrderDetail(base, true);
    const mobile = base.account || state.activeMobile;
    if (!mobile) { renderOrderDetail(base, false); return; }
    try {
        const d = await (await fetch(`/api/order_detail/${encodeURIComponent(mobile)}/${encodeURIComponent(orderId)}`)).json();
        if (odOpenId !== orderId) return;   // closed or switched while loading
        if (d.success && d.order) {
            const f = d.order;
            const pay = f.payment ? (/cod|cash/i.test(f.payment) ? 'Cash on Delivery' : f.payment) : base.payment;
            ocStore[orderId] = Object.assign({}, base, {
                restaurant: f.restaurant || base.restaurant, area: f.area || base.area,
                status: f.status_label || base.status, eta: f.eta || base.eta, substatus: f.substatus || '',
                amount: f.amount ? Number(f.amount).toLocaleString('en-IN') : base.amount,
                item_lines: (f.items && f.items.length) ? f.items : base.item_lines,
                bill_lines: f.bill_lines || base.bill_lines, address: (f.address && f.address.text) ? f.address : base.address,
                payment: pay, time_raw: f.order_time || base.time_raw || base.time, delivered_at: f.delivered_at || base.delivered_at,
                de_name: f.de_name || base.de_name, de_phone: f.de_phone || base.de_phone, link: f.tracking_link || '',
                load_failed: false,
            });
        } else {
            ocStore[orderId] = Object.assign({}, base, { load_failed: true });
        }
    } catch (e) {
        ocStore[orderId] = Object.assign({}, base, { load_failed: true });
        if (refreshOnly) showToast('Could not refresh', true);
    }
    if (odOpenId === orderId) renderOrderDetail(ocStore[orderId], false);
}

function _odSpin(btnId, on) {
    const b = document.getElementById(btnId);
    if (!b) return;
    b.disabled = on;
    const i = b.querySelector('i');
    if (i) i.classList.toggle('fa-spin', on);
}

const odEmpty = (title, sub, retry = true) => `<div class="full-page-empty" style="min-height:26vh;"><div class="fpe-ring">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
    </div><div class="fpe-title">${title}</div><div class="fpe-sub">${sub}</div>
    ${retry ? '<button type="button" class="od-refresh od-empty-btn" id="odRefresh" onclick="ordersRefresh()"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button>' : ''}</div>`;

async function loadHourOrders(manual) {
    const box = document.getElementById('hourOrdersList');
    box.innerHTML = ordersSkeleton(2);
    _odSpin('odRefresh', true);
    let data = null;
    try { data = await (await fetch('/api/orders_recent?minutes=60&_=' + Date.now())).json(); } catch (e) { /* offline */ }
    _odSpin('odRefresh', false);
    if (ordersTab !== 'hour') return;
    if (!data) { box.innerHTML = odEmpty('Could not load orders', 'Check your connection and try again.'); return; }
    const orders = data.orders || [];
    setHourCount(orders.length);
    if (!orders.length) {
        box.innerHTML = odEmpty('No Orders Found', 'Orders you place here show up for 60 minutes.');
        if (manual) showToast('Refreshed', 'fa-circle-check');
        return;
    }
    box.innerHTML = orders.map(o => {
        const mins = Math.max(0, Math.round((Date.now() - new Date(o.created_at).getTime()) / 60000));
        return ocCard({
            restaurant: o.restaurant || 'Swiggy order', status: o.status_label || 'Order placed', amount: Number(o.amount || 0).toLocaleString('en-IN'),
            item_lines: o.items || [], order_id: o.order_id, eta: o.eta, bill_lines: o.bill_lines || [], address: o.address || {},
            account: o.mobile, show_account: true, account_name: o.account_name, payment: o.payment_method === 'cod' ? 'Cash on Delivery' : 'UPI',
            ago: mins < 1 ? 'just now' : mins + ' min ago', substatus: o.substatus, de_name: o.de_name, de_phone: o.de_phone, link: o.tracking_link,
            time_raw: o.created_at || '', delivered_at: o.delivered_at,
        });
    }).join('');
    if (manual) showToast('Refreshed', 'fa-circle-check');
}

async function fetchOrdersForActiveAccount(manual) {
    const content = document.getElementById('ordersContent');
    const listEl = document.getElementById('ordersListContainer');
    const hourBox = document.getElementById('hourOrdersContent');
    if (!content || !listEl) return;

    if (ordersTab === 'hour') {
        content.style.display = 'none';
        hourBox.style.display = 'block';
        loadHourOrders(manual === true);
        return;
    }
    hourBox.style.display = 'none';
    content.style.display = 'block';
    loadHourOrdersCount();

    if (!state.activeSession) {
        listEl.innerHTML = odEmpty('No Account Selected', 'Select an active account to view its order history.', false);
        return;
    }

    const mobile = state.activeMobile;
    listEl.innerHTML = ordersSkeleton(3);
    _odSpin('odRefresh', true);
    try {
        const res = await fetch(`/api/orders/${mobile}?_=${Date.now()}`);
        const data = await res.json();
        _odSpin('odRefresh', false);
        if (mobile !== state.activeMobile || ordersTab !== 'acc') return;   // switched while loading
        if (data.is_expired) {
            listEl.innerHTML = odEmpty('Session Expired', `+91 ${mobile} needs to log in again.`, false);
            showToast(`Session expired for +91 ${mobile}`, true);
            const session = state.sessions.find(s => String(s.mobile) === String(mobile));
            if (session) {
                session.is_expired = true;
                session.status = 'expired';
                renderAccountsList();
                updateAccountHeaderUI();
                _autoFallbackToNextValidSession(mobile);
            }
            return;
        }
        if (data.success) {
            state.orders = data.orders || [];
                    renderOrdersList();
            if (manual === true) showToast('Refreshed', 'fa-circle-check');
        } else {
            listEl.innerHTML = odEmpty('Could not load orders', 'Something went wrong, try again.');
        }
    } catch {
        _odSpin('odRefresh', false);
        listEl.innerHTML = odEmpty('Could not load orders', 'Check your connection and try again.');
    }
}

function filterOrderTag(tag, btn) {
    state.activeOrderTagFilter = tag;
    document.querySelectorAll('.order-filter-chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderOrdersList();
}

function renderOrdersList() {
    const listEl = document.getElementById('ordersListContainer');
    if (!listEl) return;

    let filtered = state.orders;
    if (state.activeOrderTagFilter !== 'ALL') {
        filtered = state.orders.filter(o => o._order_tag === state.activeOrderTagFilter);
    }
    if (filtered.length === 0) {
        listEl.innerHTML = odEmpty('No Orders Found', state.orders.length ? 'No orders match the current filter.' : 'This account has no orders yet.');
        return;
    }
    listEl.innerHTML = filtered.map(o => ocCard({
        restaurant: o.restaurant_name || o.store_name || 'Swiggy Food',
        area: o.area, status: o.order_status || 'Delivered',
        amount: Number(o.order_total || o.total || o.amount || 0).toLocaleString('en-IN'),
        time_short: o.order_time || '', items: o.items_text, item_lines: Array.isArray(o.items) ? o.items : [], order_id: o.order_id, eta: o.eta,
        account: state.activeMobile, bill_lines: o.bill_lines || [], address: o.address || {}, payment: o.payment || '', time_raw: o.order_time || '', delivered_at: o.delivered_at,
        de_name: o.de_name, de_phone: o.de_phone, link: o.tracking_link,
    })).join('');
}

function downloadRawOrdersJson() {
    if (!state.orders.length) { showToast('No orders to export', 'fa-triangle-exclamation'); return; }
    const a = document.createElement('a');
    a.href = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state.orders, null, 2));
    a.download = `orders_${state.activeMobile || 'export'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('JSON exported!', 'fa-circle-check');
}

/* ── TOOLS PAGE: free cash offers + Decoders links ─────────────── */

// claim windows are India time (deadline = last minute to claim today)
// Swiggy's "Pick your offer" page (value 1-4 in that order); breakfast and night have the same four
const TL_CHOICES_LIST = [
    { value: 1, title: '₹50 Free Cash', min: 199 },
    { value: 2, title: '₹150 OFF Coupon', min: 249 },
    { value: 3, title: '₹175 OFF Coupon', min: 399 },
    { value: 4, title: '₹100 OFF Coupon', min: 149 },
];
const TL_CHOICES = { breakfast: TL_CHOICES_LIST, night: TL_CHOICES_LIST };

const TL_OFFERS = [
    { key: 'night', action: 'night', title: 'Night Offer', amount: 50, icon: 'fa-moon', tone: 'night',
      desc: 'Use today at 9:00 PM', from: [11, 0], until: [18, 30], note: 'Claim before 6:30 PM', opens: '11:00 AM', anim: 'rock' },
    { key: 'breakfast', action: 'breakfast', title: 'Breakfast Offer', amount: 50, icon: 'fa-sun', tone: 'bf',
      desc: 'Use tomorrow at 8:00 AM', from: [11, 0], until: [2, 0], note: 'Claim before 2:00 AM', opens: '11:00 AM', anim: 'spin' },   // until < from: window runs past midnight
    { key: 'diya', action: 'diya', title: 'Diwali Diya Offer', amount: 75,  icon: 'fa-fire-flame-curved', tone: 'diya',
      desc: '₹75 off on ₹300 cart', note: 'Claim anytime · 8 diyas per account', anim: 'pulse' },
    { key: 'instant', action: '', title: 'Instant Offer', amount: 50, icon: 'fa-bolt', tone: 'inst',
      desc: 'Claim & use instantly, anytime', note: 'Claim & use anytime', soon: true, anim: 'pulse' },
];

const tl = { offer: null, picked: new Set(), filter: 'all', q: '', results: {}, running: false, timer: null, value: 1, pickOpen: false, claimed: new Set() };

function tlIstNow() {
    const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
    return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
}

// "Ends in 2h 10m" until the deadline, then "Ended for today"
// claim window of the day (India time): before it "Opens at ... · in ...", inside "Claim before ... · Ends in ...",
// after it "Ended for today · opens ..."
function tlTimeLeft(o) {
    if (o.closed) return { text: 'Closed · coming soon', live: false, open: false };   // closed: true on TL_OFFERS = shut for now
    if (!o.until) return { text: o.note, live: true, open: true };
    const n = tlIstNow();
    const now = n.h * 3600 + n.m * 60 + n.s;
    const from = o.from ? (o.from[0] * 60 + o.from[1]) * 60 : 0;
    const until = (o.until[0] * 60 + o.until[1]) * 60;
    const DAY = 86400;
    const wraps = until <= from;   // e.g. breakfast 11:00 AM -> 2:00 AM (next day)
    const dur = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h ? h + 'h ' : ''}${m}m`; };
    const open = wraps ? (now >= from || now < until) : (now >= from && now < until);
    if (!open) {
        // before the window opens: [until, from) when it wraps, before `from` otherwise
        const beforeOpen = wraps ? (now >= until && now < from) : now < from;
        if (beforeOpen) return { text: `Opens at ${o.opens} · in ${dur(from - now)}`, live: false, open: false };
        return { text: `Ended for today · opens ${o.opens}`, live: false, open: false };
    }
    const left = wraps && now >= from ? (DAY - now) + until : until - now;
    return { text: `${o.note} · Ends in ${dur(left)}`, live: true, open: true };
}

function renderToolsPage() {
    const box = document.getElementById('tlOffers');
    if (!box) return;
    box.innerHTML = TL_OFFERS.map((o, i) => {
        const t = tlTimeLeft(o);
        return `<button type="button" class="tl-offer ${o.soon || o.closed ? 'soon' : ''}" style="animation-delay:${i * .06}s" onclick="tlOpenOffer('${o.key}')">
            <span class="tl-offer-ico ${o.anim}"><i class="fa-solid ${o.icon}"></i></span>
            <div class="tl-offer-text">
                <b>${odEsc(o.title)}${o.soon ? '<em class="tl-soon">Soon</em>' : o.closed ? '<em class="tl-soon">Closed</em>' : ''}</b>
                <small>${odEsc(o.desc)}</small>
                <span class="tl-pill ${t.live ? '' : 'off'}"><i class="fa-regular fa-clock"></i>${odEsc(t.text)}</span>
            </div>
            <div class="tl-offer-amt"><b>${o.amtText || '₹' + o.amount}</b><small>${o.amtSub || 'free cash'}</small></div>
            <i class="fa-solid fa-chevron-right tl-offer-go"></i>
        </button>`;
    }).join('');
    clearInterval(tl.timer);   // keep the countdowns ticking while the page is open
    tl.timer = setInterval(() => { if (state.activeTab === 'tools') renderToolsPage(); else clearInterval(tl.timer); }, 30000);
}

/* claim sheet: pick accounts, claim, see each result */

function tlOpenOffer(key) {
    const o = TL_OFFERS.find(x => x.key === key);
    if (!o) return;
    if (o.soon) { showToast('Instant offer is coming soon', 'fa-bolt'); return; }
    if (o.closed) { showToast(`${o.title} is closed, coming soon`, 'fa-clock', 1500); return; }
    const win = tlTimeLeft(o);
    if (!win.open) { showToast(`${o.title}: ${win.text}`, 'fa-clock', 1500); return; }
    if (!state.sessions.length) { showToast('Add an account first', true); return; }
    tl.offer = o; tl.picked = new Set(); tl.filter = 'all'; tl.q = ''; tl.results = {};
    tl.value = 1; tl.pickOpen = false; tl.claimed = new Set();
    tlRenderSheet();
    document.getElementById('tlSheet').classList.remove('hidden');
    tlLoadClaimed(o.action);
}

// accounts that already claimed this offer today: tagged, and left out of "Select all"
async function tlLoadClaimed(action) {
    try {
        const d = await (await fetch('/api/offers/claimed?offer=' + encodeURIComponent(action))).json();
        if (!tl.offer || tl.offer.action !== action) return;   // closed or switched meanwhile
        tl.claimed = new Set((d.mobiles || []).map(String));
        tlRenderSheet();
    } catch (e) { /* no marks, nothing else changes */ }
}

const tlClaimedToday = mob => tl.claimed.has(String(mob));

function tlCloseSheet(e) {
    if (e && e.target !== e.currentTarget) return;
    if (tl.running) { showToast('Claiming, please wait…', false); return; }
    document.getElementById('tlSheet').classList.add('hidden');
}

const tlExpired = s => s.is_expired || s.status === 'expired' || s.valid === false;
const tlOrdered = s => !!(s.is_done || s.order_count);

function tlVisible() {
    const q = tl.q.toLowerCase();
    return state.sessions.filter(s => {
        const mob = String(s.mobile || s.phone || '');
        if (q && !mob.includes(q) && !String(s.name || '').toLowerCase().includes(q)) return false;
        if (tl.filter === 'new') return !tlOrdered(s);
        if (tl.filter === 'ordered') return tlOrdered(s);
        return true;
    });
}

function tlRenderSheet() {
    const list = tlVisible();
    const usable = list.filter(s => !tlExpired(s) && !tlClaimedToday(s.mobile));   // Select all skips claimed accounts; tap one by hand to claim it again
    const allOn = usable.length > 0 && usable.every(s => tl.picked.has(String(s.mobile)));
    const counts = { all: state.sessions.length, new: state.sessions.filter(s => !tlOrdered(s)).length, ordered: state.sessions.filter(tlOrdered).length };
    const done = Object.values(tl.results).filter(r => !r.pending);   // finished ones only
    const ok = done.filter(r => r.success).length;
    document.getElementById('tlSheetBody').innerHTML = `
        ${tlPickerHtml()}
        <div class="tl-sh-tools">
            <div class="tl-search"><i class="fa-solid fa-magnifying-glass"></i><input type="text" placeholder="Search name or number" value="${odEsc(tl.q)}" oninput="tl.q=this.value; tlRenderList()"></div>
            <div class="tl-chips">${['all', 'new', 'ordered'].map(f => `<button type="button" class="tl-chip ${tl.filter === f ? 'on' : ''}" onclick="tl.filter='${f}'; tlRenderSheet()">${f[0].toUpperCase() + f.slice(1)} <em>${counts[f]}</em></button>`).join('')}
                <button type="button" class="tl-chip all ${allOn ? 'on' : ''}" onclick="tlToggleAll()"><i class="fa-solid fa-check-double"></i> ${allOn ? 'Clear' : 'Select all'}</button></div>
        </div>
        <div class="tl-acc-list" id="tlAccList"></div>
        ${done.length ? `<div class="tl-summary"><i class="fa-solid fa-circle-check"></i> ${ok} claimed · ${done.length - ok} failed</div>` : ''}
        <button type="button" class="tl-claim" id="tlClaimBtn" onclick="tlClaim()"></button>`;
    tlRenderList();
}

// offer picker: a plain select line; the choices open below it as simple radio lines
function tlChoice() {
    const list = TL_CHOICES[tl.offer.key] || [];
    return list.find(c => c.value === tl.value) || list[0] || TL_CHOICES_LIST[0];
}

const tlChoiceText = c => `<b>${odEsc(c.title)}</b><span>applies on orders above ₹${c.min}</span>`;

function tlPickerHtml() {
    if (tl.offer.key === 'diya') return '';
    const list = TL_CHOICES[tl.offer.key] || [];
    const cur = tlChoice();
    return `<div class="tl-pick ${tl.pickOpen ? 'open' : ''}">
        <div class="tl-pick-label">Offer to claim</div>
        <button type="button" class="tl-sel" ${tl.running || list.length < 2 ? 'disabled' : ''} onclick="tlTogglePick()">
            <span class="tl-sel-text">${tlChoiceText(cur)}</span>
            ${list.length > 1 ? '<i class="fa-solid fa-chevron-down tl-sel-go"></i>' : ''}
        </button>
        <div class="tl-opts">${list.map(c => `
            <button type="button" class="tl-opt ${c.value === cur.value ? 'on' : ''}" onclick="tlChoose(${c.value})">
                <span class="tl-radio"></span><span class="tl-sel-text">${tlChoiceText(c)}</span>
            </button>`).join('')}</div>
    </div>`;
}

function tlTogglePick() { tl.pickOpen = !tl.pickOpen; tlRenderSheet(); }

function tlChoose(v) { tl.value = v; tl.pickOpen = false; tlRenderSheet(); }

function tlRenderList() {
    const list = tlVisible();
    document.getElementById('tlAccList').innerHTML = list.length ? list.map(s => {
        const mob = String(s.mobile || s.phone || ''), exp = tlExpired(s), r = tl.results[mob];
        const name = s.name || 'Swiggy User';
        const tag = exp ? '<span class="tl-tag bad">Expired</span>'
            : tlClaimedToday(mob) ? '<span class="tl-tag claimed"><i class="fa-solid fa-circle-check"></i> Claimed today</span>'
            : tlOrdered(s) ? '<span class="tl-tag">Ordered</span>' : '<span class="tl-tag new">New</span>';
        const res = !r ? '' : r.pending ? '<span class="tl-res wait"><i class="fa-solid fa-spinner fa-spin"></i></span>'
            : r.success && r.swiggy != null ? `<span class="tl-res ok"><i class="fa-solid fa-circle-check"></i> Swiggy ₹${+r.swiggy || 0}</span>`
            : r.success ? '<span class="tl-res ok"><i class="fa-solid fa-circle-check"></i> Claimed</span>'
            : `<span class="tl-res bad" title="${odEsc(r.error || '')}"><i class="fa-solid fa-circle-xmark"></i> ${odEsc(String(r.error || 'Failed').slice(0, 28))}</span>`;
        return `<label class="tl-acc ${exp ? 'off' : ''} ${tl.picked.has(mob) ? 'on' : ''} ${tlClaimedToday(mob) ? 'claimed' : ''}">
            <input type="checkbox" ${tl.picked.has(mob) ? 'checked' : ''} ${exp || tl.running ? 'disabled' : ''} onchange="tlPick('${odEsc(mob)}', this.checked)">
            <span class="tl-box"><i class="fa-solid fa-check"></i></span>
            <span class="tl-av">${odEsc(name.trim().charAt(0).toUpperCase() || 'S')}</span>
            <span class="tl-acc-text"><b>${odEsc(name)}</b><small>+91 ${odEsc(mob)}</small></span>
            ${res || tag}
        </label>`;
    }).join('') : '<div class="tl-empty">No accounts match</div>';
    tlRenderClaimBtn();
}

function tlRenderClaimBtn() {
    const b = document.getElementById('tlClaimBtn');
    if (!b) return;
    const n = tl.picked.size;
    b.disabled = !n || tl.running;
    b.innerHTML = tl.running ? '<i class="fa-solid fa-spinner fa-spin"></i> Claiming…'
        : `<i class="fa-solid fa-gift"></i> ${n ? `Claim ${odEsc(tl.offer.key === 'diya' ? 'Diwali Diya' : tlChoice().title)} · ${n} account${n > 1 ? 's' : ''}` : 'Select accounts to claim'}`;
}

function tlPick(mob, on) {
    if (on) tl.picked.add(mob); else tl.picked.delete(mob);
    tlRenderSheet();
}

function tlToggleAll() {
    const usable = tlVisible().filter(s => !tlExpired(s) && !tlClaimedToday(s.mobile)).map(s => String(s.mobile));   // claimed today: pick by hand only
    const allOn = usable.length && usable.every(m => tl.picked.has(m));
    usable.forEach(m => allOn ? tl.picked.delete(m) : tl.picked.add(m));
    tlRenderSheet();
}

// 5 accounts per request so the results show up as they come in
async function tlClaim() {
    const mobiles = [...tl.picked];
    if (!mobiles.length || tl.running) return;
    tl.running = true;
    mobiles.forEach(m => { tl.results[m] = { pending: true }; });
    tlRenderSheet();
    for (let i = 0; i < mobiles.length; i += 5) {
        const chunk = mobiles.slice(i, i + 5);
        let d = null;
        try {
            d = await (await fetch(tl.offer.key === 'diya' ? '/api/tools/diya' : '/api/tools/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: tl.offer.action, mobiles: chunk, slot: tl.value }) })).json();
        } catch (e) { /* offline */ }
        const got = {};
        ((d && d.results) || []).forEach(r => { got[String(r.mobile)] = r; });
        chunk.forEach(m => {
            tl.results[m] = got[m] || { success: false, error: (d && (d.detail || d.error)) || 'No answer' };
            if (tl.results[m].success) tl.claimed.add(String(m));
        });
        tlRenderList();
    }
    tl.running = false;
    tl.picked = new Set();
    const ok = Object.values(tl.results).filter(r => r.success).length;
    if (tl.offer.key === 'diya') {
        const cash = Object.values(tl.results).filter(r => r.success).reduce((a, r) => a + (+r.swiggy || 0), 0);
        const reason = Object.values(tl.results).map(r => r.error).find(Boolean) || 'Claim failed, maybe a used account!';
        showToast(ok ? `Claimed successfully ₹${cash} free cash` : reason, ok ? 'fa-circle-check' : true, 3000);
        tlRenderSheet();
        return;
    }
    const when = tl.offer.key === 'breakfast' ? 'claimed for tomorrow morning' : 'claimed for tonight';
    showToast(`${ok} of ${mobiles.length} ${when}`, ok ? 'fa-circle-check' : true, 3000);
    tlRenderSheet();
}

/* ── TOOLS & BATCH AUTOMATION ──────────────────────── */

let toolsState = {
    searchQuery: '',
    filter: 'all',
    selectedMobiles: new Set(),
    selectedSlot: 1
};

function renderToolsView() {
    const listEl = document.getElementById('toolsAccountList');
    if (!listEl) return;

    const query = (toolsState.searchQuery || '').toLowerCase().trim();
    const filter = toolsState.filter || 'all';

    // Calculate filter counts across all sessions
    const counts = {
        all: state.sessions.length,
        new: state.sessions.filter(s => !s.total_orders || s.total_orders === 0).length,
        ordered: state.sessions.filter(s => s.total_orders && s.total_orders > 0).length,
        otp: state.sessions.filter(s => s.login_mode === 'otp' || !s.login_mode).length,
        json: state.sessions.filter(s => s.login_mode === 'json').length
    };

    // Update filter pill badges
    const pillAll = document.getElementById('tools-filter-all');
    const pillNew = document.getElementById('tools-filter-new');
    const pillOrd = document.getElementById('tools-filter-ordered');
    const pillOtp = document.getElementById('tools-filter-otp');
    const pillJson = document.getElementById('tools-filter-json');

    if (pillAll) pillAll.innerText = `All (${counts.all})`;
    if (pillNew) pillNew.innerText = `New (${counts.new})`;
    if (pillOrd) pillOrd.innerText = `Ordered (${counts.ordered})`;
    if (pillOtp) pillOtp.innerText = `OTP Login (${counts.otp})`;
    if (pillJson) pillJson.innerText = `JSON Imported (${counts.json})`;

    // Filter sessions
    let filtered = state.sessions.filter(s => {
        const mob = String(s.mobile || s.phone || '');
        const name = String(s.name || '').toLowerCase();
        
        // Search check
        if (query && !mob.includes(query) && !name.includes(query)) {
            return false;
        }

        // Category filter check
        if (filter === 'new') return !s.total_orders || s.total_orders === 0;
        if (filter === 'ordered') return s.total_orders && s.total_orders > 0;
        if (filter === 'otp') return s.login_mode === 'otp' || !s.login_mode;
        if (filter === 'json') return s.login_mode === 'json';

        return true;
    });

    const totalEl = document.getElementById('toolsAccountListTotal');
    if (totalEl) totalEl.innerText = `${filtered.length} shown`;

    const selectedPill = document.getElementById('toolsSelectedCountPill');
    if (selectedPill) selectedPill.innerText = `${toolsState.selectedMobiles.size} Selected`;

    const iconsBar = document.querySelector('.tools-action-icons-bar');
    if (iconsBar) {
        if (toolsState.selectedMobiles.size > 0) {
            iconsBar.style.display = 'grid';
        } else {
            iconsBar.style.display = 'none';
        }
    }

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div style="text-align:center; padding:18px; color:var(--text-muted); font-size:12px;">
                No accounts match the current search & filter.
            </div>`;
        return;
    }

    listEl.innerHTML = filtered.map(s => {
        const mob = String(s.mobile || s.phone || '');
        const name = s.name || 'User';
        const isSelected = toolsState.selectedMobiles.has(mob);
        const isExpired = s.is_expired || s.status === 'expired';
        const statusTag = isExpired ? 'Expired' : (s.status || 'Active');
        const badgeColor = isExpired ? '#ef4444' : '#10b981';

        let swiggyCount = s.swiggy_count || 0;
        if (s.orders && Array.isArray(s.orders)) {
            swiggyCount = s.orders.filter(o => o._order_tag === '#swiggy').length;
        }

        const ordersSub = swiggyCount
            ? `<i class="fa-solid fa-cart-shopping"></i> ${swiggyCount} Swiggy`
            : `${s.total_orders || 0} orders`;

        return `
        <div class="tools-account-checkbox-item ${isSelected ? 'selected' : ''}" onclick="toggleToolsAccountRow('${mob}', event)">
            <div style="display:flex; align-items:center; gap:10px;">
                <input type="checkbox" id="chk_tools_${mob}" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleToolsAccountSelection('${mob}', this.checked)">
                <div>
                    <div style="font-family:var(--font-heading); font-size:13px; font-weight:700; color:var(--text-main);">
                        +91 ${mob} <span style="font-size:11px; font-weight:500; color:var(--text-muted); margin-left:4px;">(${name})</span>
                    </div>
                    <div style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">
                        ${ordersSub}
                    </div>
                </div>
            </div>
            <span style="font-size:10px; font-weight:700; background:rgba(0,0,0,0.2); color:${badgeColor}; padding:2px 8px; border-radius:10px;">
                ${statusTag}
            </span>
        </div>`;
    }).join('');
}

function filterToolsAccounts(query) {
    toolsState.searchQuery = query;
    renderToolsView();
}

function setToolsAccountFilter(filterName, btnEl) {
    toolsState.filter = filterName;
    document.querySelectorAll('#view-tools .filter-pill').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderToolsView();
}

function toggleToolsAccountRow(mobile, event) {
    const chk = document.getElementById(`chk_tools_${mobile}`);
    if (chk) {
        chk.checked = !chk.checked;
        toggleToolsAccountSelection(mobile, chk.checked);
    }
}

function toggleToolsAccountSelection(mobile, isChecked) {
    if (isChecked) {
        toolsState.selectedMobiles.add(mobile);
    } else {
        toolsState.selectedMobiles.delete(mobile);
    }
    renderToolsView();
}

function selectAllToolsAccounts(selectAll = true) {
    const query = (toolsState.searchQuery || '').toLowerCase().trim();
    const filter = toolsState.filter || 'all';

    let filtered = state.sessions.filter(s => {
        const mob = String(s.mobile || s.phone || '');
        const name = String(s.name || '').toLowerCase();
        if (query && !mob.includes(query) && !name.includes(query)) return false;
        if (filter === 'new') return !s.total_orders || s.total_orders === 0;
        if (filter === 'ordered') return s.total_orders && s.total_orders > 0;
        if (filter === 'otp') return s.login_mode === 'otp' || !s.login_mode;
        if (filter === 'json') return s.login_mode === 'json';
        return true;
    });

    filtered.forEach(s => {
        const mob = String(s.mobile || s.phone || '');
        if (selectAll) {
            toolsState.selectedMobiles.add(mob);
        } else {
            toolsState.selectedMobiles.delete(mob);
        }
    });

    renderToolsView();
}

function selectToolsSlot(slotNumber, element) {
    toolsState.selectedSlot = slotNumber;
    document.querySelectorAll('.slot-radio-card').forEach(c => c.classList.remove('active'));
    if (element) element.classList.add('active');
}

let pendingToolsAction = 'claim_breakfast';

function openToolsOfferModal(actionName) {
    const mobiles = Array.from(toolsState.selectedMobiles);
    if (!mobiles.length) {
        showToast('Select at least one account first!', true);
        return;
    }
    pendingToolsAction = actionName;

    const modal = document.getElementById('toolsSlotModal');
    const titleEl = document.getElementById('toolsSlotModalTitle');
    if (!modal) return;

    if (titleEl) {
        titleEl.innerText = actionName === 'claim_breakfast' ? 'Breakfast Offer Slot' : 'Late Night Offer Slot';
    }

    modal.style.display = 'flex';
}

function closeToolsSlotModal(event) {
    if (event && event.target && event.target.id !== 'toolsSlotModal' && !event.target.classList.contains('modal-close-btn')) {
        return;
    }
    const modal = document.getElementById('toolsSlotModal');
    if (modal) modal.style.display = 'none';
}

function confirmToolsOfferClaim() {
    closeToolsSlotModal();
    triggerBatchAction(pendingToolsAction);
}

function closeToolsProgressModal() {
    const modal = document.getElementById('toolsProgressModal');
    if (modal) modal.style.display = 'none';
}

async function triggerBatchAction(actionName) {
    const mobiles = Array.from(toolsState.selectedMobiles);
    if (!mobiles.length) {
        showToast('Select at least one account to execute action!', true);
        return;
    }

    const actionTitleMap = {
        claim_breakfast: 'Breakfast Offer Claim',
        claim_night: 'Late Night Offer Claim',
        check_alive: 'Check Alive Status',
        delete_addresses: 'Delete Saved Addresses'
    };

    const title = actionTitleMap[actionName] || actionName;

    const progressModal = document.getElementById('toolsProgressModal');
    const titleEl = document.getElementById('toolsProgressTitle');
    const subEl = document.getElementById('toolsProgressSub');
    const barFill = document.getElementById('toolsProgressBarFill');
    const resultsList = document.getElementById('toolsProgressResultsList');
    const doneBtn = document.getElementById('toolsProgressDoneBtn');
    const closeBtn = document.getElementById('toolsProgressCloseBtn');
    const headerIcon = document.getElementById('toolsProgressHeaderIcon');

    if (!progressModal || !resultsList) return;

    if (titleEl) titleEl.innerText = title;
    if (subEl) subEl.innerText = `Processing ${mobiles.length} account(s) in parallel (30 workers)...`;
    if (barFill) barFill.style.width = '15%';
    if (doneBtn) doneBtn.style.display = 'none';
    if (closeBtn) closeBtn.style.display = 'none';
    if (headerIcon) headerIcon.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;

    // Render working placeholders inside popup card
    resultsList.innerHTML = mobiles.map(mob => {
        const acc = state.sessions.find(s => String(s.mobile || s.phone) === String(mob));
        const name = acc ? acc.name || 'User' : 'User';
        return `
        <div id="prog_row_${mob}" class="tools-account-checkbox-item" style="padding:10px 12px;">
            <div style="display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-spinner fa-spin" style="color:var(--swiggy-blue); font-size:14px;"></i>
                <div>
                    <div style="font-family:var(--font-heading); font-size:13px; font-weight:700; color:var(--text-main);">
                        +91 ${mob} <span style="font-size:11px; font-weight:500; color:var(--text-muted); margin-left:4px;">(${name})</span>
                    </div>
                </div>
            </div>
            <span class="prog-tag" style="font-size:10px; font-weight:700; background:rgba(252,128,25,0.15); color:var(--swiggy-blue); padding:2px 8px; border-radius:10px;">
                Working...
            </span>
        </div>`;
    }).join('');

    progressModal.style.display = 'flex';

    try {
        const res = await fetch('/api/tools/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: actionName,
                mobiles: mobiles,
                slot: toolsState.selectedSlot
            })
        });

        const data = await res.json();
        if (barFill) barFill.style.width = '100%';

        if (data.success && data.results) {
            let successCount = 0;
            let failCount = 0;

            data.results.forEach(item => {
                const mob = String(item.mobile || '');
                const msg = item.message || '';
                const row = document.getElementById(`prog_row_${mob}`);
                
                if (item.success) {
                    successCount++;
                } else {
                    failCount++;
                }

                if (row) {
                    const iconEl = row.querySelector('i');
                    const tagEl = row.querySelector('.prog-tag');
                    if (iconEl) {
                        iconEl.className = item.success ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-xmark';
                        iconEl.style.color = item.success ? '#10b981' : '#ef4444';
                    }
                    if (tagEl) {
                        tagEl.innerText = item.success ? 'Success' : 'Failed';
                        tagEl.style.background = item.success ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
                        tagEl.style.color = item.success ? '#10b981' : '#ef4444';
                    }
                    const detail = document.createElement('div');
                    detail.style.fontSize = '11px';
                    detail.style.color = item.success ? '#10b981' : '#ef4444';
                    detail.style.marginTop = '2px';
                    detail.innerText = msg;
                    const textWrap = row.querySelector('div > div');
                    if (textWrap) textWrap.appendChild(detail);
                }
            });

            if (subEl) subEl.innerText = `Finished! Success: ${successCount} | Failed: ${failCount}`;
            if (headerIcon) headerIcon.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981;"></i>`;
            if (doneBtn) doneBtn.style.display = 'flex';
            if (closeBtn) closeBtn.style.display = 'block';

            showToast(`${title} finished! (${successCount} OK, ${failCount} Fail)`, failCount > 0 ? 'fa-triangle-exclamation' : 'fa-circle-check');

            if (actionName === 'check_alive' || actionName === 'delete_addresses') {
                await loadSavedSessions();
            }
        } else {
            if (subEl) subEl.innerText = `Error: ${data.detail || data.error || 'Execution failed'}`;
            if (headerIcon) headerIcon.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:#ef4444;"></i>`;
            if (doneBtn) doneBtn.style.display = 'flex';
            if (closeBtn) closeBtn.style.display = 'block';
        }
    } catch (err) {
        if (barFill) barFill.style.width = '100%';
        if (subEl) subEl.innerText = `Network error: ${err.message}`;
        if (headerIcon) headerIcon.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:#ef4444;"></i>`;
        if (doneBtn) doneBtn.style.display = 'flex';
        if (closeBtn) closeBtn.style.display = 'block';
    }
}


/* ═══════════════════════════════════════════════════════════════════════════
   ██  CART PAGE — Full Group Cart with Address, Bill, Coupons, Payments  ██
   ═══════════════════════════════════════════════════════════════════════════ */

let cartState = {
    selectedAddress: null,
    groupCartId: '',
    cartData: null,
    billCollapsed: false,
    addressId: '',
};

function renderCartView() {
    const banner = document.getElementById('cartNoAccountBanner');
    const content = document.getElementById('cartContent');
    if (!banner || !content) return;

    if (!state.activeSession) {
        banner.style.display = 'flex';
        content.style.display = 'none';
        return;
    }

    banner.style.display = 'none';
    content.style.display = 'block';

    // Sync top address bar display
    updateTopAddressBarUI();
}

/* ── ADDRESS SELECTOR MODAL ──────────────────────────── */

function openCartAddressModal() {
    const modal = document.getElementById('cartAddressModal');
    if (modal) modal.style.display = 'flex';
    loadCartAddressesModalList();
}

function closeCartAddressModal(e) {
    if (e && e.target !== e.currentTarget) return;
    const modal = document.getElementById('cartAddressModal');
    if (modal) modal.style.display = 'none';
}

async function loadCartAddressesModalList() {
    const container = document.getElementById('cartAddressSelectorList');
    if (!container || !state.activeMobile) return;

    container.innerHTML = '<div class="cart-loading-shimmer"><div class="shimmer-line w80"></div><div class="shimmer-line w60"></div></div>';

    try {
        const res = await fetch(`/api/addresses/${state.activeMobile}?force=false`);
        const data = await res.json();
        if (data.success) {
            const allAddrs = data.addresses || [];
            cartState._addresses = allAddrs;
            if (allAddrs.length === 0) {
                container.innerHTML = `<div class="cart-empty-addr"><i class="fa-solid fa-location-dot"></i> No saved addresses in database.</div>`;
                return;
            }

            container.innerHTML = allAddrs.map((a, idx) => {
                const isSelected = cartState.selectedAddress && (cartState.selectedAddress.id === a.id || (cartState.selectedAddress.address === a.address && cartState.selectedAddress.name === a.name));
                const icon = a.is_global ? 'fa-globe' : 'fa-location-dot';
                const tag = (a.annotation || a.label || (a.is_global ? 'GLOBAL' : 'ACCOUNT')).toUpperCase();
                const globalBadge = a.is_global ? '<span class="cart-addr-global-badge">GLOBAL</span>' : '<span class="cart-addr-tag-pill account">ACCOUNT</span>';
                const addr = a.formatted_address || a.address || a.house || 'Unknown Address';
                const shortAddr = addr.length > 90 ? addr.substring(0, 90) + '...' : addr;
                const nameStr = a.name || 'Recipient';
                const phoneStr = a.phone ? ` | +91 ${a.phone}` : '';

                return `
                <div class="cart-addr-option ${isSelected ? 'selected' : ''}" onclick="selectCartAddressFromModal(${idx})">
                    <div class="cart-addr-icon"><i class="fa-solid ${icon}"></i></div>
                    <div class="cart-addr-body">
                        <div class="cart-addr-tag-row">
                            <span class="cart-addr-tag">${tag}</span>
                            ${globalBadge}
                            ${isSelected ? '<span class="coupon-applied-tag" style="margin-left:auto;"><i class="fa-solid fa-check"></i> Selected</span>' : ''}
                        </div>
                        <div class="cart-addr-name" style="margin-top:2px;">${nameStr}${phoneStr}</div>
                        <div class="cart-addr-text" style="margin-top:2px;">${shortAddr}</div>
                    </div>
                    <div class="cart-addr-radio"><span></span></div>
                </div>`;
            }).join('');
        }
    } catch (e) {
        container.innerHTML = `<div class="cart-empty-addr"><i class="fa-solid fa-triangle-exclamation"></i> Error loading addresses</div>`;
    }
}

async function selectCartAddressFromModal(idx) {
    const allAddrs = cartState._addresses || [];
    if (idx >= allAddrs.length) return;

    const selected = { ...allAddrs[idx] };
    closeCartAddressModal();

    // Saved (database) addresses go onto the Swiggy account now; if it already has the same one, that copy is used.
    if (selected.is_global) {
        showToast('Adding address to account...', false, 1500);
        const onAccount = await addGlobalAddressToAccount(selected);
        if (!onAccount) return;  // toast already shown
        selected.account_id = onAccount.id;
    } else {
        selected.account_id = selected.id;
    }

    cartState.selectedAddress = selected;
    updateTopAddressBarUI();
    showToast(`Address selected: ${selected.annotation || selected.label || 'Home'}`);

    // If group cart link is already filled, automatically fetch cart with new address
    const input = document.getElementById('cartGroupLinkInput');
    if (input && input.value.trim()) {
        handleFetchGroupCart();
    }
}

function updateTopAddressBarUI() {
    const a = cartState.selectedAddress;
    const titleEl = document.getElementById('cartTopAddrTitle');
    const subEl = document.getElementById('cartTopAddrSub');

    if (!a) {
        if (titleEl) titleEl.textContent = 'Select Delivery Address';
        if (subEl) subEl.textContent = 'Tap to select saved address from database';
        return;
    }

    const tag = a.annotation || a.label || (a.is_global ? 'Global' : 'Account');
    if (titleEl) titleEl.innerHTML = `${tag} <span style="font-size:11.5px; font-weight:600; color:var(--text-muted); margin-left:6px;">${a.name ? a.name : ''}</span>`;
    if (subEl) {
        const addr = a.formatted_address || a.address || a.house || '';
        subEl.textContent = addr.length > 80 ? addr.substring(0, 80) + '...' : addr;
    }
}

function openAddAddressFromCart() {
    closeCartAddressModal();
    switchTab('address');
}

async function addGlobalAddressToAccount(addr) {
    if (!state.activeMobile || !addr) return null;
    try {
        const res = await fetch('/api/cart/add_address_to_account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile: state.activeMobile, address: addr })
        });
        const data = await res.json();
        if (data.success && data.address) return data.address;
        showToast(data.error || 'Could not add address to account', true, 2500);
    } catch (e) {
        showToast('Network error while adding address', true, 2500);
    }
    return null;
}

/* ── GROUP CART FETCH ─────────────────────────────────── */

function extractGroupCartId(input) {
    if (!input) return '';
    input = input.trim();
    
    // 1. Swiggy shortlink pattern: swig.gy/gc/<rest_id>/<host_name>-<group_cart_id>
    const m1 = input.match(/swig\.gy\/gc\/\d+\/[^\/]+-(\d+)/i);
    if (m1) return m1[1];

    // 2. Query param group_cart_id=(\d+)
    const m2 = input.match(/group_cart_id=(\d+)/i);
    if (m2) return m2[1];

    // 3. Pure digits
    if (/^\d+$/.test(input)) return input;

    // 4. Fallback to number after last hyphen
    const m3 = input.match(/-(\d+)(?:\/?|\?.*)$/);
    if (m3) return m3[1];

    // 5. Generic fallback regex for min 6 digits
    const m4 = input.match(/(\d{6,})/);
    if (m4) return m4[1];

    return input;
}

async function handleFetchGroupCart() {
    const input = document.getElementById('cartGroupLinkInput');
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) {
        showToast('Enter a group cart ID or link', true);
        return;
    }

    const groupCartId = extractGroupCartId(raw);
    if (!groupCartId) {
        showToast('Invalid cart ID / link', true);
        return;
    }

    cartState.groupCartId = groupCartId;

    const btn = document.getElementById('cartFetchBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching Cart...';
    }

    showToast('Fetching cart data from Swiggy...');

    try {
        const addr = cartState.selectedAddress || {};
        const res = await fetch('/api/cart/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mobile: state.activeMobile,
                group_cart_id: raw, // Pass raw link so backend can also resolve swig.gy if needed
                address_id: addr.account_id || addr.id || '',
                lat: addr.lat || null,
                lng: addr.lng || null,
            })
        });
        const data = await res.json();

        if (data.success) {
            cartState.cartData = data;
            renderFullCartData(data);
            showToast('Cart loaded successfully!');

            // Also fetch payment options
            fetchCartPaymentOptions();
        } else {
            const rawErr = formatRawServerError(data, 'Failed to fetch group cart');
            showToast(`${rawErr}`, true, 4000);
            renderCartErrorCard(rawErr, data);
        }
    } catch (e) {
        const netErr = `Network / server error: ${e.message || e}`;
        showToast(`${netErr}`, true, 4000);
        renderCartErrorCard(netErr, { error: netErr });
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Fetch Cart Data';
        }
    }
}

function renderCartErrorCard(errorText, rawData) {
    const step3 = document.getElementById('cartStep3');
    if (!step3) return;
    step3.style.display = 'block';

    const rawDisplay = typeof rawData === 'object' ? JSON.stringify(rawData, null, 2) : String(rawData || errorText);

    step3.innerHTML = `
        <div class="card" style="padding:16px; border:2px solid #ef4444; background:rgba(239,68,68,0.06); border-radius:16px; margin-bottom:14px;">
            <div style="display:flex; align-items:center; gap:10px; color:#ef4444; font-family:var(--font-heading); font-size:14px; font-weight:800; margin-bottom:8px;">
                <i class="fa-solid fa-circle-xmark" style="font-size:18px;"></i> Swiggy Server Raw Error Response
            </div>
            <div style="font-size:13px; color:var(--text-main); font-weight:600; margin-bottom:8px;">
                ${errorText}
            </div>
            <div style="font-size:11px; color:var(--text-muted); font-family:monospace; background:rgba(0,0,0,0.3); padding:10px; border-radius:8px; white-space:pre-wrap; word-break:break-all; max-height:220px; overflow-y:auto;">
${rawDisplay}
            </div>
        </div>`;
}

/* ── RENDER FULL CART DATA ────────────────────────────── */

function renderFullCartData(data) {
    // Show step 3
    document.getElementById('cartStep3').style.display = 'block';
    // Optionally collapse step 2
    document.getElementById('cartStep2').querySelector('.cart-link-input-wrap').style.display = 'none';

    // Restaurant
    renderRestaurantCard(data.restaurant || {});

    // Savings banner
    renderSavingsBanner(data.savings_info || {});

    // Swiggy One
    renderSwiggyOneCard(data.swiggy_one || {});

    // Couponless savings
    renderCouponlessBanner(data.couponless_savings || {});

    // Items
    renderCartItems(data.items || [], data.item_count || 0);

    // Coupon info
    renderCouponInfo(data.coupon_info || {});

    // Bill
    renderBillDetails(data.bill || {});
}

function renderRestaurantCard(rest) {
    const nameEl = document.getElementById('cartRestName');
    const metaEl = document.getElementById('cartRestMeta');
    const ratingBox = document.getElementById('cartRestRating');
    const ratingVal = document.getElementById('cartRestRatingVal');

    if (nameEl) nameEl.textContent = rest.name || 'Restaurant';
    
    const metaParts = [];
    if (rest.area) metaParts.push(rest.area);
    if (rest.delivery_time) metaParts.push(`${rest.delivery_time} min`);
    if (rest.cuisines && rest.cuisines.length) metaParts.push(rest.cuisines.slice(0, 3).join(', '));
    if (metaEl) metaEl.textContent = metaParts.join(' · ') || 'Food delivery';

    if (rest.rating && ratingBox && ratingVal) {
        ratingBox.style.display = 'flex';
        ratingVal.textContent = rest.rating;
    }
}

function renderSavingsBanner(savings) {
    const banner = document.getElementById('cartSavingsBanner');
    const text = document.getElementById('cartSavingsText');
    if (!banner) return;

    if (savings.savings_message || savings.total_savings > 0) {
        banner.style.display = 'flex';
        if (text) text.textContent = savings.savings_message || `₹${savings.total_savings} saved on this order!`;
    } else {
        banner.style.display = 'none';
    }
}

function renderSwiggyOneCard(one) {
    const card = document.getElementById('cartOneCard');
    const benefitsList = document.getElementById('cartOneBenefitsList');
    const label = document.getElementById('cartOneBenefitsLabel');
    if (!card) return;

    if (one.is_super && one.benefits && one.benefits.length > 0) {
        card.style.display = 'block';
        if (label) label.textContent = one.logo_text || 'BENEFITS';
        if (benefitsList) {
            benefitsList.innerHTML = one.benefits.map(b => `
                <div class="one-benefit-item">
                    <i class="fa-solid fa-check-circle"></i>
                    <span>${b.title || b.sub_title || ''}</span>
                </div>
            `).join('');
        }
    } else {
        card.style.display = 'none';
    }
}

function renderCouponlessBanner(cl) {
    const banner = document.getElementById('cartCouponlessBanner');
    if (!banner) return;
    if (cl.savings || cl.benefit_callout) {
        banner.style.display = 'flex';
        const savEl = document.getElementById('cartCouponlessSavings');
        const callEl = document.getElementById('cartCouponlessCallout');
        if (savEl) savEl.textContent = cl.savings || '';
        if (callEl) callEl.textContent = cl.benefit_callout || '';
    } else {
        banner.style.display = 'none';
    }
}

function renderCartItems(items, count) {
    const listEl = document.getElementById('cartItemsList');
    const countPill = document.getElementById('cartItemsCountPill');
    if (countPill) countPill.textContent = count || items.length;

    if (!listEl) return;
    if (!items.length) {
        listEl.innerHTML = '<div class="cart-empty-items">No items in cart</div>';
        return;
    }

    listEl.innerHTML = items.map(item => {
        const vegIcon = item.is_veg
            ? '<div class="veg-icon veg"><div></div></div>'
            : '<div class="veg-icon nonveg"><div></div></div>';
        
        const priceDisplay = item.effective_price || item.price || 0;
        const mrpDisplay = item.mrp || 0;
        const showStrike = mrpDisplay > priceDisplay && mrpDisplay > 0;
        const qty = item.quantity || 1;
        const totalDisplay = (priceDisplay * qty / 100).toFixed(0);
        const pricePerItem = (priceDisplay / 100).toFixed(0);
        const mrpPerItem = (mrpDisplay / 100).toFixed(0);

        const imgHtml = item.image ? `<img src="${item.image}" alt="${item.name}" class="cart-item-img" onerror="this.style.display='none'">` : '';

        return `
        <div class="cart-item-card">
            <div class="cart-item-left">
                ${vegIcon}
                <div class="cart-item-info">
                    <div class="cart-item-name">${item.name}</div>
                    <div class="cart-item-price-row">
                        ${showStrike ? `<span class="cart-item-mrp">₹${mrpPerItem}</span>` : ''}
                        <span class="cart-item-price">₹${pricePerItem}</span>
                        <span class="cart-item-qty">× ${qty}</span>
                    </div>
                    ${item.ribbon ? `<span class="cart-item-ribbon">${item.ribbon}</span>` : ''}
                    ${item.description ? `<div class="cart-item-desc">${item.description.substring(0, 80)}</div>` : ''}
                </div>
            </div>
            <div class="cart-item-right">
                ${imgHtml}
                <div class="cart-item-total">₹${totalDisplay}</div>
            </div>
        </div>`;
    }).join('');
}

function renderCouponInfo(coupon) {
    const titleEl = document.getElementById('cartCouponTitle');
    const subEl = document.getElementById('cartCouponSub');
    if (!titleEl) return;

    if (coupon.coupon_code) {
        titleEl.textContent = `Coupon Applied: ${coupon.coupon_code}`;
        subEl.textContent = coupon.coupon_discount > 0 ? `You saved ₹${coupon.coupon_discount}` : 'Coupon applied';
    } else if (coupon.show_couponless_savings && coupon.couponless_savings) {
        titleEl.textContent = 'Apply Coupon';
        subEl.textContent = coupon.couponless_savings.savings ? `Extra ${coupon.couponless_savings.savings} available` : 'Save more on your order';
    }
}

function renderBillDetails(bill) {
    // Item Total
    const itemTotal = bill.cart_subtotal || bill.item_total || 0;
    const itemTotalStrike = bill.item_total_strike || bill.item_total || 0;
    setInner('billItemTotal', `₹${(itemTotal / 100).toFixed(0)}`);
    
    if (bill.item_total_strike_off && itemTotalStrike > itemTotal) {
        setInner('billItemTotalStrike', `₹${(itemTotalStrike / 100).toFixed(0)}`);
    } else if (itemTotalStrike > 0 && itemTotalStrike !== itemTotal) {
        setInner('billItemTotalStrike', `₹${(itemTotalStrike / 100).toFixed(0)}`);
    }

    // Trade/Offer Discount
    if (bill.trade_discount > 0) {
        showEl('billRowTradeDiscount');
        setInner('billTradeDiscount', `-₹${bill.trade_discount}`);
    }

    // Coupon Discount
    if (bill.coupon_discount > 0) {
        showEl('billRowCouponDiscount');
        setInner('billCouponDiscount', `-₹${bill.coupon_discount}`);
    }

    // Delivery Fee
    const deliveryCharges = bill.delivery_charges || 0;
    const deliveryBase = bill.delivery_base_price || 0;
    if (deliveryCharges === 0 && deliveryBase > 0) {
        setInner('billDeliveryFee', 'FREE');
        document.getElementById('billDeliveryFee').classList.add('green');
        setInner('billDeliveryStrike', `₹${deliveryBase}`);
    } else if (deliveryCharges > 0) {
        setInner('billDeliveryFee', `₹${deliveryCharges}`);
    } else {
        setInner('billDeliveryFee', 'FREE');
        document.getElementById('billDeliveryFee').classList.add('green');
    }

    // Delivery tooltip
    if (bill.delivery_tooltip && bill.delivery_tooltip.length > 0) {
        const tooltipEl = document.getElementById('billDeliveryTooltip');
        if (tooltipEl) {
            tooltipEl.innerHTML = bill.delivery_tooltip.map(t => {
                if (t.type === 'title') return `<div class="dt-title">${t.display_text || ''}</div>`;
                const valColor = (t.meta && t.meta.valueTextColor) || '';
                const strike = (t.meta && t.meta.intermediateTextStriked && t.intermediateText) ? `<span class="dt-strike">${t.intermediateText}</span>` : '';
                return `<div class="dt-row"><span>${t.display_text || ''}</span><div>${strike} <span style="color:${valColor || 'inherit'}">${t.value || ''}</span></div></div>`;
            }).join('');
        }
    }

    // Free Delivery Savings
    if (bill.free_delivery_discount > 0) {
        showEl('billRowFreeDelivery');
        setInner('billFreeDelivery', `-₹${bill.free_delivery_discount}`);
    }

    // Platform/Convenience Fee
    if (bill.convenience_fees > 0) {
        showEl('billRowConvenience');
        setInner('billConvenience', `₹${bill.convenience_fees.toFixed(2)}`);
    }

    // Packing Charges
    if (bill.packing_charges > 0) {
        showEl('billRowPacking');
        setInner('billPacking', `₹${bill.packing_charges}`);
    }

    // GST
    const gstTitle = bill.gst_title || 'GST & Other Charges';
    setInner('billGSTLabel', gstTitle);
    const taxAmount = bill.taxes_and_charges || bill.total_tax || 0;
    setInner('billGST', `₹${taxAmount.toFixed(2)}`);

    // GST Tooltip
    if (bill.gst_details && Object.keys(bill.gst_details).length > 0) {
        const gstEl = document.getElementById('billGSTTooltip');
        if (gstEl) {
            const gd = bill.gst_details;
            let rows = '';
            if (gd.item_SGST > 0) rows += `<div class="dt-row"><span>Item SGST</span><span>₹${gd.item_SGST.toFixed(2)}</span></div>`;
            if (gd.item_CGST > 0) rows += `<div class="dt-row"><span>Item CGST</span><span>₹${gd.item_CGST.toFixed(2)}</span></div>`;
            if (gd.item_IGST > 0) rows += `<div class="dt-row"><span>Item IGST</span><span>₹${gd.item_IGST.toFixed(2)}</span></div>`;
            if (gd.packaging_SGST > 0) rows += `<div class="dt-row"><span>Packaging SGST</span><span>₹${gd.packaging_SGST.toFixed(2)}</span></div>`;
            if (gd.packaging_CGST > 0) rows += `<div class="dt-row"><span>Packaging CGST</span><span>₹${gd.packaging_CGST.toFixed(2)}</span></div>`;
            if (gd.service_charge_SGST > 0) rows += `<div class="dt-row"><span>Service SGST</span><span>₹${gd.service_charge_SGST.toFixed(2)}</span></div>`;
            if (gd.service_charge_CGST > 0) rows += `<div class="dt-row"><span>Service CGST</span><span>₹${gd.service_charge_CGST.toFixed(2)}</span></div>`;
            gstEl.innerHTML = rows || '<div class="dt-row"><span>Tax details not available</span></div>';
        }
    }

    // Swiggy Money / Free Cash
    if (bill.swiggy_money > 0) {
        showEl('billRowSwiggyMoney');
        setInner('billSwiggyMoney', `-₹${bill.swiggy_money}`);
    }

    // TO PAY
    const toPay = bill.order_total || bill.cart_total || 0;
    setInner('billToPay', `₹${toPay}`);

    // Collapsed bill
    const collapsed = bill.collapsed || {};
    setInner('billCollapsedAmount', `₹${collapsed.totalAmount || toPay}`);
    setInner('billCollapsedSub', collapsed.subtitle || 'Incl. all taxes & charges');
    if (collapsed.strikeoffAmount && collapsed.strikeoffAmount > 0) {
        setInner('billCollapsedStrike', `₹${collapsed.strikeoffAmount}`);
    }
    
    // Discount message
    if (bill.discount_message) {
        const savBanner = document.getElementById('cartSavingsBanner');
        const savText = document.getElementById('cartSavingsText');
        if (savBanner && savText) {
            savBanner.style.display = 'flex';
            savText.textContent = bill.discount_message;
        }
    }
}

function setInner(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function showEl(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}

function toggleBillCollapse() {
    cartState.billCollapsed = !cartState.billCollapsed;
    const body = document.getElementById('cartBillBody');
    const collapsed = document.getElementById('cartBillCollapsed');
    const icon = document.getElementById('billCollapseIcon');

    if (cartState.billCollapsed) {
        if (body) body.style.display = 'none';
        if (collapsed) collapsed.style.display = 'flex';
        if (icon) icon.style.transform = 'rotate(180deg)';
    } else {
        if (body) body.style.display = 'block';
        if (collapsed) collapsed.style.display = 'none';
        if (icon) icon.style.transform = 'rotate(0deg)';
    }
}

function toggleDeliveryTooltip() {
    const el = document.getElementById('billDeliveryTooltip');
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function toggleGSTTooltip() {
    const el = document.getElementById('billGSTTooltip');
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

/* ── PAYMENT OPTIONS ──────────────────────────────────── */

async function fetchCartPaymentOptions() {
    const section = document.getElementById('cartPaymentSection');
    if (!section || !state.activeMobile || !cartState.groupCartId) return;

    try {
        const addr = cartState.selectedAddress || {};
        const res = await fetch('/api/cart/payment_options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mobile: state.activeMobile,
                group_cart_id: cartState.groupCartId,
                address_id: addr.account_id || addr.id || '',
                lat: addr.lat || null,
                lng: addr.lng || null,
            })
        });
        const data = await res.json();

        if (data.success) {
            section.style.display = 'block';
            renderPaymentGroups(data.payment_groups || []);
        }
    } catch (e) {
        console.log('Payment options error:', e);
    }
}

function renderPaymentGroups(groups) {
    const listEl = document.getElementById('cartPaymentGroupsList');
    if (!listEl) return;

    listEl.innerHTML = groups.map(group => {
        if (!group.methods || group.methods.length === 0) return '';
        
        const methodsHtml = group.methods.map(m => {
            const icon = m.icon ? `<img src="${m.icon}" alt="${m.name}" class="pm-icon" onerror="this.style.display='none'">` : `<div class="pm-icon-fallback"><i class="fa-solid fa-credit-card"></i></div>`;
            const statusClass = m.enabled ? '' : 'disabled';
            const codBadge = m.is_cod ? '<span class="pm-badge cod">COD</span>' : '';
            const upiBadge = m.is_upi_intent ? '<span class="pm-badge upi">UPI</span>' : '';
            const balanceHtml = m.balance ? `<span class="pm-balance">₹${parseFloat(m.balance).toFixed(2)}</span>` : '';
            const linkedBadge = m.is_linked ? '<span class="pm-linked-badge"><i class="fa-solid fa-link"></i></span>' : '';
            const promoHtml = m.promo_msg ? `<div class="pm-promo">${m.promo_msg}</div>` : '';
            const preferredStar = m.preferred ? '<i class="fa-solid fa-star pm-pref-star"></i>' : '';

            return `
            <div class="pm-method ${statusClass}">
                <div class="pm-left">
                    ${icon}
                    <div class="pm-details">
                        <div class="pm-name">${m.name} ${preferredStar} ${codBadge} ${upiBadge} ${linkedBadge}</div>
                        ${m.amount ? `<div class="pm-amount">₹${m.amount}</div>` : ''}
                        ${balanceHtml ? `<div class="pm-amount">${balanceHtml}</div>` : ''}
                        ${promoHtml}
                        ${!m.enabled ? `<div class="pm-disabled-msg">${m.disable_message || 'Not available'}</div>` : ''}
                    </div>
                </div>
                ${m.enabled ? '<div class="pm-radio"><span></span></div>' : ''}
            </div>`;
        }).join('');

        return `
        <div class="pm-group">
            <div class="pm-group-header">
                <span class="pm-group-name">${group.display_name || group.name}</span>
                ${group.is_preferred ? '<span class="pm-pref-tag">Preferred</span>' : ''}
            </div>
            ${methodsHtml}
        </div>`;
    }).join('');
}

/* ── COUPON MODAL ─────────────────────────────────────── */

function openCouponModal() {
    document.getElementById('cartCouponModal').style.display = 'flex';
    // Fetch coupons
    fetchAvailableCoupons();
}

function closeCouponModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('cartCouponModal').style.display = 'none';
}

async function fetchAvailableCoupons() {
    const listEl = document.getElementById('couponAvailableList');
    if (!listEl || !state.activeMobile) return;

    listEl.innerHTML = '<div class="coupon-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading coupons...</div>';

    try {
        const addr = cartState.selectedAddress || {};
        const res = await fetch('/api/cart/coupons', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mobile: state.activeMobile,
                group_cart_id: cartState.groupCartId || '',
                lat: addr.lat || null,
                lng: addr.lng || null,
            })
        });
        const data = await res.json();

        if (data.success && data.coupons && data.coupons.length > 0) {
            listEl.innerHTML = '<div class="coupon-list-title">Available Coupons</div>' + data.coupons.map(c => `
                <div class="coupon-card-item" onclick="applyCouponFromList('${c.code}')">
                    <div class="coupon-card-code">${c.code}</div>
                    <div class="coupon-card-desc">${c.title || c.description || ''}</div>
                    ${c.max_discount ? `<div class="coupon-card-max">Max discount: ₹${c.max_discount}</div>` : ''}
                    <button class="coupon-apply-btn">APPLY</button>
                </div>
            `).join('');
        } else {
            listEl.innerHTML = '<div class="coupon-empty">No coupons available for this cart</div>';
        }
    } catch (e) {
        listEl.innerHTML = '<div class="coupon-empty">Error loading coupons</div>';
    }
}

function applyCouponFromList(code) {
    const input = document.getElementById('couponCodeInput');
    if (input) input.value = code;
    handleApplyCoupon();
}

async function handleApplyCoupon() {
    const input = document.getElementById('couponCodeInput');
    const resultEl = document.getElementById('couponResultMsg');
    if (!input) return;
    const code = input.value.trim().toUpperCase();
    if (!code) {
        showToast('Enter a coupon code', true);
        return;
    }

    showToast('Applying coupon...');

    try {
        const addr = cartState.selectedAddress || {};
        const res = await fetch('/api/cart/apply_coupon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mobile: state.activeMobile,
                coupon_code: code,
                group_cart_id: cartState.groupCartId || '',
                address_id: addr.account_id || addr.id || '',
                lat: addr.lat || null,
                lng: addr.lng || null,
            })
        });
        const data = await res.json();

        if (resultEl) {
            resultEl.style.display = 'block';
            if (data.success) {
                resultEl.className = 'coupon-result-msg success';
                resultEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${data.message || 'Coupon applied!'} ${data.discount ? `(₹${data.discount} off)` : ''}`;
                showToast('Coupon applied!');
                
                // Re-fetch cart to update bill
                setTimeout(() => {
                    closeCouponModal();
                    handleFetchGroupCart();
                }, 1500);
            } else {
                resultEl.className = 'coupon-result-msg error';
                resultEl.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> ${data.error || data.message || 'Failed to apply coupon'}`;
                showToast(data.error || 'Coupon failed', true);
            }
        }
    } catch (e) {
        if (resultEl) {
            resultEl.style.display = 'block';
            resultEl.className = 'coupon-result-msg error';
            resultEl.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> Network error applying coupon';
        }
        showToast('Error applying coupon', true);
    }
}
