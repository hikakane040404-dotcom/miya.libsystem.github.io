# 宮本研 蔵書管理システム (Miyamoto Lab Library System)

宮本研究室向けの、モダンで使い勝手の良い蔵書管理・貸出システムです。

## 🌟 特徴
- **マルチデバイス対応**: PCだけでなく、スマートフォンからの快適な操作を考慮したデザインです。
- **カメラによるバーコードスキャン**: ISBNバーコードをスキャンして、書籍の検索や登録が瞬時に行えます（GitHub Pages 移行により安定性が大幅に向上）。
- **GAS x GitHub Pages ハイブリッド構成**: データの保存は Google スプレッドシート（Google Apps Script）、画面は GitHub Pages という構成で、セキュリティと利便性を両立しています。
- **書籍情報の自動取得**: OpenBD および Google Books API と連携し、ISBNからタイトル、著者、表紙画像を自動で見つけます。
- **ドライブ連携**: 自身のカメラで撮影した書籍の表紙を Google ドライブに自動保存・表示できます。

## 🚀 使い方

### 一般ユーザー
1. **新規登録・ログイン**: 学生番号でアカウントを作成してログインします。
2. **書籍を探す**: 「一覧」から読みたい本を探したり、キーワードで検索できます。
3. **借りる・返す**: 本の詳細画面、または「スキャン」タブから本のバーコードを読み取って操作します。
4. **マイページ**: 自分の貸出履歴や現在のステータスを確認できます。

### 管理者
- **個別追加**: 本を手動、またはスキャンで1冊ずつ登録できます。
- **一括登録**: 複数の本のバーコードを連続でスキャンし、一気に登録できます。
- **情報の修正**: 登録済みの本のタイトルや画像を「管理」モードから修正できます。

## 🛠️ 技術構成
- **Frontend**: HTML5, Vanilla CSS (Modern aesthetic), JavaScript
- **Backend**: Google Apps Script (Web App / POST API)
- **Database**: Google Sheets
- **Image Storage**: Google Drive
- **Scanner**: html5-qrcode library

## ⚙️ メンテナンス・設置方法
1. Google スプレッドシートを用意し、`Code.js` を GAS プロジェクトとしてデプロイします。
2. `index.html` 内の `GAS_API_URL` を、自身の GAS デプロイ URL に書き換えます。
3. `index.html` を GitHub Pages で公開します。

---
© 2026 Miyamoto Lab.
