# MODEL_PROVIDER_POLICY.md — Zero Required Spend

**Default:** local Ollama-compatible text model. The user decides which locally available model to pull/run; do not assume a GPU or specific size. Inspect RAM/VRAM and installed models before recommending a download.

**Optional:** free Groq, Gemini or OpenRouter models, only after checking *current* model availability, geography, terms, data-use policy, free quotas and whether a card is required. Do not promise permanent free access. Do not automatically create paid accounts or enable billing. Record the exact model, endpoint, limits and credentials source.

**Adapter interface:** `model_id`, capabilities (text, tool_schema, vision, streaming), `generate`, `stream`, timeout, provider errors, token usage if returned. Keep provider metadata in result. Fallback must be explicitly surfaced rather than silent substitution.

**Evaluation:** Compare at least one prompt fixture using deterministic/non-model tool operations for correctness, and only report actual latency and output validity from real requests. RouteTune-adapted intent routing is postponed until training and hold-out tests have actually completed; never claim it is running merely because a notebook exists.

**Voice:** Windows built-in TTS as simplest first step; optional free STT engine after model requirements and license verified; do not assume a permanently free live voice provider. **Security:** remote inference may retain/use data according to provider terms; user must opt in before any sensitive sources are uploaded.
