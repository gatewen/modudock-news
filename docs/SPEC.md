# modudock-news 規格

- 狀態：v0.1 定稿（Codex 五輪，22 條已納入）；v0.2 分類增補見 §12
- 日期：2026-09-21
- 角色：codex-modudock 開發；claude-modudock 對抗審核（門檻：只收中高——抓不到 / 假綠 / 安全洞 / 違反殼協定）
- 依據：modudock `docs/MANIFEST.md`、`docs/RUNTIME-PROTOCOL.md`（protocol 1）、`docs/ADD.md`

## 1. 一句話

一個 modudock 模組：後半定時抓一組繁中新聞 RSS，前半在 `main` 位置列出最新新聞；自己一個 GitHub 公開 repo，最後用 `modudock add` 拉進殼變 submodule。

## 2. 硬限制（來自殼，不可談）

1. **沒有安裝步驟。** `modudock add` 只做 clone + 登記，殼起後半只跑 `backend.command`。所以後半**只能用 Python 3 標準庫**（urllib / xml.etree / html.parser / threading / json）。不准 pip 依賴。
2. **線 B 一行 ≤ 1 MB**，超過視同後半 fail。每則送給前半的 `msg` 要有上限（見 §5）。
3. **前半是原生 ES module**，`import()` 抓什麼跑什麼，不經建置；`frontend.public` 裡的東西一律公開。
4. **前半在 `up` 之前送的東西殼會丟**；後半每行要 flush、讀用 readline（echo 的兩個坑）。
5. **repo 必須公開**：`modudock add` 不帶任何憑證。
6. id 規則 `[A-Za-z0-9._-]{1,64}`；`modules/<id>` 由 id 命名。
7. 後半被殺是 process group 整組殺；`bye` 後拆卸逾時內要回 `done` 並自己退出。
8. **線 B 每則都帶 `seq`**：殼在 `hello` 給的本輪序號，後半送出的 `ready` / `done` / `msg` / `publish` 全部回填同一個 seq；殼送來的每則也帶 seq，不等於本輪的一律丟掉並記 stderr。
9. **每個 process 只有一輪**：`hello → ready → up → … → bye → done`。前端斷線＝殼把模組拆掉，使用者重新載入是**新 process 從零開始**（協定 §5.4）。沒有跨重連的快取。
10. **執行環境下限**：Python ≥ 3.12、expat ≥ 2.6（本機 3.12.8 / expat 2.6.4）。啟動時預先檢查並**保存**錯誤；但 `fail` 只能在收到合法 `hello`、拿到 seq **之後**送（之前送殼會丟），flush 後退出。
11. **殼掃 `modules/` 只認真目錄**（`DirEntry.IsDir()`），symlink 不算模組。

## 3. 宣告檔

```json
{
  "protocol": 1,
  "id": "news",
  "name": "新聞",
  "version": "0.1.0",
  "frontend": { "entry": "front/front.js", "public": "front" },
  "backend":  { "command": ["python3", "back/news.py"] },
  "placements": [ { "slot": "main", "title": "新聞" } ],
  "provides": [ "news.fetched" ]
}
```

## 4. 來源（2026-09-21 實測皆 200 且有 item）

| 名稱 | URL |
|---|---|
| 公視新聞網 | https://news.pts.org.tw/xml/newsfeed.xml |
| 報導者 | https://www.twreporter.org/a/rss2.xml |
| 自由時報即時 | https://news.ltn.com.tw/rss/all.xml |
| 中央社 政治 | https://feeds.feedburner.com/rsscna/politics |
| 中央社 財經 | https://feeds.feedburner.com/rsscna/finance |
| 中央社 國際 | https://feeds.feedburner.com/rsscna/intworld |
| BBC 中文（繁） | https://feeds.bbci.co.uk/zhongwen/trad/rss.xml |
| 端傳媒 | https://theinitium.com/feed |
| 科技新報 | https://technews.tw/feed/ |

- 清單放 `back/feeds.json`（**不在 `front/`，不公開**）。格式 `[{"name":..., "url":...}]`。
- 只接受 `http:` / `https:`；redirect 落到其他 scheme 一律拒。
- 第一版不做使用者自訂來源的 UI；改 `feeds.json` 重啟即可。

## 5. 後半行為（`back/news.py`）

### 5.1 協定與輸出所有權

- 完整封包（N = hello 的 seq）：

  | 方向 | 封包 |
  |---|---|
  | 殼→後半 | `{"t":"hello","seq":N}` → 後半 `{"t":"ready","seq":N}`（或 `{"t":"fail","seq":N,"reason":"…"}`） |
  | 殼→後半 | `{"t":"up","seq":N}` → 開始排程 |
  | 殼→後半 | `{"t":"msg","seq":N,"body":{"op":"refresh"}}` |
  | 後半→殼 | `{"t":"msg","seq":N,"body":{"op":"list",…}}` |
  | 後半→殼 | `{"t":"publish","seq":N,"topic":"news.fetched","body":{"count":n,"at":"…"}}` |
  | 殼→後半 | `{"t":"bye","seq":N}` → 後半 `{"t":"done","seq":N}` 然後退出 |
  | 殼→後半 | `{"t":"event",…}` | 忽略（不訂閱任何主題） |

- `ready` 之前不碰網路；啟動檢查（§2.10、feeds.json 讀得到且格式對）失敗 → `fail`。
- **stdout 只有一個寫入者**：一條 writer 執行緒（daemon）從 `queue.Queue` 取封包寫出並 flush；所有執行緒只能透過 `Outbox.put()` 入列。`Outbox` 內部一把鎖保護 `closed` 旗標與入列：`close_with(done)` 在鎖內把 `closed=True`、**丟掉佇列裡尚未送出的業務訊息**、放入 `done` 與哨兵——之後任何 put 在鎖內看到 closed 直接丟棄。**不會有 done 之後的業務訊息、不會有交錯的 JSON。**
- `done` 的送達：writer 寫完並 flush `done` 後 set 一個 `Event`；主執行緒 `wait(0.8)`——等到就 `sys.exit(0)`；等不到（stdout 被堵、殼沒在讀）就 `os._exit(0)`。**政策：done 盡力送，1 秒內退出優先**（殼那邊 done 沒到會 kill，結果相同）。
- `json.dumps` 用預設 `ensure_ascii`；stdout 只有協定行，記錄全走 stderr。
- stdin：主執行緒 `readline` 迴圈；EOF 或 `bye` → 走結束流程。

### 5.2 執行緒與結束

- **只用 `threading.Thread(daemon=True)`，不用 `ThreadPoolExecutor`**（executor 的執行緒會擋住解譯器退出）。並行上限用 `threading.Semaphore(4)`。
- **固定 4 條 worker 執行緒**（daemon，啟動時建好，之後不再建執行緒）＋ 一個有界待辦 `queue.Queue(maxsize=32)`。排程器開一輪時先**清空待辦裡屬於舊輪的工作**，再把本輪每個來源的工作放進去；worker 取出工作先看輪 id 還有效才做，失效直接跳過。所以待辦與執行緒數都有上限，不隨輪數增長。
- **期限的意義（誠實版）**：30 秒「每來源期限」與 60 秒「每輪期限」是**協調者停止採納結果**的期限，**不保證 worker 被釋放**。socket timeout 15 秒只管單次 recv/connect；伺服器只要每 15 秒內滴一點（慢 headers、慢 body），單一 `urlopen()` 或讀取可以無限長；`getaddrinfo` 沒有逾時 API。這些都會佔住一條 worker。
- **worker 耗盡政策**：四條全被佔住時，之後每一輪所有來源都在 60 秒期限記 `error:"deadline"`、前半照常收到（stale 的）list，直到卡住的連線自己結束。這是**已知限制**，README 與 §11 寫明；不做可終止的工作程序（v1 的來源是自己挑的九個，不是任意輸入）。
- body 讀取仍用「有資料就回」的 `read1(n)`，每塊檢查時鐘——這讓**願意配合的**慢來源在 30 秒放手，只是不構成保證。
- 結束流程：設 `stopping` → 排程器不再開新輪 → `Outbox.close_with(done)` → 主執行緒等 done 送達（見 5.1）→ 退出。daemon 執行緒不等。
- **保證**：收到 `bye` 或 EOF 後 1 秒內 process 退出（測 §8.5 用閘門讓 HTTP 卡住時驗）。

### 5.3 排程

- `up` 後立刻第一輪；之後**每一輪結束時**排下一輪，間隔 10 分鐘（從結束起算）。
- 同時只有一輪在跑。抓取中收到 `refresh` → 記 `pending_refresh = True`（重複收到不累加）；本輪結束後若 pending 立刻再跑一輪並清旗標，不等 10 分鐘。
- 每一輪有 **輪 id**。**worker 不碰快取**：只回傳候選結果 `(round_id, source, result)`；唯一的協調者（排程執行緒）收到後確認輪 id 仍有效**才提交**到快取（items / validators / first_seen 一次提交）。失效輪的候選整個丟掉，快取不變。

### 5.4 抓取一個來源

- 逾時三層：socket timeout 15 秒（`urlopen(timeout=)`）；**每來源總期限 30 秒**（連線、redirect、讀取合計，讀取分塊、每塊檢查時鐘）；**每輪總期限 60 秒**——到期就用手上已回來的結果收輪，沒回來的來源記 `error:"deadline"`，其 worker 之後回來也丟（輪 id）。
- 網路信任邊界（**初始 URL 與每一次 redirect 都檢查**，用自訂 `HTTPRedirectHandler`；redirect 最多 5 次）：
  - 只接受 `http:` / `https:`；URL 帶 userinfo（`user:pass@`）拒；
  - 主機名先解析（`socket.getaddrinfo`），**任何一個位址**落在 loopback / private（10/8、172.16/12、192.168/16）/ link-local（169.254/16、fe80::/10）/ multicast / reserved / unspecified / ULA（fc00::/7）/ IPv4-mapped 的對應範圍 → 拒，記 `error:"private address"`；
  - 不用 proxy（`ProxyHandler({})`，忽略環境變數）；
  - **不宣稱防 DNS rebinding**（解析與連線是兩次查詢），README 寫明。
  - 測試注入：`news.py --allow-host <host>`（可重複；**精確比對主機名或 IP**，只放行那幾個，不是放寬整個私有網段），只在測試的 subprocess 呼叫用；`modudock.json` 的 command 不帶。單元層 `Fetcher(allow_hosts={...})` 同義。
- 請求：`User-Agent: modudock-news/0.1 (+https://github.com/gatewen/modudock-news)`；**不送 `Accept-Encoding`**；回應若帶 `Content-Encoding` → 該來源失敗（不解壓）。
- 有上次的 validators 就帶 `If-None-Match` / `If-Modified-Since`。
- 讀取上限 **2 MB**：超過 → 該來源**失敗**（不截斷、不解析半份）。
- XML 用 `xml.parsers.expat.ParserCreate()` 直接解析（不用 ElementTree 的便利 API），在**解析階段**拒絕而不是掃 bytes（掃 bytes 對 UTF-16 無效）：設 `StartDoctypeDeclHandler`、`EntityDeclHandler`、`ExternalEntityRefHandler` 一被呼叫就記錯誤並停止解析（任何 DTD / entity 宣告都拒，RSS/Atom 不需要）；`StartElementHandler` 計數：元素 > 20000 或深度 > 32 → 拒；單一文字節點累積 > 256 KB → 拒。編碼由 expat 處理（UTF-8 / UTF-16 都會走同一套 handler）。
- 結果三種：`ok(items, validators)` / `not_modified` / `error(str)`。

### 5.5 快取與失敗語意（每個來源一份）

- 快取 = `{items, etag, last_modified, first_seen: OrderedDict(key → iso)}`；`first_seen` **每來源最多 1000 個 key**，超過淘汰最早進入的。「缺日期的則時間穩定」只在該 key 尚未被淘汰期間成立。
- **只在成功解析後原子更新** items 與 validators（同一次賦值）。解析失敗即使 HTTP 200 也**不更新 validators**（避免之後永遠 304 沒資料）。
- `not_modified` 且有快取 → 沿用；`not_modified` 但**沒有快取** → 視為失敗 `error:"304 without cache"` 並清掉 validators。
- 任何失敗 → **保留舊 items**，該來源 `ok:false, error:<str>`，items 照常進合併（stale 但在）。
- `sources[i]`：`{"name", "ok": bool, "error": str|null, "count": 本輪合併後屬於該來源的則數}`。
- 廣播 `news.fetched` 的 `count` = 本輪 `items` 長度（合併、去重、裁切之後）。

### 5.6 正規化（決定性規則）

- 認 RSS 2.0（`<rss><channel><item>`）與 Atom（`<feed><entry>`）；其他根元素 → 失敗。
- 欄位：
  - `title`：RSS `title` / Atom `title`，去標籤、壓空白，**≤ 300 字**；空 → 丟該則。
  - `link`：RSS `link`（空則 `guid` 且 `isPermaLink!="false"`）；Atom 先找 `rel="alternate"`（或無 rel）的 `link@href`，沒有就第一個 `link@href`。相對連結用**feed 的最終 URL**（redirect 之後）`urljoin`。結果不是 http(s) 或空 → **丟該則**。**≤ 2048 字**，超過丟該則。
  - `published`：RSS `pubDate` / Atom `published`，沒有則 `updated`；用 `email.utils.parsedate_to_datetime` 與 `datetime.fromisoformat` 解析成 UTC ISO 8601；解析不了 → `first_seen[key]`（該 key 第一次見到的時間，存在快取裡，process 生命週期內穩定），並 `time_guessed: true`；否則 `false`。
  - `summary`：RSS `description` / Atom `summary`（無則 `content`）；去標籤（`html.parser`）、`html.unescape`、壓空白，**≤ 200 字**。
  - `source`：feeds.json 的 name（≤ 64 字）。
- 去重 key：`link` 去 fragment、去 query 中 `utm_*` 與 `fbclid`。同 key 多則 → 留 `published` 最新的；再同 → 留先出現在 feeds.json 順序的。
- 排序：`published` 新→舊；同時間依 `source` 再 `title` 字典序（穩定）。
- 最多 **200 則**。

### 5.7 大小上限

- 可變字串全部有上限（見 5.6；`error` ≤ 200 字；feeds.json 最多 **32** 個來源，多的啟動時 `fail`）。
- 送出前算實際 bytes：`len(json.dumps(packet)) + 1`（含 envelope、seq、換行）> **900 KB** → 從尾端砍 items 直到不超過。這道守衛在上限下是**可達的**（ensure_ascii 讓每個 CJK 字 6 bytes；200 則 × 滿欄位 > 900 KB），測試要先證明。

## 6. 前半行為（`front/front.js`）

- `mount(ctx)` 契約（協定 §3）：**同步**做完——建 UI、`ctx.channel.onMessage(...)`、`ctx.onUp(...)` 都註冊好，然後 `ctx.report('ready')`，**回傳 `{ unmount() }`**。缺任何一步殼會判 fail 或等到裝載逾時。
- UI：工具列（「重新整理」按鈕、來源篩選 `<select>`、狀態文字）＋ 清單。
- 按鈕在 `onUp` 前 disabled。
- 按鈕 click → `ctx.channel.send({op:"refresh"})`；只在 up 之後。
- `onMessage(body)`：`body.op === "list"` → 重畫清單：每則 `來源 · 時間 · 標題（<a target=_blank rel="noopener noreferrer">）`，`title` 屬性放 summary。其他 op 忽略。所有欄位先檢查型別（不是 string 就當空字串）。
- **一律 `textContent`，禁 `innerHTML`**（RSS 內容是不受信任的）。`link` 只在 `http:`/`https:` 時才做成 `<a>`，否則純文字。
- 時間顯示成本地時區 `MM-DD HH:mm`。
- `unmount()`：清自己掛的東西、移除事件監聽。
- 不用任何框架、不經建置，一個檔案。

## 7. Repo 形狀

```
modudock-news/
  modudock.json
  back/news.py
  back/feeds.json
  front/front.js
  tests/            # Python unittest（執行期零依賴）；front 測試用 node + happy-dom（devDependency，只在開發機）
  docs/SPEC.md      # 本文件定稿
  README.md         # 怎麼裝（modudock add）、怎麼本機開發
  LICENSE
```

## 8. 測試（模組 repo 自己的）

後半：`python3 -m unittest`；前半：`npm test`（node + happy-dom，dev-only）。

1. **解析**：RSS 2.0 / Atom fixture；壞 XML；缺 pubDate（驗 first_seen 兩輪穩定）；CDATA 含 HTML 的 summary；相對 link；Atom 多個 link（alternate 優先）；缺 link 被丟；`<!DOCTYPE` / `<!ENTITY` 被拒；元素數 > 20000 被拒；根元素不是 rss/feed 被拒。
2. **去重與排序**：同 link 不同 utm/fbclid 只留一則且留最新；同時間 tie-break 決定性（跑兩次同結果）。
3. **大小上限**：構造 200 則滿欄位（title 300 CJK、link 2048、summary 200 CJK、32 個來源 error 200 字）→ **先斷言序列化 > 900 KB**，再斷言送出的行 ≤ 900 KB；變異（拔守衛）要紅。
4. **HTTP**（本機 `http.server`，subprocess 帶 `--allow-private`）：正常 / 304 有快取沿用 / 304 無快取視為失敗 / 5xx 保留舊 items 並 ok:false / 回應 > 2 MB 失敗不截斷 / `Content-Encoding: gzip` 失敗 / redirect 到 `file://` 拒 / redirect 到私有位址：假 server 在 localhost、`allow_hosts={'127.0.0.1'}` 放行第一跳，第一跳回 302 到 `http://10.255.255.1/`——斷言假 server **收到第一跳**、錯誤是 `private address`、耗時 < 1 秒（沒去連）；**拔掉 redirect handler 的檢查測試要紅**（會改成連線逾時）/ redirect 6 次拒 / 持續滴流 body（每秒 1 byte）→ 該來源在 30 秒記 deadline、**健康來源的結果在 60 秒內送出** / **慢 headers**（假 server 送完合法 status line 後，在**同一行 header 內每 0.5 秒滴 1 byte、不送換行**——避開 http.client 的 100 行上限與 65536 單行上限——永不結束）→ 該來源記 deadline、輪照常在 60 秒收、worker 數仍是 4（固定）；另一條：滴流進行中、**先斷言該請求尚未返回且 worker 正在處理它**（假 server 端計數 + 模組 stderr 的「fetching」記錄），再送 bye → 1 秒內退出——這兩條測的是耗盡政策與退出，不是釋放 / 解析失敗的 200 不更新 ETag（下一次請求不帶 If-None-Match）。
5. **線 B 協定**（起真 subprocess，seq 用隨機非 1 的值）：`hello`→`ready` 回填 seq；壞 feeds.json / 版本不符 → 在 `hello` **之後**收到帶正確 seq 的 `fail`，之前 stdout 無任何行；seq 不對的輸入被丟；`up`→ 收到 `msg op=list` 與 `publish news.fetched`（count 一致）；抓取中送 `refresh` 兩次 → 本輪結束後只多跑一輪；**HTTP 卡在閘門時**送 `bye` → `done` 是最後一行、process 1 秒內退出、無孫 process；stdin EOF 同樣 1 秒內退出；`done` 之後 stdout 沒有任何行；**writer 被閘門暫停時**送 `bye` → 結果與 bye 同時到達，done 仍是最後一行且業務訊息沒有夾在後面；stdout 不被讀取（pipe 塞滿）時送 bye → process 仍在 1 秒內退出。
5b. **worker 有界**：四個來源全部卡在閘門，連跑三輪 → `threading.active_count()` 不增長、待辦長度 ≤ 32、每輪都在 60 秒內收輪並回報 `deadline`；放開閘門後下一輪健康來源正常回來。
5c. **晚到候選不污染快取**：舊輪 worker 卡在閘門、新輪已提交 → 放開舊輪 → items / validators / first_seen 全部維持新輪的值（拔掉輪 id 檢查要紅）。
6. **前半**（happy-dom）：用假 ctx 呼叫 `mount(ctx)` → 同步呼叫過 `report('ready')`、回傳有 `unmount`；up 前按鈕 disabled 且 `send` 未被叫；up 後 click → `send({op:"refresh"})`；收 list → DOM 有 N 則；title 含 `<img onerror>` 只出現為文字（沒有 img 元素）；link 為 `javascript:` 時沒有 `<a>`；`unmount()` 後容器內沒有模組掛的節點、事件監聽已移除。另加 grep 級靜態檢查（無 innerHTML / insertAdjacentHTML / eval / Function）當縱深。
7. **本機開發驗證**（`scripts/dev-check.sh`）：起殼後**連 `/ws`**，斷言收到的 catalog 含 `id:"news"` 且宣告與 `modudock.json` 一致；再用瀏覽器載入看畫面。放在最小宣告檔與入口建好之後就先跑一次。
8. **安裝驗收**：`modudock add https://github.com/gatewen/modudock-news` 成功、重啟殼、`/ws` catalog 含 news、畫面上有新聞。

## 9. 明確不做（v1）

- 全文抓取、圖片、關鍵字搜尋、使用者自訂來源 UI、持久化（重啟殼從零抓）、通知。

## 10. 開發流程

- 殼只認真目錄（§2.11），所以 **git 工作副本本身就放在殼掃的目錄裡**：repo 在 `/Users/gatewenlee/Code/modudock-modules/news`（目錄名 = id），Codex 的 cwd 就是它。
- 本機看畫面：在 `modudock/shell` 跑 `go run ./cmd/modudock -modules /Users/gatewenlee/Code/modudock-modules`（前端用執行檔 embed 的那份，2026-09-21 已重建）；開工前先照 §8.7 驗 catalog 有 `news`。
- Codex 逐塊交付（解析 → HTTP → 協定 → 前半 → 測試），每塊 Claude 審；Codex 每塊先跑自己的 unittest 附結果。
- 推 GitHub 由用戶做；推完跑 §8.8 安裝驗收。

## 11. 已知限制（刻意不修，README 要寫）

- 不防 DNS rebinding（解析與連線是兩次查詢）。
- worker 可能被慢 headers / 慢 body / 卡住的 DNS 佔住且無法回收；四條全佔住時新聞停止更新直到連線自己結束，殼看到的是每輪 `deadline` 錯誤。
- 不做持久化：殼重啟、模組重載都從零抓。

---

## 12. v0.2 分類（jev）— 增補規格

- 狀態：**已實作、已驗收**（2026-09-22；三塊各審一次，第 2 塊退回一次改補送預留、request 格式因真 API 實測改過一次；真實端到端 200 則 other 僅 2）
- 角色：cx-mod（Codex，wE:p2）開發；cc-mod（Claude，wE:p1）審核；門檻同本文開頭——只收中高：抓不到 / 假綠 / 安全洞 / 違反殼協定 / 破壞 v0.1 既有保證
- 依據：`~/Code/jevmodel/docs/jev-application-guide.md` §0、§2、§7（由 claude-jevmodel 摘要，2026-09-22）
- 本節**覆寫**前面章節的地方都明寫；沒寫到的 v0.1 規則全部維持。

### 12.1 一句話

每則新聞多一個 `category` 欄位，由 TypeSafe AI 的 jev 決策模型（雲端 HTTPS API）分類；前半多一個類別篩選。**沒有 API key 或分類失敗時，模組行為與 v0.1 完全相同**（新聞照列、只是沒類別）。

### 12.2 類別（固定，模組內寫死）

| id | 顯示 | criteria（給 jev 的邊界描述，繁中） |
|---|---|---|
| `politics` | 政治 | 台灣或各國政府、選舉、政黨、法案、外交 |
| `finance` | 財經 | 股匯市、經濟數據、企業財報與併購、房市、產業景氣（科技公司的財報歸這裡） |
| `tech` | 科技 | 產品、技術、AI、半導體技術本身、網路服務（不含財報） |
| `world` | 國際 | 國外的社會事件、戰爭、災難、國際組織（外交歸政治） |
| `society` | 社會 | 台灣的治安、司法案件、事故、災害、公共安全 |
| `life` | 生活 | 健康、醫療、教育、消費、旅遊、天氣、交通 |
| `sports` | 體育 | 各項運動賽事、球員、賽果 |
| `entertainment` | 娛樂 | 影視、音樂、藝人、遊戲、綜藝 |
| `other` | 其他 | 以上皆非 |

- `other` 是**棄權選項，必須存在**（jev 沒有棄權選項會硬選並給高機率）。
- criteria 文字是模組原始碼的一部分（`back/classify.py`），改 criteria = 改版本。
- 前半顯示用中文，線 B 與 API 一律用 id。

### 12.3 資料與欄位（覆寫 §5.6）

- 每則 item 多一個 `category`：**字串**，值是 12.2 的 id 之一或空字串 `""`（= 尚未分類 / 分類關閉 / 分類失敗）。**永遠出現**，前半不用猜。
- `list` 的 body 多一個 `classify`：`{"enabled": bool, "pending": int}`。`enabled` = 這個 process 有 key 且沒被永久關閉；`pending` = 本次送出的 items 中 `category == ""` 且 `enabled` 的數量。
- 分類快取：`OrderedDict(dedup_key → category)`，**最多 4000 個 key**，超過淘汰最早進入的；只存成功的分類結果，不存 `""`。**分類快取由協調者擁有**（同 items 快取的所有權規則 §5.3），worker / classifier 執行緒只回候選。
- 大小守衛 §5.7 不變（900 KB），但滿欄位測試（§8.3）要把 `category` 用最長 id `entertainment` 一起算。

### 12.4 Key 與開關

- 後半啟動時讀環境變數 **`TYPESAFE_API_KEY`**（殼 `proc.go` 用 `os.Environ()` 起後半，殼的環境會繼承下來）。**不寫進任何檔案、不進 log、不進線 B。**
- 沒有 key → `enabled: false`、stderr 一行 `classify: disabled (no TYPESAFE_API_KEY)`，之後**不再嘗試**、不建 classifier 執行緒。
- 有 key 但 API 回 **401 / 403** → 記 stderr、**永久關閉**（`enabled` 轉 false，本 process 內不再打）。
- 其他失敗（逾時、429、5xx、格式壞）→ 本輪剩餘不分類、記 stderr、**下一輪再試**（不在同一輪內重試；429 多等一輪也算退避）。
- `--allow-host` 與 §5.4 的私有位址 / redirect 政策**不套用**在 jev 的連線上（它是固定的公網 endpoint，不跟 redirect：3xx 視為失敗）。

### 12.5 呼叫 jev（`back/classify.py`）

- `POST https://api.typesafe.ai/v1/systemone`，`Authorization: Bearer <key>`，`Content-Type: application/json`，`User-Agent` 同 §5.4。**model 固定 `jev-1.13.0`**，不用 `jev-latest`。
- 純標準庫 `urllib.request` + 同 `fetch.py` 的 SSL context 建法（含 CA fallback；**無 CA 一樣拒絕連線、不關驗證**，錯誤與 §11 相同語意）。
- **批次**：一次請求最多 **20 則**，且 `sum(len(title)+len(summary))` ≤ **8000 字**（先到者為準）。state 是**物件** `{"news_0": {"title", "summary"}, …, "news_{N-1}": …}`；questions 是 `item_0 … item_{N-1}`，每題 `type:"choice"`、同一份 `criteria`，但 **`instructions` 每題不同、必須點名那一則**：`"news_n 這則新聞屬於哪一類？"`。**只送 title 與 summary**，不送 link / source / 全文。
  - 2026-09-22 實測教訓：原本每題共用同一句 instructions（「item_n 對應 state 中 i 為 n」）→ jev 分不出哪題問哪則，200 則有 196 則回 `other`（p≈0.5–0.65）；改成每題點名後同一批 20 則全部正確落類、p 多在 0.9 以上、延遲 0.76 秒。
  - `other` 的 criteria 用「以上皆非」，**不要**寫「資訊不足無法判斷」（會把模型往棄權推）；instructions 也不要加「資訊不足選 other」。§12.2 表格的 other 一列以此為準。
- 回應驗證（全部嚴格，任何一條不過整批當失敗、不採納半批）：HTTP 200；JSON 物件；`answers` 是物件；每個 `item_n` 有 `choice`（字串、在 12.2 id 內）與 `probabilities`（物件，值是 0–1 的數）。**回應 ≤ 1 MB**，超過視為失敗。
- **閾值**：`p_max = max(probabilities.values())`；`p_max < 0.35` → 改記 `other`。閾值是常數，測試要覆蓋 0.34 / 0.35 兩側。
- 逾時：**單次請求 15 秒**（connect + read 各自）；**每輪分類總預算 60 秒**（由 classifier 自己看時鐘，超過就不再發下一批，剩餘留給下一輪）。
- 一條 daemon 執行緒 `news-classify`，一次一個請求，序列進行。它跟 fetch worker 一樣**不可回收**：卡住時 §11 的耗盡政策成立（分類停擺、新聞照更新）。

### 12.6 時序（覆寫 §5.3 的輪結束）

1. 輪結束 → 協調者照 v0.1 `_emit`：items 帶快取裡已有的 `category`（沒有就 `""`），照常 `publish news.fetched`。**列表不等分類。**
2. `_emit` 之後，協調者把「`category == ""` 且 enabled」的 `(dedup_key, title, summary)` 交給 classifier（有界佇列，長度 200；佇列滿就丟、不阻塞協調者）。**同一個 key 已在佇列或處理中就不重送。**
3. classifier 每批回傳候選 `ClassifyResult(keys → category)`，走**同一個** `results` deque 給協調者（協調者的 `_accept` 分辨型別）。**分類結果不看輪 id**（category 是 key 的屬性，不是輪的屬性），永遠提交到分類快取。
4. 協調者提交後，若**目前不在抓取中**（`active == False`）且本次有任何 key 對應到最近一次送出的 items → 重送一次 `msg op=list`（同一份 items、只補 `category`、`classify.pending` 更新、`at` 不變）；**不重送 `publish`**（`news.fetched` 只代表抓到新聞）。若正在抓取中 → 不重送，下一輪 `_emit` 自然帶上。
5. 一輪內 classifier 可能回多批，每批一次重送；**重送也過 §5.7 的 900 KB 守衛**。
6. `refresh` 期間分類照常；`bye` → classifier 跟 worker 同等待遇：`stop()` 不 join，1 秒退出政策不變。

### 12.7 前半（覆寫 §6）

- 工具列多一個 `<select aria-label="新聞類別">`：「全部類別」+ 12.2 的九個中文名，**選項固定、不從資料長**。
- 每則列前面加 `[類別]`（`category` 對得上 id 才顯示中文名；`""` 或不認得的值顯示 `[未分類]`）。
- 篩選 = 來源 AND 類別；重畫規則同 v0.1（`drawItems`）。
- 狀態列加 `· 未分類：N`（`classify.pending`，型別不對當 0）；`classify.enabled === false` 時改顯示 `· 分類：關閉`。
- 收到重送的 `list`（同 `at`）就照常整份重畫；篩選選值要保留（沿用 v0.1 保留來源選值的做法）。
- 其餘 v0.1 規則全部維持：`textContent`、禁 `innerHTML`、型別檢查、`unmount` 清乾淨。

### 12.8 測試（增補 §8）

後半測試一律用 **`/usr/local/bin/python3`**（python.org 3.12，CA 空）跑一次，Homebrew 版本不算數。

- 假 jev：本機 `http.server`，測試以環境變數 **`NEWS_TEST_JEV_URL`** 覆寫 endpoint（**只在 `hooks.directory` 有設時才讀**，同 `NEWS_TEST_FEEDS` 的閘門；正式路徑不讀）；key 用 `TYPESAFE_API_KEY=test`。
- 9. **classify 單元**（`tests/test_classify.py`）：
  - 請求形狀：Authorization header、model 固定、state 只有 title/summary、20 則與 8000 字兩個上限各自觸發分批（21 則→2 批；3 則各 3000 字→2 批）。
  - 回應驗證：非 200 / 非 JSON / 缺 answers / choice 不在名單 / probabilities 不是數 / 回應 > 1 MB → 整批失敗、**沒有半批採納**。
  - 閾值 0.34 → `other`、0.35 → 原 choice。
  - 401 → 永久關閉（之後不再有請求打到假 server，計數器為證）；429 / 500 / 逾時 → 本輪停、下一輪再打。
  - 60 秒預算：假 server 每批睡 X 秒，斷言預算到了不再發下一批（用可注入的 clock）。
- 10. **協調者整合**（`tests/test_scheduler.py` 增補）：
  - 一輪 → 先收到 `list`（category 全 `""`、`classify.pending == N`）與 `publish`，**之後**收到第二個 `list`（category 補上、`pending == 0`、`at` 相同）且**沒有第二個 `publish`**。
  - 快取：第二輪同樣的 items → 假 server **零請求**；新 key 才請求。
  - 4000 上限：塞 4001 個 key，最早的被淘汰（下一輪會重問）。
  - 分類進行中新一輪開始 → 分類結果照常入快取、但不重送（`active`），下一輪 `_emit` 帶上。
  - 沒 key → 沒有 classifier 執行緒（`threading.active_count()` 少一）、`classify.enabled == false`、沒有任何請求。
  - 佇列 200 上限：同 key 不重送、超過丟棄不阻塞（協調者在時限內收輪）。
  - **變異**：拔掉「不看輪 id」→ 舊輪結果被丟、測試要紅；拔掉 `active` 檢查 → 抓取中重送、要紅；拔掉回應驗證任一條 → 要紅。
- 11. **協定**（`tests/test_protocol.py` 增補）：classifier 卡在假 server（永不回應）時送 `bye` → 1 秒內退出；key **不出現在** stdout / stderr 任何一行（用一個獨特的假 key 字串 grep）。
- 12. **前半**（`front.test.mjs` 增補）：類別 select 有 10 個選項；item `category:"tech"` 顯示 `[科技]`、`""` 與 `"zzz"` 顯示 `[未分類]`；來源 AND 類別篩選；`classify.enabled:false` 顯示「分類：關閉」；重送 list 後篩選值保留。
- §8.3 滿欄位大小測試加 `category:"entertainment"`。

### 12.9 明確不做（v0.2）

- 不持久化分類快取（同 §9）。
- 不讓使用者自訂類別、不做多選 / 多標籤、不做信心值顯示。
- 不做 key 的 UI 設定；只認環境變數。
- 不重試同一輪內的失敗批次。

### 12.10 版本與交付

- `modudock.json` `version` → `0.2.0`；`provides` 不變。
- README 增：`TYPESAFE_API_KEY` 說明、資料出境提醒（標題＋摘要送到 TypeSafe AI，美國託管）、沒 key 的行為。
- cx-mod 分三塊交付，每塊附 `/usr/local/bin/python3 -m unittest -v` 與 `npm test` 結果：
  1. `back/classify.py` + `tests/test_classify.py`（§12.5、§12.8-9）
  2. 協調者接線 + 快取 + 重送（§12.3、§12.6、§12.8-10/11）
  3. 前半 + README + 版本（§12.7、§12.8-12、§12.10）
- 每塊 cc-mod 審完才進下一塊；審核發現中高問題退回，不順手改。

---

## 13. v0.3 財經分析（jev）— 增補規格

- 狀態：**已實作、已驗收**（2026-09-23；第 2 塊退回一次：佇列上限 200 < 列表 300，真實端到端抓到；瀏覽器帶 key 驗過面板與題材篩選）
- 角色：cx-mod 開發；cc-mod 審核（門檻同 §12）
- 本節覆寫前面章節的地方都明寫；沒寫到的 v0.1 / v0.2 規則全部維持。
- 問法已用真 API 驗證（2026-09-23，新財經來源 40 則 × 3 題，每批 20 則 60 題 0.66–0.74 秒；120 個答案僅 2 個 p_max < 0.35；補齊題材後「其他」10 → 1）。**改問法、選項、criteria 前必須重跑同樣的真 API 驗證**（§12.5 的教訓）。

### 13.1 一句話

類別是「財經」或「科技」的新聞，再多三個分析：**股市訊號**、**主要題材**、**對該題材的方向**。前半在類別篩選切到財經或科技時，列表上方出現分析面板（股市訊號分布、大盤／總經、題材排行，點題材可篩新聞）。

### 13.2 新來源（覆寫 §4、§5.6 的 200 則上限）

feeds.json 追加四個（2026-09-23 以模組自己的 Fetcher＋parse_feed 實測皆 ok、有摘要、無猜時間）：

| name | url |
|---|---|
| 經濟日報 證券 | `https://money.udn.com/rssfeed/news/1001/5590?ch=money` |
| 經濟日報 產業 | `https://money.udn.com/rssfeed/news/1001/5591?ch=money` |
| MoneyDJ 頭條 | `https://www.moneydj.com/KMDJ/RssCenter.aspx?svc=NR&fno=1&arg=MB010000` |
| Yahoo 台股動態 | `https://tw.stock.yahoo.com/rss?category=tw-market` |

- 共 13 個來源（仍 ≤ 32）。**合併上限 200 → 300 則**（財經來源量大，200 會把其他類別擠掉）；§5.7 的 900 KB 守衛不變，仍是最後防線。
- **分類與分析佇列上限跟著合併上限走**（覆寫 §12.6-2 的 200）：兩條佇列各為合併上限（300），由同一個常數推得，不各自寫死。2026-09-23 真實端到端發現：列表 300 則、佇列 200 → 第一輪固定有 100 則被丟、要等下一輪（10 分鐘）才分類。
- 來源之間同事件重複報導（實測 20 則裡 3–5 則標題相同）**不處理**：去重規則仍只看 link（§5.6）。

### 13.3 三個問題（固定，寫在 `back/analyze.py`）

每則一次問三題，題目 id `market_n`、`theme_n`、`dir_n`，state 格式同 §12.5（`{"news_n": {title, summary}}`），instructions 一律點名 `news_n`：

- `market`：「news_n 這則報導對股市前景呈現什麼方向的訊息？」
  | id | criteria |
  |---|---|
  | `positive` | 對股市或個股前景呈現正向訊息：上漲、利多、成長、獲利 |
  | `negative` | 對股市或個股前景呈現負向訊息：下跌、利空、衰退、虧損、下修 |
  | `mixed` | 同時呈現正反兩面 |
  | `not_market` | 內容與股市或個股前景無關 |
  | `other` | 以上皆非 |
- `theme`：「news_n 這則新聞最主要涉及哪個產業或題材？」（單選，只取主題材）
  | id | 顯示 | criteria |
  |---|---|---|
  | `foundry` | 晶圓代工 | 晶圓代工、先進製程 |
  | `ic_design` | IC 設計 | IC 設計 |
  | `memory` | 記憶體 | 記憶體（DRAM、NAND、HBM） |
  | `packaging` | 先進封裝 | 先進封裝（CoWoS 等） |
  | `semi_equip` | 半導體設備材料 | 半導體設備與材料 |
  | `ai_server` | AI 伺服器 | AI 伺服器、資料中心、雲端 |
  | `cooling` | 散熱 | 散熱 |
  | `pcb` | PCB／被動元件 | PCB、載板、被動元件 |
  | `optical` | 光通訊 | 光通訊、矽光子、海纜 |
  | `display` | 光電面板 | 光電、面板、LED |
  | `leo` | 低軌衛星 | 低軌衛星、太空 |
  | `energy` | 能源 | 能源、電力、儲能、綠能 |
  | `ev` | 電動車 | 電動車與汽車供應鏈 |
  | `financials` | 金融 | 銀行、保險、證券、金控 |
  | `property` | 營建房產 | 營建、房地產 |
  | `transport` | 航運航空 | 航運、航空、物流 |
  | `consumer_elec` | 消費電子 | 手機、PC、消費電子、品牌硬體 |
  | `petrochem` | 原物料傳產 | 石化、塑化、鋼鐵、水泥等原物料與傳產 |
  | `software` | 軟體網路 | 軟體、網路服務、電商、量子運算等新興科技 |
  | `industrial` | 工業電腦 | 工業電腦、自動化、機器人 |
  | `macro` | 大盤／總經 | 大盤、總體經濟、利率匯率、法人買賣超等不屬於單一產業 |
  | `other` | 其他 | 以上皆非 |
- `dir`：「news_n 這則新聞對它最主要涉及的產業或個股，呈現什麼方向？」
  | id | criteria |
  |---|---|
  | `bull` | 利多：對該產業或個股明確有利 |
  | `bear` | 利空：對該產業或個股明確不利 |
  | `mixed` | 正反並存 |
  | `neutral` | 以上皆非 |
- **門檻**：每題各自 `p_max < 0.35` → 改記該題的棄權值（market→`other`、theme→`other`、dir→`neutral`）。方向另有**計入門檻**：前半只在 `dir` 的 p_max ≥ 0.6 時把它算進利多／利空（後半送 `dir_p`，見 13.4）。
- 回應驗證同 §12.5（整批嚴格、不採納半批、1 MB 上限、probabilities 0–1 且不含布林／NaN）；每則三題都要齊。

### 13.4 資料與欄位

- 每則 item 多一個 `analysis`：**永遠出現**；未分析 / 不適用 / 關閉時是 `null`，否則 `{"market": id, "theme": id, "dir": id, "dir_p": number}`（`dir_p` 四捨五入到小數兩位）。
- **只分析 `category ∈ {"finance", "tech"}` 的 item**；其他類別永遠 `null`。
- `list` body 多 `analysis: {"pending": int}`：本次送出 items 中 category 為 finance / tech 且 `analysis == null` 且 enabled 的數量。enabled 與 `classify.enabled` 同一個開關（同一把 key、同一個 401 永久關閉）。
- 分析快取：`OrderedDict(dedup_key → analysis)`，上限 4000、FIFO、只存成功結果、協調者擁有（同 §12.3）。
- **大小預留（覆寫 §12 的預留規則，一般化）**：量測時，每則 item 預留「它尚未填上的欄位將來可能長到的最大 bytes」——`category == ""` 預留最長類別 id；`analysis == null` 且 category ∈ {"", finance, tech} 預留最長可能的 analysis 物件（各欄最長 id、`dir_p` 用 `0.99`）。目標不變：**補送的 item 數永遠等於第一次列表的 item 數**。

### 13.5 時序（增補 §12.6）

- 分類結果提交後，若某 key 的 category 是 finance / tech、分析快取沒有、也不在分析 in-flight 中 → 排入分析。`_emit` 時快取裡已經有 category（finance / tech）但沒 analysis 的也排入。
- **分析與分類用同一條 `news-classify` 執行緒、同一個 HTTP client 設定**（逾時 15 秒、無 redirect、CA 規則、key 不進 log）；工作項分成「分類」與「分析」兩種，分類優先。分析批次上限 20 則（= 60 題）且 8000 字，每輪預算與分類**共用 60 秒**。
- 分析失敗語意同 §12.4（401/403 永久關閉兩者；其他失敗本輪停、下一輪再試；in-flight 一定釋放）。
- 分析結果提交後的補送規則同 §12.6-4（not active 且有可見 key 才補送；不 publish；at 不變）。
- 分析結果**不看輪 id**（同分類）。

### 13.6 前半（增補 §12.7）

- **分析面板**：只在類別篩選 = 財經或科技時出現，放在工具列與清單之間；範圍 = 目前來源篩選 + 類別篩選下的 items（**不含**題材篩選，否則排行會塌成一項）。內容（全部 `textContent`）：
  1. `樣本：N 則・K 個來源・分析中 P`；N < 10 時加 `・樣本少，僅供參考`。
  2. `股市訊號：正面 a・負面 b・正反 c・無關 d・未明 e`（`other` 與 `analysis == null` 都算未明）。
  3. `大盤／總經：n 則（利多 x・利空 y）`。
  4. **題材排行**：排除 `macro` 與 `other`，依篇數由多到少、同數依 13.3 表格順序，最多 10 個；每項是一個按鈕 `記憶體 2（▲1 ▼1）`（▲＝利多且 dir_p ≥ 0.6，▼＝利空且 dir_p ≥ 0.6，其他不顯示箭頭數）。沒有任何題材時顯示 `題材：尚無`。
  5. 一行小字：`篇數是報導數，同一事件多家報導會重複計算。`
- **題材篩選**：點題材按鈕 → 清單只顯示該題材（與來源、類別 AND）；面板上方出現 `題材：記憶體 ✕`，點 ✕ 或再點同一題材取消。類別切到非財經／科技時題材篩選自動清除。補送 list 時題材篩選保留。
- 清單列：已分析的 item 前綴改成 `[財經｜記憶體 ▲]`（題材顯示名；方向只有 bull/bear 且 dir_p ≥ 0.6 才加 ▲／▼）；theme 是 `macro` 顯示 `大盤／總經`、`other` 只顯示類別。其他維持 v0.2。
- 所有欄位型別檢查：`analysis` 不是物件、id 對不上表格、`dir_p` 不是 0–1 的數 → 當成未分析，不炸。

### 13.7 測試（增補 §8、§12.8）

後半一律 `/usr/local/bin/python3`。

- `tests/test_analyze.py`：請求形狀（三題 id、每題點名 news_n、三題 instructions 彼此不同、criteria 與表格一致）、批次 20 則上限與 8000 字、三題任一缺漏或不合法 → 整批失敗、三個門檻各自兩側（0.34 / 0.35）、`dir_p` 四捨五入、401 關閉、429 / 500 / 逾時本輪停。
- 協調者整合：finance / tech 的 item 分類後被分析並補送、其他類別永遠 `null` 且沒有分析請求；分類優先於分析；分析快取命中零請求；分析失敗釋放 in-flight 下一輪重試；401 同時關閉分類與分析；**大小預留邊界**：構造「全部未填時剛好 ≤ 900 KB、全部填滿最長值後 > 900 KB」→ 第一次與補送 item 數相等（拔預留要紅）；300 則上限。
- 協定：分析卡在永不回應的假 server 時 bye → 1 秒退出；key 不進 stdout / stderr。
- 前半：面板只在財經 / 科技出現、各計數正確、未明計算、題材排行排序與上限 10、▲▼ 只算 dir_p ≥ 0.6、點題材篩選與 ✕ 取消、切類別自動清除、補送後保留、N < 10 的「樣本少」、非法 analysis 不炸、XSS（題材名來自前半常數，但 title 仍要驗 textContent）。
- 變異至少：拔「只分析 finance / tech」、拔分析預留、拔 dir_p 計入門檻，各要紅。

### 13.8 明確不做（v0.3）

- 同事件去重、來源權重、跨日趨勢、通知、新 publish 主題。
- 多題材（多標籤）；個股辨識；事件型態 / 時間確定性。
- 政治立場分析。

### 13.9 版本與交付

- `modudock.json` `version` → `0.3.0`；README 補「財經分析（v0.3）」一節（面板怎麼讀、篇數不是事件數、題材清單是人維護的固定表、新增來源）。
- 三塊交付，每塊附 `/usr/local/bin/python3 -m unittest` 與 `npm test`：
  1. feeds.json 四個來源 + 300 上限 + `back/analyze.py` + `tests/test_analyze.py`
  2. 協調者接線 + 分析快取 + 一般化大小預留 + 整合 / 協定測試
  3. 前半面板 + 題材篩選 + README + 版本

---

## 14. v0.3.1 前半視覺設計 — 增補規格

- 狀態：**已實作、已驗收**（2026-09-23；深淺主題截圖審過，退回一次修 hidden 被 display 蓋掉、左緣對齊、題材名縮排；起因：用戶看了 v0.3 畫面說「很難看，要有一點設計」）
- 角色：cc-mod 設計、審核（深淺兩種主題都要截圖看）；cx-mod 實作
- **只改呈現**：§6、§12.7、§13.6 的資料規則、篩選邏輯、計數定義、textContent／型別檢查全部不變。

### 14.1 設計主張

- **對象**：看台股的個人投資者，在殼的 main 格子裡（常見寬度 480–900px）掃一眼今天的新聞與盤勢。
- **唯一的重點**：股市訊號做成一條**分佈長條**，顏色用**台股慣例：紅漲綠跌**（正面＝紅、負面＝綠）。這是這個面板和一般儀表板不一樣的地方；其他元素全部安靜、不搶。
- **資訊結構靠排版，不靠框線**：不做卡片陣列、不加陰影、不用漸層；面板是一整塊淡底色區域。
- **數字用等寬數字**（`font-variant-numeric: tabular-nums`），計數靠右對齊，好比較。
- **文字精簡**：時間顯示本地 `HH:mm 更新`，不顯示 ISO 字串；失敗來源與未分類數只在 > 0 時出現。

### 14.2 顏色 token（全部掛在模組根元素 `.nw` 上）

優先吃殼的主題變數（`RUNTIME-PROTOCOL` 主題第一、二塊已提供），fallback 是殼淺色值：

| token | 值 |
|---|---|
| `--nw-bg` | `var(--md-bg, #ffffff)` |
| `--nw-fg` | `var(--md-fg, #242424)` |
| `--nw-muted` | `var(--md-fg-muted, #616161)` |
| `--nw-line` | `var(--md-border, #c7c7c7)` |
| `--nw-surface` | `var(--md-surface, #f3f3f3)` |
| `--nw-accent` | `var(--md-accent, #005fb8)` |
| `--nw-focus` | `var(--md-focus, #005fb8)` |
| `--nw-up` | 淺 `#c8102e`；深 `#ff6b6b`（漲／利多／正面） |
| `--nw-down` | 淺 `#0f7b3f`；深 `#4fd18b`（跌／利空／負面） |
| `--nw-mixed` | 淺 `#b7791f`；深 `#f0b429`（正反並存） |
| `--nw-idle` | `color-mix(in srgb, var(--nw-muted) 45%, transparent)`（無關／未明） |

深色值用 `:root[data-theme="dark"] .nw { … }` 覆寫（殼執行期把 `data-theme` 寫在 `<html>`，見殼 `web/index.html` 註解）。`--nw-up`、`--nw-down`、`--nw-mixed` 在兩個主題下對各自背景的對比度都要 ≥ 3:1（圖形元素）；`--nw-idle` 刻意低調、**不受此限**（它代表「沒有訊號」，數字與文字標籤另外提供資訊；cx-mod 量到淺色約 1.93:1，實際截圖可辨識，接受）。

### 14.3 字

- 字族：`"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif`（不載入網路字型；模組 public 目錄只放自己的檔）。
- 字級：基準 14px；新聞標題 15px／500；面板數字 20px／600（只用在股市訊號的四個數）；次要資訊 12px `--nw-muted`；行高 1.5，標題 1.4。

### 14.4 版面

```
┌ 工具列（一行，窄時換行）─────────────────────────────────┐
│ [↻ 重新整理] [全部來源 ▾] [財經 ▾]                16:51 更新 │
└──────────────────────────────────────────────────────────┘
┌ 面板（--nw-surface 底，圓角 8px，內距 14px 16px）────────┐
│ 137 則，10 個來源                                 分析中 0 │
│                                                          │
│ 股市訊號                                                  │
│ ██████████████████████████▓▓▓▓░░░░░░░░██                 │  ← 高 10px，四段：正面/正反/無關+未明/負面
│ 95 正面    14 正反    19 無關    9 負面                   │  ← 數字 20px，色點對應長條
│                                                          │
│ 大盤／總經  61 則      利多 44   利空 0                   │
│                                                          │
│ 題材                                         （點選篩選）  │
│ 軟體網路    ████████░░██        10                        │  ← 每列是一個按鈕
│ 金融        ██░░░░░░             8                        │
│ …（最多 10 列；容器 ≥ 560px 時排兩欄）                     │
│                                                          │
│ 篇數是報導數，同一事件多家報導會重複計算。                  │
└──────────────────────────────────────────────────────────┘
  已篩選：記憶體  [清除]                                       ← 有題材篩選時才出現，在面板下、清單上
┌ 清單 ────────────────────────────────────────────────────┐
│ 玉山金併三商美邦人壽 公平會放行                              │  ← 標題 15px 連結，第一行
│ 金融 ▲   財經   自由時報即時   16:44                        │  ← 第二行 12px：題材籤（有方向時上色）、類別、來源、時間
│──────────────────────────────────────────────────────────│  ← 列與列之間 1px --nw-line
```

- 全部靠左對齊；計數靠右、等寬數字。
- **同一條左緣**：工具列、面板內容、題材篩選列、清單列的文字左緣必須在同一個 x 座標（模組根留外距，面板用內距，工具列／篩選列／清單列用相同的 inline 內距對齊面板內容）；右緣同理（「更新時間」不得貼到捲軸）。題材列的名稱與「題材」小標題左緣對齊，不額外縮排。
- **股市訊號長條**：四段寬度 = 各數量 / 總數（總數為 0 時整條 `--nw-idle`）；段順序固定 正面 → 正反 → 無關（含未明） → 負面，讓紅綠分居兩端。長條有 `role="img"` 與完整 `aria-label`（例：「正面 95、正反 14、無關 19、負面 9」）。
- **題材列**：名稱（左）、小長條（中，寬度 = 該題材篇數 / 排行第一的篇數；內部依 ▲ 紅、▼ 綠、其餘 `--nw-idle` 分段）、篇數（右）。被選中的列：左側 3px `--nw-accent` 條 + 名稱粗體 + `aria-pressed="true"`。
- **清單列**：標題（連結；非 http(s) 時純文字）在上，meta 在下。題材籤只在 analysis 有效且 theme 非 other 時出現；方向 ▲ 用 `--nw-up`、▼ 用 `--nw-down`；`macro` 顯示「大盤」。未分類顯示「未分類」灰字。摘要仍放在標題的 `title` 屬性。
- 非財經／科技類別時沒有面板，清單照同樣的兩行樣式。
- 空狀態：尚未收到列表時清單區顯示「正在取得新聞」；篩選後 0 則顯示「這個條件下沒有新聞」並附一個「清除篩選」按鈕（清來源、類別、題材）。

### 14.5 互動與可及性

- 所有可點元素是 `<button>` / `<a>` / `<select>`；`:focus-visible` 2px `--nw-focus` 外框。
- 題材列 hover：背景 `color-mix(in srgb, var(--nw-fg) 6%, transparent)`。
- 動態只有一個：補送更新時長條寬度 `transition: width 240ms ease`；`prefers-reduced-motion: reduce` 時關閉。
- 窄容器（< 420px）：工具列換行、題材列隱藏小長條只留名稱與數字。

### 14.6 實作規則

- 樣式是 `front/front.js` 內一段 CSS 字串，mount 時建 `<style>` 放進模組根 `<section class="nw">` 裡（不動 `document.head`，unmount 隨根一起移除）；**所有選擇器以 `.nw` 開頭**，不得影響殼或其他模組。
- 模組根設 `container-type: inline-size`，用 `@container` 判斷 560px／420px。
- 不動殼給的容器本身（不設它的 style、hidden、class）。
- 仍然禁 `innerHTML`；CSS 字串只能用 `textContent` 塞進 `<style>`。

### 14.7 測試

- 既有前半測試的行為斷言維持（可能要改選擇器，不能改語意）。
- 新增：`<style>` 在根元素內且 unmount 後消失；所有 CSS 規則選擇器以 `.nw` 開頭（解析 CSS 字串檢查）；長條四段寬度比例與 aria-label；總數 0 的長條；題材列小長條寬度相對第一名；時間顯示 `HH:mm 更新`；失敗來源 0 時不顯示、> 0 時顯示；0 則時的空狀態與「清除篩選」會清三個篩選。
- `modudock.json` version → `0.3.1`。

---

## 15. v0.3.2 主題判斷改用標準 CSS — 增補規格

- 狀態：**已實作、已驗收**（2026-09-24；真殼 Chromium 量到淺 rgb(200,16,46)／深 rgb(255,107,107)，data-topic 點選篩選正常；依 claude-modudock 建議：殼承諾的只有九個 `--md-*` 代幣，`<html data-theme>` 是殼的內部實作、不是契約）
- **覆寫 §14.2**：刪除 `:root[data-theme="dark"] .nw { … }` 那段；三個語意色改用標準 `light-dark()`，依殼設在 `:root` 的 `color-scheme` 自動切換：
  - `--nw-up: light-dark(#c8102e, #ff6b6b)`
  - `--nw-down: light-dark(#0f7b3f, #4fd18b)`
  - `--nw-mixed: light-dark(#b7791f, #f0b429)`
- 模組 CSS **不得**再出現 `data-theme`（選擇器或屬性都不行）。
- 題材按鈕的 `data-theme` 屬性改名為 **`data-topic`**（避免和殼的主題屬性同名）。
- 驗收：真殼 Chromium 上切淺／深兩種主題，量 `.nw` 內正面長條段的 computed `background-color` 分別是 `rgb(200, 16, 46)` 與 `rgb(255, 107, 107)`。
- `modudock.json` version → `0.3.2`。

---

## 16. v0.4 同事件合併（jev）— 增補規格

- 狀態：**已實作、已驗收**（2026-09-24；滿額真實端到端第一輪 events.pending 歸 0，300 則 → 232 事件；真殼深淺主題截圖審過摺疊與面板）
- 角色：cx-mod 開發；cc-mod 審核
- 起因：v0.3 面板的「篇數是報導數」讓大盤／熱門題材被同一事件灌爆（實測一則被 3 家轉載、台股收盤行情被報導 10+ 次）。

### 16.1 實驗依據（2026-09-24，300 則快照）

- 標題相似度 = 去空白標點、轉小寫後的**字元雙字（bigram）重疊係數** `|A∩B| / min(|A|,|B|)`，只比 `published` 相差 ≤ 36 小時的配對。
- ≥ 0.9：23 對，全是轉載／同標題（Yahoo 轉經濟日報等）→ **直接視為同事件，不問 jev**。
- 0.2–0.9：314 對 → 問 jev。真 API 兩組各 40 對：高相似組 40/40 判 same（人工看全對）；**困難負例組**（共享「台積電／台股／川普／AI」但不同事）30 same／10 related——same 裡「同一天台股盤中／收盤」、「習近平訪美兩篇」屬同事件，判對；Cadence vs Synopsys、AI CPU vs 矽晶圓漲價判 related，判對；唯一可疑是「跌 160 點 vs 跌 132 點」p=0.41。→ **採納門檻 p ≥ 0.8**。
- < 0.2：不比。

### 16.2 問法（固定，寫在 `back/events.py`）

- state 同 §12.5（`{"news_n": {title, summary}}`）；每題 `same_k`：
  - instructions：`news_a 與 news_b 是否在報導同一個事件（同一件事、同一個發布或同一段行情）？`（a、b 為 state 編號）
  - criteria：`same`「是同一個事件」／`related`「主題相關但不是同一個事件」／`different`「不同事件」
- 採納：choice == `same` 且 p_max ≥ **0.8** → 同事件；其他一律「不同」。
- 批次：一次請求 state ≤ 20 則、題數 ≤ 40、字數 ≤ 8000（同 §12.5 的計法，只算 state 內的字）；其餘驗證、逾時、401 規則同 §12.4–12.5。

### 16.3 分群

- **所有類別**都分群（清單摺疊需要）；配對判斷結果快取 `OrderedDict(frozenset{keyA,keyB} → bool)`，上限 20000、FIFO、協調者擁有。
- 用 union-find 把「同事件」配對連起來；**防串連過長**：一群內任一則與代表的 `published` 相差 > 24 小時就不併入（該配對視為不同）。
- **代表**：群內 `published` 最早者；同時間依 feeds.json 順序。
- `event` id：代表的 dedup_key 取 `sha1` 前 12 個 hex 字元（固定長度，方便大小預留）。
- 尚未判斷完的候選配對存在時，item 的 `event` 用**目前已知**的群（可能之後被併大）；單獨一則的群 `event` 就是自己的 id。

### 16.4 資料與欄位

- 每則 item 多 `event`：12 字元字串，**永遠出現**（jev 關閉時＝自己的 id，只靠 ≥ 0.9 的自動合併）。
- 每則 item 多 `event_size`：整數，所屬群的則數（只算本次送出的 items）。
- body 多 `events: {"pending": int}`＝尚未判斷的候選配對數（關閉時 0）。
- 大小預留：`event` 固定長度不需預留；`event_size` 預留到 3 位數。

### 16.5 時序（增補 §13.5）

- `_emit` 時協調者算候選配對（≥ 0.2 且 ≤ 36h，排除已快取）；≥ 0.9 直接寫入快取為 true。
- 其餘排入**第三種工作**「配對」，優先順序 分類 > 分析 > 配對；共用同一條執行緒、同一個 enabled、同一個每輪 60 秒預算；有界佇列上限 = 合併上限 × 2（600 對），超過丟棄、下一輪再排。（優先序已由 §18.30 取代：分類 > 配對 > 話題 > 分析 > 基調。）
- 配對結果提交後重算群；若 not active 且有任何可見 item 的 `event` / `event_size` 改變 → 補送（同 §12.6-4，不 publish）。另外 **`events.pending` 由 > 0 變成 0 時也補送一次**（即使群沒變），否則前半的「合併中」會停在舊值（cx-mod 用 300 則快照測出，2026-09-24）。

### 16.6 前半（增補 §14）

- **清單摺疊**：同一 `event` 只顯示代表那一則；meta 行尾加一個按鈕 `另 N 則報導`（N = event_size − 1，N = 0 不顯示），點開在下方縮排列出其他報導（標題連結＋來源＋時間，12px），再點收合。展開狀態在補送後保留（依 event id）。
- 篩選（來源／類別／題材）先作用在個別 item，再摺疊：一群中只要有一則符合就顯示該群，代表改為**符合條件者中最早的一則**。
- **面板改算事件**：樣本行改成 `N 個事件（M 則報導），K 個來源`；股市訊號、大盤／總經、題材排行全部以**事件**為單位計數，事件的 analysis 取代表（符合條件者中最早且已分析的一則）；說明小字改成 `同一事件多家報導只算一次。`
- 狀態：`events.pending > 0` 時樣本行尾加 `・合併中 X`。

### 16.7 測試

- `tests/test_events.py`：bigram 重疊係數（去標點、大小寫、空標題）；36h 窗；≥0.9 不送 jev；請求形狀（same_k 點名兩則、state 去重、20 則／40 題／8000 字三個上限各自觸發分批）；0.79 / 0.8 門檻兩側；related / different 都算不同；union-find 串連與 24h 防串連；代表挑選與 tie-break；event id 長度與穩定性。
- 協調者：配對優先序最低；配對快取命中零請求；補送只在 event / event_size 改變時；401 關閉三者；佇列 600 上限；滿額 300 則端到端（真資料快照 fixture）第一輪內 `events.pending` 歸 0 或因預算留到下一輪而正確遞減。（優先序已由 §18.30 取代：分類 > 配對 > 話題 > 分析 > 基調。）
- 前半：摺疊與展開、展開狀態補送後保留、篩選後的代表挑選、面板以事件計數、`另 N 則報導` 的 N、合併中顯示。
- 變異：拔 24h 防串連、拔 0.8 門檻、拔「≥0.9 不問」各要紅。

### 16.8 版本

- `modudock.json` → `0.4.0`；README 補「同事件合併」一節（怎麼判斷、門檻、會有少量誤合併／漏合併）。
- 三塊交付：① `back/events.py`＋單元測試 ② 協調者接線＋整合測試 ③ 前半摺疊與面板改算事件＋README＋版本。

---

## 17. v0.5 國際局勢分析（jev）— 增補規格

- 狀態：**已實作、已驗收**（2026-09-24；滿額真實端到端第一輪全部完成，world 15 則全分析；真殼深淺主題截圖審過國際面板與地區篩選）
- 角色：cx-mod 開發；cc-mod 審核
- 實驗依據（2026-09-24，300 則快照分類後）：
  - **國際**（14 則，2 題 28 題 0.77 秒）：走向判得準（北韓試射火箭炮、巴基斯坦空襲阿富汗、俄佔烏城 → escalation 0.84–1.00；加州小鎮出售、溫斯坦判刑、新加坡巴士罰款 → not_conflict 0.92–1.00）；地區大致正確（「AI 巨頭 聯合國討論」判 americas 屬可接受誤差）。→ **做**。
  - 生活「民生負擔」：20 則 18 則 not_cost → 不做。
  - 政治「政策階段」：20 則 14 則 not_policy（選舉期新聞以選戰為主）→ 不做。
  - 「次要題材」（多標籤）：20 則僅 2 則過 p≥0.6，其一牽強 → 不做（待用戶決定）。
- **改問法、選項、criteria 前必須重跑真 API 驗證。**

### 17.1 問題（固定，加在 `back/analyze.py`，與財經題組並列）

只分析 `category == "world"` 的 item；每則兩題，題目 id `trend_n`、`region_n`，state 與點名規則同 §13.3：

- `trend`：「news_n 這則報導描述的國際衝突或緊張情勢，走向是什麼？」
  | id | 顯示 | criteria |
  |---|---|---|
  | `escalation` | 升級 | 升級：衝突、對峙、制裁或威脅加劇 |
  | `deescalation` | 緩和 | 緩和：停火、談判進展、關係改善 |
  | `stalemate` | 僵持 | 僵持：持續對峙但沒有明顯變化 |
  | `not_conflict` | 無關 | 內容不涉及衝突或緊張情勢 |
  | `other` | 未明 | 以上皆非 |
- `region`：「news_n 這則報導主要涉及哪個地區？」
  | id | 顯示 | criteria |
  |---|---|---|
  | `us_china` | 美中 | 美中關係 |
  | `asia_pacific` | 亞太 | 亞太（不含美中雙邊） |
  | `middle_east` | 中東 | 中東 |
  | `europe_russia` | 歐洲／俄烏 | 歐洲與俄烏 |
  | `americas` | 美洲 | 美洲 |
  | `other` | 其他 | 以上皆非 |
- 門檻：p_max < 0.35 → 該題棄權值（trend→`other`、region→`other`）。
- 批次上限：一次請求 ≤ 20 則；國際與財經題組**分開請求**（不混在同一個 state），各自走 §13.3 的驗證。

### 17.2 資料

- `analysis` 形狀依類別：finance / tech 維持 `{market, theme, dir, dir_p}`；world 為 `{"kind": "world", "trend": id, "region": id}`；財經物件也補 `"kind": "finance"`（前半靠 kind 分辨，舊資料沒有 kind 視為 finance）。
- `analysis.pending` 計入 world。
- 大小預留：`analysis == null` 且 category ∈ {"", finance, tech, world} 預留兩種形狀中較長者。
- 快取、補送、401、預算、優先序（分類 > 分析（財經與國際同級）> 配對）全部沿用 §13.5。（優先序已由 §18.30 取代：分類 > 配對 > 話題 > 分析 > 基調。）

### 17.3 前半

- 類別篩選 = 國際時顯示**國際面板**（取代財經面板的位置；樣式、token、左緣規則同 §14）：
  1. 樣本行同 §16.6（`N 個事件（M 則報導），K 個來源・分析中 P`）。
  2. `局勢走向` 四段長條，順序 升級 → 僵持 → 緩和 → 無關＋未明；顏色：升級 `var(--md-danger, #b42318)`、僵持 `--nw-mixed`、緩和 `--nw-accent`、無關／未明 `--nw-idle`（**不用紅漲綠跌**，國際局勢不是漲跌）。下方數字列同股市訊號。
  3. `地區`：各地區一列（名稱、小長條依升級／緩和分段、事件數），依事件數排序、隱藏 0；點選篩選（同題材篩選的互動與 `data-topic` 規則，屬性值用 `region:<id>` 以免和題材 id 撞名）。
  4. 小字同 §16.6。
- 清單列：國際新聞的籤顯示地區名＋走向（升級用 `--md-danger` 色字「升級」，緩和用 accent 色字「緩和」，僵持／無關不加字）。
- 以事件計數，規則同 §16.6。

### 17.4 測試、版本

- `tests/test_analyze.py` 增補國際題組：請求形狀、兩題點名、門檻兩側、kind 欄位；財經與國際分開請求。
- 協調者：world item 被分析且補送；非 world／finance／tech 永遠 null；預留兩種形狀取長者（變異要紅）。
- 前半：國際面板只在國際類別出現、四段順序與顏色 token、地區排序與篩選、`region:` 前綴、舊 analysis 無 kind 仍當財經、非法 world analysis 不炸。
- `modudock.json` → `0.5.0`；README 補「國際局勢分析」。
- 兩塊交付：① 後半（題組、kind、接線、預留、測試）② 前半（面板、籤、測試、README、版本）。

## 18. v0.6 自主進化 — 增補規格

> 2026-09-25 起的 8 小時自主進化（cc-mod 審核、cx-mod 開發）。每輪 1～3 件、有數據才收；分支 `evolve/2026-09-25`。

### 18.1 第 1 輪

**基準（2026-09-25 18:44，滿額 300 則真實跑）**：首份列表 2.1 秒；分類 pending 13.3 秒歸零；分析 pending 34.8 秒歸零；配對 40.5 秒歸零。
分類結束後分析還剩 170 則，卻用了 **34 次**補送才清完（財經與國際在佇列中交錯，每遇到另一種 kind 就切斷批次）。
報導者抓到 10 則，清單裡是 **0 則**（300 則名額純粹依時間排序，更新少的來源會整個被擠掉）。
人工標注的 120 則黃金集：分類寬鬆準確 119/120、嚴格 103/120，**本輪不改分類**。

**R1-A 分析依 kind 分批**
- 組分析批次時，以佇列頭的 kind 為準，往後掃描同一 work 的佇列，收同一 kind 的項目，直到 MAX_ITEMS 或 MAX_CHARS；不同 kind 的項目**留在佇列原位、原順序**。
- 分類優先、配對最後、共用 60 秒預算、單一執行緒、失敗語意都不變。（優先序已由 §18.30 取代：分類 > 配對 > 話題 > 分析 > 基調。）
- 驗收：單元測試以財經／國際交錯的 300 則（短文）驗證分析請求數 = ceil(財經數/20)+ceil(國際數/20)；留下的項目順序不變；真實跑的「分類歸零後的分析補送次數」大幅低於 34。

**R1-B 來源保底名額**
- `merge_items` 仍輸出最多 MAX_ITEMS_LIST 則、依時間新到舊排序；但**每個來源先保留自己最新的 min(3, 該來源則數) 則**，剩下名額再依時間由全部其餘項目遞補。
- 去重規則不變（同 dedup key 取較新的），保底以去重後歸屬的來源計算；輸出仍是確定性的。
- 驗收：單元測試（一個來源全都比其他來源舊，仍保留 3 則；保底後總數仍 ≤ 上限；來源數×3 > 上限時不得超出上限，依來源順序取）；真實跑報導者 ≥ 3 則。

**R1-C 跨日時間顯示**
- 清單時間：發布時間在使用者當地的「今天」→ `HH:mm`；否則 → `M/D HH:mm`。
- `time_guessed` 為 true 的項目時間前加「約」，元素 `title` 為「來源沒有提供發布時間，以收錄時間代替」。
- 驗收：前半測試覆蓋今天、昨天、推定時間三種；只用 textContent。

### 18.2 第 2 輪（穩定性）

第 1 輪結果：全部完成 40.5s→28.1s；分類後分析補送 34→10；報導者 0→3。

**R2-A jev 回應讀取總時限**
- `_ChoiceClient._request` 讀 body 的迴圈加總時限 `read_deadline`（預設 30 秒，以 `self.clock` 計，從送出請求前開始算）；超過即放棄該批（回 None、log 固定字串「{label}: response deadline」，不帶內容）。
- 共用設定：`shared=` 的 client 沿用同一個值。模組文件字串更新：DNS／慢速 header 仍無法回收（照實寫）。
- 驗收：本機假 server 以每 0.2 秒 1 byte 滴流回應，client 在 read_deadline（測試設 1 秒）+ 一個讀取間隔內返回 None；正常回應不受影響。

**R2-B 分析快取必須和目前類別相容**
- 分析快取命中時，若 `analysis.kind != analysis_kind(目前類別)`：視為沒有分析——從 analysis_cache 刪除、不得裝飾到列表、重新排入分析（同一輪預算規則）。
- 晚到的舊分析結果（kind 不符目前類別）同樣不收。
- 驗收：重現 cx-mod 回報的情境（finance 分析仍在、分類被淘汰後改判 world）→ 列表不帶舊分析、analysis pending 正確計入、之後得到 world 分析。

**R2-C 狀態文字不假裝在跑**
- 「分析中 N」改為「待分析 N」、「・合併中 N」改為「・待合併 N」。前半不知道後半是否仍在工作，文字只陳述數量。

### 18.3 第 3 輪（新功能：焦點）

第 2 輪結果：讀取時限、kind 相容都有變異測試保護；真實跑 28.1s。
觀察：預設「全部類別」畫面只是一長串依時間排序的清單（最上面全是自由時報最近一小時），看不出「現在最大的事」。同事件合併已經算出每個事件有幾家媒體報導，這是現成的重要性訊號。

**R3-A 焦點區**
- 位置：工具列下方、財經／國際面板上方；所有類別檢視都有，依目前的來源／類別／題材篩選計算。
- 入選：同一事件（`groupItems` 的群組）內**不同來源數 ≥ 3**；依不同來源數由多到少、同數依最新發布時間新到舊、再依事件 id；最多 5 個。沒有入選時整區 `hidden`。
- 每列：代表報導標題（連結，同清單的安全規則）＋右側「N 家媒體」按鈕。按下後：清單中該事件展開（同「另 N 則報導」的 expanded 狀態）、捲動到該列（`scrollIntoView({block: "nearest"})`）、焦點移到該列的展開按鈕。
- 標題：「焦點」，後面小字「多家媒體同時報導」。視覺沿用面板的 token、字級、間距（不另創色）；窄版（<420px）時按鈕文字縮為「N 家」。
- 無障礙：區塊 `<section aria-labelledby>`；按鈕 `aria-label="展開 N 家媒體的報導"`。
- 驗收：前半測試（門檻 3 家、排序、上限 5、篩選後重算、按鈕展開＋焦點、hidden）；真殼深淺主題截圖由 cc-mod 審。

**R3-B 只有日期的來源不顯示 00:00**
- 發布時間在當地剛好 00:00:00 → 視為只給日期：今天顯示「今天」，其他顯示 `M/D`（不附時間）。`time_guessed` 規則照舊。
- 驗收：前半測試覆蓋。

### 18.4 第 4 輪（新功能：上次之後的新增）

第 3 輪結果：焦點區上線（真殼深淺主題審過）。另發現「習近平訪美」36 則報導分散在 26 個事件——事件定義本來就窄，需要更上一層的「話題」，另案驗證中（§18.5）。

儲存規則（claude-modudock 2026-09-25）：前半可用 localStorage；key 一律 `modudock.module.news.<欄位>`；讀寫都包 try/catch，壞值當作沒有；讀寫集中在一組函式，將來搬到殼的設定檔只改一處。

**R4-A 上次之後的新增**
- 集中的儲存函式：`loadState(name)` / `saveState(name, value)`，內部加前綴、JSON 序列化、try/catch；任何失敗回 null／靜默忽略。
- `lastSeen`：mount 時讀一次為 L（ISO 字串，Date.parse 失敗視為沒有）。之後每收到列表，把「目前列表中最新的 published」記成候選 M；在 dispose 和 `pagehide` 時寫入 `max(L, M)`。不在收到列表時立刻寫（避免重整後標記全部消失）。
- 標記：L 存在時，清單列（含焦點區）published > L 的項目，標題前加 `<span class="nw-new">新</span>`（顏色用 `--nw-accent`／`--md-accent`，粗體小字，不用背景塊）；事件群組只要任一報導是新的就標在代表列。
- 工具列狀態：L 存在且有新項目時，「HH:mm 更新」後面加「 · N 則新」（與其他狀態同一種分隔）（N 以事件計，跟清單一致）。
- 第一次使用（沒有 L）不標任何東西。只有日期（00:00）的項目照 published 比較即可。
- 驗收：前半測試（無 L、有 L、壞值、localStorage 丟例外、dispose 寫入 max、key 前綴、群組標記）；真殼截圖由 cc-mod 審。

### 18.5 第 5 輪（話題：後半）

**問題**：「習近平訪美」36 則報導分散在 26 個事件；焦點區只看得到其中一個事件（4 家）。事件＝同一件事，太窄；需要上一層「話題」＝同一件大事的報導、後續、反應、評論。

**真 API 驗證（2026-09-25 19:3x，cc-mod）**：以國宴事件為種子、41 個候選（含 6 個「川普但非訪美」困難負例）→ jev 41/41 正確（TP 31、FP 0、FN 0、TN 9），p 幾乎都 ≥0.94。另兩個種子（半導體新加坡、王冠閎奪金）的寬鬆候選全部判 different（最高 0.55）。**瓶頸在候選召回**：只用種子標題的詞，會漏掉只寫「川習會」的報導 → 需要滾雪球擴展。

**R5-A 純函式 `topics.plan(items, groups, cache, feed_order)`**（新檔 back/topics.py，無 I/O）
- 詞：標題正規化（別名表 `特朗普→川普`、`特習→川習`），取連續中文字的 2～4 字片段與英數字詞（≥2 字，轉大寫）；df＝該詞出現在目前列表幾則標題。**特徵詞**＝df ≤ 列表則數×10%。
- 種子：事件群組中不同來源數 ≥3 者，依不同來源數多→少、最新 published 新→舊、事件 id 排序。依序處理；已被前面話題收進去的事件跳過；最多 5 個話題。
- 種子代表 `seed_key`＝該事件中依 group_events 排序最早的那則的 dedup key；話題 id＝sha1(seed_key) 前 12 碼。
- 成員擴展（滾雪球）：成員＝種子事件的全部報導。候選＝不在成員、未被其他話題收走、published 在「種子事件最新時間」前後 48 小時內、且和**目前成員**的特徵詞至少共用 1 個的項目。對每個候選查 cache[(seed_key, key)]：True→把該項目**所屬整個事件**併入成員（特徵詞一起加入）；False→略過；沒有→加入待問清單。重複直到沒有新成員（只靠已知答案擴展）。每次 plan、每個種子的待問數上限 60（依共用特徵詞數多→少、時間新→舊取；答案回來重算時可再列新候選，總量由每輪 60 秒預算限制）。
- 回傳：話題清單 `[{id, title(種子代表標題), sources(不同來源數), count(則數), keys}]` 與待問清單 `[(seed_key, item_key)]`。純函式、確定性，不看輸入順序。

**R5-B jev 判斷**（`TopicMatcher(_ChoiceClient)`，放 topics.py）
- state：news_0＝種子代表（title, summary），news_1..n＝同一個種子的候選（每批 ≤19 個候選、≤MAX_CHARS）。
- 題目 `t_{i}`：instructions「news_0 是一個大新聞話題的代表報導。news_{i} 和 news_0 是否屬於同一個新聞話題？」；criteria `same_topic`「同一個話題：同一件大事的報導、後續發展、各方反應、評論或影響」、`different`「不同話題：即使人物或領域相同，講的是另一件事」；abstain `different`。
- 採納：`same_topic` 且 p ≥ 0.7 → True；其餘 False。失敗批次 → 不寫快取。

**R5-C 排程**
- 優先序：分類 > 分析 > 配對 > 話題；同一條 news-classify 執行緒、共用 enabled 與每輪 60 秒預算。（優先序已由 §18.30 取代：分類 > 配對 > 話題 > 分析 > 基調。）
- 只有在目前列表的 events.pending == 0 時才產生話題工作；每收一批答案就重算 plan（自然滾雪球），有新的待問就再排入。
- 快取 `topic_cache` FIFO 上限 20000，鍵 (seed_key, item_key)，由協調者擁有。
- 列表欄位：每則 `topic`（12 碼或不出現）；`body.topics = {"pending": n, "list": [{"id","title","sources","count"}]}`（最多 5 個；API 關閉時 pending 0、list 仍依已知快取計算）。大小守衛為 `topic` 欄位與 list 預留空間。
- 話題結果改變或 pending 歸零時，非 active 時補送一次（同事件合併的規則）。
- 驗收：plan 單元測試（別名、特徵詞門檻、滾雪球兩層、48 小時窗、已被收走的事件、上限 60、5 個話題、順序不影響結果）；matcher 單元測試（題目點名 news_0/news_i、門檻 0.7、失敗不快取）；排程測試（配對未完不排話題、優先序、補送）。真實滿額跑由 cc-mod 驗：「習近平訪美」話題 ≥ 25 則、話題 pending 歸零、總時間增加 ≤ 15 秒。

### 18.6 第 6 輪（話題：前半）

第 5 輪結果：真實滿額跑「習近平訪美」話題 41 則／9 家媒體，含訪美字樣的 36 則全收；多收的 5 則（貿易休兵延長、美中直航、北京學者評論）屬周邊報導；總時間 28→40 秒。

**R6-A 焦點改用話題**
- 驗證 `body.topics.list`：每筆 id 為 12 碼 hex、title 字串、sources 整數 ≥3、count 整數 ≥1；最多取 5 筆。有有效話題時焦點區列話題；沒有時沿用第 3 輪的事件焦點（行為不變）。
- 話題列：標題＝該話題中「標題與 topic.title 相同」那則的連結（找不到就純文字）；右側按鈕「N 家媒體・M 則」（窄版「N 家」），`aria-pressed` 表示是否為目前篩選的話題。任一報導是新的 → 標題前「新」。
- 按下話題按鈕：切到話題篩選——來源、類別重設為全部、題材篩選清除，清單只列 `item.topic === id` 的項目（仍依事件分組）。再按一次同一個 → 取消。
- 話題篩選中顯示篩選列（沿用題材篩選列的樣式與位置）：「話題：{title 前 24 字，超過加…}」＋「取消話題篩選」按鈕（aria-label）。空狀態的「清除篩選」也要清掉話題。
- 使用者手動改來源或類別時，話題篩選自動取消。
- 列表更新後若目前話題 id 已不在 topics.list，自動取消篩選。
- 按下的按鈕樣式：外框改 accent 色＋內側左緣 3px accent（inset box-shadow）；未按下維持一般外框。不另創色。
- 驗收：前半測試（驗證、回退事件焦點、篩選、取消的四種方式、新標記、消失自動取消）；真殼深淺主題截圖由 cc-mod 審。

### 18.7 第 7 輪（話題穩定、焦點不跑掉）

第 6 輪結果：焦點列話題、話題篩選上線（深淺截圖審過）。
**發現**：同一個話題兩次計算，代表標題不同（「排場十足」vs「白宮國宴誰出席」）。種子依「來源數、最新時間」排序，新報導一進來排名就換人 → 話題 id 改變（使用者的話題篩選被自動取消）、(seed_key, key) 快取全部失效要重問（最多 60 題／種子）。

**R7-A 話題種子黏著**
- `plan(items, groups, cache, feed_order, previous=())`：`previous` 是上一份已送出列表的話題 seed_key 清單（依當時順序）。
- 先處理 previous：seed_key 仍在列表、其事件未被收走 → 以**同一個 seed_key** 建話題（成員＝該 seed_key 所屬事件，照常滾雪球）；建好後若不同來源數 ≥3 就保留，否則丟棄（不收走事件）。
- 再依原本規則從其餘事件補足到 5 個。
- 輸出的 list 排序：不同來源數多→少、則數多→少、id；與黏著無關，確定性。
- 協調者保存最後送出的 seed_key 清單（受 stop/新輪影響的語意同 last_list）。
- 驗收：單元測試（新報導讓另一事件排名超前時 id 不變；previous 的種子掉到 <3 家時被取代；previous 不存在於列表時忽略；輸出排序確定）；真實跑兩輪（第二輪用 refresh 觸發）：同話題 id 不變、第二輪話題待問數明顯少於第一輪。

**R7-B 補送不搶走鍵盤焦點**
- drawItems 重畫前，若 `document.activeElement` 在本模組根元素內，記下它的身分：清單標題連結（href＋所在列的事件 id）、展開按鈕（data-event）、焦點區按鈕（data-event 或 data-topic-id）、題材按鈕（data-topic）。重畫後找到相同身分的新元素就 `focus({preventScroll: true})`；找不到就不動（不把焦點丟到別處）。
- 驗收：前半測試（四種元素在補送後仍有焦點；元素消失時不報錯）。

### 18.8 第 8 輪（話題的報導基調）

第 7 輪結果：種子黏著、補送保住焦點（審核補：被裁掉的種子略過）。
**資料缺口**：「習近平訪美」41 則中 39 則是政治類，而政治類沒有任何分析 → 話題層級沒有風向可看。
**真 API 驗證（19:5x，cc-mod）**：對該話題 41 則問「報導基調」→ 負面 17、中性 15、正反 5、正面 4；逐則人工檢查約 8 成同意，錯誤多為「中性 vs 負面」邊界；彙總方向與實際報導敘事（「排場十足但進展有限」）一致。

**R8-A 基調判斷（後半）**
- 對象：目前 topics.list 中各話題的成員報導（不限類別）。沒有結果的排入 tone 工作。
- 優先序最低：分類 > 分析 > 配對 > 話題 > 基調；同執行緒、共用 enabled 與 60 秒預算。（優先序已由 §18.30 取代：分類 > 配對 > 話題 > 分析 > 基調。）
- `ToneClient(_ChoiceClient)`（可放 topics.py）：每批 ≤20 則；題目 `q_{i}`：instructions「news_{i} 對它所報導的事情，整體評價基調是什麼？」；criteria：`positive`「正面：強調成果、進展、合作或利多」、`negative`「負面：強調分歧、受挫、風險、抗議或批評」、`neutral`「中性：主要陳述事實、行程或背景」、`mixed`「正反並陳」；abstain `neutral`（沿用 THRESHOLD 0.35）。
- 快取 tone_cache：key → tone，FIFO 4000；失敗批次不寫。
- 列表：topics.list 每筆加 `tone: {"positive": n, "negative": n, "neutral": n, "mixed": n}`（以**報導**計，只算已有結果者）；`body.topics.tone_pending`＝話題成員中尚無結果的則數（API 關閉時 0）。有變化或歸零時補送（同話題規則）。大小守衛預留。
- 驗收：單元測試（題目點名 news_i、abstain、優先序最低、計數、pending）；真實跑 cc-mod 驗 tone_pending 歸零、總時間增加 ≤ 8 秒。

**R8-B 基調顯示（前半）**
- 焦點區話題列：標題下方一行細條（高 4px，沿用 nw-bar／nw-segment；色段固定順序 正面、正反、中性、負面，同股市訊號條）＋小字「報導基調：負面 17・中性 15・正反 5・正面 4」（依數量多→少、只列 >0 者）。**已判斷則數 ≥5 才顯示**。
- 顏色：負面 `--nw-danger`、正面 `--nw-accent`、正反 `--nw-mixed`、中性 `--nw-idle`。**不用紅漲綠跌**（那是股市語意）。
- 文字與細條都是輔助：aria 以文字為準，細條 `aria-hidden`。
- 驗收：前半測試（<5 不顯示、排序、驗證壞資料忽略）；真殼深淺截圖由 cc-mod 審。

### 18.9 第 9 輪（穩定性整理）

第 8 輪結果：基調上線，總時間 38s（未增加）；色段改固定順序。12 分鐘兩版比對：更新後都只補問 2 題、id 不變（本時段未觸發黏著，無退步）。
**觀察**：啟動後約 25～30 秒內，事件還在合併，焦點區話題會連續換 3～4 次（真實跑 log：4fcf→707a/2ba7→707a…），使用者看到閃動。

**R9-A 事件合併未完成時不改話題**
- `events.pending > 0` 時，列表的 `topics.list` 沿用**上一份已送出列表**的話題（依目前列表重新計算各話題的 sources/count/tone 與 item.topic；成員只取仍在列表者；某話題成員掉到 <3 家就移除）；沒有上一份就給空清單。`topics.pending` 為 0。
- events.pending 歸零後才照常 plan。
- 驗收：排程測試（配對進行中話題不換；歸零後才出現新話題；首輪配對中為空）；真實跑 cc-mod 看 log 不再出現啟動期閃動。

**R9-B 話題詞排除純數字**
- `words()` 的英數字詞若全為數字（例如 2026、11）不列入。
- 驗收：單元測試；真實跑話題第一輪最大待問數與召回（「習近平訪美」≥36）不退步。

**R9-C 輸出佇列只保留最新一份列表**
- `Outbox.put` 收到 `t=="msg"` 且 `body.op=="list"` 時：若佇列中已有**尚未開始寫出**的列表封包，就在原位置以新封包取代（不新增一格）；否則照常排入。佇列滿時同樣先嘗試取代；無可取代才依原規則丟棄。
- 其他封包（publish、控制封包）的順序與規則不變；寫出中的那一份不可被取代。
- 驗收：單元測試（阻塞寫出→連續 10 份列表→解除阻塞：只寫出正在寫的那份＋最後一份；publish 相對順序不變；控制封包不受影響）。

### 18.10 第 10 輪（追蹤關鍵字、失敗來源名稱）

第 9 輪結果：啟動期話題不再閃動；召回 35/35；38 秒。

**R10-A 追蹤關鍵字（前半）**
- 設定讀寫集中：`watchWords()` 讀 `loadState("watch")`（陣列）並正規化；`setWatchWords(list)` 寫入。正規化：字串、trim、去掉空的、長度 1～20 字、不分大小寫去重、最多 10 個。這兩個函式是將來搬到殼設定檔時唯一要改的地方（claude-modudock 建議）。
- 工具列在類別選單後加「追蹤」按鈕（`aria-expanded` 控制設定列）。設定列（預設隱藏）：文字輸入框（label「追蹤關鍵字」，placeholder「以空白或逗號分隔，最多 10 個」）＋「儲存」按鈕＋「只看追蹤」切換按鈕（`aria-pressed`，按下樣式同話題按鈕；文字附目前符合的事件數（與清單、狀態列一致），例如「只看追蹤（12）」）。輸入框 Enter 等同儲存。
- 比對：標題或摘要包含任一關鍵字（不分大小寫的子字串）。
- 符合的清單列：meta 最前面加 `<span class="nw-watch">追蹤：{第一個符合的詞}</span>`（accent 色字、1px accent 外框、小字，不用實心底色）；事件群組任一報導符合就標在代表列。
- 「只看追蹤」開啟時清單只列符合的群組，可與來源／類別／題材／話題篩選並用；設定為空時此按鈕 disabled。空狀態的「清除篩選」也關掉它。
- 狀態列在「N 則新」之後加「追蹤 M」（M 以事件計，有設定且 M>0 才顯示）。
- 只用 textContent；關鍵字不進 innerHTML、不做正規表示式（避免特殊字元）。
- 驗收：前半測試（正規化、儲存與重新載入、Enter、比對大小寫、群組標記、只看追蹤與其他篩選並用、disabled、localStorage 丟例外、特殊字元如 `.*(`）；真殼深淺截圖由 cc-mod 審。

**R10-B 失敗來源名稱**
- 狀態列「失敗來源：N」改為可讀的「{第一個失敗來源名}等 N 個來源失敗」（N=1 時「{名稱} 失敗」）；元素 `title` 列出全部失敗來源名稱與錯誤（error 字串前 80 字）。
- 驗收：前半測試。

### 18.11 第 11 輪（風向隨時間）

第 10 輪結果：追蹤關鍵字、失敗來源名稱（審核：數字口徑統一為事件、按下樣式）。
**資料檢查（20:0x）**：以目前列表的財經分析依發布時間分桶，每小時只有 0～8 個事件，雜訊太大；每 6 小時一段約 15～25 個事件，足以看出方向。後半不必改：列表已有發布時間與分析。

**R11-A 面板加「近 24 小時」**（財經與國際面板都要）
- 位置：股市訊號（或局勢走向）圖例之後、大盤／題材之前。標題「近 24 小時」＋小字「每 6 小時一段，同一事件只算一次」。
- 分段：以列表 `body.at`（沒有就用現在時間）為終點往前 24 小時，切 4 段 [at−24h, at−18h)、…、[at−6h, at]；**由上到下＝舊到新**。每段標籤為當地時間「HH:mm–HH:mm」（最後一段「HH:mm–現在」）。
- 計數：沿用面板的範圍（來源＋類別，不受題材篩選影響）與事件去重規則（群組中第一個有效分析）；事件時間取群組代表報導的 published。超出 24 小時的事件不計。
- 每列：時段標籤｜細條（高 6px，色段與順序同上方主訊號條）｜右側數字：財經為「正面 N%」（positive ÷ (positive+negative+mixed)，四捨五入整數），國際為「升級 N%」（escalation ÷ (escalation+stalemate+deescalation)）。分母為 0 時顯示「—」；分母 1～4 時不換算百分比，改顯示「升級 3/3」這種計數（小分母的百分比會誇大）。窄版標籤欄固定 7.5ch、寬版 11ch、標籤不換行，細條起點對齊。
- 該段有效事件 <5：細條不畫（保留空軌 `data-empty`），右側顯示「樣本不足」。
- 窄版（<420px）：標籤縮為「HH–HH」、右側數字維持。
- 無障礙：每列為一個 `role="group"`，`aria-label`「HH:mm–HH:mm，正面 N%，樣本 M 個事件」；細條 `aria-hidden`。
- 驗收：前半測試（分段邊界含左不含右、最後一段含終點、<5 樣本不足、分母 0、國際版、去重、題材篩選不影響、body.at 缺失）；真殼深淺截圖由 cc-mod 審。

### 18.12 第 12 輪（回頭審查修正）

第 11 輪結果：近 24 小時風向分段（審核：對齊、小分母改計數）。
第 12 輪為回頭審查：cx-mod 審前半（3 條中度，皆 happy-dom 重現）、獨立審查 agent 審後半（結果另補）。

**R12-F1 焦點區連結的焦點恢復**：焦點區標題連結納入身分（話題 id 或事件 id＋href），補送後恢復。
**R12-F2 合併後追蹤原報導**：原身分找不到、但同一 href 在清單中唯一存在 → 若在收合群組內就展開該群組，然後恢復焦點；報導真的消失則不移動焦點。
**R12-F3 lastSeen 不倒退**：寫入前重新讀一次目前儲存值（驗證同 mount），寫入 max(儲存值, L, min(M, now))；例外照舊忽略。
- 驗收：前半測試各一（用 cx-mod 的重現步驟）。

**後半審查（獨立 agent，2 條中度，皆以腳本重現）**

**R12-B1 基調不可搶在話題之前**（scheduler.py:305-307、:257、:366）
- 現況：新一輪 emit 時配對未完成、沿用舊話題 → tone 佇列已有工作、topic 佇列空。worker 送出最後一批配對結果後，不等協調者接收就拿走 tone 批次；協調者接收後才排 topic 工作。順序變成 events → tone → topics；若 tone 失敗，work.failed 讓本輪話題完全不跑，topics.pending 卡到下一輪。
- 修正：worker 的等待條件也要等尚未被接收的 `EventResult`（和 Classify/Topic 一樣：有未接收結果時先讓協調者處理，再重新選佇列）。
- 驗收：排程測試重現審查腳本的情境（第 2 輪：沿用話題＋配對進行中＋最後一批配對結果）→ 呼叫順序為 events → topics → tone；tone 失敗時話題仍已完成。

**R12-B2 黏著不可擋住更大的新話題**（topics.py:55-63）
- 現況：previous 種子先處理，湊滿 5 個就 break；新出現的 10 家大事件永遠進不來。
- 修正：previous 只提供「穩定的身分」，不保證名額。處理順序仍是 previous → 依規則排序的其他種子，但**不在建構中途因滿 5 個而停止**（建構上限 10 個話題以控制成本）；全部建好後依（不同來源數多→少、則數多→少、id）取前 5。待問清單只保留最後入選的話題。
- 驗收：單元測試（5 個舊話題各 3 家＋1 個 10 家新事件 → 新事件入選、擠掉最弱的舊話題；舊話題 id 不變者仍維持原 id；待問只含入選者）。

**低於門檻，記錄不修**：Outbox 取代舊列表後，舊列表對應的 news.fetched publish 會排在新列表之後送出（數量／時間為舊值）；`_send_list` 在 outbox.put 回 False 時仍回傳 packet。

### 18.13 第 13 輪（「上次看到這裡」分隔線）

第 12 輪結果：前半 3 條、後半 2 條審查問題修正；異常情境（錯誤金鑰、無金鑰）真實測試通過。
**觀察（整頁走查，20:27）**：離開 2 小時後回來，清單上方 60 則每列都有「新」字樣，滿版標記反而沒有重點。
**依據**：清單群組依「最新一則報導」出現的順序排列，所以「含新報導的群組」必定連續排在最上面（發布時間無效的項目除外）。

**R13-A 分隔線取代清單內的「新」標記**
- 清單（不含焦點區）：L 存在、且清單中同時有新群組與舊群組時，在**第一個舊群組之前**插入 `<li class="nw-divider" role="separator">`，文字「上次看到這裡」，`aria-label`「以上是上次之後的新報導」。全部是新的或全部是舊的：不插入。
- 清單列不再加「新」字樣；**例外**：不屬於開頭連續新群組的新群組（出現在分隔線之下、或第一個群組就是舊的而沒有分隔線）仍加「新」。第一個群組是舊的時不插入分隔線。
- 焦點區的「新」保留（焦點不依時間排序）。
- 樣式：文字 12px、`--nw-accent` 色、左對齊；文字右側延伸 1px `--nw-accent` 橫線（flex＋偽元素或 border）；上下留白與清單列一致；不使用背景色塊。
- 分隔線不是清單項目：清單列計數、焦點恢復、鍵盤導覽都要略過它（`li` 但不含連結或按鈕）。
- 驗收：前半測試（無 L／全新／全舊不插入、位置正確、例外列仍有「新」、焦點區仍有「新」、補送後位置更新、篩選後重算）；真殼深淺截圖由 cc-mod 審。

### 18.14 第 14 輪（時間範圍、基調可追溯）

第 13 輪結果：分隔線上線（審核補開頭舊群組邊界）。

**R14-A 多報導事件顯示時間範圍**
- 問題：群組依「最新一則」排序，列上卻只顯示代表（最早一則）的時間，出現「18:01」夾在一排「20:20」之間，看起來像排錯。
- 修正：群組有 ≥2 則且最早與最新時間不同時，列上時間顯示「{最早}–{最新}」（各自沿用 newsTime 規則：跨日加日期、只有日期不附時間、推定加「約」）；同一天時第二段只顯示 HH:mm。只有一則或時間相同時維持原樣。展開的子報導各自顯示自己的時間（不變）。
- 驗收：前半測試（同日、跨日、推定、只有日期、單則不變）。

**R14-B 每則報導的基調（可追溯）**
- 後半：話題成員若已有基調結果，該項目加欄位 `tone`（positive/negative/neutral/mixed）；非話題成員不出現此欄位。大小守衛預留。
- 前半：**只在話題篩選中**，清單列 meta 加基調小標（「負面」「正面」「正反」「中性」），顏色同焦點基調條（負面 danger、正面 accent、正反 mixed、中性 muted），1px 同色外框、不用實心底；群組代表列顯示代表報導的基調，展開的子報導各自顯示。未篩選話題時不顯示（避免清單雜訊）。
- 目的：使用者能看出「負面 15」是哪 15 則，自己判斷模型準不準。
- 驗收：後半單元測試（成員才有、無結果不出現、預留）；前半測試（只在話題篩選中出現、無效值忽略、子報導）；真殼深淺截圖由 cc-mod 審。

### 18.15 第 15 輪（話題來源分布、模型統計）

第 14 輪結果：時間範圍、基調可追溯（深淺截圖審過）。話題精確度抽查：訪美 37/37、普發現金 5/5 皆屬同話題（航空直航、AI 競賽屬周邊）。

**R15-A 話題篩選列顯示來源分布（前半）**
- 話題篩選中，篩選列「話題：…」之後加一行小字（`nw-hint`）：該話題在目前列表中的報導依來源計數，由多到少、同數依 feeds 順序，最多列 5 個，其餘合併為「等 N 家」。格式：「BBC 中文（繁）12・中央社 國際 10・公視新聞網 4 等 3 家」。
- 只是計數，不附任何立場或評價字眼。
- 驗收：前半測試（排序、同數順序、超過 5 家、補送後更新）。

**R15-B 每輪模型統計（後半）**
- 每個 fetch 輪次的模型工作結束（該輪所有佇列清空、或預算用完、或失敗）時，stderr 寫一行固定格式：`model round={id} requests={n} failed={m} elapsed={s:.1f}s classify={a} analysis={b} events={c} topics={d} tone={e}`（各類別為請求次數）。不含任何新聞內容、URL、錯誤文字或金鑰。
- 同一輪只寫一次；沒有任何模型請求的輪次不寫。
- 驗收：排程測試（一輪寫一次、計數正確、失敗計數、無內容）。

### 18.16 第 16 輪（政治議題分析）

第 15 輪結果：話題來源分布、每輪模型統計（一輪完整 44 次請求／35 秒）。
**缺口**：政治類約占列表 1/4（本次 70/300），完全沒有分析。用戶已保留的「藍綠傾向」**不做**；本輪只做中立的「議題」分類。
**真 API 驗證（20:4x，cc-mod）**：隨機 40 則政治新聞 → 約 38 則分類合理，僅 1 則「以上皆非」；p 多數 ≥0.85。

**R16-A 後半**
- `ANALYSIS_CATEGORIES` 加入 `politics`；`analysis_kind("politics") == "politics"`；`QUESTION_SETS["politics"] = {"issue": ("這則新聞主要涉及哪一個政治議題？", ISSUE_CRITERIA, "other")}`（instructions 仍須點名 news_i，沿用既有題組機制）。
- `ISSUE_CRITERIA`（照抄，已驗證）：`cross_strait`「兩岸關係、中國對台」、`us_intl`「美國與國際外交（含川習會、軍售外交）」、`defense`「國防、軍事、國安」、`election`「選舉、候選人、選戰、政黨動態」、`budget`「預算、財政、普發現金、補貼、稅」、`legislature`「立法院議事、法案」、`justice`「司法、檢調、弊案、貪污」、`energy_env`「能源、核能、環境」、`local`「地方施政、建設」、`other`「以上皆非」。
- 結果形狀 `{"kind": "politics", "issue": id}`；`valid_analysis` 相應擴充。批次仍須同一 kind（第 1 輪規則）。大小預留取三種形狀中最長者（沿用機制）。
- 驗收：單元測試（題目點名 news_i、abstain、kind 分批、驗證、預留）。

**R16-B 前半**
- 類別切到「政治」時顯示面板（沿用財經／國際面板骨架）：樣本行（事件、報導、來源、待分析）＋「議題」排行（依事件數，點選篩選，`issue:` 前綴，同地區排行的互動與按下樣式；無方向細條，只顯示數量長條）＋註記「同一事件多家報導只算一次。」。不顯示股市訊號與近 24 小時。
- 議題名稱：兩岸、美國與國際、國防、選舉、預算與補貼、立法院、司法、能源環境、地方施政、其他。「其他」（以及國際的地區「其他」）固定排最後。
- 政治類清單列 meta 加議題小標（樣式同題材小標，無箭頭）。
- 驗收：前半測試（面板顯示條件、排行、篩選與取消、無效分析忽略、切換類別清掉不適用篩選）；真殼深淺截圖由 cc-mod 審。

### 18.17 第 17 輪（無障礙：按鈕名稱包含可見文字）

第 16 輪結果：政治議題分析（71/71，+4 請求）；審核修正「其他」排最後。
**Lighthouse 無障礙稽核（真 Chromium，財經檢視，20:55）**：94 分。news 的失敗項為 `label-content-name-mismatch`（WCAG 2.5.3 Label in Name）：題材按鈕可見「晶圓代工 10」，aria-label 卻是「晶圓代工 10（▲7 ▼1）」；語音操作者照畫面念可能點不到，▲▼ 讀出也無意義。同類問題還有：焦點話題按鈕（可見「8 家媒體・37 則」、名稱「篩選話題：…」開頭）、焦點事件按鈕（可見「3 家媒體」、名稱「展開 3 家媒體的報導」）、「清除」按鈕（名稱「取消題材篩選」）。其餘失敗項屬殼（分頁按鈕 aria-selected 無 role、meta description），轉告 claude-modudock。

**R17-A 規則**：凡有可見文字的按鈕，**不用 aria-label 覆蓋名稱**；可見文字就是名稱。補充資訊改放 `aria-describedby` 指向的視覺隱藏元素（`.nw-sr` 類：clip 隱藏的標準寫法），以文字表達，不用符號：
- 題材／地區／議題排行按鈕：描述「利多 7、利空 1」（國際「升級 N、緩和 M」；政治無描述）。
- 焦點話題按鈕：描述「篩選話題：{title}」。窄版可見文字「8 家」時，描述仍完整。
- 焦點事件按鈕：描述「展開同事件的其他報導」。
- 「清除」按鈕：可見文字改為「清除篩選」（題材／地區／議題共用），不再另設 aria-label；話題的「取消話題篩選」維持。
- 沒有可見文字的元素（例如 region、細條）照舊用 aria-label。
- 驗收：前半測試——掃描模組內所有 `button`：若有可見文字，則沒有 aria-label（或 aria-label 與可見文字相同）；describedby 目標存在且文字正確。真 Chromium 重跑 Lighthouse 由 cc-mod 驗 `label-content-name-mismatch` 消失。

### 18.18 第 18 輪（變異測試找出的測試漏洞）

第 17 輪結果：Lighthouse 的 label-in-name 失敗消失（剩餘 3 項屬殼）。
**變異掃描（21:02，cc-mod，15 個變異）**：12 個被測試抓到，3 個存活——
1. `plan()` 種子門檻 `>= 3` 改成 `>= 2` 仍全綠：沒有測試「2 家來源的事件，即使快取答案能讓它擴展到 ≥3 家，也不能當種子」。
2. 待問排序去掉「共用特徵詞數多→少」仍全綠：沒有測試候選 >60 時，優先保留共用詞較多者。
3. 輸出排序改成只看則數仍全綠：沒有測試「來源數較多者優先於則數較多者」。

**R18-A** 為上述 3 點各補一個單元測試（只改 tests/，不改程式）；完成後以對應變異驗證會變紅。

### 18.19 第 19 輪（摘要展開、追蹤切換上工具列）

第 18 輪結果：變異掃描後半 15、前半 12，存活皆補到 0。
cx-mod 以「每天早上看 3 分鐘的使用者」走查提出 5 項（皆不增加模型請求）；本輪做其中成本最低、每天都會用到的兩項。

**R19-A 在模組內看摘要**
- 現況：摘要只在標題的 `title` 提示裡（滑鼠停留才看得到；鍵盤、觸控看不到）。
- 清單列 meta 最後加小按鈕「摘要」（樣式同「另 N 則報導」），`aria-expanded`、`aria-controls` 指向摘要段落；按下在該列 meta 下方展開 `<p class="nw-summary">`（放在 meta 之後，按鈕位置才不會因展開而移動；textContent＝代表報導的 summary；13px、muted、行高 1.6、最大寬度 42em 以控制行長、不截斷）。再按收起。摘要為空字串時不顯示按鈕。
- 展開狀態以事件 id（無 id 時用 link）記住，補送後保留；列消失時移除。
- 標題 `title` 屬性保留（桌面滑鼠使用者習慣），但不再是唯一途徑。
- 摘要段落開頭加小字「來源摘要」標籤（muted），明確這是來源提供的文字。

**R19-B 「只看追蹤」上工具列**
- 有追蹤關鍵字時，工具列在「追蹤」按鈕右側直接顯示切換鈕「只看追蹤 N」（N＝符合的事件數；`aria-pressed`，按下樣式同話題按鈕）；沒有關鍵字時不顯示。設定列內原本的「只看追蹤」移除（設定列只留輸入框＋儲存）。
- 「追蹤」按鈕文字改為「追蹤設定」。
- 狀態列不再顯示「追蹤 M」（數字已在切換鈕上）。
- 驗收：前半測試（摘要按鈕顯示條件、展開收起、補送保留、空摘要、aria；工具列切換鈕顯示條件、計數、按下狀態、設定列不再有切換）；真殼深淺與窄版截圖由 cc-mod 審。

### 18.20 第 20 輪（話題新進展、整理狀態）

第 19 輪結果：摘要展開（審核：放 meta 之下、行寬 42em）、只看追蹤上工具列。

**R20-A 話題新進展（前半）**
- 焦點區話題列：L 存在且該話題有「含新報導的事件」時，在基調行（沒有基調行就在標題下）加 accent 小字「上次之後新增 N 個事件」。N 以事件計。
- 進入話題篩選後，清單的「上次看到這裡」分隔線照常作用（新進展自然排在上方），不另做「只看新進展」。
- 驗收：前半測試（無 L 不顯示、N 計數以事件、無新事件不顯示、與基調行並存）。

**R20-B 整理狀態（後半＋前半）**
- 後半列表加 `body.model = {"state": s, "reason": r}`：
  - `working`：本輪還有模型工作排隊或進行中（任一 pending>0 且本輪未失敗、預算未用完、API 開啟）。
  - `done`：所有 pending 為 0。
  - `paused`：仍有 pending，但本輪已停止（`reason`：`budget`＝60 秒預算用完、`failed`＝請求失敗）；下一輪會繼續。
  - `off`：API 關閉（`reason`：`disabled`）。
  - reason 只用這些固定字串，不含任何錯誤內容。大小守衛預留。
- 前半狀態列（「HH:mm 更新」之後）：working →「整理中」；paused →「整理暫停，下次更新繼續」；off/done 不顯示（off 已有「分類：關閉」）。焦點區在 working 且沒有話題時，顯示提示「正在整理多家媒體同報的話題」而不是整區隱藏。
- 驗收：後半排程測試（四種狀態轉換、預算用完→paused、失敗→paused、下一輪回到 working/done）；前半測試（狀態文字、焦點提示）；cc-mod 用真 API 滿額跑觀察狀態序列最後為 done。

### 18.21 第 21 輪（看完話題回到原檢視）

第 20 輪結果：話題新進展、整理狀態（真實序列 working→done、錯誤金鑰 working→off）。

**R21-A**
- 進入話題篩選時（從非話題狀態），保存當下檢視：來源、類別、題材／地區／議題篩選、只看追蹤、清單捲動位置（模組根元素最近的可捲動祖先的 scrollTop）、焦點所在元素的身分（沿用 focusIdentity）。
- 以下方式離開話題時**還原**保存的檢視（篩選值若已不存在於選項則略過該項）：「取消話題篩選」按鈕、再按一次同一話題按鈕、話題從列表消失。還原後恢復捲動位置與焦點（找不到就不動）。
- 以下方式離開話題時**不還原**、並丟棄保存：使用者手動改來源或類別、空狀態的「清除篩選」。
- 在話題中切換到另一個話題：保存的仍是最初進入話題前的檢視。
- 「取消話題篩選」按鈕文字改為「返回」，`aria-describedby` 說明「回到進入話題前的篩選與位置」。
- 驗收：前半測試（三種還原路徑、兩種丟棄路徑、話題間切換、選項消失、捲動與焦點恢復）；真殼截圖由 cc-mod 審。

### 18.22 第 22 輪（清單列資訊密度整理）

第 21 輪結果：看完話題回到原檢視（真殼實測篩選與捲動位置都還原）。
**觀察（21:31 截圖）**：話題檢視中一列 meta 同時有「議題、類別、來源、時間、基調、另 N 則報導、摘要」7 個元素，資訊與操作混在一起。原則：每個標籤只在提供新資訊時出現；資訊與操作分開。

**R22-A**
- 類別篩選為特定類別時，清單列不顯示類別名稱（使用者已選定，重複無資訊）；「全部類別」時照常顯示。
- 政治議題小標只在類別為「政治」時顯示（「全部」或話題檢視中，「美國與國際｜政治」重複）；題材（含 ▲▼）與地區小標維持原規則。
- 操作按鈕（「另 N 則報導」「摘要」）移到 meta 右端：meta 內分成資訊區與操作區，操作區 `margin-left: auto`、兩鈕間距 6px；窄版（<420px）時操作區不推到右端（緊接資訊之後），放得下就同一行、放不下自然換行，避免每列都多一行。
- 資訊元素順序固定：追蹤標記 → 分析小標（題材／地區／議題）→ 類別 → 來源 → 時間 → 基調（僅話題檢視）。
- 驗收：前半測試（三種類別狀態下的類別名稱顯示、議題小標顯示條件、操作區結構與順序）；真殼寬版＋窄版、深淺截圖由 cc-mod 審。

### 18.23 第 23 輪（焦點跟隨類別、狀態列去重）

第 22 輪結果：清單列資訊密度整理（審核：窄版操作區自然換行）。

**R23-A 焦點跟隨來源／類別篩選**
- 有來源或類別篩選時，焦點區只列「至少一則成員報導落在目前來源＋類別範圍內」的話題；列上的「N 家媒體・M 則」仍是話題整體數字（點下去看的是整個話題）。全部被過濾掉時，焦點區隱藏（不回退事件焦點）。
- 無篩選時行為不變。話題篩選中不受影響。
- 回退的事件焦點本來就依篩選計算，維持。

**R23-B 狀態列去重**
- `model.state` 為 working 時，不顯示「未分類：N」（「整理中」已涵蓋）；paused 或 done 時若仍有未分類才顯示。
- 驗收：前半測試（A：類別過濾、來源過濾、全部過濾掉時隱藏、數字仍為整體；B：working 隱藏、paused 顯示）；真殼截圖由 cc-mod 審。

### 18.24 第 24 輪（後半低嚴重度收尾）

第 23 輪結果：焦點跟隨篩選、狀態列去重（真殼實測）。1 小時耐久測試：7 次更新、零錯誤、RSS 33～56MB 無上升。

第 12 輪後半審查列為「低於門檻」的兩項，趁前半獨立審查進行時收尾：
**R24-A publish 與取代的列表一致**：Outbox 以新列表取代佇列中的舊列表時，若佇列中其後有對應舊列表的 `news.fetched` publish，將其 body 的 count/at 更新為新列表的值（仍維持原位置、只送一次）。
**R24-B 未送出的列表不當作已送出**（實作確認：現有程式已回傳 None，第 12 輪審查的這條低嚴重度判斷有誤；本輪只補測試鎖住行為）：`_send_list` 在 `outbox.put` 回 False 時回傳 None（不更新 last_list、不觸發依賴已送出列表的後續排程）；呼叫端既有對 None 的處理需確認一致。
- 驗收：單元測試各一（A：阻塞寫出→列表 L1＋publish P1→L2 取代 L1→寫出順序 L2、P1 且 P1 的 count/at 為 L2；B：put 回 False → 回傳 None、last_list 不變）。

### 18.25 第 25 輪（前半獨立審查修正）

第 24 輪結果：publish 同步；R24-B 原已正確只補測試。README 補齊第 13～24 輪。
**前半獨立審查（第二次，agent，21:5x）**：4 條中度、1 條低度，皆以 happy-dom 腳本重現（scratchpad/h.mjs、t1.mjs、t2.mjs）。

**R25-1 進入話題要關掉只看追蹤**：onFocus 進話題時 `onlyWatched = false`（原值已存於 savedView，返回時還原）。
**R25-2 摘要展開狀態不因篩選而清掉**：`summaries` 的清理改以「整份 items 仍存在的 key」為準（同 `expanded` 規則），不以目前可見群組為準；返回原檢視後展開狀態與捲動位置一致。
**R25-3 話題消失時焦點不掉到 body**：自動返回路徑重畫前記下目前焦點身分；還原時先試保存的焦點、再試目前焦點身分，都找不到則不移動（不得落到 body）。
**R25-4 不搶模組外的焦點**：由補送觸發的自動返回，只有在 `root.contains(document.activeElement)` 或焦點在 body 時才還原焦點與捲動；使用者按鈕觸發的返回照舊。
**R25-5（低）摘要 key**：沒有事件 id 時 key 用 `link＋source＋title`；link 為空時不記住展開狀態。
- 驗收：五條各一個前半測試（可直接改寫審查腳本）。

### 18.26 第 26 輪（選單顯示數量）

第 25 輪結果：前半第二次獨立審查 5 條修正（重跑審查腳本確認）。

**R26-A 下拉選單附數量**
- 類別選單每個選項附事件數：「財經 97」；數字以**目前來源篩選**下、該類別的事件數計（不受題材／話題／只看追蹤影響）；「全部類別」附總事件數。0 的類別仍列出（顯示「娛樂 0」），不隱藏、不 disabled。
- 來源選單每個選項附該來源的報導數（來自 `body.sources[].count`）；`ok === false` 的來源附「（失敗）」；「全部來源」附總報導數。
- 選項文字只用 textContent；補送時就地更新文字，不重建 `<select>`（保留目前選取值與鍵盤焦點）。
- 驗收：前半測試（類別數隨來源篩選變、全部的總數、失敗標記、補送不改變選取值與焦點）；真殼截圖由 cc-mod 審（展開選單的畫面以選項文字檢查代替）。

### 18.27 第 27 輪（前半結構整理，行為不變）

第 26 輪結果：選單附數量（真殼實測）。
**動機**：front/front.js 已 1150+ 行；其中樣式字串約 150 行、名稱對照與驗證函式約 70 行，與 mount 的狀態邏輯混在一起。

**R27-A 拆檔（純搬移，不改行為）**
- `front/style.js`：`export const css = ...`（原字串原封不動）。
- `front/labels.js`：categoryNames、themeNames、regionNames、issue 名稱、topic/trend/market/direction 的 id 集合，以及 validAnalysis、topicOf、arrow、eventId 等無狀態工具（原程式原封不動，改為 export）。
- `front/front.js`：以相對路徑 `import { css } from "./style.js"`、`import {...} from "./labels.js"`；`export default function mount` 不變。
- 不改任何行為、文字、選擇器、測試斷言（測試只允許調整 import 路徑，若有需要）。模組層級計數器（focusHeadingId 等 id 產生器）留在 front.js。
- manifest `frontend.public` 為 `front`，同目錄檔案皆可被瀏覽器載入；cc-mod 於真殼確認實際載入成功。
- 驗收：前半測試全綠且數量不變；cc-mod 重跑前半變異掃描（變異目標可能移到 labels.js）＋真殼截圖。

### 18.28 第 28 輪（重新整理的即時回饋）

第 27 輪結果：前半拆檔（純搬移逐行驗證、變異 0 存活、真殼載入三檔）。
**觀察**：按「重新整理」後畫面沒有任何變化，直到新一輪抓完（約 2 秒～數秒）才更新；使用者無法確定按到了沒有。

**R28-A**
- 按下後：按鈕 `disabled`、文字改為「更新中…」（圖示保留）、清單 `aria-busy="true"`；記下按下當時的 `body.at`。
- 收到 `at` 與記下值不同的列表時恢復：按鈕可按、文字復原、`aria-busy` 移除。
- 保險：30 秒內沒有新 `at` 也恢復（避免後端忙或失敗時按鈕永遠卡住），並在狀態列顯示「更新未完成，稍後自動重試」直到下一份列表到來。
- unmount 時清掉計時器。
- 驗收：前半測試（按下後狀態、新 at 恢復、同 at 不恢復、30 秒逾時恢復與提示、unmount 清計時器）；真殼截圖由 cc-mod 審。

### 18.29 第 29 輪（後半模型工作迴圈結構整理，行為不變）

第 28 輪結果：重新整理的即時回饋（真殼 1.8 秒恢復）。
**動機**：`_classify_worker` 以 5 個布林旗標（toning/topic_matching/matching/analyzing）與多層三元運算式分派 5 種工作；第 12 輪的「基調搶在話題前」即出在這段的等待條件。可讀性差、易藏優先序錯誤。

**R29-A 以「工作線路表」取代旗標**
- 新增內部 dataclass `_Lane`（name、jobs 佇列、pair 型或 item 型、批次規則、呼叫函式、結果類別、是否要等待未接收結果）；`self.lanes` 依優先序列出 classify、analysis、events、topics、tone。（優先序已由 §18.30 取代：分類 > 配對 > 話題 > 分析 > 基調。）
- `_classify_worker` 拆成：`_next_lane()`（依序取第一個非空佇列）、`_take_batch(lane, work, first)`（沿用各自既有的批次規則：analysis 的同 kind 掃描、events/topics 的 fits、其他的 MAX_ITEMS/MAX_CHARS）、`_call(lane, batch)`、`_to_result(lane, ...)`。
- 等待條件改為「有任何 lane 標記需要等待的未接收結果」（等同目前的 Classify/Event/Topic）。
- `work.requests` 的鍵沿用 lane.name。
- **不改任何行為**：優先序、批次內容與大小、預算、失敗語意、log 字串、統計行格式都不變。
- 驗收：Python 全套測試數不變全綠；cc-mod 重跑後半變異掃描（目標字串若搬移需對應更新）；真實滿額跑的 `model round=` 統計各類請求數與改版前在同一時段的量級一致、所有 pending 歸零、總時間相當。

### 18.30 第 30 輪（模型工作優先序：焦點優先）

第 29 輪結果：worker 線路表（真實跑請求數前後完全相同）。
**動機**：預設檢視是「全部類別」，最上方是焦點；但焦點要等分析做完才開始配對與話題。分析只用在財經／國際／政治面板。
**真 API 實驗（22:3x，cc-mod，各跑 2 次）**：

| 指標 | 現行 分類>分析>配對>話題>基調 | 分類>配對>話題>分析>基調 |
|---|---|---|
| 焦點出現 ≥20 則的話題 | 32.2 / 31.9 秒 | **20.8 / 19.8 秒** |
| 話題全部完成 | 39.7 / 38.8 秒 | **28.1 / 27.0 秒** |
| 分析全部完成 | 32.2 / 31.9 秒 | 40.0 / 38.7 秒 |
| 全部完成 | 41.9 / 41.0 秒 | 42.0 / 40.7 秒 |

**R30-A** 優先序改為 **分類 > 配對 > 話題 > 分析 > 基調**（`self.lanes` 順序）。其餘語意不變：話題仍只在配對完成（events.pending == 0）後才排；各 lane 的等待規則不變。
- 更新 §18.5 R5-C、§18.8 R8-A 等處對優先序的描述為本節順序（在原文加註「已由 §18.30 取代」即可）。
- 驗收：既有優先序測試改為新順序並維持相同強度（例如「配對進行中不排話題」「話題先於分析」「分析先於基調」）；cc-mod 真實跑確認焦點提前。
