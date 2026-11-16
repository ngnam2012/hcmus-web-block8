import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { broker } from '../src/broker.js';
import { QUEUE, DLQ, sleep } from '../src/config.js';
import { compose, commands, request, submit, reset, until, status, snapshot, save, close, workerReady, mockUrl } from './helpers.js';

async function calls(jobId) { return (await request(`/calls/${jobId}`, { base: mockUrl })).body.count; }
async function attempts(jobId) { return (await request(`/summaries/${jobId}/attempts`)).body; }
async function queueEmpty() {
  await until(async () => {
    const ch = await (await broker.connect()).createChannel();
    try { return (await ch.checkQueue(QUEUE)).messageCount === 0; }
    finally { await ch.close(); }
  }, 'main queue empty');
  await sleep(200); // let the final consumer ack reach the broker
}
function checkEmpty(data, dlq = 0) {
  for (const queue of data.queues) {
    assert.equal(queue.messages_ready, queue.name === DLQ ? dlq : 0, `${queue.name} ready`);
    assert.equal(queue.messages_unacknowledged, 0, `${queue.name} unacked`);
  }
}
async function final(name) {
  await queueEmpty();
  const data = await snapshot(name);
  await save(name, data);
  return data;
}

const isGemini = () => report.llm?.provider === 'gemini';
function assertTransientOnly(rows) {
  assert.ok(rows.every(a => a.outcome === 'TRANSIENT_ERROR'), `Expected only transient retries, got ${rows.map(a => a.outcome)}`);
}

const scenarios = {
  async H0() {
    const result = await submit('V1', { mock: { delay_ms: 900 } });
    assert.equal(result.status, 202);
    const initial = await request(result.body.status_url);
    assert.equal(initial.body.status, 'QUEUED', '202 must precede completion');
    const done = await status(result.body.job_id);
    assert.ok(new Date(done.completed_at) > new Date(initial.body.created_at));
    const rows = await attempts(done.job_id);
    assert.equal(rows.at(-1).outcome, 'SUCCEEDED');
    if (isGemini()) assertTransientOnly(rows.slice(0, -1));
    else assert.equal(rows.length, 1);
    const data = await final('H0');
    assert.equal(data.tables.mock_calls.filter(c => c.response_status === 200).length, 1);
    if (!isGemini()) assert.equal(data.tables.mock_calls.length, 1);
    assert.equal(data.tables.summaries.length, 1);
    checkEmpty(data);
    return { response_ms: result.elapsed_ms, completed_at: done.completed_at };
  },
  async H1() {
    const jobs = [];
    const batches = isGemini() ? [10, 10] : [20];
    for (const [idx, count] of batches.entries()) {
      if (idx > 0) await sleep(45000); // Respect Free Tier 15 RPM quota between concurrent batches.
      const batch = [];
      for (let i = 0; i < count; i++) {
        const result = await submit('V1', { mock: { delay_ms: 200 } });
        assert.equal(result.status, 202);
        batch.push(result.body.job_id);
        jobs.push(result.body.job_id);
      }
      await Promise.all(batch.map(id => status(id)));
    }
    const data = await final('H1');
    assert.equal(data.tables.jobs.filter(j => j.status === 'DONE').length, 20);
    assert.equal(data.tables.summaries.length, 20);
    const okCalls = data.tables.mock_calls.filter(c => c.response_status === 200);
    assert.equal(okCalls.length, 20);
    if (isGemini()) {
      assert.ok(data.tables.mock_calls.every(c => [200, 429, 503, 504].includes(c.response_status)), 'unexpected non-transient LLM status in H1');
    } else {
      assert.equal(data.tables.mock_calls.length, 20);
    }
    assert.equal(new Set(data.tables.processing_attempts.map(a => a.worker_id)).size, 2);
    for (const id of jobs) assert.equal(data.tables.processing_attempts.filter(a => a.job_id === id && a.outcome === 'SUCCEEDED').length, 1);
    checkEmpty(data);
    return {
      total_llm_calls: data.tables.mock_calls.length,
      succeeded_calls: okCalls.length,
      transient_retries: data.tables.mock_calls.length - okCalls.length,
    };
  },
  async F2() {
    const { body, status: code } = await submit('V1', { mock: { status: 429, fail_first: 2, delay_ms: 100 } });
    assert.equal(code, 202);
    await status(body.job_id);
    const rows = await attempts(body.job_id);
    assert.equal(rows[0].outcome, 'TRANSIENT_ERROR');
    assert.equal(rows[1].outcome, 'TRANSIENT_ERROR');
    assert.equal(rows.at(-1).outcome, 'SUCCEEDED');
    if (isGemini()) assertTransientOnly(rows.slice(2, -1));
    else assert.equal(rows.length, 3);
    const delays = rows.slice(1).map((a, i) => new Date(a.started_at) - new Date(rows[i].finished_at));
    assert.ok(delays[0] >= 950 && delays[1] >= 2950, `Retry delays were ${delays}`);
    assert.ok(delays[0] < 6000 && delays[1] < 9000);
    const data = await final('F2');
    assert.equal(data.tables.mock_calls.filter(c => c.response_status === 200).length, 1);
    if (!isGemini()) assert.equal(data.tables.mock_calls.length, 3);
    assert.equal(data.tables.summaries.length, 1);
    checkEmpty(data);
    return { retry_gaps_ms: delays };
  },
  async F3() {
    const { body, status: code } = await submit('V9');
    assert.equal(code, 202);
    await status(body.job_id, 'DEAD_LETTERED');
    assert.deepEqual((await attempts(body.job_id)).map(a => a.outcome), ['PERMANENT_ERROR']);
    assert.equal(await calls(body.job_id), 0);
    const data = await final('F3');
    checkEmpty(data, 1);
    assert.equal(data.tables.summaries.length, 0);
    const dlq = data.dlq_messages[0];
    assert.equal(dlq.message.message_id, body.message_id);
    assert.equal(dlq.properties.headers.error_type, 'NO_AUDIO');
    assert.equal(dlq.properties.headers.attempt_count, 1);
    assert.ok(dlq.message.correlation_id);
  },
  async F4() {
    const { body, status: code } = await submit('V1', { mock: { status: 503, delay_ms: 100 } });
    assert.equal(code, 202);
    await status(body.job_id, 'DEAD_LETTERED');
    assert.deepEqual((await attempts(body.job_id)).map(a => a.outcome), Array(4).fill('TRANSIENT_ERROR'));
    assert.equal(await calls(body.job_id), 4);
    checkEmpty(await final('F4-before-replay'), 1);
    assert.equal((await request(`/faults/${body.job_id}`, { method: 'PUT', base: mockUrl, body: {} })).status, 200);
    const replay = await request(`/dlq/${body.message_id}/replay`, { method: 'POST' });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.message_id, body.message_id);
    await status(body.job_id);
    const data = await final('F4');
    assert.equal(data.tables.summaries.length, 1);
    assert.equal(data.tables.mock_calls.filter(c => c.response_status === 200).length, 1);
    if (!isGemini()) assert.equal(data.tables.mock_calls.length, 5);
    assert.equal(data.tables.replay_events.length, 1);
    assert.ok(data.tables.processing_attempts.every(a => a.message_id === body.message_id));
    checkEmpty(data);
  },
  async F7() {
    const first = await submit('V7', { mock: { delay_ms: 6000 } });
    // Ensure V1 has actually started before submitting V2 to the other worker.
    await until(async () => await calls(first.body.job_id) === 1, 'V1 in LLM');
    const second = await submit('V7', { mock: { delay_ms: 100 } });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const newDone = await status(second.body.job_id);
    const oldDone = await status(first.body.job_id);
    assert.ok(new Date(oldDone.completed_at) > new Date(newDone.completed_at));
    const current = await request('/videos/V7/summary');
    assert.equal(current.body.version, 2);
    assert.equal(current.body.job_id, second.body.job_id);
    const data = await final('F7');
    assert.equal(data.tables.summaries.length, 2);
    checkEmpty(data);
    return { v1_completed: oldDone.completed_at, v2_completed: newDone.completed_at, current_version: 2 };
  },
  async F1() { return crashScenario('F1', 'before_llm_call', 0, 1); },
  async F5() { return crashScenario('F5', 'after_commit_before_ack', 1, 1); },
  async F8() { return crashScenario('F8', 'after_llm_before_commit', 1, 2); },
  async F6() {
    compose('stop', '-t', '1', 'worker-1', 'worker-2');
    const accepted = [];
    for (let i = 0; i < 5; i++) {
      const result = await submit();
      assert.equal(result.status, 202);
      accepted.push(result.body.job_id);
    }
    const before = await snapshot('F6-before-broker-stop');
    assert.equal(before.queues.find(q => q.name === QUEUE).messages_ready, 5);
    await save('F6-before-broker-stop', before);
    compose('stop', 'rabbitmq');
    const rejected = await submit();
    assert.equal(rejected.status, 503);
    assert.equal((await request(rejected.body.status_url)).body.status, 'QUEUED');
    await save('F6-broker-down', { response: rejected, jobs: (await pool.query('SELECT * FROM jobs ORDER BY created_at')).rows, commands: [...commands] });
    compose('start', 'rabbitmq');
    await until(() => broker.connect(), 'broker restart', 60000);
    compose('up', '-d', 'worker-1', 'worker-2');
    await workerReady();
    await Promise.all(accepted.map(id => status(id)));
    const data = await final('F6');
    checkEmpty(data);
    assert.equal(data.tables.summaries.length, 5);
    const orphan = data.tables.jobs.find(j => j.job_id === rejected.body.job_id);
    assert.equal(orphan.status, 'QUEUED');
    assert.equal(data.tables.processing_attempts.filter(a => a.job_id === orphan.job_id).length, 0);
    const okCalls = data.tables.mock_calls.filter(c => c.response_status === 200);
    assert.equal(okCalls.length, 5);
    if (report.llm?.provider === 'gemini') {
      assert.ok(data.tables.mock_calls.every(c => [200, 429, 503, 504].includes(c.response_status)));
    } else {
      assert.equal(data.tables.mock_calls.length, 5);
    }
    return { orphan_job_id: orphan.job_id, http_when_broker_down: rejected.status, accepted_survived: 5, llm_calls_total: data.tables.mock_calls.length, known_gap: 1 };
  },
  async B0() {
    const sync = [], asyncRows = [];
    try {
      compose('run', '-d', '--no-deps', '--name', 'hcmus-block8-benchmark', '-p', '127.0.0.1:3010:3000', '-e', 'APP_VERSION=V0', 'api');
      await until(async () => (await request('/health', { base: 'http://127.0.0.1:3010' })).status === 200, 'V0 API');
      for (let i = 0; i < 5; i++) {
        let response, start;
        for (let tries = 0; tries < 4; tries++) {
          start = Date.now();
          response = await request('/summaries', { method: 'POST', base: 'http://127.0.0.1:3010', body: { video_id: 'V1', options: { mock: { delay_ms: 800 } } } });
          if (response.status === 200 || !isGemini() || response.status !== 502) break;
          await sleep(5000);
        }
        assert.equal(response.status, 200);
        sync.push({ job_id: response.body.job_id, http_status: response.status, response_ms: Date.now() - start });
      }
      for (let i = 0; i < 5; i++) {
        const start = Date.now();
        const response = await submit('V1', { mock: { delay_ms: 800 } });
        assert.equal(response.status, 202);
        const done = await status(response.body.job_id);
        asyncRows.push({ job_id: done.job_id, http_status: 202, response_ms: response.elapsed_ms, done_after_ms: Date.now() - start, completed_at: done.completed_at });
      }
      const data = { mock_delay_ms: 800, V0: sync, V3: asyncRows };
      await save('B0-measurements', data);
      checkEmpty(await final('B0'));
      return data;
    } finally {
      // Remove only the one named benchmark container created by this scenario.
      const { execFileSync } = await import('node:child_process');
      execFileSync('docker', ['rm', '-f', 'hcmus-block8-benchmark'], { stdio: 'pipe' });
      commands.push({ at: new Date().toISOString(), command: 'docker rm -f hcmus-block8-benchmark' });
    }
  },
  async timeout() {
    const { body } = await submit('V1', { mock: { timeout: true, fail_first: 1 } });
    await status(body.job_id);
    const rows = await attempts(body.job_id);
    assert.equal(rows[0].outcome, 'TRANSIENT_ERROR');
    assert.equal(rows[0].error_type, 'LLM_TIMEOUT');
    assert.equal(rows.at(-1).outcome, 'SUCCEEDED');
    if (isGemini()) assertTransientOnly(rows.slice(1, -1));
    else {
      assert.equal(rows.length, 2);
      assert.equal(await calls(body.job_id), 2);
    }
    checkEmpty(await final('timeout'));
  },
};

async function crashScenario(name, marker, callsAtKill, callsFinal) {
  // Prevent the other competing consumer from picking up the redelivery first.
  compose('stop', '-t', '1', 'worker-2');
  const result = await submit('V1', { pause_at: marker, mock: { delay_ms: 100 } });
  assert.equal(result.status, 202);
  const jobId = result.body.job_id;
  const reached = await until(async () => (await pool.query('SELECT * FROM checkpoint_events WHERE job_id=$1 AND marker=$2', [jobId, marker])).rows[0], marker);
  const paused = await snapshot(`${name}-at-marker`);
  assert.equal(paused.queues.find(q => q.name === QUEUE).messages_unacknowledged, 1);
  await save(`${name}-at-marker`, paused);
  compose('kill', '-s', 'SIGKILL', 'worker-1');
  const killed = await snapshot(`${name}-while-killed`);
  assert.equal(await calls(jobId), callsAtKill);
  assert.equal(killed.tables.jobs[0].status, name === 'F5' ? 'DONE' : 'QUEUED');
  assert.equal(killed.tables.summaries.length, name === 'F5' ? 1 : 0);
  assert.equal(killed.queues.find(q => q.name === QUEUE).messages_ready, 1);
  assert.equal(killed.queues.find(q => q.name === QUEUE).messages_unacknowledged, 0);
  await save(`${name}-while-killed`, { ...killed, commands: [...commands], marker: reached });
  compose('up', '-d', 'worker-1', 'worker-2');
  await workerReady();
  await status(jobId);
  const rows = await attempts(jobId);
  assert.ok(rows[1]?.redelivered, 'real RabbitMQ redelivery expected');
  const data = await final(name);
  assert.equal(data.tables.summaries.length, 1);
  if (name === 'F5') {
    assert.deepEqual(rows.map(a => a.outcome), ['SUCCEEDED', 'DUPLICATE']);
    assert.equal(data.tables.mock_calls.length, callsFinal);
  } else if (report.llm?.provider === 'gemini') {
    assert.equal(rows[0].outcome, 'CRASHED');
    assert.equal(rows.at(-1).outcome, 'SUCCEEDED');
    assert.ok(rows.slice(1, -1).every(a => a.outcome === 'TRANSIENT_ERROR'));
    assert.equal(data.tables.mock_calls.filter(c => c.response_status === 200).length, callsFinal);
    assert.ok(data.tables.mock_calls.every(c => [200, 429, 503, 504].includes(c.response_status)));
  } else {
    assert.deepEqual(rows.map(a => a.outcome), ['CRASHED', 'SUCCEEDED']);
    assert.equal(data.tables.mock_calls.length, callsFinal);
  }
  checkEmpty(data);
  return { marker, killed_with: 'SIGKILL', mock_calls_before_restart: callsAtKill, mock_calls_succeeded: callsFinal, mock_calls_total: data.tables.mock_calls.length, known_gap: name === 'F8' ? 3 : null };
}

const groups = {
  automated: ['H0', 'F2', 'F3', 'F4', 'F7'],
  demos: ['H1', 'F1', 'F5', 'F6', 'F8'],
  all: ['B0', 'H0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'timeout', 'H1'],
};
const selected = process.argv[2] || 'automated';
const names = groups[selected] || [selected];
const report = { started_at: new Date().toISOString(), selected, llm: null, results: [] };
try {
  try {
    const health = await request('/health');
    if (health.status === 200 && health.body?.llm) report.llm = health.body.llm;
  } catch {}
  for (const name of names) {
    if (!scenarios[name]) throw new Error(`Unknown scenario ${name}`);
    console.log(`RUN ${name} (fresh data)`);
    const start = Date.now();
    const commandStart = commands.length;
    try {
      await reset();
      const measurements = await scenarios[name]();
      report.results.push({ scenario: name, passed: true, elapsed_ms: Date.now() - start, measurements, commands: commands.slice(commandStart) });
      console.log(`PASS ${name} (${Date.now() - start}ms)`);
    } catch (error) {
      report.results.push({ scenario: name, passed: false, error: error.stack, commands: commands.slice(commandStart) });
      throw error;
    }
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  report.finished_at = new Date().toISOString();
  report.passed = report.results.length === names.length && report.results.every(r => r.passed);
  await save(selected === 'all' ? 'verification' : `verification-${selected}`, report);
  if (selected === 'all' && report.passed) {
    const { buildReport } = await import('./report.js');
    await buildReport();
  }
  await close();
}
