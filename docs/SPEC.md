# modudock-news 規格

- 狀態：定稿（Codex 五輪，22 條已納入，第五輪判可開工）
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
