const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../server');

function createMemoryStore() {
  const companies = [];
  return {
    companies,
    async init() {},
    async list() { return structuredClone(companies); },
    async get(id) { return structuredClone(companies.find((company) => company.id === id) || null); },
    async saveResearch(research) {
      const company = {
        id: `company-${companies.length + 1}`,
        ...research,
        score: { total: 77, breakdown: { fit: 80, timing: 70 }, reasons: ['Match'] },
        snapshots: [{ capturedAt: new Date().toISOString(), ...research.snapshot }],
        signals: [],
      };
      companies.push(company);
      return structuredClone(company);
    },
    async remove(id) {
      const index = companies.findIndex((company) => company.id === id);
      if (index < 0) return false;
      companies.splice(index, 1);
      return true;
    },
  };
}

test('API validates input, saves research, returns the shortlist and removes a company', async (suite) => {
  const store = createMemoryStore();
  const app = createApp({
    store,
    research: async (url, context) => ({
      domain: 'example.com',
      websiteUrl: 'https://example.com',
      name: 'Example',
      summary: `Researched ${url} for ${context}`,
      score: { total: 77 },
      snapshot: { title: 'Example' },
    }),
  });
  const server = app.listen(0);
  await once(server, 'listening');
  suite.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const invalid = await fetch(`${baseUrl}/api/research`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: '' }),
  });
  assert.equal(invalid.status, 400);

  const created = await fetch(`${baseUrl}/api/research`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'example.com', context: 'SaaS' }),
  });
  assert.equal(created.status, 201);
  assert.match((await created.json()).company.summary, /SaaS/);

  const listed = await fetch(`${baseUrl}/api/companies`);
  assert.equal((await listed.json()).companies.length, 1);

  const removed = await fetch(`${baseUrl}/api/companies/company-1`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(store.companies.length, 0);
});

test('batch research caps input at 20 and reports partial success with bounded concurrency', async (suite) => {
  const store = createMemoryStore();
  let active = 0;
  let peakConcurrency = 0;
  const app = createApp({
    store,
    research: async (url, context) => {
      active += 1;
      peakConcurrency = Math.max(peakConcurrency, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (url.includes('unavailable')) throw new Error('Connection timed out');
      return {
        domain: new URL(`https://${url}`).hostname,
        websiteUrl: `https://${url}`,
        name: url.split('.')[0],
        summary: `Researched ${url} for ${context}`,
        score: { total: 70 },
        snapshot: { title: url },
      };
    },
  });
  const server = app.listen(0);
  await once(server, 'listening');
  suite.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const tooMany = await fetch(`${baseUrl}/api/research/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls: Array.from({ length: 21 }, (_, index) => `company-${index}.example`) }),
  });
  assert.equal(tooMany.status, 400);

  const batch = await fetch(`${baseUrl}/api/research/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls: ['one.example', 'unavailable.example', 'three.example', 'four.example', 'five.example'], context: 'SaaS' }),
  });
  assert.equal(batch.status, 202);
  const { job: startedJob } = await batch.json();
  assert.equal(startedJob.status, 'running');
  assert.equal(startedJob.total, 5);

  let payload;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const status = await fetch(`${baseUrl}/api/research/batch/${startedJob.id}`);
    assert.equal(status.status, 200);
    payload = (await status.json()).job;
    if (payload.status !== 'running') break;
  }

  assert.equal(payload.status, 'completed');
  assert.equal(payload.successful, 4);
  assert.equal(payload.failed.length, 1);
  assert.match(payload.failed[0].error, /Could not research this website/);
  assert.ok(peakConcurrency <= 3);
  assert.equal((await (await fetch(`${baseUrl}/api/companies`)).json()).companies.length, 4);

  const allFailed = await fetch(`${baseUrl}/api/research/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls: ['unavailable.example'] }),
  });
  assert.equal(allFailed.status, 202);
  const failedJob = await allFailed.json();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const status = await fetch(`${baseUrl}/api/research/batch/${failedJob.job.id}`);
    payload = (await status.json()).job;
    if (payload.status !== 'running') break;
  }
  assert.equal(payload.status, 'failed');
  assert.equal(payload.failed.length, 1);
});

test('batch jobs expose live progress, reject overlapping runs and report unknown jobs', async (suite) => {
  const store = createMemoryStore();
  let releaseResearch;
  const researchGate = new Promise((resolve) => { releaseResearch = resolve; });
  const app = createApp({
    store,
    research: async (url) => {
      await researchGate;
      return {
        domain: url,
        websiteUrl: `https://${url}`,
        name: url,
        summary: 'Company brief',
        score: { total: 60 },
        snapshot: { title: url },
      };
    },
  });
  const server = app.listen(0);
  await once(server, 'listening');
  suite.after(() => {
    releaseResearch();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const started = await fetch(`${baseUrl}/api/research/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls: ['one.example', 'two.example'] }),
  });
  assert.equal(started.status, 202);
  const { job } = await started.json();

  const overlapping = await fetch(`${baseUrl}/api/research/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls: ['three.example'] }),
  });
  assert.equal(overlapping.status, 409);

  const progress = await fetch(`${baseUrl}/api/research/batch/${job.id}`);
  const current = (await progress.json()).job;
  assert.equal(current.status, 'running');
  assert.equal(current.processed, 0);
  assert.equal(current.total, 2);

  releaseResearch();
  let payload;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const status = await fetch(`${baseUrl}/api/research/batch/${job.id}`);
    payload = (await status.json()).job;
    if (payload.status !== 'running') break;
  }
  assert.equal(payload.status, 'completed');
  assert.equal(payload.processed, 2);

  const missing = await fetch(`${baseUrl}/api/research/batch/not-a-job`);
  assert.equal(missing.status, 404);
});
