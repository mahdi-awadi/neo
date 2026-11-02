# Knowledge retrieval & indexing infrastructure for a self-hosted multi-project coding-agent engine

Research date: 2026-11-02. Scope: retrieval strategies that give SDK workers fast, accurate knowledge of many codebases and their history without relying on the model's memory. The operator already runs a vector DB, Meilisearch, and a "codebase-memory" MCP graph that workers must query first.

Access note for the report writer: in this session `arxiv.org`, `cursor.com`, `huggingface.co`, `jxnl.co`, `meilisearch.com`, `qodo.ai`, `trychroma.com` and `academy.dair.ai` were not fetchable (network allow-list). Numbers from those sources come from search-result snippets and secondary summaries and are marked as such; the Anthropic context-engineering post and the official Claude Code memory page were fetched in full.

---

## KQ1. What the evidence says: agentic grep/glob + reads vs embeddings RAG vs hybrid vs structural (2025-2026)

### Takeaway
The measured evidence is split by task type, not by "which is best": for *issue localization / repair* (SWE-bench-style), agentic exploration with grep/reads sits a clear tier above classical retrieval (BM25/TF-IDF/RAG near random on SWE-Explore; grep matches or beats embeddings once harness design is controlled), but *adding* semantic search to an agent that already greps gives a real, modest lift (Cursor: +12.5% internal benchmark, +0.3% retention in A/B), and for *repository QA* one controlled study found plain semantic search beat a planner+subagent "deep agentic search" (65.2% vs 46.2%). Structural graphs (RepoGraph, LocAgent) show large relative gains in papers (+32.8% SWE-bench success) but the ContextBench study found scaffolding sophistication yields only marginal retrieval gains and that the real bottleneck is *consolidation* (agents inspect the right code but fail to use it).

### Cited Findings
- Cursor's "Improving Agent with semantic search" (Nov 2025) reports semantic search raised agent accuracy on its internal benchmark by 12.5% on average across models (range 6.5%–23.5%), with the largest benefit in large repositories (>1,000 files); online A/B: +0.3% agent code retention with semantic search, and 2.2% more dissatisfied follow-ups when it was disabled; conclusion: grep + semantic search together is best — [Cursor blog (via search snippets)](https://cursor.com/blog/semsearch); [ZenML summary](https://www.zenml.io/llmops-database/enhancing-ai-coding-agent-performance-with-custom-semantic-search). Caveat: internal benchmark, pre-Composer-2, vendor-reported.
- Augment's Colin Flaherty (SWE-bench Verified agent): grep beat embeddings in their SWE-bench agent; agent+grep = excellent quality/reliability but struggles on speed, cost and scale; agent+embeddings "combines the best of both but remains slow and expensive"; SWE-bench repos are smaller than real codebases — [jxnl.co write-up of Augment talk](https://jxnl.co/writing/2025/09/11/why-grep-beat-embeddings-in-our-swe-bench-agent-lessons-from-augment/) (secondary, could not fetch).
- "Is Grep All You Need?" (reported as arXiv 2605.15184): when wrapped in a suitable agent harness, grep matches or exceeds embedding retrieval on coding-agent tasks; harness design accounts for most of the performance differential usually attributed to embeddings; grep works best when the codebase is structured for navigation, embeddings partially compensate for unstructured input — [DAIR summary](https://academy.dair.ai/papers/is-grep-all-you-need) (secondary; primary not reachable).
- SWE-Explore (arXiv 2606.07297, June 2026): 848 issues, 203 repos, 10 languages drawn from SWE-bench Verified/Pro/Multilingual; isolates exploration as a task (ranked code regions within a line budget). Finding: agentic explorers form "a clear tier above classical retrieval"; TF-IDF, BM25 and a RAG baseline score close to random at reaching ground-truth files; file-level localization is already strong, line-level coverage and efficient ranking differentiate; exploration metrics track downstream repair outcomes — [hyper.ai summary](https://hyper.ai/en/papers/2606.07297); [emergentmind](https://www.emergentmind.com/papers/2606.07297). Secondary summaries only.
- Deep Agentic Search for repo-level code QA (arXiv 2608.01507, Aug 2026, SWE-QA benchmark): vector "semantic search" answered 65.2% correctly vs 46.2% for a planner that delegates to an isolated-context subagent, at under half the cost per correct answer; 41.8% of deep-agentic failures occurred at the planner→subagent handoff and were usually silent — [arXiv listing](https://arxiv.org/pdf/2608.01507); [Codex CLI blog repeat](https://codex.danielvaughan.com/2026/08/13/deep-agentic-search-vs-semantic-search-repository-code-qa-codex-cli-subagent-delegation-context-rot/). Note this is *QA*, not repair, and it contradicts the direction of SWE-Explore — task type matters.
- ContextBench (arXiv 2602.05892, Feb 2026): 1,136 issue tasks, 66 repos, 8 languages with human-annotated gold contexts; 4 frontier LLMs × 5 agents. "Sophisticated agent scaffolding yields only marginal retrieval gains"; simple search-and-inspect stays competitive; agents often inspect gold-relevant code but fail to retain/use it in the patch — consolidation is the bottleneck. Caveat: gold contexts are patch-conditioned — [arXiv](https://arxiv.org/html/2602.05892v1); [benchmarklist note](https://benchmarklist.com/benchmarks/contextbench/).
- RepoGraph (ICLR 2025, arXiv 2410.14684): line-level nodes with def/ref edges, plugged into four SWE-bench methods → average relative success improvement of 32.8%; higher file/function/line recall for every framework (smallest gain at line level) — [arXiv](https://arxiv.org/abs/2410.14684); [ICLR slides](https://www.iclr.cc/media/iclr-2025/Slides/28957.pdf). Author-reported.
- LocAgent (ACL 2025, arXiv 2503.09089): heterogeneous graph (files/classes/functions; import/invoke edges) for multi-hop localization; a fine-tuned Qwen-2.5-Coder-32B reached results comparable to proprietary models at ~86% lower cost; introduces Loc-Bench — [arXiv](https://arxiv.org/pdf/2503.09089). (A "92.70% file localization" figure circulates but was not verified.)
- cAST (EMNLP 2025 Findings, CMU + Augment): AST-based chunking (greedy merge of AST nodes, recursive split of oversized nodes) gives +4.3 Recall@5 on RepoEval retrieval and +2.67 Pass@1 on SWE-bench generation vs line-based chunking — [arXiv](https://arxiv.org/html/2506.15655v2); [ACL Anthology](https://preview.aclanthology.org/dashboard/2025.findings-emnlp.430).
- Cline's position (vendor): deliberately no index; RAG "struggles with a constantly changing codebase" and needs a continuously maintained pipeline; embeddings create a second copy of code; it uses ripgrep + tree-sitter on demand. Critics note prompts still transit Cline servers; on large repos filesystem search can be slow — [Cline blog](https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing); [fast.io comparison (secondary, promotional)](https://fast.io/resources/augment-code-vs-cline-codebase-indexing/).
- Industry default: Claude Code, Codex CLI, OpenCode, Cursor, Continue and Aider all default to grep/ripgrep for agent search; Cursor adds semantic search on top — [yage.ai analysis](https://yage.ai/share/why-coding-agents-still-use-grep-en-20260327.html) (opinion/analysis).
- Anthropic's guidance: Claude Code loads CLAUDE.md up front then uses glob/grep "just in time"; metadata (folder location, naming, timestamps) is itself signal; recommended hybrid = retrieve some data up front for speed, explore autonomously when needed — [Anthropic, Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (fetched).
- Vendor claims to treat as hype until independently reproduced: Morph's "agents spend upward of 60% of first turn pulling context" and "no top SWE-bench Verified entries use vector retrieval" — [Morph blog](https://www.morphllm.com/blog/code-search-bottleneck.md); Sourcegraph CodeScaleBench "38% faster, 30% token savings" with Sourcegraph MCP (370 tasks, 40+ repos, 9 languages, same agent with/without) — [Sourcegraph agent effectiveness page](https://sourcegraph.com/solutions/agent-effectiveness); Augment's AugmentQA claims its embeddings beat open models that top CoIR, and a podcast claim of "33% fewer tokens than Claude Code on Terminal-Bench" — [AugmentQA post](https://www.augmentcode.com/blog/you-make-your-evals-then-your-evals-make-you-introducing-augmentqa).
- Counter-signal on RAG for review: Qodo says "We built a state-of-the-art RAG system for code review. In Qodo 2.4, we took most of it out," replacing a source-code search index with something "more like long-term memory over your PR history," claiming it leads their review benchmarks with "a fraction of the indexing infrastructure" — [Qodo blog](https://www.qodo.ai/?p=20694) (vendor; no figures published).

### Inferences
- For Neo's dispatch workers (issue→patch work in a known folder), the default should stay agentic grep/glob/read with the project's existing structure; a semantic index is an *additive* tool worth keeping, with the measured upside concentrated in large repos and natural-language-to-code questions ("where is the thing that handles X").
- The structural graph the operator already runs (codebase-memory MCP) is in the RepoGraph/LocAgent family; the papers' big relative gains come from weak baselines, and ContextBench suggests the marginal gain over a good grep agent on a frontier model is small. Keep it for call-tracing/impact queries, do not expect it to lift SWE-bench-style success dramatically.
- The 41.8% silent planner→subagent handoff failure in Deep Agentic Search is a design warning for Neo's fresh-context search subagents: the handoff contract (what the subagent must return, with file:line evidence) matters more than the retrieval technology.

### Gaps
- No public ablation isolates "grep-only vs grep+BM25 vs grep+vectors vs grep+graph" on one harness with one frontier model; Cursor's is the closest but internal.
- Could not read primary PDFs for SWE-Explore, "Is Grep All You Need", Deep Agentic Search or the Augment talk; exact tables unverified.

---

## KQ2. Repo maps and code indexes; keeping them fresh cheaply; per-repo vs cross-repo

### Takeaway
Three proven index families exist for self-hosting: tree-sitter symbol maps ranked by PageRank (Aider), positional-trigram lexical indexes (Zoekt, designed to be incremental and shard-per-repo), and precise semantic graphs (SCIP / Greptile-style call graphs / codebase-memory). Freshness is handled by content-hash change detection (Cursor's Merkle tree, chunk-hash embedding cache) rather than full re-index; per-repo shards with a federation layer are the standard way to isolate yet query across projects.

### Cited Findings
- Aider repo map: tree-sitter queries extract definition/reference tags for every file, a directed reference graph is built, and networkx PageRank ranks symbols; a personalization vector boosts files whose names/definitions match identifiers in the chat; the map is refreshed in the background only when files change; 26+/31 languages via tree-sitter-language-pack — [pyshine analysis](https://pyshine.com/aider/); [Rust port repo-mapper](https://docs.rs/crate/repo-mapper/latest/source/README.md); [RepoMapper](https://github.com/Cryect/RepoMapper). (Secondary descriptions of `aider/repomap.py`.)
- Zoekt design: positional trigram index; index construction "can easily be made incremental"; one shard file per repository, mmap-able; posting lists can live on SSD so search needs ~1.2× corpus size of RAM; Sourcegraph groups small repos into compound shards and trashes deleted repos for 24h before deletion — [Zoekt design doc](https://gerrit.googlesource.com/zoekt/+show/0314dee638e2b18be32ff3cc81efc2d4d4fc9f2f/doc/design.md); [DeepWiki glossary](https://deepwiki.com/sourcegraph/zoekt/7-glossary).
- Sourcegraph stack: Zoekt for search, SCIP for precise go-to-definition / find-references / cross-repo dependency resolution with incremental indexing; SCIP moving to open governance (Uber, Meta, Sourcegraph); Sourcegraph MCP exposes search, navigation, history and Deep Search to any MCP agent — [latent.space write-up](https://latent.space/reading/sourcegraph-normsky-coding-agents/); [Sourcegraph MCP](https://sourcegraph.com/mcp). An open-source MCP server (code-context-provider) wraps Sourcegraph or Zoekt backends with Langfuse evals — [GitHub](https://github.com/AndroidSourceTools/code-context-provider).
- Greptile: parses every file into directories/functions/classes/variables, maps calls/imports/variable usage into a graph, stores it for querying at review time; at review the changed function's dependencies and usages are checked; graph updated incrementally as code lands (third-party) — [Greptile docs](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context); [Greptile seed post](https://www.greptile.com/blog/seed).
- codebase-memory-mcp (DeusData): tree-sitter → persistent knowledge graph with sub-ms structural queries (architecture summaries, call tracing, impact analysis, dead code, Cypher-like queries, semantic search); installer adds MCP entries, instruction files, skills and *pre-tool hooks* that push agents to query the graph before grepping; README benchmark: five structural queries ≈3,400 tokens via graph vs ≈412,000 via grep-and-read (self-reported); all processing local except a bounded GitHub release check; preprint listed as arXiv 2603.27277 — [aibuilderclub guide](https://www.aibuilderclub.com/blog/codebase-memory-mcp-guide); [mirror repo](https://github.com/gfsaaser24/codebase-memory-mcp).
- Cursor freshness: Merkle tree of file/folder hashes finds changed files without reprocessing; changed files are chunked syntactically and embedded asynchronously; embeddings cached by chunk content hash so unchanged code is never re-embedded; a simhash of the tree lets teammates reuse an existing index; a 10-minute resync interval is reported by a secondary source — [Cursor secure indexing](https://cursor.com/blog/secure-codebase-indexing); [engineerscodex](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast).
- Serena (open-source MCP): LSP-backed symbol-level find/replace tools for 40+ languages; claims "much more token-efficient" but publishes no token numbers; notes its tools are disabled by default inside Claude Code/Codex because the harness already covers them — [Serena listing](https://mcpservers.org/servers/serena-mcp-server).
- A 2024 paper on persistent IDE trigram indexes notes indexes are typically rebuilt from scratch on checkout and motivates applying only version deltas; an agent-tools survey says any indexed search in an agent loop needs an incremental-update path — [arXiv 2403.03751](https://arxiv.org/abs/2403.03751?context=cs); [agentpatterns](https://agentpatterns.ai/tool-engineering/indexed-regex-search-agent-tools/).

### Inferences
- Cheapest freshness design for a single operator: a post-commit / post-merge hook (or a file watcher) that computes content hashes, re-chunks only changed files, and upserts by chunk-hash into Meilisearch and the vector DB; keep a per-project index (Zoekt-style shard, Meilisearch index per project) and federate at query time.
- Aider-style PageRank repo maps are cheap to generate from tree-sitter tags and are a good "first page" for a worker (a few thousand tokens) — better as a *retrieval target* (on-demand `repo_map` tool) than as prompt injection on every run (see KQ4 evidence on context-file cost).

### Gaps
- No public measurement of how stale an index can be before agent accuracy drops; Cursor's 10-minute cadence is a secondary claim.
- Zoekt's exact commit-level incremental update path isn't documented in the sources found.

---

## KQ3. Hybrid search design (Meilisearch + vectors + reranking), chunking, metadata, what to index beyond code

### Takeaway
Meilisearch natively supports hybrid (keyword + vector) search with per-query `semanticRatio`, multiple named embedders per index with per-embedder `documentTemplate`, and federated multi-search across indexes with weights — enough to build one query surface over code chunks, docs, ADRs, ledger events and handoff notes. Evidence on code retrieval says: chunk by AST (cAST), carry class/import context into each method chunk (Qodo), and use BM25 for exact-token queries, dense for natural-language queries, and rerank when both signals matter.

### Cited Findings
- Meilisearch hybrid: default `semanticRatio` 0.5; closer to 1 = semantic, closer to 0 = keyword; tune per query (docs suggest testing 0.3/0.5/0.7 — brand/exact-name queries favour lower, descriptive queries higher); each embedder has its own `documentTemplate` (which fields are embedded) and `documentTemplateMaxBytes`; changing a template may re-embed all documents — [Meilisearch hybrid overview](https://meilisearch.com/docs/capabilities/hybrid_search/overview); [custom hybrid ranking](https://meilisearch.com/docs/capabilities/hybrid_search/advanced/custom_hybrid_ranking).
- Multiple embedders per index, selectable per query via `hybrid.embedder`; binary quantization per embedder to cut storage; built-in sources: OpenAI, HuggingFace, Ollama, custom REST, plus Cohere/Mistral/Voyage/Gemini/Cloudflare — [multiple embedders](https://www.meilisearch.com/docs/capabilities/hybrid_search/advanced/multiple_embedders); [features](https://www.meilisearch.com/docs/getting_started/features.md).
- Federated multi-search: several queries (different indexes and/or embedders) in one `/multi-search` request, merged into one ranked list with `federationOptions.weight` — [combine text and image search](https://meilisearch.com/docs/capabilities/multi_search/how_to/combine_text_and_image_search).
- Chunking: cAST's AST-aware chunking beats line-based chunking (+4.3 Recall@5 RepoEval, +2.67 Pass@1 SWE-bench) — [arXiv 2506.15655](https://arxiv.org/html/2506.15655v2). Qodo's 10k-repo RAG: ~500-character chunks; each method chunk carries the class definition and relevant imports; repo-level filtering to control noise across many repos; fine-tuned Qodo-Embed-1 (1.5B/7B) — [Qodo blog](https://www.qodo.ai/blog/rag-for-large-scale-code-repos/).
- Lexical vs dense vs hybrid on code benchmarks: NanoCoIR leaderboard — on CodeSearchNet-CCR (code-to-code) reranked hybrid 0.9073 nDCG@10 vs BM25 0.8834 vs dense 0.8519; on CodeSearchNet (NL→code) dense 0.9687 beat reranked hybrid 0.8678; on Apps BM25 ≈0.008 (useless) vs dense 0.2528; on CosQA BM25 recall@100 0.74 vs dense 0.98 — [NanoCoIR](https://hakari-bench-leaderboard.hf.space/docs/benchmark-tasks/NanoCoIR); [NanoCosQA](https://hakari-bench-leaderboard.hf.space/docs/benchmark-tasks/NanoCoIR/NanoCosQA). Scientific-code repo search (arXiv 2607.05443): BM25 MRR@10 0.367, embeddings 0.518, hybrid-RRF 0.487, hybrid+cross-encoder rerank 0.528 (best on 5/6 metrics, modest over dense) — [arXiv](https://arxiv.org/pdf/2607.05443).
- Augment's AugmentQA scores retrieval by ground-truth keyword recall on real codebases and argues synthetic leaderboards (CoIR) mislead — [AugmentQA](https://www.augmentcode.com/blog/you-make-your-evals-then-your-evals-make-you-introducing-augmentqa) (vendor).
- Beyond source: Qodo 2.4 moved to "long-term memory over your PR history" instead of a source index for review — [Qodo](https://www.qodo.ai/?p=20694); Anthropic recommends structured notes (NOTES.md/todo) persisted outside context and reloaded — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); an ADR-generation study found a small recency window (3–5 prior records) beats retrieval for sequential decisions, with retrieval helping mainly for cross-cutting ones — [arXiv 2604.03826](https://arxiv.org/html/2604.03826).

### Inferences
- A practical Neo layout: one Meilisearch index per project for code chunks (AST-chunked, with `project`, `path`, `lang`, `symbol`, `git_sha`, `mtime` as filterable attributes) and shared indexes for `decisions` (ADRs, plan approvals, handoff notes), `history` (commit messages, PR descriptions, ledger events) and `incidents` (error-sweep notes); federated multi-search with a higher weight on the current project; lower `semanticRatio` for identifier-like queries, higher for NL questions. Rerank only the federated top-k (cross-encoder is the measured winner but the gain over dense is modest — budget accordingly).
- The lexical side matters for code: BM25/Meilisearch keyword wins on exact identifiers and code-to-code; dense wins on NL→code; neither alone covers both — this is the measured case for hybrid.

### Gaps
- Meilisearch publishes no chunking guidance (best-practices page for document templates was linked but not reachable); chunk-size numbers come from Qodo/cAST, not Meilisearch.
- No study measures the value of indexing ledger/handoff/chat-decision data for coding agents specifically.

---

## KQ4. Documentation agents can use: CLAUDE.md/AGENTS.md, size limits, ADRs, docs-sweep, docs as retrieval targets vs prompt injection

### Takeaway
The only controlled study (ETH Zurich / LogicStar, ICLR 2026) found context files do not significantly improve task success, raise inference cost >20%, and LLM-generated ones are slightly negative — except in documentation-poor repos where generated files help ~2.7pp; a separate efficiency study found AGENTS.md cut median runtime 28.6% and output tokens 16.6% on 124 real PRs. Official Claude Code guidance is to keep CLAUDE.md under 200 lines, put path-specific instructions in `.claude/rules/` (loaded only when matching files are touched), and keep everything else as on-demand skills or files — i.e. docs as retrieval targets, instruction files as minimal constraints.

### Cited Findings
- Gloaguen et al., "Evaluating AGENTS.md" (arXiv 2602.11988, ICLR 2026): across agents and LLMs, context files give no improvement in task success while increasing inference cost by over 20% and step count; developer-written files: small, statistically insignificant gain (~4% on a niche-repo benchmark per one summary); LLM-generated: marginal negative (~3%); instructions are followed and lead to more testing and broader exploration but files "do not function as effective repository overviews"; with all other docs removed, generated context files raise success ~2.7pp; recommendation: only minimal, specific additional requirements — [arXiv](https://arxiv.org/html/2602.11988v1); [ICLR page](https://iclr.cc/virtual/2026/10021235); [notesbylex summary](https://notesbylex.com/self-generated-agent-context-files-dont-help-either).
- Lulla et al., "On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents" (arXiv 2601.20404): 10 repos, 124 PRs, with/without AGENTS.md → lower median runtime (Δ28.64%) and output tokens (Δ16.58%) at comparable completion — [arXiv](https://arxiv.org/abs/2601.20404v1). Small sample.
- Official Claude Code memory docs (fetched): target under 200 lines per CLAUDE.md ("Longer files consume more context and reduce adherence"); `@imports` organise but do not reduce context cost (imported files load together, max depth 4); contradictory instructions → Claude "may pick one arbitrarily"; `/doctor prompt-audit` audits instruction files; subdirectory CLAUDE.md files load on demand when a file there is read/written; `.claude/rules/*.md` with a `paths:` front-matter load only when matching files are touched; auto memory loads first 200 lines or 25KB; `claudeMdExcludes` skips other teams' files in monorepos; CLAUDE.md is context, not enforcement — use a PreToolUse hook to block actions — [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory).
- OpenAI's guidance: AGENTS.md is "an open-format README for agents," loaded automatically; when Codex makes the same mistake twice, run a retrospective and update AGENTS.md — [OpenAI best practices](https://developers.openai.com/pt-BR/guides/best-practices). Third-party: push detail into linked files, be specific, avoid contradicting README, over-strict rules are followed too literally — [thepromptshelf](https://thepromptshelf.dev/blog/agents-md-openai-codex-guide-2026/).
- ADRs for agents: retrieval "reliably surfaces what was decided and reliably misses why" because the why is scattered across sources; agents don't notice when an old ADR conflicts with current code, so reversals must be recorded as doc changes with status Superseded + link — [tianpan.co](https://tianpan.co/blog/2026/07/02/the-adr-your-agent-never-read) (opinion); context-aware prompting with a 3–5 record recency window gave the best ADR-generation fidelity; retrieval helps mainly for cross-cutting decisions — [arXiv 2604.03826](https://arxiv.org/html/2604.03826).
- Anthropic: system prompts at the "right altitude" — minimal, add rules only from observed failures; CLAUDE.md dropped in up front, everything else fetched just-in-time — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

### Inferences
- Neo's dispatch preamble (`briefWithProjectDocs`) plus a per-project CLAUDE.md is the right shape, but each should be audited against the 200-line target and against the ICLR finding: rules that merely restate what the code shows cost >20% and buy nothing. Keep "commands Claude can't guess, conventions that differ from defaults, where to look."
- A nightly docs-sweep loop is justified by the "docs-poor repo" exception (generated overview helps where nothing else exists) and by the ADR status-tracking need (mark Superseded), not by evidence that richer docs lift success in well-documented repos.
- Treat architecture docs, ADRs and glossaries as retrieval targets (indexed in Meilisearch; linked by path from CLAUDE.md) rather than injected text.

### Gaps
- No study measures the effect of a *glossary* (CONTEXT.md) or of ADR retrieval on coding-agent task success.
- The ETH study's exact per-condition numbers were not readable in-session.

---

## KQ5. History and provenance: git log/blame, "why does this code exist", decisions as precedent

### Takeaway
There is tooling but little measurement: the working pattern is blame → introducing commit → linked PR/issue/ADR → co-change history, with explicit "history is thin" hedging because commit messages often don't record intent. Linking commits to the agent session (or Neo ledger/plan entry) that produced them is the one approach that closes the "why" gap deterministically.

### Cited Findings
- `git-why` (deterministic, no LLM): traces a line through blame to its commit, then pulls issue/PR references from the message and GitHub; explains why a function exists, shows a file's evolution timeline, reports repository "intent coverage" — [GitHub](https://github.com/phoenix-assistant/git-why).
- "Commit Archaeologist" skill: finds introducing commit, later edits and co-changing files, mines intent clues from messages, instructs the agent to say when history is thin rather than invent a rationale; "an empty signal list means the messages don't say why, not that the change had no reason" — [skills.cat](https://skills.cat/skills/shubhamsaboo/awesome-llm-apps/commit-archaeologist).
- `commit-context` (agentmemory): links a blamed commit to the agent session that produced it; if a commit predates session linking it reports the gap instead of guessing from the diff — [skillselion](https://skillselion.com/skills/rohitg00/agentmemory/commit-context).
- `git-query-commits` skill: query history before editing; hook injects recent git history into prompts; structured commit messages enable queries by intent/scope and explicit decision records — [tomevault](https://tomevault.io/tome/srdjan/rlm-git-commits).
- Sourcegraph MCP exposes "history" alongside search/navigation to agents — [Sourcegraph MCP](https://sourcegraph.com/mcp).
- Qodo's review product shifted to memory over PR history rather than a source index — [Qodo](https://www.qodo.ai/?p=20694) (vendor).
- Anthropic: file timestamps and naming are relevance signals for just-in-time retrieval — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

### Inferences
- Neo already has a trace spine (message ids, threads, causes) and a plan registry; writing the plan/trace id into every worker commit message (trailer) and indexing commit messages + PR descriptions + ADR/plan text in a `history` index gives a deterministic "why" chain with no AI in the engine.
- Index incident/error-sweep notes with `path`/`symbol` metadata so a blame→symbol lookup can also surface "this line was involved in incident N".

### Gaps
- No measured evidence that git-history retrieval improves agent task success; all sources are tools/skills and practitioner opinion.

---

## KQ6. Cross-project knowledge: federated search, glossary, shared skills, isolation vs "ask across projects"

### Takeaway
The self-hostable pattern is per-project indexes (one Meilisearch index / Zoekt shard / vector namespace each) plus a federation layer that queries several at once with weights; shared rules and skills live outside projects and are symlinked or imported. Direct evidence that cross-project retrieval lifts accuracy is absent; the design is justified by isolation, freshness and cost, not by measured gains.

### Cited Findings
- Meilisearch federated multi-search merges queries across indexes/embedders into one ranked list with per-query weights — [Meilisearch](https://meilisearch.com/docs/capabilities/multi_search/how_to/combine_text_and_image_search).
- Zoekt: one shard per repo; compound shards for many small repos — [design doc](https://gerrit.googlesource.com/zoekt/+show/0314dee638e2b18be32ff3cc81efc2d4d4fc9f2f/doc/design.md); [DeepWiki](https://deepwiki.com/sourcegraph/zoekt/7-glossary). SCIP gives cross-repository dependency resolution — [latent.space](https://latent.space/reading/sourcegraph-normsky-coding-agents/).
- Qodo used repo-level filtering to manage noise across 10k repos — [Qodo](https://www.qodo.ai/blog/rag-for-large-scale-code-repos/); Qodo later added cross-repo review and "mined rules" — [Qodo 2.4 post](https://www.qodo.ai/?p=20694).
- Claude Code shares rules across projects via `~/.claude/rules/` (all projects) or symlinked `.claude/rules/` (external links require one-time approval, path-scoped linked rules don't load); monorepo noise handled by `claudeMdExcludes` — [memory docs](https://code.claude.com/docs/en/memory).
- Anthropic/OpenAI both describe instruction files as the place to accumulate corrections ("same mistake twice → update") — [OpenAI](https://developers.openai.com/pt-BR/guides/best-practices); [Claude Code docs](https://code.claude.com/docs/en/memory).

### Inferences
- "Ask across projects" should be an explicit tool (`search_all_projects`) with a lower federation weight for foreign projects and a hard `project` filter by default, so a worker in project A never silently acts on project B's code.
- A company glossary is best stored as a small indexed doc (retrieval target) plus a one-line pointer in CLAUDE.md, per KQ4's cost findings.

### Gaps
- No evidence found on glossary effects or on optimal federation weighting for code.

---

## KQ7. Token efficiency: context size vs quality, caching, fresh-context subagents, summaries not dumps, budgets

### Takeaway
Measured: quality degrades gradually with context length even on simple tasks across 18 models (Chroma "context rot"), so retrieval should return the smallest high-signal set; prompt caching reads cost 0.1× (writes 1.25× for 5-min, 2× for 1-hour TTL), making stable prefixes the main cost lever (Manus: KV-cache hit rate is "the single most important metric"); subagents that return 1–2k-token summaries from tens-of-thousands-token explorations are Anthropic's recommended pattern, but multi-agent setups burn ~15× tokens and can introduce silent handoff failures.

### Cited Findings
- Chroma "Context Rot" (2025): 18 models (GPT-4.1, Claude 4, Gemini 2.5, Qwen3…) — reliability degrades non-uniformly as input grows even on simple tasks; degradation can be significant well below the window (e.g. at 50K of 200K); distractors semantically similar to the needle hurt; needle position matters — [DAIR summary](https://academy.dair.ai/papers/context-rot); [W&B report](https://wandb.ai/byyoung3/ml-news/reports/Chroma-Research-Warns-of-Context-Rot-as-LLMs-Falter-with-Long-Inputs--VmlldzoxMzczMjQ4MQ). Primary page not reachable; specific "30%+" drops in blogs unverified.
- Anthropic context engineering (fetched): attention budget is finite (n² pairwise relations), so find "the smallest possible set of high-signal tokens"; tools must return token-efficient output; compaction keeps architectural decisions/unresolved bugs/implementation details, drops redundant tool output, carries the 5 most recently accessed files; lightest form is clearing old tool results; sub-agents may use tens of thousands of tokens each but return condensed summaries of 1,000–2,000 tokens — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- Anthropic multi-agent research system: Opus 4 lead + Sonnet 4 subagents beat single Opus 4 by 90.2% on internal research eval; token usage explains 80% of performance variance; multi-agent uses ~15× the tokens of chat; worth it only for high-value, parallelizable breadth tasks; coding with many inter-agent dependencies is a poor fit — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system); [ByteByteGo summary](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent).
- Deep Agentic Search: subagent delegation lost to plain semantic search on SWE-QA (46.2% vs 65.2%) and 41.8% of failures were silent handoff failures — [arXiv 2608.01507](https://arxiv.org/pdf/2608.01507).
- Claude Code subagents: tool calls, file reads and search output stay inside the subagent, only the final message returns; subagents can't spawn subagents; set `maxTurns` on bounded subagents; small tasks pay startup overhead — [vantaige](https://vantaige.io/blog/claude-code-subagents-save-context-3-patterns); [Medium guide](https://medium.com/@akshaych.dev/claude-code-working-with-agents-and-improving-the-context-window-baee3ffee9cd) (secondary).
- Prompt caching (Anthropic docs): 5-min cache write 1.25× base input, 1-hour write 2× (`cache_control: {type: "ephemeral", ttl: "1h"}`), reads 0.1× regardless of TTL; up to 4 breakpoints; 1-hour entries must precede 5-minute ones — [Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching); [Portkey summary](https://portkey.ai/docs/integrations/llms/anthropic/prompt-caching).
- Manus (primary post): KV-cache hit rate is the most important production metric; a single-token prefix change (e.g. a timestamp) invalidates the cache from there on; append-only context, deterministic JSON key ordering; cached vs uncached Sonnet input 0.30 vs 3 USD/MTok; mask tools via logits instead of removing them; file system as externalised memory with restorable compression (drop content, keep path/URL); keep failed actions in context so the model learns — [Manus](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).
- Context files cost: >20% more inference and more steps (ETH); AGENTS.md cut runtime 28.6% / output tokens 16.6% in the PR study — [arXiv 2602.11988](https://arxiv.org/html/2602.11988v1); [arXiv 2601.20404](https://arxiv.org/abs/2601.20404v1).
- Graph-vs-grep token claim: codebase-memory README reports ≈3,400 vs ≈412,000 tokens for five structural queries (self-reported) — [guide](https://www.aibuilderclub.com/blog/codebase-memory-mcp-guide).

### Inferences
- For Neo: keep the dispatch preamble + CLAUDE.md as a stable cached prefix (no timestamps or per-run ids at the top), put volatile brief content last; the learned cache TTL already in place should prefer 1-hour on long loops where write cost (2×) is amortised by many reads (0.1×).
- Search tools should return ranked hits with `path:line` + a few lines of context and a hard result cap, never whole files; a fresh-context "Explore" subagent is worth it for broad scans (many files) but its return contract must be explicit (evidence list with paths) to avoid the silent-handoff failure mode.

### Gaps
- No measurement of optimal per-search token budget or truncation threshold for coding agents.
- Chroma's primary numbers and Anthropic's "30%/27%" figures circulating in blogs could not be verified.

---

## KQ8. Memory systems compared (Claude auto-memory, Mem0/Letta/Zep/Graphiti, OpenClaw/Hermes-style); poisoning/drift; when an index beats a memory file

### Takeaway
Vendor LoCoMo scores are contested and not comparable (Mem0 claims 91–93; Zep 80–83 or 58 depending on who recomputes; Letta showed a plain file + grep at 74.0% beat Mem0's then-reported 68.5%), so treat "memory layer" benchmarks as marketing; memory stores are also a documented attack surface (MINJA >95% injection success in idealised settings; OWASP ASI06). A search index over versioned, provenance-tagged files is the safer default; Claude's auto memory is capped (first 200 lines / 25KB) and treated as context, not enforcement.

### Cited Findings
- Letta: placing LoCoMo history in a file and giving the agent grep/search_files/open/close on GPT-4o-mini scored 74.0% vs Mem0's reported 68.5% (top graph variant); Letta argues LoCoMo measures retrieval, not memory management — [Letta blog](https://www.letta.com/blog/benchmarking-ai-agent-memory).
- Mem0 self-reports 91.6 (Apr 2026) / 92.5 on LoCoMo and 93.4–94.4 on LongMemEval — [Mem0 comparison](https://mem0.ai/blog/zep-vs-mem0-which-ai-memory-layer-should-you-choose); [DevToolLab](https://devtoollab.com/blog/ai-agent-memory-platforms). Zep says Mem0's paper scored Zep at 65.99% due to implementation errors; Zep's own configs 80.32%–83%; a third-party recalculation of an 84% Zep claim came to ~58.44% with the adversarial category included — [Zep blog](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/); [Towards AI](https://pub.towardsai.net/mem0-vs-zep-vs-letta-a-folder-of-text-files-shouldnt-beat-the-61k-star-memory-layer-9d7e65c5799c). Graphiti is Zep's open-source engine.
- Claude Code auto memory: Claude-written notes per repository (shared across worktrees), loaded every session, first 200 lines or 25KB; subagents can keep their own; both memory types are "context, not enforced configuration" — [memory docs](https://code.claude.com/docs/en/memory).
- MINJA (NeurIPS 2025, arXiv 2503.03704): injects malicious records into an agent's memory bank using only ordinary queries/output observation; secondary reports of >95% injection success and ~70% attack success under idealised conditions; Llama Guard-style moderation and memory sanitisation "largely ineffective" — [arXiv](https://arxiv.org/pdf/2503.03704v1); [Red Sky summary](https://redskyalliance.org/xindustry/minja-memory-injection-attack). MemoryGraft (arXiv 2512.16962) implants poisoned "successful experiences" that activate by semantic similarity — [arXiv](https://arxiv.org/pdf/2512.16962.pdf); attack/defense study arXiv 2601.05504 — [arXiv](https://arxiv.org/html/2601.05504v1); Unit 42 PoC planted instructions via a compromised web page; OWASP lists ASI06 "Memory and Context Poisoning" in its 2026 agentic Top 10 — [Vectorize](https://vectorize.io/articles/ai-memory-poisoning).
- Anthropic's own memory guidance is structured note-taking in files (NOTES.md/todo) reloaded on demand — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); Manus uses the file system as memory with restorable compression — [Manus](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).

### Inferences
- Neo's "capped curated memory + frozen snapshot + FTS recall" (memory Phase 2) is consistent with the evidence: files + search beat opaque memory layers on retrieval benchmarks, and a cap plus provenance limits poisoning blast radius. Customer-tainted text must never be written into memory that workers load (MINJA/MemoryGraft vector).
- A search index beats a memory file whenever the fact is (a) large, (b) changes with code, or (c) only occasionally relevant; a memory file wins for small, always-relevant, operator-authored corrections.

### Gaps
- No neutral head-to-head of memory layers under identical conditions; no coding-specific memory benchmark found.
- No public data on OpenClaw/Hermes-style memory accuracy.

---

## KQ9. Code-quality retrieval: linters/static analysis as queryable signals, architecture fitness functions, how agents use them

### Takeaway
Static-analysis feedback loops measurably improve LLM code (Bandit/Pylint loop; Bandit feedback cut CodeQL-flagged issues 30.8%), but Semgrep/CodeQL verdicts agree with ground truth only ~61–65% per sample, so they are signals to act on, not oracles. Deterministic architecture gates (dependency-cruiser, grimp, ast-grep, archfit) that emit structured repair tasks are the emerging pattern for keeping agents inside boundaries across repos.

### Cited Findings
- "Static Analysis as a Feedback Loop" (arXiv 2508.14419): iterative loop with Bandit + Pylint (CodeQL as extra check) — LLMs guided by static-analysis feedback "significantly enhance code quality beyond functional correctness"; cites Alrashedy et al.: Bandit feedback loop achieved a 30.8% reduction in CodeQL-flagged security issues — [arXiv](https://arxiv.org/html/2508.14419v1).
- Firouzi & Ghafari (arXiv 2602.05868, SANER 2026 workshop): 1,080 LLM-generated samples; manual review 61% secure vs Semgrep 60% / CodeQL 80% "secure" labels; per-sample agreement with ground truth only 65% (Semgrep) and 61% (CodeQL) — "question the reliability of static analysis tools as sole evaluators" — [arXiv](https://arxiv.org/html/2602.05868v1).
- archfit: reads structure facts from analyzers (go list, dependency-cruiser, ast-grep, grimp) and evaluates boundaries, layers, public APIs, cycles, Balanced Coupling; rationale: agents can't hold whole-system design in context, so green tests can hide forbidden imports; on failure emits a structured `agent_tasks` repair entry; deterministic gates separate from optional LLM narration ("LLM never decides whether the gate passes") — [pkg.go.dev](https://pkg.go.dev/github.com/alexei-led/archfit@v0.14.0).
- Augment's review benchmark (vendor): 59% F-score (~65% precision / 57% recall) attributed to Context Engine retrieving call sites and dependencies — [Augment](https://augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results).
- Claude Code: to *enforce* a rule use a PreToolUse hook; instruction files are advisory — [memory docs](https://code.claude.com/docs/en/memory).

### Inferences
- For Neo: run Biome/ESLint/golangci-lint/Semgrep/dependency-cruiser in the governor as deterministic post-edit gates (hooks), index their findings per project+path so workers can query "known issues in this file", and treat Semgrep/CodeQL results as evidence for the worker to verify, not auto-fail conditions.
- Architecture rules (import boundaries) belong in machine-checkable config (dependency-cruiser / import-linter) referenced from CLAUDE.md, matching the "rules in code, not prompts" principle.

### Gaps
- No study found that measures Semgrep or CodeQL inside a *coding agent* loop (only prompting loops with Bandit/Pylint).
- No independent evaluation of archfit or dependency-cruiser's effect on agent output.
