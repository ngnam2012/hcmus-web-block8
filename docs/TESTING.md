# Kịch bản kiểm thử, bảng ánh xạ và hướng dẫn chạy thủ công — Block 9

## 1. Bảng ánh xạ Contract API & Schema (khớp 100% đề bài)

| Thành phần trong đề | Tên trong repo này | Ghi chú |
| --- | --- | --- |
| `POST /jobs/:job_id/complete` | `POST http://127.0.0.1:4000/jobs/:job_id/complete` | Trả `200` sau commit; idempotent khi job đã `DONE` |
| `GET /events/:event_id` | `GET http://127.0.0.1:4000/events/:event_id` | Trả outbox + `attempts` + `replays` |
| `POST /events/:event_id/replay` | `POST http://127.0.0.1:4000/events/:event_id/replay` | Chỉ nhận `DEAD`, trạng thái khác trả `409` |
| `POST /webhooks/summaries` | `POST http://127.0.0.1:4100/webhooks/summaries` | Raw body HMAC → schema → inbox commit → `202`/`409`/`401`/`400` |
| `GET /inbox/:event_id` | `GET http://127.0.0.1:4100/inbox/:event_id` | Trả `RECEIVED`/`PROCESSED` kèm `received_at`, `processed_at` |
| `GET /videos/:video_id/summary` | `GET http://127.0.0.1:4100/videos/:video_id/summary` | Trả `version`, `summary`, `applied_count`; chưa có trả `404` |
| DB sender (`jobs`, `outbox`, `delivery_attempts`) | `sender_db` (`jobs`, `outbox`, `delivery_attempts`, `replay_events`) | Thêm `replay_events` để ghi nhận thao tác replay |
| DB receiver (`inbox`, `video_summaries`) | `receiver_db` (`inbox`, `video_summaries`) | `PRIMARY KEY (source, event_id)` trên `inbox` |

## 2. Ma trận kiểm thử H0 và F1–F10

| Ca | Loại | Marker / Fault | Tiêu chí đạt | Snapshot chứng cứ |
| --- | --- | --- | --- | --- |
| **H0** | Tự động | Không fault | J42 `DONE`, 1 outbox `DELIVERED`, A1 `ACKNOWLEDGED` (202), 1 inbox `PROCESSED`, V7 v1, `applied_count=1` | `H0.json` |
| **F1** | **Kill thật** | Sender `after_job_update_before_outbox` | Sau SIGKILL: J42 vẫn `READY`, 0 outbox. Restart & gọi lại → đạt H0 | `F1-after-kill.json`, `F1.json` |
| **F2** | **Kill thật** | Relay tắt; Sender `after_sender_commit_before_response` | Sau SIGKILL: DB đã `DONE` + E42 `PENDING`. Gọi lại trả cùng `E42`, không tạo event mới. Bật relay → đạt H0 | `F2-after-kill.json`, `F2.json` |
| **F3** | **Kill thật** | Relay `after_http_2xx_before_delivery_commit` | Sau SIGKILL: receiver đã có inbox E42, sender còn `PENDING` & A1 `STARTED`. Restart: A1 → `UNKNOWN`, gửi A2 cùng E42 → `202`, 1 inbox, `applied_count=1` | `F3-after-kill.json`, `F3.json` |
| **F4** | Tự động | Receiver `after_inbox_commit_before_response` (1 lần) | A1 `RETRYABLE`, inbox đã có E42; retry A2 → `202`/`DELIVERED`; 1 inbox; sau worker `applied_count=1` | `F4-after-attempt-1.json`, `F4.json` |
| **F5** | Tự động | Sửa payload, sai chữ ký, ts cũ >300s, ts tương lai >300s, sai schema | 4 ca xác thực → `401`, ca sai schema → `400`; inbox rỗng, summary `404` | `F5.json` |
| **F6** | Tự động | 5 bản sao đồng thời + 1 bản cùng ID khác body | 5 bản sao đều `202`, 1 inbox, `applied_count=1`; cùng ID khác body → `409`, không ghi đè | `F6.json` |
| **F7** | **Kill thật** | Worker `after_projection_write_before_commit` | Sau SIGKILL: inbox vẫn `RECEIVED`, summary `404`. Restart worker → `PROCESSED`, `applied_count=1` | `F7-after-kill.json`, `F7.json` |
| **F8** | Tự động | Receiver `503` trước lưu inbox 4 lần, rồi gỡ fault & replay | 4 attempt `RETRYABLE` (chờ 1/3/9s) → `DEAD`, inbox rỗng. Replay giữ `event_id` & `raw_body`, mở vòng 2 → `DELIVERED`/`PROCESSED`, `applied_count=1`; replay khi `DELIVERED` → `409` | `F8-before-replay.json`, `F8.json` |
| **F9** | Tự động | Hoàn tất J43 (v2) trước, rồi J42 (v1) sau | Cả 2 inbox `PROCESSED`; V7 vẫn `version=2`, `applied_count=1` | `F9.json` |
| **F10** | Tự động | Tắt receiver worker, hoàn tất J42, rồi bật lại | Khi tắt: sender `DELIVERED`, inbox `RECEIVED`, summary `404`. Khi bật: `PROCESSED`, summary `200` (`applied_count=1`) | `F10-worker-stopped.json`, `F10.json` |

## 3. Chạy tự động toàn bộ harness

```powershell
# Khởi động PostgreSQL (2 DB logic: sender_db & receiver_db)
docker compose up -d postgres --wait

# Unit tests (HMAC, timestamp ±300s, schema, HTTP classifier, Retry-After, backoff)
npm.cmd test

# Chạy toàn bộ H0 và F1–F10 (kèm real SIGKILL cho F1, F2, F3, F7)
npm.cmd run verify

# Hoặc chạy từng nhóm / từng ca lẻ
npm.cmd run verify:automated
npm.cmd run verify:kills
node --env-file=.env scripts/harness.js F3

# Cập nhật docs/REPORT.md từ dữ liệu evidence/*.json
npm.cmd run report
```

## 4. Chạy & dừng / kill từng tiến trình thủ công

### Cách A: Qua `scripts/process-ctl.js` (4 tiến trình Node độc lập trên loopback)

```powershell
npm.cmd run seed
npm.cmd run proc -- start all
npm.cmd run proc -- status

# Ví dụ dừng riêng worker (F10)
npm.cmd run proc -- stop receiver-worker
Invoke-RestMethod http://127.0.0.1:4000/jobs/J42/complete -Method Post
Invoke-RestMethod http://127.0.0.1:4000/events/E42
Invoke-RestMethod http://127.0.0.1:4100/inbox/E42
# GET /videos/V7/summary lúc này trả 404; bật lại worker:
npm.cmd run proc -- start receiver-worker
Invoke-RestMethod http://127.0.0.1:4100/videos/V7/summary

# Ví dụ kill thật tại marker (F3)
npm.cmd run proc -- stop relay
npm.cmd run seed
npm.cmd run proc -- start relay --marker=after_http_2xx_before_delivery_commit
Invoke-RestMethod http://127.0.0.1:4000/jobs/J42/complete -Method Post
npm.cmd run proc -- logs relay        # thấy dòng MARKER after_http_2xx_before_delivery_commit
npm.cmd run proc -- kill relay        # SIGKILL thật
npm.cmd run snapshot -- manual-F3-after-kill
npm.cmd run proc -- start relay       # restart không marker -> A1 UNKNOWN, A2 202
npm.cmd run snapshot -- manual-F3-final

# Dừng toàn bộ
npm.cmd run proc -- stop all
```

### Cách B: Qua Docker Compose (4 container độc lập + Postgres)

```powershell
docker compose up -d --build --wait
docker compose stop receiver-worker
docker compose kill -s SIGKILL relay
docker compose up -d relay receiver-worker
```

## 5. Truy vấn trực tiếp hai DB bằng `psql`

```powershell
# DB sender
docker compose exec -T postgres psql -U lab -d sender_db -c "SELECT job_id, video_id, version, status FROM jobs ORDER BY job_id;"
docker compose exec -T postgres psql -U lab -d sender_db -c "SELECT event_id, job_id, status, replay_round, next_attempt_at FROM outbox;"
docker compose exec -T postgres psql -U lab -d sender_db -c "SELECT attempt_id, event_id, round, attempt_in_round, http_status, outcome, started_at, finished_at FROM delivery_attempts ORDER BY attempt_seq;"

# DB receiver
docker compose exec -T postgres psql -U lab -d receiver_db -c "SELECT source, event_id, status, received_at, processed_at FROM inbox;"
docker compose exec -T postgres psql -U lab -d receiver_db -c "SELECT video_id, version, applied_count, source_event_id, updated_at FROM video_summaries;"
```
