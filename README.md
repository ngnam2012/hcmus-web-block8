# hcmus-web-block8 — Message Broker & xử lý bất đồng bộ

Bài làm **Phần E, Block 8**: tóm tắt video qua RabbitMQ, API Node.js, PostgreSQL, hai competing consumer và **Google Gemini API (Google AI Studio)** thông qua `@google/genai` (Interactions API). Hệ thống hỗ trợ thêm video/transcript động qua API/UI và vẫn giữ tầng đếm lời gọi + fault injection cục bộ để kiểm chứng delivery semantics (retry, DLQ, crash recovery).

Đề gốc: <https://pub.nndkhoa9.win/webadv/w7/block-08-broker-interactive.html#1>.

## Cấu hình Google Gemini API (Google AI Studio)

1. Tạo API key tại Google AI Studio: <https://aistudio.google.com/api-keys>.
2. Sao chép `.env.example` thành `.env` (hoặc chỉnh file `.env` hiện có) và điền `GEMINI_API_KEY`:

```dotenv
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-3.5-flash-lite
LLM_PROVIDER=gemini
LLM_TIMEOUT_MS=15000
```

- `LLM_PROVIDER=gemini` (mặc định): mọi request tóm tắt bình thường sẽ gọi **Google Gemini API** động theo `title`, `transcript`, `options.language` và `options.style`.
- Nếu chạy bài test tải hàng loạt (`H1` / `verify`) trên máy không có mạng hoặc muốn tránh chạm giới hạn RPM của AI Studio Free Tier, có thể tạm đổi `LLM_PROVIDER=mock` trong `.env`.

## Chạy nhanh trên Windows / PowerShell

Yêu cầu: Docker Desktop chạy **Linux containers**, Docker Compose v2; Node.js >= 22 để chạy test/script trên máy. Các port mặc định: 3000, 3001, 5438, 5678, 15678.

```powershell
Set-Location c:\Users\admin\Downloads\block8\hcmus-web-block8
Copy-Item .env.example .env   # sau đó điền GEMINI_API_KEY vào .env
npm.cmd ci
docker compose up -d --build --wait
npm.cmd test
npm.cmd run test:integration
```

`verify` chạy B0, H0, H1, F1–F8 và timeout, mỗi ca dùng dữ liệu mới; xuất chứng cứ thực đo vào `evidence/`. Script tự dừng/start worker, SIGKILL worker tại marker và restart broker; **chỉ chạy trong project lab này**, không chạy đồng thời nhiều script. Dữ liệu lab cũ được reset. Khoảng 3–6 phút tùy máy (lần đầu tải image lâu hơn).

Nếu đã có `.env`, giữ cấu hình của bạn. Khi thay port/URL, đồng bộ các biến Node với `.env` qua Node `--env-file=.env` như hướng dẫn trong `docs/TESTING.md`; Docker Compose tự đọc `.env`, npm/Node mặc định không tự đọc.

```powershell
# Chỉ các test bắt buộc H0, F2, F3, F4, F7
npm.cmd run test:integration
# Các demo H1, F1, F5, F6, F8 (script hóa nhưng vẫn kill process thật)
npm.cmd run demo
# Một ca hoặc phép đo B0
node scripts/scenarios.js F5
npm.cmd run benchmark
# Snapshot DB + ready/unacked + DLQ payload
npm.cmd run snapshot -- my-snapshot
```

## Gọi API

```powershell
$body = @{video_id='V1'; options=@{language='vi'; style='short'}} | ConvertTo-Json
$job = Invoke-RestMethod http://127.0.0.1:3000/summaries -Method Post -ContentType application/json -Body $body
Invoke-RestMethod "http://127.0.0.1:3000$($job.status_url)"
Invoke-RestMethod "http://127.0.0.1:3000/summaries/$($job.job_id)/attempts"
Invoke-RestMethod http://127.0.0.1:3000/videos/V1/summary
Invoke-RestMethod "http://127.0.0.1:3001/calls/$($job.job_id)"
```

| Route                             | Ý nghĩa                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /videos`, `POST /videos`     | Xem danh sách hoặc thêm mới video/transcript động để Gemini tóm tắt.                                                                                                            |
| `POST /summaries`                 | Nhận `{video_id, options}`. Commit job QUEUED + version, publish persistent, chờ confirm rồi trả 202 + `job_id`, `message_id`, `status_url`. Trả 503 nếu broker không xác nhận. |
| `GET /summaries/:job_id`          | Trạng thái QUEUED / DONE / DEAD_LETTERED và bản tóm tắt nếu có.                                                                                                                 |
| `GET /summaries/:job_id/attempts` | Số lần xử lý, worker, redelivered, thời điểm và outcome/error_type.                                                                                                             |
| `GET /videos/:video_id/summary`   | Bản có version lớn nhất đã DONE.                                                                                                                                                |
| `POST /dlq/:message_id/replay`    | Lấy khỏi DLQ, giữ message_id, đổi QUEUED, ghi replay_events và gửi lại.                                                                                                         |
| `GET /health`                     | Health API (DB + broker + trạng thái cấu hình Gemini LLM). Worker có `/health` cổng 3002 bên trong container.                                                                   |
| llm: `GET /health`                | Health LLM service, provider (`gemini`/`mock`), model và trạng thái API key.                                                                                                    |
| llm: `GET /calls/:job_id`         | Bộ đếm, lịch sử gọi thực trong PostgreSQL.                                                                                                                                      |
| llm: `PUT /faults/:job_id`        | Đổi/gỡ fault; body `{}` để gỡ. Chỉ có khi LAB_MODE=true.                                                                                                                        |

Thử lỗi 429 hai lần đầu:

```powershell
$body = @{video_id='V1'; options=@{mock=@{status=429; fail_first=2; delay_ms=100}}} | ConvertTo-Json -Depth 5
Invoke-RestMethod http://127.0.0.1:3000/summaries -Method Post -ContentType application/json -Body $body
```

RabbitMQ Management: <http://127.0.0.1:15678>, tài khoản lab `lab` / `lab`. Tất cả port publish chỉ bind `127.0.0.1`; health của worker không publish ra host. Container dùng `0.0.0.0` để các service liên lạc trong mạng Compose. Các credential và endpoint fault/replay chỉ phục vụ lab cục bộ.

## Bốn phiên bản

Cùng mã nguồn, chọn bằng `APP_VERSION` trong `.env`, rồi `docker compose up -d --force-recreate api worker-1 worker-2`. Mặc định V3, bao gồm các tính năng trước đó.

| Version | Hành vi                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| V0      | API gọi mock đồng bộ, commit rồi trả 200. B0 tạo API V0 riêng ở loopback 3010, đo 5 request nối tiếp rồi đo 5 request V3 với cùng độ trễ mock.     |
| V1      | Publisher confirm, manual ack sau commit, 2 worker prefetch=1, lưu attempts, UNIQUE(job_id), kiểm soát version. Chưa retry lỗi tạm thời. H0/H1/F7. |
| V2      | Thêm retry TTL 1/3/9 giây, tối đa 4 lần mỗi lượt xử lý/replay, phân loại lỗi, DLQ, replay. F2/F3/F4.                                               |
| V3      | Thêm checkpoint persist và pause tại marker cho SIGKILL thật; restart broker, F1/F5/F6/F8.                                                         |

## Cấu trúc source

```text
src/
  api.js          HTTP contract, V0 baseline, DLQ replay, CRUD videos
  worker.js       consumer, idempotency, retry/DLQ, reconnect
  gemini.js       Google Gemini API client (@google/genai Interactions API)
  mock-llm.js     LLM gateway (Gemini thật / fault injection & bộ đếm bền vững)
  broker.js       durable topology + persistent publish/confirm/mandatory
  processing.js   attempts, checkpoints, mock call, transaction kết quả
  db.js           pool, transaction và advisory lock theo job
  domain.js       validation, message envelope, phân loại lỗi
  config.js       queue, policy và cấu hình
db/001-init.sql   schema, ràng buộc, seed V1/V7/V9
scripts/          test tích hợp, demo SIGKILL, B0, snapshot chứng cứ
test/             unit tests
docs/             kiến trúc, kịch bản, tham khảo, báo cáo thực chạy
evidence/         snapshot JSON và kết quả đo
compose.yaml      API + 2 worker + mock + RabbitMQ + PostgreSQL
```

Xem [kiến trúc](docs/ARCHITECTURE.md), [ma trận kiểm thử và demo](docs/TESTING.md), [báo cáo thực chạy](docs/REPORT.md), [nguồn tham khảo](docs/REFERENCES.md). File `requests.http` có mẫu gọi dành cho VS Code REST Client.

## Dừng hệ thống

```powershell
docker compose down
```

Volume giữ DB/broker qua lần chạy. Chỉ khi muốn xóa toàn bộ dữ liệu lab: `docker compose down -v`. Init SQL chỉ chạy khi volume PostgreSQL mới; các test tự reset nội dung qua SQL, không cần xóa volume.

## Giao diện web

Mở http://127.0.0.1:3000 sau khi chạy Docker Compose. Giao diện hỗ trợ tạo job, gửi batch 20 job, cấu hình mock, theo dõi queue, xem kết quả và attempts, gỡ fault và replay DLQ. Chọn checkpoint để dừng worker tại marker; thực hiện SIGKILL thật qua terminal theo TESTING.md.
