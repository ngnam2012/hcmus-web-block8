const $ = s => document.querySelector(s);
let data, selected, busy = false, lastVideosKey = '';
const htmlCache = new WeakMap();
const setHtml = (el, html) => {
  if (htmlCache.get(el) === html) return false;
  htmlCache.set(el, html);
  el.innerHTML = html;
  return true;
};
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const x = await r.json();
  if (!r.ok) throw Error(x.error || r.status);
  return x;
}

function notify(s) { $('#notice').textContent = s; }

function options() {
  const o = { language: $('#language').value, style: $('#style').value };
  const delay = Number($('#delay').value);
  const fault = $('#fault').value;
  if (fault !== 'normal' || delay > 0) {
    const mock = {};
    if (delay > 0) mock.delay_ms = delay;
    if (fault === '429') Object.assign(mock, { status: 429, fail_first: 2 });
    if (fault === '503') mock.status = 503;
    if (fault === 'timeout') Object.assign(mock, { timeout: true, fail_first: 1 });
    o.mock = mock;
  }
  if ($('#marker').value) o.pause_at = $('#marker').value;
  return o;
}

async function create() {
  const j = await api('/summaries', 'POST', { video_id: $('#video').value, options: options() });
  selected = j.job_id;
  return j;
}

$('#form').onsubmit = async e => {
  e.preventDefault();
  $('#submit').disabled = true;
  try {
    const j = await create();
    notify('Đã nhận yêu cầu: ' + j.job_id);
    await refresh();
  } catch (err) {
    notify('Lỗi: ' + err.message);
  } finally {
    $('#submit').disabled = false;
  }
};

$('#batch').onclick = async () => {
  $('#batch').disabled = true;
  try {
    for (let i = 0; i < 20; i++) await create();
    notify('Đã gửi 20 yêu cầu. Theo dõi attempts để kiểm tra phân phối worker.');
    await refresh();
  } catch (err) {
    notify(err.message);
  } finally {
    $('#batch').disabled = false;
  }
};

$('#videoForm').onsubmit = async e => {
  e.preventDefault();
  $('#createVideo').disabled = true;
  try {
    const payload = {
      title: $('#newTitle').value,
      transcript: $('#newTranscript').value,
      has_audio: $('#newHasAudio').checked,
    };
    const rawId = $('#newVideoId').value.trim();
    if (rawId) payload.video_id = rawId;
    const v = await api('/videos', 'POST', payload);
    notify(`Đã thêm video ${v.video_id}: ${v.title}`);
    $('#newVideoId').value = '';
    $('#newTitle').value = '';
    $('#newTranscript').value = '';
    $('#newHasAudio').checked = true;
    await refresh();
    $('#video').value = v.video_id;
  } catch (err) {
    notify('Lỗi tạo video: ' + err.message);
  } finally {
    $('#createVideo').disabled = false;
  }
};

$('#filter').onchange = () => render();

document.addEventListener('click', async e => {
  const id = e.target.dataset.job;
  if (id) {
    selected = id;
    renderDetail();
    $('#detail').scrollIntoView();
  }
  if (e.target.id === 'replay') {
    e.target.disabled = true;
    try {
      await api('/dashboard/faults/' + selected, 'PUT', {});
      await api('/dlq/' + data.tables.jobs.find(j => j.job_id === selected).message_id + '/replay', 'POST');
      notify('Đã gỡ fault và replay cùng message_id.');
      await refresh();
    } catch (err) {
      notify(err.message);
    } finally {
      e.target.disabled = false;
    }
  }
});

function syncVideos() {
  const videos = data.tables.videos || [];
  const key = videos.map(v => `${v.video_id}:${v.title}:${v.has_audio}`).join('|');
  if (key === lastVideosKey) return;
  lastVideosKey = key;
  const prev = $('#video').value;
  $('#video').innerHTML = videos.map(v =>
    `<option value="${esc(v.video_id)}">${esc(v.video_id)} — ${esc(v.title)}${v.has_audio ? '' : ' (không âm thanh)'}</option>`
  ).join('');
  if (videos.some(v => v.video_id === prev)) $('#video').value = prev;
}

function renderHealth() {
  const h = $('#health');
  const llm = data.llm;
  if (!llm) {
    h.className = '';
    h.textContent = '● Hệ thống kết nối';
    return;
  }
  if (llm.provider === 'gemini') {
    if (llm.gemini_configured) {
      h.className = 'ok';
      h.textContent = `● Gemini (${llm.model})`;
    } else {
      h.className = 'warn';
      h.textContent = `⚠ Thiếu GEMINI_API_KEY (${llm.model})`;
    }
  } else {
    h.className = '';
    h.textContent = '● Mock LLM';
  }
}

function render() {
  syncVideos();
  renderHealth();
  const jobs = data.tables.jobs;
  setHtml($('#metrics'), [
    ['Tổng yêu cầu', jobs.length],
    ['Đang chờ', jobs.filter(j => j.status === 'QUEUED').length],
    ['Hoàn thành', jobs.filter(j => j.status === 'DONE').length],
    ['Dead letter', jobs.filter(j => j.status === 'DEAD_LETTERED').length],
  ].map(([t, n]) => `<div class="metric"><span>${t}</span><strong>${n}</strong></div>`).join(''));

  setHtml($('#queueRows'), data.queues.map(q =>
    `<div class="queue"><code>${esc(q.name)}</code><span><b>${q.ready}</b> ready · ${q.unacked ?? '—'} unacked · ${q.consumers} consumer</span></div>`
  ).join(''));

  setHtml($('#jobRows'), [...jobs]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .filter(j => !$('#filter').value || j.status === $('#filter').value)
    .map(j => `<tr><td><code>${esc(j.job_id.slice(0, 8))}</code><br>${esc(j.video_id)}</td><td>v${j.version}</td><td><span class="badge ${j.status}">${j.status}</span></td><td>${data.calls.find(c => c.job_id === j.job_id)?.count || 0}</td><td>${new Date(j.created_at).toLocaleTimeString('vi-VN')}</td><td><button class="secondary" data-job="${j.job_id}">Chi tiết</button></td></tr>`)
    .join('') || '<tr><td colspan="6">Chưa có job trong danh sách.</td></tr>');
  renderDetail();
}

function renderDetail() {
  const j = data?.tables.jobs.find(j => j.job_id === selected);
  if (!j) return;
  const attempts = data.tables.processing_attempts.filter(a => a.job_id === selected);
  const s = data.tables.summaries.find(s => s.job_id === selected);
  const v = data.tables.videos.find(v => v.video_id === j.video_id);
  const detailEl = $('#jobDetail');
  const detailsOpen = detailEl.querySelector('details')?.open;
  const html = `
    <p><span class="badge ${j.status}">${j.status}</span> · ${esc(j.video_id)} / v${j.version} · Bản hiện tại v${v?.current_version ?? 0}</p>
    <p>Job: <code>${esc(j.job_id)}</code><br>Message: <code>${esc(j.message_id)}</code><br>Correlation: <code>${esc(j.correlation_id)}</code></p>
    ${j.status === 'DEAD_LETTERED' ? '<button id="replay">Gỡ fault &amp; Replay</button>' : ''}
    <h3>Transcript nguồn</h3>
    <pre>${esc(v?.transcript || (v?.has_audio === false ? '(Video không có âm thanh)' : 'Trống'))}</pre>
    <h3>Kết quả tóm tắt</h3>
    <pre>${esc(s?.content || 'Chưa có kết quả')}</pre>
    <h3>Lịch sử xử lý</h3>
    <div class="scroll"><table><tr><th>Lần</th><th>Worker</th><th>Kết quả</th><th>Giao lại</th><th>Lỗi</th><th>Bắt đầu / Kết thúc</th></tr>
      ${attempts.map(a => `<tr><td>${a.attempt_no}</td><td>${esc(a.worker_id)}</td><td>${esc(a.outcome || 'RUNNING')}</td><td>${a.redelivered ? 'Có' : 'Không'}</td><td>${esc(a.error_type || '—')}</td><td>${esc(a.started_at)}<br>${esc(a.finished_at || '—')}</td></tr>`).join('')}
    </table></div>
    <details><summary>Checkpoint, replay và dữ liệu job</summary><pre>${esc(JSON.stringify({ job: j, checkpoints: data.tables.checkpoint_events.filter(x => x.job_id === selected), replays: data.tables.replay_events.filter(x => x.message_id === j.message_id) }, null, 2))}</pre></details>`;
  if (setHtml(detailEl, html) && detailsOpen) {
    const det = detailEl.querySelector('details');
    if (det) det.open = true;
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    data = await api('/dashboard');
    render();
  } catch (e) {
    $('#health').className = '';
    $('#health').textContent = '● Mất kết nối';
    notify(e.message);
  } finally {
    busy = false;
  }
}

refresh();
setInterval(refresh, 2000);
