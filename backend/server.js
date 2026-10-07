require('dotenv').config();

const express = require('express');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { z } = require('zod');
const { researchWebsite } = require('./research');
const { CompanyStore } = require('./store');

const researchRequest = z.object({
  url: z.string().trim().min(1).max(2_048),
  context: z.string().trim().max(1_000).optional().default(''),
});
const batchResearchRequest = z.object({
  urls: z.array(z.string().trim().min(1).max(2_048)).min(1).max(20),
  context: z.string().trim().max(1_000).optional().default(''),
});

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function publicResearchError(error) {
  if (error.publicMessage) return error.publicMessage;
  if (/^(Enter |Only |Private |The website host|Could not resolve|The website did not|The website redirected|Unable to retrieve)/.test(error.message)) {
    return error.message;
  }
  return 'Could not research this website. Check that it is publicly accessible and try again.';
}

function createApp({ store, research = researchWebsite, batchConcurrency = 3 } = {}) {
  const app = express();
  const companyStore = store || new CompanyStore();
  const jobs = new Map();
  let activeBatchJobId = null;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '48kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/companies', async (_request, response, next) => {
    try {
      const companies = await companyStore.list();
      companies.sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0));
      response.json({ companies });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/companies/:id', async (request, response, next) => {
    try {
      const company = await companyStore.get(request.params.id);
      if (!company) return response.status(404).json({ error: 'Company not found.' });
      response.json({ company });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/research', async (request, response, next) => {
    const parsed = researchRequest.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid research request.' });
    }

    try {
      const result = await research(parsed.data.url, parsed.data.context);
      const company = await companyStore.saveResearch(result);
      response.status(201).json({ company });
    } catch (error) {
      if (!error.publicMessage && publicResearchError(error) !== 'Could not research this website. Check that it is publicly accessible and try again.') {
        return response.status(422).json({ error: publicResearchError(error) });
      }
      next(error);
    }
  });

  app.post('/api/research/batch', async (request, response) => {
    const parsed = batchResearchRequest.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: parsed.error.issues[0]?.message || 'Enter between 1 and 20 company websites.' });
    }

    for (const [id, job] of jobs) {
      if (job.status !== 'running' && Date.now() - job.updatedAt > 60 * 60 * 1_000) jobs.delete(id);
    }
    if (activeBatchJobId) {
      return response.status(409).json({ error: 'Another company batch is already running. Wait for it to finish before starting another.' });
    }

    const job = {
      id: randomUUID(),
      status: 'running',
      total: parsed.data.urls.length,
      processed: 0,
      successful: 0,
      failed: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    jobs.set(job.id, job);
    activeBatchJobId = job.id;

    void mapWithConcurrency(parsed.data.urls, batchConcurrency, async (url) => {
      try {
        const result = await research(url, parsed.data.context);
        await companyStore.saveResearch(result);
        job.successful += 1;
      } catch (error) {
        job.failed.push({ url, error: publicResearchError(error) });
      } finally {
        job.processed += 1;
        job.updatedAt = Date.now();
      }
    }).then(() => {
      job.status = job.successful > 0 ? 'completed' : 'failed';
      job.updatedAt = Date.now();
      job.completedAt = job.updatedAt;
      activeBatchJobId = null;
    }).catch((error) => {
      console.error(`Batch research job ${job.id} failed:`, error);
      job.status = 'failed';
      job.error = 'Batch research could not be completed. Check the server logs for details.';
      job.updatedAt = Date.now();
      job.completedAt = job.updatedAt;
      activeBatchJobId = null;
    });

    response.status(202).json({ job: publicJob(job) });
  });

  app.get('/api/research/batch/:id', (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) return response.status(404).json({ error: 'Research job not found or expired.' });
    response.json({ job: publicJob(job) });
  });

  app.delete('/api/companies/:id', async (request, response, next) => {
    try {
      const removed = await companyStore.remove(request.params.id);
      if (!removed) return response.status(404).json({ error: 'Company not found.' });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    console.error(error);
    if (response.headersSent) return;
    if (error instanceof SyntaxError && 'body' in error) {
      return response.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'Request body is too large.' });
    }
    response.status(500).json({
      error: error.publicMessage || 'The request could not be completed. Check the server logs for details.',
    });
  });

  app.locals.companyStore = companyStore;
  return app;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    successful: job.successful,
    failed: job.failed,
    error: job.error,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
  };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 4000);
  app.locals.companyStore.init()
    .then(() => {
      app.listen(port, () => console.log(`Company Brief is running at http://localhost:${port}`));
    })
    .catch((error) => {
      console.error('Unable to start Company Brief:', error);
      process.exitCode = 1;
    });
}

module.exports = { createApp, publicJob };
