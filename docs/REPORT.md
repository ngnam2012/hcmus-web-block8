# Báo cáo Thực hành Block 9 — Kết quả chạy thật

Thực hiện từ **22:44:47 19/11/2026** đến **22:45:22 19/11/2026** (giờ Việt Nam, UTC+7; JSON chứng cứ lưu UTC).
Môi trường: Node v22.19.0 (win32); PostgreSQL 17 (2 DB logic: `sender_db` & `receiver_db`). Không gọi LLM; dùng fixture cố định `J42` (`V7`, version 1) và `J43` (`V7`, version 2).

## 1. Tổng hợp kết quả

**PASS: 11/11 ca** (gồm H0 và F1–F10).
Các ca F1, F2, F3, F7 dừng process tại marker rồi gửi **SIGKILL thật** (`kill -9` / `TerminateProcess`), không thay bằng `throw` exception và không dùng `sleep` đoán thời điểm. Mỗi ca đều reset sạch cả hai DB trước khi chạy.

## 2. Bảng Expected / Observed (H0, F1–F10)

| Ca | Loại | Expected (theo đề Block 9) | Observed (thực đo) | Kết quả | Snapshot |
| --- | --- | --- | --- | --- | --- |
| **H0** | Tự động | J42 DONE, 1 outbox E42 DELIVERED, 1 attempt ACKNOWLEDGED (202), 1 inbox E42 PROCESSED, V7 version 1, applied_count = 1. | POST complete -> 200 (E42); outbox=DELIVERED, inbox=PROCESSED, V7 version=1, applied_count=1. | **PASS** (7038 ms) | `H0.json` |
| **F1** | Kill thật | Kill sender tại after_job_update_before_outbox => rollback: J42 vẫn READY, 0 outbox. Restart và gọi complete lại => đạt H0. | SIGKILL pid=14084 tại `after_job_update_before_outbox`; sau kill J42 vẫn READY, 0 outbox; gọi lại -> 200 E42, cuối cùng DELIVERED/PROCESSED, applied_count=1. | **PASS** (1521 ms) | `F1-after-kill.json`, `F1.json` |
| **F2** | Kill thật | Tắt relay, kill sender tại after_sender_commit_before_response => DB đã có J42 DONE & outbox E42 PENDING dù client không nhận response. Gọi complete lại trả cùng E42; bật relay => đạt H0. | SIGKILL pid=11332 tại `after_sender_commit_before_response`; sau kill DB đã DONE + E42 PENDING; gọi lại -> 200 cùng E42 (`already_completed=true`); bật relay -> DELIVERED/PROCESSED, applied_count=1. | **PASS** (1394 ms) | `F2-after-kill.json`, `F2.json` |
| **F3** | Kill thật | Kill relay tại after_http_2xx_before_delivery_commit => receiver đã có inbox E42, sender còn PENDING & A1 STARTED. Restart relay: A1 -> UNKNOWN, gửi A2 cùng E42 -> 202, 1 inbox, applied_count = 1. | SIGKILL pid=5432 tại `after_http_2xx_before_delivery_commit`; sau kill receiver đã có inbox E42, sender còn PENDING & A1 STARTED; restart -> A1=UNKNOWN, A2=ACKNOWLEDGED (202), 1 inbox, applied_count=1. | **PASS** (2475 ms) | `F3-after-kill.json`, `F3.json` |
| **F4** | Tự động | Marker after_inbox_commit_before_response (bật 1 lần) => sender ghi A1 RETRYABLE, inbox đã có E42; retry A2 thành 202/DELIVERED; 1 inbox; sau khi worker chạy, applied_count = 1. | Receiver đóng socket 1 lần sau commit inbox -> A1=RETRYABLE (UND_ERR_SOCKET), inbox đã có E42 RECEIVED; retry A2=ACKNOWLEDGED (202); worker chạy -> 1 inbox PROCESSED, applied_count=1. | **PASS** (2355 ms) | `F4-after-attempt-1.json`, `F4.json` |
| **F5** | Tự động | Payload bị sửa, chữ ký sai, timestamp quá cũ (>300s), timestamp quá xa tương lai (>300s) đều trả 401; sai schema trả 400; inbox rỗng, không đổi video_summaries. | tampered=401, wrong_sig=401, old_ts=401, future_ts=401, bad_schema=400; inbox=0, summary=404. | **PASS** (537 ms) | `F5.json` |
| **F6** | Tự động | 5 bản sao đồng thời cùng E42 cùng payload đều trả 202, chỉ 1 inbox, applied_count = 1. Cùng event_id nhưng khác body (chữ ký hợp lệ) => 409, dữ liệu cũ không đổi. | 5 bản sao đồng thời -> [202, 202, 202, 202, 202], 1 inbox PROCESSED, applied_count=1; cùng event_id khác body -> 409 (PAYLOAD_CONFLICT), dữ liệu cũ giữ nguyên. | **PASS** (646 ms) | `F6.json` |
| **F7** | Kill thật | Kill receiver worker tại after_projection_write_before_commit => rollback: inbox vẫn RECEIVED, video_summaries rỗng (404). Restart worker => PROCESSED, applied_count = 1. | SIGKILL pid=24572 tại `after_projection_write_before_commit`; sau kill inbox còn RECEIVED, summary=404; restart worker -> PROCESSED, version=1, applied_count=1. | **PASS** (1470 ms) | `F7-after-kill.json`, `F7.json` |
| **F8** | Tự động | 4 attempt 503 (chờ 1, 3, 9s) => E42 DEAD, inbox rỗng. Gỡ fault, replay giữ event_id & raw_body, mở vòng 2 => DELIVERED, PROCESSED, applied_count = 1; replay khi DELIVERED trả 409. | 4 lần 503 (gaps: 1050, 3026, 9052 ms) -> DEAD, inbox=0; replay -> vòng 2, raw_body giữ nguyên=true, A5=202 DELIVERED/PROCESSED, applied_count=1; replay khi DELIVERED -> 409. | **PASS** (14630 ms) | `F8-before-replay.json`, `F8.json` |
| **F9** | Tự động | Chờ worker xử lý từng event. Cả hai inbox PROCESSED; bản hiện tại vẫn version 2, applied_count = 1. | Sau E43 (v2): version=2, applied_count=1; sau E42 (v1): cả 2 inbox PROCESSED, bản hiện tại vẫn version=2 (E43), applied_count=1. | **PASS** (1309 ms) | `F9.json` |
| **F10** | Tự động | Khi worker tắt: sender DELIVERED, inbox RECEIVED, GET /videos/V7/summary trả 404. Bật worker: inbox PROCESSED, bản tóm tắt xuất hiện (version 1, applied_count = 1). | Worker tắt: sender=DELIVERED, inbox=RECEIVED, GET summary=404; bật worker -> PROCESSED, version=1, applied_count=1. | **PASS** (1174 ms) | `F10-worker-stopped.json`, `F10.json` |

## 3. Bản ghi Kill thật (F1, F2, F3, F7)

| Ca | Process bị kill | PID | Marker | Tín hiệu | Thời điểm (UTC) | Snapshot đối chứng |
| --- | --- | --- | --- | --- | --- | --- |
| **F1** | `sender-api` | `14084` | `after_job_update_before_outbox` | `kill -9 (SIGKILL)` | `2026-11-19T15:44:55.603Z` | `F1-after-kill.json` → `F1.json` |
| **F2** | `sender-api` | `11332` | `after_sender_commit_before_response` | `kill -9 (SIGKILL)` | `2026-11-19T15:44:56.958Z` | `F2-after-kill.json` → `F2.json` |
| **F3** | `relay` | `5432` | `after_http_2xx_before_delivery_commit` | `kill -9 (SIGKILL)` | `2026-11-19T15:44:58.683Z` | `F3-after-kill.json` → `F3.json` |
| **F7** | `receiver-worker` | `24572` | `after_projection_write_before_commit` | `kill -9 (SIGKILL)` | `2026-11-19T15:45:04.858Z` | `F7-after-kill.json` → `F7.json` |

Chi tiết trạng thái ngay sau SIGKILL (trích trực tiếp từ snapshot JSON):

- **F1 (`F1-after-kill.json`):** `jobs.J42 = READY`, `outbox.length = 0`, `inbox.length = 0` — PostgreSQL rollback nguyên tử khi connection bị đứt đột ngột trước COMMIT.
- **F2 (`F2-after-kill.json`):** `jobs.J42 = DONE`, `outbox[0] = E42 (PENDING)`, `delivery_attempts.length = 0` — thay đổi đã bền vững dù client không nhận response; gọi lại `complete` trả đúng `E42`.
- **F3 (`F3-after-kill.json` → `F3.json`):** sau kill, `outbox[0] = PENDING`, `delivery_attempts[0] = A1 (STARTED)` trong khi `receiver_db.inbox.length = 1`. Sau restart: `A1:UNKNOWN, A2:ACKNOWLEDGED`, `inbox.length = 1`, `applied_count = 1`.
- **F7 (`F7-after-kill.json`):** `sender.outbox[0] = DELIVERED`, `receiver.inbox[0] = RECEIVED`, `video_summaries.length = 0` (GET trả `404`) — cả UPSERT lẫn dấu `PROCESSED` đều rollback cùng nhau.

## 4. Đo khoảng chờ retry & replay (F8)

- Chính sách backoff của lab: **1000 / 3000 / 9000 ms** (tối đa 4 lần mỗi vòng).
- Sai số đo công bố: **[-50 ms, +1000 ms]** (do chu kỳ poll relay 50 ms và độ trễ lập lịch tiến trình).
- Khoảng chờ đo được qua `started_at[i] - finished_at[i-1]`: **1050 ms, 3026 ms, 9052 ms**.
- Trước replay (`F8-before-replay.json`): `outbox.status = DEAD`, `delivery_attempts = 4` (đều 503 `RETRYABLE`), `inbox.length = 0`.
- Sau replay (`F8.json`): giữ nguyên `event_id = E42` và byte-for-byte `raw_body`, mở `replay_round = 2`, ghi `replay_events` (1 dòng), gửi `A5` (vòng 2, lần 1) thành công `202`, giữ nguyên lịch sử `A1..A4`.

## 5. Giải thích cơ chế & giới hạn

1. **Attempt dang dở (`STARTED` → `UNKNOWN`):** Relay luôn commit `delivery_attempts` với `outcome = STARTED` ở Transaction 1 trước khi gọi HTTP (không giữ transaction mở khi chờ mạng). Khi relay chết trước Transaction 2 (ca F3), lần khởi động lại tìm mọi dòng `STARTED`, đổi sang `UNKNOWN`, tính là đã dùng 1 lượt trong vòng hiện tại và hẹn `next_attempt_at` theo backoff. Outbox không dùng cờ "đang gửi" nên không bị kẹt vĩnh viễn sau crash.
2. **Bản sao (`UNIQUE(source, event_id)`):** Vì mạng có timeout và relay có thể chết sau 2xx, bản sao là không thể tránh. Receiver xác định `source` từ secret cấu hình (không lấy từ header) và dùng ràng buộc `PRIMARY KEY (source, event_id)` cùng `INSERT ... ON CONFLICT DO NOTHING`. Bản sao đồng thời (F6) hay gửi lại (F3, F4) có cùng raw body đều trả `202` mà không thêm dòng; cùng `event_id` nhưng khác raw body trả `409` và không ghi đè dữ liệu cũ.
3. **Version cũ đến sau (F9):** Worker khóa dòng inbox (`FOR UPDATE SKIP LOCKED`) và cập nhật `video_summaries` bằng một lệnh `UPSERT` nguyên tử có điều kiện `WHERE EXCLUDED.version > video_summaries.version`. Khi E42 (version 1) đến sau E43 (version 2), 0 dòng nghiệp vụ bị sửa, `applied_count` giữ nguyên `1`, nhưng E42 vẫn được đánh dấu `PROCESSED` trong cùng transaction để worker không lặp vô hạn.
4. **Replay (F8):** `POST /events/:event_id/replay` chỉ chấp nhận event `DEAD` (trạng thái khác trả `409`), giữ nguyên `event_id` và `raw_body` bất biến, tăng `replay_round`, ghi bảng `replay_events`, đặt `status = PENDING`. Khi relay gửi ở vòng mới, timestamp và chữ ký HMAC-SHA256 được tính lại trên chính `raw_body` gốc, kèm `attempt_id` mới; lịch sử attempt các vòng cũ không bị sửa.
5. **Giới hạn của kiến trúc lab (không tuyên bố exactly-once đầu cuối):**
   - **Một relay duy nhất:** Chưa có cơ chế lease/locking cho nhiều relay chạy song song.
   - **Retry hữu hạn:** Tối đa 4 lần mỗi vòng rồi chuyển `DEAD`; không tự giao được nếu receiver ngừng hoạt động vô thời hạn mà không có người vận hành replay.
   - **Chống lặp chỉ trong DB receiver:** Giao dịch cục bộ bảo vệ bảng `inbox` và `video_summaries` cùng commit. Nếu thay bước cập nhật DB bằng tác vụ ngoài (gửi email, gọi LLM), crash trước commit vẫn có thể gọi lặp tác vụ ngoài — cần idempotency key phía nhà cung cấp hoặc đối soát.
   - **`DELIVERED` ≠ `PROCESSED`:** Mã `202` và trạng thái `DELIVERED` ở sender chỉ chứng minh receiver đã commit `inbox`, không chứng minh worker đã cập nhật `video_summaries` (được chứng minh trực tiếp bằng ca F10).

## 6. Cách kiểm tra lại

```powershell
npm.cmd test
npm.cmd run verify
npm.cmd run report
```
