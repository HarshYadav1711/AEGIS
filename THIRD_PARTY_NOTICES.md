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
