# news — 繁中新聞 RSS 模組

目前交付第 1–3 塊：可被 modudock 掃描的宣告檔、協定骨架、工具列與空清單，
獨立的 RSS/Atom 解析、正規化、去重、封包大小守衛，以及單來源同步 HTTP Fetcher。
**尚未接上排程或顯示新聞**；收到 `up` 不會發出網路請求。
完整定稿見 [docs/SPEC.md](docs/SPEC.md)。執行期只用 Python 標準庫與原生 ES module。

## 安裝

需要 Python ≥ 3.12、Expat ≥ 2.6，以及支援 protocol 1 的 modudock。
啟動預檢失敗會在 hello 後回帶 seq 的 fail。公開 repo 由使用者發布；發布後，
在 modudock 主 repo 執行以下指令（將 `<owner>` 換成實際 GitHub 帳號）：

```sh
modudock add https://github.com/<owner>/modudock-news
```

安裝登記為 `modules/news` submodule；裝完重啟殼，從 catalog 載入「新聞」。
目前 repo 尚未發布，不能把上述模板當成已驗收的安裝 URL。
來源設定在 `back/feeds.json`，不在公開的 `front/` 裡；改完須重新載入模組。

## 本機開發

工作副本放在 `/Users/gatewenlee/Code/modudock-modules/news`，目錄名就是 id。
殼只掃真目錄，不能以 symlink 代替。

```sh
cd /Users/gatewenlee/Code/modudock/shell
go run ./cmd/modudock -addr 127.0.0.1:8731 -modules /Users/gatewenlee/Code/modudock-modules
```

瀏覽器開 `http://127.0.0.1:8731`。模組 repo 內執行：

```sh
python3 -m unittest -v
./scripts/dev-check.sh
```

dev-check 需要 Go 與提供內建 WebSocket 的 Node，會起自己的殼、連 `/ws` 比對
完整 catalog 宣告，再關閉自己的 process group；8731 已占用時拒絕執行。
此檢查不等於瀏覽器掛載驗收。協定測試使用真 subprocess；
`NEWS_TEST_DIR`、`NEWS_TEST_MODE`、`NEWS_TEST_FEEDS` 僅供測試注入及 writer 閘門，
正常執行請勿設定；宣告檔沒有啟用它們。

`back/fetch.py` 的 `Fetcher.fetch(url, validators)` 回傳 `Result`，status 為
`ok` / `not_modified` / `error`。validators 使用 `etag`、`last_modified`；成功取得
只回候選值，不代表 XML 解析成功，也不提交快取。`timeout`、`deadline` 可在測試縮短。
`news.py --allow-host HOST` 可重複，只配置 Fetcher 的精確主機放行名單，不啟動抓取；
正式宣告檔不帶此參數。User-Agent 的 GitHub owner 仍是規格模板，發布前需填實值。

後續協調者必須接住 `fit_packet` 的 `ValueError`、記 stderr，不能讓 process 因此退出；
304 無快取、解析失敗不提交 validators、保留 stale items 也由後續協調者負責。

### 已知限制

下列是完整 v1 的既定限制，並非宣稱抓取功能已完成：

- 不防 DNS rebinding（解析與連線會是兩次查詢）。
- 固定四條 daemon worker 可能被慢 headers、慢 body 或 DNS 佔住，不能強制回收；
  全部占用時停止更新，每輪回報 deadline，直到連線自行結束。
- 不持久化；殼重啟或模組重載都從零開始。
- stdout 堵塞時 done 盡力送；等待 0.8 秒後強制退出，優先維持 1 秒退出政策。
