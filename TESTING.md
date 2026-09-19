# 0.2.0 測試記錄

## 已通過

- `npm test`：36 項，含指紋、完整分段、混合檢索、去重、取消、保存恢復、多視窗鎖、故障備援、助手正文配對、v1 摘要遷移、未完成目錄保留歷史、重複全文核對、試跑不寫聊天，以及 DeepSeek 助手關閉思考／拒絕空回覆／獨立連線參數。
- `npm run check`：manifest、全部自有 JavaScript 語法、內建模型與 runtime SHA-256。
- `python tests/browser.py`：真實 Chromium、普通 HTTP、內建 ONNX / WASM。512 維、L2 norm 約 1；同義句 cosine 0.830，不相關句 0.431；這只是冒煙檢查，不是品質評測。首次推理約 4.9 秒，不代表手機性能。
- 三頁角色正文生成三次摘要，玩家輸入不獨立摘要；重開無重複摘要。魔法棒介面、搜尋、助手測試按鈕、暫停、Anima 接管及 390px 手機無水平溢出。外部資源請求 0、瀏覽器錯誤 0。此項助手 API 為合成回覆。
- `python tests/host_readonly.py`：已運行 SillyTavern 1.18.0 的實際 discovery、模型參數適配器、`runGenerationInterceptors`。選中正文及玩家背景進入歷史，最新輸入保留，主模型設定和原聊天不變；2 次助手 API 為合成回覆，應用寫入全部攔截。

## 真實助手連線驗收

`tests/host_live.py` 已通過：從局域網酒館直接載入已安裝的 0.2.0（沒有用本地模組冒充），使用既有 DeepSeek Flash 連線和合成故事。

- 三頁正文各完成一次摘要，三頁向量索引完成；再執行整理沒有重複保存。
- 真實助手從兩頁舊目錄候選中選回正確的藍色信件正文；七則歷史縮到五則，玩家背景與最後輸入仍保留。
- 四次短請求都有非空正文，`finish_reason=stop`，測試時約 1.14–1.50 秒；不代表實際長篇或所有網路的速度。
- 五則在原生 request-ready 事件的合成請求內找到完整內容。沒有發送主模型正文生成，這不等於對用戶所有預設的端到端驗證。
- 聊天與主模型設定保持不變。應用寫入被攔截；瀏覽器錯誤 0。桌面與 390px 手機截圖已檢查。

實機測試最初抓到 DeepSeek 回 200 但正文空白、`finish_reason=length`。修正助手請求的思考控制後才通過，不把 HTTP 200 當作摘要完成。DeepSeek 預設思考與關閉方式依 [官方文件](https://api-docs.deepseek.com/guides/thinking_mode/)；自訂後端欄位依 [SillyTavern 1.18 原始碼](https://github.com/SillyTavern/SillyTavern/blob/1.18.0/src/endpoints/backends/chat-completions.js)。只影響插件助手，不更改主聊天思考設定。

## 限制

沒有聲稱測過每個角色卡的 HTML、所有手機／酒館版本、多裝置同時編輯或數萬頁壓力。其他第三方擴充在隔離驗收瀏覽器不載入，未證明所有插件並用相容。

最終請求觀測驗證使用酒館真實事件搭配合成訊息；不發送真正的主模型正文回覆，也不宣稱驗證每個預設最後的全文。事件觀測不是供應商收件確認。所有瀏覽器均 finally 關閉，沒有啟動新酒館伺服器、端口或常駐服務。
