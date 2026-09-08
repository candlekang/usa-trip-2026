# 美國行 2026 · 旅行 App

7 人美國公路旅行的共用小 app：行程打勾、留言、每日心得、照片牆、行前清單、分帳結算。

## 架構（v2）

```
瀏覽器（index.html + app.js，靜態檔）
   ├── Firebase Auth      Google 登入，白名單 email 才能進
   └── Firestore          共用狀態；Rules 限制「只能改自己那一格 / 那一筆」
                          離線時寫入排隊（IndexedDB），恢復連線自動送出
```

- 沒有後端程式。安全全部靠 `firestore.rules`，有單元測試（`npm run test:rules`），push 會在 GitHub Actions 自動跑。
- 行程、住宿、航班等內容**不在程式碼裡**，存在 Firestore `config/itinerary`，登入的團員才讀得到。
- Firebase 前端 config（`firebase-config.js`）設計上是公開的，不是機密。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 畫面骨架 + CSS |
| `app.js` | 全部邏輯：登入、Firestore 監聽、寫入、render |
| `art.js` | SVG 圖示 |
| `firestore.rules` / `tests/` | 資料庫規則與測試 |
| `scripts/seed.mjs` | 把 `data/itinerary.local.json` 與 `data/allow.local.txt` 寫進 Firestore（兩個檔都不進 git） |

## 改行程 / 加團員

```bash
# 改行程：編輯 data/itinerary.local.json 後
npm run seed
# 只更新白名單：編輯 data/allow.local.txt（一行一個 email）後
npm run seed -- --allow-only
# 沒有本機檔案？從 Firestore 匯出
npm run seed -- --export
```

需要 Firebase 專案 `ron-usa-trip-2026` 的權限與 `gcloud auth application-default login`。

## 本機開發

```bash
npm install
export JAVA_HOME=$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home   # emulator 需要 Java
npm run emulators            # hosting :5050 / auth :9099 / firestore :8080 / UI :4000
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed
# 開 http://localhost:5050/?emu=1，登入時用 emulator 的假帳號即可
npm run test:rules
```

## 部署

```bash
firebase hosting:channel:deploy test --project ron-usa-trip-2026   # 7 天 preview 網址
firebase deploy --only firestore:rules,hosting --project ron-usa-trip-2026
```

GitHub Pages（main）也能直接服務同一份檔案，兩者擇一。
