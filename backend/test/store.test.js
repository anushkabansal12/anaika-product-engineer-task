const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CompanyStore } = require('../store');

test('persists repeated research and change history across store instances', async (suite) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-brief-'));
  suite.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'companies.json');
  const store = new CompanyStore(filePath);
  await store.init();

  const baseResearch = {
    domain: 'example.com',
    websiteUrl: 'https://example.com',
    name: 'Example',
    description: 'A sample company',
    summary: 'A sample company.',
    score: { total: 50, breakdown: { fit: 50, timing: 50 }, reasons: [] },
    persona: { title: 'Relevant leader', rationale: 'Validate the contact.' },
    outreach: { subject: 'Hello', body: 'A first note.' },
    analysisMode: 'rules',
    snapshot: { title: 'Example', description: 'A sample company', headings: ['Home'] },
  };
  const first = await store.saveResearch(baseResearch);
  const updated = await store.saveResearch({
    ...baseResearch,
    snapshot: { title: 'Example careers', description: 'We are hiring engineers', headings: ['Open roles'] },
  });

  assert.equal(updated.id, first.id);
  assert.equal(updated.snapshots.length, 2);
  assert.equal(updated.signals[0].type, 'HIRING');

  const restored = new CompanyStore(filePath);
  await restored.init();
  assert.equal((await restored.list())[0].snapshots.length, 2);
  assert.equal(await restored.remove(first.id), true);
  assert.deepEqual(await restored.list(), []);
});
