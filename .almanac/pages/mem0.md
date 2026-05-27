---
title: Mem0
summary: Mem0 is an operational agent-memory layer whose extraction and retrieval model clarifies how CodeAlmanac differs from runtime memory stores.
topics: [product-positioning]
sources:
  - /Users/rohan/.codex/sessions/2026/05/15/rollout-2026-05-15T01-30-45-019e2a1d-a038-7633-81ea-a1dfc6cb50bd.jsonl
  - /Users/rohan/.codex/sessions/2026/05/19/rollout-2026-05-19T20-19-07-019e4364-e949-7d40-969e-a5baf98aa944.jsonl
  - /Users/rohan/Desktop/Projects/mem0/mem0/memory/main.py
  - /Users/rohan/Desktop/Projects/mem0/mem0/configs/prompts.py
  - /Users/rohan/Desktop/Projects/mem0/.almanac/pages/python-oss-memory.md
  - /Users/rohan/Desktop/Projects/mem0/.almanac/pages/python-oss-add-pipeline.md
  - /Users/rohan/Desktop/Projects/mem0/.almanac/pages/python-oss-search-pipeline.md
  - /Users/rohan/Desktop/Projects/mem0/.almanac/pages/python-oss-entity-linking.md
  - /Users/rohan/Desktop/Projects/mem0/.almanac/pages/python-oss-storage-and-history.md
  - https://github.com/mem0ai/mem0
  - https://arxiv.org/abs/2504.19413
  - https://docs.mem0.ai/migration/platform-v2-to-v3
  - https://docs.mem0.ai/migration/oss-v2-to-v3
  - https://docs.mem0.ai/platform/cli
  - https://docs.mem0.ai/platform/mem0-mcp
  - https://docs.mem0.ai/open-source/features/graph-memory
  - https://langchain-ai.github.io/langmem/
  - https://github.com/getzep/graphiti
  - https://help.getzep.com/v2/understanding-the-graph
  - https://docs.langchain.com/oss/javascript/langgraph/memory
verified: 2026-05-20
---

`Mem0` is an agent-memory product and open-source project inspected during the 2026-05-20 memory-competitor research thread. It competes with CodeAlmanac at the broad "agents should remember across interactions" layer, but its core artifact is a runtime memory store rather than a repo-owned wiki.

The local `../mem0` clone was inspected at commit `a623cfaf` on `main`, titled `Oss qdrant hosted memories to platform migration (#5080)`. The implementation read centered on `mem0/memory/main.py` and `mem0/configs/prompts.py`, where `Memory.add()` imports `ADDITIVE_EXTRACTION_PROMPT`, stores extracted memories, links entities in a parallel entity collection, and ranks search results with vector similarity plus BM25 and entity boost signals.

## Memory Model

Mem0 stores short natural-language memory records extracted from conversation turns. The Mem0 paper describes extracting salient memories from a new user-assistant message pair plus conversation context, then using those memories in later interactions.

The older documented algorithm had two phases: extract candidate facts, retrieve similar existing memories, then let an LLM classify each candidate as `ADD`, `UPDATE`, `DELETE`, or `NOOP`. The v3 migration docs changed that extraction model to single-pass, add-only memory creation. Existing memories are not automatically overwritten or deleted during extraction; recency and currentness move to retrieval and ranking.

Mem0 still exposes explicit mutation operations through API, CLI, and MCP surfaces. The public surface includes add, search, list, update, and delete operations, so the add-only extraction policy is an ingestion rule rather than a claim that memories are immutable.

## OSS Architecture Components

The Python OSS architecture has four main state-bearing pieces: an LLM extractor, a vector store, SQLite support tables, and a side entity store. Optional BM25 keyword search, score fusion, and a reranker shape retrieval after those stores produce candidates.

The LLM extractor turns messages plus recent context into memory facts. In the current default path, `Memory.add()` builds a session scope from `user_id`, `agent_id`, and `run_id`, loads the latest 10 saved messages for that scope, searches existing memories, and calls `ADDITIVE_EXTRACTION_PROMPT` for new records.

The vector store is the current searchable memory corpus. Each extracted memory is embedded and stored with payload fields such as `data`, `hash`, `text_lemmatized`, timestamps, session identifiers, and caller metadata. Hash dedupe skips exact duplicate memory texts before insertion.

SQLite stores support state rather than the primary searchable corpus. `SQLiteManager` records `ADD`, `UPDATE`, and `DELETE` history rows, and it keeps the latest 10 messages per deterministic session scope so the next extraction can resolve references from nearby conversation.

The entity store is graph-like but not a full relation graph. It is a parallel vector collection named `<memory_collection>_entities`; entity payloads store entity text, type, scope ids, and `linked_memory_ids`. Search extracts query entities, searches that side collection, and boosts memories linked through matched entities.

Keyword retrieval is optional at the vector-store contract level. Stores that support full-text or BM25 behavior can use the lemmatized text payload, while stores without keyword support return semantic candidates only.

`Memory.search()` fuses semantic vector scores, normalized BM25 scores when available, and entity boosts in `score_and_rank`. When `rerank=True` and a reranker is configured, the formatted candidate memories pass through the reranker; a reranker failure falls back to the fused score order.

The concrete add flow is: validate scope, load recent SQLite messages, search related memories, extract additive memory facts with the LLM, embed records, dedupe by hash, insert vector payloads, write `ADD` history, link entities, and save current messages. The concrete search flow is: validate filters, lemmatize the query, extract query entities, embed the query, semantic-overfetch `max(top_k * 4, 60)` candidates, optionally run BM25, search entity links, fuse scores, optionally rerank, and format results.

## Retrieval Model

Mem0 is designed to sit inside an agent loop. The common integration pattern retrieves relevant memories before generation and writes new memories after the assistant response.

The current docs describe hybrid retrieval rather than pure vector search. Semantic similarity provides candidates, while BM25 keyword scoring and entity signals boost or fuse ranking. Older Mem0g and graph-memory docs describe entities as nodes and relationships as edges; the v3 migration docs say OSS graph-store support was removed and replaced by entity linking in a parallel vector collection.

That trajectory matters to CodeAlmanac because agent-memory products are converging on the same lesson as [[company-brain]]: pure embedding retrieval is not enough for durable operational context. The difference is where the structured memory lives and what it is allowed to mean.

## Public Memory Patterns

The 2026-05-20 comparison found a broader pattern across Mem0, LangMem, Graphiti, Zep, and LangGraph. Public agent-memory systems commonly extract facts from interaction history, expose separate memory operations, combine semantic search with keyword or entity signals, and model memory as temporal or additive state rather than a single overwritten profile.

Mem0's v3 add-only extraction is one example of that shift. Graphiti and Zep describe temporal knowledge graphs where facts evolve over time. LangGraph and LangMem use semantic, episodic, and procedural memory categories, which frame memory as more than a vector store of prior chat snippets.

The product implication for CodeAlmanac is that the market is validating structured memory, not only automatic recall. CodeAlmanac should reuse that lesson while keeping its artifact different: durable pages, explicit evidence, topics, wikilinks, file references, and Git review instead of an opaque per-agent memory profile.

## CodeAlmanac Contrast

Mem0 answers "what should this agent remember for future interactions?" CodeAlmanac answers "what has this repository learned that future agents must preserve?"

Mem0 optimizes for automatic recall in a running product or agent. Its durable units are memory records, embeddings, entity links or graph relations, and API-visible memory operations. It is useful when the product needs personalization, session continuity, or cross-conversation recall.

CodeAlmanac optimizes for governed project knowledge. Its durable units are `.almanac/pages/*.md` and `.almanac/topics.yaml`, with topics, `files:` frontmatter, wikilinks, backlinks, health checks, and Git review. It is useful when the memory must become part of the repository's institutional record and shape future code edits.

The practical positioning rule matches [[codex-supermemory]] and [[agentmemory-competitor]]: CodeAlmanac should not compete as generic agent memory. It should compete as the repo-local artifact that promotes expensive session understanding into reviewed project memory.

## Related Pages

[[codex-supermemory]] covers the Supermemory Codex hook integration tested in the same research arc. [[agentmemory-competitor]] covers the heavier local-daemon competitor. [[just-in-time-context-surfacing]] describes the CodeAlmanac response to memory products with better automatic recall.
