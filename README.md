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
