# Báo cáo Phần E — kết quả chạy thật

Thực hiện từ 17:31:16 15/11/2026 đến 17:33:51 15/11/2026 (giờ Việt Nam, UTC+7). JSON gốc lưu UTC. Môi trường: Node host v22.19.0; Docker server 29.5.2; Linux containers, RabbitMQ 4.2 management, PostgreSQL 17, Node 22 trong container. Không gọi LLM thật.

## Kết quả

**PASS: 12/12 ca.** Các demo crash dùng docker compose kill -s SIGKILL, không thay bằng exception. Mỗi ca reset dữ liệu trước khi chạy.

| Ca | Kết quả | Thời gian gồm chuẩn bị/chứng cứ |
| --- | --- | --- |
| B0 | PASS | 16178 ms |
| H0 | PASS | 6224 ms |
| H1 | PASS | 7133 ms |
| F1 | PASS | 17328 ms |
| F2 | PASS | 13366 ms |
| F3 | PASS | 4111 ms |
| F4 | PASS | 20165 ms |
| F5 | PASS | 16006 ms |
| F6 | PASS | 21474 ms |
| F7 | PASS | 5738 ms |
| F8 | PASS | 15320 ms |
| timeout | PASS | 12274 ms |

## B0 — số đo HTTP

Cùng mock delay 800 ms, mỗi bản 5 request nối tiếp. Bản async được poll đến DONE trước khi gửi request tiếp theo để so sánh độc lập.

| Request | V0 trả 200 (ms) | V3 trả 202 (ms) | V3 phát hiện DONE sau (ms) |
| --- | --- | --- | --- |
| 1 | 940 | 45 | 1083 |
| 2 | 841 | 15 | 1012 |
| 3 | 841 | 19 | 859 |
| 4 | 842 | 15 | 871 |
| 5 | 847 | 50 | 957 |
| Trung bình HTTP | 862.2 | 28.8 | — |

202 rút ngắn thời gian chờ HTTP; công việc vẫn cần xử lý nền. done_after_ms có cả độ trễ polling 150 ms, không phải latency thuần của worker. completed_at chính xác nằm trong JSON. Đây là phép đo lab nhỏ, không phải benchmark năng lực phục vụ.

## Các bằng chứng chính

- H1: 20 job DONE, 20 summary, 20 mock calls; phân bổ attempts: {"worker-1":10,"worker-2":10}.
- F2: gap từ finished_at lần lỗi đến started_at lần tiếp theo: **1024, 3016 ms**, policy 1000/3000 ms.
- F4: gap của bốn lần thử: **1016, 3022, 9011 ms**, policy 1000/3000/9000 ms; sau replay có 1 summary, DLQ rỗng, message_id giữ nguyên.
- F1: trước restart 0 mock calls, sau restart 1; attempt cũ CRASHED, lần sau SUCCEEDED, redelivered=true.
- F5: DONE đã commit trước SIGKILL; giao lại ghi DUPLICATE, tổng mock calls vẫn 1, chỉ 1 summary.
- F6: 5 message đã nhận sống qua restart broker; request trong lúc broker dừng trả 503 và để lại 1 job QUEUED không có attempt/message. **Gap 1 được ghi nhận**, không tự sửa bằng RAM retry.
- F7: version 1 commit sau version 2, nhưng bản hiện tại vẫn version 2. Hai job đều có summary riêng.
- F8: restart tạo **2 mock calls, 1 summary**, CRASHED rồi SUCCEEDED. **Gap 3 được ghi nhận**, không tuyên bố exactly-once cho LLM.
- Timeout: attempt đầu LLM_TIMEOUT/TRANSIENT_ERROR, sau retry SUCCEEDED, tổng 2 calls.

## Cách kiểm tra lại

Xem evidence/verification.json cho lệnh docker, UTC timestamp và kết quả assertions; các file H0/H1/F*.json cho snapshot DB, ready/unacked từng queue, mock call history và DLQ headers. F1/F5/F8 có snapshot tại marker và khi process còn đang tắt. F6 có snapshot broker-down kèm HTTP 503 và orphan. B0-measurements.json chứa đủ 10 response và thời điểm DONE.

Chạy lại: npm.cmd run verify. Chạy một ca: node scripts/scenarios.js F5. Các JSON là chứng cứ của từng lần reset; trạng thái DB đang mở sau toàn bộ suite chỉ tương ứng ca cuối. Không cộng số job giữa các snapshot độc lập.

## Giới hạn còn lại

DB và broker chưa có transaction phân tán/outbox. Có thể trùng message trong cửa sổ publish-confirm trước ack; UNIQUE(job_id), trạng thái DONE và job lock bảo vệ kết quả trong DB. Gap 2 có nhánh phục hồi DEAD_LETTERED khi giao lại nhưng không bảo đảm chỉ một bản vật lý trong DLQ. TTL/DLX classic queue chưa bảo đảm an toàn khi mất đích/disk. Không test cluster HA/network partition. Chi tiết và tài liệu gốc nằm trong ARCHITECTURE.md và REFERENCES.md.
