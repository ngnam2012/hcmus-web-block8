# Báo cáo Phần E — kết quả chạy thật

Thực hiện từ 22:07:21 16/11/2026 đến 22:11:06 16/11/2026 (giờ Việt Nam, UTC+7). JSON gốc lưu UTC. Môi trường: Node host v22.19.0; Docker server 29.3.1; Linux containers, RabbitMQ 4.2 management, PostgreSQL 17, Node 22 trong container. LLM động qua Google Gemini API (gemini-3.5-flash-lite; tiêm lỗi cục bộ ở các ca F2/F4/timeout).

## Kết quả

**PASS: 12/12 ca.** Các demo crash dùng docker compose kill -s SIGKILL, không thay bằng exception. Mỗi ca reset dữ liệu trước khi chạy.

| Ca | Kết quả | Thời gian gồm chuẩn bị/chứng cứ |
| --- | --- | --- |
| B0 | PASS | 25700 ms |
| H0 | PASS | 5669 ms |
| F1 | PASS | 16355 ms |
| F2 | PASS | 10626 ms |
| F3 | PASS | 3509 ms |
| F4 | PASS | 19235 ms |
| F5 | PASS | 10931 ms |
| F6 | PASS | 23128 ms |
| F7 | PASS | 10432 ms |
| F8 | PASS | 14362 ms |
| timeout | PASS | 20993 ms |
| H1 | PASS | 64182 ms |

## B0 — số đo HTTP

Cùng độ trễ giả lập 800 ms (cộng thêm thời gian xử lý của LLM), mỗi bản 5 request nối tiếp. Bản async được poll đến DONE trước khi gửi request tiếp theo để so sánh độc lập.

| Request | V0 trả 200 (ms) | V3 trả 202 (ms) | V3 phát hiện DONE sau (ms) |
| --- | --- | --- | --- |
| 1 | 2752 | 12 | 2120 |
| 2 | 2119 | 11 | 2003 |
| 3 | 2250 | 11 | 2613 |
| 4 | 1536 | 9 | 2166 |
| 5 | 1826 | 10 | 1959 |
| Trung bình HTTP | 2096.6 | 10.6 | — |

202 rút ngắn thời gian chờ HTTP; công việc vẫn cần xử lý nền. done_after_ms có cả độ trễ polling 150 ms, không phải latency thuần của worker. completed_at chính xác nằm trong JSON. Đây là phép đo lab nhỏ, không phải benchmark năng lực phục vụ.

## Các bằng chứng chính

- H1: 20 job DONE, 20 summary, 20 LLM calls (20 thành công); phân bổ attempts: {"worker-1":10,"worker-2":10}.
- F2: gap từ finished_at lần lỗi đến started_at lần tiếp theo: **1028, 3009 ms**, policy 1000/3000 ms.
- F4: gap của bốn lần thử: **1009, 3015, 9009 ms**, policy 1000/3000/9000 ms; sau replay có 1 summary, DLQ rỗng, message_id giữ nguyên.
- F1: trước restart 0 LLM calls, sau restart 1 call thành công (tổng 1); attempt đầu CRASHED, attempt kế tiếp redelivered=true, cuối cùng SUCCEEDED.
- F5: DONE đã commit trước SIGKILL; giao lại ghi DUPLICATE, tổng LLM calls vẫn 1, chỉ 1 summary.
- F6: 5 message đã nhận sống qua restart broker; request trong lúc broker dừng trả 503 và để lại 1 job QUEUED không có attempt/message. **Gap 1 được ghi nhận**, không tự sửa bằng RAM retry.
- F7: version 1 commit sau version 2, nhưng bản hiện tại vẫn version 2. Hai job đều có summary riêng.
- F8: restart tạo **2 LLM calls thành công (tổng 2), 1 summary**, CRASHED rồi SUCCEEDED. **Gap 3 được ghi nhận**, không tuyên bố exactly-once cho LLM.
- Timeout: attempt đầu LLM_TIMEOUT/TRANSIENT_ERROR, sau retry SUCCEEDED, tổng 2 calls.

## Cách kiểm tra lại

Xem evidence/verification.json cho lệnh docker, UTC timestamp và kết quả assertions; các file H0/H1/F*.json cho snapshot DB, ready/unacked từng queue, mock call history và DLQ headers. F1/F5/F8 có snapshot tại marker và khi process còn đang tắt. F6 có snapshot broker-down kèm HTTP 503 và orphan. B0-measurements.json chứa đủ 10 response và thời điểm DONE.

Chạy lại: npm.cmd run verify. Chạy một ca: node scripts/scenarios.js F5. Các JSON là chứng cứ của từng lần reset; trạng thái DB đang mở sau toàn bộ suite chỉ tương ứng ca cuối. Không cộng số job giữa các snapshot độc lập.

## Giới hạn còn lại

DB và broker chưa có transaction phân tán/outbox. Có thể trùng message trong cửa sổ publish-confirm trước ack; UNIQUE(job_id), trạng thái DONE và job lock bảo vệ kết quả trong DB. Gap 2 có nhánh phục hồi DEAD_LETTERED khi giao lại nhưng không bảo đảm chỉ một bản vật lý trong DLQ. TTL/DLX classic queue chưa bảo đảm an toàn khi mất đích/disk. Không test cluster HA/network partition. Chi tiết và tài liệu gốc nằm trong ARCHITECTURE.md và REFERENCES.md.
