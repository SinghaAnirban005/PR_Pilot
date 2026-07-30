<div align="center">

<img width="1024" height="1024" alt="bunny" src="https://github.com/user-attachments/assets/0c224c36-99e5-4eed-a79b-48d6734694be" />

# CommitBear

**A senior engineer that never sleeps, never rate limits your team, and reviews every PR in seconds.**

[![Build](https://img.shields.io/badge/build-passing-2ea44f)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](#)
[![License](https://img.shields.io/badge/license-MIT-black)](#license)
[![Made with LangGraph](https://img.shields.io/badge/agent-LangGraph-1c1c1c)](#)

[Getting Started](#getting-started) · [How It Works](#how-it-works) · [Architecture](#architecture) · [Roadmap](#roadmap)

</div>

<br />

## The problem

Code review doesn't scale with team size. Senior engineers spend hours a week reading diffs instead of shipping. Junior PRs sit for a day waiting on a reviewer. Context that lives in one person's head such as *"we tried that pattern in `auth/`, it broke prod"*  never makes it into the review at all.

## What CommitBear does

CommitBear installs on a repo like any other GitHub App. From then on, **every pull request gets reviewed automatically**  not by a stateless LLM glancing at a diff but by an agent that retrieves the actually relevant parts of your codebase first, reasons over the change with that context, validates its own output against a strict schema, and posts inline comments and a risk summary straight to the PR. If it can't produce a trustworthy review, it says so instead of guessing.

No dashboards to check. No copy pasting diffs into a chat window. It just shows up in your PRs.

<br />

## How it works

1. **You install the app** on a repo. CommitBear clones it once, chunks the source with AST aware parsing, embeds every chunk, and stores it in a vector index.
2. **Someone opens a PR.** A webhook fires, CommitBear pulls the diff, and extracts the symbols that actually changed.
3. **It retrieves relevant context** — not the whole repo, just the functions and modules the diff touches or depends on.
4. **An LLM reasons over [diff + context]** and produces a structured review: a risk rating, an approval recommendation, and inline comments.
5. **The output is validated against a strict schema.** If it's malformed, CommitBear retries with the validation errors fed back in  up to 3 times before falling back gracefully instead of posting garbage.
6. **The review is posted to GitHub** as inline comments plus a summary, the same way a human reviewer would leave one.
7. **Every merge keeps the index fresh.** Pushes to the default branch trigger an incremental re sync of just the changed files, so CommitBear's understanding of your codebase never goes stale.

<br />

## Architecture

```mermaid
flowchart TD
    U["👤 Developer"] -->|opens / updates PR| GH["GitHub"]
    GH -->|webhook| SRV["Webhook Gateway<br/>(Express)"]

    SRV -->|drop non-code diffs| FILTER{"Guardrail<br/>filter"}
    FILTER -->|dispatch event| Q["Inngest<br/>(durable job queue)"]

    subgraph AGENT["LangGraph Agent Workflow"]
        direction TB
        A["Extract Diff Node<br/>parse changed symbols"] --> B["Vector Retrieval Node<br/>fetch relevant context"]
        B --> C["LLM Reasoning Node<br/>Groq · Llama 3.3 70B"]
        C --> D{"Output Validation<br/>Node — Zod schema"}
        D -->|invalid, retries left| C
        D -->|invalid, retries exhausted| F["Fallback Node<br/>post error notice"]
        D -->|valid| P["Post Review Node<br/>inline comments + summary"]
    end

    Q --> A
    B <-->|cosine similarity search| VDB[("pgvector<br/>code_chunks")]
    P -->|Octokit REST| GH
    F -->|Octokit REST| GH
    GH -->|review appears on PR| U

    subgraph INGEST["Repo Onboarding & Sync"]
        direction TB
        I1["App installed"] --> I2["Full clone + AST chunk<br/>+ batch embed"]
        I3["Push to default branch<br/>(incl. PR merges)"] --> I4["Incremental re-embed<br/>of changed files only"]
    end

    GH -.->|install / push events| INGEST
    I2 -->|upsert| VDB
    I4 -->|upsert| VDB
    EMB["Hugging Face<br/>BAAI/bge-m3"] -.embeds.-> I2
    EMB -.embeds.-> I4
    EMB -.embeds.-> B

    style AGENT fill:#0a0a0a,stroke:#333,color:#fff
    style INGEST fill:#0a0a0a,stroke:#333,color:#fff
    style VDB fill:#1c1c1c,stroke:#555,color:#fff
    style Q fill:#1c1c1c,stroke:#555,color:#fff
```

<br />


## Tech stack

- **Runtime** — Node.js 24, TypeScript (strict, ESM)
- **Webhook Gateway** — Express + `@octokit/webhooks`
- **Job Orchestration** — Inngest
- **Agent Orchestration** — LangGraph.js (`@langchain/langgraph`)
- **Vector Store** — PostgreSQL + `pgvector` (HNSW index)
- **Embeddings** — Hugging Face Inference API
- **Code Parsing** — `@ast-grep/napi`
- **LLM** — Groq
- **Validation** — Zod
- **GitHub Integration** — Octokit (REST + App auth)

<br />

## Getting Started

```bash
npm install
cp .env.example .env      # fill in DB / GitHub App / HF / Groq credentials
npm run migrate            # sets up pgvector schema
npm run build && npm start
```

Then create a GitHub App, subscribe it to **Pull request**, **Installation**, **Installation repositories**, and **Push** events, and install it on a repo. See [`SETUP.md`](./SETUP.md) for the full walkthrough — from creating the app to your first automated review.

<br />

## License

MIT — see [`LICENSE`](./LICENSE).

<br />

<div align="center">
<sub>Built for teams who'd rather ship than wait for review.</sub>
</div>
