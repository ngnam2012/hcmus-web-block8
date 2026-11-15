export class ProcessingError extends Error {
  constructor(type, transient) { super(type); this.type = type; this.transient = transient; }
}

export function classifyStatus(status) {
  return new ProcessingError(`LLM_HTTP_${status}`, status === 429 || status >= 500);
}

export function validateOptions(options = {}, labMode = false) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object');
  const keys = labMode ? ['language', 'style', 'mock', 'pause_at'] : ['language', 'style'];
  if (Object.keys(options).some(key => !keys.includes(key))) throw new Error('Unsupported option');
  for (const key of ['language', 'style']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key].length > 100)) throw new Error(`Invalid ${key}`);
  }
  if (options.pause_at && !['before_llm_call', 'after_llm_before_commit', 'after_commit_before_ack'].includes(options.pause_at)) throw new Error('Invalid pause_at');
  if (options.mock !== undefined) validateFault(options.mock);
  return options;
}

export function validateFault(fault) {
  if (!fault || typeof fault !== 'object' || Array.isArray(fault)) throw new Error('Invalid mock configuration');
  if (Object.keys(fault).some(key => !['delay_ms', 'status', 'fail_first', 'timeout'].includes(key))) throw new Error('Unsupported mock option');
  if (fault.delay_ms !== undefined && (!Number.isInteger(fault.delay_ms) || fault.delay_ms < 0 || fault.delay_ms > 30000)) throw new Error('Invalid delay_ms');
  if (fault.status !== undefined && ![200, 400, 429, 503].includes(fault.status)) throw new Error('Invalid mock status');
  if (fault.fail_first !== undefined && (!Number.isInteger(fault.fail_first) || fault.fail_first < 0 || fault.fail_first > 100)) throw new Error('Invalid fail_first');
  if (fault.timeout !== undefined && typeof fault.timeout !== 'boolean') throw new Error('Invalid timeout');
  return fault;
}

export function messageFor(job) {
  return {
    message_id: job.message_id, job_id: job.job_id, video_id: job.video_id,
    version: job.version, correlation_id: job.correlation_id,
    created_at: new Date(job.created_at).toISOString(), options: job.options,
  };
}
