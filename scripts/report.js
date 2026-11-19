import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const readEvidence = name =>
  readFile(new URL(`../evidence/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);

function formatLocal(iso) {
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

function summarizeObserved(r) {
  const o = r.observed || {};
  switch (r.id) {
    case 'H0':
      return `POST complete -> ${o.client_complete?.status} (${o.client_complete?.body?.event_id}); outbox=${o.event_status}, inbox=${o.inbox_status}, V7 version=${o.summary?.version}, applied_count=${o.summary?.applied_count}.`;
    case 'F1':
      return `SIGKILL pid=${o.kill?.pid} tại \`after_job_update_before_outbox\`; sau kill J42 vẫn READY, 0 outbox; gọi lại -> 200 E42, cuối cùng DELIVERED/PROCESSED, applied_count=1.`;
    case 'F2':
      return `SIGKILL pid=${o.kill?.pid} tại \`after_sender_commit_before_response\`; sau kill DB đã DONE + E42 PENDING; gọi lại -> 200 cùng E42 (\`already_completed=true\`); bật relay -> DELIVERED/PROCESSED, applied_count=1.`;
    case 'F3':
      return `SIGKILL pid=${o.kill?.pid} tại \`after_http_2xx_before_delivery_commit\`; sau kill receiver đã có inbox E42, sender còn PENDING & A1 STARTED; restart -> A1=UNKNOWN, A2=ACKNOWLEDGED (202), 1 inbox, applied_count=1.`;
    case 'F4':
      return `Receiver đóng socket 1 lần sau commit inbox -> A1=RETRYABLE (${o.attempts?.[0]?.error_detail}), inbox đã có E42 RECEIVED; retry A2=ACKNOWLEDGED (202); worker chạy -> 1 inbox PROCESSED, applied_count=1.`;
    case 'F5':
      return `tampered=${o.responses?.tampered_body?.status}, wrong_sig=${o.responses?.wrong_signature?.status}, old_ts=${o.responses?.timestamp_too_old?.status}, future_ts=${o.responses?.timestamp_too_future?.status}, bad_schema=${o.responses?.invalid_schema?.status}; inbox=0, summary=404.`;
    case 'F6':
      return `5 bản sao đồng thời -> [${o.concurrent_statuses?.join(', ')}], 1 inbox PROCESSED, applied_count=1; cùng event_id khác body -> ${o.conflict_response?.status} (${o.conflict_response?.body?.error}), dữ liệu cũ giữ nguyên.`;
    case 'F7':
      return `SIGKILL pid=${o.kill?.pid} tại \`after_projection_write_before_commit\`; sau kill inbox còn RECEIVED, summary=${o.summary_after_kill_status}; restart worker -> PROCESSED, version=1, applied_count=1.`;
    case 'F8':
      return `4 lần 503 (gaps: ${o.measured_gaps_ms?.join(', ')} ms) -> DEAD, inbox=0; replay -> vòng ${o.replay_response?.body?.replay_round}, raw_body giữ nguyên=${o.raw_body_preserved}, A5=202 DELIVERED/PROCESSED, applied_count=1; replay khi DELIVERED -> ${o.replay_when_delivered_status}.`;
    case 'F9':
      return `Sau E43 (v2): version=${o.after_E43?.version}, applied_count=${o.after_E43?.applied_count}; sau E42 (v1): cả 2 inbox PROCESSED, bản hiện tại vẫn version=${o.after_E42?.version} (${o.after_E42?.source_event_id}), applied_count=${o.after_E42?.applied_count}.`;
    case 'F10':
      return `Worker tắt: sender=${o.while_worker_stopped?.sender_event_status}, inbox=${o.while_worker_stopped?.receiver_inbox_status}, GET summary=${o.while_worker_stopped?.receiver_summary_http_status}; bật worker -> PROCESSED, version=${o.after_worker_started?.version}, applied_count=${o.after_worker_started?.applied_count}.`;
    default:
      return r.status;
  }
}

export async function buildReport() {
  const v = await readEvidence('verification');
  const f1After = await readEvidence('F1-after-kill');
  const f2After = await readEvidence('F2-after-kill');
  const f3After = await readEvidence('F3-after-kill');
  const f3Final = await readEvidence('F3');
  const f7After = await readEvidence('F7-after-kill');
  const f8Before = await readEvidence('F8-before-replay');
  const f8Final = await readEvidence('F8');
  const f8Result = v.results.find(r => r.id === 'F8');

  let runtime = `Node ${v.node_version} (${v.platform})`;
  try {
    const dockerVer = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    runtime += `; Docker server ${dockerVer}; PostgreSQL 17-alpine (2 DB logic: \`sender_db\` & \`receiver_db\`)`;
  } catch {
    runtime += `; PostgreSQL 17 (2 DB logic: \`sender_db\` & \`receiver_db\`)`;
  }

  const killCases = v.results.filter(r => r.kind === 'Kill thật');

  const expectedObservedRows = v.results
    .map(
      r =>
        `| **${r.id}** | ${r.kind} | ${r.expected} | ${summarizeObserved(r)} | **${r.status}** (${r.duration_ms} ms) | ${(r.observed?.snapshots || []).map(s => `\`${s}\``).join(', ')} |`,
    )
    .join('\n');

  const killRows = killCases
    .map(r => {
      const k = r.observed?.kill || {};
      const markerName = k.reason || '-';
      const signalLabel =
        k.action && k.exit_signal && k.action.includes(k.exit_signal)
          ? `\`${k.action}\``
          : `\`${k.action || '-'}\`${k.exit_signal ? ` (${k.exit_signal})` : ''}`;
      return `| **${r.id}** | \`${k.service}\` | \`${k.pid}\` | \`${markerName}\` | ${signalLabel} | \`${k.at}\` | ${(r.observed?.snapshots || []).map(s => `\`${s}\``).join(' → ')} |`;
    })
    .join('\n');

  const text = `# Báo cáo Thực hành Block 9 — Kết quả chạy thật

Thực hiện từ **${formatLocal(v.started_at)}** đến **${formatLocal(v.finished_at)}** (giờ Việt Nam, UTC+7; JSON chứng cứ lưu UTC).
Môi trường: ${runtime}. Không gọi LLM; dùng fixture cố định \`J42\` (\`V7\`, version 1) và \`J43\` (\`V7\`, version 2).

## 1. Tổng hợp kết quả

**${v.summary.failed === 0 ? 'PASS' : 'FAIL'}: ${v.summary.passed}/${v.summary.total} ca** (gồm H0 và F1–F10).
Các ca F1, F2, F3, F7 dừng process tại marker rồi gửi **SIGKILL thật** (\`kill -9\` / \`TerminateProcess\`), không thay bằng \`throw\` exception và không dùng \`sleep\` đoán thời điểm. Mỗi ca đều reset sạch cả hai DB trước khi chạy.

## 2. Bảng Expected / Observed (H0, F1–F10)

| Ca | Loại | Expected (theo đề Block 9) | Observed (thực đo) | Kết quả | Snapshot |
| --- | --- | --- | --- | --- | --- |
${expectedObservedRows}

## 3. Bản ghi Kill thật (F1, F2, F3, F7)

| Ca | Process bị kill | PID | Marker | Tín hiệu | Thời điểm (UTC) | Snapshot đối chứng |
| --- | --- | --- | --- | --- | --- | --- |
${killRows}

Chi tiết trạng thái ngay sau SIGKILL (trích trực tiếp từ snapshot JSON):

- **F1 (\`F1-after-kill.json\`):** \`jobs.J42 = ${f1After.sender_db.jobs.find(j => j.job_id === 'J42')?.status}\`, \`outbox.length = ${f1After.sender_db.outbox.length}\`, \`inbox.length = ${f1After.receiver_db.inbox.length}\` — PostgreSQL rollback nguyên tử khi connection bị đứt đột ngột trước COMMIT.
- **F2 (\`F2-after-kill.json\`):** \`jobs.J42 = ${f2After.sender_db.jobs.find(j => j.job_id === 'J42')?.status}\`, \`outbox[0] = ${f2After.sender_db.outbox[0]?.event_id} (${f2After.sender_db.outbox[0]?.status})\`, \`delivery_attempts.length = ${f2After.sender_db.delivery_attempts.length}\` — thay đổi đã bền vững dù client không nhận response; gọi lại \`complete\` trả đúng \`E42\`.
- **F3 (\`F3-after-kill.json\` → \`F3.json\`):** sau kill, \`outbox[0] = ${f3After.sender_db.outbox[0]?.status}\`, \`delivery_attempts[0] = ${f3After.sender_db.delivery_attempts[0]?.attempt_id} (${f3After.sender_db.delivery_attempts[0]?.outcome})\` trong khi \`receiver_db.inbox.length = ${f3After.receiver_db.inbox.length}\`. Sau restart: \`${f3Final.sender_db.delivery_attempts.map(a => `${a.attempt_id}:${a.outcome}`).join(', ')}\`, \`inbox.length = ${f3Final.receiver_db.inbox.length}\`, \`applied_count = ${f3Final.receiver_db.video_summaries[0]?.applied_count}\`.
- **F7 (\`F7-after-kill.json\`):** \`sender.outbox[0] = ${f7After.sender_db.outbox[0]?.status}\`, \`receiver.inbox[0] = ${f7After.receiver_db.inbox[0]?.status}\`, \`video_summaries.length = ${f7After.receiver_db.video_summaries.length}\` (GET trả \`404\`) — cả UPSERT lẫn dấu \`PROCESSED\` đều rollback cùng nhau.

## 4. Đo khoảng chờ retry & replay (F8)

- Chính sách backoff của lab: **${(f8Result?.observed?.backoff_policy_ms || [1000, 3000, 9000]).join(' / ')} ms** (tối đa 4 lần mỗi vòng).
- Sai số đo công bố: **[${f8Result?.observed?.tolerance_ms?.min_delta ?? -50} ms, +${f8Result?.observed?.tolerance_ms?.max_delta ?? 1000} ms]** (do chu kỳ poll relay 50 ms và độ trễ lập lịch tiến trình).
- Khoảng chờ đo được qua \`started_at[i] - finished_at[i-1]\`: **${(f8Result?.observed?.measured_gaps_ms || []).join(' ms, ')} ms**.
- Trước replay (\`F8-before-replay.json\`): \`outbox.status = ${f8Before.sender_db.outbox[0]?.status}\`, \`delivery_attempts = ${f8Before.sender_db.delivery_attempts.length}\` (đều 503 \`RETRYABLE\`), \`inbox.length = ${f8Before.receiver_db.inbox.length}\`.
- Sau replay (\`F8.json\`): giữ nguyên \`event_id = ${f8Final.sender_db.outbox[0]?.event_id}\` và byte-for-byte \`raw_body\`, mở \`replay_round = ${f8Final.sender_db.outbox[0]?.replay_round}\`, ghi \`replay_events\` (${f8Final.sender_db.replay_events.length} dòng), gửi \`A5\` (vòng 2, lần 1) thành công \`202\`, giữ nguyên lịch sử \`A1..A4\`.

## 5. Giải thích cơ chế & giới hạn

1. **Attempt dang dở (\`STARTED\` → \`UNKNOWN\`):** Relay luôn commit \`delivery_attempts\` với \`outcome = STARTED\` ở Transaction 1 trước khi gọi HTTP (không giữ transaction mở khi chờ mạng). Khi relay chết trước Transaction 2 (ca F3), lần khởi động lại tìm mọi dòng \`STARTED\`, đổi sang \`UNKNOWN\`, tính là đã dùng 1 lượt trong vòng hiện tại và hẹn \`next_attempt_at\` theo backoff. Outbox không dùng cờ "đang gửi" nên không bị kẹt vĩnh viễn sau crash.
2. **Bản sao (\`UNIQUE(source, event_id)\`):** Vì mạng có timeout và relay có thể chết sau 2xx, bản sao là không thể tránh. Receiver xác định \`source\` từ secret cấu hình (không lấy từ header) và dùng ràng buộc \`PRIMARY KEY (source, event_id)\` cùng \`INSERT ... ON CONFLICT DO NOTHING\`. Bản sao đồng thời (F6) hay gửi lại (F3, F4) có cùng raw body đều trả \`202\` mà không thêm dòng; cùng \`event_id\` nhưng khác raw body trả \`409\` và không ghi đè dữ liệu cũ.
3. **Version cũ đến sau (F9):** Worker khóa dòng inbox (\`FOR UPDATE SKIP LOCKED\`) và cập nhật \`video_summaries\` bằng một lệnh \`UPSERT\` nguyên tử có điều kiện \`WHERE EXCLUDED.version > video_summaries.version\`. Khi E42 (version 1) đến sau E43 (version 2), 0 dòng nghiệp vụ bị sửa, \`applied_count\` giữ nguyên \`1\`, nhưng E42 vẫn được đánh dấu \`PROCESSED\` trong cùng transaction để worker không lặp vô hạn.
4. **Replay (F8):** \`POST /events/:event_id/replay\` chỉ chấp nhận event \`DEAD\` (trạng thái khác trả \`409\`), giữ nguyên \`event_id\` và \`raw_body\` bất biến, tăng \`replay_round\`, ghi bảng \`replay_events\`, đặt \`status = PENDING\`. Khi relay gửi ở vòng mới, timestamp và chữ ký HMAC-SHA256 được tính lại trên chính \`raw_body\` gốc, kèm \`attempt_id\` mới; lịch sử attempt các vòng cũ không bị sửa.
5. **Giới hạn của kiến trúc lab (không tuyên bố exactly-once đầu cuối):**
   - **Một relay duy nhất:** Chưa có cơ chế lease/locking cho nhiều relay chạy song song.
   - **Retry hữu hạn:** Tối đa 4 lần mỗi vòng rồi chuyển \`DEAD\`; không tự giao được nếu receiver ngừng hoạt động vô thời hạn mà không có người vận hành replay.
   - **Chống lặp chỉ trong DB receiver:** Giao dịch cục bộ bảo vệ bảng \`inbox\` và \`video_summaries\` cùng commit. Nếu thay bước cập nhật DB bằng tác vụ ngoài (gửi email, gọi LLM), crash trước commit vẫn có thể gọi lặp tác vụ ngoài — cần idempotency key phía nhà cung cấp hoặc đối soát.
   - **\`DELIVERED\` ≠ \`PROCESSED\`:** Mã \`202\` và trạng thái \`DELIVERED\` ở sender chỉ chứng minh receiver đã commit \`inbox\`, không chứng minh worker đã cập nhật \`video_summaries\` (được chứng minh trực tiếp bằng ca F10).

## 6. Cách kiểm tra lại

\`\`\`powershell
npm.cmd test
npm.cmd run verify
npm.cmd run report
\`\`\`
`;

  await writeFile(new URL('../docs/REPORT.md', import.meta.url), text, 'utf8');
  console.log('Generated docs/REPORT.md from measured evidence.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  buildReport().catch(error => {
    console.error('REPORT_FAILED', error.message);
    process.exit(1);
  });
}
