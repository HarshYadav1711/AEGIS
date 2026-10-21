# Third-Party Notices

AEGIS source code is original. It depends on the packages below, installed from
npm / PyPI at the pinned versions (full resolved sets: `apps/desktop/package-lock.json`,
`services/core/requirements.lock.txt`). No third-party source files, images,
fonts, sounds or animations are copied into this repository.

Licenses were read from each installed package's own metadata on 2026-10-21.
Transitive dependencies carry their own licenses inside `node_modules/` and the
Python virtual environment; review them before any redistribution.

## Desktop (npm)

| Package | Version | License | Use |
|---|---|---|---|
| react | 19.3.1 | MIT | Renderer UI |
| react-dom | 19.3.1 | MIT | Renderer UI |
| electron | 44.9.2 | MIT | Desktop shell (dev dependency; bundles Chromium/Node with their own notices) |
| vite | 8.3.4 | MIT | Renderer build/dev server |
| @vitejs/plugin-react | 6.1.2 | MIT | Vite React transform |
| typescript | 6.0.3 | Apache-2.0 | Type checking / main-process compile |
| eslint | 10.13.0 | MIT | Lint |
| @eslint/js | 10.0.1 | MIT | Lint rules |
| typescript-eslint | 8.72.0 | MIT | Lint rules |
| eslint-plugin-react-hooks | 7.1.1 | MIT | Lint rules |
| globals | 17.13.0 | MIT | Lint globals |
| @types/react, @types/react-dom | 19.3.0 | MIT | Type definitions |
| @types/node | 24.19.2 | MIT | Type definitions |

## Core (PyPI)

| Package | Version | License | Use |
|---|---|---|---|
| fastapi | 0.156.1 | MIT | HTTP API |
| starlette | 1.9.0 (via fastapi) | BSD-3-Clause | ASGI toolkit |
| pydantic | 2.14.1 | MIT | Response models |
| uvicorn | 0.54.0 | BSD-3-Clause | ASGI server |
| pytest | 9.1.1 | MIT | Tests (dev only) |
| httpx | 0.28.1 | BSD-3-Clause | Test client (dev only) |
| langgraph | 1.2.16 | MIT | Phase 2 bounded plan/execute graphs (runtime) |
| langchain-core | 1.6.12 (via langgraph) | MIT | LangGraph runtime dependency |
| langgraph-checkpoint, langgraph-prebuilt, langgraph-sdk | 4.3.0, 1.1.1, 0.4.8 (via langgraph) | MIT | Installed with LangGraph; AEGIS uses no checkpointer, prebuilt agent or remote SDK |
| langsmith | 0.14.11 (via langchain-core) | MIT | Installed transitively; tracing is off (no LANGSMITH_* variables reach the core, whose environment is allowlisted) |
| Other transitive packages of langgraph (orjson, ormsgpack, PyYAML, tenacity, requests, urllib3, xxhash, zstandard, httpx2, websockets, ...) | see `requirements.lock.txt` | MIT / BSD / Apache-2.0; orjson MPL-2.0 AND (Apache-2.0 OR MIT) | Not used directly |
| playwright (Python) | 1.63.0 | Apache-2.0 (NOTICE and ThirdPartyNotices.txt in the installed package) | Phase 3 isolated headless browser for reading approved public pages |
| greenlet | 3.5.6 (via playwright) | MIT AND PSF-2.0 | Playwright runtime dependency |
| pyee | 13.0.1 (via playwright) | MIT | Playwright runtime dependency |

### Downloaded at setup (not in the repository)

| Component | Version | License | Use |
|---|---|---|---|
| Chromium headless shell (Playwright build r1243) | 153.0.8010.12 | BSD-3-Clause, with Chromium's bundled third-party notices | Rendering fetched pages with JavaScript off; installed by `scripts\setup.ps1` into the venv's `playwright` package (`PLAYWRIGHT_BROWSERS_PATH=0`) |
| Node.js runtime bundled in the playwright wheel | (as shipped by playwright 1.63.0) | MIT, with its own notices | Playwright driver process |
