// CONFIG (GASのURL)
const GAS_API_URL = "https://script.google.com/macros/s/AKfycby_YdPuOD1FHMQPIf--8GQdksJbEJpdbYH5NJCn5q-mWpj3dfuuZCrXrB-yPOl4T4uP9Q/exec";


// API Client (強化版)
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
let copiesToAdd = 1;  // 蔵書数
let usersMap = {};    // uid → name マップ

let bulkQueue = [];

// キャッシュ設定
const CACHE_KEY = 'lib_data_cache';
const CACHE_TTL = 3 * 60 * 1000; // 3分間キャッシュ

// データをキャッシュに保存
function setCache(data) {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        data: data
    }));
}

// キャッシュからデータを取得
function getCache() {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;
    const { timestamp, data } = JSON.parse(cached);
    if (Date.now() - timestamp > CACHE_TTL) return null; // 期限切れ
    return data;
}

// キャッシュを明示的にクリア（更新系操作の後）
function clearCache() {
    localStorage.removeItem(CACHE_KEY);
}

// ─── Init ───
window.addEventListener('DOMContentLoaded', async function () {
    const savedUser = localStorage.getItem('lib_user');
    if (savedUser) {
        try {
            me = JSON.parse(savedUser);
            // 自動ログイン時はスプラッシュを介して入る
            showAppWithSplash();
        } catch (e) {
            localStorage.removeItem('lib_user');
        }
    }

    document.getElementById('book-search').addEventListener('input', function (e) { renderBooks(e.target.value); });
    document.getElementById('book-form').addEventListener('submit', onFormSubmit);
    document.getElementById('bulk-modal').addEventListener('click', function (e) {
        if (e.target === this) closeBulkModal();
    });

    // ③ ISBN自動取得（デバウンス付き）─入力後1.2秒で自動実行
    const fIsbn = document.getElementById('f-isbn');
    if (fIsbn) {
        fIsbn.addEventListener('input', function () {
            clearTimeout(isbnDebounceTimer);
            const v = this.value.trim().replace(/[- ]/g, '');
            if (v.length >= 10) {
                const st = document.getElementById('isbn-status');
                if (st) st.textContent = '… 1.2秒後に自動取得';
                isbnDebounceTimer = setTimeout(() => {
                    console.log("[ISBN Auto] Triggering lookup for:", v);
                    lookupISBN();
                }, 1200);
            }
        });
    }
});

// 蔵書数カウント管理（不足していた関数を追加）
function updateCopies(val) {
    const el = document.getElementById('f-copy-count');
    if (!el) return;
    copiesToAdd = Math.max(1, Math.min(20, (copiesToAdd || 1) + val));
    el.textContent = copiesToAdd;
}


function updateUIForUser() {
    if (!me) return;
    const uName = document.getElementById('u-name'); if (uName) uName.textContent = me.name;
    const uRole = document.getElementById('u-role');
    if (uRole) {
        uRole.textContent = me.role === 'admin' ? '管理者' : '学生';
        uRole.className = me.role === 'admin' ? 'role-admin' : 'role-student';
    }
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

    // クラスによる制御に切り替え
    const tabLogin = document.getElementById('tab-login');
    const tabReg = document.getElementById('tab-reg');
    if (isL) {
        tabLogin.classList.add('selected');
        tabReg.classList.remove('selected');
    } else {
        tabLogin.classList.remove('selected');
        tabReg.classList.add('selected');
    }
    document.getElementById('login-err').textContent = '';
}

/** 🎭 スプラッシュ画面を表示してアプリへ遷移 */
async function showAppWithSplash() {
    const splash = document.getElementById('splash-screen');
    const login = document.getElementById('login-screen');
    const app = document.getElementById('app-main');

    // 1. ログイン画面を消してスプラッシュを起動
    login.style.display = 'none';
    splash.classList.add('active');

    updateUIForUser();
    fetchData(true); // 裏側でデータ取得を開始（待機しない）

    // ロゴがフェードアウトを始める少し前（1.1s後）に、より長い時間をかけて浮かび上がらせる
    setTimeout(() => {
        app.classList.add('show-anim');
    }, 1100);

    // アニメーション完了（2.2s）に合わせてスプラッシュを物理的に削除
    setTimeout(() => {
        splash.classList.remove('active');
    }, 2200);
}

async function doLogin() {
    const id = document.getElementById('login-id').value.trim();
    const pw = document.getElementById('login-pass').value;
    const err = document.getElementById('login-err');
    if (!id || !pw) { err.innerHTML = '<span class="status-msg error">IDとパスワードを入力してください</span>'; return; }
    err.innerHTML = '<span class="status-msg loading"><i class="fas fa-circle-notch fa-spin"></i> 認証中</span>';

    const res = await callGAS("login", { id, password: pw });
    if (res && res.success) {
        me = res.user;
        localStorage.setItem('lib_user', JSON.stringify(me));
        showAppWithSplash();
    } else {
        const msg = (res && res.message) || "ログインに失敗しました";
        err.innerHTML = `<span class="status-msg error">${msg}</span>`;
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
    if (!id || !name || !pw) { err.innerHTML = '<span class="status-msg error">学籍番号・氏名・パスワードは必須です</span>'; return; }
    if (pw !== pw2) { err.innerHTML = '<span class="status-msg error">パスワードが一致しません</span>'; return; }

    err.innerHTML = '<span class="status-msg loading"><i class="fas fa-circle-notch fa-spin"></i> 登録中</span>';
    const res = await callGAS("registerUser", { id, name, password: pw });
    if (res && res.success) {
        toast('登録完了！ログインしてください');
        switchTab('login');
    } else {
        const msg = (res && res.message) || "登録に失敗しました";
        err.innerHTML = `<span class="status-msg error">${msg}</span>`;
    }
}

// ─── Profile ───
function updateProfile() {
    if (!me) return;
    const ne = document.getElementById('p-name'); if (ne) ne.textContent = me.name;
    const ie = document.getElementById('p-id'); if (ie) ie.textContent = 'ID: ' + (me.student_id || me.id);

    // マイページ側の役割表示
    const pRole = document.getElementById('p-role');
    if (pRole) {
        pRole.textContent = me.role === 'admin' ? '管理者' : '学生';
        pRole.className = me.role === 'admin' ? 'role-admin' : 'role-student';
    }
}

function openProfileEditModal() {
    if (!me) return;
    document.getElementById('prof-name').value = me.name || '';
    document.getElementById('prof-email').value = me.email || '';
    document.getElementById('prof-pass').value = '';
    const modal = document.getElementById('profile-modal');
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
}

function closeProfileModal() {
    const modal = document.getElementById('profile-modal');
    modal.classList.remove('active');
    setTimeout(() => modal.style.display = 'none', 300);
}

async function saveProfile() {
    const name = document.getElementById('prof-name').value.trim();
    const email = document.getElementById('prof-email').value.trim();
    const pass = document.getElementById('prof-pass').value;
    const btn = document.getElementById('prof-save-btn');

    if (!name) { toast("名前を入力してください"); return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';

    const res = await callGAS("updateUserProfile", { id: me.id, name, email, password: pass });
    if (res && res.success) {
        me.name = name;
        if (email) me.email = email;
        localStorage.setItem('lib_user', JSON.stringify(me));
        updateUIForUser();
        toast("プロフィールを更新しました");
        closeProfileModal();
    } else {
        toast("エラー: " + (res.message || "不明なエラー"));
    }
    btn.disabled = false;
    btn.innerHTML = '変更を保存する';
}

async function confirmDeleteAccount() {
    if (!me) return;
    if (me.role === 'admin') {
        toast("管理者は直接削除できません。");
        return;
    }
    const ok = confirm("本当にアカウントを削除しますか？\nこの操作は取り消せません。");
    if (!ok) return;

    toast("アカウント削除中...");
    const res = await callGAS("deleteUserAccount", { uid: me.id });
    if (res && res.success) {
        toast("アカウントを削除しました");
        doLogout();
    } else {
        toast("エラー: " + (res.message || "削除に失敗しました"));
    }
}

// ─── Data ───
async function fetchData(bg) {
    if (!bg) {
        const lo = document.getElementById('loading-overlay');
        if (lo) lo.style.display = 'flex';
    }

    // キャッシュ確認（bg更新でない場合）
    if (!bg) {
        const cached = getCache();
        if (cached) {
            console.log("[Cache] Using cached data");
            applyData(cached.books, cached.users);
            const lo = document.getElementById('loading-overlay');
            if (lo) lo.style.display = 'none';
            // キャッシュは使うが、裏で最新情報を取得して同期する
            bg = true;
        }
    }

    // 書籍とユーザー情報を並行取得
    const [d, u] = await Promise.all([
        callGAS("getInitialData"),
        callGAS("getUsers")
    ]);

    if (d && d.success && u && u.success) {
        console.log("[Data] Fresh data received");
        setCache({ books: d.books, users: u.users });
        applyData(d.books, u.users, bg);
    } else {
        if (!bg) console.error("Data fetch failed", d, u);
        const lo = document.getElementById('loading-overlay');
        if (lo) lo.style.display = 'none';
    }
}

function applyData(rawBooks, rawUsers, isBg = false) {
    // ユーザーマップを構築（uid → name）
    usersMap = {};
    if (rawUsers) {
        rawUsers.forEach(usr => { usersMap[String(usr.id)] = usr.name; });
    }

    books = (rawBooks || []).sort(function (a, b) { return (parseInt(b.id) || 0) - (parseInt(a.id) || 0); });
    renderBooks();
    renderAdmin();
    renderMyBooks();
    renderBorrowStatus();

    if (!isBg) fetchHistory();

    const lo = document.getElementById('loading-overlay');
    if (lo) lo.style.display = 'none';

    if (books.length > 0) enrichAPI(books);
}

// ─── ④ 貸出状況（全員に公開） ───
function renderBorrowStatus() {
    const c = document.getElementById('borrow-status-list'); if (!c) return;
    const rented = books.filter(b => b.status === 'rented' && b.borrower_id);
    if (!rented.length) {
        c.innerHTML = '<p style="text-align:center;color:var(--muted);padding:16px;font-size:.85rem">現在貸出中の本はありません</p>';
        return;
    }

    // 利用者ごとにグループ化
    const userGroups = {};
    rented.forEach(b => {
        const uid = String(b.borrower_id);
        if (!userGroups[uid]) userGroups[uid] = [];
        userGroups[uid].push(b);
    });

    c.innerHTML = '';
    Object.keys(userGroups).forEach(uid => {
        const userName = usersMap[uid] || uid;
        const userBooks = userGroups[uid];
        const section = document.createElement('div');
        section.style.cssText = 'background:rgba(255,255,255,.03);border-radius:12px;padding:12px;margin-bottom:12px;border:1px solid var(--border)';

        // ヘッダー（利用者名）
        const head = document.createElement('div');
        head.style.cssText = 'font-size:.82rem;font-weight:700;color:var(--acc);margin-bottom:10px;display:flex;align-items:center;gap:6px';
        head.innerHTML = `<i class="fas fa-user-circle"></i> ${userName} さんの貸出中カード`;
        section.appendChild(head);

        // 本のリスト
        userBooks.forEach(b => {
            const item = document.createElement('div');
            item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid rgba(255,255,255,.05)';
            item.innerHTML =
                `<img src="${getImg(b)}" style="width:28px;height:40px;object-fit:cover;border-radius:3px;flex-shrink:0">` +
                `<div style="flex:1;min-width:0;font-size:.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${b.title}</div>`;
            section.appendChild(item);
        });
        c.appendChild(section);
    });
}


// ─── ① ユーザー管理 ───
async function fetchUsers() {
    const res = await callGAS("getUsers");
    if (res && res.success) renderUsers(res.users || []);
}

function renderUsers(users) {
    const tb = document.getElementById('user-table'); if (!tb) return;
    tb.innerHTML = '';
    users.forEach(u => {
        const isMe = me && String(u.id) === String(me.id);
        const tr = document.createElement('tr');
        tr.innerHTML =
            `<td>${u.id}</td>` +
            `<td><b>${u.name}</b></td>` +
            `<td>
                <select onchange="updateUserRole('${u.id}', this.value)" style="width:auto;padding:4px 8px;font-size:.82rem" ${isMe ? 'disabled' : ''}>
                    <option value="student" ${u.role !== 'admin' ? 'selected' : ''}>学生</option>
                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option>
                </select>
            </td>` +
            `<td>${isMe ? '<span style="color:var(--muted);font-size:.78rem">自分</span>' :
                `<button class="btn btn-danger" style="padding:4px 10px;font-size:.78rem" onclick="deleteUser('${u.id}','${u.name}')">削除</button>`
            }</td>`;
        tb.appendChild(tr);
    });
}

async function updateUserRole(uid, role) {
    const res = await callGAS("updateUserRole", { id: uid, role });
    if (res && res.success) {
        toast(`権限を変更しました`);
        clearCache();
    }
    else alert((res && res.message) || "変更に失敗しました");
}

async function deleteUser(uid, name) {
    if (!confirm(`${name} さんを削除しますか？`)) return;
    const res = await callGAS("deleteUser", { id: uid });
    if (res && res.success) {
        toast(`削除しました`);
        clearCache();
        fetchUsers();
    }
    else alert((res && res.message) || "削除に失敗しました");
}

function switchAdminTab(tab) {
    console.log("[Admin] Switching to tab:", tab);
    const panels = {
        'books': document.getElementById('admin-panel-books'),
        'users': document.getElementById('admin-panel-users'),
        'maint': document.getElementById('admin-panel-maint')
    };
    const tabs = {
        'books': document.getElementById('admin-tab-books'),
        'users': document.getElementById('admin-tab-users'),
        'maint': document.getElementById('admin-tab-maint')
    };

    Object.keys(panels).forEach(k => { if (panels[k]) panels[k].style.display = k === tab ? 'block' : 'none'; });
    Object.keys(tabs).forEach(k => { if (tabs[k]) tabs[k].classList.toggle('active', k === tab); });

    if (tab === 'users') fetchUsers();
    else if (tab === 'books') renderAdmin();
}

/** メンテナンス: 貸出履歴の削除 */
async function adminClearLogs() {
    if (!confirm("⚠️ 本当にすべての貸出履歴（ログ）を削除しますか？\nこの操作は取り消せません。")) return;
    const res = await callGAS("clearLogs");
    if (res && res.success) {
        toast("履歴を削除しました");
        fetchHistory(); // マイページの履歴も更新
    } else {
        alert("削除に失敗しました: " + (res.message || ""));
    }
}

/** メンテナンス: 貸出状況の一括リセット */
async function adminResetLending() {
    if (!confirm("⚠️ すべての蔵書を「貸出可」にリセットしますか？\n現在誰かが借りている本もすべて返却済みの扱いになります。")) return;
    const res = await callGAS("resetLendingStatus");
    if (res && res.success) {
        toast("リセット完了");
        clearCache();
        await fetchData(true);
    } else {
        alert("リセットに失敗しました: " + (res.message || ""));
    }
}



/**
 * サムネイル画像が未登録の本を対象に OpenBD / Google Books から自動取得し、
 * スプレッドシートに書き戻す（バックグラウンド処理）。説明文のバックフィルも同時に実行。
 */
async function enrichAPI(list) {
    if (!list || !list.length) return;

    // API制限(429)対策: セッション中で5分間のクールダウンを設ける
    const now = Date.now();
    const lastRun = sessionStorage.getItem('lib_enrich_last');
    if (lastRun && (now - lastRun < 5 * 60 * 1000)) {
        console.log("[enrichAPI] Cooldown: Skipping background enrichment");
        return;
    }
    sessionStorage.setItem('lib_enrich_last', now);

    // ⑨ サムネイルなし & ISBNありの本
    const targets = list.filter(b => !b.thumbnail && b.isbn && String(b.isbn).replace(/[' ]/g, '').length >= 10);
    // ⑨ 説明文なし & ISBNありの本（別リスト）
    const descTargets = list.filter(b => !b.description && b.isbn && String(b.isbn).replace(/[' ]/g, '').length >= 10);

    if (targets.length === 0 && descTargets.length === 0) return;
    console.log(`[enrichAPI] サムネイル取得対象: ${targets.length}冊, 説明文取得対象: ${descTargets.length}冊`);

    // ① OpenBD 一括取得（サムネイル + 説明文）
    const allTargets = [...new Map([...targets, ...descTargets].map(b => [b.id, b])).values()];
    if (allTargets.length) {
        try {
            const isbns = allTargets.map(b => String(b.isbn).replace(/[' ]/g, ''));
            const res = await fetch('https://api.openbd.jp/v1/get?isbn=' + isbns.join(','));
            const data = await res.json();
            data.forEach((item, idx) => {
                if (!item) return;
                const b = allTargets.find(b => String(b.isbn).replace(/[' ]/g, '') === isbns[idx]);
                if (!b) return;
                if (item.summary && item.summary.cover && !b.thumbnail) {
                    b.image_api = item.summary.cover.replace(/^http:/, 'https:');
                }
                // 説明文（OpenBD ONIX形式）
                if (!b.description) {
                    try {
                        const texts = item.onix && item.onix.CollateralDetail && item.onix.CollateralDetail.TextContent;
                        if (texts && texts.length > 0) b.desc_api = texts[0].Text || '';
                    } catch (e) { }
                }
            });
        } catch (e) { console.warn('[enrichAPI] OpenBD error:', e); }
    }

    // ② Google Books で補完（サムネイル + 説明文）
    const stillMissing = targets.filter(b => !b.image_api && b.isbn);
    const descMissing = descTargets.filter(b => !b.desc_api && b.isbn);
    const gbTargets = [...new Map([...stillMissing, ...descMissing].map(b => [b.id, b])).values()];
    // 429回避のため、一度にリクエストするのは最大5冊に絞り、ウェイトを1秒にする
    for (const b of gbTargets.slice(0, 5)) {
        try {
            const cleanIsbn = String(b.isbn).replace(/[' ]/g, '');
            const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`);
            if (res.status === 429) {
                console.warn("[enrichAPI] Google Books Rate Limit (429) reached");
                break;
            }
            const d = await res.json();
            if (d.items && d.items[0]) {
                const v = d.items[0].volumeInfo;
                if (!b.image_api && v.imageLinks) b.image_api = (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail).replace(/^http:/, 'https:');
                if (!b.desc_api && v.description) b.desc_api = v.description;
            }
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { /* 個別失敗は無視 */ }
    }

    // ③ 取得できたサムネイルを画面に反映
    let updated = false;
    allTargets.forEach(b => {
        if (b.image_api) {
            const target = books.find(x => String(x.id) === String(b.id));
            if (target) { target.thumbnail = b.image_api; updated = true; }
        }
        if (b.desc_api) {
            const target = books.find(x => String(x.id) === String(b.id));
            if (target) { target.description = b.desc_api; updated = true; }
        }
    });
    if (updated) { renderBooks(); renderAdmin(); renderBorrowStatus(); }

    // ④ サムネイルをシートに書き戻し
    const toSave = allTargets
        .filter(b => b.image_api)
        .map(b => ({ isbn: String(b.isbn).replace(/[' ]/g, ''), url: b.image_api }));
    if (toSave.length) {
        console.log(`[enrichAPI] ${toSave.length}冊のサムネイルをシートに保存開始...`);
        await callGAS("saveThumbnailsBulk", toSave);
    }

    // ⑤ 説明文をシートに書き戻し（既存書籍へのバックフィル）
    const descToSave = allTargets
        .filter(b => b.desc_api)
        .map(b => ({ isbn: String(b.isbn).replace(/[' ]/g, ''), description: b.desc_api }));
    if (descToSave.length) {
        console.log(`[enrichAPI] ${descToSave.length}冊の説明文をシートに保存開始...`);
        const res = await callGAS("saveDescriptionsBulk", descToSave);
        console.log(`[enrichAPI] バックフィル完了:`, res);
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

/**
 * ISBNが同じ本を1グループにまとめる
 */
function groupBooks(list) {
    const map = new Map();
    list.forEach(b => {
        const key = String(b.isbn || '').replace(/[' ]/g, '') || ('title::' + b.title);
        if (!map.has(key)) {
            map.set(key, { key, rep: b, copies: [] });
        }
        map.get(key).copies.push(b);
    });
    return Array.from(map.values());
}

function renderBooks(f) {
    f = f || '';
    const c = document.getElementById('book-list'); if (!c) return;
    c.innerHTML = '';
    const fl = books.filter(function (b) {
        const haystack = (b.title + (b.author || '') + (b.isbn || '') + (b.publisher || '') + (b.description || '')).toLowerCase();
        return haystack.includes(f.toLowerCase());
    });
    if (!fl.length) {
        c.innerHTML = '<p style="text-align:center;color:var(--muted);padding:32px">該当する書籍はありません</p>';
        return;
    }


    const groups = groupBooks(fl);
    // 最新登録順（グループ内最大IDを代表に）
    groups.sort((a, b) => Math.max(...b.copies.map(x => parseInt(x.id) || 0)) - Math.max(...a.copies.map(x => parseInt(x.id) || 0)));

    groups.forEach(function (g) {
        const rep = g.rep;
        const copies = g.copies;
        const total = copies.length;
        const avail = copies.filter(x => x.status === 'available').length;
        const firstAvail = copies.find(x => x.status === 'available');
        const isMine = copies.some(x => String(x.borrower_id) === String(me && me.id) && x.status === 'rented');
        const myBook = copies.find(x => String(x.borrower_id) === String(me && me.id) && x.status === 'rented');

        const d = document.createElement('div');
        d.className = 'card book-card'; d.style.cursor = 'pointer';
        d.style.display = 'flex'; d.style.flexDirection = 'row';
        d.onclick = function (e) {
            if (e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
                openDetail(g.key);
            }
        };

        // バッジ表示
        let badgeHtml, btnHtml;
        if (avail > 0) {
            badgeHtml = `<span class="badge badge-ok">貸出可 ${avail}/${total}冊</span>`;
            btnHtml = `<button class="btn btn-primary" style="min-width:80px" onclick="event.stopPropagation();borrowBook('${firstAvail.id}')">借りる</button>`;
        } else if (isMine) {
            badgeHtml = `<span class="badge badge-ng">貸出中 ${total}/${total}冊</span>`;
            btnHtml = `<button class="btn btn-warn" style="min-width:80px" onclick="event.stopPropagation();doReturn('${myBook.id}')">返却</button>`;
        } else {
            badgeHtml = `<span class="badge badge-ng">貸出中 ${total}/${total}冊</span>`;
            btnHtml = `<button class="btn btn-outline" style="min-width:80px" onclick="event.stopPropagation();reserveBook('${rep.id}')">予約</button>`;
        }

        // 蔵書数バッジ（2冊以上のとき表示）
        const countBadge = total >= 2
            ? `<span style="font-size:.75rem;color:var(--muted);margin-left:6px">計${total}冊</span>`
            : '';

        d.innerHTML =
            `<img src="${getImg(rep)}" class="book-cover" onerror="this.src='https://via.placeholder.com/68x100'">` +
            `<div class="book-details" style="display:flex; flex-direction:column; justify-content:space-between">` +
            `<div><div class="book-title" style="margin-bottom:4px">${rep.title}${countBadge}</div>` +
            `<div class="book-author">${rep.author || ''} (${rep.publisheddate || rep.publishedDate || '-'})</div></div>` +
            `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:12px">` +
            badgeHtml + btnHtml +
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
        const tr = document.createElement('tr');
        const ok = b.status === 'available';
        const hasImg = (b.thumbnail || b.image_api);
        const imgIndicator = hasImg
            ? `<div class="indicator-badge yes"><i class="fas fa-image"></i></div>`
            : `<div class="indicator-badge no"><i class="fas fa-minus"></i></div>`;

        tr.innerHTML = `<td>${b.id}</td><td><b>${b.title}</b></td><td>${b.author || ''}</td>` +
            `<td style="text-align:center">${imgIndicator}</td>` +
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

// ─── Detail Modal（グループ対応版） ───
function openDetail(groupKey) {
    // groupKeyはISBNまたは「title::タイトル」形式
    const copies = books.filter(b => {
        const key = String(b.isbn || '').replace(/[' ]/g, '') || ('title::' + b.title);
        return key === groupKey;
    });
    if (!copies.length) return;
    const rep = copies[0];
    const total = copies.length;
    const avail = copies.filter(x => x.status === 'available').length;

    // 基本情報をセット
    const cover = document.getElementById('d-cover'); if (cover) cover.src = getImg(rep);
    const title = document.getElementById('d-title'); if (title) title.textContent = rep.title;
    const author = document.getElementById('d-author'); if (author) author.textContent = rep.author || '';
    const pub = document.getElementById('d-pub'); if (pub) pub.textContent = rep.publisher || '-';
    const date = document.getElementById('d-date'); if (date) date.textContent = rep.publisheddate || rep.publishedDate || '-';
    const isbnEl = document.getElementById('d-isbn'); if (isbnEl) isbnEl.textContent = rep.isbn || '-';

    // ステータス（蔵書数表示）
    const st = document.getElementById('d-status');
    if (st) {
        const hasFree = avail > 0;
        st.className = 'badge ' + (hasFree ? 'badge-ok' : 'badge-ng');
        st.textContent = total >= 2 ? `貸出可 ${avail}/${total}冊` : (hasFree ? '貸出可' : '貸出中');
    }

    // アクション（蔵書が複数の場合は各冊個別に表示）
    const acts = document.getElementById('d-actions');
    if (acts) {
        acts.innerHTML = '';
        if (total === 1) {
            // 1冊だけの場合：従来通り
            const b = copies[0];
            const ok = b.status === 'available';
            if (ok) {
                acts.innerHTML = `<button class="btn btn-primary" style="width:100%" onclick="borrowBook('${b.id}');closeBookDetail()">この本を借りる</button>`;
            } else if (me && String(b.borrower_id) === String(me.id)) {
                acts.innerHTML = `<button class="btn btn-warn" style="width:100%" onclick="doReturn('${b.id}');closeBookDetail()">返却する</button>`;
            } else {
                acts.innerHTML = `<button class="btn btn-outline" style="width:100%" onclick="reserveBook('${b.id}');closeBookDetail()">予約する</button>`;
            }
        } else {
            // 複数冊の場合：個別リスト表示
            acts.innerHTML = `<p style="font-size:.82rem;color:var(--muted);margin-bottom:8px">蔵書一覧（${total}冊）</p>`;
            copies.forEach((b, idx) => {
                const ok = b.status === 'available';
                const isMyBook = me && String(b.borrower_id) === String(me.id) && b.status === 'rented';
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid var(--border)';
                let btn;
                if (ok) {
                    btn = `<button class="btn btn-primary" style="padding:4px 12px;font-size:.8rem" onclick="borrowBook('${b.id}');closeBookDetail()">借りる</button>`;
                } else if (isMyBook) {
                    btn = `<button class="btn btn-warn" style="padding:4px 12px;font-size:.8rem" onclick="doReturn('${b.id}');closeBookDetail()">返却</button>`;
                } else {
                    btn = `<span class="badge badge-ng" style="font-size:.75rem">貸出中</span>`;
                }
                row.innerHTML = `<span style="font-size:.85rem">冊子 ${idx + 1}&nbsp;&nbsp;<span class="badge ${ok ? 'badge-ok' : 'badge-ng'}" style="font-size:.72rem">${ok ? '貸出可' : '貸出中'}</span></span>` + btn;
                acts.appendChild(row);
            });
        }
    }

    const modal = document.getElementById('detail-modal');
    if (modal) modal.classList.add('active');
}
function closeBookDetail() {
    const modal = document.getElementById('detail-modal');
    if (modal) modal.classList.remove('active');
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

/** 蔵書数 UI 操作 */
function changeCopies(delta) {
    copiesToAdd = Math.max(1, Math.min(20, copiesToAdd + delta));
    updateCopiesUI();
}
function updateCopiesUI() {
    const d = document.getElementById('copies-display');
    if (d) d.textContent = copiesToAdd;
}

function openAddModal() {
    copiesToAdd = 1;
    updateCopiesUI();
    const modal = document.getElementById('book-modal');
    if (modal) modal.classList.add('active');
    const ttl = document.getElementById('modal-ttl'); if (ttl) ttl.textContent = '蔵書登録';
    const fid = document.getElementById('f-id'); if (fid) fid.value = '';
    const form = document.getElementById('book-form'); if (form) form.reset();

    // 説明文リセット
    const desc = document.getElementById('f-desc'); if (desc) desc.value = '';

    // 蔵書数UIと重複バナーをリセット
    const copiesRow = document.getElementById('copies-row'); if (copiesRow) copiesRow.style.display = 'flex';
    const dupBanner = document.getElementById('dup-banner'); if (dupBanner) dupBanner.style.display = 'none';
    clearPhoto();
}
function openEditModal(id) {
    const b = books.find(function (x) { return String(x.id) === String(id); }); if (!b) return;
    const modal = document.getElementById('book-modal');
    if (modal) modal.classList.add('active');
    const ttl = document.getElementById('modal-ttl'); if (ttl) ttl.textContent = '書誌情報の修正';
    // 編集時は蔵書数UIと重複バナーを非表示
    const copiesRow = document.getElementById('copies-row'); if (copiesRow) copiesRow.style.display = 'none';
    const dupBanner = document.getElementById('dup-banner'); if (dupBanner) dupBanner.style.display = 'none';

    document.getElementById('f-id').value = b.id;
    document.getElementById('f-isbn').value = b.isbn || '';
    document.getElementById('f-title').value = b.title;
    document.getElementById('f-author').value = b.author || '';
    document.getElementById('f-pub').value = b.publisher || '';
    document.getElementById('f-year').value = b.publisheddate || b.publishedDate || '';
    document.getElementById('f-desc').value = b.description || '';
    document.getElementById('f-img').value = b.thumbnail || '';

    if (b.thumbnail) {
        document.getElementById('photo-prev').src = b.thumbnail;
        document.getElementById('photo-area').classList.add('has-photo');
    } else {
        clearPhoto();
    }
}
function closeBookModal() {
    const modal = document.getElementById('book-modal');
    if (modal) modal.classList.remove('active');
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
        description: document.getElementById('f-desc').value || '',
        thumbnail: photoB64 || document.getElementById('f-img').value || ''
    };

    // Drive保存（Base64の場合）
    if (photoB64 && photoB64.startsWith('data:image')) {
        const imgRes = await callGAS("saveImageToDrive", { base64: photoB64, title: data.title });
        if (imgRes && imgRes.success) data.thumbnail = imgRes.url;
    }

    let res;
    if (id) {
        // 編集時: 1冊更新
        res = await callGAS("updateBook", data);
    } else {
        // 新規登録: 蔵書数分一括登録
        const copies = copiesToAdd || 1;
        if (btn) btn.textContent = `登録中 (${copies}冊)...`;
        const booksArray = Array.from({ length: copies }, () => ({ ...data }));
        res = await callGAS("addBooksBulk", booksArray);
    }

    if (btn) { btn.disabled = false; btn.textContent = '保存'; }

    if (res && res.success) {
        const copies = copiesToAdd || 1;
        toast(id ? '更新完了' : `${copies}冊登録完了！`);
        clearCache();
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

/**
 * 著者名の余分な情報（カンマ区切り・生涯年）をクリーニング
 */
function cleanAuthorName(authors) {
    if (!authors || !authors.length) return '';
    let raw = Array.isArray(authors) ? authors.join(', ') : String(authors);

    // 1. 生没年パターンをより広範囲に除去 (かっこ内、または剥き出しの 19xx-)
    raw = raw.replace(/[（\(\[\［]\s*\d{4}[-–－—~～〜]\d*?\s*[）\)\]］]/g, '');
    raw = raw.replace(/\s*\d{4}[-–－—~～〜]\d*/g, '');

    // 2. カンマ、セミコロン、中黒、全角コンマなどをすべて半角スペースに
    raw = raw.replace(/[，,;；、。・]/g, ' ');

    // 3. [著][編] などの役割表記を消す
    raw = raw.replace(/[\[\(]?[著編訳監抄修][\]\)]?/g, '');

    // 4. 単語ごとに分割してクリーンアップし、再結合
    return raw.split(/\s+/).map(a => a.trim())
        .filter(a => a && !/^\d+$/.test(a)) // 数字だけの要素（西暦の残りなど）を除外
        .join(' ')
        .replace(/\s+/g, ' ') // 連続スペースを1つに
        .trim();
}

async function lookupISBN() {
    const isbnVal = document.getElementById('f-isbn').value.trim();
    if (!isbnVal) return;

    const btn = document.getElementById('isbn-btn');
    const st = document.getElementById('isbn-status');
    if (btn) { btn.disabled = true; btn.textContent = '検索中...'; }
    if (st) st.textContent = '書籍情報を取得中...';

    // ── 重複ISBNチェック ──
    const cleanIsbn = isbnVal.replace(/[' ]/g, '');
    const existing = books.filter(b => String(b.isbn || '').replace(/[' ]/g, '') === cleanIsbn);
    const dupBanner = document.getElementById('dup-banner');
    const dupMsg = document.getElementById('dup-msg');
    if (existing.length > 0 && dupBanner && dupMsg) {
        const avail = existing.filter(b => b.status === 'available').length;
        dupMsg.textContent = `現在 ${existing.length}冊（貸出可 ${avail}冊）`;
        dupBanner.style.display = 'block';
    } else if (dupBanner) {
        dupBanner.style.display = 'none';
    }



    const res = await callGAS("lookupISBN", { isbn: isbnVal });
    if (res && res.items && res.items.length > 0) {
        const v = res.items[0].volumeInfo;
        document.getElementById('f-title').value = v.title || '';
        document.getElementById('f-author').value = cleanAuthorName(v.authors);
        document.getElementById('f-pub').value = v.publisher || '';
        document.getElementById('f-year').value = (v.publishedDate || '').substring(0, 4);
        document.getElementById('f-desc').value = v.description || '';

        const cover = v.imageLinks
            ? (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail || '').replace(/^http:/, 'https:')
            : '';

        if (cover) {
            // ② まず即座にプレビュー表示
            document.getElementById('f-img').value = cover;
            document.getElementById('photo-prev').src = cover;
            document.getElementById('photo-area').classList.add('has-photo');
            if (st) st.textContent = '✅ ' + (v.title || '');

            // ③ バックグラウンドでDriveに即保存（登録フォーム送信時に確実なURLを使うため）
            if (st) st.textContent = '📤 表紙をDriveに保存中...';
            try {
                const imgRes = await callGAS("saveImageToDrive", {
                    base64: cover,   // GAS側でUrlFetchAppにより画像を取得・保存
                    title: v.title || 'book'
                });
                if (imgRes && imgRes.success) {
                    document.getElementById('f-img').value = imgRes.url;
                    if (st) st.textContent = '✅ ' + (v.title || '') + '（画像Driveに保存済）';
                } else {
                    // Drive保存失敗時はURLのまま継続（エラーにはしない）
                    if (st) st.textContent = '✅ ' + (v.title || '');
                }
            } catch (e) {
                if (st) st.textContent = '✅ ' + (v.title || '');
            }
        } else {
            if (st) st.textContent = '✅ ' + (v.title || '') + '（表紙画像なし）';
        }
    } else {
        if (st) st.textContent = '⚠️ 見つかりませんでした。手動で入力してください';
    }
    if (btn) { btn.disabled = false; btn.textContent = '手動で書籍情報を取得'; }
}

// ─── Borrow / Return Actions (Optimistic UI 改善版) ───
async function borrowBook(id) {
    if (!me) return;
    const b = books.find(x => String(x.id) === String(id));
    if (!b || b.status !== 'available') return;

    // --- Optimistic Update ---
    const oldStatus = b.status;
    const oldBorrower = b.borrower_id;

    b.status = 'rented';
    b.borrower_id = me.id;

    // 即座にUI反映
    renderBooks();
    renderMyBooks();
    renderBorrowStatus();
    toast('貸出処理を開始しました...');

    // API呼び出し (裏で実行)
    const res = await callGAS("borrowBook", { id, uid: me.id });
    if (res && res.success) {
        toast('貸出を完了しました');
        clearCache();
        fetchData(true); // バックグラウンドで最終同期
    } else {
        // 失敗時はロールバック
        b.status = oldStatus;
        b.borrower_id = oldBorrower;
        renderBooks();
        renderMyBooks();
        renderBorrowStatus();
        alert((res && res.message) || "エラーが発生しました。元の状態に戻します。");
    }
}

async function doReturn(id) {
    if (!me || !confirm('返却しますか？')) return;
    const b = books.find(x => String(x.id) === String(id));
    if (!b) return;

    // --- Optimistic Update ---
    const oldStatus = b.status;
    const oldBorrower = b.borrower_id;

    b.status = 'available';
    b.borrower_id = null;

    renderBooks();
    renderMyBooks();
    renderBorrowStatus();
    toast('返却処理を開始しました...');

    const res = await callGAS("returnBook", { id, uid: me.id });
    if (res && res.success) {
        toast('返却を完了しました');
        clearCache();
        fetchData(true);
    } else {
        // 失敗時はロールバック
        b.status = oldStatus;
        b.borrower_id = oldBorrower;
        renderBooks();
        renderMyBooks();
        renderBorrowStatus();
        alert((res && res.message) || "エラーが発生しました。元の状態に戻します。");
    }
}

async function reserveBook(id) {
    toast('予約リクエストを送信中...');
    const res = await callGAS("reserveBook", { id, uid: me.id });
    if (res && res.success) {
        toast('予約しました');
        clearCache();
        fetchData(true);
    }
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
    const modal = document.getElementById('bulk-modal');
    if (modal) modal.classList.add('active');
    setTimeout(() => {
        const input = document.getElementById('bulk-isbn-input');
        if (input) input.focus();
    }, 400);
}
function closeBulkModal() {
    const modal = document.getElementById('bulk-modal');
    if (modal) modal.classList.remove('active');
}
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
        // 既存ISBNチェック（スプレッドシートの蔵書 + 今回のキュー内）
        const cleanIsbn = String(isbn).replace(/[' ]/g, '');
        const existInDB = books.filter(b => String(b.isbn || '').replace(/[' ]/g, '') === cleanIsbn);
        const existInQueue = bulkQueue.filter(b => String(b.isbn || '').replace(/[' ]/g, '') === cleanIsbn);
        res.dupCount = existInDB.length;       // DB内の既存数
        res.queueDup = existInQueue.length;    // 今回のキュー内での重複数
        bulkQueue.push(res);
        renderBulkList();
    } else {
        toast("⚠️ 取得失敗: " + isbn);
    }
}
function renderBulkList() {
    const list = document.getElementById('bulk-list');
    list.innerHTML = '';
    bulkQueue.forEach((item, idx) => {
        const isDup = item.dupCount > 0;
        const isQueueDup = item.queueDup > 0;
        const d = document.createElement('div');
        d.className = 'card';
        d.style.cssText = `margin-bottom:6px;border:1px solid ${isDup ? 'rgba(245,158,11,.5)' : 'var(--border)'};padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px`;

        let badges = '';
        if (isDup) {
            badges += `<span style="font-size:.72rem;background:rgba(245,158,11,.18);color:var(--warn);border:1px solid rgba(245,158,11,.4);border-radius:6px;padding:2px 7px;white-space:nowrap">⚠️ 既に${item.dupCount}冊</span> `;
        }
        if (isQueueDup) {
            badges += `<span style="font-size:.72rem;background:rgba(148,163,184,.15);color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:2px 7px;white-space:nowrap">🔁 重複</span>`;
        }

        d.innerHTML =
            `<div style="flex:1;min-width:0">` +
            `<div style="font-weight:600;font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.title || '（タイトル不明）'}</div>` +
            `<div style="font-size:.75rem;color:var(--muted);margin-top:2px">${item.isbn}</div>` +
            `</div>` +
            `<div style="display:flex;gap:4px;align-items:center;flex-shrink:0">${badges}` +
            `<button onclick="bulkQueue.splice(${idx},1);renderBulkList()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;padding:2px 4px">✕</button>` +
            `</div>`;
        list.appendChild(d);
    });
    document.getElementById('bulk-count').textContent = bulkQueue.length;

    // 重複サマリーを表示
    const dupTotal = bulkQueue.filter(b => b.dupCount > 0).length;
    const summary = document.getElementById('bulk-dup-summary');
    if (summary) {
        summary.textContent = dupTotal > 0 ? `⚠️ ${dupTotal}冊が既に登録済みです（追加登録されます）` : '';
        summary.style.display = dupTotal > 0 ? 'block' : 'none';
    }
}

async function saveBulk() {
    if (!bulkQueue.length) return;
    const btn = document.getElementById('bulk-save-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
    }

    const res = await callGAS("addBooksBulk", bulkQueue);
    if (res && res.success) {
        toast("すべて登録しました");
        clearCache();
        closeBulkModal();
        await fetchData(true);
    }
    else {
        alert("保存に失敗しました: " + (res.message || ""));
        if (btn) {
            btn.disabled = false;
            btn.textContent = '一括保存する';
        }
    }
}

// ─── NDL (国立国会図書館) 検索 ───────────────────────────────────
function openNDLModal() {
    console.log("[AcademicSearch] Opening modal...");
    let m = document.getElementById('ndl-modal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'ndl-modal';
        m.classList.add('modal-overlay');
        m.innerHTML = `
        <div class="modal" style="max-width:640px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h3>学術資料 検索 (NDL & CiNii Research)</h3>
                <button onclick="closeNDLModal()" style="background:none;border:none;color:var(--muted);font-size:1.5rem;cursor:pointer">&times;</button>
            </div>
            <p style="font-size:.78rem;color:var(--muted);margin-bottom:12px;background:rgba(255,255,255,.03);padding:8px;border-radius:6px">
                <i class="fas fa-info-circle"></i> 国立国会図書館(NDL)の蔵書や、CiNii Researchの学術論文・データベースから情報を検索できます。
            </p>
            <div style="display:flex;gap:8px;margin-bottom:10px">
                <select id="search-source" style="width:120px;padding:8px;font-size:.85rem;background:#f1f5f9;color:var(--txt);border-radius:10px;font-weight:700">
                    <option value="both">両方</option>
                    <option value="ndl">NDL</option>
                    <option value="cinii">CiNii</option>
                </select>
                <input type="text" id="ndl-query" placeholder="キーワード・タイトル・著者名..." style="flex:1">
                <select id="ndl-type" style="width:110px;padding:8px;font-size:.85rem;border-radius:10px;background:#f1f5f9">
                    <option value="">すべて</option>
                    <option value="1">図書</option>
                    <option value="4">論文・記事</option>
                    <option value="5">博士論文</option>
                </select>
            </div>
            <button class="btn btn-primary" style="width:100%;margin-bottom:14px" onclick="doNDLSearch()">検索開始</button>
            <div id="ndl-results" style="max-height:380px;overflow-y:auto"></div>
        </div>`;
        document.body.appendChild(m);
    }
    m.classList.add('active');
    setTimeout(() => { const q = document.getElementById('ndl-query'); if (q) q.focus(); }, 100);
}
function closeNDLModal() {
    const m = document.getElementById('ndl-modal');
    if (m) m.classList.remove('active');
}
async function doNDLSearch() {
    const query = (document.getElementById('ndl-query').value || '').trim();
    const source = document.getElementById('search-source').value;
    const mediatype = document.getElementById('ndl-type').value;
    if (!query) return;
    const resultsEl = document.getElementById('ndl-results');
    resultsEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:24px">🔍 検索中...</p>';

    let results = [];
    let errors = [];

    const callNDL = async () => {
        const res = await callGAS('searchNDL', { query, mediatype });
        if (res && res.success) results = results.concat(res.results || []);
        else if (res) errors.push(`NDL: ${res.message}`);
    };

    const callCiNii = async () => {
        const res = await callGAS('searchCiNii', { query });
        if (res && res.success) results = results.concat(res.results || []);
        else if (res) errors.push(`CiNii: ${res.message}`);
    };

    if (source === 'both') {
        await Promise.all([callNDL(), callCiNii()]);
    } else if (source === 'cinii') {
        await callCiNii();
    } else {
        await callNDL();
    }

    if (results.length === 0 && errors.length > 0) {
        resultsEl.innerHTML = `<p style="text-align:center;color:var(--danger);padding:16px">取得に失敗しました:<br>${errors.join('<br>')}</p>`;
        return;
    }

    // 重複除去（タイトルと著者で簡易判定）
    const uniqueResults = [];
    const seen = new Set();
    results.forEach(r => {
        const key = (r.title + r.author).replace(/\s/g, '');
        if (!seen.has(key)) {
            seen.add(key);
            uniqueResults.push(r);
        }
    });

    renderNDLResults(uniqueResults);
}
function renderNDLResults(results) {
    const el = document.getElementById('ndl-results');
    if (!results.length) {
        el.innerHTML = '<p style="text-align:center;color:var(--muted);padding:24px">結果が見つかりませんでした</p>';
        return;
    }
    el.innerHTML = '';
    el._results = results;
    results.forEach((r, i) => {
        const sourceLabel = `<span style="font-size:.65rem;border:1px solid currentColor;border-radius:4px;padding:0 4px;margin-right:6px;opacity:.7">${r.source || 'NDL'}</span>`;
        const catLabel = r.category ? `<span style="font-size:.7rem;background:rgba(56,189,248,.15);color:var(--acc);border:1px solid rgba(56,189,248,.3);border-radius:5px;padding:1px 6px;margin-left:6px">${r.category}</span>` : '';
        const d = document.createElement('div');
        d.style.cssText = 'padding:12px;border-bottom:1px solid var(--border);transition:background .15s';
        d.onmouseover = () => d.style.background = 'rgba(56,189,248,.06)';
        d.onmouseout = () => d.style.background = '';
        d.innerHTML =
            `<div style="font-weight:600;font-size:.9rem;margin-bottom:3px">${sourceLabel}${r.title}${catLabel}</div>` +
            `<div style="font-size:.78rem;color:var(--muted)">${r.author || '著者不明'} ／ ${r.publisher || ''} ${r.publishedDate ? '(' + r.publishedDate + ')' : ''}</div>` +
            (r.description ? `<div style="font-size:.76rem;color:var(--muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.description}</div>` : '') +
            `<div style="margin-top:8px;display:flex;gap:8px;align-items:center">` +
            `<button class="btn btn-outline" style="padding:4px 12px;font-size:.8rem" onclick="fillFromNDL(${i})">⬆️ フォームに入力</button>` +
            (r.link ? `<a href="${r.link}" target="_blank" style="font-size:.75rem;color:var(--acc);text-decoration:none">詳細を見る →</a>` : '') +
            `</div>`;
        el.appendChild(d);
    });
}
function fillFromNDL(idx) {
    const el = document.getElementById('ndl-results');
    const results = el && el._results;
    if (!results || !results[idx]) return;
    const r = results[idx];
    const set = (id, val) => { const e = document.getElementById(id); if (e) e.value = val || ''; };
    set('f-isbn', r.isbn || '');
    set('f-title', r.title);
    set('f-author', r.author);
    set('f-pub', r.publisher);
    set('f-year', r.publishedDate);
    set('f-desc', r.description || ''); // NDLの説明文も取得
    closeNDLModal();
    toast('フォームに入力しました');
    if (r.isbn) {
        const fIsbn = document.getElementById('f-isbn');
        if (fIsbn) { fIsbn.value = r.isbn; lookupISBN(); }
    }
}

// グローバルに公開
window.openDetail = openDetail;
