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

> R1-A 的單一執行緒敘述已由 §18.32 取代：啟用模型時使用 3 條 worker。
> R1-C 的時間格式已由 §18.3 R3-B、§18.14 R14-A 取代：午夜只顯示日期，多報導事件可顯示時間範圍。

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

> R2-B 的無條件刪除敘述已由 §18.38 取代：目前類別未知或不屬於分析類別時，保留分析快取但不顯示；僅在目前類別可分析且 kind 不符時刪除並重排。

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

> R3-A 的事件焦點與篩選規則已由 §18.6、§18.20、§18.23 取代：優先列話題；話題只跟隨來源＋類別，數字仍為整體；無話題且整理中時顯示提示，其餘才回退事件焦點。
> R3-A 的按鈕 aria-label 已由 §18.17 取代：可見文字作名稱，補充資訊使用 aria-describedby。

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

> R4-A 的保存公式已由 §18.12 R12-F3 取代：寫入前重讀，保存 max(儲存值, L, min(M, now))。
> R4-A 清單每列的「新」標記已由 §18.13 取代：開頭連續新群組使用分隔線，後方零星新群組及焦點區仍保留標記。

### 18.5 第 5 輪（話題：後半）

**問題**：「習近平訪美」36 則報導分散在 26 個事件；焦點區只看得到其中一個事件（4 家）。事件＝同一件事，太窄；需要上一層「話題」＝同一件大事的報導、後續、反應、評論。

**真 API 驗證（2026-09-25 19:3x，cc-mod）**：以國宴事件為種子、41 個候選（含 6 個「川普但非訪美」困難負例）→ jev 41/41 正確（TP 31、FP 0、FN 0、TN 9），p 幾乎都 ≥0.94。另兩個種子（半導體新加坡、王冠閎奪金）的寬鬆候選全部判 different（最高 0.55）。**瓶頸在候選召回**：只用種子標題的詞，會漏掉只寫「川習會」的報導 → 需要滾雪球擴展。

**R5-A 純函式 `topics.plan(items, groups, cache, feed_order)`**（新檔 back/topics.py，無 I/O）
- 詞：標題正規化（別名表 `特朗普→川普`、`特習→川習`），取連續中文字的 2～4 字片段與英數字詞（≥2 字，轉大寫）；df＝該詞出現在目前列表幾則標題。**特徵詞**＝df ≤ 列表則數×10%。
- 種子：事件群組中不同來源數 ≥3 者，依不同來源數多→少、最新 published 新→舊、事件 id 排序。依序處理；已被前面話題收進去的事件跳過；最多 5 個話題。
- 種子代表 `seed_key`＝該事件中依 group_events 排序最早的那則的 dedup key；話題 id＝sha1(seed_key) 前 12 碼。
- 成員擴展（滾雪球）（非種子整事件納入規則已由 §20.36 取代）：成員＝種子事件的全部報導。候選＝不在成員、未被其他話題收走、published 在「種子事件最新時間」前後 48 小時內、且和**目前成員**的特徵詞至少共用 1 個的項目。對每個候選查 cache[(seed_key, key)]：True→把該項目**所屬整個事件**併入成員（特徵詞一起加入）；False→略過；沒有→加入待問清單。重複直到沒有新成員（只靠已知答案擴展）。每次 plan、每個種子的待問數上限 60（依共用特徵詞數多→少、時間新→舊取；答案回來重算時可再列新候選，總量由每輪 60 秒預算限制）。
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

> R5-A 詞抽取已由 §18.9 R9-B、§18.33 R33-4 取代：排除純數字詞，比對前移除指定四種零寬字元、保留 ZWJ。
> R5-A 種子處理與建構上限已由 §18.7、§18.12 R12-B2 取代：先處理 previous，最多建構 10 個話題，再依來源數、則數、id 取前 5；黏著不保證名額。
> R5-C 的單一執行緒敘述已由 §18.32 取代：3 條模型 worker 並行。

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

> R6-A 的取消按鈕與退出行為已由 §18.21、§18.25 取代：按鈕為「返回」，同話題重按及話題消失也還原原檢視；進入話題另關掉只看追蹤。
> R6-A 的無話題回退與焦點顯示範圍已由 §18.20、§18.23 取代：整理中顯示提示；話題跟隨來源＋類別，全部被過濾時不回退事件焦點。

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

> R7-A「補足到 5 個」已由 §18.12 R12-B2 取代：最多建構 10 個，再排序取前 5，previous 不保證名額。
> R7-B 找不到原身分就不動的規則已由 §18.12 R12-F2、§18.38 R38-B 取代：先嘗試唯一 href，必要時展開群組；原焦點在模組內且重畫後無法恢復時，最後保底到清單容器。

### 18.8 第 8 輪（話題的報導基調）

第 7 輪結果：種子黏著、補送保住焦點（審核補：被裁掉的種子略過）。
**資料缺口**：「習近平訪美」41 則中 39 則是政治類，而政治類沒有任何分析 → 話題層級沒有風向可看。
**真 API 驗證（19:5x，cc-mod）**：對該話題 41 則問「報導基調」→ 負面 17、中性 15、正反並陳 5、正面 4；逐則人工檢查約 8 成同意，錯誤多為「中性 vs 負面」邊界；彙總方向與實際報導敘事（「排場十足但進展有限」）一致。

**R8-A 基調判斷（後半）**
- 對象：目前 topics.list 中各話題的成員報導（不限類別）。沒有結果的排入 tone 工作。
- 優先序最低：分類 > 分析 > 配對 > 話題 > 基調；同執行緒、共用 enabled 與 60 秒預算。（優先序已由 §18.30 取代：分類 > 配對 > 話題 > 分析 > 基調。）
- `ToneClient(_ChoiceClient)`（可放 topics.py）：每批 ≤20 則；題目 `q_{i}`：instructions「news_{i} 對它所報導的事情，整體評價基調是什麼？」；criteria：`positive`「正面：強調成果、進展、合作或利多」、`negative`「負面：強調分歧、受挫、風險、抗議或批評」、`neutral`「中性：主要陳述事實、行程或背景」、`mixed`「正反並陳」；abstain `neutral`（沿用 THRESHOLD 0.35）。
- 快取 tone_cache：key → tone，FIFO 4000；失敗批次不寫。
- 列表：topics.list 每筆加 `tone: {"positive": n, "negative": n, "neutral": n, "mixed": n}`（以**報導**計，只算已有結果者）；`body.topics.tone_pending`＝話題成員中尚無結果的則數（API 關閉時 0）。有變化或歸零時補送（同話題規則）。大小守衛預留。
- 驗收：單元測試（題目點名 news_i、abstain、優先序最低、計數、pending）；真實跑 cc-mod 驗 tone_pending 歸零、總時間增加 ≤ 8 秒。

**R8-B 基調顯示（前半）**
- 焦點區話題列：標題下方一行細條（高 4px，沿用 nw-bar／nw-segment；色段固定順序 正面、正反並陳、中性、負面，同股市訊號條）＋小字「報導基調：負面 17・中性 15・正反並陳 5・正面 4」（依數量多→少、只列 >0 者）。**已判斷則數 ≥5 才顯示**。
- 顏色：負面 `--nw-tone-neg`（正文色 78%，深墨色）、正面 `--nw-accent`、正反並陳 `--nw-mixed`、中性 `--nw-idle`。**不用任何紅或綠**：財經檢視中紅色＝上漲（§18.35 修正：原本負面用 danger 紅，與股市訊號並排時語意相反）。
- 文字與細條都是輔助：aria 以文字為準，細條 `aria-hidden`。
- 驗收：前半測試（<5 不顯示、排序、驗證壞資料忽略）；真殼深淺截圖由 cc-mod 審。

> R8-A 的同執行緒敘述已由 §18.32 取代：3 條模型 worker 並行。

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

> R9-C 的 publish 規則已由 §18.24 R24-A 取代：對應被取代列表的 queued publish，其 count／at 同步更新，位置不變。

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

> R10-A 的追蹤介面已由 §18.19 R19-B 取代：「追蹤」改為「追蹤設定」；「只看追蹤 N」移到工具列，沒有關鍵字時隱藏；狀態列移除「追蹤 M」。

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

> R11-A 固定顯示四列的規則已由 §18.36 取代：四段中至少三段樣本不足時，只顯示標題與一行不足提示。

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

> 末段「低於門檻，記錄不修」已由 §18.24 取代：publish 同步更新；拒收列表回 None 原本就已實作，該項舊審查判斷有誤。

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
- 前半：**只在話題篩選中**，清單列 meta 加基調小標（「負面」「正面」「正反並陳」「中性」），顏色同焦點基調條（負面 danger、正面 accent、正反並陳 mixed、中性 muted），1px 同色外框、不用實心底；群組代表列顯示代表報導的基調，展開的子報導各自顯示。未篩選話題時不顯示（避免清單雜訊）。
- 目的：使用者能看出「負面 15」是哪 15 則，自己判斷模型準不準。
- 驗收：後半單元測試（成員才有、無結果不出現、預留）；前半測試（只在話題篩選中出現、無效值忽略、子報導）；真殼深淺截圖由 cc-mod 審。

> R14-B 的負面 danger 色已由 §18.35 取代：基調小標使用 --nw-tone-neg，深墨色／深色主題亮灰，不使用紅綠。

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

> R15-B 的統計時機已由 §18.32 取代：等待該輪在途、待接收結果與佇列全部清空，再寫一次。
> R15-B「請求次數」口徑已由 §18.38 取代：計算准入的模型批次；§18.31 的 429／529 HTTP 重試包含在同一批，不另加 requests 或各類計數。§18.37 規定已記錄的 work 不再登記，避免重複統計行。

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

> R16-B 的清單議題小標顯示條件已由 §18.22 取代：只有類別篩選為政治時顯示，全部類別及話題檢視不顯示。

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

> R17-A「取消話題篩選」維持原文的敘述已由 §18.21 取代：按鈕改為「返回」，補充說明為「回到進入話題前的篩選與位置」。

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

> R19-A 的摘要 key 與清理時機已由 §18.25 取代：無事件 id 時用 link＋source＋title，空 link 不記住；依整份 items 清理，暫時篩掉不清除。

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

> R20-B 的 working／paused 判斷與 reason 集合已由 §18.37 取代：有 pending 且仍有排隊或在途工作時為 working，即使已失敗或過期；無工作可推進時為 paused，新增 waiting 與「整理暫停，等待下次更新」。

### 18.21 第 21 輪（看完話題回到原檢視）

第 20 輪結果：話題新進展、整理狀態（真實序列 working→done、錯誤金鑰 working→off）。

**R21-A**
- 進入話題篩選時（從非話題狀態），保存當下檢視：來源、類別、題材／地區／議題篩選、只看追蹤、清單捲動位置（模組根元素最近的可捲動祖先的 scrollTop）、焦點所在元素的身分（沿用 focusIdentity）。
- 以下方式離開話題時**還原**保存的檢視（篩選值若已不存在於選項則略過該項）：「取消話題篩選」按鈕、再按一次同一話題按鈕、話題從列表消失。還原後恢復捲動位置與焦點（找不到就不動）。
- 以下方式離開話題時**不還原**、並丟棄保存：使用者手動改來源或類別、空狀態的「清除篩選」。
- 在話題中切換到另一個話題：保存的仍是最初進入話題前的檢視。
- 「取消話題篩選」按鈕文字改為「返回」，`aria-describedby` 說明「回到進入話題前的篩選與位置」。
- 驗收：前半測試（三種還原路徑、兩種丟棄路徑、話題間切換、選項消失、捲動與焦點恢復）；真殼截圖由 cc-mod 審。

> R21-A 的自動返回焦點與捲動規則已由 §18.25、§18.38 取代：原焦點在模組外時不還原焦點／捲動；在模組內則依保存身分、目前身分恢復，皆找不到時保底到清單容器。手動返回仍依使用者操作還原原檢視。

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

> R25-3、R25-4 的自動返回規則已由 §18.38 R38-B 取代：原焦點在模組內且兩種身分皆找不到時，移到 tabindex=-1 的清單容器；原焦點在模組外（含 body）時不移動焦點或捲動。

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

> R29-A「第一個非空佇列」已由 §18.38 取代：第 37 輪的實際准入條件還要求佇列頭 work.admitted 必須為 true；初始 list／publish 送入 Outbox 前暫不准入，拒收會撤回待辦。

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

### 18.31 第 31 輪（並行準備：可重入用戶端、429/529 退避）

第 30 輪結果：焦點優先序（焦點大話題 ~32→~20–24 秒）。
**claude-jevmodel 回覆（22:4x，含實測）**：同一 key 12 個並發請求總時間 ≈ 單一請求、無 429；超限回 429 或 529，**不帶 Retry-After、無 rate-limit header**，須反應式指數退避；官方限制可能無預警調整；每請求 64k tokens 上限，目前 20 則 ≈ 6k tokens。建議先做 2～3 條並行（預估一輪 40 秒 → ~14 秒），暫不放大批次（準確率風險）。
**阻礙**：`Analyzer` 以 `self._kind`、`EventMatcher` 以 `self._pending` 保存當次請求狀態 → 同一物件不可同時呼叫。

**R31-A 用戶端可重入**
- `_ChoiceClient._request(batch, context=None)`；`_questions(size, context)`、`_decode(batch, answers, context)` 由參數取得當次資料，不得寫入任何實例屬性。Analyzer 的 kind、EventMatcher 的 pending pairs 改走 context。
- 共享的只有：設定（endpoint/key/timeout…）、opener、`_state`（enabled）。`_state.enabled` 的寫入（401/403）用鎖或原子賦值，說明為何安全。
- 驗收：單元測試以兩條執行緒同時呼叫同一 Analyzer（finance 與 world）與同一 EventMatcher（不同 pairs），假 server 延遲回應並依題目回答 → 兩邊結果各自正確、不交錯。

**R31-B 429/529 退避**
- 回應 429 或 529：在該請求的 `read_deadline` 內重試，最多 2 次，等待 0.5 秒、1 秒（可注入 sleep 以利測試）；仍失敗則照一般失敗處理。log 固定字串「{label}: rate limited, retry」／「{label}: rate limited」，不含任何回應內容。401/403 行為不變（關閉，不重試）。
- 驗收：單元測試（429→200 成功、529×3 失敗、超過 read_deadline 不再重試、401 不重試）。
- 本輪**不改**排程（仍單一 worker），真實跑結果應與現在一致（cc-mod 驗請求數與結果）。

> 本節結尾「仍單一 worker」已由 §18.32 取代：3 條模型 worker 並行。

### 18.32 第 32 輪（模型請求 3 條並行）

第 31 輪結果：用戶端可重入、429/529 退避（真實跑行為與請求數不變）。

**R32-A 多個模型 worker**
- `MODEL_WORKERS = 3`：啟動 3 條 daemon 執行緒（名稱 `news-classify-1..3`），執行同一個 worker 迴圈。
- 選工作：在 cv 下，取優先序最高、佇列非空的 lane（順序同 §18.30）；同一 lane 可同時有多批在途（用戶端已可重入）。
- **維持的規則**（逐條要有測試）：
  1. 等待規則：`self.results` 中有未接收的 Classify/Event/Topic 結果時，worker 不取新工作（讓協調者先重算話題、排後續）。
  2. 在途集合（in_flight 各集合）防止同一 key／pair 重複被問；多 worker 下不得重複請求。
  3. 預算：每輪 60 秒為**准入**上限（取批次時判斷），在途的請求可以完成；同一輪任一批失敗 → `work.failed`，之後不再准入，但已在途的批次回來時結果照常接收。
  4. 401/403：任一 worker 關閉後，其他 worker 不再准入。
  5. stop：所有 worker 結束，不 join 被網路卡住的執行緒（同 fetch worker 政策）。
  6. 統計行：`work.running` 改為在途計數；一輪仍只寫一行，requests 為所有 worker 合計。
- 驗收：
  - 單元測試：假用戶端延遲回應 → 同時在途批次數達到 3；優先序（有高優先工作時新空出的 worker 先取高優先）；等待規則；在途去重；失敗停止准入但在途結果被接收；401 關閉；stop；統計行合計且只一行。
  - cc-mod 真實跑 3 次：全部完成時間、各類請求數、所有 pending 歸零、分類 300／話題大小與單 worker 相當；另跑 12 分鐘確認自動更新輪正常。

> R32-A 選 lane 規則已由 §18.38 取代：還須通過 work.admitted 初始列表准入閘門，詳見 §18.29 的追註。

### 18.33 第 33 輪（刁鑽資料壓測修正，後半）

第 32 輪結果：模型 3 條並行（41→15 秒、焦點 24→9 秒）；README 補齊。前半效能：單次完整重畫 10ms、CPU 4x 降速 42ms，不改。
**壓測（cx-mod，22:3x，腳本在 scratchpad/r33_*.py）**：4 條中度，皆可重現。

**R33-1 短標題不得自動合併**（events.py:42、62）：兩標題 bigram 集合較小者 < 6 個時，重疊係數再高也**不自動合併**（不走 ≥0.9 的直接合併）；仍可成為候選交由 jev 判斷（門檻 0.2 照舊）。
**R33-2 first_seen 容量淘汰不得連鎖**（feedparse.py:221–225）：本輪查詢上一輪的 first_seen 與本輪新增／淘汰分開進行（先以舊表查完全部，再寫入新表並依容量淘汰），淘汰只影響真正最舊的項目。
**R33-3 未來日期上限**：發布時間比目前時間晚超過 1 小時者，視為不可信：改用 first_seen（推定時間，`time_guessed=true`）。
**R33-4 比對用正規化去除零寬字元**：事件 `_bigrams` 與話題 `words()` 在比對前移除 U+200B、U+200C、U+2060、U+FEFF（**不移除** U+200D ZWJ，以免破壞 emoji 序列）；顯示文字不變。
- 驗收：各一個單元測試（可直接改寫 r33_* 腳本）；既有事件自動合併的測試不得因 R33-1 失效（真實制式短標題若受影響需說明）；cc-mod 真實跑比對事件數與話題不退步。

### 18.34 第 34 輪（開發工具：真實端到端腳本進 repo）

第 33 輪結果：壓測 4 條修正（審核抓到 automatic 重算 bigram 的效能退化並修正）。並行耐久 22 分鐘 3 輪全正常。
**動機**：本次進化每輪都靠 repo 外的臨時腳本做真 API 滿額驗證（~/.claude/.../evolve/run_e2e.py、ttf.py）；下次開發拿不到。

**R34-A `scripts/real_run.py`**（純 stdlib，/usr/local/bin/python3 可跑）
- 以 stdio 協定啟動 `back/news.py`（hello→up），印出每份列表的時間線（秒數、各類 pending、topics 清單摘要、model.state），直到 `model.state == "done"`／`"off"` 或逾時（`--timeout`，預設 120 秒），送 bye 並等待退出。
- 結束時印摘要：首份列表時間、全部完成時間、焦點首次出現 ≥N 則話題的時間（`--topic-min`，預設 20）、分類／分析完成數、事件數與多報導事件數、話題清單（則數／家數／基調）、stderr 中的 `model round=` 行。
- `--save OUT.json` 另存最後一份列表；`--root` 指定模組目錄（預設 repo 根）。
- 不印 API key、不印新聞內容以外的敏感資訊；沒有 key 時照常跑（只驗 RSS 與協定）。
- README「本機開發」加一段用法（會實際呼叫 jev API、產生費用）。
- 驗收：cc-mod 用它跑一次真 API，輸出與 evolve 臨時腳本一致。

### 18.35 第 35 輪（視覺巡檢：基調色與股市色衝突）

第 34 輪結果：scripts/real_run.py（審核修正 seq）。
**巡檢發現（23:5x，財經檢視）**：焦點基調條的「負面」用 danger 紅，正下方股市訊號條依台股慣例「紅＝上漲」，兩條紅並排語意相反。
**R35-A**：新增 `--nw-tone-neg: color-mix(in srgb, var(--nw-fg) 78%, transparent)`（深墨色；深色主題為亮灰），基調條與基調小標的負面改用它；基調不再使用任何紅或綠。§18.8 R8-B 已註記。
**另發現（殼）**：`/modules/` 靜態檔無 Cache-Control，只改子模組（style.js）時瀏覽器可能沿用舊檔；已轉告 claude-modudock（建議 `Cache-Control: no-cache`）。驗收截圖以停用快取的瀏覽器進行。

### 18.36 第 36 輪（近 24 小時在樣本少時收合）

第 35 輪結果：基調負面改深墨色。
**巡檢發現（00:0x，國際檢視）**：國際只有 17 個事件，近 24 小時 4 段中 3 段「樣本不足」，整塊是空灰條，佔版面無資訊。
**R36-A**：4 段中有 ≥3 段樣本不足時，「近 24 小時」只顯示標題＋一行 `nw-hint`「樣本不足，無法比較 24 小時內的變化」，不畫四列；否則照舊。財經／國際共用規則。
- 驗收：前半測試（3 段不足→收合、2 段不足→照舊四列）；真殼截圖由 cc-mod 審。

### 18.37 第 37 輪（後半第二次獨立審查：並行與邊界）

第 36 輪結果：近 24 小時樣本少時收合。深夜真實跑正常（16 秒完成、焦點 9 秒）。
**後半第二次獨立審查（agent，00:1x，重點並行）**：鎖順序、死鎖、重複請求、計數器、429 重試、stop、900KB 預留皆無問題。3 條中度，皆有腳本（scratchpad/r1_stuck_working.py、r2_events_overflow.py、r4_first_seen.py）。

**R37-1 前後輪重疊時不得漏做、不得卡在 working**
- 舊輪 in_flight 的 key 被新輪跳過；舊輪那批失敗／過期／被丟棄時，釋放 in_flight 的同時，若目前的 `self.model_work` 仍可准入（未失敗、未過期），就把這些 key（classify／analysis／events／topics／tone 各自）以**目前的 work** 重新排入。
- 舊輪過期但分類成功時，後續分析以**目前的 work** 排入（不用已過期的 candidate.work）。
**R37-2 配對候選不得因佇列滿而永久遺漏**
- 每次接收 EventResult 後，補排「未快取、未在途、未排入」的候選配對到目前 work（佇列有空位就補），直到全部問完或預算用完。
**R37-3 model.state 反映實際能否前進**
- `working` 只在「有排隊或在途的模型工作」時成立；pending>0 但沒有任何排隊／在途工作 → `paused`，reason 為 `budget`（本輪預算已過）、`failed`（本輪失敗）或 `waiting`（等下一輪）。
- 協調者在目前 work 的 deadline 到期時醒來一次；若 model.state 因此改變，非 active 時補送一次（不必等結果到來）。
- 同一輪統計行只寫一次（已寫過的 work 不再放回 model_rounds）。
**R37-4 first_seen 以最近使用淘汰**
- first_seen 命中時 `move_to_end`（LRU）；淘汰最久未出現在任何 feed 的項目，仍在 feed 裡的項目不被淘汰。
- 驗收：四條各有測試（可直接改寫審查腳本）；前半「整理暫停」文字新增 reason `waiting`：「等待下次更新」。真實跑由 cc-mod 驗：正常一輪結束為 done；手動在處理中按 refresh 最後仍到 done。

> R37-4「仍在 feed 裡的項目不被淘汰」已由 §18.38 取代：每來源 first_seen 上限仍為 1000；LRU 優先保留最近出現者，但單輪超過 1000 個需記錄的 key 時，仍會淘汰本輪較早處理的項目。

### 18.38 第 38 輪（文件與程式一致性、焦點最後保底）

第 37 輪結果：後半第二次審查修正（真 API 中途重新整理驗證 15.6 秒 done）。最終變異掃描 後半 0/15、前半 0/12。
**一致性比對（cx-mod，00:4x）**：26 條不一致；25 條是文件（被後續輪次改掉但前文未加註、README 漏寫），1 條是程式（R25-3「不得落到 body」未達成）。

**R38-A 文件同步**：§18.1～§18.37 中被後續輪次取代的敘述，在原段落加註「已由 §18.x 取代：…」（不刪原文，保留演進紀錄）；README 依程式修正（短標題不自動合併、地區「其他」固定最後、閱讀基準的保存規則、first_seen 1000 筆上限內的 LRU 等）。
**R38-B 焦點最後保底**：補送或自動返回重畫後，若原焦點在模組內、而保存的身分與目前焦點身分都找不到，焦點移到清單容器（`list` 加 `tabindex="-1"`，`focus({preventScroll:true})`），不落到 body；若原焦點不在模組內，照舊不動。
- 驗收：前半測試（話題與原連結同時消失 → activeElement 為清單）；文件以 cx-mod 清單逐條核對。

### 18.39 第 39 輪（焦點話題顯示最新進展標題）

第 38 輪結果：文件與程式對齊、焦點保底。最終耐久 22 分鐘三輪正常；測試 5 次＋3 份並跑皆綠。
**觀察**：持續發展的大話題（例：習近平訪美，早上到晚上 40+ 則），焦點列顯示的是種子報導標題（通常是較早的報導），看不出最新發展。

**R39-A**
- 焦點話題列，在標題下方（基調行之前）加一行小字：「最新：{話題成員中 published 最新的那則標題}」（`nw-hint`，單行、超出以 `text-overflow: ellipsis` 截斷、`title` 屬性為完整標題）；該則若與種子標題相同、或與種子代表屬於同一事件（只是另一家媒體的同一則新聞）則不顯示。
- 最新那則若比 lastSeen 新，這一行前面加「新」（沿用 nw-new 樣式）。
- 只用 textContent；話題成員依 items 中 `topic === id` 取得。
- 驗收：前半測試（顯示／不顯示條件、截斷與 title、新標記）；真殼截圖由 cc-mod 審。

### 18.40 第 40 輪（清單鍵盤快速瀏覽）

第 39 輪結果：焦點話題「最新：…」（審核：同事件不重複顯示）。
**動機**：每天快速掃新聞時，鍵盤使用者只能用 Tab 在標題、摘要、展開按鈕之間逐一跳，一列要按 2～4 次。

**R40-A**
- 只在 `root.contains(event.target)` 且 target 不是 input／select／textarea／contenteditable、且沒有按 Ctrl／Meta／Alt 時生效；其他情況完全不攔截（不影響殼與其他模組）。在模組根元素上監聽 keydown（不掛 window／document）。
- `j`：焦點移到下一列的標題連結（從目前焦點所在列往下找；焦點不在任何列時到第一列）；`k`：上一列。移動後 `scrollIntoView({block: "nearest"})`。分隔線與子報導列略過。
- `s`：切換目前列的摘要（等同按「摘要」）；`e`：切換目前列的「另 N 則報導」。該列沒有對應按鈕時不動作。
- 有處理的按鍵呼叫 `preventDefault()`；其他按鍵不攔。
- 清單加 `aria-keyshortcuts="j k s e"`；README 補一行說明。
- unmount 移除監聽。
- 驗收：前半測試（j/k 移動與邊界、略過分隔線、s/e 切換、在 input 中不攔、帶修飾鍵不攔、unmount 後不作用）。

### 18.41 第 41 輪（前半第三次獨立審查修正）

第 40 輪結果：鍵盤快速瀏覽（真殼實測）。
**前半第三次獨立審查（agent，01:3x，範圍第 26～40 輪）**：5 條中度（3 條 happy-dom 重現：t4.mjs、t5.mjs；2 條需實機）。

**R41-1 收合時焦點不留在隱藏區塊**：`e` 或點「另 N 則報導」收合時，若焦點在該列 `.nw-reports` 內，先把焦點移到該列的 `.nw-expand`。
**R41-2 焦點保底涵蓋隱藏／停用元素**：§18.38 的保底條件加上「activeElement 位於 `[hidden]` 祖先內或為 disabled」，符合時移到清單容器。
**R41-3 重新整理忙碌中保持可聚焦**：忙碌狀態改用 `aria-disabled="true"`（不設 disabled），`onRefresh` 在忙碌時直接忽略；樣式沿用 disabled 外觀。
**R41-4 逾時提示持續到真的有新列表**：「更新未完成，稍後自動重試」只在收到 `at` 與上次不同的列表時清除（同一輪的補送不清）；§18.28 同步加註。
**R41-5 選項文字不變就不寫**：更新選單數量時 `if (option.textContent !== next) option.textContent = next`。
- 驗收：五條各一個前半測試（R41-3 驗 aria-disabled 與忙碌時點擊無效；R41-5 以 MutationObserver 驗相同內容補送零變動）；cc-mod 真殼驗鍵盤按 Enter 重新整理後焦點仍在按鈕上。

### 18.42 第 42 輪（只給日期的來源改以來源整體判斷）

第 41 輪結果：前半第三次審查 5 條修正。最終驗收（第一次）：後半 331／前半 149 全綠、變異 0、真 API 16 秒完成。
**觀察（真殼，系統時間 00:08）**：自由時報一則在當地 00:00:00 發布的新聞顯示為「今天」。§18.3 R3-B 以「單則時間剛好 00:00:00」判斷只給日期，真實的午夜新聞會被誤判。

**R42-A**：「只給日期」改為**來源層級**判斷——同一來源在目前列表中，published 為當地 00:00:00 的比例 ≥80% 且至少 3 則，才把該來源的 00:00:00 項目視為只給日期（顯示「今天」或 M/D）；否則照一般時間顯示（00:00）。判斷隨每份列表重算。
- 驗收：前半測試（報導者型來源 3/3 午夜→日期；自由時報型 1/40 午夜→顯示 00:00；只有 2 則的來源不判定）；§18.3 R3-B 加註已由本節取代。

### 18.43 第 43 輪（減少首頁理解成本）

第 42 輪結果：只給日期改來源層級判斷。CPU 量測：完整一輪 3.8s CPU（單核 24%），不優化。不做「題材升溫」（近 6 小時樣本太少）。
cx-mod 第二次使用者走查（00:12）5 條；採用 2、3、4、5，**不採用 1**（把基調條移出焦點）——基調是用戶在意的風向資訊，首頁一眼可見是它的價值。

**R43-A 入口文字明示動作**：焦點話題按鈕可見文字「看話題・N 家」（窄版「N 家」照舊）、事件回退按鈕「看同事件・N 家」；話題篩選的「返回」改為「返回原檢視」。describedby 內容相應調整（名稱仍為可見文字）。
**R43-B 分隔線與新增數用詞**：分隔線文字改為「以下為上次離開前的新聞」（aria-label 同義）；狀態列「N 則新」改為「新增 N 個事件」，焦點「上次之後新增 N 個事件」維持。
**R43-C 面板減量**：「待分析 N」只在 N>0 時顯示；「近 24 小時」改為可展開區塊——標題列為按鈕「近 24 小時變化」（`aria-expanded`，預設收起；以 ::after 的 ▸／▾ 提示可展開），展開後才畫各段或樣本不足提示；展開狀態存 `loadState/saveState("history")`（布林），跨類別共用。
**R43-D 只看追蹤時收起焦點與面板**：「只看追蹤」開啟時，焦點區與分析面板隱藏，清單上方顯示一行 `nw-hint`「只看追蹤：{關鍵字們}」；關閉時恢復。
- 驗收：前半測試（各條文字與顯示條件、history 展開狀態保存與讀取失敗、只看追蹤的收起與恢復）；真殼深淺截圖由 cc-mod 審。

### 18.44 第 44 輪（分類關閉時說明原因）

第 43 輪結果：首頁理解成本（入口文字、分隔線用詞、面板減量、只看追蹤收起）。
**觀察**：模組是公開 repo，沒有 key 的使用者只看到「分類：關閉」，不知道原因、也不知道怎麼開。

**R44-A 後半**：`model.reason` 在 `off` 時細分為 `no_key`（啟動時沒有 TYPESAFE_API_KEY）與 `auth`（收到 401/403 後關閉）；其他語意不變。固定字串，不含任何回應內容或 key。
**R44-B 前半**：狀態列「分類：關閉」依 reason 改為「分類未啟用：未設定 API 金鑰」或「分類已停用：API 金鑰無效」；該元素 `title` 補一句「設定 TYPESAFE_API_KEY 後重新載入模組」（no_key）或「請確認金鑰後重新載入模組」（auth）。reason 缺失時維持「分類：關閉」。
- 驗收：後半測試（no_key、401、403 的 reason）；前半測試（三種文字與 title）；cc-mod 真實跑無 key 與錯誤 key 各一次。

### 18.45 第 45 輪（記住上次的來源與類別）

第 44 輪結果：分類關閉時說明原因（真實跑 no_key／auth）。
**動機**：每天固定看某一類（例如財經）的使用者，每次開啟都要重選。

**R45-A**
- 使用者**手動**改來源或類別時，以 `saveState("view", {source, category})` 保存（話題進出、清除篩選造成的變更不保存）。
- mount 時讀取；收到第一份列表後，若保存的來源／類別仍存在於選項中就套用（不存在則忽略該項），之後照常運作。
- 題材／話題／只看追蹤不記住（它們依當天資料而定）。
- 讀寫失敗靜默忽略；key 同樣是 `modudock.module.news.view`。
- 驗收：前半測試（保存時機、重新 mount 後套用、選項不存在時忽略、話題與清除篩選不保存、localStorage 丟例外）；README 本機儲存一節補上。

### 18.46 第 46 輪（記住類別的兩個邊界）

第 45 輪結果：記住來源與類別（真殼驗證）。
**審查（agent，00:3x）**：2 條中度皆重現（scratchpad/t6.mjs、t7.mjs）；其餘（只套一次、不該存的不存、只看追蹤＋題材、展開按鈕焦點、j/k、名稱、後端 reason）無問題。

**R46-1 記住的類別延後到分類可用時才套用**：記住的**來源**照舊在第一份列表套用；記住的**類別**等到出現第一份「至少一則 item 有 category」的列表才套用；`classify.enabled === false` 時永不套用；在套用前使用者手動改了類別就放棄套用。另外，已選特定類別且 `model.state === "working"` 而清單為空時，空狀態文字改為「分類中，稍後出現」。
**R46-2 只保存使用者實際改動的那一欄**：手動改來源只更新 view.source、改類別只更新 view.category（以既存值為基底合併），避免把話題暫時清空的值寫入。
- 驗收：前半測試（改寫 t6/t7 情境）；§18.45 加註。

## 19. v0.6 現行行為總覽

本節以第 46 輪收件後的程式（`452628d`）建立，並於 §20.18 依 `a00347c` 的前後半重新核對（涵蓋 §20.1～§20.17），是閱讀目前行為的入口。§18 保留演進過程；若舊文與本節不同，以本節描述的現行實作為準。API 題目與 criteria 的逐字定義仍見 §12.2／§12.5、§13.3、§16.2、§17.1、§18.5／§18.8／§18.16；本節不重新改寫題目。下列出處同時標示必要的早期基礎規格，避免誤把所有功能都歸於 §18。

### 19.1 資料流與後半

- **入口與抓取**：`back/news.py` 處理 stdio 協定；hello／up／bye 使用同一 session seq。四條 daemon RSS worker 抓 `back/feeds.json`，協調者擁有來源快取與列表；預設每輪結束後 600 秒再抓，refresh 可提前觸發，進行中則合併為下一輪 refresh。每來源工作開始後有 30 秒期限，整輪 60 秒；過期抓取結果不提交到新輪。304 沿用快取；每來源另由協調者記錄最後成功確認時間 `last_success`（ISO 字串，從未成功為 null），成功解析或有效 304 接收時更新，失敗、過期或舊輪候選不更新。抓取／解析失敗可繼續列出上一份成功資料，sources 帶出確認時間供前半標示沿用；這不是報導發布時間。（出處：§20.3）模型工作不阻擋首份新聞列表。Fetcher 使用 ETag／Last-Modified 條件請求、15 秒 socket timeout、30 秒讀取期限、2 MiB body 上限，拒絕 Content-Encoding，目的地與 redirect 依既有 SSRF／TLS 規則檢查。（出處：§5、§6、§18.24、§18.34、§18.37）
- **解析與列表名額**：RSS／Atom 正規化 title、link、published、summary、source、time_guessed；標題最多 300 字、摘要 200 字，原始欄位先截 8192 字元再以線性掃描去 HTML 標籤，不再交 HTMLParser；不完整片段只在原處處理，不把整欄退回 HTML；截斷屬性尾標籤丟棄、非標籤的 < 留作文字、未知 <![…]> 宣告丟棄（§20.6）。僅收可解析的 HTTP(S) 連結，相對路徑依最後 feed URL 解開。合併依 dedup key 去重：同來源取較新報導；跨來源優先選連結主機屬於該來源受信任網域者，再按 feeds.json 順序，發布時間不能跨來源搶所有權。去重後每來源先保留最新 min(3, 則數)，餘額按時間填入，每來源最多 60 則，最後仍新到舊排序。`MAX_ITEMS_LIST=300` 是列表與一般模型佇列共同上限；保底名額不能突破總上限，封包守衛仍可裁切。（出處：§5.6、§13.2、§18.1、§18.33、§18.50、§20.2）
- **來源信任與解析安全**：來源網域取本機 feeds.json 的 `link_domains`（可選小寫 DNS 名稱陣列），未提供則用設定 feed URL 的主機去掉開頭 www；連結主機須完全相同或以「.網域」結尾，不能只比字串尾綴。不信任 feed 本文／redirect URL 宣告的擁有者。中央社三份 FeedBurner 來源明列 cna.com.tw，BBC 明列 bbc.com／bbc.co.uk；這只控制去重歸屬，不豁免抓取 SSRF／TLS 檢查。主機字元白名單與禁止 HTTPS→HTTP 轉址依 §18.50。HTML 正常實體解碼、段落空白、script/style 原文處理與既有 fixture／真實快照相容；畸形片段依 §20.6 局部保留或丟棄，並非整欄回退；保留的字面文字仍以 textContent 顯示。整份 2 MiB 惡意 feed、多種未閉合與密集標籤測試要求解析 CPU<2 秒，不依計時器或只解析前 N 則截掉新聞。（出處：§18.50、§20.2、§20.6）
- **媒體與 feed 身分**：feeds.json 可填 `outlet`（1～64 字、不得全為空白或帶頭尾空白），未填以 name 為媒體身分；sources 狀態永遠帶 outlet。中央社政治／財經／國際共用「中央社」，經濟日報證券／產業共用「經濟日報」。所有「家」的門檻、排名與顯示以 outlet 去重，包括新話題種子、話題最終門檻、topic.sources、配對未完成時舊話題重算、前半事件焦點與話題分布。來源下拉、來源錯誤、每 feed 保底／上限及面板「個來源」仍指 feed，不改代表的 feeds 順序。（出處：§20.4 R4-A）
- **日期與 first_seen**：後半日期無時區時按 UTC 解讀；無效／缺日期或晚於目前時間超過十分鐘，改用該來源 first_seen 並標 `time_guessed=true`，恰好晚十分鐘仍有效。first_seen 每來源最多 1000 筆，命中移到尾端，整份 feed 查完才淘汰最久未使用者；處理不直接修改傳入快取，須由協調者接收結果才提交。單輪超過容量仍可能淘汰當輪較早處理的 key。（出處：§5.6、§18.33、§18.37、§18.38、§18.50）
- **分類**：九類固定為 politics、finance、tech、world、society、life、sports、entertainment、other；未完成為空字串。jev 模型固定 `jev-1.13.0`，state 是 `news_n → {title, summary}` 物件，每題 instructions 點名自己的 news_n。一般文字批次最多 20 則、標題＋摘要合計 8000 字；分類 p_max<0.35 歸 other，等於 0.35 可採納。（出處：§12.2、§12.5；§18.1、§18.31 延續此契約）
- **分析**：只分析 finance／tech／world／politics；財經與科技共用 finance kind（market、theme、dir、dir_p），國際為 world（trend、region），政治為 politics（issue）。同一請求只含同一 kind，從佇列頭的 kind 往後收同一 work 的項目，不同 kind 留在原相對順序。低信心依各題 abstain 值處理；財經 dir_p 保留並四捨五入至兩位。已知可分析類別與快取 kind 不相容時刪快取重排；類別未知或不需分析時不顯示，但保留快取。晚到結果須通過完整分析驗證，且 kind 等於接收時的 analysis_kind(category) 才採納；此函式對 world／politics 以外（含未知類別）回 finance。既有快取在未知類別時保留，與晚到結果的准入是兩個步驟。（出處：§13.3、§17.1、§18.1、§18.2、§18.16、§18.38）
- **同事件配對**：以標題 bigram 重疊係數產生相差不超過 36h、係數≥0.2 的候選；係數≥0.9 且兩標題較小的 bigram 集合至少 6 個才自動 same。其餘問 jev，same 且 p_max≥0.8 才合併；批次 state≤20 則、配對題≤40、字數≤8000。union-find 依固定邊順序合併，群組最早到最晚不得超過 24h；代表取最早、同時按 feeds 順序，event id 為代表 dedup key 的 SHA-1 前 12 碼。關閉 API 仍可自動合併。（出處：§16.2～§16.5、§18.33）
- **比對正規化與話題種子**：事件與話題比對移除 U+200B／U+200C／U+2060／U+FEFF，保留 ZWJ，顯示文字不改。話題另做「特朗普→川普」「特習→川習」；英文／數字連串至少兩字、純數字排除，中文取 2～4 字片段，只保留在目前列表出現比例≤10% 的特徵詞。新種子事件需至少三家不同 outlet，按 outlet 家數多、最新時間新、id 排序。（家數修正見 §20.4 R4-A）（出處：§18.5、§18.9、§18.18、§18.33）
- **話題擴展與穩定身分**：上一份已送出列表仍存在的 seed key 優先嘗試，但不保證入選名額。候選與種子事件最新時間相差≤48h，且與目前成員共用特徵詞；種子事件成員照舊直接納入；非種子候選只納入自身已快取 true 的報導，不繼承同事件其他成員。已有成員的同事件兄弟篇可不共用詞，但仍須在 48h 窗內，各自查答案或排待問，並優先於一般候選。每次 plan、每種子最多列 60 個待問候選，同優先層依共用詞多、時間新、key 排序（§20.36）；答案回來可再 plan。每批一個種子＋最多 19 候選、≤8000 字，same_topic 且 p_max≥0.7 採納。最多建 10 個話題，再按家數、則數、id 取 5 個，僅保留入選者待問；話題 id 是 seed key 的 SHA-1 前 12 碼。previous 種子擴展後仍須至少三家。（出處：§18.5、§18.7、§18.12、§18.18）
- **配對完成前的話題**：events.pending 尚未歸零時不重新 plan 話題，也不開始新的話題請求；保留上次話題，依本份列表仍存在的成員重算數量，仍須至少三家不同 outlet 才保留。配對完成才更新話題；種子若被裁掉，不再保留黏著身分。跨輪舊話題也遵守此限制：worker 等待配對在途工作與結果提交；配對已結束但仍有未解決候選時，不發話題請求，釋放舊工作供下一輪重排（§20.19）。（出處：§18.7、§18.9、§18.12、§18.30、§18.37）
- **報導基調**：只為目前話題成員分析 positive／negative／neutral／mixed；p_max<0.35 歸 neutral。成功後成員 item 才有 tone，話題 tone 按報導數聚合，並提供 tone_pending；不是民意、政治立場或事件真相判斷。（出處：§18.8、§18.14、§18.35）
- **快取與有界工作**：分類／分析／基調快取各 4000、配對／話題快取各 20000，皆 FIFO、只存成功結果（配對與話題的 false 也是成功判斷）。一般工作佇列各 300、配對 600；各類 in-flight 同時涵蓋排隊與已取走工作，避免重問，完成／失敗均釋放。配對結果接收後會補排溢出的候選。來源快取、模型快取、分群與列表由協調者管理；worker 只回候選，results 上限 32。（出處：§12.3、§13.4、§16.4、§18.5、§18.8、§18.32、§18.37）
- **並行與優先序**：啟用時固定三條 `news-classify-1..3` daemon worker，以 lanes 表按「分類 > 配對 > 話題 > 分析 > 基調」選下一批；同 lane 可多批在途，不中斷已開始的低優先請求。cv 下取批，若 results 有未接收的 Classify／Event／Topic 結果，先讓協調者接收再選工作。初始列表尚未獲 Outbox 接收時 work 不准入，拒收則撤回待辦；無 key 不啟動模型 worker。（出處：§18.12、§18.29～§18.32、§18.37、§18.38）
- **預算與跨輪接手**：一輪模型工作從第一批准入起共用 60 秒准入預算；在途請求可超過此時點完成。任一批失敗即停止該 work 的新准入，其他在途成功仍可採納；晚到模型結果不因舊輪 id 而一律丟棄。新輪若先因舊輪 in-flight 跳過某 key，舊結果回來／失敗後會在目前 work 仍可准入且有 last_list 的條件下重排未完成工作；active 抓取期間不補送列表，下一次 emit 帶快取結果。（出處：§12.6、§18.2、§18.32、§18.37）
- **HTTP 與驗證**：五種 client 共用設定與 enabled 狀態，每次請求的 context 分開，不把批次狀態留在實例。SSL 驗證保持開啟，沿用 Fetcher 的 CA 做法、不跟隨模型 redirect；單次 socket timeout 15 秒，body 讀取總時限預設 30 秒（送出前起算），回應上限 1 MiB。所需每題都要通過驗證，任一題失敗整批不採納；choice 須在 criteria 中，probabilities 須為非空物件，值須是非 bool 的有限 0～1 數值。現行不要求機率總和為 1，也不要求 choice 等於機率最大者。（出處：§12.5、§18.2、§18.31）
- **關閉與退避**：只從 TYPESAFE_API_KEY 啟用，無 key 只記一次 disabled。任一 client 收 401／403，整個 process 的模型工作永久關閉；model.reason 為 auth，啟動無 key 為 no_key。關閉後 `_decorate` 將 item.analysis 設為 null，即使分析快取仍存在，清單分析標籤與面板分析結果也不再顯示；已快取分類、依現存資料成立的話題與已取得基調仍顯示。429／529 在同一 read_deadline 內最多重試兩次，分別等 0.5／1 秒；無 Retry-After 可用，耗盡或其他失敗停止本輪新准入。模型錯誤只記固定字串，不把 key、HTTP body 或例外原文寫入 log。（出處：§18.31、§18.44）
- **停止**：bye 不等待卡住的網路 worker，不 join RSS 或模型執行緒；維持後半一秒內退出的協定政策。這不代表能在 process 存活時強制回收卡住的 DNS／header 請求。（出處：§5、§18.2、§18.32）
- **列表與補送**：每 item 永遠有 category、analysis（null 或物件）、event、event_size；topic／tone 只在適用時出現。body 有 classify、analysis、events、topics、model 的進度。初始 list 後 publish `news.fetched`；補送不改 at、不另 publish。配對結果只有可見 event／event_size 改變、pending 歸零或模型狀態需更新時補送；一般成功結果只影響可見項目時才需補內容。Outbox 對尚未開始寫出的 list 原位取代，同步更新其後對應 publish 的 count／at；put 拒收不更新 last_list。（出處：§12.6、§16.5、§18.9、§18.20、§18.24、§18.37）
- **大小守衛**：model 額外預留 failed 的 failure 固定代碼最長形狀（§20.21）。完整 JSON envelope（ensure_ascii、含換行）限 900 KiB，從 items 尾端裁切。未分類預留最長 category；尚未分析且類別為空或可分析者預留三種 analysis 中最長形狀；event_size 預留三位數，另預留 topic、tone、最多五個話題與 model 狀態。裁切後重算來源 count、classify／analysis pending、event_size，協調者再裝飾事件／話題進度。補送理應不減少首次已送 items；若仍裁切，stderr 記一行後照送，不 raise。空 items 的 envelope 仍超限則拒送。（出處：§12.3、§13.4、§16.5、§18.5、§18.14、§18.16、§18.20）
- **stderr 統計**：有模型准入的 work 在 queued／running／awaiting 均清空後，僅寫一次 `model round={id} requests={n} failed={m} elapsed={s:.1f}s classify={a} analysis={b} events={c} topics={d} tone={e}`。requests 是准入批次數，429／529 的 HTTP 重試不另加；行尾另附 http（實際 HTTP 嘗試）、retries（其中重試次數）、total_http／total_retries（本 process 已發起的累計嘗試與重試，跨輪可能包含其他在途 work）。三 worker 以每次呼叫的 context 綁定原 work，重試不改歸到新輪。沒有模型請求的輪次不寫（§20.20）。內容不含新聞、URL 或 key。（出處：§18.15、§18.31、§18.32、§18.37、§18.38）

`body.model` 的現行判斷順序如下；pending 指 classify／analysis／events／topics.pending 與 topics.tone_pending 的任一正值。（出處：§18.20、§18.37、§18.44）

| state | reason | 實際條件 | 前半文字 |
|---|---|---|---|
| off | no_key／auth | 共用模型開關關閉，優先於 pending 判斷 | 分類未啟用：未設定 API 金鑰／分類已停用：API 金鑰無效 |
| done | 空字串 | API 開啟且所有上述 pending 為 0 | 不加整理文字 |
| working | 空字串 | 尚有 pending，且任一模型佇列或 in-flight 集合非空 | 整理中 |
| paused | failed | 沒有上述排隊／在途工作，本 work 失敗；有失敗次數時優先於預算原因；failure=busy／connection／response／other，title 與 describedby 提供原因與建議（§20.21） | 整理暫停，下次更新繼續 |
| paused | budget | 沒有上述工作，本 work 已過 deadline，且未以 failed 優先判定 | 整理暫停，下次更新繼續 |
| paused | waiting | 尚有 pending，但沒有工作、失敗或逾時可解釋 | 整理暫停，等待下次更新 |

### 19.2 前半

- **結構與樣式**：`front.js` 管 mount／狀態／DOM，`style.js` 匯出 scoped CSS，`labels.js` 放固定名稱與無狀態驗證。style 放模組根 section.nw，CSS 不操作殼或 document.head；根 `.nw` 設 position:relative，讓 `.nw-sr` 與窄版快捷鍵隱藏名稱的 absolute 定位留在模組內；隱藏文字使用 1px、clip／clip-path、overflow:hidden、white-space:nowrap，不用 display:none（§20.17）。吃 --md-* token、light-dark 深淺色、ResizeObserver 驅動的窄版／排行 class，含 20px 遲滯（§20.27）。工具列、篩選與列文字同左緣；財經紅漲綠跌，國際升級用 danger、緩和用 accent。基調負面用深墨色／深色亮灰，不借用財經紅綠。（出處：§14、§15、§17.3、§18.22、§18.27、§18.35）
- **工具列**：重新整理、來源、固定十選項的類別、追蹤關鍵字、有關鍵字才顯示的「只看追蹤 N」、可收合搜尋、狀態及快捷鍵入口。來源選項依目前類別範圍計事件數，不使用 body.sources 的報導 count（§20.9）；失敗且有有效 last_success 時附「（HH:mm 資料）」（非本地今天則為「（M/D HH:mm 資料）」），option.title 與來源 select 的 aria-describedby 提供最後成功確認完整本地年月日時分秒與錯誤。從未成功者仍附「（失敗）」，成功（含 304）清除舊資料短註；不按報導日期判失效。（出處：§20.3）採分面計數：來源選項依目前類別、類別選項依目前來源計事件數；全部來源為目前類別的事件總數，全部類別為目前來源的事件總數。不受題材／話題／數字／搜尋／追蹤／新進展限制（§20.9、§20.11）；零值仍可選；同事件可落在多個來源／類別選項，選項數字不能直接相加推算總數。補送保留選值與 select 節點，文字相同不重寫。（出處：§18.19、§18.26、§18.41）
- **重新整理回饋**：up 後可按，點下立即「↻ 更新中…」、aria-disabled=true、清單 aria-busy=true，重複點擊忽略而仍可聚焦。新 at 到來或 30 秒逾時恢復；逾時顯示「更新未完成，稍後自動重試」，同 at 補送不清除，直到不同 at 才清。unmount 清計時器。（出處：§18.28、§18.41）
- **狀態列**：更新時間、逾時提示、整理文字、新增 N 個事件、失敗來源名稱、分類資訊依適用條件組合。失敗且有 last_success 者按來源數顯示「N 個來源沿用舊資料」；從未成功者沿用單一來源名稱／多個首名與總數的失敗文字。部分失敗時兩種可同時顯示。全部來源 ok=false 且至少一個有效 last_success 時，主文字改「更新失敗，沿用 HH:mm 的資料」，採最新一次任何來源成功時間，跨本地日加 M/D；不再以本次 at 顯示「更新」。全未成功則為「尚未取得新聞：所有來源連線失敗；請按「重新整理」重試」。title 列所有失敗來源、各自最後成功確認時間與截短錯誤；恢復任一來源（含 304）後回原狀態（§20.20）。（出處：§20.3）working 隱藏未分類數；其他狀態有 pending 才列。off＋classify.enabled=false 按 reason 顯示金鑰原因，title 提示設定／確認後重新載入；原因缺失或不認得保留「分類：關閉」。（出處：§18.10、§18.20、§18.23、§18.41、§18.43、§18.44）
- **首頁風向速覽**：收到列表後，只在全部類別、未進話題（含話題內數字篩選）、無非空搜尋、非只看追蹤且分類啟用時，於工具列末端／焦點上方顯示財經與國際兩個輕量文字按鈕。財經只計 finance，國際計 world，沿用目前來源與新進展限制，先篩個別報導再分事件、取最早有效分析；與目的類別面板共用計數。開頭明示「新聞風向（非行情）」，兩段為「財經 偏多 X 件・偏空 Y 件」「國際 升級 X 件・緩和 Y 件」，件指事件；該類別已分析合計<10 時在該段末尾加「（樣本少）」，仍列實際方向數。只要尚有缺分析，就在可見文字補「（已分析 X／N）」，新進展開啟時類別名後加「新進展」，不把部分結果當完整風向。點選走手動類別切換流程（含偏好保存），焦點移至類別選單；同／新 at 補送重算。兩段各一顆按鈕，可見文字即名稱，裝飾分隔符在按鈕外；窄版可在「｜國際」前換行，長覆蓋率文字也可換行，不截斷。讀者 A/B 評估已通過，補上主詞、非行情與事件單位以避免誤讀，不增加模型請求（§20.13）。
- **焦點入口**：優先最多五個話題；未處於 selectedTopic 話題檢視時，來源＋類別只決定話題是否有符合成員；話題檢視中保留所有話題入口，內部切類別不隱藏這些入口。題材／數字／搜尋／新進展不篩話題卡，話題家數、基調與新增數仍按整個話題。被過濾光不回退事件焦點。寬窄版皆以「看話題・N 家」進話題（§20.24），標題連結仍開原文；話題 title、最新不同事件的報導標題、基調、上次之後新增事件數依資料呈現。最新列與種子同標題或同事件即不重複列，長標題單行省略、title 留全文。（出處：§18.6、§18.20、§18.23、§18.39、§18.43）
- **焦點回退與基調**：無話題且 working 時顯示「正在整理多家媒體同報的話題」；其他無話題情況，依目前清單篩選找至少三家報導的事件，按家數、最新時間、id 取五個，「看同事件・N 家」展開並定位該事件。若仍為零，僅在無篩選且全部資料也無三家事件時改顯緊湊一行「目前沒有多家媒體同時報導的新聞」，無卡片底色與上下內距，隱藏標題；title 保留至少三家不同媒體門檻（§20.9）；有篩選而無可顯示事件則隱藏（§20.6）。只看追蹤仍隱藏焦點，有話題但被來源／類別篩光也仍隱藏。收到的 topic.tone 必須先是合法非負整數計數、合計不超過 topic.count，否則整個基調區不顯示。通過此檢查後，話題至少五則有效逐則基調才畫基調條與計數按鈕；色段、計數按鈕與圖例固定負面／中性／正反並陳／正面，計數前有同色裝飾方塊（aria-hidden），首頁保留可見（§20.32）。前半以目前話題逐則有效 tone 重算可核對計數，缺失或非法 tone 另列「待判定 N 則」，未滿五則也可顯示待判定。行首為「報導語氣（則）：」，計數文字為原生按鈕，如「負面 3」，aria-label 為包含完整可見文字的「負面 3 則報導」（§20.23）；按鈕無底色與外框、數字加粗，hover 底線、選取時粗底線、保留 focus-visible 外框。在首頁與進入話題後都可使用（§20.12）。（出處：§18.3、§18.8、§18.20、§18.35、§18.43、§20.1）
- **基調核對區**：點基調按鈕，在該話題列下方展開「依標題與摘要判斷的報導語氣・按報導計」，逐則列出貢獻該數字的標題連結、來源、時間及可展開來源摘要；同事件不摺疊，不按清單類別／搜尋／追蹤／新進展篩選縮減話題計數。同時只開一個，再點同鈕或模組內非編輯區／搜尋輸入框的 Esc 收起並回焦點，Esc 順序依 §20.15 優先於搜尋清除；其他輸入區不攔。補送重算、按話題＋基調保留選擇；話題／該基調按鈕消失或話題被藏起即收起，之後不自動復開。摘要沿用清單元件，以來源＋連結＋標題識別單篇，保留到報導離開快照或 unmount，不持久化（§20.12）。
- **窄版面板與工具列**：ResizeObserver 以模組根內容寬度 ≤480px 進窄版、≥500px 才退出，20px 遲滯涵蓋約 16px 捲軸；不以 viewport 判斷。CSS 共用 nw-narrow，不另用 container query；排行雙欄 ≥560px 進、≤540px 退（§20.27）。面板預設收合為摘要按鈕，財經／科技顯偏多與偏空、國際顯升級與緩和、政治顯事件數；缺分析才附已分析 X／N。aria-expanded／aria-controls 對應面板內容；展開選擇跨類別與補送保留，只在本次掛載記憶，不寫本機儲存；寬版始終顯示完整面板，縮回窄版沿用選擇。尺寸改變若焦點在面板內容則保持展開；若焦點在摘要鈕，寬版先保留此鈕，失焦後才隱藏，不轉移閱讀焦點（§20.27）。寬版工具列 DOM／Tab 順序為重新整理→來源→類別→追蹤關鍵字→只看追蹤（若有）→搜尋；窄版搬動既有節點為來源→類別→主操作行，視覺與 Tab 順序一致，跨門檻保留焦點，不以 CSS order 排序（§20.25）。窄版四個訊號鈕為 2×2、不斷詞；下拉並排第一行，重新整理／追蹤關鍵字／只看追蹤／搜尋在第二行，極窄時該操作行可橫捲，不多折一行；狀態、速覽與展開的輸入區另列。（出處：§20.24）
- **分析面板範圍**：finance／tech 顯示財經、world 顯示國際、politics 顯示政治，其他類別或只看追蹤時不顯示。範圍是來源＋類別＋當前話題與 outlet 限制後的報導（§20.26）；若開啟只看上次之後，再保留含較新報導的完整事件（§20.11），不受題材／地區／議題或數字篩選影響；每事件取時間排序中第一則有效分析。數字篩選若從話題內啟用，面板與清單保留該話題範圍。（數字篩選見 §20.1）樣本列為 N 個事件（M 則報導），K 個來源，N<10 提示「樣本少，僅供參考」；只在 X<N 時另列「已分析 X／N」，完成後隱藏（§20.23）；缺有效分析的事件不進方向條或四個按鈕，有缺額且分類啟用、model 非 paused 時顯示「待判定 Y」。off／paused 沿用狀態列的分類關閉／整理暫停文字，不把缺額當無關；待合併取 body.events.pending。（§20.11）（出處：§16.6、§18.2、§18.11、§18.16、§18.43）
- **三種面板**：財經分布固定偏多／多空互見／與股市無關（含已分析的 other）／偏空（§20.8），另列大盤／總經；題材排行排除 macro／other，依事件數、固定表格順序最多十個。▲▼ 及利多／利空計數只取 bull／bear 且 dir_p≥0.6。國際可見四段文字為升級／僵持／緩和／無關；無關僅合計有效分析的 not_conflict 與 other，title 另列無關／未明細數，地區排行以事件數排序、其他最後；政治只列中立議題排行、其他最後，沒有方向條或歷史。排行皆隱藏零值、可點選篩清單，再點同項或清除取消；不相容類別會清除該篩選。（出處：§13.6、§17.3、§18.16、§18.22、§18.38）
- **面板數字篩選**：財經／科技的偏多、多空互見、與股市無關、偏空（§20.8），以及國際的升級、僵持、緩和、無關四段計數皆為原生 button；大盤／總經總數、利多、利空亦可點。可見文字含數量即 accessible name，選取同步 aria-pressed。點擊列出貢獻該數字的整個事件，與面板共用最早有效分析及方向門檻；無關包含有效分析的 other，不包含缺分析；四段長條分母為已分析事件數（§20.11）。數字與題材互斥；話題是可保留的範圍，能與內部類別及題材或數字取交集（§20.6）。從題材點數字會清題材，點話題清數字／題材；從話題數字改題材保留原話題與返回資訊。面板分母不受數字篩選縮小。篩選列顯示說明與「清除篩選」，同數字再點取消；話題內點數字保留話題範圍但改顯數字說明，清除依原話題返回流程還原原檢視。進入話題前若選了數字，返回亦恢復它。補送保留數字篩選；改類別清除，改來源重算（若數字來自話題則退出該範圍）；不寫 localStorage。樣本、待判定、待合併與歷史數字仍是說明文字。（出處：§20.1）
- **面板語意**：開啟只看上次之後時，樣本列開頭加「上次離開後的新進展：」，明示統計已縮至新進展；關閉移除前綴。搜尋不縮面板，新進展會縮；兩者並用時，下述搜尋提示與樣本列前綴同時顯示，來源／類別下拉仍維持原分面範圍（§20.11）。搜尋有字時，樣本列前顯示「統計為全部{類別名}，未套用搜尋」，清除即隱藏；面板仍沿用來源／類別／話題範圍，題材／數字不另加提示。股市訊號旁註「依新聞內容判斷對股市的影響，非行情」，四段新詞同步按鈕、篩選說明、aria、title 與歷史。大盤行為「大盤方向：」後依序為「大盤／總經 N 個事件」「利多 X」「利空 Y」三個按鈕，以 gap 分隔、不加浮動符號（§20.9），三個計數仍可點；其後另加非按鈕小字「其餘 N 件無明確方向」，N=總數−利多−利空，0 時不顯示（§20.23）。財經題材排行圖例「紅＝偏多・綠＝偏空・灰＝無方向」；國際使用升級／緩和／無方向及相應 danger／accent／idle 色，政治不顯示方向圖例。清單財經題材 ▲▼ 可見字不改，title 與外部 aria-describedby 說明該新聞對題材偏多／偏空（非行情），無方向則為「題材：{題材}」。報導基調的正面／負面／正反並陳／中性不改。（出處：§20.8）
- **近 24 小時變化**：財經／科技／國際共用預設收起的按鈕，aria-expanded 與 ▸／▾ 同步，展開才畫內容，狀態跨類別保存。以 body.at 為終點（無效改當時 Date.now），四個六小時區間，含左不含右、末段含終點；時間取事件最早代表、分析取第一個有效者。缺分析事件不進色條任何色段，色條以該段已分析事件為分母（§20.11）。每段有效分析事件<5 不畫色條；四段中≥3 段不足只顯示一行不足提示。其餘段落財經分母為偏多＋偏空＋多空互見，國際為升級＋僵持＋緩和；分母 0 顯示 —、1～4 顯示計數、≥5 顯示整數百分比。（出處：§18.11、§18.36、§18.43）
- **清單與摺疊**：先以來源、類別、題材／地區／議題、話題限制個別報導，再分事件；只看追蹤則保留群組內至少一則命中的事件。event 須為 12 位 hex 且 event_size 為正整數，否則該報導獨立。代表是符合條件者中最早一則；群組依輸入新到舊列表首次出現順序列出。標題在上、資訊在下，操作按鈕右置、窄版自然換行；資訊順序為搜尋命中（若有）、追蹤、分析標籤、類別、來源、時間、話題內基調。特定類別不重複類別名，政治議題標籤只在政治檢視顯示。（出處：§16.6、§18.10、§18.14、§18.22）
- **事件最新報導**：多報導事件仍以最早報導為代表；群組內 published 最新且比代表晚、不同報導與不同標題時，代表標題下顯示連往原文的「最新：標題（來源）」。單行省略、完整標題放 title，HTTP(S)／target=_blank／rel=noopener noreferrer 同代表；最新行不再另加「新」徽章（§20.23）。搜尋命中最新那則時隱藏此行，由展開子報導顯示；補送與搜尋重算，展開內容不變。自然 Tab 順序為代表→最新→摘要→展開，無額外按鈕。（出處：§20.7）
- **時間**：依使用者當地時間，今天 HH:mm、其他 M/D HH:mm，推定時間加「約」及說明。每份完整列表逐來源計算：至少三則且≥80% 為當地 00:00:00，該來源午夜項目才顯示「今天」或 M/D；非午夜項目照常、篩選不改判斷。推定時間項目也計入該來源午夜比例的分母。後半將無時區日期視為 UTC（`back/feedparse.py:_iso`）；因此只給日期又未帶時區的 feed，其 UTC 午夜在台灣是 08:00，不會符合此處的當地午夜判斷。多報導事件顯示最早到最新範圍，相同時間不重複，展開子報導各自顯示自己的時間。（出處：§18.1、§18.3、§18.14、§18.42）
- **展開與摘要**：「另 N 則報導」只在 N>0 出現，展開狀態按 event id 保留，子報導列標題／來源／時間，話題檢視另顯各自 tone。「摘要」只在代表有非空字串摘要時出現，在 meta 下方展開原文純文字與「來源摘要」標籤、最大 42em。摘要狀態按 event id，無 id 用 link＋source＋title，空 link 不記；按整份 items 清理，暫時篩掉不清除。補送若 event id 改變，先依共同報導 link 從舊快照移轉 expanded／summary 至新 id，再淘汰消失的 id；合併／拆分不在同次移轉中連鎖傳遞，相關按鈕焦點亦可按唯一報導連結追到新事件（§18.48）。（出處：§16.6、§18.14、§18.19、§18.25）
- **搜尋收合與焦點**：收起搜尋列同時清空搜尋字、取消搜尋篩選與命中提示，焦點回搜尋入口；重新展開是空輸入，不存在隱藏卻生效的搜尋。Esc 清除搜尋時，若焦點在只因搜尋而自動展開的子報導，先移至該列展開鈕再重畫，不將該事件寫入手動 expanded；原本手動展開的事件仍保留（§20.14）。
- **閱讀分隔線**：lastSeen 初始為 mount 時讀取的時間基準；只有手動「標為已看」／當次「復原」會在此頁改動，普通補送不推進，不是逐則已讀紀錄（§20.21）。事件任一報導較新就算新事件；清單開頭連續新事件後若還有舊事件，插入「以下為上次離開前的新聞」。分隔線與狀態新增數均按目前篩選後的群組計算。全新／全舊／第一群就是舊的不插入；全部為新事件時，主列不加「新」徽章，改靠狀態列新增數；焦點／事件的「最新：」行不再加新徽章，標題前的新徽章保留（§20.23）；展開子報導平常不標「新」；開啟「只看上次之後」時，lastSeen 後發布的子報導加「新」（§20.11）。非開頭連續區段的新事件仍加「新」，焦點亦保留。狀態顯示可切換的「新增 N 個事件」按鈕，N=0 或無 lastSeen 時隱藏且禁用，不顯示新增文字與其前方分隔符；aria-pressed 同步，按鈕節點保留以維持焦點。開啟後只列符合目前條件、且至少一則報導在 lastSeen 後的事件，保留其較舊代表；與來源／類別／題材／數字／話題／搜尋／追蹤取交集。題材是否仍有效以目前來源／類別／話題範圍的個別報導判斷，且在新進展縮小前檢查；只要仍有該題材報導，開關新進展或其中暫時為零都不清題材。先套個別報導題材，再以事件是否含新報導取交集，按前新增數＝按後列數；只有原範圍題材真的消失才自動取消（§20.14）。清單前提示「只看上次離開後的新進展（N 個事件）」及獨立關閉鈕，即使 N=0 仍可退出。面板、24 小時分段也縮至新進展事件，選單分面數維持原範圍；搜尋仍不縮面板。補送保留、清除全部取消、話題返回還原進入前開關，不持久化（§20.11）。話題可見短標「+N 新事件」，accessible name 保留「上次之後新增 N 個事件」；首次無基準則都不顯示（§20.23）。（出處：§18.4、§18.12、§18.13、§18.20、§18.43）
- **話題進出**：首次進入保存來源、類別、題材、數字篩選、追蹤與新進展開關、最近可捲動祖先位置與焦點身分，再清空來源／類別／題材／數字、關閉只看追蹤；保留搜尋字與當時的新進展開關。切另一話題不覆寫保存；返回原檢視、再點同話題、話題消失都還原有效項目；手動改來源或空清單清除則丟棄原檢視；話題內手動改類別保留話題及返回狀態，清掉題材／數字，面板按話題×類別計算；此類別切換是臨時檢視，不寫 localStorage，返回原檢視後把實際還原的 source／category 寫回 view（§20.14）。話題內數字改點題材會保留話題與返回狀態（§20.6）。話題篩選列另按 outlet 合併報導數列媒體分布，最多五家，同數按該 outlet 最早的 feed 順序，其餘顯示「另 N 家（共 M 家）」，title 列全部媒體與報導數（§20.25）。來源下拉仍可分別選各 feed。（家數修正見 §20.4 R4-A）（出處：§18.6、§18.15、§18.21、§18.25、§18.43）
- **返回的焦點與捲動**：自動返回若焦點在模組外具體控制項，不還原焦點／捲動；若在模組內，先試保存身分、再目前身分，找不到則保底清單容器。body 是特例：現行也走保存身分恢復與捲動恢復，找不到則不強制聚焦清單。此為 §18.25 R25-4 的 body 特例。（出處：§18.21、§18.25、§18.38；實作 `front/front.js:returnToView`）
- **追蹤**：最多十個關鍵字、每個 1～20 字，空白／半形或全形逗號分隔，不分大小寫去重；標題或摘要做字面包含，不當 regex。只看追蹤 N 按來源／類別／話題／題材／數字／搜尋與新進展交集後命中的事件計數，尚未套用只看追蹤本身，N 等於按下後列數（§20.19）。命中列顯第一個符合的關鍵字。開啟後隱藏焦點與分析面板，清單前顯「只看追蹤：關鍵字們」，既有題材／話題／數字篩選列仍可操作；關閉恢復。清空關鍵字會關閉並藏起切換鈕；「追蹤關鍵字」設定中提供先輸入並儲存的引導。只看追蹤的 title／aria-describedby 說明「只顯示標題或摘要含你的關鍵字的新聞（N 個事件）」，隨數字同步。（出處：§18.10、§18.19、§18.25、§18.43、§20.9）
- **快捷鍵說明**：狀態列尾端小字「快捷鍵」或非輸入區的 ?（Shift+/）可開關清單上方的非 modal 說明區（role=region、aria-label=鍵盤快捷鍵）。開啟聚焦說明區、不鎖 Tab，關閉還原開啟前焦點；補送後依身分還原，目標消失則回入口。入口與「新增 N 個事件」「標為已看」「復原」共用細框次要按鈕及 30px 最小高度；窄版入口顯示圓框 ?，aria-label／title 均為「快捷鍵說明」，與狀態文字同列（§20.23）。說明只列既有 j/k、s、e、/、Esc 與 ?。Esc 每次一層，優先序為基調核對區→清除搜尋→收起說明；搜尋框內 Esc 也遵此優先序，其他編輯區不攔。? 不攔輸入框／選單／textarea／contenteditable、組字或 Ctrl／Meta／Alt，按住不反覆切換。不持久化，unmount 移除監聽（§20.15）。
- **鍵盤**：只在根元素內、非輸入／選單／textarea／contenteditable、無 Ctrl／Meta／Alt／Shift 且不在輸入法組字時處理小寫 j/k/s/e。j/k 在主列標題連結間移動並 scrollIntoView(nearest)，跳過分隔線、子報導與無有效連結標題；不在列內時從第一列找起。s／e 切換該主列摘要／其他報導，沒有控制項不攔；只有實際處理才 preventDefault。收合時焦點若在子報導，先移至該列展開按鈕。（出處：§18.40、§18.41）
- **無障礙與安全 DOM**：資料欄位先驗型別，分析 kind 缺失兼容 finance、不合法當未分析；連結限 HTTP(S)、新頁 noopener noreferrer，資料只用 textContent。按鈕以可見文字作名稱，補充資訊放 aria-describedby；展開／選取同步 aria-expanded／aria-pressed。補送依身分恢復焦點，唯一 href 可追到合併後子報導並展開；原焦點在模組內但消失、隱藏或停用時保底 tabindex=-1 清單。unmount 移除監聽與計時器，保留的舊回呼不復活 UI。（出處：§12.7、§18.7、§18.12、§18.17、§18.27、§18.38、§18.41）
- **偏好套用與空狀態**：記住的來源只在第一份列表恢復有效選項；類別等任一 item 出現九類中有效 category 才恢復一次。收到 classify.enabled=false 永久取消本次待恢復類別；手動改哪一欄就取消該欄恢復，並讀取既存 view、只合併保存該欄。話題進入及空狀態清除篩選不保存；清除全部後只手動改一欄，另一欄仍可暫時與已存偏好不同（§20.16）。話題內類別切換不保存，返回時保存實際還原的 source／category（§20.14）。已選特定類別、model.state=working 且結果為空時顯示「分類中，稍後出現」；搜尋非空時優先顯示「目前篩選範圍內沒有符合搜尋的新聞」；其他收到列表後的空狀態為「這個條件下沒有新聞」，有清除篩選入口。（出處：§18.45、§18.46）

所有 localStorage 讀寫集中於 loadState／saveState，JSON 序列化並 try/catch；壞值或禁止儲存不阻止閱讀，不將這些設定送模型。模型、新聞與摘要／事件展開狀態不寫入 localStorage。（出處：§18.4、§18.19、§18.25、§18.43、§18.45、§18.46）

| key | 值與保存時機 | 出處 |
|---|---|---|
| `modudock.module.news.lastSeen` | ISO 時間或 null；手動標記／復原立即寫入，復原至下一份 list；pagehide／unmount 仍重讀並存 max(已存值, 本頁基準, min(目前列表最新 published, now))，補送不自動推進 | §18.4、§18.12、§18.38、§20.21 |
| `modudock.module.news.watch` | 正規化關鍵字陣列，按儲存或 Enter 時寫入；不保存只看追蹤開關 | §18.10、§18.19 |
| `modudock.module.news.history` | 布林，按歷史展開鈕時保存，僅 true 視為展開，跨類別共用 | §18.43 |
| `modudock.module.news.view` | `{source, category}` 字串欄位，一般手動切換只更新改動欄位；話題內類別是暫時值不保存，返回時保存實際還原兩欄；題材、話題、追蹤開關不保存（§20.14） | §18.45、§18.46 |

- **臨時搜尋**：工具列「搜尋」可展開／收起整行輸入框，收起同時清除搜尋條件（§20.14）；只搜尋本輪目前收錄的標題與摘要，與來源／類別／題材／數字／話題／只看追蹤／新進展取交集。以事件計命中，保留原代表，命中子報導時自動展開並標「搜尋命中」。補送與新 at 都保留並重新比對；「搜尋「X」：N 個事件」顯示在搜尋列旁，以 aria-live=polite 更新（§20.6），零則時說明目前範圍無命中並提供清除。「清除搜尋」按鈕只清搜尋；Esc 先收基調核對、再清搜尋、最後收快捷鍵說明（一次一層，§20.15）。空狀態的「清除篩選」清所有條件與待恢復值，不覆寫已存 view；面板篩選列的同名按鈕只清該篩選，話題範圍則返回原檢視。搜尋不寫本機儲存；根元素內 / 開啟並聚焦，輸入框內不觸發 j/k/s/e。比對移除 U+200B/U+200C/U+2060/U+FEFF、保留 ZWJ，再折疊全形 ASCII／全形空白與大小寫，不改顯示原文。（出處：§20.5）

- **話題內閱讀工具**：只在話題及話題內數字篩選顯示「最新更新｜時間順序」二選一分段按鈕（role=group、各自 aria-pressed；§20.33）；預設沿用最新優先，順讀按符合條件事件最早報導時間由舊到新，加實際 M/D 日期分隔，title 明示「依發布時間，非事件發生時間」。時間順序顯示「由舊到新，依發布時間」；順讀不放上次離開分隔線，新進展計數保留；j/k 按實際列順序。離開或切換另一話題重設，補送保留，不持久化。來源分布升級為「各家報導語氣（則）」：按 outlet 合併 feed，每家一列媒體按鈕、報導數、基調比例條與短數字，前五家外以「另 N 家（共 M 家）」按鈕展開。比例只含有效逐則 tone，未判定另列；已判定不足五則的媒體加「樣本少」、比例條 opacity=.45 但寬度不變，短 mixed 為「兩面」。標題下明示「依每則標題與摘要判讀對此事件的語氣（AI 判定），不代表媒體整體立場」（§20.34）；順序、圖例與焦點一致（§20.32）。按媒體篩該話題，來源下拉顯全部來源，表格旁顯「只看：媒體名 ✕」chip，✕ 無障礙名稱為「清除媒體篩選」，排序鈕獨立；同一家再按或清除只取消媒體。來源下拉手動變更沿用退出話題規則，返回恢復進入前檢視。分布數字為套用類別、題材／數字、搜尋、追蹤、新進展後可列出的報導數，不受已選 outlet 限制；數字＝點後報導數，同事件可含多則。分布 title 列全部，總家數仍按完整話題 outlet 去重。窄版換行、不縮寫。（出處：§20.26）

- **補送閱讀位置**：只在接收同／新 at list 且捲動容器 scrollTop>4px 時，記錄最近可捲動祖先視窗內第一個可見報導連結的身分與 y 位置，重畫後補償 scrollTop；原列消失則依序找原視窗內下一個仍存在的報導，全部消失不強制定位。被合併成子報導時展開該群並定位原報導。主動搜尋／篩選／進出話題不套用，自動話題返回沿用原返回位置；鍵盤閱讀沿用原焦點規則，pointer／wheel 後恢復滑鼠位置保護。模組根 overflow-anchor:none，只停用模組自身原生 anchoring，避免與手動補償重複。頂端（scrollTop≤4px）不補償，讓工具列與新插入報導自然留在前方；只有已捲離頂端才保護閱讀位置，不要求錨點上緣已超出可視區。未更改殼樣式。（出處：§20.28、§20.30）
- **首次閱讀階段**：up 後仍為「等待新聞更新」，第一份 list 若 working 顯示「新聞已可閱讀・整理分類與話題中」；由首份 working 起滿 30 秒仍 working 加「可按重新整理」，不估完成秒數、不依補送才更新。首次離開 working 即結束此階段；完成時消失，paused／off 沿既有原因提示，後續輪 working 仍用「整理中」。計時器於結束及 unmount 清除。（出處：§20.28）

- **話題閱讀呈現**：進入話題（含話題內數字篩選）時，焦點預設收為「焦點：N 個話題 ▸」，可展開完整卡片；同話題補送保留開關，換話題重設，離開恢復完整焦點。基調標題 title 依後半 criteria 說明報導語氣、非媒體立場；合併事件內有多種有效基調時，主列顯示各類報導數組成，子報導保留自己的基調（§20.33）。
- **話題統計範圍**：篩選列標頭附「整個話題：N 個事件・M 則・K 家」，以完整目前話題成員重新分事件及按 outlet 去重計家數，不隨閱讀篩選縮小。清單實際報導少於完整成員時，另顯一行「目前顯示：N 個事件・M 則」；沒有縮小則隱藏，即使有條件但結果相同也不顯示。事件數相同、報導變少仍提示。適用話題及話題內數字篩選、搜尋即時變更及補送。基調按鈕列 title 明示「整個話題：按報導計，不隨清單篩選變動」，核對仍按完整話題。（出處：§20.29）

### 19.3 驗證方式

- **前半漫步**：`npm test` 包含固定 200×100 步；可用 `NEWS_WALK_SEEDS`／`NEWS_WALK_STEPS`／`NEWS_WALK_SEED` 放大或依失敗 seed 重跑。逐步驗數字與交集、焦點、ARIA、保存規則及核對區唯一性；既有暫時 view 欄位不強制覆寫偏好。另跑 2,000 組多 seed 探索，不取代窄版／深淺主題實機驗收。（出處：§20.16）

- **離線回歸**：在 news repo 執行 `/usr/local/bin/python3 -m unittest` 與 `npm test`；後者為 Node＋happy-dom，另含 grep 級安全／樣式檢查。後半用假 http.server、注入 clock／sleep、thread gate 驗預算、滴流、退避、三條並行、准入優先序、在途去重及退出；不需要真 key。第 46 輪基準為後半 331、前半 162 測試，數量是收件快照，不是永遠固定的驗收條件。（出處：§18.2、§18.18、§18.31～§18.33、§18.41、§18.46）
- **真實端到端工具**：`/usr/local/bin/python3 scripts/real_run.py --timeout 120 --topic-min 20 --save /tmp/news-last.json`。繼承環境 TYPESAFE_API_KEY、有 key 會真的呼叫 API，應依當輪授權執行；無 key 仍可驗 RSS 與協定。工具清除 NEWS_TEST_* 環境覆寫，`--root` 可指定 news repo。hello／up／bye 同 seq；讀到 model done／off 或達總逾時後送 bye，必要時強制結束子程序。done／off 且子程序成功退出才回 0。（出處：§18.34）
- **端到端觀測**：時間線包含各類 pending、model.state、話題摘要；結束列首份列表、完成、首次≥topic-min 的話題時間，以及分類／分析完成數、事件數、話題／基調與 model round 統計。另列 model_usage 的 requests／http／retries，僅加總已完成輪的統計行，不重複加總 total_http；舊行缺 http／retries 則列 unknown，逾時未收尾的在途輪不包含在此摘要（§20.20）。--save 保存最後 envelope，逾時也可留下部分結果；不要把單次真資料秒數當固定性能保證。腳本變更至少實際跑過無 key 路徑，避免假 backend 掩蓋協定錯誤。（出處：§18.30、§18.32、§18.34）
- **畫面驗收**：真殼 Chromium 深／淺、寬／窄皆看；開 DevTools 停用快取後重載，避免 front.js／style.js／labels.js 舊檔混用。happy-dom 不驗真實 light-dark 顏色、捲動與完整排版；實機驗 Enter 更新焦點、話題返回捲動、窄版換行、Lighthouse label-in-name。基調負面與財經漲跌須可分辨。（出處：§18.17、§18.22、§18.27、§18.35、§18.41）
- **chaos 的確定覆蓋**：固定 seed 仍注入多輪重疊、HTTP 失敗、認證關閉及退避，原有所有不變條件與 lane／結果覆蓋斷言保留。乾淨輪加全新 key 的話題候選（共用低頻詞，bigram 低於配對門檻）與無關填充資料，避免候選被舊配對快取或 10% 特徵詞門檻消掉；非 auth 情境逐一要求 topics 已呼叫且候選確實加入話題。不新增 sleep。驗收以預設 60 組、6 份 process 並行×5 批（共 30 次）全部通過，並以故意讓 topics 回 false 的變異驗證會失敗。（出處：§20.3）
- **回歸強度與耐久**：針對門檻、待問排序、優先序、預留、共用開關、焦點與保存規則做變異驗證；不要為了通過而移除舊行為斷言，先確認是否被後續規格取代。既有耐久結果包含一小時七次更新 RSS 33～56MB 無上升、22 分鐘三輪正常，未保證任意網路／來源永久無故障。（出處：§18.18、§18.24、§18.32、§18.34、§18.38、§18.39）

### 19.4 已知限制與刻意不做

- **一致性修正**：§20.18 P1～P3 已由 §20.19 修正：追蹤數套完整交集，排行以實際最大值縮放，跨輪舊話題遵守配對准入限制。

- **分析材料與解讀**：只送標題＋摘要，不抓全文；熱度是目前收錄報導／事件數，不是民意或市場調查，來源保底只避免被擠光，不代表樣本均衡。基調不判斷真假或政黨立場，事件與話題仍可能誤合併／漏合併。首次啟動、深夜與篩選後的小樣本尤其不能過度解讀。（出處：§13.8、§16、§18.1、§18.8、§18.11、§18.16、§18.36）
- **不做藍綠傾向、民生負擔、政策階段、多題材**：政治只做中立議題分類。既有真樣本民生負擔 20 則有 18 則不適用、政策階段 20 則有 14 則不適用；次要題材 20 則只有 2 則過 0.6 且一則牽強，沒有足夠收益支持增加面板與模型題目。（出處：§17 實驗紀錄、§18.16；多題材不再列為待實作功能）
- **不新增題材、不降話題種子到兩家、不做題材升溫**：題材是人維護的固定表；新種子至少三家有明確測試，previous 黏著例外依 §19.1。近六小時樣本太少，升溫容易被一兩則放大；這也是歷史分段不足時只顯示提示的原因。不把「基調移出首頁」當瘦身方案，首頁可見就是用戶需要的風向價值。（出處：§18.18、§18.36、§18.43；不新增題材為本次審核既定範圍）
- **不做跨輪累積新聞與內容指紋**：目前每輪以各來源最新成功快取組列表，失敗可 stale 沿用，但不維護累積歷史資料庫；模型 key 仍跟 dedup key，不用內容指紋偵測同 URL 改稿。localStorage 只存上述四項偏好／基準，新聞與模型快取不持久化。（出處：§9、§18.4、§18.24、§18.43、§18.45；跨輪累積／內容指紋為本次審核既定不做事項，§18 未另立提案）
- **網路與預算界線**：Python thread 不能終止卡住的 DNS／慢 header；read_deadline 不是所有底層網路階段的硬牆鐘上限。RSS worker 被占滿時後續輪可能全 deadline、顯示 stale；模型工作有准入預算而非整輪保證 60 秒結束，paused 需後續更新接手。bye 靠 daemon／process 退出，不假稱已取消遠端請求。（出處：§5、§18.2、§18.32、§18.37）
- **暫不擴大並行／批次或重寫前半**：分析按 kind 分批曾讓分類後補送 34→10、總耗時 40.5→28.1 秒；焦點優先在兩次對照中由約 32 秒提早到約 20 秒，總時間相近；三條並行後實測整輪約 41→15 秒、焦點 24→9 秒。雖曾測同 key 十二並行可用，仍只開三條、不放大二十則批次以免準確率風險。完整前半重畫約 10ms、CPU 四倍降速約 42ms；一輪後半 CPU 3.8s（單核約 24%），目前沒有數據支持額外重構。（出處：§18.1、§18.2、§18.30～§18.33、§18.43）

### 19.5 歷史差異索引（本次核對見 §20.18）

以下列出會影響下一位開發者理解的舊文或實作細節；不是要求把程式改回早期行為。

| SPEC 位置 | 目前程式與差異 | 程式位置 |
|---|---|---|
| §18.1 R1-C 追註、§18.3 R3-B | 舊文仍像單則午夜就省時間；§18.42 要求的原段加註未補。現在每來源至少三則、午夜≥80% 才省略；以整份列表計，不按可見清單。 | `front/front.js:isDateOnly`、`renderList` 的 sourceTimes |
| §18.28 R28-A | 舊文 busy=disabled、提示到下一份列表；§18.41 要求的原段追註未補。現行 busy 用 aria-disabled 保焦點，同 at 補送不清逾時提示。 | `front/front.js:onRefresh`、`finishRefresh`、`renderList` |
| §18.4／§18.13／§18.20、§18.6／§18.21／§18.23 | 舊文仍見「N 則新」「上次看到這裡」「返回」「N 家媒體・M 則」。現行依 §18.43 改為新增 N 個事件、以下為上次離開前的新聞、返回原檢視、看話題・N 家／看同事件・N 家；窄版仍 N 家。 | `front/front.js:drawItems`、`drawFocus`、`drawPanel` |
| §18.11／§18.36、§18.2 R2-C | 歷史不再預設展開，須按 §18.43 的按鈕；待分析 0 元素仍有文字但 hidden。只看追蹤時焦點與面板一起隱藏，舊版面描述不再完整。 | `front/front.js:onHistory`、`drawHistory`、`drawPanel`、`drawFocus` |
| §18.20 off=disabled | 實際依 §18.44 回 no_key／auth；大小預留常數仍用較長的 disabled 字串作保守量測，它不是目前對外輸出的 reason。 | `back/scheduler.py:_model_state`；`back/feedparse.py:MODEL_RESERVE` |
| §18.45 R45-A | 仍寫手動存兩欄與第一份列表一起套來源／類別，未加 §18.46 追註；現行手動只合併該欄，類別延後，來源仍只首份。 | `front/front.js:onSourceOrCategory`、`renderList` 的 initialView |
| §18.46 R46-1「至少一則 item 有 category」 | 實作較嚴格：必須是固定九類之一，不是任意非空字串。收到 enabled=false 會刪除本次待恢復類別，之後即使測試封包重新 enabled 也不再恢復；改來源不取消待恢復類別。 | `front/front.js:renderList` 的 initialView、`onSourceOrCategory` |
| §18.40 R40-A | 正文只列 Ctrl／Meta／Alt；實作也排除 Shift、isComposing，並跳過無有效連結的主列。 | `front/front.js:onBrowseKey` |
| §18.33 R33-2「先以舊表查完、再寫新表」 | 實作先複製傳入 OrderedDict，遍歷時可新增／更新 LRU，但整份遍歷結束才淘汰；達成避免同輪連鎖淘汰的目的，並非兩階段延後所有寫入。 | `back/feedparse.py:parse_feed` 的 seen 複本、move_to_end 與最後的 popitem |

以上差異以 §19.1～§19.4 的現行描述為閱讀基準；這些項目多為舊文未追註或更精確的型別／實作說明。（出處：§18.38、§18.41～§18.46）

### 18.47 第 47 輪（後半隨機故障注入測試）

§19 完成後，後半改為用「隨機序列＋不變條件」補強並行排程的長期保護（先前審查是人工找交錯）。
**R47-A** 新增 `tests/test_model_chaos.py`：以固定 seed 產生 N 組（預設 60 組，環境變數可調高）情境；每組用假 client（隨機延遲 0～30ms、隨機回 None／成功、隨機觸發 401 一次、429 由 _ChoiceClient 層模擬）、隨機插入 refresh 與新列表（items 增減、事件合併）。每組結束（所有假 client 成功後再跑一輪乾淨的）後斷言：
1. 所有 in_flight 集合為空、所有 lane 佇列為空；
2. 最後一份列表 `model.state` 為 `done`（或 401 情境為 `off/auth`），且各 pending 為 0（off 時為 0）；
3. 同一 key／pair 在任一時刻不會同時被兩個 worker 請求（假 client 記錄在途集合檢查）；
4. 每個 round 的統計行最多一行；
5. 所有 worker 執行緒在 stop 後結束（或只因假網路阻塞而存活）。
- 全套測試時間增加 ≤10 秒；失敗時印出 seed 以便重現。只加測試；若測試抓到真問題，先回報 cc-mod 再修。

### 18.48 第 48 輪（前半通盤審查：跨功能狀態）

第 47 輪結果：後半隨機故障注入測試（變異：拿掉在途去重 → 53 組失敗）。最後耐久 22 分鐘三輪正常。
**前半通盤審查（agent，00:5x）**：80 seed × 800 步隨機狀態漫步全部不變條件成立；定向重現 3 條中度（scratchpad/tb.mjs、ta.mjs、ta2.mjs；漫步腳本 walk.mjs）。

**R48-1 事件 id 變動時沿用展開／摘要狀態與焦點**：`renderList` 清理前，以上一份 items 建立 link→舊 event 對照，依共有成員把 `expanded`／`summaries` 的舊 id 換成新 id；`focusIdentity` 對 `.nw-expand`／`.nw-summary-toggle` 另記該列代表 href，`restoreFocus` 找不到時依 href 找所在列的同類按鈕。
**R48-2 延後的類別不得套進話題檢視**：恢復類別時若在話題檢視（selectedTopic 或 savedView 存在），寫進 `savedView.category` 而不改 `categories.value`；`returnToView` 讓待恢復值優先於 saved.category。
**R48-3 清除篩選取消待恢復**：`onClearAll` 刪除 `initialView.category` 與 `.source`（只影響本次，不寫 localStorage）。
**R48-4 前半隨機狀態漫步進 repo**：把 walk.mjs 改寫為 `tests/front.walk.test.mjs`（固定 seed、預設 20 seed × 300 步，環境變數可調），斷言審查使用的不變條件；失敗時印 seed。
- 驗收：三條各一測試（改寫審查腳本）；漫步測試全綠且總時間增加 ≤10 秒。

### 18.49 第 49 輪（題材篩選的兩個小缺口）

第 48 輪結果：跨功能 3 條＋前半隨機漫步進 repo（185 測試 4.2 秒）。
通盤審查另列兩個低於中度的觀察，一併收尾：
**R49-1**：補送後若目前題材／地區／議題篩選在面板範圍內已無任何事件（排行按鈕消失），自動取消該篩選（同 returnToView 的處理），不留下「已篩選：X」與空清單。
**R49-2**：篩選列的「其他」依種類顯示為「其他地區」（region:other）或「其他議題」（issue:other）；題材的「其他」維持「其他」。
- 驗收：前半測試各一。

### 18.50 第 50 輪（安全審查修正）

第 49 輪後文件讀者測試 12/12 正確；最終變異 後半 0/15、前半 0/12。
**安全審查（security agent，01:2x，唯讀，PoC 在 scratchpad：poc_html.py、poc_ssrf.py、poc_cpu.py）**：3 條中度、無高風險；前半無 innerHTML、連結只收 http/https、XML DTD/entity 拒絕、下載上限、API key 不外洩等皆確認。

**R50-1（M1）解析前先截斷**：`feedparse.plain()` 在交給 HTMLParser 前先截取原始字串前 8192 字元（HTMLParser 對不完整標籤為平方時間；PoC：240KB feed 解析 45 秒）。截斷後輸出仍照原 limit（300/200）。
**R50-2（M2）主機名稱字元白名單、禁止降級轉址**：`check_destination` 只接受由 `[A-Za-z0-9.-]` 組成的主機名稱或 IP 字面值（含 `%` 等一律拒絕），避免檢查與連線時解析不同名稱（PoC：`x%2F.attacker.example`）；轉址不得由 https 降到 http。
**R50-3（M3）單一來源上限與未來時間容差**：每個來源在列表中最多 60 則（保底 3 則規則不變）；未來時間容差由 1 小時降為 10 分鐘（超過改用 first_seen 推定）。
**已知限制（記錄、交用戶決定）**：連線時未綁定已檢查的 IP（DNS rebinding 時間差，原 docstring 已承認）；事件與話題代表取最早報導，被入侵的來源可用更早時間與相同標題成為代表；feed 文字可影響分類／分析結果（僅限既定選項，無法注入 UI 或取得 key）。
- 驗收：三條各有單元測試（改寫 PoC，M1 以 30000 次 `<a` 在 1 秒內完成）；真實跑結果（列表、事件、話題）不退步。


## §20 第二次進化紀錄

2026-09-26 09:20 起，分支 `evolve/2026-09-26`（基於 `5bfb62a`）。每輪審核通過後才 commit、不 push、不動殼；jev 真 API 總預算約 1500 次，每次執行前報預估、結束回報實際用量。

#


## 20.1 第 1 輪：面板數字查看新聞、焦點空狀態

**R1-A 面板數字可點選**：
- 股市訊號四段（正面／正反／無關／負面）、國際走向四段（升級／僵持／緩和／無關）、大盤／總經總數及利多／利空改成原生 button。可見文字包含計數，直接作 accessible name；Enter／Space 沿用原生按鈕操作，aria-pressed 表示選取，不靠顏色單獨表達。樣本、待分析、待合併與近 24 小時數字維持說明文字；既有題材／地區／議題排行按鈕不變。
- 計數與點擊後清單共用事件貢獻判定：先取目前來源／類別及話題範圍，事件內按時間取第一個有效分析，整個事件只算一次。清單保留該事件所有範圍內報導，不以單則分析再次裁掉成員。無關包含未明／未分析；大盤方向沿用 dir_p≥0.6。
- 數字選取取代題材或話題選取，點題材或話題亦取代數字；面板本來不受題材篩選影響，因此從題材狀態點數字會清掉題材，列出該面板數字的全部貢獻事件。清單上方一行說明＋「清除篩選」，再點同數字也取消。未選取的按鈕 aria-pressed=false，零計數仍可點，清單顯示既有空狀態。
- **審核確認的話題範圍**：在話題面板點數字，保留該話題作數字的範圍，但不再同時顯示話題選取列；改顯「已篩選：話題內・…」。保留原話題返回資訊，清除或話題消失時沿用返回原檢視的篩選、焦點、捲動恢復。話題前的數字選取也屬原檢視；切另一話題不覆蓋已保存的原檢視。
- 同 at 補送保留選取並重算；切類別清除數字，切來源重新計數，若原為話題內數字則退出話題範圍。清除全部取消數字選取；不新增本機儲存。新事件監聽在 unmount 移除，補送保持數字按鈕焦點。
- 驗收：多組同事件不同分析、未分析、方向 0.59／0.6、來源與題材狀態測試，每個數字等於點後清單事件數；覆蓋話題範圍、互斥、取消、補送、返回、焦點、原生按鈕與 aria-pressed。

**R1-B 焦點無資料說明**：model 非 working、沒有話題、事件焦點亦零時，保留焦點標題，顯示一行 nw-hint「目前沒有 3 家以上媒體同時報導的新聞」。working 且無話題仍顯示整理提示；只看追蹤仍隱藏；有話題但被來源／類別篩光仍隱藏，不回退事件或空狀態。測試各分支。

本輪僅前半、前半測試及規格；jev 用量 0，不改模型題目與後半規則。


### 20.2 第 2 輪：feed 解析 CPU 與跨來源去重安全

獨立安全審查 PoC：`sec2/poc_feed_cpu.py`、`poc_html.py`、`poc_merge.py`。jev 0。

**S1 整份 feed 的解析成本**：舊版只在每欄截 8192 字，HTMLParser 對未完成標籤仍反覆搜尋尾段；127 則×標題摘要的 2 MiB PoC 本輪重現 118.4 秒，`<![` 另會拋 AssertionError 丟掉整份來源。
- 改為單向、帶引號狀態的線性去標籤掃描：文字、一般標籤／屬性、註解、宣告、CDATA、script/style；不建立 HTML DOM、不重試同一個未閉合尾段。維持原始欄位 8192 字元與輸出 300／200 字上限、實體解碼及段落分隔。
- 不完整或不支援的標記只讓該欄位退回原始截斷文字（解實體、壓空白、套輸出長度）；正常的另一欄及後續項目繼續。正式路徑移除 HTMLParser，因此不再有其 AssertionError 傳出；畸形欄位的字面標籤由前半 textContent 顯示，不執行。
- 選此方案而非每 feed 時間預算／限前 N 則：讓結果不隨機器速度、項目位置而異，也不為防 CPU 攻擊犧牲正常來源後段新聞。未擴大 XML、文字節點、深度與下載上限。
- 驗收：2 MiB 的 `<a\t`、未閉合屬性、註解、結束標籤、`<![`、密集正常標籤／實體等十種形狀，以及 2500 個短欄位，逐份 CPU<2 秒；PoC 127 則全保留。舊 HTMLParser 僅作測試 oracle，與既有 RSS／Atom fixture、300 則真實快照（600 個標題／摘要欄位）及一般 HTML 案例比對輸出完全一致；刻意畸形標記的 fallback 語意另驗。

**S2 跨來源鍵碰撞**：去重優先序先於每來源保底／上限執行：
1. 不同來源撞 dedup key，link 主機屬於該來源的本機受信任網域者優先。
2. 同為自身網域或同為外部連結，按 feeds.json 順序；不能以較晚的 published 搶其他來源項目。
3. 同來源的多個版本仍取較新者，相同時間保留先遇到者。
- `merge_items(source_items, feeds=())` 接收來源設定；scheduler 必須傳入 self.feeds。沒有設定的純函式呼叫僅能以輸入來源順序歸屬，不能從新聞 link 反推受信任網域。
- `link_domains` 為本機可選設定，取代 feed 主機的預設網域；接受最多 16 個小寫 DNS 名稱（不得含 wildcard、路徑、空項或連續點）。中央社三份代管 feed 設為 cna.com.tw，BBC 設為 bbc.com／bbc.co.uk。主機比較含點邊界；`cna.com.tw.evil.example`、`notcna.com.tw` 不屬於 cna.com.tw。
- 驗收：五家各 60 則遭 EVIL 加 utm／改晚時間冒用，修前只剩 EVIL 60，修後每家仍 60、共 300；包含 EVIL 排設定第一的情境。中央社政治／財經合法同 link 仍只留一則。測試同來源新版本、網域尾綴攻擊、代管 alias、本機設定驗證與 scheduler 接線。
- 界線：這是本機設定的來源歸屬，不是內容真偽驗證；不猜公共後綴或同集團網域。若沒有匹配的擁有者就依設定順序，同一受信任網域下的內容仍可能被改稿／入侵；既有 DNS rebinding 限制不在此輪擴張處理。


### 20.3 第 3 輪：chaos 穩定覆蓋、來源沿用資料提示

**R3-A chaos 負載下確定涵蓋 topics**：乾淨 cab5590 單跑 12/12 綠、六份並行 18 次有四次因未走到 topics 而紅。初始快照的話題候選會在 refresh 增加同題成員、減少填充新聞後超過 10% 詞頻門檻；早期是否剛好排到 topics 取決於執行緒排程。
- 保留全部既有錯誤注入、佇列／in-flight／退出／終態與全 lane 覆蓋斷言，不加 sleep，不改正式程式的模型規則。
- 最後乾淨輪加入未曾出現的 key=90，標題共用話題特徵詞、但與其他事件的 bigram 低於配對門檻，避免隨機 same 回答吞掉候選或舊配對快取干擾；加 20 則無關填充新聞，確保共用詞低於 10% 門檻。除永久 auth 關閉外，每一個 scenario 都要求 topics 至少一次且新候選已加入話題。
- 驗收：預設 60 scenarios 的測試六份並行×五批，30/30 通過；topics 解碼故意全回 false 時，新成員斷言變紅。不要只用單次測試綠作負載驗收。

**R3-B 來源最後成功確認與舊資料提示**：
- scheduler 以來源索引保存 last_success，僅在 cv 下接收本輪有效成功候選時用注入的 now 記錄 ISO 時間；成功解析（含零則）及已有快取的 304 都算確認。過期／舊輪結果、下載或解析失敗、沒有快取的 304 不更新。失敗沿用先前確認時間，從未成功為 null；與 sources.ok／error／count 一起送出，補送沿用同份 sources。
- 前半按 `ok===false` 且 last_success 是有效時間字串辨識沿用，不看報導的 published。狀態列顯示「N 個來源沿用舊資料」，來源選項附「（HH:mm 資料）」（非本地今天則為「（M/D HH:mm 資料）」）。完整本地年月日時分秒、來源名稱與截短錯誤放 option.title／狀態 title，來源 select 以 aria-describedby 連到穩定的純文字說明節點，切選項及補送同步更新。
- 沒成功過或時間欄位不合法者維持原本「失敗」文字；同時有沿用與從未成功的來源，兩段資訊並列。成功／304 後移除沿用短註；報導日期即使很舊也不能因此顯示失效。描述節點與監聽沿用 mount／unmount 清理規則，資料一律 textContent／title。
- 驗收：假 now 走成功→失敗→失敗→304→失敗，確認時間只在成功兩步更新，新聞本身不變；另驗過期候選、從未成功、非法欄位、XSS、選項與無障礙描述更新及清理。

本輪 jev 0；更新後半來源狀態、前半文字與測試，不變更分類／分析／配對／話題／基調問法或優先序。


### 20.4 第 4 輪：媒體身分與話題種子實驗

**R4-A 媒體家數不重複計 feed（jev 0）**：
- feeds.json 新增可選 outlet；preflight 驗證為 1～64 字的非空字串、無頭尾空白。未填＝name；中央社三 feed 的 outlet 為中央社，經濟日報兩 feed 為經濟日報。sources 狀態帶 outlet，前半先驗字串與長度，不合法或缺失則回退 feed name。
- topics.plan 接受可選 outlets 對照，所有 source_count、種子至少三家、最終至少三家、家數排序及 topic.sources 都以 outlet 去重。scheduler 必須傳入本機設定的對照；配對 pending 時保留既有話題的重算也採同規則，低於三家即不保留。
- 前半事件焦點的 group.count／門檻／排序按 outlet；「看話題・N 家」使用後半 topic.sources。話題篩選列按 outlet 合併報導數，以 outlet 名顯示，最多五家、剩餘家數亦去重；同數依該 outlet 第一份 feed 順序。來源下拉、來源資料時間、feed 名與「個來源」仍保持 feed 粒度，解析／去重／配對與每 feed 名額規則不變。
- 驗收：中央社三 feed 的同事件只算一家，不能成新種子或事件焦點；中央社＋公視＋BBC 算三家。另驗 previous／pending 保留門檻、sources 傳輸、前半補送／來源切換、分布合併與 overflow、缺失／不合法 outlet、preflight。

**R4-B 離線快照真 API 實驗（另行執行，不改正式規則）**：用 300 則 `scratchpad/f1/items-0955.json` 比較現行事件種子≥3 家與實驗≥2 家，家數採 R4-A outlet；最終話題均仍需≥3 家。腳本與結果留 scratchpad/f1，不進 repo。實驗總請求≤250，執行前報預估、結束報實際與話題成員；R4-A 回報後才開始。正式門檻本輪仍為三家。


### 20.5 第 5 輪：臨時搜尋（jev 0）

- 工具列提供可收起的「搜尋」，展開後獨占可換行的一列，輸入框 min-width:0，窄版不撐寬。可見按鈕名、輸入框 accessible name、aria-expanded／controls／pressed 隨狀態同步。
- 輸入即時比對標題或摘要的連續字串，不分大小寫；零寬移除與後半 match_text 相同（U+200B/U+200C/U+2060/U+FEFF），保留 ZWJ；另把全形 ASCII 與全形空白轉半形。後半目前 match_text 沒有全形轉換，本輪只在前半搜尋補上，不改後半模型比對。
- 先套既有來源／類別／題材／數字／話題與追蹤條件，再以群組任一報導命中決定事件是否列出；不改事件代表與面板取分析規則。保留群組內符合既有條件的報導，命中代表或子報導均標示「搜尋命中」，子報導命中時自動展開且 aria-expanded=true，可手動收合；下次重算有子報導命中仍展開。搜尋造成的展開不污染手動展開集合。
- 清單上方以純文字顯示「搜尋「X」：N 個事件」。搜尋與其他篩選為交集，不取代它們，話題返回也保留搜尋。面板仍顯示既有範圍計數；搜尋提示顯示取交集後的事件數。
- 同 at／新 at 列表更新皆保留輸入與重新計算，不持久化搜尋。「清除搜尋」／Esc 僅清搜尋；空狀態「清除篩選」清所有條件與待恢復選值。零結果說明搜尋在目前範圍無命中。
- / 沿用模組內無修飾鍵、非輸入區及非組字的快捷鍵守衛，開啟並聚焦搜尋；輸入框內 j/k/s/e 不導覽。Esc 在搜尋框或非輸入的模組區清除搜尋。unmount 移除所有新增監聽與比對索引。
- 每次收件建標題／摘要比對索引；輸入不重建未受影響的類別選項與分析面板，同份資料與篩選的清單列節點重用、更新命中標記與新舊分隔標記，改篩選或收件清空暫存，清單以 fragment 一次掛入。驗收涵蓋正規化、型別／XSS、子報導、各篩選交集、補送、新 at、返回、清除、鍵盤／清理；300 則逐次輸入含同步 DOM 渲染量測 <50ms。


### 20.6 第 6 輪：HTML 相容性、話題檢視與搜尋回饋（jev 0）

- **R6-1**：取代 §20.2 整欄 fallback。plain 仍先截 8192、線性去標籤及限輸出長度；單一畸形片段不取消前文解析。屬性只有在等號後值開頭才啟用引號狀態，未引號值的 apostrophe 只是字元；未知 <![…]> 與 Word 條件標記段當宣告丟棄。不成標籤的 < 留原文，未收尾帶屬性或結束標籤尾段丟棄；未閉合引號且已有 > 則僅該片段按字面處理，再解析後文。保留 HTMLParser 的實體解碼與 script/style 行為，不呼叫 HTMLParser。刻意差異：HTMLParser close() 會把無 > 的截斷屬性／結束標籤尾段當文字，本版依本輪要求丟棄。驗收 29 個定向案例與 400 個真實樣貌 HTML 截斷位移零差異；原 S1 壓測每 feed CPU ≤2 秒及既有快照比對仍通過。
- **R6-2**：採用話題內可選類別的設計，取代 §18.21／§19 舊「切類別退出話題」。進話題仍先清空來源與類別；之後經 change 選類別保留話題與 savedView，題材／數字重設，面板與清單在話題×類別範圍計數。切來源仍退出話題；返回還原原檢視。測試全部經 click／change 到達話題內面板，不直接改類別值再 message；漫步檢查允許話題＋類別，仍檢查話題／類別的事件交集與來源退出規則。
- **R6-3**：話題內數字再點題材，從 selectedCount.topic 接回 selectedTopic，清數字、保留 savedView；與話題＋題材一致，返回原來源／類別／位置。
- **R6-4**：取代 §20.1 空狀態判斷。無話題、非 working 時，事件焦點按目前條件顯示；若空，只有在未篩選全部事件亦無三家、且沒有來源／類別／題材／數字／話題／搜尋條件時才顯示「目前沒有 3 家以上…」。被篩掉時隱藏，不誤稱全份資料沒有。只看追蹤與被篩光的既有話題仍隱藏，working 整理提示不變。
- **R6-5**：取代 §20.5 搜尋提示位置。搜尋命中數移入搜尋列，aria-live=polite，窄版可換行。輸入框改 text（不出現原生搜尋 ×），只保留「清除搜尋」按鈕；/、Esc、搜尋交集與不持久化不變。


### 20.7 第 7 輪：事件看最新報導（jev 0）

- 只在多報導事件代表下增加一條 nw-hint 連結，不增加按鈕、不換代表。從通過既有篩選的群組選 published 最大者；時間必須有效且嚴格晚於代表、報導與標題須不同。最新與代表同時間、同標題或只有一則時不顯示；不以較舊的不同標題替代最新者。
- 文字為「最新：{標題}（{來源}）」、textContent 安全寫入；單行省略，title 為完整報導標題。連結限 HTTP(S)，target/rel 同代表；非法連結不生成最新行。依 lastSeen 判斷新徽章，不受主列新舊分隔線規則抑制。
- 搜尋命中最新報導的標題或摘要時隱藏最新行，避免與自動展開、標示命中的子報導重複；輸入重用列節點時同步隱藏狀態，清除搜尋恢復。一般手動展開子報導照舊。
- 補送重新選最新報導；焦點身分區分最新連結與同網址的子報導，舊列合併的 href fallback 仍以正式報導連結辨識，不讓額外預覽造成假歧義。
- 原生 Tab 順序為代表連結→最新連結→摘要→展開（不存在者略過），摘要按鈕移至展開之前，無正 tabindex。驗收涵蓋選取門檻、來源篩選、同標題／同時間、徽章、安全連結／XSS、補送焦點、搜尋去重、順序與單行樣式。


### 20.8 第 8 輪：面板風向語意（jev 0）

- **R8-1**：財經、科技、國際、政治面板樣本列前新增 nw-hint「統計為全部{類別名}，未套用搜尋」。正規化後有非空搜尋才顯示，輸入／清除／類別切換／補送皆同步，即使搜尋只重畫清單也要更新。面板統計與所有既有資料規則不變；面板內的題材／數字篩選不加此提示。
- **R8-2**：財經股市四段用詞為「偏多／多空互見／與股市無關／偏空」，positive／mixed／idle／negative 等 id 不改；按鈕、數字篩選說明、長條 aria、title 及歷史比例／計數同步。報導基調仍為正面／負面／正反／中性。股市訊號旁加「依新聞內容判斷對股市的影響，非行情」，國際／政治不顯示此股市註解。大盤行改為「大盤方向：大盤／總經 N 個事件・利多 X・利空 Y」，保留三個可點計數與可見名稱，不新增 aria-label 蓋過文字。
- **R8-3**：清單財經題材標籤可見文字不變；有 ▲／▼ 時 title 與 aria-describedby 都是「這則新聞對{題材}偏多／偏空（依新聞內容判斷，非行情）」，未達方向門檻／無方向時為「題材：{題材}」。描述節點放在該列內、標籤之外，使用既有 nw-sr、唯一 id 與純文字，補送清理／搜尋節點重用皆不能留下失效關聯。
- **R8-4**：題材標題旁以圖例取代「（點選篩選）」：財經「紅＝偏多・綠＝偏空・灰＝無方向」，色點沿用 bull／bear／idle 的 token；國際「升級・緩和・無方向」，色點沿用 escalation／deescalation／idle（danger／accent／idle），不套財經紅綠說法；政治模式無方向圖例。小字及圖例可換行，所有 CSS 維持 .nw 範圍。
- 驗收：四類搜尋提示、補送／清除與數字不變；股市／歷史新詞、可點大盤、基調原詞；標記可見文字與 title／描述一致；財經→國際→政治切換圖例文字、色段 class 與可見狀態。


### 20.9 第 9 輪：事件數單位與緊湊提示（jev 0）

- **R9-0**：大盤方向保留前綴與三個按鈕、可見名稱不變；移除按鈕外「・」，僅用既有 gap 排版。
- **R9-1**：來源／類別選單統一事件數，採慣例分面計數：類別選項＝目前來源範圍內該類別的事件數；來源選項＝目前類別範圍內該來源的事件數；全部來源＝目前類別範圍的事件總數，全部類別＝目前來源範圍的事件總數。不受題材／數字／話題／搜尋／只看追蹤限制。切換對方維度會更新計數；這比固定完整資料數更能預告點選後的清單列數（未加其他篩選時）。非法 event 元資料逐則當獨立事件，沿用 groupItems；同事件跨來源／類別可列於多個選項，數字不應相加推算總數。body.sources.count 仍是後半報導數，本輪不改；前半來源數由 items 算出。補送與篩選變動皆更新，保留來源失敗／沿用舊資料短註、選值、焦點與選項節點；相同文字不重寫。狀態列新增 N 個事件不變。原先「各自按完整資料、互不影響」方案已依審核改為此分面規則。
- **R9-2**：§20.6 焦點空狀態的顯示條件不變；顯示時隱藏焦點標題、取消卡片底色與上下內距，保留左右文字對齊，以 nw-hint 一行「目前沒有多家媒體同時報導的新聞」呈現，title 為「焦點事件門檻：至少 3 家不同媒體同時報導」。working／有話題／有事件回復既有卡片呈現，被篩光仍隱藏。
- **R9-3**：「追蹤設定」改名「追蹤關鍵字」。只看追蹤 N 按鈕 title 與穩定的 aria-describedby 節點同步為「只顯示標題或摘要含你的關鍵字的新聞（N 個事件）」，N 仍沿用既有篩選範圍的事件計數。未設關鍵字仍隱藏／停用只看追蹤，強制事件不啟用；打開關鍵字設定顯示「先輸入並儲存關鍵字，即可使用『只看追蹤』篩選標題或摘要。」引導，儲存關鍵字後隱藏。描述與引導皆純文字，unmount 清理。
- 驗收：多 feed 同事件只計一次、非法 event 獨立計數、雙向分面計數逐項經 change 驗證等於清單列數、補送重算及失敗標記；漫步同時驗來源／類別事件數；空狀態與卡片恢復；追蹤描述數字、零關鍵字引導與不啟用；大盤按鈕名稱及 gap。


### 20.11 第 11 輪：已分析樣本與新進展切換（jev 0）

**R11-A：缺分析不等於無關**

- 每事件仍取符合範圍的最早有效分析。缺有效分析的事件不貢獻四個方向按鈕，也不進方向長條分母；有效分析的 other 沿用未明／無關色段，與缺分析區分。四鈕合計＝已分析事件數，按鈕與清單共用 contributes 判斷。
- 財經／科技、國際與政治樣本列加「已分析 X／N」。有缺額且分類啟用、model 非 paused 時顯示「待判定 Y」；關閉／失敗或其他 paused 狀態沿用狀態列既有原因文字，缺額不冒充無關。無有效分析時四鈕為 0、色條寬度為 0。
- 24 小時每段色條也只以有效分析事件為分母；有效樣本不足門檻、方向比例排除無關的分母規則不變。題材／地區／議題排行原本只收有效分析，本輪不改：外條依最多事件的排行項目縮放，內部方向以該項目事件數為分母。
- 驗收：財經與國際全待分析、逐批補送 X+Y=N、四鈕合計 X、各按鈕結果數、auth／no_key／paused 路徑，以及歷史色條與題材樣本。

**R11-B：只看上次離開後的新進展**

- 狀態列「新增 N 個事件」改為原生 button，aria-pressed 同步；沒有 lastSeen 或 N=0 時隱藏且 disabled，清空按鈕文字、不加其前方分隔符；其他狀態欄位之間的正常分隔符仍保留。N 依目前清單其他篩選後、至少有一則 published>lastSeen 的事件計算，不把「新」稱為已讀／未讀。
- 開啟後仍以完整事件保留舊代表及其他報導，不把舊事件的新報導排除。與來源、類別、題材、數字、話題、搜尋及只看追蹤取交集；搜尋命中舊代表也可保留同事件的新進展。題材限制先套個別報導，最後再確認篩選後事件仍有新報導。
- 面板與 24 小時統計先限於目前來源／類別／話題中有新報導的事件；題材／數字／搜尋仍不縮面板，追蹤仍隱藏面板。來源與類別選單的分面計數規則不變。樣本列開頭加「上次離開後的新進展：」，例如「上次離開後的新進展：11 個事件（14 則報導）…」，關閉時移除。搜尋不縮面板、新進展會縮；同時開啟時，R8「統計為全部{類別名}，未套用搜尋」提示與新進展樣本前綴並存，表示目前面板的新進展範圍不再按搜尋字縮小。四種分析類別、同／新 at 補送、搜尋交集與關閉均須驗收。
- 清單上方 nw-hint 顯示「只看上次離開後的新進展（N 個事件）」與「關閉新進展篩選」鈕。即使補送或其他條件讓 N 歸零，也保留退出入口；空狀態的清除篩選同時取消此開關。
- 此模式下展開子報導，僅 lastSeen 後者加既有「新」徽章；關閉恢復原本不標的行為。代表選擇、新舊分隔線基準不變。
- 同 at／新 at 補送保留並重算；進話題保留此開關，返回還原進入前狀態；不寫 localStorage。狀態按鈕節點不在補送時換掉；unmount 移除兩個新監聽，窄版提示列可換行且與清單同左緣。
- 驗收：舊事件含新報導、全部篩選交集、同／新 at 補送、0 與無基準、子報導徽章、話題返回、清除全部、焦點與 unmount。新增 11 個前半測試（含四類面板範圍提示），並按上述新規則更新既有統計斷言。


### 20.12 第 12 輪：報導基調可核對（jev 0）

- **計數與範圍**：首頁焦點話題列，以及進入話題篩選後仍顯示的同一話題列，共用基調入口；不另複製第二組基調條。沿用至少五則有效基調才畫條的門檻、固定色段順序及文字按數量排序。每個非零計數為原生 button，§20.23 改可見文字為「負面／中性／正反並陳／正面 N」，行首「報導語氣（則）：」，aria-label 為完整「名稱 N 則報導」且包含可見文字；aria-expanded 與 aria-pressed 同步。
- 先驗證 topic.tone 原有格式與上限，再以目前 items 中該話題、tone 為四種合法字串的逐則報導計數。按鈕數字必等於核對區報導數，不用無法列出依據的聚合數；同事件多報導仍分開計算。缺失／非法 tone 不進四類，依目前話題成員數扣掉已判定數顯示「待判定 N 則」，N=0 不顯示；有效基調未滿五則時仍可顯示待判定。
- **展開**：點按鈕於該話題列下方展開核對區，標頭固定「依標題與摘要判斷的報導基調・按報導計」，另列選取基調與報導數。完整話題範圍不受清單來源／類別／題材／數字／搜尋／追蹤／新進展篩選縮減；既有焦點的話題可見性規則不變。報導逐則顯示標題連結、來源、時間，連結安全規則同主清單，非法網址只顯示文字。
- 摘要重用清單的摘要元件、來源摘要標籤、42em 行寬、aria-controls 與 aria-expanded；以個別報導的來源／連結／標題識別，不用 event id 共用狀態。文字一律 textContent；補送清理已離開快照的摘要狀態。
- **收合與生命週期**：全模組只開一個話題／基調，點另一個取代；再點同按鈕或模組內非輸入區 Esc 收起，焦點回原按鈕。Esc 優先收核對區，不同時清搜尋。補送依話題 id＋基調保留並重算報導、數字、待判定數；核對中的連結與摘要控制可還原焦點。話題消失、所選計數歸零、有效數不足或話題被篩選隱藏時收起，不在資料返回時自行復開；原按鈕不存在時沿用既有焦點保底。
- **呈現**：核對區跨話題列整行，文字可換行、長標題與來源 overflow-wrap:anywhere；基調採輕量文字按鈕：無預設外框／底色、各基調文字色、數字加粗，hover 底線，aria-pressed=true 加粗底線，保留 focus-visible 焦點框。縮小 padding 與間距，380px 目標含「報導基調：」兩行內；按鈕可自然換行，沿用深淺色 token。unmount 移除新增監聽並清掉選擇，不新增本機儲存或後半／模型請求。
- **驗收**：完整兩話題 fixture，包含同事件不同基調、未完成基調、逐段數字＝列數、單一展開區、摘要獨立展開、Esc／再次點擊與焦點、同／新 at 補送更新、話題／基調消失、篩選後消失、話題內搜尋、聚合數不一致、非法資料／XSS、窄版換行 CSS、unmount。既有只有聚合數的有效測試補齊逐則 tone 與報導，維持原來門檻與格式驗證斷言。


### 20.13 第 13 輪：首頁跨類別風向速覽（jev 0，讀者評估通過）

- **顯示條件與位置**：有列表後，全部類別且非話題／話題內數字篩選、非搜尋（依正規化後非空字串）、非只看追蹤時才顯示；分類關閉時隱藏，沿用既有狀態原因。放在工具列末端、焦點上方，nw-hint 大小，無新卡片底色。普通來源選取與只看新進展不隱藏速覽。
- **計數**：財經只收 finance（不混 tech），國際只收 world；各自先套目前來源，再分事件，取最早有效分析。只看新進展啟用時也套同樣事件範圍，按鈕類別名後明示「新進展」。使用與面板相同的 contributes 函式；缺分析不計入方向，數字必須等於點過去後面板對應四段按鈕的數字。
- **文字與誠實度**：開頭固定「新聞風向（非行情）」，各方向數字帶事件單位「件」：「財經 偏多 X 件・偏空 Y 件」／「國際 升級 X 件・緩和 Y 件」。每類別已分析事件合計<10（含 0）時，在該段末尾加「（樣本少）」；不再使用原本 <5 隱藏方向數的規則，0 也顯示實際計數。只要有缺分析，無論 working／paused，都在可見文字附「（已分析 X／N）」，不是只放 title；全部已分析才省略覆蓋率。title 另列完整事件樣本數、依標題與摘要判斷及財經非行情的限制。
- **互動與樣式**：每段是原生 button，可見文字即 accessible name，不另蓋 aria-label；點下等同手動選類別下拉，保留來源及新進展開關，依既有規則保存改動的類別欄位，焦點移到類別選單。主詞與兩段以「｜」區隔，分隔符與後方按鈕包為一組、aria-hidden，不混入按鈕名稱；字級 12px、透明無框、hover 底線、保留 focus-visible。窄版可在「｜國際」前換行；長文字必要時也可換行，不裁切、不省略。不增加 localStorage key；補送重算，unmount 移除監聽。
- **測試與收件**：新增八個測試，涵蓋全部／單一來源×新進展開關、同事件報導分析不同與首篇無分析、財經不混科技、少樣本 0／4／5／9／10 邊界、部分／完整覆蓋、同／新 at 補送、paused／關閉、話題／搜尋／追蹤隱藏、點選後面板數字一致、偏好與焦點、換行 CSS 與 unmount。讀者 A/B 評估通過：A 無速覽時無法答出財經／國際風向（把握 20%）；B 可回答（80%／50%）。依回饋補上新聞主詞、非行情與「件」單位，避免被讀成行情或「第 4 級」；文字改版後仍待真殼窄版確認。


### 20.14 第 14 輪：話題偏好、搜尋與新進展交集修正（jev 0）

- **R14-1**：話題內（含由話題進入數字篩選）切換類別只改當前檢視，不寫 view；一般來源／類別切換仍只保存改動欄位。返回原檢視（包括手動返回、再按同話題、話題消失自動返回）在套用有效來源／類別後，將實際還原的兩欄寫回 view，讓重載與畫面一致；儲存仍經 saveState try/catch。
- **R14-2**：採「收起即清除搜尋」。點搜尋入口收起時清空輸入、移除搜尋交集與命中提示、aria-pressed=false，焦點回搜尋入口；再展開、同／新 at 補送不復活舊搜尋。不另新增隱藏搜尋狀態或持久化。
- **R14-3**：題材的有效性先按目前來源＋類別＋話題範圍的個別報導檢查，不用最早代表的事件層級題材，也不因新進展範圍變窄而取消。清單題材仍先套個別報導，新進展再以群組是否含 lastSeen 後報導取交集，按鈕新增數＝點後列數。關閉新進展會恢復同題材的較舊事件；新進展暫時零筆仍保留題材與清除入口。來源／類別／話題原範圍真的沒有該題材才自動取消。返回原檢視也沿用此驗證，不再依面板排行是否出現該題材另行清除。分析面板及速覽沿用既有事件分析規則，本輪不改數字。
- **R14-4**：清除搜尋前，若焦點在搜尋自動展開的子報導且該事件不在手動 expanded，先將焦點移到該列展開鈕，再清字重畫；restoreFocus 不會因此把隱藏子報導轉成手動展開。原本手動展開者保持原狀；後續補送與無關篩選重畫也不得復活搜尋暫時展開。
- **驗收**：先跑 fdf1381 審查快照 A／B／C／D（全部重現），C2 觀察到新增數 1→2、題材被清。改寫為 repo 的八個回歸測試：三種話題返回／重載、收搜尋／再開／補送、同事件異題材的新進展交集、零結果及真正題材消失、搜尋暫時展開與手動展開對照；修前七個失敗、手動展開對照通過。既有持久化及搜尋收合測試依本節新規則更新斷言。


### 20.15 第 15 輪：快捷鍵可發現性（jev 0）

- **入口與區域**：狀態列末端提供原生小字按鈕「快捷鍵」，與狀態文字放同一可縮排容器；窄版可只見 ? 圖示，但透過螢幕閱讀器可讀的文字保留名稱「快捷鍵」。aria-expanded、aria-controls 與唯一 id 關聯清單上方說明區。說明區 role=region、aria-label=鍵盤快捷鍵、tabindex=-1，不用 dialog／aria-modal，不做焦點圈限。
- **說明內容**：j／k＝下一則／上一則新聞，s＝開關目前新聞摘要，e＝展開／收合同事件其他報導，/＝開啟並聚焦搜尋，Esc＝依序收起基調核對區／清除搜尋／收起本說明（每次一項），?（Shift+/）＝開關本說明。s／e 仍需焦點在新聞列內且有相應控制，j／k 仍只走主列有效連結；不宣稱不存在的方向鍵或全域鍵。
- **? 與焦點**：僅焦點在模組內、非 input／select／textarea／contenteditable、非組字且無 Ctrl／Meta／Alt 時處理 ?，允許 Shift 產生 ?；其他既有快速鍵仍拒絕 Shift。忽略 ? 自動重複以免按住閃動。開啟記錄焦點節點與既有身分，聚焦說明區；再次 ?、再次入口按鈕或輪到說明的 Esc 收起，先依身分還原，再試仍存在可見的節點，失效則回快捷鍵入口。若原目標是清除搜尋後已收合的子報導，還原至該列展開鈕，不重新展開或寫入 expanded。
- **Esc 優先序**：模組非編輯區與搜尋輸入框共用「基調核對區→有字的搜尋→說明」；一次只做一項。三者同時存在時第一次收核對區並回基調鈕、第二次清搜尋、第三次收說明並還原開啟前焦點。搜尋 Esc 不順便收說明，? 則只切換說明，不動搜尋／核對區。其他輸入區不攔截；基調與搜尋既有清除時焦點規則保留。
- **生命週期與版面**：說明開關只在當次 mount 記憶，補送不收起；不新增儲存 key、不呼叫模型。使用 .nw token、可換行雙欄鍵名／說明，unmount 移除入口與根鍵盤監聽、清掉還原目標。
- **驗收**：七個新增測試，涵蓋搜尋子報導還原不污染手動展開、Shift+? 開關／補送後焦點、可見入口／原生 Tab、輸入框當文字及修飾鍵／組字／模組外不處理、三層 Esc 順序（非輸入區與搜尋框）、消失目標保底、unmount；既有 j/k/s/e 與搜尋回歸測試照舊。


### 20.16 第 16 輪：前半跨功能隨機漫步（jev 0）

- **規模與重現**：`tests/front.walk.test.mjs` 預設固定 seed 1～200，各 100 步，納入 `npm test`。`NEWS_WALK_SEEDS`／`NEWS_WALK_STEPS`／`NEWS_WALK_SEED` 可調整組數、每組步數與起始 seed；失敗列出 seed、從 0 起算的步號與最近 30 個動作，單組重跑保留相同亂數序列。另用多個隨機起始 seed 做 2,000 組本地探索。
- **動作與資料**：使用真實 mount／unmount 與 DOM click／change／input／keydown；包含數字篩選、話題內切類別、搜尋開關／輸入／Esc、只看新進展、基調核對、速覽、快捷鍵說明、題材、追蹤編輯、重新整理、摘要與事件展開。補送同 at／新 at，話題可消失、事件 id 可改變，報導跨 lastSeen 前後，分析與基調可尚未完成。小型多來源、多話題 fixture 保留同事件多報導，以控制 CI 時間；300 則效能仍由既有專門測試驗證。
- **每步不變式**：從封包獨立分群、挑選代表分析與計算交集，核對清單事件數、新進展及搜尋數字、面板各計數、速覽及兩個下拉的分面數；抽查實際選取後列數，速覽點後比對面板。搜尋／追蹤可再縮清單而不縮面板，這時核對交集，不誤要求原面板數字等於縮小後列數。焦點不能位於 hidden／disabled，ARIA 開關須符合對應區塊，基調核對同時至多一個且數字等於報導數；不得拋出例外。整批另斷言各主要操作確實發生。
- **保存規則例外**：只允許 lastSeen／watch／history／view 四個既有 key，逐次核對預期寫入的 view。畫面與保存值逐欄一致，但「清除全部」、話題內暫時篩選（含手動切來源離開後仍暫時的類別）、分類尚不可用／關閉時未套用的類別為刻意例外；只手動改一欄只解除該欄例外，返回原檢視保存實際還原兩欄。不得為了測試一致性覆寫另一欄偏好。
- **本輪結果**：`npm test` 458/458 通過（含固定 20,000 步），同機本輪基準 7.05 秒、最終全套 16.57 秒（增加 9.52 秒）。本地四組隨機起始 seed：496068197、421586374、657887643、880126401，各 500 組×100 步，合計 2,000 組／200,000 步全綠；實際點選核對 4,511 次分面與 1,303 次速覽，包含 791 次話題內切類別及 276 次目前話題消失。未發現需修改產品程式的問題；測試模型曾漏列「話題內同數字鈕再按一次會返回並保存」的合法路徑（seed 496068692、step 19），補齊模型後同 seed 與全批重跑通過。


### 20.17 第 17 輪：螢幕閱讀器文字的定位範圍（jev 0）

- **問題與修正**：cc 真殼量到 130 個絕對定位的 `.nw-sr` 以殼的 main 為定位參考，main 高度 599px、scrollHeight 卻達 20399px，深淺主題皆出現額外垂直捲軸；實測 `.nw` 加 `position: relative` 後 scrollHeight 回到 599px。模組根以此建立定位參考，限制於模組自身，不修改殼。
- **既有定位**：根元素不加位移、z-index 或 overflow，仍留在正常排版，不新增捲動容器。目前模組沒有 sticky／fixed 規則；既有絕對定位只有 `.nw-sr` 與窄版快捷鍵的隱藏名稱，兩者改以模組根為定位參考。
- **隱藏文字**：`.nw-sr` 已使用標準 visually-hidden 寫法：absolute、1px 寬高、零 padding／border、-1px margin、overflow hidden、clip rect 與 clip-path inset(50%)、white-space nowrap，保留不改；不得改成 display:none 或移除無障礙描述。
- **驗收**：CSS 回歸測試斷言根規則及計算樣式為 relative、沒有位移／新捲動設定，並鎖定 `.nw-sr` 的裁切與尺寸宣告。移除根定位時測試失敗；happy-dom 不計真實 scrollHeight，捲軸與深淺主題仍以真殼驗收。


### 20.18 第 18 輪：§19 與程式一致性核對（jev 0）

核對基準為 `a00347c`，讀完 §19、front 三個模組及 back 全部 Python 檔；對照 §20.1～§20.17 決定現行規則。以下「文件」均已修正；「程式」僅重現、列報，不改正式程式與測試。README 同步用白話簡短補新功能及更新過時敘述。

| 編號／判定 | 不一致與處理 | 實作依據（本輪行號） |
|---|---|---|
| D1 文件 | §19 開頭只標更新到 §20.4；改為已核對至 §20.17／a00347c。 | 本輪 Git HEAD |
| D2 文件 | §19.1 安全段仍泛稱畸形欄位保留字面，易被當成整欄 fallback；改為局部保留／丟棄，引用 §20.6。 | `back/feedparse.py:121`、`:217` |
| D3 文件 | outlet「不得空白」不精確；改成不得全空白／頭尾空白。配對未完成保留話題仍寫三家「來源」；改成不同 outlet。 | `back/news.py:53`、`back/scheduler.py:522` |
| D4 文件 | 分析晚到結果只寫與「已知」kind 比較；補明實際使用 analysis_kind，未知／非 world／politics 回 finance，與保留既有快取不同。 | `back/analyze.py:92`、`back/scheduler.py:315`、`:698` |
| D5 文件 | §19.2 樣式未納根元素定位與 visually-hidden 規則；補 §20.17，不宣稱 happy-dom 能量 scrollHeight。 | `front/style.js:3`、`:27`、`:197` |
| D6 文件 | 工具列未列搜尋／快捷鍵，選單分面排除條件漏新進展；補入口、排除範圍及同事件選項不可相加。 | `front/front.js:92`、`:252`、`:1106` |
| D7 文件 | 焦點段像是來源／類別永遠篩話題入口；補 selectedTopic 話題檢視中保留所有入口，話題卡不跟搜尋／新進展縮減。 | `front/front.js:555`～`:568` |
| D8 文件 | 基調區漏 topic.tone 的合法性前置檢查、五則門檻也控制按鈕；Esc 描述漏搜尋框，視覺漏輕量鈕。補驗證、按鈕條件、樣式與共用 Esc 順序。 | `front/front.js:467`、`:1350`、`:1373`；`front/style.js:85`～`:89` |
| D9 文件 | 「數字、題材、話題不疊加」與 §20.6 後程式矛盾；改為數字與題材互斥、話題作保留範圍，可配內部類別與其中一種篩選。 | `front/front.js:781`、`:949`、`:993` |
| D10 文件 | 國際第四段描述像可見「無關含未明」、歷史仍用正面／負面／正反；分清可見「無關」與有效 other，歷史改偏多／偏空／多空互見。 | `front/front.js:719`、`:856`、`:892` |
| D11 文件 | 清單資訊順序漏搜尋命中；全新事件「清單只靠新增數」未排除最新連結的新徽章。補順序並限定主列徽章，保留最新連結規則。 | `front/front.js:1240`、`:1276` |
| D12 文件 | 摘要未限定非空、未寫換 event id 後展開／摘要移轉；補非空與共同 link、快照移轉及焦點沿用。 | `front/front.js:1307`、`:1401`～`:1419` |
| D13 文件 | 話題進入的保存欄位漏數字／新進展、未明說保留搜尋；補完整範圍，及非話題暫時欄位可與已存 view 不同的例外。 | `front/front.js:661`、`:959`、`:993`、`:1378` |
| D14 文件 | §19 搜尋仍寫收起不清、Esc 一律清除、所有「清除篩選」都清全部；空狀態漏搜尋優先。改為收起即清、Esc 三層順序、區分空狀態／面板／話題的清除，補搜尋空文案。 | `front/front.js:987`、`:1318`、`:1332`、`:1373` |
| D15 文件 | 日期的 feedparse:145 與 §19.5 多組 front／first_seen 行號過時；改用函式名與具體區塊定位，§19.5 標明歷史索引。 | `back/feedparse.py:_iso`／`parse_feed`；`front/front.js:isDateOnly`／`renderList` |
| D16 文件 | README 仍用來源報導數、舊失敗文案、缺分析當未明、舊財經詞、話題切類別退出／返回不保存、子報導永不標新、追蹤設定，以及漫步 20×300。逐項更正，補速覽、面板數字、臨時搜尋、新進展切換、基調核對、最新報導與快捷鍵入口；門檻與保存規則沿用本節。 | `front/front.js:738`～`:1012`、`:1106`～`:1185`、`:1509`～`:1526`；`tests/front.walk.test.mjs:8`～`:10` |

**程式落差，待 cc 審核（本輪不修；後續修正見 §20.19）：**

- **P1：只看追蹤 N 未套完整清單交集。** §19.2／§20.9 說按目前篩選範圍計事件，實際 `front/front.js:1143` 在搜尋前計數，`:1151` 才做搜尋與最後的新進展檢查。happy-dom 兩個不同事件標題「AI needle」「AI other」、追蹤 AI、搜尋 needle：顯示「只看追蹤 2」，點後只有 1 列。另一例：A 事件有舊 memory／新 foundry，B 有新 memory，三則均命中 AI；選 memory 再開新進展，追蹤仍 2、清單 1。建議將追蹤 N 在搜尋與題材後的新進展資格確認之後、只看追蹤本身之前計算；保留開關交集語意。
- **P2：其他地區／議題最多時長條超過 100%。** §14.4／§20.11 要求外條以最多事件的項目縮放；`front/front.js:912` 將 other 固定排最後，`:940` 卻用排行第一項作分母。happy-dom 六個國際獨立事件：美中 1、其他 5，實際寬度 100%／500%，應為 20%／100%。政治同樣受影響。建議排序與縮放分母分開，用排行內實際最大 count，其他仍排最後。
- **P3：配對 pending 時，跨輪已排入的話題仍可開始新請求。** §19.1／§18.9 要求配對未完成不新開話題請求。`back/scheduler.py:570` 只在排話題時守 pending；`:364`／`:413` 取工作只看佇列、admitted 與未接收結果，未看仍在途的配對。離線 fake client 重現：目前 work=2、events.pending=1、event_in_flight 非空、事件佇列已被其他 worker 取完，topic_jobs 留 work=1 的候選；實際 worker 仍呼叫 TopicMatcher。建議在話題准入點補配對依賴守衛，涵蓋跨輪舊候選，不阻止已在途請求完成；需檢驗較低優先工作與共用預算不被誤卡。

驗證均離線：兩個 happy-dom 計數案例、國際長條案例及假 client worker 皆重現上述輸出；未呼叫 jev，也未執行真 RSS。僅改文件，未重跑整套程式測試；以 diff 檢查確認沒有 front／back／tests 變更。


### 20.19 第 19 輪：計數、排行縮放與話題准入修正（jev 0）

- **R19-1**：「只看追蹤 N」在來源／類別／話題／題材／數字／搜尋及新進展交集後、只看追蹤開關之前計數。題材先套個別報導，再判事件有無新報導；N 等於按下後列數。新增搜尋與題材＋新進展兩個 UI 回歸案例，先確認舊版均為 2 對 1。漫步每步也用獨立資料 oracle 驗追蹤 N，按下時直接比清單列數。先前漫步驗了清單交集、搜尋／新增／數字等計數與追蹤顯隱，卻沒有驗追蹤鈕上的 N，因此清單本身正確就會通過。
- **R19-2**：題材／地區／議題外長條以顯示項目的實際最大事件數作分母，與排列順序分離；其他地區／議題仍排最後。國際與政治各測一般項目 1、其他 5：舊版 100%／500%，修後 20%／100%。內部方向比例不變。
- **R19-3**：worker 取話題前，若 event_in_flight 尚未清空則跳過話題 lane，分析／基調仍可執行；未接收結果的既有守衛不變。配對結果可能已提交而 last_list 的補送尚未完成，故真正准入時以可見候選與最新 event_cache 確認，不單憑舊封包 pending。若沒有在途配對卻仍有未解決候選（失敗、預算耗盡或等待下輪），不呼叫 TopicMatcher，透過正常空結果釋放舊 topic in-flight，留下一輪重排；這種延後不算 API 失敗，也不令舊 ModelRound.failed 變 true。已在途請求不強制中斷。
- **先紅後綠**：四個前半回歸測試先紅；後半假 client 測試先重現舊話題搶先，以及失敗／預算結束後仍呼叫話題。修後涵蓋等待時分析可進行、配對接受後即使列表 pending 尚未更新也可繼續，以及失敗／預算／waiting 三路都釋放去重鍵、不死等。
- **驗證結果**：`npm test` 463/463；漫步 200 個 seed × 100 步（20,000 步，201 個測試）全綠；`/usr/local/bin/python3 -m unittest` 357/357；最終程式的 chaos 6 份並行 × 5 波，30/30 全綠（每份預設 60 個固定 seed 案例）。全程離線，jev 0，未 commit。


### 20.20 第 20 輪：實際 HTTP 用量與全來源失敗提示（jev 0）

- **R20-A 計數定義**：stderr `model round=` 原有欄位與順序保留，`requests=` 仍是准入批次；行尾新增 `http=H retries=R total_http=T total_retries=U`。http 在每次 HTTP opener.open 前加一，包括連線失敗；重試也加 http，且從該批第二次 open 起加 retries。睡過退避但未真正重試不計；空批、TLS 前置拒絕、disabled、預算拒絕都不算 HTTP。429→529→200 為 requests=1、http=3、retries=2。
- **歸屬與累計**：每次 worker 呼叫用 ContextVar 帶原 ModelRound 的觀測 callback，finally 還原；client 不存可互相覆寫的 per-call 計數。三 worker 在 cv 下累加原 round 及 process 的計數，刷新後的重試仍屬舊 work。每輪完成行的 total_http／total_retries 是當時本 process 已發起總量，可能包含其他在途輪，不應將多行 total 相加。原本沒有准入請求的輪不印行，body.model 不增欄位。停止時未完成輪不保證另有結算行。
- **腳本摘要**：`scripts/real_run.py` 保留原始統計行，另印 `model_usage (completed rounds): requests=… http=… retries=…`；只加總已完成行，不將 total 欄位相加。舊 backend 缺新欄位則為 unknown，零統計行為 0；逾時／中途停止的摘要不代表完整 process 消耗。
- **R20-B 全來源失敗**：非空 sources 且每個來源 `ok===false` 才適用。至少一個有效 last_success 時主文字改「更新失敗，沿用 HH:mm 的資料」，跨本地日為「更新失敗，沿用 M/D HH:mm 的資料」。時間取最新一次任何來源成功確認，代表最後還有更新成功的時點，避免最舊來源長期失效把整體時間一直拉回；不代表所有來源同時新鮮。title 列各來源自己的最後成功年月日時分秒與截短錯誤，未成功者保留失敗明細；來源下拉仍沿用各自 R3 註記。
- 全來源無有效 last_success 時顯示「尚未取得新聞：所有來源連線失敗；請按「重新整理」重試」，既有重新整理按鈕可操作。全掛不再顯示本輪 at 的「更新」或重複來源失敗摘要；模型／分類等其他狀態仍保留。空 sources 不推定全掛；部分失敗維持 R3，任一來源恢復（含 304）即恢復更新時間及部分失敗提示。判斷不依 published，舊報導成功確認也算成功。
- **測試**：三 worker 以 barrier 同時進入假 HTTP，分別重試 2／1／0 次，驗批次各 1、HTTP 各 3／2／1、原輪歸屬、累計 6／3、敏感文字不入 log；連線失敗計 1、TLS 前置失敗計 0。前半假 clock 驗成功→全掛→跨日→304 恢復、最新而非最舊確認、title 各來源時間、首次全掛與空 sources。腳本以離線假 backend 跑實際 subprocess，驗新舊統計行與協定退出。
- **結果**：`npm test` 465/465、漫步 200×100 步（201 個測試）全綠；`/usr/local/bin/python3 -m unittest` 360/360。另實際移除 TYPESAFE_API_KEY 執行 real_run.py：2.05 秒取得 300 則，off／exit 0，摘要 requests=0 http=0 retries=0；jev 0。

- **併修 R19 deferred 回歸**：未發 HTTP 的 deferred 結果不增加 awaiting；所有模型結果攜帶 accounted 標記，只有實際加過的結果在接收時扣回，避免未登錄 work 遺留 +1，也避免已登錄 work 誤扣成負值。以原審查腳本改寫測試，未登錄與已登錄兩路皆驗 deferred→同輪 tone 的 awaiting/running 歸零、model_rounds 移除、只印一行；tone 經 429→529→200 仍正確列 requests=1（若先前已有批次則加計）、http=3、retries=2。修前未登錄路徑 awaiting=1、不印行；修後原腳本 awaiting=0、logged=True、無殘留。
- **話題准入候選快取**：依 last_list 物件身分快取一份非自動配對 key 集合，不快取 unresolved 布林值；每批仍查最新 event_cache，所以答案提交與 FIFO 淘汰立即生效。同一列表多次檢查只呼叫一次 candidate_pairs，替換列表就重算，最多持有一份列表與候選。300 則離線 fixture 全部候選已解決時，本機中位數由重算 19.765ms（10 次）降為快取查詢 0.015ms（100 次）；不作硬體無關效能保證。
- **併修後驗證**：Python 全套 362/362；chaos 6 process 並行 × 5 波，30/30 全綠（每份預設 60 seed 案例）；前半未再變動，沿用本輪 465/465 與 20,000 步漫步通過結果。jev 0，未 commit。


### 20.21 第 21 輪：手動閱讀基準與暫停原因（jev 0）

- **R21-A 標為已看**：在狀態列新增數附近提供「標為已看」，與「新增 N 個事件」同條件顯示：N=0 或 lastSeen=null 時隱藏；基準可推進時可按。復原顯示期間隱藏標記鈕，復原本身不因 N 歸零而隱藏。以整份目前列表（不受篩選影響）的最新有效 published 與 at 取較新者，上限為現在；立即寫入既有 `modudock.module.news.lastSeen`，重算新增事件、分隔線、主列／子報導／最新連結徽章與面板新進展範圍。正常資料新增歸零；來源容許的未來報導仍算新，不為歸零而把基準推到未來（cc 確認）。不自動觸發、不關掉只看新進展；因此空清單仍能用既有關閉鈕退出。
- **復原期限**：提供當次「復原」一次，恢復操作前此頁的基準並立即寫回；下一份 list 到來即失效，同 at 補送也算，不新增計時器。按標記後焦點移至復原；復原或期限到後移至可用標記鈕，否則清單，不能留在 hidden 元素。移除模組時清掉新監聽與復原快照。
- **多分頁與儲存**：手動標記／復原以最後寫入為準，不聽 storage 事件、不更新別頁畫面；儲存失敗仍可操作本頁。離開／unmount 保留原本重讀儲存值並取較新者的保護，不能由舊頁覆蓋其他頁較新的基準（cc 確認）。無新增持久化 key。
- **R21-B 暫停細分**：保留 `model.reason=failed|budget|waiting`。只有 paused/failed 加 `failure=busy|connection|response|other`：429／529 重試耗盡為 busy；網路／socket 或讀取逾時為 connection；JSON、回應結構／答案驗證失敗為 response；其他 HTTP 或本地未知失敗為 other。認證失敗仍走 off/auth。每批使用獨立 ContextVar，work 記第一個失敗代碼；跨執行緒／跨輪不共用最後錯誤。只傳固定代碼，不傳例外、回應內容、key 或 URL。
- **呈現**：短字維持「整理暫停，下次更新繼續」（waiting 維持「整理暫停，等待下次更新」）。status.title 與專用 aria-describedby 文字提供：忙碌→稍後自動重試；連線失敗→檢查網路、下次更新重試；回應無法使用／其他→下次重試、持續發生可聯絡維護者；budget→本輪預算用完、下次更新繼續；waiting→等待下次更新接手。非法／缺失 failure 用其他提示，恢復非 paused 時移除建議，不覆蓋來源明細或認證指引。
- **大小與測試**：MODEL_RESERVE 覆蓋最長 `paused/failed/connection` 形狀；微小 items 的 900 KiB 邊界測試確認補送不再砍列。假 clock 驗早→午→晚、手動歸零、之後新報導增加、復原一次、同／新 at 失效、首次 null、多分頁手動覆寫與既有離開保護、儲存失敗、未來 clamp、焦點及 unmount。假 server 注入 429／529、逾時、壞 JSON、缺答案、500，核對安全代碼；前半驗 title／describedby、非法值、恢復清除。
- **驗證結果**：`npm test` 477/477（含固定 200×100 步漫步）；`/usr/local/bin/python3 -m unittest` 364/364。新增失敗代碼嚴格白名單，包含物件、toString／__proto__ 等非法值皆用安全建議。`git diff --check` 通過；jev 0，未 commit。


### 20.23 第 23 輪：讀者密度走查的用詞與入口（jev 0）

- **R23-1 新的層級**：工具列保留完整「新增 N 個事件」。焦點話題進展改 accent 小字「+N 新事件」，note 的 accessible name 保留「上次之後新增 N 個事件」。焦點與清單事件的「最新：」行一律不加新徽章；標題前既有新徽章不變，計數及篩選規則不改。本條取代 §18.20／§18.39／§20.7 的相應顯示規則。
- **R23-2 次要入口**：「標為已看」、復原、「快捷鍵」與新增按鈕同用 30px 最小高度、細框與 hover 底線／accent 邊框，保持原 status group。窄版快捷鍵顯示帶圓框的 ?，按鈕 aria-label／title 均為「快捷鍵說明」，寬版可見「快捷鍵」。不改面板收合、2×2 配置或焦點入口文字，那些留下一輪。
- **R23-3 完成不列進度**：財經／科技／國際／政治樣本只在已分析 X<N 時顯示「已分析 X／N」；待判定原條件不變。速覽原本僅缺額時顯示覆蓋率，title 也同步僅缺額時顯示。
- **R23-4 基調短字**：mixed 的前半名稱統一為「正反並陳」，含焦點、核對區、清單與子報導小標。行首為「報導語氣（則）：」，按鈕可見「負面 11」這樣的短式，數字仍加粗；aria-label 保留「負面 11 則報導」，完整包含可見字，維持 label-in-name。核對區內重述仍用含單位的完整名稱。id、排序、配色、逐則計數與後半驗證過的 criteria 原文不改（§20.34 已將 UI mixed 統一為「正反並陳」，API criteria 原文不變）。
- **R23-5 大盤其餘**：在利空按鈕後加非互動 nw-hint「其餘 N 件無明確方向」，N=大盤總數−利多−利空，N=0 不建立此文字；包含中性與方向信心不足的事件。仍只有三個原有計數按鈕，不新增篩選。
- **驗收**：更新舊文案斷言，保留標題新徽章、核對數字＝報導數、原文連結與鍵盤操作檢查；補按鈕框／高度／窄版圓框、基調可見與無障礙名稱、全數分析後隱藏與逐批缺額、大盤其餘歸零的測試。真殼排版由 cc 截圖審查。
- **驗證結果**：`npm test` 481/481（含固定漫步）；`/usr/local/bin/python3 -m unittest` 364/364；`git diff --check` 通過。jev 0，未 commit。


### 20.24 第 24 輪：窄版版面（jev 0）

- **R24-1 面板收合**：以 ResizeObserver 觀察 `.nw` contentRect.width，≤480px 為窄版（不是 viewport）。財經／科技、國際、政治共用本次 mount 的展開選擇，預設收合；補送、換類別與寬窄切換不重設，不持久化。寬版完整面板常駐，摘要入口隱藏。按鈕 aria-controls／aria-expanded 對應實際內容，文字使用同一事件分析統計：股市訊號偏多／偏空、局勢走向升級／緩和、議題分布事件數；只在缺分析時附「已分析 X／N」。摘要維持單行，過長省略；title 保留完整摘要、樣本與新進展／搜尋範圍提示。▸／▾ 為裝飾提示；展開照舊顯示完整面板。unmount 斷開 observer 與監聽，舊回呼無效。
- **R24-2 四鈕**：≤480px 的訊號按鈕為 2×2 grid，名稱不斷詞；事件計數與點選規則不變。
- **R24-3 話題入口**：窄版保留完整「看話題・N 家」，與寬版相同，無障礙名稱與原本描述不變；不再只有家數。
- **R24-4 工具列**：≤480px 兩個下拉並排第一行，四個主要操作（重新整理、追蹤關鍵字、只看追蹤、搜尋）在第二行。文字不縮寫；極窄或追蹤鈕顯示時可橫捲操作行，不折第三行。狀態／新增／標記／快捷鍵群組、速覽與展開的搜尋／設定區另列，避免與主操作搶寬。寬版不限制兩行。
- **驗收**：以假 ResizeObserver 驗 480／481 邊界、不受視窗寬度影響、預設收合、原生按鈕操作與 ARIA、跨類別與補送保留、重新 mount 重設、resize 焦點、unmount；CSS 驗 2×2／不斷詞／兩行主控制。happy-dom 不量真實首屏高度；380px 選財經首屏至少一則標題由 cc 真殼驗收。
- **結果**：`npm test` 484/484（含固定漫步）；最終摘要單行樣式與 title 調整後，R24 三條定向測試亦通過。`git diff --check` 通過；jev 0，未 commit。


### 20.25 第 25 輪：工具列順序與話題來源分布（jev 0）

- **R25-1 視覺與 Tab 同序**：修正 §20.24 的包裝回歸。寬版初始 DOM 及容器 >480px 時依序為重新整理、來源、類別、追蹤關鍵字、只看追蹤（有設定才顯示）、搜尋。≤480px 時以既有 ResizeObserver 搬動原節點：來源／類別第一行，四個主操作第二行；移除 CSS order，原生 Tab 順序與視覺一致。只在跨門檻時搬動，保留節點、選值、監聽及焦點；不重新建立控制項。
- **R25-2 家數尾句**：話題來源分布最多列五家，超過時尾句改「，另 N 家（共 M 家）」，N 為尚未列出的媒體家數、M 為全部家數，均以 outlet 去重，與話題入口家數同義。title 列所有媒體及各自報導數，最後標總家數；退出話題時清空 title，避免殘留。前五排序及報導數不變。
- **驗收**：寬／窄 DOM 控制項順序、480／481px 邊界、原生 tabIndex、跨尺寸焦點保留、無 CSS order；十家媒體含中央社兩 feed 的分布尾句、完整 title 與退出清除。既有分布排序與補送測試同步新文案。
- **結果**：`npm test` 486/486（含固定漫步），R25 兩條定向測試通過；`git diff --check` 通過。jev 0，未 commit。


### 20.26 第 26 輪：話題時間順讀與媒體閱讀（jev 0）

- **R26-1 排序**：話題篩選列旁提供原生按鈕，顯示目前「最新優先／時間順讀」，aria-pressed=true 代表時間順讀；title 提示下一個排序與「依發布時間，非事件發生時間」。預設保留原最新優先，順讀按符合閱讀條件事件的最早報導時間升序，相同時間保留原順序、無日期排尾。日期改變加分隔（本地 M/D、今天，無日期為日期不明）。j/k 自動跟隨畫面 DOM 順序。跨同／新 at 補送保留；離開、清除全部或換另一話題重設，不寫 localStorage。順讀用日期分隔取代「以下為上次離開前」分隔線，避免舊到新排序時文字誤導；新增計數及既有新徽章規則保留。
- **R26-2 媒體**：分布前五家名稱與報導數為 button，aria-pressed 表示目前 outlet；點按合併中央社等多個 feed，來源選單顯全部來源，旁列「話題內・中央社」與清除。再按同一家或清除取消 outlet，仍保留其他條件；返回照舊還原原檢視。切換來源下拉沿用退出話題行為並清除 outlet。話題內類別、題材／數字、搜尋、追蹤、新進展皆取交集，先篩個別報導再分群；補送保留，媒體暫無報導時仍能清除。
- **計數契約**：分布數字改為各 outlet 在其他現行條件下點入後會看到的報導數（含摺疊子報導），不受當前 outlet 限制；與事件數區別。搜尋／追蹤以事件命中時，列出該 outlet 符合事件內的全部報導。0 可點，清除永遠可達。按當前數字排序、同數以 feed 順序決定；完整 title 與總家數仍涵蓋整個話題的 outlet。此條取代 §20.25／§19 舊「分布報導數不受其他篩選」語意。
- **驗收**：定向測試驗多日分隔、事件最早報導、j/k、同／新 at、搜尋／新進展／題材／數字交集、三 feed 一家、計數＝報導數、再次取消、返回、unmount。漫步加入排序、outlet、清除動作與覆蓋斷言；增加時間單調、aria-pressed、點前數字＝點後主列＋子報導數的不變式。窄版工具列可換行，媒體名稱沿用斷行保護。
- **結果**：`npm test` 489/489（含固定 200×100 步漫步與三個新增動作覆蓋），R26 三條定向測試通過；`git diff --check` 通過。jev 0，未 commit。


### 20.27 第 27 輪：順讀語意與窄版遲滯（jev 0）

- **R27-1 固定名稱**：話題排序按鈕固定「時間順讀」，aria-pressed=true 表示順讀中，false 表示最新優先；title 說明切換目標及「依發布時間，非事件發生時間」。取代 §20.26 的狀態式可見文字。
- **R27-2 單一尺寸狀態**：以模組根 ResizeObserver 為唯一來源，≤480px 進窄版、≥500px 才退出；20px 緩衝大於重現的 16px 捲軸差。根 nw-narrow 同時控制面板、DOM 工具列排列與全部窄版 CSS，移除 @container；舊 420px 規則併入窄版狀態。排行雙欄另外以 nw-wide-ranking 維持 ≥560px 進、≤540px 退，同樣有 20px 緩衝。寬窄狀態只在跨門檻時改變，保留 R25 的 DOM 與 Tab 同序。
- **焦點**：尺寸回呼不把焦點搬到摘要或清單。縮窄時焦點若在面板內容，保持展開並記住此狀態；轉寬時焦點若在摘要鈕，先保留按鈕，等自然失焦才隱藏。工具列搬動原節點時沿用同一控制項焦點保護，不另選焦點目標。unmount 移除 blur 監聽及 observer。
- **R27-3 搜尋範圍提示**：收合摘要 title 的「未套用搜尋」由獨立更新函式維護，搜尋 input 的 searchOnly 路徑也立即更新，清空／Esc 同步移除；仍不因搜尋重算面板分析。
- **瀏覽器重現**：使用提供的 repro_ro.html 與真 Chrome headless。此環境採 overlay scrollbar，原始頁面未產生 16px 寬差；另在同頁以實際 overflow 狀態切換 16px 內距，重現 classic scrollbar 的寬度回饋（容器高 600px、120 幀）。舊快照在 490／474px 間切換 **119 次**；新程式 **0 次**，focusin 只有測試起始聚焦的 1 次。腳本 `/tmp/news-r27-feedback.py`，結果 `/tmp/news-r27-feedback.log`；原生捲軸仍交 cc 真殼複驗。
- **驗收**：固定文字與 aria-pressed、480／500 邊界、120 次 16px 波動、CSS／DOM 同狀態、焦點保持與失焦清理、排行遲滯、搜尋 input／清空／Esc 的 title；更新被取代的舊斷點與焦點移動斷言，保留其他行為測試。
- **結果**：`npm test` 492/492（含固定漫步），`git diff --check` 通過。jev 0，未 commit。


### 20.28 第 28 輪：補送閱讀位置與首次階段（jev 0）

- **R28-1 錨定**：renderList 變更 DOM 前，從殼提供的最近可捲動祖先（與返回原檢視共用 scrollHost；無則 document.scrollingElement）取得可視範圍，按畫面順序記錄可見主列／子報導連結及 top。補送後依 HTTP(S) href 報導身分找回，scrollTop 加上新舊 top 差，誤差目標≤4px；第一則不在時找原可視區下一則，皆不在則保留自然位置。報導成為摺疊子報導時展開原群，維持同一篇可見。
- **範圍與互動**：同 at／新 at 都適用，僅 list 接收與首次階段計時提示造成的重畫。主動切篩選、點話題、搜尋不做；話題消失的自動返回優先用既有返回邏輯。模組內 keydown 視為鍵盤閱讀，跳過位置補償；pointerdown／wheel 恢復滑鼠模式，保留既有鍵盤焦點規則。模組根 CSS 加 overflow-anchor:none，防止原生與手動雙重修正，不修改殼容器；到底部受合法 scrollTop 上限限制時以瀏覽器可達位置為準。
- **R28-2 首次階段**：等待新聞更新→第一份 working list「新聞已可閱讀・整理分類與話題中」→完成時消失。由第一份 working 起 30 秒仍 working 加「可按重新整理」，單次 timer 到時即更新，補送不重設時限；不估秒數。首次非 working 結束此提示階段，paused／off 使用既有降級原因，後續輪回原短字「整理中」。計時與新增互動監聽在 unmount 清理。
- **驗證**：Playwright 腳本在 scratchpad/r28_reading.py，讀取預覽 real.html 與 body-real.json，對照修改前快照與現行前半。外層 #c 模擬高 600px 殼捲動容器、捲至 1500，注入焦點／速覽由無到有與分析補齊；為量測程式本身保護能力，兩版皆在殼型容器停用原生 anchoring。原生啟用的初次樣本兩版皆 0px；停用原生後，同 at／新 at **133→0px**，移除首列時下一可見列 **58→0px**。結果 `/tmp/news-r28-browser2.log`。repo 邏輯測試涵蓋同／新 at、列消失、成為子報導、主動操作／鍵盤不修正、wheel 恢復、假 clock 30 秒與終止清理。
- **結果**：`npm test` 496/496（含固定漫步），`git diff --check` 通過。jev 0，未 commit。


### 20.29 第 29 輪：話題整體與目前顯示（jev 0）

- **完整範圍**：話題篩選標頭附「整個話題：32 個事件・46 則・10 家」格式，完整成員經 groupItems 算事件數、逐則算報導數、outlet 去重算媒體家數。完整話題是目前收錄快照，不是跨輪累積。退出話題時清除，話題內數字篩選也保留。
- **縮小範圍**：實際列出的主列＋摺疊子報導數少於完整成員時，加一行「目前顯示：N 個事件・M 則」，N 等於清單主列數，M 為主列與摺疊子報導總數，與媒體按鈕的報導單位一致；無縮小時隱藏。類別、媒體、題材／數字、搜尋、追蹤、新進展與交集皆適用；同事件少了部分報導但事件數未變也顯示。來源下拉手動變更仍沿用退出話題規則，不另改返回行為。補送與搜尋 searchOnly 都重算。
- **基調與版面**：共用基調計數列 title 加「整個話題：按報導計，不隨清單篩選變動」，焦點首頁與話題內沿用同一元件；不複製另一組基調條。總數是篩選標頭的 12px 文字，可隨窄版換行；只有縮小時多一個「目前顯示」文字行，不為基調範圍再增加可見行。
- **驗收**：完整總數固定、篩選後事件數＝主列數、報導減少但事件不變、無效命中零事件、補送、新進展＋數字＋媒體與類別＋題材＋搜尋交集；基調全文與 title 保持整個話題。
- **結果**：`npm test` 500/500（含固定漫步），R29 四條定向測試通過；`git diff --check` 通過。jev 0，未 commit。


### 20.30 第 30 輪：頂端補送不捲動（jev 0）

- **守衛**：captureReading 取得實際捲動容器後，scrollTop≤4px 直接不建立錨點；同 at／新 at、頁面根捲動與殼祖先皆適用。4px 容許次像素與微小捲動誤差；scrollTop>4px 視為讀者已捲離頂端，沿用補償，不再要求報導上緣先超出可視區，避免中段首則完整可見報導失去保護。
- **呈現**：頂端新報導插入時維持原 scrollTop，工具列不被推到畫面外；overflow-anchor:none 保留以防中段雙重修正。此條補充 §20.28 的准入條件，不改主動操作／鍵盤例外與下一可見列回退。
- **驗收**：邏輯測試強制頂端有可見錨點，驗 0／1／4px 不補償、4.1／5px 仍補償，同／新 at 插入八則皆涵蓋；另跑 t1b.py 的頁面／殼情境與 r28_reading.py 中段對照。
- **結果**：`npm test` 501/501。真 Chromium 重跑 t1b.py，頁面／殼插八則的 scrollTop 均由舊版 0→600 改為 0→0，工具列 top 由 -580 改為 20px；r28_reading.py 的中段同 at／新 at／首列消失皆保持 0px 位移。`git diff --check` 通過；jev 0，未 commit。


### 20.32 第 32 輪：各家基調對照（jev 0）

- **對照表**：話題來源分布改為「各家報導語氣（則）」，每列一個 outlet，合併同媒體各 feed。媒體名與報導數為同一按鈕，沿用點選／再點取消的媒體篩選。依報導數由多至少、同數依來源順序，預設前五家，其餘以「另 N 家（共 M 家）」展開，aria-expanded 與 aria-controls 對應；展開後可收合。同話題補送與篩選保留展開，退出／換話題重設，不持久化。
- **統計範圍**：沿用 §20.26，各家數字套用類別、題材／數字、搜尋、追蹤、新進展，但不受所選 outlet 限制。因此各家則數等於點後報導數，並非摺疊事件數。有效 item.tone 按負面／中性／正反並陳／正面計數，缺失或非法值另列「待判定 N」，不進比例分母；沒有已判定報導時保留空比例條欄位。短數字為負／中／兩面／正，零不顯示，title 保留完整名稱及報導單位。各短數字合計等於該媒體已判定報導數；對照不另設五則門檻，焦點整體基調既有五則門檻不變。
- **呈現一致**：焦點、話題基調及對照表的色段、計數、圖例統一固定負面→中性→正反並陳→正面（取代先前色段順序與按數量排序的文字）；沿用既有深墨／灰／琥珀／accent token，數字前同色小方塊 aria-hidden。基調核對區仍按整個話題，不隨清單篩選；對照表按上一條可列出報導範圍。
- **篩選 chip**：以緊貼表格的「只看：媒體名 ✕」取代「話題內・媒體名」及清除，✕ 是原生按鈕，aria-label／title 為「清除媒體篩選」；排序按鈕不放進 chip。前五家後的純尾句由展開按鈕取代（§20.25／§20.26 的呈現已由本節取代）。
- **窄版與驗收**：媒體與比例條可縮，短數字下一列自然換行，長媒體名可斷行。測試涵蓋同媒體多 feed、同事件多報導、七家展開／收合、每家點後則數守恆、已判定比例與待判定、非法 tone、補送保留、固定順序／配色／裝飾語意、chip 與排序分離及 unmount 清理。
- **結果**：`npm test` 506/506（含固定漫步），Chromium 真實預覽資料在 380px／1000px 展開全部十家，對照表及各列 scrollWidth 均不超過 clientWidth；`git diff --check` 通過。jev 0，未 commit。


### 20.33 第 33 輪：話題閱讀層次、排序與基調語意（jev 0）

- **R33-1**：進話題後焦點卡預設收成「焦點：N 個話題 ▸」按鈕，aria-expanded／aria-controls 對應完整卡片區。選此方案以節省首屏高度，同時保留切換其他話題與核對整體基調的入口；不限窄版。同話題補送保留展開，換話題重新收合，離開話題恢復首頁完整卡片；不持久化。
- **R33-2**：排序改 role=group、名稱「報導排序」，兩顆固定文字「最新更新」「時間順序」，各自 aria-pressed、重按已選項不切回。預設最新更新，沿用既有新到舊事件順序，方便回來看新進展；時間順序按事件最早報導由舊到新，小字「由舊到新，依發布時間」，日期分隔一律實際 M/D，不再用今天。發布時間仍不等於事件發生時間，交集、鍵盤順序、離開重設規則不變；取代 §20.26／§20.27 舊切換文案。
- **R33-3**：「報導語氣（則）」與「各家報導語氣（則）」title 說明：依標題與摘要判斷報導的語氣，正面＝強調成果、進展、合作或利多；負面＝強調分歧、受挫、風險、抗議或批評；中性＝主要陳述事實、行程或背景；正反並陳；非媒體立場。依 back/topics.py TONE_CRITERIA，不改模型題目。話題清單同事件符合條件報導有多種有效 tone 時，小標顯「負 N・中 N・兩面 N・正 N」（零不列），不只取代表；非法／未判定不混入，子報導仍個別標示。
- **驗收**：焦點收合／展開／補送／退出、分段按鈕互斥及固定文字、日期與提示、criteria 說明、同事件多報導組成；漫步加入焦點開關及兩種排序。


### 20.34 第 34 輪：報導語氣名稱、短標與小樣本（jev 0）

- **R34-1**：標題改「各家報導語氣（則）」，其下常見 nw-hint：「依每則標題與摘要判讀對此事件的語氣（AI 判定），不代表媒體整體立場」。焦點卡改「報導語氣（則）」；核對區同步用報導語氣，既有 title 的 criteria 解釋與非媒體立場說明保留。僅前半名稱變更，模型題目、id、資料與計數不變。
- **R34-2**：mixed 完整顯示名統一「正反並陳」，短標統一「兩面 N」，含各家對照、合併事件組成、清單、子報導與核對區，aria／title 同步；負／中／正不變。取代 §20.23／§20.32／§20.33 的舊顯示詞。
- **R34-3**：每家有效 tone 合計不足五則時，比例條 opacity=.45，數字後加「樣本少」；group accessible name 包含此提示，媒體按鈕以 aria-describedby 連到可見提示。未判定不計門檻與分母，零已判定仍保留空條欄位並提示樣本少／待判定，避免 grid 自動排版讓數字移進比例條欄。比例條維持原等長容器，只改透明度，不以樣本總數縮短。補送跨過五則即移除提示與淡化。
- **驗收**：四／五則門檻、待判定排除、補送、等長比例與透明度 CSS、可見說明及無障礙關聯；既有名稱斷言同步，不更動守恆規則。

- **R34 附帶修正**：全待判定時保留空比例條及原網格位置，寬窄版待判定都留在數字欄。對照標題 title 加「各家則數只算該家符合目前篩選的報導，清單會保留整個事件，所以加總可能與目前顯示不同」。


### 20.36 第 36 輪：非種子報導逐則取得話題資格

- **成員**：種子事件的所有報導仍直接納入。其他候選僅在 cache[(seed,key)] 為 true 時納入該 key，不再帶入整個 event；false 不會被同事件 true 覆蓋。話題 sources／count／keys 與語氣統計皆只計實際成員，不改前半事件分組或事件 id。
- **同事件待問**：已有成員所屬 event 的其他報導，不要求再次共用特徵詞，逐則查快取／加入待問；仍遵守種子最新時間 ±48h、已被先前話題收走的 event 排除、每 plan 每種子 MAX_PENDING=60、快取與每輪預算。兄弟篇優先一般詞候選，原因是先完成已出現事件的報導資格，避免各家語氣混入未確認成員；同層維持共用詞數、時間、key 排序。滿額未問留後續 plan，不額外開 worker 或延長預算。
- **穩定與門檻**：previous 精確 seed 身分照舊、名額不保證；擴展後仍須至少三個 outlet，不足則不輸出話題與其 pending，讓既有話題消失／返回流程處理。種子事件是刻意保留的直接納入例外，因此本改動不保證消除所有誤入。
- **測試**：三則同事件只有一則 true 時僅一則納入、無共同詞兄弟篇仍待問、false 排除、各自 true 後加入及家數改變、兄弟篇優先與 60 上限／後續 plan、sticky 與三家門檻。既有整事件擴展斷言改為逐篇，同時保留快取、排序、輸入不變與 seed identity 檢查。

- **驗證結果**：全套 unittest 366/366；chaos 六並行×五批 30/30。擴充來源副本只覆蓋 back/*.py、feeds.json 雜湊不變；真實 model round=1 requests=53 http=53 retries=0 failed=0，elapsed=7.3s，model done、classify／analysis／events／topics／tone pending 全0。
- **人工品質核對**：r36.json 峰會39則／11家，另三話題各3則／3家；R35準則逐則看48則未發現明確誤入或待核對。舊run2峰會43則／10家有1不相關、2待核對；本次ETtoday伊朗解封報導仍在300則內、與中央社川習談中東同event，但已不帶topic，中央社仍納入。新資料有增減、模型亦有隨機性，不能將全部數量下降視為本改動的因果效果；逐則核對表放scratchpad/feedexp/r36-review.json。

### 20.38 第 38 輪：長時間資源平台期（jev 0）

- **測試方法**：同一 Scheduler 長時間存活，三來源、48 則／輪、120 組 link 循環，每五輪回用上一組，定期移除話題種子；使用真實 RSS 解析、分類／分析／配對／話題／語氣 client 的請求組裝與回應驗證，只將 opener 替換為記憶體假回應。禁止 socket.connect，沒有真 API。假回應交替成功、429／529 重試、壞 answers、TimeoutError 及在有效回應完整讀取後注入 model clock 超過 60 秒預算（獨立於逾時，另斷言 paused/budget）；初期以 Event 閘門保證 refresh 發生於模型請求途中，不靠 sleep 撞時序。
- **短版**：tests/test_model_endurance.py 200 輪；每輪等已完成抓取、非 active／pending_refresh、最後列表非 working、model_rounds／results／所有佇列與 in-flight 歸零。檢查 first_seen 每來源≤1000、分類／分析／語氣≤4000、配對／話題≤20000、佇列既有容量、候選 keys≤300選2、快取列表≤300、seed≤5；確認同一組四 fetch＋三 model＋一 coordinator 執行緒未增生，stop 後全部退出。model_rounds≤3 是本測試至多一次額外 refresh 的工作量界限，不宣稱任意外部更新壓力下通用上限。
- **長版**：scratchpad/r38/endurance.py 用相同 harness 執行 3000 輪操作，另外包括啟動及重疊 refresh；每250輪記錄上述容器及 tracemalloc 當前／生命週期峰值、active_count。harness 只保留最後封包與固定種類 Counter，不累積封包／完整 log；採樣前 GC，取樣記錄僅十餘筆。高水位為觀測值，不宣稱捕捉每個執行緒瞬間。
- **解讀**：穩定期記憶體允許小幅波動與 CPython 容器重配置；不以 RSS 絕對值作跨機器測試。此工作量驗證反覆輪轉與收尾，不是滿300則或每個模型快取都達上限的性能保證；既有 FIFO 單元測試仍負責容量邊界。
- **結果**：短版200輪 4.39s；全套367測試通過。最終長版3000次操作、3009個已完成抓取輪，191.95s；2500～3000輪 tracemalloc current 4.713～4.726 MiB、尾端較起點+3.4 KiB，峰值5.910 MiB。分類／分析各4000、配對1728、話題480、語氣768，末500輪大小不變；三份來源cache各16則、first_seen各1000。候選快取一份48則列表／15 keys、last_topic_seeds最多1。
- **收尾與故障覆蓋**：每輪閒置時五in-flight、所有佇列、results、model_rounds全0；執行中觀測model_rounds高水位2、results6，模型workers3、總owned threads8（含主執行緒active_count=9）不變，stop全部join退出。假HTTP注入429／529各78次、壞回應402次、逾時452次、預算294次，確實觀察到paused/failed與paused/budget。未發現production洩漏，未修改back程式。完整採樣與可重跑腳本放scratchpad/r38/（final目錄為最終版本，早期資料僅供調試）。
