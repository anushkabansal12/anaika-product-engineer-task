const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { z } = require('zod');

const MAX_PAGE_BYTES = 2_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normalizeWebsiteUrl(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('Enter a company website URL.');
  }

  const trimmedInput = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedInput) && !/^https?:\/\//i.test(trimmedInput)) {
    throw new Error('Only HTTP and HTTPS websites can be researched.');
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(trimmedInput) ? trimmedInput : `https://${trimmedInput}`);
  } catch {
    throw new Error('Enter a valid website URL, such as example.com.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS websites can be researched.');
  }
  if (url.username || url.password) {
    throw new Error('Website URLs cannot include credentials.');
  }
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new Error('Enter a publicly accessible company website.');
  }
  if (net.isIP(url.hostname) && !isPublicIpv4(url.hostname)) {
    throw new Error('Private or reserved network addresses cannot be researched.');
  }

  return url;
}

function isPublicIpv4(address) {
  if (net.isIP(address) !== 4) return false;
  const value = address.split('.').map(Number).reduce((result, octet) => result * 256 + octet, 0);
  const isInRange = (network, prefix) => {
    const networkValue = network.split('.').map(Number).reduce((result, octet) => result * 256 + octet, 0);
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (networkValue & mask);
  };

  const reservedRanges = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  return value > 0 && !reservedRanges.some(([network, prefix]) => isInRange(network, prefix));
}

async function resolvePublicIpv4(hostname) {
  if (net.isIP(hostname)) {
    if (!isPublicIpv4(hostname)) {
      throw new Error('Private or reserved network addresses cannot be researched.');
    }
    return hostname;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, family: 4 });
  } catch (error) {
    throw new Error(`Could not resolve the website host: ${error.message}`);
  }

  const publicAddress = addresses.find(({ address }) => isPublicIpv4(address));
  if (!publicAddress) {
    throw new Error('The website host did not resolve to a public IPv4 address.');
  }
  return publicAddress.address;
}

async function getPage(initialUrl) {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const address = await resolvePublicIpv4(url.hostname);
    const response = await axios.get(url.href, {
      responseType: 'text',
      timeout: 12_000,
      maxContentLength: MAX_PAGE_BYTES,
      maxBodyLength: MAX_PAGE_BYTES,
      maxRedirects: 0,
      validateStatus: (status) => status < 400 || REDIRECT_STATUSES.has(status),
      headers: {
        'User-Agent': 'CompanyBrief/1.0 (+public website research)',
        Accept: 'text/html,application/xhtml+xml',
      },
      ...(url.protocol === 'https:'
        ? { httpsAgent: new https.Agent({ lookup: pinnedLookup(address) }) }
        : { httpAgent: new http.Agent({ lookup: pinnedLookup(address) }) }),
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new Error('The website did not return an HTML page that can be researched.');
      }
      return { html: response.data, url };
    }

    const location = response.headers.location;
    if (!location || redirects === 3) {
      throw new Error('The website redirected too many times to research safely.');
    }
    url = normalizeWebsiteUrl(new URL(location, url).href);
  }

  throw new Error('Unable to retrieve the company website.');
}

function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    const result = { address, family: 4 };
    if (options && options.all) return callback(null, [result]);
    callback(null, result.address, result.family);
  };
}

function extractWebsiteFacts(html, pageUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, nav, footer').remove();

  const title = cleanText($('title').first().text()) || cleanText($('h1').first().text());
  const description = cleanText(
    $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="twitter:description"]').attr('content'),
  );
  const headings = $('h1, h2, h3')
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean)
    .slice(0, 12);
  const pageText = cleanText($('body').text()).slice(0, 20_000);
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, '');
  const name = cleanText(
    $('meta[property="og:site_name"]').attr('content') ||
      $('meta[name="application-name"]').attr('content') ||
      title.split(/[|–—-]/)[0],
  );
  const links = $('a[href]')
    .map((_, element) => {
      const href = $(element).attr('href');
      try {
        const target = new URL(href, pageUrl);
        return target.protocol.startsWith('http') ? { href: target.href, text: cleanText($(element).text()) } : null;
      } catch {
        return null;
      }
    })
    .get()
    .filter(Boolean);
  const usefulLinks = links.filter(({ href, text }) => /about|team|career|jobs|pricing|product|contact/i.test(`${href} ${text}`)).slice(0, 10);

  return {
    name: name || pageHost,
    title,
    description,
    headings,
    pageText,
    usefulLinks,
    sourceUrl: pageUrl,
    domain: pageHost,
  };
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function scoreCompany(facts, context = '') {
  const content = `${facts.title} ${facts.description} ${facts.headings.join(' ')} ${facts.pageText}`.toLowerCase();
  const keywords = [...new Set(
    context.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) || [],
  )].filter((word) => !['the', 'and', 'for', 'with', 'that', 'from', 'you', 'your', 'our', 'are', 'who', 'what'].includes(word));
  const matchedKeywords = keywords.filter((word) => content.includes(word));
  const fit = keywords.length === 0 ? 50 : Math.min(100, Math.round((matchedKeywords.length / Math.min(keywords.length, 8)) * 100));
  const timingMatch = /\b(hiring|careers|raised|series [a-f]|launch(?:ed|ing)?|introducing|now available|expanding)\b/i.test(content);
  const timing = timingMatch ? 75 : 35;
  const total = Math.round(fit * 0.7 + timing * 0.3);
  const reasons = [
    keywords.length
      ? `${matchedKeywords.length} of ${keywords.length} distinct profile terms appeared on the company page.`
      : 'No ideal-customer profile was provided; fit is neutral until you add context.',
    timingMatch
      ? 'The page contains language that may indicate a timely company activity; verify it before acting.'
      : 'No clear timing signal was found in the captured page text.',
  ];

  return {
    total,
    breakdown: { fit, timing },
    reasons,
  };
}

function createAnalysis(facts, context = '') {
  const score = scoreCompany(facts, context);
  const sourceText = `${facts.description} ${facts.headings.join(' ')}`.trim();
  const summary = sourceText
    ? `${facts.name}: ${sourceText.slice(0, 300)}${sourceText.length > 300 ? '…' : ''}`
    : `${facts.name} is a company at ${facts.domain}. The website provided limited descriptive information.`;
  const persona = {
    title: 'Relevant functional leader',
    rationale: context
      ? `Start with the leader responsible for ${context.slice(0, 160)}; confirm the right owner on a public professional source before outreach.`
      : 'Add your ideal customer profile to identify the most relevant buying role. Confirm a named contact through a public professional source before outreach.',
  };
  const subject = `A thought for ${facts.name}`;
  const body = `Hi,\n\nI came across ${facts.name}${facts.description ? ` and noticed ${facts.description.slice(0, 180)}` : ` while researching ${facts.domain}`}.\n\n${context ? `I work with teams focused on ${context.slice(0, 180)}. ` : ''}Would it be useful to compare notes on whether this is relevant to your team?\n\nBest,\n`;

  return { summary, score, persona, outreach: { subject, body }, analysisMode: 'rules' };
}

const aiAnalysisSchema = z.object({
  summary: z.string().min(1).max(600),
  industry: z.string().max(120).nullable(),
  personaTitle: z.string().min(1).max(120),
  personaRationale: z.string().min(1).max(500),
  outreachSubject: z.string().min(1).max(160),
  outreachBody: z.string().min(1).max(1_200),
});

async function analyzeWithAI(facts, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || /^your[-_]/i.test(apiKey.trim())) return null;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey, timeout: 30_000 });
    const message = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: [
        'You create a concise business-development brief from a company website capture.',
        'Use only the supplied website text and user context. Do not invent company facts, events, metrics, or named contacts.',
        'If evidence is sparse, say so. Suggest a job-function persona, never a guessed person.',
        'Write a short, respectful first-contact draft grounded in the supplied evidence; do not claim a prior relationship.',
        'Return only one JSON object with exactly these keys: summary, industry, personaTitle, personaRationale, outreachSubject, outreachBody.',
        'industry must be a short string or null.',
      ].join(' '),
      messages: [{
        role: 'user',
        content: JSON.stringify({
          company: facts.name,
          website: facts.sourceUrl,
          title: facts.title,
          metaDescription: facts.description,
          headings: facts.headings,
          visiblePageText: facts.pageText.slice(0, 6_000),
          userContext: context,
        }),
      }],
    });

    const text = message.content.find((block) => block.type === 'text')?.text;
    if (!text) throw new Error('The AI provider returned an empty analysis.');
    const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let decoded;
    try {
      decoded = JSON.parse(json);
    } catch (error) {
      throw new Error('The AI provider returned an invalid structured analysis.', { cause: error });
    }
    const parsed = aiAnalysisSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error('The AI provider returned an analysis with an unexpected shape.');
    }
    return parsed.data;
  } catch (error) {
    error.publicMessage = 'AI analysis failed. Check the Anthropic API key and model configuration, then retry.';
    throw error;
  }
}

async function researchWebsite(inputUrl, context = '') {
  const initialUrl = normalizeWebsiteUrl(inputUrl);
  const { html, url } = await getPage(initialUrl);
  const facts = extractWebsiteFacts(html, url.href);
  const analysis = createAnalysis(facts, context);
  const aiAnalysis = await analyzeWithAI(facts, context);
  if (aiAnalysis) {
    analysis.summary = aiAnalysis.summary;
    analysis.industry = aiAnalysis.industry;
    analysis.persona = { title: aiAnalysis.personaTitle, rationale: aiAnalysis.personaRationale };
    analysis.outreach = { subject: aiAnalysis.outreachSubject, body: aiAnalysis.outreachBody };
    analysis.analysisMode = 'anthropic';
  }

  return {
    domain: facts.domain,
    websiteUrl: url.origin,
    name: facts.name,
    description: facts.description,
    summary: analysis.summary,
    industry: analysis.industry || null,
    score: analysis.score,
    persona: analysis.persona,
    outreach: analysis.outreach,
    analysisMode: analysis.analysisMode,
    snapshot: {
      title: facts.title,
      description: facts.description,
      headings: facts.headings,
      sourceUrl: facts.sourceUrl,
      usefulLinks: facts.usefulLinks,
      capturedText: facts.pageText.slice(0, 4_000),
      score: analysis.score,
    },
  };
}

module.exports = {
  createAnalysis,
  extractWebsiteFacts,
  normalizeWebsiteUrl,
  researchWebsite,
  scoreCompany,
  analyzeWithAI,
};
