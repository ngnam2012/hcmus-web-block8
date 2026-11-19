const $ = id => document.getElementById(id);

let currentState = null;
let pollTimer = null;
const selectedMarkers = {};

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('vi-VN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function fmtCountdown(iso) {
  if (!iso) return '—';
  const diffMs = new Date(iso).getTime() - Date.now();
  const t = fmtTime(iso);
  return diffMs > 0 ? `${t} (+${(diffMs / 1000).toFixed(1)}s)` : `${t} (đến hạn)`;
}

function addLog(badge, message, kind = 'relay') {
  const host = $('activity-log');
  const item = document.createElement('div');
  item.className = 'log-item';
  item.innerHTML = `<span class="log-time">${fmtTime(new Date().toISOString())}</span><span class="pill ${esc(kind)}">${esc(badge)}</span><span class="log-detail">${esc(message)}</span>`;
  host.prepend(item);
  while (host.children.length > 50) host.lastChild.remove();
}

function showModal(title, meta, content) {
  $('modal-title').textContent = title;
  $('modal-meta').textContent = meta;
  let formatted = content;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    // plain text
  }
  $('modal-content').textContent = formatted;
  $('payload-dialog').showModal();
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, body: json };
}

function describeFault(fault) {
  if (!fault) return { active: false, text: 'Receiver API đang tắt' };
  const parts = [];
  if (fault.fail_status !== null) {
    parts.push(`HTTP ${fault.fail_status}${fault.fail_remaining ? ` (${fault.fail_remaining} lần)` : ' (liên tục)'}`);
  }
  if (fault.retry_after) parts.push(`Retry-After: ${fault.retry_after}s`);
  if (fault.redirect_to) parts.push(`Location: ${fault.redirect_to}`);
  if (fault.drop_after_commit_once) parts.push('Đóng socket sau commit inbox (1 lần - F4)');
  if (fault.delay_after_commit_ms > 0) {
    parts.push(`Trễ ${fault.delay_after_commit_ms}ms sau commit${fault.delay_after_commit_once ? ' (1 lần)' : ''}`);
  }
  return parts.length ? { active: true, text: parts.join(' · ') } : { active: false, text: 'Bình thường (không lỗi)' };
}

function renderProcesses(processes) {
  const strip = $('proc-strip');
  const accentMap = {
    'sender-api': 'sender-accent',
    relay: 'relay-accent',
    'receiver-api': 'receiver-accent',
    'receiver-worker': 'receiver-accent',
  };

  strip.innerHTML = processes
    .map(p => {
      const isUp = p.status === 'RUNNING' || p.status === 'PAUSED_AT_MARKER';
      const chosenMarker = selectedMarkers[p.name] ?? p.marker ?? '';
      let metaText = `${p.status}`;
      if (isUp) {
        metaText = `${p.status} · pid=${p.pid}${p.marker ? ` · marker=${p.marker}` : ''}`;
      } else if (p.last_exit) {
        metaText = `${p.status} (${p.last_exit.action}, pid=${p.last_exit.pid}, ${fmtTime(p.last_exit.at)})`;
      }

      const markerOptions = [
        `<option value="">(không marker)</option>`,
        ...p.available_markers.map(
          m => `<option value="${esc(m)}" ${chosenMarker === m ? 'selected' : ''}>marker: ${esc(m)}</option>`,
        ),
      ].join('');

      return `
        <div class="proc-card ${accentMap[p.name]} ${esc(p.status)}">
          <div class="proc-head">
            <span class="dot"></span>
            <strong>${esc(p.label)}</strong>
            <span class="proc-port mono">:${esc(p.port)}</span>
          </div>
          <div class="proc-meta">${esc(metaText)}</div>
          ${p.status === 'PAUSED_AT_MARKER' ? `<div class="proc-marker-badge">⏸ ĐANG DỪNG TẠI MARKER — Bấm Kill -9!</div>` : ''}
          <select class="marker-select" data-marker-for="${esc(p.name)}">${markerOptions}</select>
          <div class="proc-controls">
            <button class="btn xs ok-btn" data-proc-action="start" data-proc="${esc(p.name)}" type="button">▶ Start</button>
            <button class="btn xs" data-proc-action="stop" data-proc="${esc(p.name)}" ${isUp ? '' : 'disabled'} type="button">⏹ Stop</button>
            <button class="btn xs danger" data-proc-action="kill" data-proc="${esc(p.name)}" ${isUp ? '' : 'disabled'} type="button">Kill -9</button>
            <button class="btn xs" data-proc-logs="${esc(p.name)}" type="button">Logs (${p.logs.length})</button>
          </div>
        </div>
      `;
    })
    .join('');

  strip.querySelectorAll('[data-marker-for]').forEach(sel => {
    sel.onchange = () => {
      selectedMarkers[sel.dataset.markerFor] = sel.value;
    };
  });

  strip.querySelectorAll('[data-proc-action]').forEach(btn => {
    btn.onclick = () => controlProcess(btn.dataset.proc, btn.dataset.procAction);
  });

  strip.querySelectorAll('[data-proc-logs]').forEach(btn => {
    btn.onclick = () => {
      const proc = currentState?.processes?.find(x => x.name === btn.dataset.procLogs);
      const lines = proc?.logs?.length
        ? proc.logs.map(l => `[${fmtTime(l.at)}] [${l.stream}] ${l.line}`).join('\n')
        : '(Chưa có dòng log nào)';
      showModal(`Logs tiến trình — ${proc?.label || btn.dataset.procLogs}`, `status=${proc?.status} · pid=${proc?.pid ?? '-'}`, lines);
    };
  });
}

function renderGuidedBanner(demo) {
  const host = $('guided-banner');
  if (!demo) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');
  host.classList.remove('killed', 'recovered');
  if (demo.phase === 'KILLED' || demo.phase === 'WORKER_STOPPED') host.classList.add('killed');
  if (demo.phase === 'RECOVERED') host.classList.add('recovered');

  if (demo.id === 'F10') {
    const workerProc = currentState?.processes?.find(p => p.name === 'receiver-worker');
    const workerUp = workerProc?.status === 'RUNNING';
    host.innerHTML = `
      <div class="guided-head">
        <h3>${esc(demo.title)}</h3>
        <button class="btn sm" id="btn-close-guided" type="button">Ẩn hướng dẫn</button>
      </div>
      <div class="small" style="margin:0;color:var(--fg)">${esc(demo.after_kill_hint)}</div>
      <div class="guided-actions">
        ${
          workerUp
            ? `<span class="pill ok">✓ Receiver Worker đã bật lại — kiểm tra inbox PROCESSED và V7 = 200 OK ở bên dưới!</span>`
            : `<button class="btn ok-btn" id="btn-f10-start-worker" type="button">▶ Bật lại Receiver Worker để hoàn tất F10</button>`
        }
      </div>
    `;
    $('btn-close-guided').onclick = () => {
      host.classList.add('hidden');
      if (currentState) currentState.guided_demo = null;
    };
    const btnStart = $('btn-f10-start-worker');
    if (btnStart) btnStart.onclick = () => controlProcess('receiver-worker', 'start');
    return;
  }

  const s1 = 'done';
  const s2 = demo.phase === 'PAUSED_AT_MARKER' ? 'active-bad' : 'done';
  const s3 = demo.phase === 'KILLED' ? 'active' : demo.phase === 'RECOVERED' ? 'done' : '';

  host.innerHTML = `
    <div class="guided-head">
      <h3>${esc(demo.title)}</h3>
      <div class="guided-steps">
        <span class="step-chip ${s1}">1. Dừng tại marker</span>
        <span class="step-chip ${s2}">2. Kill -9 (SIGKILL) thật</span>
        <span class="step-chip ${s3}">3. Restart &amp; Phục hồi</span>
      </div>
    </div>
    <div class="guided-marker-box">${esc(demo.marker_line || '')}</div>
    <div class="small" style="margin:0;color:var(--fg)">
      ${
        demo.phase === 'PAUSED_AT_MARKER'
          ? esc(demo.before_kill_hint)
          : demo.phase === 'KILLED'
            ? esc(demo.after_kill_hint)
            : `Đã phục hồi: ${esc((demo.recovery_actions || []).join(' · '))}`
      }
    </div>
    <div class="guided-actions">
      ${
        demo.phase === 'PAUSED_AT_MARKER'
          ? `<button class="btn danger" id="btn-guided-kill" type="button">Bước 2: Bấm KILL -9 (SIGKILL) tiến trình ${esc(demo.target)} (pid=${esc(demo.pid)})</button>`
          : ''
      }
      ${
        demo.phase === 'KILLED'
          ? `<span class="pill bad">Đã SIGKILL pid=${esc(demo.kill?.pid)} lúc ${fmtTime(demo.kill?.at)}</span>
             <button class="btn ok-btn" id="btn-guided-recover" type="button">Bước 3: Khởi động lại (không marker) &amp; Phục hồi</button>`
          : ''
      }
      ${
        demo.phase === 'RECOVERED'
          ? `<span class="pill ok">✓ Hoàn tất demo ${esc(demo.id)} — xem 2 DB bên dưới để đối chiếu kết quả!</span>`
          : ''
      }
    </div>
  `;

  const killBtn = $('btn-guided-kill');
  if (killBtn) killBtn.onclick = () => controlProcess(demo.target, 'kill', demo.marker);

  const recBtn = $('btn-guided-recover');
  if (recBtn) recBtn.onclick = recoverGuidedKill;
}

function renderTables(state) {
  const { jobs, outbox, delivery_attempts: attempts, replay_events: replays } = state.sender_db;
  const { inbox, video_summaries: summaries } = state.receiver_db;

  $('sender-db-counts').textContent = `${outbox.length} outbox · ${attempts.length} attempts`;
  $('receiver-db-counts').textContent = `${inbox.length} inbox · ${summaries.length} summary`;

  // Pipeline summary
  $('pipe-jobs').textContent = jobs.length
    ? jobs.map(j => `${j.job_id}(v${j.version}): ${j.status}`).join(' · ')
    : 'Trống';
  $('pipe-outbox').textContent = outbox.length
    ? outbox.map(o => `${o.event_id}: ${o.status} (vòng ${o.replay_round})`).join(' · ')
    : 'Trống';
  $('pipe-inbox').textContent = inbox.length
    ? inbox.map(i => `${i.event_id}: ${i.status}`).join(' · ')
    : 'Trống';

  const v7 = summaries.find(s => s.video_id === 'V7');
  $('pipe-summary').textContent = v7
    ? `V7: v${v7.version} · applied_count=${v7.applied_count}`
    : 'V7: 404 (chưa xử lý)';

  // Fault banner
  const faultDesc = describeFault(state.receiver_fault);
  const fb = $('active-fault');
  fb.classList.toggle('active', faultDesc.active);
  fb.innerHTML = `Trạng thái fault: <strong>${esc(faultDesc.text)}</strong>`;

  // V7 spotlight
  const pill = $('v7-http-pill');
  const box = $('v7-summary-box');
  if (v7) {
    pill.textContent = '200 OK';
    pill.className = 'pill ok';
    box.className = 'summary-filled';
    box.innerHTML = `
      <div class="summary-metrics">
        <span class="metric-chip">video_id: ${esc(v7.video_id)}</span>
        <span class="metric-chip">version: ${esc(v7.version)}</span>
        <span class="metric-chip">applied_count: ${esc(v7.applied_count)}</span>
        <span class="metric-chip">source_event: ${esc(v7.source_event_id)}</span>
      </div>
      <div class="summary-text">${esc(v7.summary)}</div>
    `;
  } else {
    pill.textContent = '404 Not Found';
    pill.className = 'pill bad';
    box.className = 'summary-empty';
    box.innerHTML = 'Chưa có bản tóm tắt nào cho video <code>V7</code> (<code>GET /videos/V7/summary</code> trả <code>404</code>).';
  }

  // Jobs
  $('tbl-jobs').innerHTML = jobs.length
    ? jobs
        .map(
          j => `<tr>
            <td class="mono"><strong>${esc(j.job_id)}</strong></td>
            <td class="mono">${esc(j.video_id)}</td>
            <td class="mono">v${esc(j.version)}</td>
            <td><span class="pill ${esc(j.status)}">${esc(j.status)}</span></td>
            <td class="mono">${fmtTime(j.completed_at)}</td>
            <td><button class="btn xs" data-complete="${esc(j.job_id)}">${j.status === 'DONE' ? 'Gọi lại' : 'Complete'}</button></td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="empty-cell">Chưa có fixture</td></tr>';

  // Outbox
  $('tbl-outbox').innerHTML = outbox.length
    ? outbox
        .map(
          o => `<tr>
            <td class="mono"><strong>${esc(o.event_id)}</strong></td>
            <td class="mono">${esc(o.job_id)}</td>
            <td><span class="pill ${esc(o.status)}">${esc(o.status)}</span></td>
            <td class="mono">${esc(o.replay_round)}</td>
            <td class="mono">${fmtCountdown(o.next_attempt_at)}</td>
            <td class="mono">${esc(o.last_error || '—')}</td>
            <td>
              <button class="btn xs ${o.status === 'DEAD' ? 'primary' : ''}" data-replay="${esc(o.event_id)}">Replay</button>
              <button class="btn xs" data-view-outbox="${esc(o.event_id)}">Raw</button>
            </td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="empty-cell">outbox đang trống</td></tr>';

  // Delivery attempts with real measured gap
  const prevByKey = new Map();
  $('tbl-attempts').innerHTML = attempts.length
    ? attempts
        .map(a => {
          const key = `${a.event_id}#${a.round}`;
          const prev = prevByKey.get(key);
          let gapStr = '—';
          if (prev && prev.finished_at && a.started_at) {
            gapStr = `${new Date(a.started_at).getTime() - new Date(prev.finished_at).getTime()} ms`;
          }
          prevByKey.set(key, a);
          return `<tr>
            <td class="mono"><strong>${esc(a.attempt_id)}</strong></td>
            <td class="mono">${esc(a.event_id)}</td>
            <td class="mono">v${esc(a.round)} / #${esc(a.attempt_in_round)}</td>
            <td class="mono">${a.http_status ?? 'ERR'}</td>
            <td><span class="pill ${esc(a.outcome)}">${esc(a.outcome)}</span></td>
            <td class="mono">${esc(gapStr)}</td>
            <td class="mono">${esc(a.error_detail || '—')}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="7" class="empty-cell">Chưa có lần gửi nào</td></tr>';

  // Replay events
  $('tbl-replays').innerHTML = replays.length
    ? replays
        .map(
          r => `<tr>
            <td class="mono">${esc(r.replay_id)}</td>
            <td class="mono"><strong>${esc(r.event_id)}</strong></td>
            <td class="mono">vòng ${esc(r.round)}</td>
            <td class="mono">${fmtTime(r.replayed_at)}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="empty-cell">Chưa có thao tác replay</td></tr>';

  // Inbox
  $('tbl-inbox').innerHTML = inbox.length
    ? inbox
        .map(
          row => `<tr>
            <td class="mono">${esc(row.source)}</td>
            <td class="mono"><strong>${esc(row.event_id)}</strong></td>
            <td><span class="pill ${esc(row.status)}">${esc(row.status)}</span></td>
            <td class="mono">${esc(row.last_delivery_attempt || '—')}</td>
            <td class="mono">${fmtTime(row.received_at)}</td>
            <td class="mono">${fmtTime(row.processed_at)}</td>
            <td><button class="btn xs" data-view-inbox="${esc(row.event_id)}">Raw</button></td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="empty-cell">inbox đang trống</td></tr>';

  // Video summaries
  $('tbl-summaries').innerHTML = summaries.length
    ? summaries
        .map(
          s => `<tr>
            <td class="mono"><strong>${esc(s.video_id)}</strong></td>
            <td class="mono"><span class="pill ok">v${esc(s.version)}</span></td>
            <td class="mono"><strong>${esc(s.applied_count)}</strong></td>
            <td class="mono">${esc(s.source_event_id)}</td>
            <td>${esc(s.summary)}</td>
            <td class="mono">${fmtTime(s.updated_at)}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="empty-cell">video_summaries đang trống</td></tr>';

  document.querySelectorAll('[data-complete]').forEach(b => (b.onclick = () => completeJob(b.dataset.complete)));
  document.querySelectorAll('[data-replay]').forEach(b => (b.onclick = () => replayEvent(b.dataset.replay)));
  document.querySelectorAll('[data-view-outbox]').forEach(b => {
    b.onclick = () => {
      const row = outbox.find(o => o.event_id === b.dataset.viewOutbox);
      if (row) {
        showModal(
          `Outbox raw_body — ${row.event_id}`,
          `job=${row.job_id} · status=${row.status} · round=${row.replay_round} · ${row.raw_body.length} chars (bất biến)`,
          row.raw_body,
        );
      }
    };
  });
  document.querySelectorAll('[data-view-inbox]').forEach(b => {
    b.onclick = () => {
      const row = inbox.find(i => i.event_id === b.dataset.viewInbox);
      if (row) {
        showModal(
          `Inbox raw_body — ${row.event_id}`,
          `source=${row.source} · status=${row.status} · sha256=${row.payload_hash.slice(0, 16)}...`,
          row.raw_body,
        );
      }
    };
  });
}

function renderVerify(v) {
  const btn = $('btn-run-verify');
  const panel = $('verify-panel');
  btn.disabled = Boolean(v?.running);
  btn.textContent = v?.running ? 'Đang chạy 11 ca...' : 'Chạy tất cả 11 ca';

  if (!v || (!v.running && !v.results && !v.error)) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  let html = '';
  if (v.summary) {
    html += `<div class="sim-row"><strong>Kết quả kiểm chứng chính thức:</strong><span class="pill ${v.summary.failed === 0 ? 'ok' : 'bad'}">${v.summary.passed}/${v.summary.total} PASS</span></div>`;
  }
  if (v.error) {
    html += `<div class="pill bad">Lỗi: ${esc(v.error)}</div>`;
  }
  if (v.results) {
    html += `<div class="table-wrap"><table>
      <thead><tr><th>Ca</th><th>Loại</th><th>Trạng thái</th><th>Thời gian</th><th>Ghi chú đo</th></tr></thead>
      <tbody>${v.results
        .map(r => {
          const note = r.kill_pid
            ? `SIGKILL pid=${r.kill_pid}`
            : r.gaps
              ? `gaps: ${r.gaps.join(', ')} ms`
              : r.title;
          return `<tr>
            <td class="mono"><strong>${esc(r.id)}</strong></td>
            <td>${esc(r.kind)}</td>
            <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
            <td class="mono">${esc(r.duration_ms)} ms</td>
            <td class="mono">${esc(note)}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table></div>`;
  }
  if (v.output?.length) {
    html += `<pre class="verify-log">${esc(v.output.slice(-14).join('\n'))}</pre>`;
  }
  panel.innerHTML = html;
}

async function refreshAll() {
  try {
    const res = await api('/api/state');
    if (!res.ok) return;
    currentState = res.body;
    renderProcesses(currentState.processes);
    renderGuidedBanner(currentState.guided_demo);
    renderTables(currentState);
    renderVerify(currentState.verify);
  } catch {
    // ignore transient poll error
  }
}

async function controlProcess(name, action, reason) {
  const body = action === 'start' ? { marker: selectedMarkers[name] || '' } : action === 'kill' ? { reason } : undefined;
  if (action === 'start' && currentState?.guided_demo?.id === 'F10' && name === 'receiver-worker') {
    body.marker = '';
  }
  addLog(action.toUpperCase(), `${name}${body?.marker ? ` (marker=${body.marker})` : ''}...`, action === 'kill' ? 'bad' : 'relay');
  const res = await api(`/api/processes/${encodeURIComponent(name)}/${action}`, { method: 'POST', body });
  addLog(
    `${action.toUpperCase()} ${res.status}`,
    res.ok
      ? `${name}: ${action === 'kill' ? `SIGKILL pid=${res.body.kill.pid}` : res.body.process?.status}`
      : JSON.stringify(res.body),
    res.ok ? (action === 'kill' ? 'bad' : 'ok') : 'bad',
  );
  await refreshAll();
}

async function armKillDemo(caseId) {
  addLog(`DEMO ${caseId}`, `Đang nạp fixture và đưa tiến trình tới marker của ${caseId}...`, 'RETRYABLE');
  const res = await api(`/api/demo/arm-kill/${encodeURIComponent(caseId)}`, { method: 'POST' });
  if (res.ok) {
    const g = res.body.guided_demo;
    addLog(`MARKER ${caseId}`, `${g.target} (pid=${g.pid}) đang DỪNG tại ${g.marker} — sẵn sàng bấm Kill -9!`, 'RETRYABLE');
  } else {
    addLog(`ERR ${caseId}`, JSON.stringify(res.body), 'bad');
  }
  await refreshAll();
}

async function recoverGuidedKill() {
  addLog('RECOVER', 'Đang khởi động lại tiến trình (không marker) và phục hồi...', 'relay');
  const res = await api('/api/demo/recover-kill', { method: 'POST' });
  addLog(`RECOVER ${res.status}`, res.ok ? (res.body.actions || []).join(' · ') : JSON.stringify(res.body), res.ok ? 'ok' : 'bad');
  await refreshAll();
  setTimeout(refreshAll, 1400);
}

async function completeJob(jobId) {
  const res = await api(`/api/jobs/${encodeURIComponent(jobId)}/complete`, { method: 'POST' });
  addLog(`POST ${res.status}`, `/jobs/${jobId}/complete -> ${JSON.stringify(res.body)}`, res.ok ? 'ok' : 'bad');
  await refreshAll();
}

async function replayEvent(eventId) {
  const res = await api(`/api/events/${encodeURIComponent(eventId)}/replay`, { method: 'POST' });
  addLog(`REPLAY ${res.status}`, `/events/${eventId}/replay -> ${JSON.stringify(res.body)}`, res.ok ? 'ok' : 'bad');
  await refreshAll();
}

async function resetAll() {
  $('sim-output').classList.add('hidden');
  $('sim-output').innerHTML = '';
  const res = await api('/api/reset', { method: 'POST' });
  addLog('RESET', res.ok ? res.body.message : JSON.stringify(res.body), res.ok ? 'ok' : 'bad');
  await refreshAll();
}

async function applyFaultPreset(preset) {
  const presets = {
    clear: {},
    'f8-503': { fail_status: 503 },
    'f4-drop': { drop_after_commit_once: true },
    '429-ra': { fail_status: 429, fail_remaining: 1, retry_after: 3 },
    '301-redir': { fail_status: 301, redirect_to: 'http://127.0.0.1:4100/health' },
    'timeout-2s': { delay_after_commit_ms: 2500, delay_after_commit_once: true },
  };
  const res = await api('/api/receiver/fault', { method: 'PUT', body: presets[preset] ?? {} });
  addLog(`FAULT ${res.status}`, `${preset} -> ${JSON.stringify(res.body?.fault || res.body)}`, res.ok ? 'RETRYABLE' : 'bad');
  await refreshAll();
}

async function runSimulator(scenario) {
  const out = $('sim-output');
  out.classList.remove('hidden');
  out.innerHTML = `<div class="muted">Đang chạy ${esc(scenario)}...</div>`;
  const res = await api(`/api/simulate/${scenario}`, { method: 'POST' });
  addLog(`SIM ${scenario}`, `HTTP ${res.status} -> ${JSON.stringify(res.body)}`, res.ok ? 'ok' : 'bad');
  if (scenario === 'F5' && res.body?.results) {
    const labels = {
      tampered_body: 'Payload bị sửa sau khi ký',
      wrong_signature: 'Chữ ký HMAC sai',
      timestamp_too_old: 'Timestamp quá cũ (-301s)',
      timestamp_too_future: 'Timestamp tương lai (+301s)',
      invalid_schema: 'Chữ ký đúng nhưng sai schema (v=0)',
    };
    out.innerHTML = Object.entries(res.body.results)
      .map(([k, v]) => {
        const expected = k === 'invalid_schema' ? 400 : 401;
        return `<div class="sim-row"><span>${esc(labels[k] || k)}</span><span class="pill ${v.status === expected ? 'ok' : 'bad'}">HTTP ${v.status} · ${esc(v.body?.error || '')}</span></div>`;
      })
      .join('');
  } else if (scenario === 'F6' && res.body) {
    const cs = res.body.concurrent_statuses || [];
    out.innerHTML = `
      <div class="sim-row"><span>5 bản sao đồng thời (cùng E42 &amp; payload)</span><span class="pill ${cs.every(s => s === 202) ? 'ok' : 'bad'}">[${cs.join(', ')}]</span></div>
      <div class="sim-row"><span>Cùng event_id E42 nhưng khác body</span><span class="pill ${res.body.conflict?.status === 409 ? 'ok' : 'bad'}">HTTP ${res.body.conflict?.status} · ${esc(res.body.conflict?.body?.error || '')}</span></div>
    `;
  }
  await refreshAll();
}

function setupPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if ($('auto-refresh').checked) pollTimer = setInterval(refreshAll, 800);
}

$('btn-refresh').onclick = refreshAll;
$('btn-reset').onclick = resetAll;
$('btn-start-all').onclick = async () => {
  addLog('START ALL', 'Đang khởi động lại đủ 4 tiến trình (không marker)...', 'relay');
  const res = await api('/api/processes/start-all', { method: 'POST' });
  addLog(`START ALL ${res.status}`, res.ok ? 'Cả 4 tiến trình đã sẵn sàng.' : JSON.stringify(res.body), res.ok ? 'ok' : 'bad');
  await refreshAll();
};
$('btn-complete-j42').onclick = () => completeJob('J42');
$('btn-complete-j43').onclick = () => completeJob('J43');
$('btn-demo-f9').onclick = async () => {
  addLog('DEMO F9', 'Đang chạy: E43 (v2) trước → E42 (v1) sau...', 'relay');
  const res = await api('/api/demo/f9', { method: 'POST' });
  addLog(`F9 ${res.status}`, res.ok ? `V7 giữ version=${res.body.summary?.version}, applied_count=${res.body.summary?.applied_count}` : JSON.stringify(res.body), res.ok ? 'ok' : 'bad');
  await refreshAll();
};
$('btn-demo-f10').onclick = async () => {
  addLog('DEMO F10', 'Đang tắt Receiver Worker và hoàn tất J42...', 'RETRYABLE');
  const res = await api('/api/demo/f10-prepare', { method: 'POST' });
  addLog(`F10 ${res.status}`, res.ok ? 'Sender DELIVERED, inbox RECEIVED, V7 trả 404 — bấm Start Receiver Worker để tiếp tục!' : JSON.stringify(res.body), res.ok ? 'RETRYABLE' : 'bad');
  await refreshAll();
};
$('btn-sim-f5').onclick = () => runSimulator('F5');
$('btn-sim-f6').onclick = () => runSimulator('F6');
$('btn-run-unit').onclick = async () => {
  const btn = $('btn-run-unit');
  const panel = $('unit-panel');
  btn.disabled = true;
  btn.textContent = 'Đang chạy Unit Tests...';
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="muted">Đang chạy node --test test/unit.test.js...</div>';
  addLog('UNIT TEST', 'Bắt đầu chạy Unit Tests (HMAC, ±300s, schema, classifier, Retry-After)...', 'relay');
  try {
    const res = await api('/api/unit-test/run', { method: 'POST' });
    const b = res.body || {};
    addLog(`UNIT ${b.ok ? 'PASS' : 'FAIL'}`, `${b.passed ?? '?'}/${b.total ?? '?'} PASS`, b.ok ? 'ok' : 'bad');
    panel.innerHTML = `
      <div class="sim-row">
        <strong>Kết quả Unit Tests:</strong>
        <span class="pill ${b.ok ? 'ok' : 'bad'}">${b.passed ?? '?'}/${b.total ?? '?'} PASS</span>
      </div>
      <pre class="verify-log">${esc((b.output || '').trim())}</pre>
    `;
  } catch (err) {
    panel.innerHTML = `<div class="pill bad">Lỗi: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Chạy Unit Tests';
  }
};
$('btn-run-verify').onclick = async () => {
  addLog('VERIFY', 'Bắt đầu chạy toàn bộ 11 ca H0 & F1–F10 (~35 giây)...', 'relay');
  const res = await api('/api/verify/run', { method: 'POST' });
  if (!res.ok) addLog('VERIFY ERR', JSON.stringify(res.body), 'bad');
  await refreshAll();
};
$('btn-clear-log').onclick = () => { $('activity-log').innerHTML = ''; };
$('auto-refresh').onchange = setupPolling;
$('modal-close').onclick = () => $('payload-dialog').close();

document.querySelectorAll('[data-kill-demo]').forEach(btn => {
  btn.onclick = () => armKillDemo(btn.dataset.killDemo);
});
document.querySelectorAll('[data-fault]').forEach(btn => {
  btn.onclick = () => applyFaultPreset(btn.dataset.fault);
});

addLog('UI', 'Demo Console sẵn sàng: bạn có thể demo 100% H0 & F1–F10 (gồm SIGKILL thật) ngay trên trình duyệt!', 'ok');
refreshAll();
setupPolling();
