const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalysis, extractWebsiteFacts, normalizeWebsiteUrl, scoreCompany } = require('../research');
const { detectChanges } = require('../store');

test('normalizes bare domains and rejects unsafe URL schemes and hosts', () => {
  assert.equal(normalizeWebsiteUrl('example.com').href, 'https://example.com/');
  assert.throws(() => normalizeWebsiteUrl('file:///etc/passwd'), /Only HTTP and HTTPS/);
  assert.throws(() => normalizeWebsiteUrl('http://localhost:3000'), /publicly accessible/);
  assert.throws(() => normalizeWebsiteUrl('http://192.168.1.10'), /publicly accessible|Private or reserved/);
});

test('extracts public company facts and useful page links from HTML', () => {
  const facts = extractWebsiteFacts(
    '<html><head><title>Acme | Better analytics</title><meta name="description" content="Analytics for teams"><meta property="og:site_name" content="Acme"></head><body><nav>Ignore</nav><h1>Analytics for teams</h1><h2>See our product</h2><a href="/careers">Careers</a><script>private()</script></body></html>',
    'https://acme.example/',
  );

  assert.equal(facts.name, 'Acme');
  assert.equal(facts.description, 'Analytics for teams');
  assert.deepEqual(facts.headings, ['Analytics for teams', 'See our product']);
  assert.match(facts.pageText, /Analytics for teams/);
  assert.doesNotMatch(facts.pageText, /Ignore|private/);
  assert.equal(facts.usefulLinks[0].href, 'https://acme.example/careers');
});

test('score is transparent, bounded and more relevant with a matching profile', () => {
  const facts = { title: 'B2B analytics software', description: 'SaaS for engineering teams', headings: [], pageText: 'hiring engineers' };
  const matched = scoreCompany(facts, 'B2B SaaS engineering teams');
  const unmatched = scoreCompany(facts, 'consumer retail fashion');

  assert.ok(matched.total > unmatched.total);
  assert.ok(matched.total >= 0 && matched.total <= 100);
  assert.equal(matched.breakdown.fit, 100);
  assert.match(matched.reasons[0], /appeared on the company page/);
});

test('analysis is explicitly heuristic and uses provided website context in its draft', () => {
  const analysis = createAnalysis({
    name: 'Acme',
    domain: 'acme.example',
    title: 'Acme | Analytics',
    description: 'Analytics for engineering teams.',
    headings: [],
    pageText: '',
  }, 'engineering leaders');

  assert.equal(analysis.analysisMode, 'rules');
  assert.match(analysis.outreach.body, /engineering leaders/);
  assert.match(analysis.persona.rationale, /engineering leaders/);
});

test('change detection distinguishes event-like website copy from generic edits', () => {
  const previous = { title: 'Acme', description: 'Analytics', headings: ['Platform'], pageText: '' };
  const hiring = detectChanges(previous, { title: 'Acme careers', description: 'We are hiring', headings: ['Open roles'] });
  const generic = detectChanges(previous, { title: 'Acme new look', description: 'Meet the team', headings: ['About us'] });

  assert.equal(hiring[0].type, 'HIRING');
  assert.equal(generic[0].materiality, 'NOISE');
});
