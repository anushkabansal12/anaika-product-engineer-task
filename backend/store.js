const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class CompanyStore {
  constructor(filePath = process.env.DATA_FILE || path.join(__dirname, 'data', 'companies.json')) {
    this.filePath = filePath;
    this.companies = [];
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const contents = await fs.readFile(this.filePath, 'utf8');
      this.companies = JSON.parse(contents);
      if (!Array.isArray(this.companies)) {
        throw new Error('The company data file must contain a JSON array.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Unable to load company data: ${error.message}`, { cause: error });
      }
      await this.persist();
    }
  }

  async list() {
    await this.writeQueue;
    return structuredClone(this.companies);
  }

  async get(id) {
    await this.writeQueue;
    const company = this.companies.find((entry) => entry.id === id);
    return company ? structuredClone(company) : null;
  }

  async saveResearch(research) {
    const operation = this.writeQueue.then(async () => {
      const now = new Date().toISOString();
      let company = this.companies.find((entry) => entry.domain === research.domain);

      if (!company) {
        company = {
          id: randomUUID(),
          domain: research.domain,
          createdAt: now,
          snapshots: [],
          signals: [],
        };
        this.companies.unshift(company);
      }

      const previous = company.snapshots.at(-1);
      const snapshot = {
        id: randomUUID(),
        capturedAt: now,
        ...research.snapshot,
      };
      const changes = detectChanges(previous, snapshot);
      snapshot.changes = changes;

      Object.assign(company, {
        name: research.name,
        websiteUrl: research.websiteUrl,
        description: research.description,
        summary: research.summary,
        industry: research.industry,
        score: research.score,
        persona: research.persona,
        outreach: research.outreach,
        analysisMode: research.analysisMode,
        updatedAt: now,
      });
      company.snapshots.push(snapshot);
      company.snapshots = company.snapshots.slice(-20);
      company.signals = [
        ...changes.map((change) => ({ ...change, detectedAt: now, snapshotId: snapshot.id })),
        ...company.signals,
      ].slice(0, 50);

      await this.persist();
      return structuredClone(company);
    });

    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async remove(id) {
    const operation = this.writeQueue.then(async () => {
      const index = this.companies.findIndex((company) => company.id === id);
      if (index === -1) return false;

      this.companies.splice(index, 1);
      await this.persist();
      return true;
    });

    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(this.companies, null, 2), 'utf8');
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw new Error(`Unable to save company data: ${error.message}`, { cause: error });
    }
  }
}

function detectChanges(previous, current) {
  if (!previous) return [];

  const changedFields = ['title', 'description', 'headings'].filter(
    (field) => JSON.stringify(previous[field]) !== JSON.stringify(current[field]),
  );
  if (changedFields.length === 0) return [];

  const currentText = [current.title, current.description, ...current.headings].join(' ');
  const signals = [];
  const patterns = [
    { type: 'HIRING', pattern: /\b(hiring|careers|join our team|open roles|open positions)\b/i },
    { type: 'FUNDING', pattern: /\b(raised|series [a-f]|funding round|venture-backed)\b/i },
    { type: 'PRODUCT_LAUNCH', pattern: /\b(launch(?:ed|ing)?|introducing|now available|new product)\b/i },
    { type: 'PRICING_CHANGE', pattern: /\b(pricing|plans and pricing|new plan|price increase)\b/i },
  ];

  for (const { type, pattern } of patterns) {
    if (pattern.test(currentText)) {
      signals.push({
        type,
        materiality: 'SIGNAL',
        summary: `The company website changed and currently mentions ${type.toLowerCase().replace('_', ' ')}-related language.`,
        whyItMatters: `This is a lead to verify, not confirmation of a ${type.toLowerCase().replace('_', ' ')} event.`,
      });
    }
  }

  if (signals.length === 0) {
    signals.push({
      type: 'WEBSITE_COPY',
      materiality: 'NOISE',
      summary: `Website content changed in ${changedFields.join(', ')}.`,
      whyItMatters: 'No clear business event was identified from the changed page text.',
    });
  }

  return signals;
}

module.exports = { CompanyStore, detectChanges };
