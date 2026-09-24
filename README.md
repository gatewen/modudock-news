# news — 繁中新聞 RSS 模組

已完成宣告檔、協定、RSS/Atom 解析與正規化、HTTP Fetcher、前半渲染，
以及固定四條 worker 的協調者／排程。`up` 開始第一輪，結束後隔 10 分鐘下一輪；
抓取中的 refresh 合併成一次待辦。前半提供新聞列表、來源篩選與失敗來源數。
v0.2 加入可選的自動新聞分類、類別標籤與來源／類別交叉篩選。
完整定稿見 [docs/SPEC.md](docs/SPEC.md)。執行期只用 Python 標準庫與原生 ES module。

## 安裝

需要 Python ≥ 3.12、Expat ≥ 2.6，以及支援 protocol 1 的 modudock。
啟動預檢失敗會在 hello 後回帶 seq 的 fail。公開 repo 由使用者發布；發布後，
在 modudock 主 repo 執行以下指令：

```sh
modudock add https://github.com/gatewen/modudock-news
```

指令須在主 repo 根（有 `.git/` 與 `modules/`）執行，且 `modudock` 執行檔已在 PATH。
安裝登記為 `modules/news` submodule，但不自動 commit、不自動載入；
自行檢查並 commit 登記變更，重啟殼後從 catalog 載入「新聞」。
殼需包含 `4aa95dd` 的後半 publish Topic 修正，否則 `news.fetched` 會被丟棄。
目前 repo 尚未發布，不能把上述模板當成已驗收的安裝 URL。
來源設定在 `back/feeds.json`，不在公開的 `front/` 裡；改完須重新載入模組。

## 分類（v0.2）

在啟動 modudock 殼之前，於殼的環境設定 `TYPESAFE_API_KEY`；殼會將自己的
環境變數繼承給新聞後半。設定或更換 key 後，需讓殼取得新環境並重新載入模組。
key 不寫入模組檔案，也不送到前半或記錄中。

沒有 key 時新聞照常列出，標籤顯示「未分類」，狀態列顯示「分類：關閉」。
有 key 時，列表先顯示，分類完成後補上類別；可同時用來源與類別篩選。
API 回傳 401 或 403 後，本 process 會永久關閉分類，不再嘗試；修正 key 後須重新載入。
其他分類失敗會停止本輪分類，下一輪再試，新聞抓取與顯示照常。

**資料出境提醒：**啟用分類後，新聞的標題＋摘要會送到 TypeSafe AI 的雲端 API，
服務由美國託管；不送連結、來源或全文。分類快取不持久化，殼重啟或模組重載後會重新分類。

## 財經分析（v0.3）

啟用分類後，財經與科技新聞會再分析股市訊號、主要題材，以及對該題材的方向。
切到「財經」或「科技」類別時，列表上方顯示分析面板；範圍是目前來源與類別篩選後的新聞。
面板列出樣本數、來源數、分析中筆數、股市訊號分布、大盤／總經及最多十項題材排行。
不足 10 個事件會提示「樣本少，僅供參考」；未分析或無法辨識的股市訊號計入「未明」。

題材自 v0.4 起按事件數排序；▲／▼ 只計方向機率至少 0.6 的利多／利空。
點題材按鈕可篩選清單，再點同題材或「清除」取消；面板統計不受題材篩選影響。
補送分析結果會保留篩選，切到財經／科技以外的類別則清除題材篩選。
v0.4 面板以事件計數，同一事件多家報導只算一次，樣本行同時保留報導數。
題材清單是人維護的固定表，不會由新聞自動產生新題材；每則只取主要題材。

新增「經濟日報 證券」、「經濟日報 產業」、「MoneyDJ 頭條」、「Yahoo 台股動態」
四個來源，共 13 個來源。合併列表上限提高到 300 則，仍受 900 KB 大小守衛限制。
分析與分類共用 API key 及開關，資料出境與不持久化規則相同。

## 同事件合併（v0.4）

同事件的新聞預設摺疊成一列，顯示最早的一則；點「另 N 則報導」可展開其他
報導的標題、來源與時間，再點收合。來源、類別與題材先篩選個別報導，再摺疊；
代表與其他報導數都依篩選後的內容決定。相同事件 id 的展開狀態會在補送後保留。

後半只比較發布時間相差不超過 36 小時的新聞，標題去空白、標點並轉小寫後，
計算字元 bigram 重疊係數。相似度 ≥ 0.9 直接合併；0.2–0.9 的候選用標題＋摘要
詢問 jev，只有回答同事件且機率 ≥ 0.8 才採納。合併後整群與最早代表的時間差
不得超過 24 小時，避免一路串連成過大的事件。仍可能有少量誤合併與漏合併。
沒有 key 或 API 停用時，仍保留 ≥ 0.9 的自動合併。

財經／科技面板的股市訊號、大盤與題材排行改以事件計數，採用符合來源與類別
篩選、最早且已分析的報導；題材篩選仍只影響清單。樣本行顯示事件數、報導數與
來源數，配對尚未完成時顯示「合併中 X」。配對與分類、分析共用 key、開關及
每輪預算，資料出境規則相同，結果不持久化。

## 本機開發

工作副本放在 `/Users/gatewenlee/Code/modudock-modules/news`，目錄名就是 id。
殼只掃真目錄，不能以 symlink 代替。

```sh
cd /Users/gatewenlee/Code/modudock/shell
go run ./cmd/modudock -addr 127.0.0.1:8731 -modules /Users/gatewenlee/Code/modudock-modules
```

瀏覽器開 `http://127.0.0.1:8731`。模組 repo 內執行：

```sh
/usr/local/bin/python3 -m unittest -v
npm ci --ignore-scripts
npm test
./scripts/dev-check.sh
```

dev-check 需要 Go 與提供內建 WebSocket 的 Node，會起自己的殼、連 `/ws` 比對
完整 catalog 宣告，再關閉自己的 process group；8731 已占用時拒絕執行。
此檢查不等於瀏覽器掛載驗收。協定測試使用真 subprocess；
`NEWS_TEST_DIR`、`NEWS_TEST_MODE`、`NEWS_TEST_FEEDS`、`NEWS_TEST_SCHEDULER`、`NEWS_TEST_JEV_URL`
僅供測試注入及 writer 閘門，
正常執行請勿設定；宣告檔沒有啟用它們。

`back/fetch.py` 的 `Fetcher.fetch(url, validators)` 回傳 `Result`，status 為
`ok` / `not_modified` / `error`。validators 使用 `etag`、`last_modified`；成功取得
只回候選值，不代表 XML 解析成功，也不提交快取。`timeout`、`deadline` 可在測試縮短。
`news.py --allow-host HOST` 可重複，只配置 Fetcher 的精確主機放行名單；收到 up 才抓取。
正式宣告檔不帶此參數。User-Agent 帶 repo 網址 `https://github.com/gatewen/modudock-news`。

協調者接住 `fit_packet` 的 `ValueError` 並記 stderr，該輪不送 list/publish、仍算結束；
304 無快取標失敗並清 validators，解析失敗不提交 validators，失敗保留 stale items。
worker 只回候選；協調者驗輪 id 與期限後才整份提交 items/validators/first_seen。
每來源採納期限由 worker 取件時計起；尚在排隊的來源由整輪期限兜底。

### 已知限制

執行期不需要 npm；happy-dom 只用於開發測試。已知限制：

- 不防 DNS rebinding（解析與連線會是兩次查詢）。
- 固定四條 daemon worker 可能被慢 headers、慢 body 或 DNS 佔住，不能強制回收；
  全部占用時停止更新，每輪回報 deadline，直到連線自行結束。
- 不持久化；殼重啟或模組重載都從零開始。
- stdout 堵塞時 done 盡力送；等待 0.8 秒後強制退出，優先維持 1 秒退出政策。
- Python 的 CA store 可能是空的（例如 python.org macOS 安裝未裝憑證）。Fetcher
  先用預設 SSL context；若無 CA，依序嘗試 SSL_CERT_FILE、macOS/Debian/RHEL
  常見系統 bundle。仍無 CA 時 HTTPS 回報 `no CA certificates`，不連線、不關驗證。
  系統必須提供可信且有效的 CA bundle；修正憑證後須重新載入模組。

### 刻意不做（SPEC §9）

- 全文抓取、圖片、關鍵字搜尋、使用者自訂來源 UI、持久化、通知。
- GitHub 發布由使用者處理；公開 repo 發布後才做 `modudock add` 安裝驗收。
