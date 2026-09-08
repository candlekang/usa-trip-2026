# data/

- `itinerary.local.json`（**不進 git**）：行程、分區、重要資訊、行前清單、使用說明。
  真相在 Firestore `config/itinerary`，用 `npm run seed` 寫入。
- `allow.local.txt`（**不進 git**）：白名單 email，一行一個。`npm run seed` 寫入 Firestore `allow/{email}`。

要改行程：改 `itinerary.local.json` → `npm run seed`。沒有這個檔案的人可以用 `npm run seed -- --export` 從 Firestore 匯出。
