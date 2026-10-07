const form = document.querySelector('#research-form');
const list = document.querySelector('#company-list');
const dialog = document.querySelector('#company-dialog');
const dialogContent = document.querySelector('#dialog-content');
const formStatus = document.querySelector('#form-status');
const singleInput = document.querySelector('#single-input');
const batchInput = document.querySelector('#batch-input');
const singleMode = document.querySelector('#single-mode');
const batchMode = document.querySelector('#batch-mode');
const resultSummary = document.querySelector('#batch-results');
const researchButton = document.querySelector('#research-button');
const singleJobKey = 'company-brief.active-batch-job';
let pollingBatch = false;
let researchMode = 'single';
let companies = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function hostLabel(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); }
  catch { return value || ''; }
}

function dateLabel(value) {
  if (!value) return 'Not yet researched';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

function priority(company) {
  const score = company.score?.total ?? 0;
  if (score >= 70) return 'Strong profile match';
  if (score >= 45) return 'Worth a closer look';
  return 'Needs more context';
}

function render() {
  const count = companies.length;
  const focus = [...companies].sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0)).slice(0, 5);
  document.querySelector('#company-count').textContent = count;
  document.querySelector('#sidebar-count').textContent = count;
  document.querySelector('#focus-copy').textContent = count
    ? `${focus[0].name} is currently your highest-scoring company. Scores are early heuristics based on the profile you provided.`
    : 'Add your first company to uncover the most promising next step.';

  if (!count) {
    list.innerHTML = '<div class="empty-state"><span class="empty-state-icon">✳</span><strong>Your shortlist starts here</strong><p>Add a company website above to get a research brief, a transparent priority score, and a first-pass outreach idea.</p></div>';
    return;
  }

  list.innerHTML = focus.map((company) => {
    const score = company.score?.total ?? 0;
    const snapshot = company.snapshots?.at(-1);
    const signal = company.signals?.[0];
    return `<article class="company-row" data-company-id="${escapeHtml(company.id)}">
      <div class="company-main">
        <span class="company-monogram">${escapeHtml((company.name || '?').slice(0, 1).toUpperCase())}</span>
        <span class="company-copy"><strong class="company-name">${escapeHtml(company.name || hostLabel(company.websiteUrl))}</strong><span class="company-domain">${escapeHtml(hostLabel(company.websiteUrl))} · researched ${escapeHtml(dateLabel(snapshot?.capturedAt))}</span></span>
      </div>
      <div class="score-cell"><div class="score-head"><span>Priority</span><span class="score-number">${score}<span style="font-weight:400">/100</span></span></div><div class="score-track"><div class="score-fill" style="width:${Math.max(0, Math.min(score, 100))}%"></div></div></div>
      <div class="signal-cell">${signal ? `<span class="signal-pill${signal.materiality === 'NOISE' ? ' no-signal' : ''}">${escapeHtml(signal.type.replaceAll('_', ' ').toLowerCase())}</span>` : '<span class="signal-pill no-signal">no change yet</span>'}</div>
      <button class="row-action" type="button" data-action="open" aria-label="Open ${escapeHtml(company.name)} details">↗</button>
    </article>`;
  }).join('');

  document.querySelector('#list-foot').textContent = count > 5
    ? `Showing the five highest-priority companies of ${count}. Scores are heuristic, not verified recommendations.`
    : 'Only the five highest-priority companies are highlighted. Scores are heuristic, not verified recommendations.';
}

async function loadCompanies() {
  list.innerHTML = '<div class="loading-row">Loading your company brief…</div>';
  try {
    const response = await fetch('/api/companies');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load the company list.');
    companies = payload.companies;
    render();
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><strong>Could not load your brief</strong><p>${escapeHtml(error.message)} Refresh the page to try again.</p></div>`;
  }
}

function setStatus(message, kind = '') {
  formStatus.textContent = message;
  formStatus.removeAttribute('data-error');
  formStatus.removeAttribute('data-success');
  if (kind) formStatus.dataset[kind] = 'true';
}

function updateBatchProgress(job) {
  const failureDetails = (job.failed || []).map((failure) =>
    `<div class="batch-error"><span>${escapeHtml(failure.url)}</span> ${escapeHtml(failure.error)}</div>`,
  ).join('');
  if (job.status === 'running') {
    resultSummary.innerHTML = `<strong>Researching companies · ${job.processed} of ${job.total} complete</strong><progress class="batch-progress" max="${job.total}" value="${job.processed}">${job.processed} / ${job.total}</progress>${failureDetails}`;
    resultSummary.hidden = false;
    setStatus(`${job.successful} saved · ${job.failed.length} failed · ${job.total - job.processed} remaining`);
    return;
  }

  resultSummary.innerHTML = `<strong>${job.status === 'completed' ? `Researched ${job.successful} of ${job.total} companies.` : escapeHtml(job.error || 'No companies could be researched.')}</strong>${failureDetails}`;
  resultSummary.hidden = false;
  setStatus(
    job.failed.length
      ? `${job.successful} saved · ${job.failed.length} could not be reached.`
      : job.status === 'completed' ? 'All research saved to your private brief.' : 'Research could not be completed.',
    job.status === 'completed' ? (job.failed.length ? 'error' : 'success') : 'error',
  );
}

function setBatchBusy(busy) {
  pollingBatch = busy;
  researchButton.disabled = busy;
  singleMode.disabled = busy;
  batchMode.disabled = busy;
  if (busy) {
    researchButton.querySelector('span:first-child').textContent = 'Researching…';
    return;
  }
  researchButton.querySelector('span:first-child').textContent = researchMode === 'batch' ? 'Research companies' : 'Research company';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function followBatchJob(jobId) {
  setBatchBusy(true);
  let consecutiveErrors = 0;
  try {
    while (true) {
      let response;
      try {
        response = await fetch(`/api/research/batch/${encodeURIComponent(jobId)}`);
      } catch (error) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) throw new Error('Lost connection to research progress. Refresh the page to resume this batch.');
        setStatus('Reconnecting to research progress…');
        await delay(1_000);
        continue;
      }

      const payload = await response.json();
      if (!response.ok) {
        sessionStorage.removeItem(singleJobKey);
        throw new Error(payload.error || 'Could not retrieve batch research progress.');
      }
      consecutiveErrors = 0;
      const job = payload.job;
      updateBatchProgress(job);
      if (job.status !== 'running') {
        sessionStorage.removeItem(singleJobKey);
        await loadCompanies();
        return;
      }
      await delay(1_000);
    }
  } finally {
    setBatchBusy(false);
  }
}

async function resumeSavedBatch() {
  const jobId = sessionStorage.getItem(singleJobKey);
  if (!jobId || pollingBatch) return;

  setResearchMode('batch');
  resultSummary.hidden = false;
  resultSummary.innerHTML = '<strong>Reconnecting to your research batch…</strong>';
  setStatus('Checking saved research progress');
  try {
    await followBatchJob(jobId);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function setResearchMode(mode) {
  researchMode = mode;
  const isBatch = mode === 'batch';
  singleInput.hidden = isBatch;
  batchInput.hidden = !isBatch;
  singleMode.classList.toggle('active', !isBatch);
  batchMode.classList.toggle('active', isBatch);
  singleMode.setAttribute('aria-pressed', String(!isBatch));
  batchMode.setAttribute('aria-pressed', String(isBatch));
  document.querySelector('#research-title').textContent = isBatch ? 'Compare your target companies' : 'Find your next opportunity';
  document.querySelector('#research-button span:first-child').textContent = isBatch ? 'Research companies' : 'Research company';
  document.querySelector('#submit-hint').textContent = isBatch ? 'We’ll highlight the five strongest profile matches.' : 'Add one company to your radar.';
  document.querySelector('#company-url').required = !isBatch;
  document.querySelector('#company-urls').required = isBatch;
  resultSummary.hidden = true;
}

singleMode.addEventListener('click', () => setResearchMode('single'));
batchMode.addEventListener('click', () => setResearchMode('batch'));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#research-button');
  const url = document.querySelector('#company-url').value.trim();
  const urls = document.querySelector('#company-urls').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const context = document.querySelector('#ideal-customer').value.trim();
  if (researchMode === 'batch') {
    if (urls.length === 0) {
      setStatus('Add at least one company website.', 'error');
      return;
    }
    if (urls.length > 20) {
      setStatus('A research batch can contain at most 20 websites.', 'error');
      return;
    }
  }

  resultSummary.hidden = true;
  button.disabled = true;
  button.querySelector('span:first-child').textContent = researchMode === 'batch' ? `Starting ${urls.length} sites…` : 'Researching…';
  setStatus(researchMode === 'batch' ? `Researching ${urls.length} websites. This may take a minute.` : 'Reading the public company website');

  try {
    const response = await fetch(researchMode === 'batch' ? '/api/research/batch' : '/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(researchMode === 'batch' ? { urls, context } : { url, context }),
    });
    const payload = await response.json();
    if (researchMode === 'batch') {
      if (response.status !== 202) throw new Error(payload.error || 'Could not start batch research.');
      const jobId = payload.job.id;
      sessionStorage.setItem(singleJobKey, jobId);
      updateBatchProgress(payload.job);
      await followBatchJob(jobId);
      return;
    }

    if (!response.ok) throw new Error(payload.error || 'Company research failed.');
    document.querySelector('#company-url').value = '';
    companies = [payload.company, ...companies.filter((company) => company.id !== payload.company.id)];
    companies.sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
    render();
    setStatus('Research saved to your private brief.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    if (!pollingBatch) {
      button.disabled = false;
      button.querySelector('span:first-child').textContent = researchMode === 'batch' ? 'Research companies' : 'Research company';
    }
  }
});

list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="open"]');
  if (!button) return;
  const row = button.closest('[data-company-id]');
  const company = companies.find((entry) => entry.id === row.dataset.companyId);
  if (company) openDetails(company);
});

function openDetails(company) {
  const snapshot = company.snapshots?.at(-1);
  const score = company.score || { total: 0, breakdown: {}, reasons: [] };
  const sourceLinks = snapshot?.usefulLinks || [];
  const signalHistory = (company.signals || []).slice(0, 5);
  const outreach = company.outreach || {};
  const contactNote = company.persona || {};
  dialogContent.innerHTML = `<div class="dialog-head">
    <span class="company-monogram">${escapeHtml((company.name || '?').slice(0, 1).toUpperCase())}</span>
    <div class="dialog-title"><h2 id="detail-name">${escapeHtml(company.name)}</h2><a href="${escapeHtml(company.websiteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(hostLabel(company.websiteUrl))} ↗</a></div>
    <button class="dialog-close" type="button" aria-label="Close details">×</button>
  </div>
  <div class="detail-score"><strong>${score.total}<span style="font:400 10px 'DM Sans',sans-serif">/100</span></strong><div><span>${escapeHtml(priority(company))} · early heuristic</span><p>Fit ${score.breakdown?.fit ?? '—'} · Timing ${score.breakdown?.timing ?? '—'}</p></div></div>
  <section class="detail-section"><h3>COMPANY BRIEF · PUBLIC WEBSITE</h3><p>${escapeHtml(company.summary || company.description || 'The website provided limited descriptive information.')}</p></section>
  <section class="detail-section"><h3>WHY IT SCORED THIS WAY</h3><ul>${(score.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></section>
  <section class="detail-section"><h3>WHO TO APPROACH FIRST</h3><p><strong>${escapeHtml(contactNote.title || 'Relevant functional leader')}</strong> — ${escapeHtml(contactNote.rationale || 'Add your ideal customer profile to identify a relevant persona.')}</p></section>
  ${sourceLinks.length ? `<section class="detail-section"><h3>PUBLIC PAGES TO VERIFY</h3>${sourceLinks.map((link) => `<a class="fact-link" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.text || hostLabel(link.href))} ↗</a>`).join('')}</section>` : ''}
  <section class="detail-section"><h3>FIRST APPROACH · DRAFT</h3>${outreach.subject ? `<p style="margin-bottom:6px"><strong>Subject:</strong> ${escapeHtml(outreach.subject)}</p>` : ''}<div class="outreach-box" id="outreach-body">${escapeHtml(outreach.body || 'Research this company to draft an opening approach.')}</div><div class="outreach-actions"><button class="copy-button" type="button" data-action="copy">Copy draft</button></div></section>
  ${signalHistory.length ? `<section class="detail-section"><h3>CHANGES TO REVIEW</h3>${signalHistory.map((signal) => `<div class="history-item"><strong>${escapeHtml(signal.type.replaceAll('_', ' '))} · ${escapeHtml(dateLabel(signal.detectedAt))}</strong><span>${escapeHtml(signal.summary)} ${escapeHtml(signal.whyItMatters || '')}</span></div>`).join('')}</section>` : ''}
  <section class="detail-section"><h3>RESEARCH TRANSPARENCY</h3><p>${company.analysisMode === 'anthropic' ? 'The brief and first-contact draft are AI-assisted and grounded in the captured webpage text. The priority score remains a transparent keyword heuristic, not buying-intent evidence.' : 'Priority, brief and outreach are generated with transparent rules from this public webpage, not an AI-verified company profile.'} Website capture: ${escapeHtml(dateLabel(snapshot?.capturedAt))}. Confirm any claim with the linked company pages before acting.</p></section>
  <button class="delete-company" type="button" data-action="delete">Remove from my radar</button>`;

  dialogContent.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialogContent.querySelector('[data-action="copy"]').addEventListener('click', async (event) => {
    await navigator.clipboard.writeText(outreach.body || '');
    event.currentTarget.textContent = 'Copied';
  });
  dialogContent.querySelector('[data-action="delete"]').addEventListener('click', () => removeCompany(company));
  dialog.showModal();
}

async function removeCompany(company) {
  if (!window.confirm(`Remove ${company.name} and its research history from this workspace?`)) return;
  try {
    const response = await fetch(`/api/companies/${encodeURIComponent(company.id)}`, { method: 'DELETE' });
    const payload = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not remove this company.');
    companies = companies.filter((entry) => entry.id !== company.id);
    dialog.close();
    render();
  } catch (error) {
    window.alert(error.message);
  }
}

document.querySelector('#refresh-button').addEventListener('click', loadCompanies);
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
document.querySelector('#today-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());

loadCompanies();
resumeSavedBatch();
