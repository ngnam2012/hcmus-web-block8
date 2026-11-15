import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const read = name => readFile(new URL(`../evidence/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);
export async function buildReport() {
  const verification = await read('verification');
  const b0 = await read('B0-measurements');
  const f2 = await read('F2');
  const f4 = await read('F4-before-replay');
  const h1 = await read('H1');
  const mean = rows => (rows.reduce((sum, row) => sum + row.response_ms, 0) / rows.length).toFixed(1);
  const gaps = rows => rows.slice(1).map((row, i) => new Date(row.started_at) - new Date(rows[i].finished_at));
  const local = value => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const workers = Object.fromEntries(['worker-1', 'worker-2'].map(id => [id, h1.tables.processing_attempts.filter(a => a.worker_id === id).length]));
  let runtime = `Node host ${process.version}`;
  try { runtime += `; Docker server ${execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).trim()}`; }
  catch { /* Historical evidence is still readable without Docker running. */ }
  const text = `# Báo cáo Phần E — kết quả chạy thật

Thực hiện từ ${local(verification.started_at)} đến ${local(verification.finished_at)} (giờ Việt Nam, UTC+7). JSON gốc lưu UTC. Môi trường: ${runtime}; Linux containers, RabbitMQ 4.2 management, PostgreSQL 17, Node 22 trong container. Không gọi LLM thật.

## Kết quả

**${verification.passed ? 'PASS' : 'FAIL'}: ${verification.results.filter(r => r.passed).length}/${verification.results.length} ca.** Các demo crash dùng docker compose kill -s SIGKILL, không thay bằng exception. Mỗi ca reset dữ liệu trước khi chạy.

| Ca | Kết quả | Thời gian gồm chuẩn bị/chứng cứ |
| --- | --- | --- |
${verification.results.map(r => `| ${r.scenario} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.elapsed_ms ?? 'n/a'} ms |`).join('\n')}

## B0 — số đo HTTP

Cùng mock delay 800 ms, mỗi bản 5 request nối tiếp. Bản async được poll đến DONE trước khi gửi request tiếp theo để so sánh độc lập.

| Request | V0 trả 200 (ms) | V3 trả 202 (ms) | V3 phát hiện DONE sau (ms) |
| --- | --- | --- | --- |
${b0.V0.map((row, i) => `| ${i + 1} | ${row.response_ms} | ${b0.V3[i].response_ms} | ${b0.V3[i].done_after_ms} |`).join('\n')}
| Trung bình HTTP | ${mean(b0.V0)} | ${mean(b0.V3)} | — |

202 rút ngắn thời gian chờ HTTP; công việc vẫn cần xử lý nền. done_after_ms có cả độ trễ polling 150 ms, không phải latency thuần của worker. completed_at chính xác nằm trong JSON. Đây là phép đo lab nhỏ, không phải benchmark năng lực phục vụ.

## Các bằng chứng chính

- H1: 20 job DONE, 20 summary, 20 mock calls; phân bổ attempts: ${JSON.stringify(workers)}.
- F2: gap từ finished_at lần lỗi đến started_at lần tiếp theo: **${gaps(f2.tables.processing_attempts).join(', ')} ms**, policy 1000/3000 ms.
- F4: gap của bốn lần thử: **${gaps(f4.tables.processing_attempts).join(', ')} ms**, policy 1000/3000/9000 ms; sau replay có 1 summary, DLQ rỗng, message_id giữ nguyên.
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
`;
  await writeFile(new URL('../docs/REPORT.md', import.meta.url), text);
  console.log('Wrote docs/REPORT.md from measured evidence');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await buildReport();
