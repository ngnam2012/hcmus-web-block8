import { snapshot, save, close } from './helpers.js';
try {
  const name = process.argv[2] || 'manual-snapshot';
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('Use letters, digits, _ or - for the snapshot name');
  const result = await snapshot(name);
  await save(name, result);
  console.log(JSON.stringify(result, null, 2));
} finally { await close(); }
