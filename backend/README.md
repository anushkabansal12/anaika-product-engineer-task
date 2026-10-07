# Company Brief

Company Brief is an early-stage company research and prioritization dashboard. Add a public company website and, optionally, describe your ideal customer or offer. The app captures the page's public title, description, headings, and useful links; gives a transparent, rules-based priority score; suggests a functional buyer persona; and drafts an editable first approach.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:4000`. Set `PORT` to use a different port. Company research is stored in `backend/data/companies.json` by default; set `DATA_FILE` to change the local data-file location. PostgreSQL and Redis are not required.

If `ANTHROPIC_API_KEY` is configured, Claude generates the concise brief, persona rationale, and outreach draft from the captured public page. Set `ANTHROPIC_MODEL` to override the default model. Without a configured key, these fields use clearly labeled local rules. An AI request or response failure is shown as an error; it is not silently presented as a successful AI analysis.

## What the score means

The 0–100 priority score combines profile keyword overlap (70%) and website language that may indicate near-term activity (30%). Without a profile, fit is neutral. It is a prioritization heuristic—not an AI-verified company assessment, evidence of buying intent, or substitute for checking the linked public pages.

Re-researching a company stores a new snapshot. Changed page copy is recorded separately, and event-like words are marked as leads to verify; generic page edits are marked as noise. A keyword match does not establish that an event happened.

## API

- `GET /api/health` — liveness check
- `GET /api/companies` — companies ordered by score
- `GET /api/companies/:id` — one company and its research history
- `POST /api/research` — research `{ "url": "example.com", "context": "B2B SaaS teams" }`
- `POST /api/research/batch` — start research for 1–20 websites `{ "urls": ["example.com", "another.example"], "context": "B2B SaaS teams" }`; responds with `202` and a job ID.
- `GET /api/research/batch/:id` — poll job progress and per-site failures; at most three sites are fetched concurrently and each success is saved immediately.
- `DELETE /api/companies/:id` — remove a company and its local history

Website fetching accepts public HTTP(S) pages only, limits response size and redirects, and does not follow redirects to private network addresses.

## Current boundaries

The first slice intentionally identifies a buyer persona rather than claiming to discover a named contact. Analysis and outreach should be reviewed before use. Batch jobs run in the app process and progress is held in memory; successful company research is stored as it completes, while an in-progress job cannot survive a server restart. The Prisma schema in `prisma/schema.prisma` is retained for a later database-backed iteration; this version uses a local JSON store so it runs without database setup.
