// ========================================
// 🚨 CONFIG (GASのURL)
// ========================================
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbz9qacI7K_km5cDuANUKsex2lYkzYbGjvoQDzxbMKaWHQfg9VGQV5v0CmdoKG8R256BRg/exec";


// ========================================
// 🛠️ API Client (強化版)
// ========================================
async function callGAS(command, data = {}) {
    try {
        console.log(`Sending command: ${command}`, data);
        const response = await fetch(GAS_API_URL, {
            method: 'POST',
            body: JSON.stringify({ command, data })
        });

        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }

        const resData = await response.json();
        console.log(`Response received:`, resData);
        return resData || { success: false, message: "返信が空でした" };
    } catch (err) {
        console.error("API Connection Error:", err);
        return { success: false, message: "通信エラーが発生しました: " + err.toString() };
    }
}

// ─── State ───
let me = null, books = [], curView = 'browse';
let qr = null, scanning = false, mqr = null;
let photoB64 = null;
let isbnDebounceTimer = null;
let bulkQueue = [];

// ─── Init ───
window.addEventListener('DOMContentLoaded', async function () {
    const savedUser = localStorage.getItem('lib_user');
    if (savedUser) {
        try {
            me = JSON.parse(savedUser);
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('app-main').style.display = 'block';
            updateUIForUser();
            await fetchData(false);
        } catch (e) {
            localStorage.removeItem('lib_user');
        }
    }

    document.getElementById('book-search').addEventListener('input', function (e) { renderBooks(e.target.value); });
    document.getElementById('book-form').addEventListener('submit', onFormSubmit);
    document.getElementById('bulk-modal').addEventListener('click', function (e) {
        if (e.target === this) closeBulkModal();
    });
});

function updateUIForUser() {
    if (!me) return;
    document.getElementById('u-name').textContent = me.name;
    document.getElementById('u-role').textContent = me.role === 'admin' ? '管理者' : '学生';
    if (me.role === 'admin') {
        const dNav = document.getElementById('nav-admin');
        const mNav = document.getElementById('mn-admin');
        if (dNav) dNav.classList.remove('hidden');
        if (mNav) mNav.classList.remove('hidden');
    }
    updateProfile();
}

function toast(msg, dur) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.className = 'show';
    setTimeout(function () { t.className = ''; }, dur || 3000);
}

// ─── Auth ───
function switchTab(mode) {
    const isL = mode === 'login';
    document.getElementById('form-login').style.display = isL ? 'block' : 'none';
    document.getElementById('form-reg').style.display = isL ? 'none' : 'block';
    document.getElementById('tab-login').style.cssText = isL ? 'background:var(--acc);color:#0f172a' : 'background:transparent;color:var(--muted)';
    document.getElementById('tab-reg').style.cssText = isL ? 'background:transparent;color:var(--muted)' : 'background:var(--acc);color:#0f172a';
    document.getElementById('login-err').textContent = '';
}

async function doLogin() {
    const id = document.getElementById('login-id').value.trim();
    const pw = document.getElementById('login-pass').value;
    const err = document.getElementById('login-err');
    if (!id || !pw) { err.textContent = 'IDとパスワードを入力してください'; return; }
    err.textContent = '認証中...';

    const res = await callGAS("login", { id, password: pw });
    if (res && res.success) {
        me = res.user;
        localStorage.setItem('lib_user', JSON.stringify(me));
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-main').style.display = 'block';
        updateUIForUser();
        await fetchData(false);
    } else {
        err.textContent = (res && res.message) || "ログインに失敗しました";
    }
}

async function doLogout() {
    localStorage.removeItem('lib_user');
    window.location.reload();
}

async function doRegister() {
    const id = document.getElementById('reg-id').value.trim();
    const name = document.getElementById('reg-name').value.trim();
    const pw = document.getElementById('reg-pass').value;
    const pw2 = document.getElementById('reg-pass2').value;
    const err = document.getElementById('login-err');
    if (!id || !name || !pw) { err.textContent = '学籍番号・氏名・パスワードは必須です'; return; }
    if (pw !== pw2) { err.textContent = 'パスワードが一致しません'; return; }

    err.textContent = '登録中...';
    const res = await callGAS("registerUser", { id, name, password: pw });
    if (res && res.success) {
        toast('登録完了！ログインしてください');
        switchTab('login');
    } else {
        err.textContent = (res && res.message) || "登録に失敗しました";
    }
}

// ─── Profile ───
function updateProfile() {
    if (!me) return;
    const ne = document.getElementById('p-name'); if (ne) ne.textContent = me.name;
    const ie = document.getElementById('p-id'); if (ie) ie.textContent = 'ID: ' + me.id;
    const re = document.getElementById('p-role'); if (re) re.textContent = me.role === 'admin' ? '👑 管理者' : '🎓 学生';
}

// ─── Data ───
async function fetchData(bg) {
    if (!bg) {
        const lo = document.getElementById('loading-overlay');
        if (lo) lo.style.display = 'flex';
    }
    const d = await callGAS("getInitialData");
    const lo = document.getElementById('loading-overlay');

    if (d && d.success) {
        books = (d.books || []).sort(function (a, b) { return (parseInt(b.id) || 0) - (parseInt(a.id) || 0); });
        renderBooks(); renderAdmin(); renderMyBooks();
        if (!bg) await fetchHistory();
        // ローディング画面を先に消してから、バックグラウンドでサムネイル取得
        if (lo) lo.style.display = 'none';
        enrichAPI(books); // 非同期・バックグラウンドで実行（awaitしない）
    } else {
        if (!bg) console.error("Data fetch failed", d);
        if (lo) lo.style.display = 'none';
    }
}

/**
 * サムネイル画像が未登録の本を対象に OpenBD / Google Books から自動取得し、
 * スプレッドシートに書き戻す（バックグラウンド処理）
 */
async function enrichAPI(list) {
    // サムネイルなし & ISBNありの本だけ対象
    const targets = list.filter(b => !b.thumbnail && b.isbn && String(b.isbn).replace(/[' ]/g, '').length >= 10);
    if (!targets.length) return;

    console.log(`[enrichAPI] サムネイル取得対象: ${targets.length}冊`);

    // ① OpenBD 一括取得（日本語書籍に強い）
    try {
        const isbns = targets.map(b => String(b.isbn).replace(/[' ]/g, ''));
        const res = await fetch('https://api.openbd.jp/v1/get?isbn=' + isbns.join(','));
        const data = await res.json();
        data.forEach((item, idx) => {
            if (item && item.summary && item.summary.cover) {
                const b = targets.find(b => String(b.isbn).replace(/[' ]/g, '') === isbns[idx]);
                if (b) b.image_api = item.summary.cover.replace(/^http:/, 'https:');
            }
        });
    } catch (e) { console.warn('[enrichAPI] OpenBD error:', e); }

    // ② Google Books で補完（OpenBDで取れなかった分）
    const stillMissing = targets.filter(b => !b.image_api && b.isbn);
    for (const b of stillMissing.slice(0, 15)) {
        try {
            const cleanIsbn = String(b.isbn).replace(/[' ]/g, '');
            const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`);
            const d = await res.json();
            if (d.items && d.items[0] && d.items[0].volumeInfo.imageLinks) {
                b.image_api = d.items[0].volumeInfo.imageLinks.thumbnail.replace(/^http:/, 'https:');
            }
            await new Promise(r => setTimeout(r, 300)); // レート制限回避
        } catch (e) { /* 個別失敗は無視 */ }
    }

    // ③ 取得できたURLを画面に反映
    let updated = false;
    targets.forEach(b => {
        if (b.image_api) {
            const target = books.find(x => String(x.id) === String(b.id));
            if (target) { target.thumbnail = b.image_api; updated = true; }
        }
    });
    if (updated) { renderBooks(); renderAdmin(); }

    // ④ スプレッドシートに書き戻し（次回から即表示されるように）
    const toSave = targets
        .filter(b => b.image_api)
        .map(b => ({ isbn: String(b.isbn).replace(/[' ]/g, ''), url: b.image_api }));
    if (toSave.length) {
        console.log(`[enrichAPI] ${toSave.length}冊のサムネイルをシートに保存`);
        callGAS("saveThumbnailsBulk", toSave); // 結果待ちなし
    }
}

async function fetchHistory() {
    if (!me) return;
    const res = await callGAS("getUserHistory", { uid: me.id });
    const tb = document.getElementById('hist-table');
    if (!tb) return;
    tb.innerHTML = '';
    if (!res || !res.success || !res.history || !res.history.length) {
        tb.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:24px">履歴はありません</td></tr>';
        return;
    }
    res.history.forEach(function (l) {
        const d = new Date(l.timestamp);
        const ds = (d.getMonth() + 1) + '/' + d.getDate();
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + ds + '</td><td>' + l.book_title + '</td><td>' + (l.action === 'borrow' ? '貸出' : '<span style="color:var(--muted)">返却</span>') + '</td>';
        tb.appendChild(tr);
    });
}

function getImg(b) {
    if (b.thumbnail) return b.thumbnail;
    const ini = b.title ? b.title.charAt(0) : '?';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="70" height="100"><rect width="70" height="100" fill="#1e293b" rx="6"/><text x="35" y="58" font-family="sans-serif" font-size="28" font-weight="bold" fill="#38bdf8" text-anchor="middle" dominant-baseline="middle">${ini}</text><text x="35" y="80" font-family="sans-serif" font-size="9" fill="#64748b" text-anchor="middle">No Cover</text></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// ─── View ───
function gv(v) {
    if (curView === 'scanner' && scanning) stopScanner();
    curView = v;
    document.querySelectorAll('.view').forEach(function (e) { e.classList.remove('active'); });
    document.getElementById('view-' + v).classList.add('active');
    ['browse', 'scanner', 'mypage', 'admin'].forEach(function (n) {
        const da = document.getElementById('nav-' + n);
        const ma = document.getElementById('mn-' + n);
        if (da) da.classList.toggle('active', n === v);
        if (ma) ma.classList.toggle('active', n === v);
    });
    if (v === 'browse') window.scrollTo(0, 0);
    if (v === 'scanner') setTimeout(function () { startScanner(false); }, 300);
    if (v === 'mypage') { updateProfile(); renderMyBooks(); fetchHistory(); }
    if (v === 'admin') renderAdmin();
}

// ─── Render ───
function renderBooks(f) {
    f = f || '';
    const c = document.getElementById('book-list'); if (!c) return;
    c.innerHTML = '';
    const fl = books.filter(function (b) { return (b.title + (b.author || '') + (b.isbn || '')).toLowerCase().includes(f.toLowerCase()); });
    if (!fl.length) { c.innerHTML = '<p style="text-align:center;color:var(--muted);padding:32px">該当する書籍はありません</p>'; return; }
    fl.forEach(function (b) {
        const ok = b.status === 'available';
        const d = document.createElement('div');
        d.className = 'card book-card'; d.style.cursor = 'pointer';
        d.onclick = function (e) { if (e.target.tagName !== 'BUTTON') openDetail(b.id); };
        d.innerHTML = `<img src="${getImg(b)}" class="book-cover" onerror="this.src='https://via.placeholder.com/68x100'">` +
            `<div class="book-details">` +
            `<div class="book-title">${b.title}</div>` +
            `<div class="book-author">${b.author || ''} (${b.publisheddate || b.publishedDate || '-'})</div>` +
            `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">` +
            `<span class="badge ${ok ? 'badge-ok' : 'badge-ng'}">${ok ? '貸出可' : '貸出中'}</span>` +
            `<button class="btn ${ok ? 'btn-primary' : 'btn-outline'}" style="padding:6px 14px;font-size:.82rem" onclick="event.stopPropagation();${ok ? 'borrowBook(\'' + b.id + '\')' : 'reserveBook(\'' + b.id + '\')'}">${ok ? '借りる' : '予約'}</button>` +
            '</div></div>';
        c.appendChild(d);
    });
}

function renderAdmin() {
    const tb = document.getElementById('admin-table'); if (!tb) return;
    tb.innerHTML = '';
    const q = (document.getElementById('admin-search') || { value: '' }).value.toLowerCase();
    const sort = (document.getElementById('admin-sort') || { value: 'id-desc' }).value;
    let list = books.filter(function (b) {
        return !q || (b.title + (b.author || '') + (b.isbn || '')).toLowerCase().includes(q);
    });
    // Sort
    list = list.slice().sort(function (a, b) {
        if (sort === 'id-asc') return (parseInt(a.id) || 0) - (parseInt(b.id) || 0);
        if (sort === 'title-asc') return (a.title || '').localeCompare(b.title || '', 'ja');
        if (sort === 'status') return (a.status === 'rented' ? 0 : 1) - (b.status === 'rented' ? 0 : 1);
        if (sort === 'no-thumb') return (!a.thumbnail ? 0 : 1) - (!b.thumbnail ? 0 : 1);
        return (parseInt(b.id) || 0) - (parseInt(a.id) || 0);
    });
    list.forEach(function (b) {
        const ok = b.status === 'available';
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${b.id}</td><td><b>${b.title}</b></td><td>${b.author || ''}</td>` +
            `<td style="text-align:center;font-size:1.1rem">${(b.thumbnail || b.image_api) ? '✅' : '❌'}</td>` +
            `<td><span class="badge ${ok ? 'badge-ok' : 'badge-ng'}">${ok ? '可' : '中'}</span></td>` +
            `<td><button class="btn btn-outline" style="padding:6px;min-width:38px" onclick="openEditModal('${b.id}')">` +
            '<i class="fas fa-edit"></i></button></td>';
        tb.appendChild(tr);
    });
}

function renderMyBooks() {
    const c = document.getElementById('my-books'); if (!c) return;
    c.innerHTML = '';
    if (!me) return;
    const my = books.filter(function (b) { return String(b.borrower_id) === String(me.id) && b.status === 'rented'; });
    const cnt = document.getElementById('p-count'); if (cnt) cnt.textContent = my.length;
    if (!my.length) {
        c.innerHTML = '<div class="card" style="text-align:center;padding:24px"><p style="color:var(--muted)">現在借りている本はありません</p></div>';
        return;
    }
    my.forEach(function (b) {
        const d = document.createElement('div'); d.className = 'card book-card';
        d.innerHTML = `<img src="${getImg(b)}" class="book-cover" onerror="this.src='https://via.placeholder.com/68x100'">` +
            `<div class="book-details"><div class="book-title">${b.title}</div>` +
            `<div class="book-author" style="margin-bottom:8px">${b.author || ''}</div>` +
            `<button class="btn btn-warn" style="width:100%" onclick="doReturn('${b.id}')"><i class="fas fa-undo"></i> 返却する</button></div>`;
        c.appendChild(d);
    });
}

// ─── Detail Modal ───
function openDetail(id) {
    const b = books.find(function (x) { return String(x.id) === String(id); }); if (!b) return;
    const ok = b.status === 'available';

    const cover = document.getElementById('d-cover'); if (cover) cover.src = getImg(b);
    const title = document.getElementById('d-title'); if (title) title.textContent = b.title;
    const author = document.getElementById('d-author'); if (author) author.textContent = b.author || '';
    const pub = document.getElementById('d-pub'); if (pub) pub.textContent = b.publisher || '-';
    const date = document.getElementById('d-date'); if (date) date.textContent = b.publisheddate || b.publishedDate || '-';
    const isbnEl = document.getElementById('d-isbn'); if (isbnEl) isbnEl.textContent = b.isbn || '-';

    const st = document.getElementById('d-status');
    if (st) {
        st.className = 'badge ' + (ok ? 'badge-ok' : 'badge-ng');
        st.textContent = ok ? '貸出可' : '貸出中';
    }

    const acts = document.getElementById('d-actions');
    if (acts) {
        acts.innerHTML = '';
        if (ok) {
            acts.innerHTML = `<button class="btn btn-primary" onclick="borrowBook('${b.id}');closeBookDetail()">この本を借りる</button>`;
        } else if (me && String(b.borrower_id) === String(me.id)) {
            acts.innerHTML = `<button class="btn btn-warn" onclick="doReturn('${b.id}');closeBookDetail()">返却する</button>`;
        } else {
            acts.innerHTML = `<button class="btn btn-outline" onclick="reserveBook('${b.id}');closeBookDetail()">予約する</button>`;
        }
    }

    const modal = document.getElementById('detail-modal');
    if (modal) modal.style.display = 'flex';
}
function closeBookDetail() {
    const modal = document.getElementById('detail-modal');
    if (modal) modal.style.display = 'none';
}

// ─── Scanner ───
async function startScanner(force) {
    if (scanning && !force) return;
    const errEl = document.getElementById('cam-err');
    const startEl = document.getElementById('cam-start');
    if (startEl) startEl.style.display = 'none';
    if (errEl) errEl.textContent = 'カメラを起動中...';

    if (qr) { try { await qr.clear(); } catch (e) { } }
    qr = new Html5Qrcode("reader");

    const config = { fps: 15, qrbox: 250 };
    qr.start({ facingMode: "environment" }, config, onScan)
        .then(function () {
            scanning = true;
            const ov = document.getElementById('scan-overlay');
            if (ov) {
                ov.style.display = 'block';
                ov.classList.add('active');
            }
            if (errEl) errEl.textContent = '';
        }).catch(err => {
            if (errEl) errEl.textContent = "カメラが見つからないか、許可されていません";
            if (startEl) startEl.style.display = 'flex';
        });
}
function onScan(code) { handleCode(code); }
function stopScanner() {
    const ov = document.getElementById('scan-overlay');
    if (ov) ov.classList.remove('active');
    if (!qr || !scanning) return;
    qr.stop().then(function () { qr.clear(); scanning = false; }).catch(function () { scanning = false; });
}
function handleCode(code) {
    if (!scanning) return;
    const b = books.find(function (x) { return String(x.isbn) === String(code) || String(x.id) === String(code); });
    stopScanner();
    const r = document.getElementById('scan-result'); if (!r) return;
    r.innerHTML = '';
    if (b) {
        const ok = b.status === 'available';
        r.innerHTML = `<div class="card book-card" style="margin-top:14px">` +
            `<img src="${getImg(b)}" class="book-cover">` +
            `<div class="book-details"><div class="book-title">${b.title}</div>` +
            `<p style="margin:10px 0;color:var(--acc);font-weight:600">${ok ? 'この本を借りますか？' : 'この本を返却しますか？'}</p>` +
            `<div style="display:flex;gap:8px">` +
            `<button class="btn btn-primary" style="flex:1" onclick="${ok ? 'borrowBook' : 'doReturn'}('${b.id}')">確定</button>` +
            `<button class="btn btn-outline" style="flex:1" onclick="resetScan()">キャンセル</button></div></div></div>`;
    } else {
        r.innerHTML = `<div style="text-align:center;margin-top:18px">` +
            `<p style="margin-bottom:10px">未登録: <b>${code}</b></p>` +
            `<button class="btn btn-outline" onclick="resetScan()">再スキャン</button></div>`;
    }
}
function resetScan() { document.getElementById('scan-result').innerHTML = ''; startScanner(true); }

// ─── Modal Scanner ───
function startModalScan() {
    const area = document.getElementById('modal-scan-area'); if (area) area.style.display = 'block';
    if (mqr) { try { mqr.clear(); } catch (e) { } }
    mqr = new Html5Qrcode('modal-reader');
    mqr.start({ facingMode: 'environment' }, { fps: 15, qrbox: 250 }, (c) => {
        stopModalScan();
        const isbnInp = document.getElementById('f-isbn'); if (isbnInp) isbnInp.value = c;
        lookupISBN();
    }).catch(err => console.error("Modal Scanner failed", err));
}
function stopModalScan() {
    const area = document.getElementById('modal-scan-area'); if (area) area.style.display = 'none';
    if (mqr) { mqr.stop().then(() => mqr.clear()); mqr = null; }
}

// ─── Book Registration ───
function openAddModal() {
    const modal = document.getElementById('book-modal'); if (modal) modal.style.display = 'flex';
    const ttl = document.getElementById('modal-ttl'); if (ttl) ttl.textContent = '蔵書登録';
    const fid = document.getElementById('f-id'); if (fid) fid.value = '';
    const form = document.getElementById('book-form'); if (form) form.reset();
    clearPhoto();
}
function openEditModal(id) {
    const b = books.find(function (x) { return String(x.id) === String(id); }); if (!b) return;
    const modal = document.getElementById('book-modal'); if (modal) modal.style.display = 'flex';
    const ttl = document.getElementById('modal-ttl'); if (ttl) ttl.textContent = '書誌情報の修正';

    document.getElementById('f-id').value = b.id;
    document.getElementById('f-isbn').value = b.isbn || '';
    document.getElementById('f-title').value = b.title;
    document.getElementById('f-author').value = b.author || '';
    document.getElementById('f-pub').value = b.publisher || '';
    document.getElementById('f-year').value = b.publisheddate || b.publishedDate || '';
    document.getElementById('f-img').value = b.thumbnail || '';

    if (b.thumbnail) {
        document.getElementById('photo-prev').src = b.thumbnail;
        document.getElementById('photo-area').classList.add('has-photo');
    } else {
        clearPhoto();
    }
}
function closeBookModal() {
    const modal = document.getElementById('book-modal'); if (modal) modal.style.display = 'none';
    stopModalScan();
}

async function onFormSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('save-btn');
    if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }

    const id = document.getElementById('f-id').value;
    const data = {
        id: id,
        isbn: document.getElementById('f-isbn').value || '',
        title: document.getElementById('f-title').value || '',
        author: document.getElementById('f-author').value || '',
        publisher: document.getElementById('f-pub').value || '',
        publishedDate: document.getElementById('f-year').value || '',
        thumbnail: photoB64 || document.getElementById('f-img').value || ''
    };

    if (photoB64 && photoB64.startsWith('data:image')) {
        const imgRes = await callGAS("saveImageToDrive", { base64: photoB64, title: data.title });
        if (imgRes && imgRes.success) data.thumbnail = imgRes.url;
    }

    const command = id ? "updateBook" : "addBook";
    const res = await callGAS(command, data);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }

    if (res && res.success) {
        toast('完了');
        closeBookModal();
        await fetchData(true);
    } else {
        alert((res && res.message) || "保存に失敗しました");
    }
}

function onPhotoSelect(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        photoB64 = e.target.result;
        document.getElementById('photo-prev').src = photoB64;
        document.getElementById('photo-area').classList.add('has-photo');
    };
    reader.readAsDataURL(file);
}
function clearPhoto() {
    photoB64 = null;
    const area = document.getElementById('photo-area'); if (area) area.classList.remove('has-photo');
    const prev = document.getElementById('photo-prev'); if (prev) prev.src = '';
}

async function lookupISBN() {
    const isbnVal = document.getElementById('f-isbn').value.trim();
    if (!isbnVal) return;
    toast("検索中...");
    const res = await callGAS("lookupISBN", { isbn: isbnVal });
    if (res && res.items && res.items.length > 0) {
        const v = res.items[0].volumeInfo;
        document.getElementById('f-title').value = v.title || '';
        document.getElementById('f-author').value = (v.authors || []).join(' ');
        document.getElementById('f-pub').value = v.publisher || '';
        document.getElementById('f-year').value = (v.publishedDate || '').substring(0, 4);
        const cover = v.imageLinks ? (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail || '').replace(/^http:/, 'https:') : '';
        document.getElementById('f-img').value = cover;
        if (cover) {
            document.getElementById('photo-prev').src = cover;
            document.getElementById('photo-area').classList.add('has-photo');
        }
        toast("取得完了");
    } else {
        toast("見つかりませんでした");
    }
}

// ─── Borrow / Return Actions ───
async function borrowBook(id) {
    setLoading(true);
    const res = await callGAS("borrowBook", { id, uid: me.id });
    setLoading(false);
    if (res && res.success) {
        toast('貸出完了');
        await fetchData(true);
    } else { alert((res && res.message) || "エラーが発生しました"); }
}
async function doReturn(id) {
    if (!confirm('返却しますか？')) return;
    setLoading(true);
    const res = await callGAS("returnBook", { id, uid: me.id });
    setLoading(false);
    if (res && res.success) {
        toast('返却完了');
        await fetchData(true);
    } else { alert((res && res.message) || "エラーが発生しました"); }
}
async function reserveBook(id) {
    const res = await callGAS("reserveBook", { id, uid: me.id });
    if (res && res.success) toast('予約しました');
    else alert((res && res.message) || "予約に失敗しました");
}

function setLoading(s) {
    const lo = document.getElementById('loading-overlay');
    if (lo) lo.style.display = s ? 'flex' : 'none';
}

// ─── Bulk ───
function openBulkModal() {
    bulkQueue = [];
    document.getElementById('bulk-list').innerHTML = '';
    document.getElementById('bulk-isbn-input').value = '';
    document.getElementById('bulk-count').textContent = '0';
    document.getElementById('bulk-modal').style.display = 'flex';
}
function closeBulkModal() { document.getElementById('bulk-modal').style.display = 'none'; }
function onBulkKey(e) {
    if (e.key === 'Enter') {
        const isbn = e.target.value.trim();
        if (isbn.length >= 10) addBulkISBN(isbn);
        e.target.value = '';
    }
}
async function addBulkISBN(isbn) {
    toast("スキャン: " + isbn);
    const res = await callGAS("lookupISBNForBulk", { isbn });
    if (res && !res.error) {
        bulkQueue.push(res);
        renderBulkList();
    }
}
function renderBulkList() {
    const list = document.getElementById('bulk-list');
    list.innerHTML = '';
    bulkQueue.forEach((item, idx) => {
        const d = document.createElement('div');
        d.className = 'card';
        d.style.marginBottom = '5px';
        d.innerHTML = `<div><b>${item.title}</b><br><small>${item.isbn}</small></div>`;
        list.appendChild(d);
    });
    document.getElementById('bulk-count').textContent = bulkQueue.length;
}
async function saveBulk() {
    if (!bulkQueue.length) return;
    const res = await callGAS("addBooksBulk", bulkQueue);
    if (res && res.success) {
        toast("登録完了");
        closeBulkModal();
        await fetchData(true);
    }
}
