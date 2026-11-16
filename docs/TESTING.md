# Kịch bản kiểm thử và trình diễn

## Chạy và lấy chứng cứ

`npm.cmd run verify` chạy toàn bộ trên project Compose `hcmus-web-block8`. Cần stack chạy, Node dependencies đã cài và `GEMINI_API_KEY` trong `.env` (mặc định `LLM_PROVIDER=gemini`). Lệnh này reset **các bảng và queue của lab**, dừng/start worker để mỗi ca độc lập, không tác động project Docker khác. Không chạy song song các ca. *(Lưu ý: `H1` gửi 20 job liên tiếp; nếu API key Google AI Studio bị giới hạn RPM thấp hơn 20, có thể tạm đổi `LLM_PROVIDER=mock` khi chạy riêng ca tải này.)*

| Ca | Script kiểm tra | Bằng chứng |
| --- | --- | --- |
| B0 | 5 request V0 trả 200, 5 request V3 trả 202; cùng delay mock 800 ms; đo thêm thời điểm DONE | B0-measurements.json, B0.json |
| H0 | 202 khi job còn QUEUED; 1 DONE/summary/SUCCEEDED/call; mọi queue rỗng | H0.json |
| H1 | 20 DONE, 20 summary/call; hai worker đều có attempt; mỗi job chỉ một SUCCEEDED | H1.json |
| F1 | SIGKILL tại before_llm_call; QUEUED, ready=1, calls=0; restart redelivered, CRASHED+SUCCEEDED, calls=1 | F1-at-marker.json, F1-while-killed.json, F1.json |
| F2 | 429 hai lần; TRANSIENT_ERROR x2 + SUCCEEDED; gap >=1s và >=3s; calls=3 | F2.json; verification.json chứa gap đo |
| F3 | V9 NO_AUDIO, 1 PERMANENT_ERROR, 0 calls; DEAD_LETTERED, 1 DLQ có metadata | F3.json |
| F4 | 503 kéo dài, 4 TRANSIENT_ERROR, waits 1/3/9s; DLQ; gỡ fault và replay cùng message_id; DONE, 1 summary, DLQ rỗng | F4-before-replay.json, F4.json |
| F5 | SIGKILL sau commit trước ack; DB đã DONE; restart có DUPLICATE; 1 summary, calls vẫn 1 | F5-at-marker.json, F5-while-killed.json, F5.json |
| F6 | Workers tắt, 5 message accepted; stop broker; POST mới 503 và orphan QUEUED; restart giữ 5 accepted đến DONE | F6-before-broker-stop.json, F6-broker-down.json, F6.json |
| F7 | V7 version 1 chậm, version 2 nhanh; cả hai DONE; version 1 commit sau nhưng GET trả version 2 | F7.json |
| F8 | SIGKILL sau mock trước commit; restart redelivered, CRASHED+SUCCEEDED; 1 summary và 2 calls | F8-at-marker.json, F8-while-killed.json, F8.json |
| timeout | Timeout lần đầu; error_type LLM_TIMEOUT; retry thành công, 2 calls | timeout.json |

Mọi snapshot chứa các bảng jobs, summaries, processing_attempts (cùng videos, checkpoint/replay/mock), counts ready/unacked **từng queue** từ `rabbitmqctl list_queues`, DLQ payload/headers. Đọc DLQ không ack, đóng channel để requeue; thao tác quan sát có thể làm cờ redelivered của DLQ thay đổi. `verification.json` ghi PASS/FAIL, UTC timestamp, lệnh docker và thời điểm. Giờ Việt Nam = UTC+7.

## Trình diễn kill thủ công

Ví dụ F5, sau khi stack chạy:

```powershell
docker compose stop worker-2
$body = @{video_id='V1';options=@{pause_at='after_commit_before_ack';mock=@{delay_ms=100}}} | ConvertTo-Json -Depth 5
$job = Invoke-RestMethod http://127.0.0.1:3000/summaries -Method Post -ContentType application/json -Body $body
docker compose logs --tail 20 worker-1
# Đợi log JSON CHECKPOINT_PAUSED đúng job_id/marker rồi thực hiện:
node scripts/snapshot.js manual-F5-at-marker
docker compose kill -s SIGKILL worker-1
node scripts/snapshot.js manual-F5-while-killed
docker compose up -d worker-1 worker-2
Invoke-RestMethod "http://127.0.0.1:3000/summaries/$($job.job_id)/attempts"
node scripts/snapshot.js manual-F5-after-restart
```

Đổi marker thành `before_llm_call` (F1) hoặc `after_llm_before_commit` (F8). Marker chỉ pause một lần theo UNIQUE(job_id, marker), lưu DB trước khi in log. Không ném exception giả process death. H1 cũng có script tái hiện hai worker. F6 script tắt và start broker thật, giữ volume.

Đọc DB/broker trực tiếp:

```powershell
docker compose exec -T postgres psql -U lab -d broker_lab -c 'SELECT * FROM processing_attempts ORDER BY attempt_id;'
docker compose exec -T rabbitmq rabbitmqctl -q list_queues name messages_ready messages_unacknowledged
docker compose exec -T worker-1 node -e "fetch('http://127.0.0.1:3002/health').then(r=>r.json()).then(console.log)"
```

## Đổi port và cấu hình

Các giá trị mặc định trong source khớp `.env.example`. Docker Compose tự đọc `.env`; khi thay port và cần chạy script Node ở host, cấu hình đủ DATABASE_URL, AMQP_URL, MOCK_URL, RABBIT_MANAGEMENT_URL, API_PORT trong `.env`, rồi:

```powershell
node --env-file=.env scripts/scenarios.js all
node --env-file=.env scripts/snapshot.js manual
```

Nếu thay credential Postgres/RabbitMQ, cập nhật cả Compose và URL; volume cũ vẫn giữ credential cũ. Script benchmark dành loopback 3010; đảm bảo port này rảnh. Benchmark tạo rồi xóa đúng container `hcmus-block8-benchmark`; không xóa container khác.

## Phạm vi kiểm tra

Unit test tập trung vào phân loại transient/permanent, giới hạn fault injection, validate video động và ánh xạ prompt/lỗi Gemini. Test tích hợp gọi HTTP thật, đọc PostgreSQL thật, đếm RabbitMQ thật, gọi Google Gemini API thật ở các ca thành công và tiêm lỗi ở F2/F4/timeout; không mock broker và không suy ra thành công chỉ từ log. Chưa mô phỏng mất disk/network partition hoặc chạy benchmark tải lớn. Không suy ra exactly-once từ bộ test này.
