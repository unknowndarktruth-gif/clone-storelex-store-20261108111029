/**
 * Swiggy Pro — Restaurant search tab
 * location -> restaurant suggestions (restaurants only) -> menu -> cart with +/- steppers
 * Backend: /api/search/restaurants, /api/search/menu, /api/search/cart (see swiggy_search.har)
 */

const SR_LOC_KEY = 'swiggy_search_loc';
const SR_ADDR_KEY = 'swiggy_cart_addr';        // saved address picked in the cart (the only thing an order can use)
const SR_OWNER_KEY = 'swiggy_search_owner';    // account the saved search / cart / address belong to

const sr = {
    loc: null,            // search location { lat, lng, title, sub }: where restaurants / prices are looked up
    addr: null,           // cart delivery address { addressId, lat, lng, title, sub, addr }: chosen from saved addresses in the cart
    owner: '',
    query: '',
    seq: 0,               // guards against out-of-order responses
    timer: null,
    results: [],
    restaurant: null,     // restaurant currently open in the menu view
    metadata: '',
    categories: [],
    menuItems: {},        // id -> dish
    cart: { restaurant: null, lines: [], cartId: '', bill: null, message: '' },
    cartTimer: null,
    cartSeq: 0,
    addon: null,          // item being customised
};

const SR_PIN_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const SR_NAV_PIN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const SR_MAP_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5"/><path d="M15 6.5v5"/><path d="M18.5 14.2c0 2.2-3 4.8-3 4.8s-3-2.6-3-4.8a3 3 0 0 1 6 0z" fill="currentColor" stroke="none"/><circle cx="15.5" cy="14.2" r="1" fill="var(--bg-card)" stroke="none"/></svg>';
const srLoader = text => `<div class="inline-loader"><span class="ring"></span><span class="il-text">${text}</span></div>`;
const srEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const srRs = paise => '₹' + (Math.round(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const srEl = id => document.getElementById(id);
const srJson = async (url, opts) => {
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-json */ }
    if (!res.ok && !data.error) data.error = data.detail || `Request failed (${res.status})`;
    if (data.is_expired || res.status === 401) data.is_expired = true;
    return data;
};

// where the cart is priced: the chosen delivery address, else the search location
const srCartPoint = () => sr.addr || sr.loc;

// switching account clears the old account's places (search location + cart address) and search;
// the cart's items stay, only its Swiggy side (cart id, bill, coupon) is redone on the new account
function srAccountChanged(mobile) {
    mobile = String(mobile || '');
    if (sr.owner && sr.owner !== mobile) {
        clearTimeout(sr.timer); clearTimeout(sr.cartTimer);
        sr.seq++; sr.cartSeq++;
        sr.loc = null; sr.addr = null;
        sr.query = ''; sr.results = []; sr.restaurant = null; sr.metadata = ''; sr.categories = []; sr.menuItems = {}; sr._addrs = null; sr._places = null;
        [SR_LOC_KEY, SR_ADDR_KEY].forEach(k => localStorage.removeItem(k));
        Object.assign(sr.cart, { cartId: '', bill: null, billLines: [], coupon: null, one: null, planId: '', oos: [], message: '', error: '', dirty: false, syncing: false });
        srSaveCart();
        if (window.scOnCartReset) scOnCartReset();
        srUpdateCartBar();
        const q = srEl('srQuery') || document.querySelector('#view-search input[type="text"]');
        if (q) q.value = '';
        if (window.srBackToResults) { try { srBackToResults(); } catch (e) { /* menu view not open */ } }
        srRenderLoc();
        if (window.scRenderAddr) scRenderAddr();
        if (window.srRenderResults && state.activeTab === 'search') { try { srRenderResults(); } catch (e) { /* nothing to draw yet */ } }
    }
    sr.owner = mobile;
    localStorage.setItem(SR_OWNER_KEY, mobile);
}

/* ── init / tab hook ───────────────────────────────── */

(function srInit() {
    try { sr.loc = JSON.parse(localStorage.getItem(SR_LOC_KEY) || 'null'); } catch (e) { sr.loc = null; }
    try { sr.addr = JSON.parse(localStorage.getItem(SR_ADDR_KEY) || 'null'); } catch (e) { sr.addr = null; }
    sr.owner = localStorage.getItem(SR_OWNER_KEY) || '';
    // older versions kept the address inside the search location: the location stays, the address must be picked again
    if (sr.loc && sr.loc.addressId) { sr.loc = { ...sr.loc, addressId: '', addr: null }; localStorage.setItem(SR_LOC_KEY, JSON.stringify(sr.loc)); }
    try { const c = JSON.parse(localStorage.getItem('swiggy_search_cart') || 'null'); if (c && c.lines) sr.cart = c; } catch (e) { /* fresh cart */ }
    const orig = window.switchTab;
    window.switchTab = function (tabId, ...rest) {
        orig(tabId, ...rest);
        if (tabId === 'search') srOnShow();
        if (tabId !== 'search') srEl('srCartBar') && (srEl('srCartBar').style.display = 'none');
        else srUpdateCartBar();
    };
    document.addEventListener('DOMContentLoaded', () => { srRenderLoc(); if (state.activeTab === 'search') srOnShow(); });
})();

function srSyncLocBar() {
    const bar = srEl('srLocBar');
    if (!bar) return;
    const inMenu = srEl('srMenuView') && srEl('srMenuView').style.display !== 'none';
    bar.classList.toggle('sr-hide', inMenu || !!sr.query);
    // a restaurant page is full screen: no web header while it is open
    const header = document.querySelector('.app-header');
    if (header && state.activeTab === 'search') header.style.display = inMenu ? 'none' : 'flex';
}

function srOnShow() {
    const has = !!state.activeSession;
    srEl('srNoAccount').style.display = has ? 'none' : 'flex';
    srEl('srContent').style.display = has ? 'block' : 'none';
    if (!has) return;
    // cart belongs to one account; drop it if the user switched account
    if (sr.cart.mobile && sr.cart.mobile !== String(state.activeMobile)) srResetCart();
    srRenderLoc();
    if (!sr.loc) srOpenLocationSheet();
    else if (!sr.query) srRenderResults();
    srUpdateCartBar();
    srSyncLocBar();
}

/* ── location ──────────────────────────────────────── */

function srRenderLoc() {
    const t = srEl('srLocTitle'), s = srEl('srLocSub');
    if (!t) return;
    t.textContent = sr.loc ? sr.loc.title : 'Select your location';
    s.textContent = sr.loc ? sr.loc.sub : 'Tap to choose where to deliver';
}

function srSetLocation(loc) {
    const changed = !sr.loc || sr.loc.lat !== loc.lat || sr.loc.lng !== loc.lng;
    sr.loc = loc;
    localStorage.setItem(SR_LOC_KEY, JSON.stringify(loc));
    // a newly searched location wins over a delivery address picked earlier somewhere else
    // (else the cart stays priced there and restaurants near the new spot show unavailable)
    if (changed && sr.addr && (Math.abs(sr.addr.lat - loc.lat) > 1e-6 || Math.abs(sr.addr.lng - loc.lng) > 1e-6)) {
        sr.addr = null;
        localStorage.removeItem(SR_ADDR_KEY);
    }
    srRenderLoc();
    srCloseSheet(null, 'srLocSheet');
    if (window.scRenderAddr) scRenderAddr();
    // keep the cart; reprice it for the new spot
    if (sr.cart.lines.length && changed) srSyncCart();
    if (changed && state.activeTab === 'search') {
        srBackToResults();
        if (sr.query.length >= 2) srRunSearch(sr.query);
        else srRenderResults();
    }
}

async function srOpenLocationSheet() {
    srEl('srLocSheet').classList.remove('hidden');
    const list = srEl('srLocList');
    list.innerHTML = srLoader('Loading your addresses');
    try {
        const data = await srJson(`/api/addresses/${state.activeMobile}?force=false`);
        const addrs = (data.addresses || []).filter(a => a.lat && a.lng);
        sr._addrs = addrs;
        if (!addrs.length) {
            list.innerHTML = '<div class="sr-empty-line"><i class="fa-solid fa-location-dot"></i> No saved addresses — use current location</div>';
            return;
        }
        list.innerHTML = addrs.map((a, i) => {
            const tag = String(a.annotation || a.address_type || a.label || 'Home');
            const tagClass = tag.toLowerCase() === 'home' ? 'home' : 'work';
            const name = a.receiver_name || a.name || '';
            const phone = a.receiver_mobile || a.phone || a.mobile || '';
            const text = a.display || a.formatted_address || a.address || a.house || '';
            const on = sr.loc && Math.abs(sr.loc.lat - a.lat) < 1e-6 && Math.abs(sr.loc.lng - a.lng) < 1e-6;
            return `<button type="button" class="sr-addr-row sr-saved ${on ? 'on' : ''}" style="animation-delay:${i * 30}ms" onclick="srPickAddress(${i})">
                <span class="sr-addr-ico pin">${SR_NAV_PIN}</span>
                <span class="sr-addr-body">
                    <span class="sr-saved-top"><span class="addr-label ${tagClass}">${srEsc(tag)}</span>${a.is_global ? '' : '<span class="addr-acc-tag">Account address</span>'}</span>
                    ${name ? `<span class="sr-saved-name">${srEsc(name)}${phone ? ` <em>| +91 ${srEsc(phone)}</em>` : ''}</span>` : ''}
                    <small>${srEsc(text)}</small>
                </span>
                ${on ? '<i class="fa-solid fa-circle-check sr-addr-check"></i>' : ''}
            </button>`;
        }).join('');
    } catch (e) {
        list.innerHTML = '<div class="sr-empty-line">Could not load saved addresses</div>';
    }
}

function srPickAddress(i) {
    const a = (sr._addrs || [])[i];
    if (!a) return;
    const text = a.formatted_address || a.address || a.house || '';
    srSetLocation({
        lat: Number(a.lat), lng: Number(a.lng),
        title: (a.annotation || a.label || 'Saved address').toString(),
        sub: text.length > 60 ? text.slice(0, 60) + '…' : text,
    });
}

async function srGeoDone(lat, lng) {
    let title = 'Current location', text = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    try {
        const d = await srJson(`/api/location/reverse?lat=${lat}&lng=${lng}&mobile=${encodeURIComponent(state.activeMobile || '')}`);
        const l = d.location || {};
        const full = l.address || l.formatted_address || '';
        if (full) { title = l.area || l.city || full.split(',')[0] || title; text = full.length > 60 ? full.slice(0, 60) + '…' : full; }
    } catch (e) { /* keep coordinates */ }
    srEl('srGpsSub').textContent = 'Using GPS';
    srSetLocation({ lat, lng, title, sub: text, full: text });
}

function srGeoFail(msg) {
    srEl('srGpsSub').textContent = 'Using GPS';
    showToast(msg, true, 3500);
    srEl('srPlaceQuery').focus();
}

function srUseCurrentLocation() {
    srEl('srGpsSub').textContent = 'Locating you…';
    const tg = window.Telegram && window.Telegram.WebApp;
    const lm = tg && tg.LocationManager;
    // Telegram's own location API — only used when the browser GPS call fails
    const telegramGeo = fallbackMsg => {
        if (!(lm && lm.init)) { srGeoFail(fallbackMsg); return; }
        lm.init(() => {
            if (!lm.isInited || !lm.isLocationAvailable) { srGeoFail(fallbackMsg); return; }
            lm.getLocation(loc => {
                if (loc) srGeoDone(loc.latitude, loc.longitude);
                else srGeoFail('Allow location access for this app in Telegram settings, or search your area above');
            });
        });
    };
    if (!navigator.geolocation) { telegramGeo('GPS not available here — search your area above'); return; }
    // same call the Add-address map uses (that one works in the mini app)
    navigator.geolocation.getCurrentPosition(
        pos => srGeoDone(pos.coords.latitude, pos.coords.longitude),
        err => telegramGeo(err.code === 1
            ? 'Location permission denied — allow it in settings, or search your area above'
            : 'Could not get your GPS position — search your area above'),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

/* place search — same calls as the Swiggy app (swiggy_location.har):
   maps.swiggy.com/place/autocomplete (biased to a nearby point) -> address/recommend?place_id */

let srPlaceTimer = null, srPlaceSeq = 0;

function srBiasPoint() {
    if (sr.loc) return sr.loc;
    const a = (sr._addrs || [])[0];
    return a ? { lat: Number(a.lat), lng: Number(a.lng) } : null;
}

function srPlaceIcon(types = []) {
    if (types.includes('food') || types.includes('restaurant')) return 'fa-utensils';
    if (types.includes('lodging')) return 'fa-hotel';
    if (types.includes('establishment')) return 'fa-building';
    if (types.includes('route')) return 'fa-road';
    return 'fa-map-pin';
}

function srClearPlace() {
    const inp = srEl('srPlaceQuery');
    inp.value = '';
    srOnPlaceQuery('');
    inp.focus();
}

function srOnPlaceQuery(v) {
    const q = v.trim();
    srEl('srPlaceClear').style.display = v ? 'grid' : 'none';
    clearTimeout(srPlaceTimer);
    srEl('srLocDefault').style.display = q ? 'none' : 'block';
    const box = srEl('srPlaceResults');
    if (q.length < 3) { box.innerHTML = ''; srPlaceSeq++; return; }
    box.innerHTML = srLoader('Finding places');
    srPlaceTimer = setTimeout(async () => {
        const my = ++srPlaceSeq;
        const bias = srBiasPoint();
        const url = `/api/location/autocomplete?query=${encodeURIComponent(q)}&mobile=${encodeURIComponent(state.activeMobile || '')}` +
            (bias ? `&lat=${bias.lat}&lng=${bias.lng}` : '');
        const d = await srJson(url).catch(() => ({}));
        if (my !== srPlaceSeq) return;
        sr._places = d.results || [];
        box.innerHTML = sr._places.length ? sr._places.map((p, i) => `
            <button type="button" class="sr-addr-row" style="animation-delay:${i * 30}ms" onclick="srPickPlace(${i})">
                <span class="sr-addr-ico pin">${SR_PIN_SVG}</span>
                <span class="sr-addr-body"><b>${srHighlight(p.main_text || p.description || '', q)}</b><small>${srEsc(p.secondary_text || p.description)}</small></span>
                <i class="fa-solid fa-arrow-right sr-brand-go"></i>
            </button>`).join('') : srMsg('fa-map-location-dot', 'No places found', 'Try a nearby landmark, area or street');
    }, 300);
}

async function srPickPlace(i) {
    const p = (sr._places || [])[i];
    if (!p) return;
    const box = srEl('srPlaceResults');
    const row = box.querySelectorAll('.sr-addr-row')[i];
    if (row) row.classList.add('loading');
    let lat = Number(p.lat), lng = Number(p.lng), full = p.description || p.main_text || '', area = '';
    if (!(lat && lng)) {
        const d = await srJson(`/api/location/place?place_id=${encodeURIComponent(p.place_id || '')}&mobile=${encodeURIComponent(state.activeMobile || '')}`).catch(() => ({}));
        if (row) row.classList.remove('loading');
        if (!d.success || !d.details || !d.details.lat) { showToast('Could not load that place', true); return; }
        lat = Number(d.details.lat); lng = Number(d.details.lng); full = d.details.address || full; area = d.details.area || '';
    }
    srEl('srPlaceQuery').value = '';
    srEl('srPlaceClear').style.display = 'none';
    box.innerHTML = '';
    srEl('srLocDefault').style.display = 'block';
    srSetLocation({ lat, lng, title: p.main_text || area || full.split(',')[0], sub: full.length > 60 ? full.slice(0, 60) + '…' : full, full });
}

function srCloseSheet(e, id) {
    if (e && e.target !== e.currentTarget) return;
    srEl(id).classList.add('hidden');
}

/* ── restaurant suggestions ────────────────────────── */

function srOnQuery(v) {
    sr.query = v.trim();
    srEl('srClearBtn').style.display = v ? 'grid' : 'none';
    srSyncLocBar();
    clearTimeout(sr.timer);
    if (sr.query.length < 2) { sr.seq++; sr.results = []; srRenderResults(); return; }
    srEl('srResults').innerHTML = '<div class="sr-skel"></div><div class="sr-skel"></div><div class="sr-skel"></div>';
    sr.timer = setTimeout(() => srRunSearch(sr.query), 450);   // wait for a typing pause: each search is many proxy calls
}

function srClearQuery() {
    srEl('srQuery').value = '';
    srOnQuery('');
    srEl('srQuery').focus();
}

function srQuick(q) {
    srEl('srQuery').value = q;
    srOnQuery(q);
}

async function srRunSearch(q) {
    if (!sr.loc) { srOpenLocationSheet(); return; }
    const my = ++sr.seq;
    const d = await srJson(`/api/search/restaurants?mobile=${encodeURIComponent(state.activeMobile)}&q=${encodeURIComponent(q)}&lat=${sr.loc.lat}&lng=${sr.loc.lng}`).catch(() => ({ error: 'Network error' }));
    if (my !== sr.seq) return;
    if (d.is_expired) { srEl('srResults').innerHTML = srMsg('fa-user-lock', 'Session expired', 'Login again with this number'); return; }
    if (!d.success) { srEl('srResults').innerHTML = srMsg('fa-triangle-exclamation', 'Search failed', d.error || 'Try again'); return; }
    sr.results = d.restaurants || [];
    srRenderResults();
}


const SR_BRANDS = ["Domino's", 'KFC', "McDonald's", 'Pizza Hut', 'Burger King', 'Subway', 'Wow! Momo', 'Haldiram'];

// idle state — same empty-state card the other tabs use (blinkit_bot style) + restaurant chips
function srHomeHtml() {
    return `
        <div class="full-page-empty compact">
            <div class="fpe-ring">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M3 9h18v1a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M5 12.5V20h14v-7.5"/><path d="M10 20v-4h4v4"/></svg>
            </div>
            <div class="fpe-title">Search Restaurants</div>
            <div class="fpe-sub">Type a restaurant name to see its menu and add dishes to your cart</div>
        </div>
        <div class="sr-quick-label">Popular restaurants</div>
        <div class="sr-quick">${SR_BRANDS.map(q => `<button type="button" class="sr-quick-chip" onclick="srQuick(this.dataset.q)" data-q="${srEsc(q)}">${srEsc(q)}</button>`).join('')}</div>`;
}

function srMsg(icon, title, sub) {
    return `<div class="sr-msg"><div class="sr-msg-ico"><i class="fa-solid ${icon}"></i></div><div class="sr-msg-title">${srEsc(title)}</div><div class="sr-msg-sub">${srEsc(sub)}</div></div>`;
}

function srHighlight(name, q) {
    const i = name.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0 || !q) return srEsc(name);
    return srEsc(name.slice(0, i)) + '<mark>' + srEsc(name.slice(i, i + q.length)) + '</mark>' + srEsc(name.slice(i + q.length));
}

function srStatusPill(a, cls = 'sr-rcard-status') {
    if (!a || a.opened === null || a.opened === undefined || !a.text) return '';
    const st = a.opened === false ? 'closed' : a.closing_soon ? 'soon' : 'open';
    return `<span class="${cls} ${st}"><span class="sr-status-dot"></span>${srEsc(a.text)}${a.sub ? `<em>${srEsc(a.sub)}</em>` : ''}</span>`;
}

function srResultCard(r, i, click = `srOpenRestaurant(${i})`) {
    const a = r.availability || {};
    const closed = a.opened === false;
    const place = [r.area, r.distance].filter(Boolean).map(srEsc).join('<span class="sr-dot"></span>');
    let status = '';
    if (closed) status = `<span class="sr-rc-state closed"><i class="fa-solid fa-moon"></i>${srEsc(a.sub || 'Closed now')}</span>`;
    return `<button type="button" class="sr-rc ${closed ? 'closed' : ''}" style="animation-delay:${Math.min(i, 10) * 45}ms" onclick="${click}">
        <span class="sr-rc-img">
            ${r.image ? `<img src="${srEsc(r.image)}" loading="lazy" alt="" onerror="this.remove()">` : ''}
            <i class="fa-solid fa-store"></i>
            ${closed ? '<span class="sr-rc-closed">CLOSED</span>' : ''}
        </span>
        <span class="sr-rc-body">
            <span class="sr-rc-name">${srHighlight(r.name, sr.query)}</span>
            <span class="sr-rc-meta">
                ${r.rating ? `<span class="sr-rc-rating"><i class="fa-solid fa-star"></i>${srEsc(r.rating)}</span>` : ''}
                ${r.ratings_count ? `<span class="sr-muted">${srEsc(r.ratings_count)} ratings</span>` : ''}
                ${r.sla && !closed ? `<span class="sr-rc-time"><i class="fa-regular fa-clock"></i>${srEsc(r.sla.toLowerCase())}</span>` : ''}
            </span>
            ${(r.cuisines || []).length ? `<span class="sr-rc-line">${srEsc(r.cuisines.slice(0, 3).join(', '))}</span>` : ''}
            ${place ? `<span class="sr-rc-line"><i class="fa-solid fa-location-dot"></i>${place}</span>` : ''}
            ${status}
        </span>
        <span class="sr-rc-go"><i class="fa-solid fa-chevron-right"></i></span>
    </button>`;
}

function srRenderResults() {
    const box = srEl('srResults');
    if (sr.query.length < 2) { box.innerHTML = srHomeHtml(); return; }
    if (!sr.results.length) { box.innerHTML = srMsg('fa-store-slash', 'No restaurants found', `Nothing matches “${sr.query}” here`); return; }
    const open = sr.results.filter(r => r.availability && r.availability.opened !== false).length;
    box.innerHTML = `<div class="sr-count"><b>${sr.results.length}</b>&nbsp;restaurant${sr.results.length > 1 ? 's' : ''}<span class="sr-count-open"><span class="sr-status-dot"></span>${open} open now</span></div>` +
        sr.results.map((r, i) => srResultCard(r, i)).join('');
}

/* ── search inside the restaurant (Swiggy's menu/search, as you type) ─────── */

function srMsReset() {
    sr.ms = { q: '', seq: 0, timer: null, items: null, loading: false, cat: '' };
    const inp = srEl('srMsInput');
    if (inp) inp.value = '';
    srMsShowClear();
    srMsHideSugg();
}

function srMsShowClear() { const b = srEl('srMsClear'); if (b) b.style.display = sr.ms && sr.ms.q ? '' : 'none'; }

// what the loaded menu already has: instant results while Swiggy answers
function srMsLocal(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    sr.categories.forEach(c => c.items.forEach(it => {
        const name = it.name.toLowerCase(), cat = (c.name || '').toLowerCase();
        const nameWords = name.split(/[^a-z0-9]+/);
        let score = 0;
        if (name.startsWith(words.join(' '))) score += 4;
        words.forEach(w => {
            if (nameWords.some(x => x.startsWith(w))) score += 2;
            else if (name.includes(w)) score += 1;
            else if (cat.includes(w)) score += 0.5;
            else score -= 10;
        });
        if (score > 0) out.push({ it, score });
    }));
    return out.sort((a, b) => b.score - a.score).map(x => x.it);
}

function srMsMark(text, q) {
    const s = srEsc(text);
    const w = q.trim().split(/\s+/).filter(x => x.length > 0).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return w.length ? s.replace(new RegExp(`(${w.join('|')})`, 'ig'), '<mark>$1</mark>') : s;
}

function srMsInput(v) {
    sr.ms.q = v.trim();
    sr.ms.cat = '';
    srMsShowClear();
    clearTimeout(sr.ms.timer);
    if (!sr.ms.q) { sr.ms.items = null; srMsSuggest(); srRenderMenu(); return; }
    sr.ms.items = null;
    srMsSuggest();
    srRenderMenu();
    if (sr.ms.q.length >= 2) sr.ms.timer = setTimeout(srMsFetch, 300);
}

async function srMsFetch() {
    const q = sr.ms.q, my = ++sr.ms.seq;
    sr.ms.loading = true;
    const d = await srJson('/api/search/menu_search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.activeMobile, restaurant_id: sr.restaurant.id, query: q, veg: srEl('srVegOnly').checked,
                               lat: sr.loc.lat, lng: sr.loc.lng }),
    }).catch(() => ({}));
    if (my !== sr.ms.seq || q !== sr.ms.q) return;   // typed again meanwhile
    sr.ms.loading = false;
    if (d.success) {
        // reuse the menu's item objects so ADD / +/- stay in sync with the menu
        sr.ms.items = (d.items || []).map(it => sr.menuItems[it.id] || (sr.menuItems[it.id] = it));
    }
    srMsSuggest();
    srRenderMenu();
}

function srMsResults() {
    if (sr.ms.cat) return (sr.categories.find(c => c.name === sr.ms.cat) || { items: [] }).items;
    const local = srMsLocal(sr.ms.q);
    if (!sr.ms.items) return local;
    // Swiggy's order first, then anything only the local match found
    const ids = new Set(sr.ms.items.map(i => i.id));
    return [...sr.ms.items, ...local.filter(i => !ids.has(i.id))];
}

function srMsFocus() {
    srMsSuggest();
}

function srMsHideSugg() { const s = srEl('srMsSugg'); if (s) { s.innerHTML = ''; s.classList.remove('open'); } }

function srMsBlur() { setTimeout(srMsHideSugg, 180); }   // let a tap on a suggestion land first

// the dropdown: dishes + matching categories while typing, category chips when empty
function srMsSuggest() {
    const box = srEl('srMsSugg');
    if (!box || document.activeElement !== srEl('srMsInput')) return;
    const q = sr.ms.q;
    let html = '';
    if (!q) {
        const cats = sr.categories.filter(c => c.items.length).slice(0, 10);
        if (cats.length) html = `<div class="sr-ms-sh">Explore this menu</div><div class="sr-ms-chips">${cats.map(c =>
            `<button type="button" class="sr-ms-chip" onmousedown="event.preventDefault()" onclick="srMsCategory('${srEsc(c.name).replace(/'/g, "\\'")}')">${srEsc(c.name)}<em>${c.items.length}</em></button>`).join('')}</div>`;
    } else {
        const veg = srEl('srVegOnly').checked;
        const dishes = srMsResults().filter(it => !veg || it.is_veg).slice(0, 6);
        const lq = q.toLowerCase();
        const cats = sr.categories.filter(c => c.name.toLowerCase().includes(lq)).slice(0, 2);
        html = dishes.map(it => `<button type="button" class="sr-ms-row" onmousedown="event.preventDefault()" onclick="srMsPick('${srEsc(it.id)}')">
                <span class="sr-diet ${it.is_veg ? 'veg' : 'nonveg'}"><i></i></span>
                <span class="sr-ms-row-t"><b>${srMsMark(it.name, q)}</b><small>${srEsc(it.category || '')}</small></span>
                <span class="sr-ms-row-p">${srRs(it.final_price || it.price)}</span>
                ${it.image ? `<img src="${srEsc(it.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
            </button>`).join('')
            + cats.map(c => `<button type="button" class="sr-ms-row cat" onmousedown="event.preventDefault()" onclick="srMsCategory('${srEsc(c.name).replace(/'/g, "\\'")}')">
                <span class="sr-ms-cat-ico"><i class="fa-solid fa-layer-group"></i></span>
                <span class="sr-ms-row-t"><b>See all in ${srMsMark(c.name, q)}</b><small>${c.items.length} items</small></span>
                <i class="fa-solid fa-chevron-right sr-ms-go"></i></button>`).join('');
        if (!html) html = sr.ms.loading || (q.length >= 2 && !sr.ms.items)
            ? `<div class="sr-ms-none"><i class="fa-solid fa-spinner fa-spin"></i> Searching…</div>`
            : `<div class="sr-ms-none">No dishes match "${srEsc(q)}"</div>`;
    }
    box.innerHTML = html;
    box.classList.toggle('open', !!html);
}

function srMsPick(id) {
    const it = sr.menuItems[id];
    if (!it) return;
    const inp = srEl('srMsInput');
    inp.value = it.name;
    inp.blur();
    srMsInput(it.name);
    srMsHideSugg();
}

function srMsCategory(name) {
    const inp = srEl('srMsInput');
    inp.value = name;
    inp.blur();
    clearTimeout(sr.ms.timer);
    sr.ms.q = name; sr.ms.cat = name; sr.ms.items = null;
    srMsShowClear();
    srMsHideSugg();
    srRenderMenu();
}

function srMsClear() {
    srMsReset();
    srRenderMenu();
    srEl('srMsInput').focus();
}

function srMsResultsHtml() {
    const veg = srEl('srVegOnly').checked;
    const items = srMsResults().filter(it => !veg || it.is_veg);
    const label = sr.ms.cat ? `in <b>${srEsc(sr.ms.cat)}</b>` : `for <b>"${srEsc(sr.ms.q)}"</b>`;
    const busy = !sr.ms.cat && sr.ms.q.length >= 2 && !sr.ms.items;
    if (!items.length) {
        return busy ? '<div class="sr-skel"></div><div class="sr-skel"></div>'
            : srMsg('fa-magnifying-glass', 'No dishes found', `Nothing ${sr.ms.cat ? 'in' : 'matches'} "${sr.ms.q}"${veg ? ' (veg only)' : ''} in this menu`);
    }
    return `<div class="sr-ms-count">${items.length} result${items.length > 1 ? 's' : ''} ${label}${busy ? '<i class="fa-solid fa-spinner fa-spin"></i>' : ''}</div>
        <div class="sr-ms-results">${items.map(srDishHtml).join('')}</div>`;
}

/* ── menu ──────────────────────────────────────────── */

function srBackToResults() {
    srEl('srMenuView').style.display = 'none';
    srEl('srSearchView').style.display = 'block';
    srSyncLocBar();
}

function srOpenRestaurant(i) { srOpenRest(sr.results[i]); }

async function srOpenRest(r) {
    if (!r) return;
    srEl('srSearchView').style.display = 'none';
    srEl('srMenuView').style.display = 'block';
    srSyncLocBar();
    srEl('srMenuTopTitle').textContent = '';
    srMsReset();
    sr.outlets = [];
    srEl('srMenuSearch').style.display = 'none';   // the dish search only makes sense once the menu is here
    srEl('srMenuHeader').innerHTML = '<div class="sr-skel tall"></div>';
    srEl('srMenuList').innerHTML = '<div class="sr-skel"></div><div class="sr-skel"></div><div class="sr-skel"></div><div class="sr-skel"></div>';
    window.scrollTo({ top: 0 });

    const d = await srJson('/api/search/menu', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.activeMobile, restaurant_id: r.id, query: sr.query || r.name, metadata: r.metadata || '', lat: sr.loc.lat, lng: sr.loc.lng }),
    }).catch(() => ({ error: 'Network error' }));
    if (!d.success) {
        srEl('srMenuHeader').innerHTML = '';
        srEl('srMenuList').innerHTML = srMsg('fa-triangle-exclamation', d.is_expired ? 'Session expired' : 'Menu unavailable', d.error || 'Try again');
        return;
    }
    sr.restaurant = { ...r, ...d.restaurant, id: r.id, parent_id: d.restaurant.parent_id || r.parent_id, name: d.restaurant.name || r.name };
    sr.categories = d.categories || [];
    sr.menuItems = {};
    sr.categories.forEach(c => c.items.forEach(it => { sr.menuItems[it.id] = it; }));
    srEl('srMenuTopTitle').textContent = sr.restaurant.name;
    srEl('srMenuSearch').style.display = '';
    srRenderMenuHeader();
    srRenderMenu();
    srLoadOutlets(r.id);
}

/* ── other outlets of the same brand (outlet.har: MENU_MULTI_OUTLET) ─────── */

async function srLoadOutlets(id) {
    const d = await srJson('/api/search/outlets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.activeMobile, restaurant_id: id, lat: sr.loc.lat, lng: sr.loc.lng }),
    }).catch(() => ({}));
    if (!sr.restaurant || String(sr.restaurant.id) !== String(id)) return;   // switched away meanwhile
    sr.outlets = d.success ? (d.outlets || []) : [];
    if (sr.outlets.length) srRenderMenuHeader();
}

function srOpenOutletSheet() {
    if (!sr.outlets || !sr.outlets.length) return;
    const cur = sr.restaurant;
    srEl('srOutletCurrent').innerHTML = `<i class="fa-solid fa-circle-check"></i> Now viewing <b>${srEsc([cur.area, cur.distance].filter(Boolean).join(' · ') || cur.name)}</b>`;
    srEl('srOutletList').innerHTML = sr.outlets.map((o, i) => srResultCard(o, i, `srPickOutlet(${i})`)).join('');
    srEl('srOutletSheet').classList.remove('hidden');
}

function srPickOutlet(i) {
    const o = (sr.outlets || [])[i];
    if (!o) return;
    srCloseSheet(null, 'srOutletSheet');
    srOpenRest({ ...o, metadata: '' });
}

function srIsClosed() { return !!(sr.restaurant && sr.restaurant.availability && sr.restaurant.availability.opened === false); }

function srRenderMenuHeader() {
    const r = sr.restaurant;
    const a = r.availability || {};
    const closed = a.opened === false;
    const cover = r.cover || r.image;
    const outlet = [r.area, r.city].filter(Boolean).join(', ');
    const m = (r.sla || '').toLowerCase().match(/^([\d\s\-–]+)\s*(.*)$/);
    const etaNum = m ? m[1].trim() : '';
    const etaUnit = m ? (m[2] || 'mins') : '';
    srEl('srMenuHeader').innerHTML = `
        <div class="sr-rh ${closed ? 'closed' : ''}">
            ${cover ? `<img class="sr-rh-bg" src="${srEsc(cover)}" alt="" onerror="this.remove()">` : ''}
            <div class="sr-rh-shade"></div>
            <div class="sr-rh-content">
                <div class="sr-rh-top">
                    <div class="sr-rh-name">${srEsc(r.name)}</div>
                    ${r.rating ? `<span class="sr-rh-rating"><i class="fa-solid fa-star"></i>${srEsc(r.rating)}${r.ratings_count ? `<small>${srEsc(r.ratings_count.replace(/\s*ratings?/i, ''))}</small>` : ''}</span>` : ''}
                </div>
                <div class="sr-rh-info">
                    ${(sr.outlets || []).length ? `<button type="button" class="sr-rh-cell grow sr-rh-outlet" onclick="srOpenOutletSheet()">
                        <span class="sr-rh-ico"><i class="fa-solid fa-store"></i></span>
                        <span class="sr-rh-txt"><small>Outlet · ${sr.outlets.length} more</small><b>${srEsc(outlet || '—')} <i class="fa-solid fa-chevron-down"></i></b></span>
                    </button>` : `<div class="sr-rh-cell grow">
                        <span class="sr-rh-ico"><i class="fa-solid fa-store"></i></span>
                        <span class="sr-rh-txt"><small>Outlet</small><b>${srEsc(outlet || '—')}</b></span>
                    </div>`}
                    ${etaNum ? `<div class="sr-rh-sep"></div>
                    <div class="sr-rh-cell">
                        <span class="sr-rh-txt right"><small>${srEsc(r.distance || 'Delivery')}</small><b>${srEsc(etaNum)} <em>${srEsc(etaUnit)}</em></b></span>
                    </div>` : ''}
                </div>
                ${closed ? `<div class="sr-rh-closed"><i class="fa-solid fa-moon"></i><b>Closed now</b>${a.sub ? `<span>${srEsc(a.sub)}</span>` : ''}</div>` : ''}
            </div>
        </div>
        ${r.serviceable === false ? '<div class="sr-warn"><i class="fa-solid fa-circle-exclamation"></i> Not deliverable to your location</div>' : ''}`;
}

function srRenderMenu() {
    const veg = srEl('srVegOnly').checked;
    if (sr.ms && sr.ms.q) { srEl('srMenuList').innerHTML = srMsResultsHtml(); return; }
    const html = sr.categories.map((c, ci) => {
        const items = c.items.filter(it => !veg || it.is_veg);
        if (!items.length) return '';
        return `<section class="sr-mc ${ci < 2 ? 'open' : ''}">
            <button type="button" class="sr-mc-head" onclick="this.parentElement.classList.toggle('open')">
                <span class="sr-mc-name">${srEsc(c.name)}</span><span class="sr-mc-count">${items.length}</span>
                <i class="fa-solid fa-chevron-down"></i>
            </button>
            <div class="sr-mc-body">${items.map(srDishHtml).join('')}</div>
        </section>`;
    }).join('');
    srEl('srMenuList').innerHTML = html || srMsg('fa-bowl-food', 'No items', veg ? 'No veg items in this menu' : 'This menu is empty');
}

function srDishHtml(it) {
    const price = it.final_price || it.price;
    const off = it.final_price ? Math.round((1 - it.final_price / it.price) * 100) : 0;
    const custom = srIsCustom(it);
    return `<div class="sr-dc ${it.in_stock ? '' : 'oos'} ${it.image ? '' : 'noimg'}" data-id="${srEsc(it.id)}">
        <div class="sr-dc-info">
            <span class="sr-diet ${it.is_veg ? 'veg' : 'nonveg'}"><i></i></span>
            <div class="sr-dc-name">${srEsc(it.name)}</div>
            <div class="sr-dc-price"><b>${srRs(price)}</b>${off > 0 ? `<s>${srRs(it.price)}</s><span class="sr-dc-off">${off}% OFF</span>` : ''}</div>
            ${it.description ? `<div class="sr-dc-desc">${srEsc(it.description)}</div>` : ''}
        </div>
        <div class="sr-dc-side">
            ${it.image ? `<div class="sr-dc-img"><img src="${srEsc(it.image)}" loading="lazy" alt="" onerror="this.parentElement.remove()"></div>` : ''}
            <div class="sr-dc-act" id="srAct-${srEsc(it.id)}">${srActHtml(it)}</div>
            ${custom && it.in_stock ? '<div class="sr-dc-custom">Customisable</div>' : ''}
        </div>
    </div>`;
}

function srQtyOf(id) { return sr.cart.lines.filter(l => l.id === id).reduce((n, l) => n + l.quantity, 0); }

function srActHtml(it) {
    if (!it.in_stock) return '<span class="sr-dc-soldout">Sold out</span>';
    if (srIsClosed() && !srQtyOf(it.id)) return '<button type="button" class="sr-add off" disabled>CLOSED</button>';
    const q = srQtyOf(it.id);
    if (!q) return `<button type="button" class="sr-add" onclick="srAdd('${srEsc(it.id)}')">ADD</button>`;
    return `<div class="sr-step">
        <button type="button" onclick="srStep('${srEsc(it.id)}',-1)" aria-label="Decrease"><i class="fa-solid fa-minus"></i></button>
        <span>${q}</span>
        <button type="button" onclick="srStep('${srEsc(it.id)}',1)" aria-label="Increase"><i class="fa-solid fa-plus"></i></button>
    </div>`;
}

function srRefreshAct(id) {
    const it = sr.menuItems[id], el = srEl('srAct-' + id);
    if (!it || !el) return;
    el.innerHTML = srActHtml(it);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
}

/* ── cart state ────────────────────────────────────── */

const SR_CART_KEY = 'swiggy_search_cart';

function srSaveCart() {
    const { syncing, dirty, ...keep } = sr.cart;
    if (keep.lines && keep.lines.length) localStorage.setItem(SR_CART_KEY, JSON.stringify(keep));
    else localStorage.removeItem(SR_CART_KEY);
}

function srResetCart() {
    sr.cart = { restaurant: null, lines: [], cartId: '', bill: null, message: '' };
    srSaveCart();
    if (window.scOnCartReset) scOnCartReset();
    srUpdateCartBar();
    Object.keys(sr.menuItems).forEach(srRefreshAct);
}

function srLineKey(id, addons, variants = []) {
    return id + '|' + variants.map(v => v.group_id + '=' + v.variation_id).sort().join(',') + '|' + addons.map(a => a.group_id + ':' + a.choice_id).sort().join(',');
}

// variants (size / crust ...) and add-ons both open the customisation sheet
const srIsCustom = it => (it.addon_groups || []).length > 0 || (it.variant_groups || []).length > 0;

// choices of a variant group that fit the other picks (some only exist for one size)
function srVChoices(g, vpicks) { return g.choices.filter(c => !c.depends || vpicks[c.depends.group_id] === c.depends.variation_id); }

// item price for these variant picks, before add-ons (paise)
//   v1: item price + each picked choice's price;  v2: the price Swiggy lists for that exact combination
function srVariantPrice(it, vpicks) {
    if (it.variant_mode === 'v2') {
        const m = (it.variant_pricing || []).find(p => Object.entries(p.combo).every(([g, v]) => vpicks[g] === v));
        return m ? (m.final_price || m.price) : (it.final_price || it.price);
    }
    let t = it.final_price || it.price;
    (it.variant_groups || []).forEach(g => { const c = g.choices.find(x => x.id === vpicks[g.id]); if (c) t += c.price; });
    return t;
}

// keep every group on a valid pick: Swiggy's preselected choice, else the first one in stock
function srFixVPicks(it, vpicks) {
    (it.variant_groups || []).forEach(g => {
        const list = srVChoices(g, vpicks).filter(c => c.in_stock);
        if (!list.some(c => c.id === vpicks[g.id])) {
            const pick = list.find(c => c.default) || list[0];
            if (pick) vpicks[g.id] = pick.id; else delete vpicks[g.id];
        }
    });
    return vpicks;
}

// names shown under a cart line: "Medium, Cheese Burst, Extra Cheese"
function srLineExtras(l) { return [...(l.variants || []).map(v => v.name), ...(l.addons || []).map(a => a.name)]; }
function srLinePrice(l) { return l.price + l.addons.reduce((n, a) => n + a.price, 0); }

function srAdd(id) {
    const it = sr.menuItems[id];
    if (!it) return;
    if (srIsClosed()) { showToast(`${sr.restaurant.name} is currently closed`, true); return; }
    if (sr.restaurant.serviceable === false) { showToast('This restaurant does not deliver to your location', true); return; }
    if (srIsCustom(it)) { srOpenAddons(it); return; }
    srAddLine(it, []);
}

function srStep(id, delta) {
    const it = sr.menuItems[id];
    const mine = sr.cart.lines.filter(l => l.id === id);
    if (!mine.length) { if (delta > 0) srAdd(id); return; }
    const line = mine[mine.length - 1];   // +/- acts on the most recently added variant
    if (delta > 0) {
        if (srIsCustom(it)) { srAddLine(it, line.addons, true, line.variants || []); return; }
        line.quantity += 1;
    } else {
        line.quantity -= 1;
        if (line.quantity <= 0) sr.cart.lines = sr.cart.lines.filter(l => l !== line);
    }
    srCartChanged([id]);
}

function srAddLine(it, addons, repeat = false, variants = []) {
    // one cart holds one restaurant; ask before replacing
    if (sr.cart.restaurant && sr.cart.restaurant.id !== sr.restaurant.id && sr.cart.lines.length) {
        customConfirm('Replace cart items?',
            `Your cart has items from ${sr.cart.restaurant.name}. Clear it and start a new cart from ${sr.restaurant.name}?`,
            () => { srResetCart(); _srAddLineNow(it, addons, repeat, variants); }, 'Replace');
        return;
    }
    _srAddLineNow(it, addons, repeat, variants);
}

function _srAddLineNow(it, addons, repeat = false, variants = []) {
    sr.cart.restaurant = { id: sr.restaurant.id, parent_id: sr.restaurant.parent_id, name: sr.restaurant.name, image: sr.restaurant.image || '', area: sr.restaurant.area || '', sla: sr.restaurant.sla || '' };
    sr.cart.mobile = String(state.activeMobile);
    const key = srLineKey(it.id, addons, variants);
    const vpicks = Object.fromEntries(variants.map(v => [v.group_id, v.variation_id]));
    let line = sr.cart.lines.find(l => l.key === key);
    if (line) line.quantity += 1;
    else sr.cart.lines.push({ key, id: it.id, name: it.name, image_id: it.image_id, is_veg: it.is_veg, quantity: 1,
        price: variants.length ? srVariantPrice(it, vpicks) : (it.final_price || it.price),
        base_price: it.base_price ?? (it.final_price || it.price),
        variants: variants.map(v => ({ ...v })), addons: addons.map(a => ({ ...a })) });
    srCartChanged([it.id]);
}

function srCartChanged(ids) {
    ids.forEach(srRefreshAct);
    if (!sr.cart.lines.length) { sr.cart.bill = null; sr.cart.cartId = ''; }
    sr.cart.dirty = sr.cart.lines.length > 0;   // waiting for the sync below
    srSaveCart();
    if (window.scRender) scRender();
    srUpdateCartBar();
    if (!srEl('srCartSheet').classList.contains('hidden')) srRenderCartSheet();
    clearTimeout(sr.cartTimer);
    if (sr.cart.lines.length) sr.cartTimer = setTimeout(srSyncCart, 450);
}

async function srSyncCart() {
    if (!srCartPoint()) {   // e.g. right after switching account: the items wait until a location is picked
        sr.cart.dirty = false; sr.cart.syncing = false; sr.cart.bill = null;
        sr.cart.error = 'Pick a delivery location to price your cart';
        if (window.scRenderSections) scRenderSections();
        srUpdateCartBar();
        return;
    }
    const my = ++sr.cartSeq;
    sr.cart.syncing = true;
    sr.cart.dirty = false;
    if (window.scRenderSections) scRenderSections();
    if (!srEl('srCartSheet').classList.contains('hidden')) srRenderCartSheet();
    const d = await srJson('/api/search/cart', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mobile: state.activeMobile, restaurant: sr.cart.restaurant,
            items: sr.cart.lines.map(l => ({ id: l.id, name: l.name, image_id: l.image_id, price: l.price, base_price: l.base_price, quantity: l.quantity, addons: l.addons, variants: l.variants || [] })),
            address_id: sr.addr?.addressId || '', cart_id: sr.cart.cartId, lat: srCartPoint().lat, lng: srCartPoint().lng,
            incognito: window.scPrefs ? scPrefs().incognito : true,
            plan_id: sr.cart.planId || '',
        }),
    }).catch(() => ({ error: 'Network error' }));
    if (my !== sr.cartSeq) return;
    sr.cart.syncing = false;
    if (d.success) { sr.cart.cartId = d.cart_id || sr.cart.cartId; sr.cart.bill = d.bill; sr.cart.billLines = d.bill_lines || []; sr.cart.coupon = d.coupon; sr.cart.one = d.swiggy_one || null; sr.cart.cartValue = d.cart_value; sr.cart.oos = (d.items || []).filter(i => !i.in_stock && !i.free).map(i => String(i.id)); sr.cart.message = d.message || ''; sr.cart.error = ''; }
    else { sr.cart.error = d.error || 'Could not price your cart'; sr.cart.bill = null; sr.cart.billLines = []; if (d.is_expired) showToast('Session expired — login again', true); }
    srSaveCart();
    if (window.scOnCartPriced) scOnCartPriced(d);
    srUpdateCartBar();
    if (!srEl('srCartSheet').classList.contains('hidden')) srRenderCartSheet();
}

/* ── cart bar + sheet ──────────────────────────────── */

function srUpdateCartBar() {
    const bar = srEl('srCartBar');
    if (!bar) return;
    const count = sr.cart.lines.reduce((n, l) => n + l.quantity, 0);
    if (!count || state.activeTab !== 'search') { bar.style.display = 'none'; return; }
    const sub = sr.cart.lines.reduce((n, l) => n + srLinePrice(l) * l.quantity, 0);
    srEl('srCartBarCount').textContent = `${count} item${count > 1 ? 's' : ''} · ${sr.cart.restaurant.name}`;
    srEl('srCartBarTotal').textContent = srRs(sr.cart.bill ? sr.cart.bill.to_pay * 100 : sub);
    bar.style.display = 'flex';
}

function srOpenCartSheet() { switchTab('cart'); }

function srCartStep(i, delta) {
    const l = sr.cart.lines[i];
    if (!l) return;
    l.quantity += delta;
    if (l.quantity <= 0) sr.cart.lines.splice(i, 1);
    srCartChanged([l.id]);
    if (!sr.cart.lines.length) srCloseSheet(null, 'srCartSheet');
}

function srClearCart() {
    customConfirm('Remove everything from your cart?', 'All items will be removed from your cart.',
        () => { srResetCart(); srCloseSheet(null, 'srCartSheet'); }, 'Remove');
}

function srRenderCartSheet() {
    const c = sr.cart;
    if (!c.lines.length) { srEl('srCartBody').innerHTML = srMsg('fa-cart-shopping', 'Cart is empty', 'Add something tasty'); return; }
    const b = c.bill;
    const row = (icon, label, val, cls = '') => val ? `<div class="sr-bill-row ${cls}"><span><i class="fa-solid ${icon}"></i>${label}</span><span>${cls === 'disc' ? '−' : ''}₹${val}</span></div>` : '';
    const count = c.lines.reduce((n, l) => n + l.quantity, 0);
    srEl('srCartBody').innerHTML = `
        <div class="sr-cart-head">
            <span class="sr-cart-head-ico"><i class="fa-solid fa-store"></i></span>
            <div class="sr-cart-head-text"><div class="sr-cart-rest">${srEsc(c.restaurant.name)}</div>
            <div class="sr-cart-loc"><i class="fa-solid fa-location-dot"></i>${srEsc(sr.loc?.title || '')}<span class="sr-dot"></span>${count} item${count > 1 ? 's' : ''}</div></div>
            <button type="button" class="sr-link-danger" onclick="srClearCart()"><i class="fa-solid fa-trash-can"></i></button>
        </div>
        <div class="sr-cart-lines">${c.lines.map((l, i) => `
            <div class="sr-cart-line">
                <span class="sr-diet ${l.is_veg ? 'veg' : 'nonveg'}"><i></i></span>
                <div class="sr-cart-line-info">
                    <div class="sr-cart-line-name">${srEsc(l.name)}</div>
                    ${srLineExtras(l).length ? `<div class="sr-cart-line-addons">${srEsc(srLineExtras(l).join(', '))}</div>` : ''}
                    <div class="sr-cart-line-price">${srRs(srLinePrice(l) * l.quantity)}</div>
                </div>
                <div class="sr-step sm">
                    <button type="button" onclick="srCartStep(${i},-1)" aria-label="Decrease"><i class="fa-solid ${l.quantity === 1 ? 'fa-trash-can' : 'fa-minus'}"></i></button>
                    <span>${l.quantity}</span>
                    <button type="button" onclick="srCartStep(${i},1)" aria-label="Increase"><i class="fa-solid fa-plus"></i></button>
                </div>
            </div>`).join('')}</div>
        ${c.error ? `<div class="sr-warn"><i class="fa-solid fa-circle-exclamation"></i> ${srEsc(c.error)}</div>` : ''}
        ${c.message ? `<div class="sr-bill-msg"><i class="fa-solid fa-tags"></i> ${srEsc(c.message)}</div>` : ''}
        <div class="sr-bill ${c.syncing ? 'loading' : ''}">
            <div class="sr-bill-title"><i class="fa-solid fa-receipt"></i>Bill details ${c.syncing ? '<span class="sr-sync"><i class="fa-solid fa-rotate fa-spin"></i>Updating</span>' : ''}</div>
            ${b ? `${row('fa-basket-shopping', 'Item total', b.item_total)}${row('fa-tag', 'Discount', b.discount, 'disc')}${row('fa-motorcycle', 'Delivery fee', b.delivery)}${row('fa-box', 'Packing', b.packing)}${row('fa-file-invoice', 'GST & charges', b.charges)}
            <div class="sr-bill-row total"><span>To pay</span><span>₹${b.to_pay}</span></div>`
            : `${row('fa-basket-shopping', 'Item total', (c.lines.reduce((n, l) => n + srLinePrice(l) * l.quantity, 0) / 100).toFixed(2))}
               <div class="sr-bill-hint"><span class="sr-live-dot"></span>Fetching final price from Swiggy…</div>`}
        </div>`;
}

/* ── customisation sheet ───────────────────────────── */

function srOpenAddons(it) {
    sr.addon = { item: it, picks: {}, vpicks: srFixVPicks(it, {}) };
    // start from Swiggy's preselected choices; required groups without one get the first in-stock option
    it.addon_groups.forEach(g => {
        const limit = g.max > 0 ? g.max : Infinity;
        let picks = g.choices.filter(x => x.default && x.in_stock).map(x => x.id).slice(0, limit);
        if (!picks.length && g.min >= 1) picks = g.choices.filter(x => x.in_stock).slice(0, g.min).map(x => x.id);
        sr.addon.picks[g.id] = picks;
    });
    srRenderAddons();
    srEl('srAddonSheet').classList.remove('hidden');
}

function srAddonTotal() {
    const { item, picks, vpicks } = sr.addon;
    let t = srVariantPrice(item, vpicks);
    item.addon_groups.forEach(g => (picks[g.id] || []).forEach(cid => { const c = g.choices.find(x => x.id === cid); if (c) t += c.price; }));
    return t;
}

function srAddonValid() {
    const { item, picks, vpicks } = sr.addon;
    const variantsOk = (item.variant_groups || []).every(g => !srVChoices(g, vpicks).some(c => c.in_stock) || srVChoices(g, vpicks).some(c => c.id === vpicks[g.id]));
    return variantsOk && item.addon_groups.every(g => (picks[g.id] || []).length >= g.min);
}

// variant group: one choice, required (Size, Crust ...)
function srVariantGroupsHtml(item, vpicks) {
    return (item.variant_groups || []).map(g => {
        const list = srVChoices(g, vpicks);
        if (!list.length) return '';
        return `<div class="sr-ag"><div class="sr-ag-head"><b>${srEsc(g.name)}</b><small>Required · choose 1</small></div>
            ${list.map(c => {
                const on = vpicks[g.id] === c.id;
                // v2 lists the full price of each option; v1 the extra it adds
                const price = item.variant_mode === 'v2' ? srRs(srVariantPrice(item, srFixVPicks(item, { ...vpicks, [g.id]: c.id })))
                    : (c.price ? '+' + srRs(c.price) : '');
                return `<button type="button" class="sr-choice ${on ? 'on' : ''}" ${c.in_stock ? '' : 'disabled'} onclick="srVPick('${srEsc(g.id)}','${srEsc(c.id)}')">
                    <span class="sr-diet ${c.is_veg || item.is_veg ? 'veg' : 'nonveg'}"><i></i></span>
                    <span class="sr-choice-name">${srEsc(c.name)}</span>
                    ${price ? `<span class="sr-choice-price">${price}</span>` : ''}
                    <span class="sr-tick"><i class="fa-solid fa-check"></i></span>
                </button>`;
            }).join('')}</div>`;
    }).join('');
}

function srVPick(gid, cid) {
    sr.addon.vpicks[gid] = cid;
    srFixVPicks(sr.addon.item, sr.addon.vpicks);   // a crust that needs another size moves to a valid one
    srRenderAddons();
}

function srRenderAddons() {
    const { item, picks, vpicks } = sr.addon;
    srEl('srAddonBody').innerHTML = `
        <div class="sr-addon-title"><span class="sr-diet ${item.is_veg ? 'veg' : 'nonveg'}"><i></i></span>${srEsc(item.name)}</div>
        <div class="sr-addon-groups">${srVariantGroupsHtml(item, vpicks)}${item.addon_groups.map(g => {
            const multi = g.max !== 1;
            const hint = g.min >= 1 ? 'Required' : 'Optional';
            const lim = multi && g.max > 0 ? ` · up to ${g.max}` : '';
            return `<div class="sr-ag"><div class="sr-ag-head"><b>${srEsc(g.name)}</b><small>${hint}${lim}</small></div>
                ${g.choices.map(c => {
                    const on = (picks[g.id] || []).includes(c.id);
                    return `<button type="button" class="sr-choice ${on ? 'on' : ''}" ${c.in_stock ? '' : 'disabled'} onclick="srPick('${srEsc(g.id)}','${srEsc(c.id)}')">
                        <span class="sr-diet ${c.is_veg ? 'veg' : 'nonveg'}"><i></i></span>
                        <span class="sr-choice-name">${srEsc(c.name)}</span>
                        ${c.price ? `<span class="sr-choice-price">+${srRs(c.price)}</span>` : ''}
                        <span class="sr-tick ${multi ? 'sq' : ''}"><i class="fa-solid fa-check"></i></span>
                    </button>`;
                }).join('')}</div>`;
        }).join('')}</div>
        <button type="button" class="sr-addon-go" ${srAddonValid() ? '' : 'disabled'} onclick="srConfirmAddons()">
            <span>Add item</span><span>${srRs(srAddonTotal())}</span>
        </button>`;
}

function srPick(gid, cid) {
    const g = sr.addon.item.addon_groups.find(x => x.id === gid);
    let cur = sr.addon.picks[gid] || [];
    if (cur.includes(cid)) { if (!(g.max === 1 && g.min >= 1)) cur = cur.filter(x => x !== cid); }
    else if (g.max === 1) cur = [cid];
    else if (g.max > 0 && cur.length >= g.max) { showToast(`Choose up to ${g.max}`, true); return; }
    else cur = [...cur, cid];
    sr.addon.picks[gid] = cur;
    srRenderAddons();
}

function srConfirmAddons() {
    if (!srAddonValid()) return;
    const { item, picks, vpicks } = sr.addon;
    const variants = [];
    (item.variant_groups || []).forEach(g => {
        const c = g.choices.find(x => x.id === vpicks[g.id]);
        if (c) variants.push({ group_id: g.id, variation_id: c.id, name: c.name, group_name: g.name, price: c.price });
    });
    const addons = [];
    item.addon_groups.forEach(g => (picks[g.id] || []).forEach(cid => {
        const c = g.choices.find(x => x.id === cid);
        if (c) addons.push({ group_id: g.id, choice_id: c.id, name: c.name, price: c.price });
    }));
    srCloseSheet(null, 'srAddonSheet');
    srAddLine(item, addons, false, variants);
}
