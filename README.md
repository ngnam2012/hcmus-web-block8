# Block 9 — Giao sự kiện tin cậy với Outbox, Inbox và Webhook

Bài thực hành **Block 9**: giao sự kiện `summary.completed` từ dịch vụ tóm tắt (**sender**) sang dịch vụ danh sách video (**receiver**) qua HTTP webhook tin cậy, sử dụng **Transactional Outbox**, **Single Relay**, **HMAC-SHA256 trên raw body**, **Durable Inbox** và **Receiver Worker**.

Đề bài gốc: <https://pub.nndkhoa9.win/webadv/w8/block-09-reliable-events-interactive.html#1>

## Kiến trúc ngắn gọn

- **4 tiến trình dừng/kill được riêng:** `sender-api` (port 4000), `relay` (health 4002), `receiver-api` (port 4100), `receiver-worker` (health 4102).
- **2 DB logic độc lập** trên cùng PostgreSQL 17: `sender_db` (`jobs`, `outbox`, `delivery_attempts`, `replay_events`) và `receiver_db` (`inbox`, `video_summaries`). Không có transaction xuyên hai DB.
- **Fixture cố định:** `J42` (`V7`, version 1) và `J43` (`V7`, version 2); không gọi LLM.
- **Tối giản đúng phạm vi lab:** một endpoint cố định trên loopback, một relay, không theo redirect, không dùng broker / CDC; Demo Console web (`src/lab-ui.js`) là giao diện phụ trợ tùy chọn cho harness/process-controller, chạy hoàn toàn tách biệt với 4 tiến trình nghiệp vụ.

## Chạy nhanh (Windows / PowerShell)

Yêu cầu: Docker Desktop (Linux containers) cho PostgreSQL 17, Node.js >= 22.

```powershell
# 1. Tạo .env từ .env.example và đặt WEBHOOK_SECRET cục bộ (không commit .env)
Copy-Item .env.example .env

# 2. Cài dependencies (chỉ express và pg)
npm.cmd ci

# 3. Khởi động PostgreSQL, chạy migration & nạp fixture J42/J43
docker compose up -d postgres --wait
npm.cmd run seed

# 4. Chạy unit tests
npm.cmd test

# 5. Chạy toàn bộ harness H0 và F1–F10 (có kill thật SIGKILL cho F1, F2, F3, F7)
npm.cmd run verify

# 6. Tạo lại báo cáo từ dữ liệu đo thật
npm.cmd run report
```

## Contract API

| Dịch vụ | Route | Hành vi |
| --- | --- | --- |
| Sender | `POST /jobs/:job_id/complete` | 1 transaction: khóa job, `READY` → `DONE`, `INSERT outbox` với `raw_body` bất biến. Trả `200` sau commit; gọi lại trả cùng `event_id`. |
| Sender | `GET /events/:event_id` | Trạng thái outbox, lịch sử `delivery_attempts` và `replay_events`. |
| Sender | `POST /events/:event_id/replay` | Chỉ nhận `DEAD` (khác trả `409`); giữ `event_id` & `raw_body`, mở vòng mới tối đa 4 lần, ghi `replay_events`. |
| Receiver | `POST /webhooks/summaries` | Kiểm timestamp `±300s` & HMAC constant-time trên raw body (`401`), parse & schema (`400`), `INSERT inbox UNIQUE(source, event_id)` + commit → `202` (bản sao cùng payload: `202`; cùng ID khác payload: `409`). |
| Receiver | `GET /inbox/:event_id` | Trạng thái `RECEIVED` / `PROCESSED`, thời điểm nhận và xử lý. |
| Receiver | `GET /videos/:video_id/summary` | Version hiện tại, nội dung, `applied_count`; chưa có trả `404`. |

## Chạy / dừng từng tiến trình riêng

Qua script Node cục bộ (`scripts/process-ctl.js`):

```powershell
npm.cmd run proc -- start all
npm.cmd run proc -- status
npm.cmd run proc -- stop receiver-worker
npm.cmd run proc -- start relay --marker=after_http_2xx_before_delivery_commit
npm.cmd run proc -- kill relay
npm.cmd run proc -- stop all
```

Hoặc qua Docker Compose (4 container độc lập + PostgreSQL):

```powershell
docker compose up -d --build --wait
docker compose stop receiver-worker
docker compose kill -s SIGKILL relay
docker compose up -d relay receiver-worker
docker compose down
```

## Giao diện Demo Console 100% trên web (không cần gõ lệnh khi trình bày)

Chỉ cần khởi động PostgreSQL và bật Demo Console 1 lần:

```powershell
docker compose up -d postgres --wait
npm.cmd run ui
```

Sau đó mở **<http://127.0.0.1:4200>** trên trình duyệt để demo **toàn bộ H0 và F1–F10 ngay trên web** (không cần PowerShell trong lúc demo):
- **Điều khiển thật 4 tiến trình** (`sender-api`, `relay`, `receiver-api`, `receiver-worker`): bấm **`▶ Start`** (chọn marker tùy ý), **`⏹ Stop`**, **`Kill -9` (`SIGKILL` thật)** và xem **`Logs`** trực tiếp trên từng thẻ.
- **Demo có hướng dẫn cho các ca Kill thật (`F1`, `F2`, `F3`, `F7`) & `F10`:** 1 bấm để dừng đúng tại marker → tự tay bấm **Kill -9** quan sát trạng thái 2 DB giữa crash → bấm **Restart & Phục hồi**.
- **Demo `H0`, `F4`, `F5`, `F6`, `F8` (`503 → DEAD → Replay`), `F9` (`v2` trước `v1` sau), `429 Retry-After`, `301` không redirect, `Timeout 2s`**.
- **Nút `Chạy tất cả 11 ca`** chạy luôn harness chính thức (`H0`, `F1–F10`), hiện bảng kết quả đo ngay trên web và cập nhật `evidence/verification.json` + `docs/REPORT.md`.

*(Lưu ý: `src/lab-ui.js` là giao diện cho harness/process-controller trên loopback; 4 tiến trình nghiệp vụ vẫn tách biệt độc lập với 2 DB `sender_db` và `receiver_db` đúng yêu cầu Block 9.)*

## Cấu trúc thư mục

```text
db/
  init/001-create-databases.sql   Tạo 2 DB độc lập: sender_db & receiver_db
  sender/001_schema.sql           Schema DB sender (jobs, outbox, delivery_attempts, replay_events)
  sender/002_fixtures.sql         Fixture J42 (V7 v1) & J43 (V7 v2)
  receiver/001_schema.sql         Schema DB receiver (inbox UNIQUE(source, event_id), video_summaries)
src/
  sender-api.js                   Process 1: Sender HTTP API (transaction outbox, replay)
  relay.js                        Process 2: Single Relay (STARTED->UNKNOWN recovery, retry 1/3/9s, 2s timeout, no redirect)
  receiver-api.js                 Process 3: Receiver HTTP API (raw body HMAC, inbox commit trước 202)
  receiver-worker.js              Process 4: Receiver Worker (FOR UPDATE SKIP LOCKED, UPSERT version > current, PROCESSED)
  crypto.js                       Ký và xác minh HMAC-SHA256 constant-time + cửa sổ 300s
  protocol.js                     Payload builder, schema validator, HTTP classifier, Retry-After & backoff
  db.js                           Pool độc lập cho sender_db & receiver_db + withTransaction
  marker.js                       Điểm dừng marker xác định cho real SIGKILL
  config.js                       Cấu hình loopback & policy lab
scripts/
  migrate.js                      Tạo DB, chạy migration, seed/reset fixture
  process-ctl.js                  Start / stop / kill (SIGKILL) / status / logs từng process
  harness.js                      Harness tự động H0 & F1–F10 (real SIGKILL + 2-DB snapshot)
  snapshot.js                     Chụp snapshot đồng thời cả sender_db và receiver_db
  report.js                       Sinh docs/REPORT.md từ bằng chứng đo thật trong evidence/
test/unit.test.js                 Unit tests cho crypto, schema, classifier, Retry-After, backoff
docs/                             ARCHITECTURE.md, TESTING.md, REPORT.md, REFERENCES.md
evidence/                         Snapshot JSON hai DB & verification.json (H0, F1–F10)
```

Xem chi tiết tại [ARCHITECTURE.md](docs/ARCHITECTURE.md), [TESTING.md](docs/TESTING.md), [REPORT.md](docs/REPORT.md) và [REFERENCES.md](docs/REFERENCES.md).
