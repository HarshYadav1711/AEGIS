"""Read-only repository scanner (Phase 4, tool `repo.inspect_read_only`).

Everything here is deterministic code; no model output reaches this module.

Read-only by construction: files are only ever opened with mode "rb", nothing
is created, renamed or deleted, and no repository code, script, package
manager or shell is run. The walk never follows links, junctions or other
reparse points, and every opened file is re-checked to be the same file the
walk saw (identity), so a swapped-in link is refused instead of followed.

Excluded without reading: VCS internals (.git), dependency folders
(node_modules, virtual environments, vendor), build output and caches,
hidden entries (except a few config files), secret-bearing files (.env,
keys, credentials), lockfiles, binaries and oversized files. Sensitive files
are listed by path only; their content is never opened.

The scan produces: an inventory, language and manifest facts, dependency and
framework evidence with line numbers, component relationships from imports,
deterministic pattern checks with file/line references, the file windows that
will be offered to the model, and a stat snapshot used later to prove the
repository did not change.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import posixpath
import re
import stat
import tomllib
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.memory.adaptive import contains_secret
from app.tools.file_scope import Scope, ScopeError, check_scope_unchanged, child_path, identity_of, is_link_like

# ------------------------------------------------------------------ bounds (printed in every report)
MAX_DEPTH = 25
MAX_ENTRIES = 20_000
MAX_INVENTORY = 5_000
MAX_FILE_BYTES = 256_000
MAX_READ_FILES = 1_500
MAX_READ_BYTES = 8_000_000
MAX_MANIFESTS = 20
MAX_CONTEXT_FILES = 12
FILE_CONTEXT_CHARS = 20_000
MAX_FILE_EXCERPT_CHARS = 2_600
HEAD_LINES = 70
WINDOW_LINES = 40
MAX_LINE_CHARS = 200
PER_RULE_LISTED = 10

# ------------------------------------------------------------------ classification tables
DEPENDENCY_DIRS = {"node_modules", "bower_components", "vendor", "site-packages", "Pods", ".venv", "venv", "env",
                   ".tox", ".nox", ".eggs"}
BUILD_DIRS = {"dist", "build", "out", "target", "coverage", "htmlcov", "dist-electron", "__pycache__", ".next",
              ".nuxt", ".svelte-kit", ".parcel-cache", ".cache", ".mypy_cache", ".pytest_cache", ".ruff_cache",
              ".gradle", ".terraform", "bin", "obj"}
VCS_DIRS = {".git", ".hg", ".svn"}
ALLOWED_HIDDEN = {".github", ".gitignore", ".gitattributes", ".editorconfig", ".dockerignore", ".nvmrc",
                  ".python-version", ".pre-commit-config.yaml"}
SENSITIVE = ("*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.ppk", "*.kdbx", "id_rsa*", "id_dsa*",
             "id_ecdsa*", "id_ed25519*", ".env", ".env.*", "*.env", "credentials*", "*secret*", ".npmrc", ".pypirc",
             ".netrc", ".htpasswd", "*.tfstate", "*.tfstate.*", "service-account*.json")
ENV_TEMPLATES = (".env.example", ".env.sample", ".env.template", ".env.dist")
LOCKFILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "poetry.lock", "uv.lock",
             "Pipfile.lock", "Cargo.lock", "go.sum", "composer.lock", "Gemfile.lock"}
LANGUAGES = {".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
             ".mjs": "JavaScript", ".cjs": "JavaScript", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
             ".cs": "C#", ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++", ".rb": "Ruby",
             ".php": "PHP", ".swift": "Swift", ".scala": "Scala", ".sh": "Shell", ".ps1": "PowerShell", ".sql": "SQL",
             ".html": "HTML", ".css": "CSS", ".scss": "CSS", ".vue": "Vue", ".svelte": "Svelte"}
DOC_EXTS = {".md", ".rst", ".txt", ".adoc"}
CONFIG_EXTS = {".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".xml", ".gradle", ".properties", ".conf"}
TEXT_NAMES = {"Dockerfile", "Makefile", "Procfile", "LICENSE", "README", "CHANGELOG", "Gemfile", "Jenkinsfile"}
MANIFEST_NAMES = {"package.json", "pyproject.toml", "go.mod", "Cargo.toml", "setup.py", "setup.cfg", "pom.xml",
                  "build.gradle", "Gemfile", "composer.json"}
ENTRYPOINT_NAMES = {"__main__.py", "main.py", "app.py", "server.py", "manage.py", "cli.py", "wsgi.py", "asgi.py",
                    "index.ts", "index.js", "index.tsx", "main.ts", "main.js", "main.tsx", "server.ts", "server.js",
                    "App.tsx", "main.go", "main.rs", "lib.rs"}
CONTAINERS = {"src", "apps", "packages", "services", "lib", "libs", "app", "modules", "cmd", "internal", "pkg"}
FRAMEWORKS = {
    "react": "React", "vue": "Vue", "svelte": "Svelte", "next": "Next.js", "electron": "Electron", "vite": "Vite",
    "express": "Express", "fastify": "Fastify", "@nestjs/core": "NestJS", "fastapi": "FastAPI", "flask": "Flask",
    "django": "Django", "starlette": "Starlette", "langgraph": "LangGraph", "langchain": "LangChain",
    "pydantic": "Pydantic", "sqlalchemy": "SQLAlchemy", "pytest": "pytest", "jest": "Jest", "vitest": "Vitest",
    "mocha": "Mocha", "playwright": "Playwright", "@playwright/test": "Playwright", "torch": "PyTorch",
    "tensorflow": "TensorFlow", "numpy": "NumPy", "pandas": "pandas", "uvicorn": "Uvicorn", "httpx": "HTTPX",
    "requests": "Requests", "ollama": "Ollama", "github.com/gin-gonic/gin": "Gin", "actix-web": "Actix Web",
    "tokio": "Tokio", "typescript": "TypeScript compiler", "tailwindcss": "Tailwind CSS",
}

# Pattern checks: (rule, title, languages or None for every read text file, regex, severity, recommendation)
_SECRET_ASSIGN = (r"""(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b"""
                  r"""["']?\s*[:=]\s*["'][^"'\s]{8,}["']""")
_KEY_FORMATS = (r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{16,}"
                r"|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}")
RULES: tuple[tuple[str, str, frozenset[str] | None, re.Pattern[str], str, str], ...] = (
    ("hardcoded-credential", "Line matches a credential pattern (value redacted)", None,
     re.compile(f"{_SECRET_ASSIGN}|{_KEY_FORMATS}"), "high",
     "Move the value to an ignored local config or the OS keychain and rotate it if it was ever real."),
    ("py-bare-except", "Bare `except:` clause", frozenset({"Python"}), re.compile(r"^\s*except\s*:"), "medium",
     "Catch specific exceptions; a bare except also swallows KeyboardInterrupt and SystemExit."),
    ("py-eval-exec", "Call to eval() or exec()", frozenset({"Python"}),
     re.compile(r"(?<![\w.])(eval|exec)\s*\("), "high",
     "Avoid evaluating strings as code; use a parser (ast.literal_eval, json) or explicit dispatch."),
    ("py-shell-true", "subprocess call with shell=True", frozenset({"Python"}), re.compile(r"\bshell\s*=\s*True\b"),
     "high", "Pass an argument list without shell=True so input is never interpreted by a shell."),
    ("tls-verify-off", "TLS certificate verification disabled", frozenset({"Python", "JavaScript", "TypeScript"}),
     re.compile(r"\bverify\s*=\s*False\b|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED"), "high",
     "Keep certificate verification on; trust a specific CA bundle if a private CA is needed."),
    ("js-eval", "Call to eval() or new Function()", frozenset({"JavaScript", "TypeScript", "Vue", "Svelte"}),
     re.compile(r"(?<![\w.])eval\s*\(|\bnew\s+Function\s*\("), "high",
     "Avoid evaluating strings as code; use JSON.parse or explicit dispatch."),
)
MARKER = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b")
_COMMENT = re.compile(r"^\s*(#|//|\*|/\*)")
_PY_IMPORT = re.compile(r"^\s*(?:from\s+(\.*[\w.]*)\s+import\b|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))")
_JS_IMPORT = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}/[^"']+)["']"""
)
_JS_EXTS = ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js")
_REQ_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$")
INJECTION = re.compile(
    r"(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?)"
    r"|\bsystem\s+prompt\b|\byou\s+are\s+now\b|\bdeveloper\s+mode\b|\bnew\s+instructions\s*:"
    r"|\b(as\s+an?\s+)?(ai|llm|language\s+model|assistant)[^.\n]{0,40}\b(must|should)\s+(now\s+)?(ignore|say|report|write|delete|run)",
    re.IGNORECASE,
)


@dataclass
class FileInfo:
    rel_path: str
    size: int
    mtime_ns: int
    file_id: str
    role: str  # source | test | doc | config | manifest | lockfile | other
    language: str | None
    status: str = "not_read"  # read | binary | too_large | not_text | lockfile | limit | unreadable | sensitive
    sha256: str | None = None
    lines: int | None = None
    suspicious: bool = False


@dataclass
class Scan:
    root: str
    files: list[FileInfo] = field(default_factory=list)
    excluded: Counter[str] = field(default_factory=Counter)
    excluded_paths: list[dict[str, str]] = field(default_factory=list)
    truncated: bool = False
    skipped_links: int = 0


def _now_entry(rel: str, st: os.stat_result, role: str, language: str | None) -> FileInfo:
    return FileInfo(rel, st.st_size, st.st_mtime_ns, identity_of(st), role, language)


def _role(rel: str, name: str) -> tuple[str, str | None]:
    ext = posixpath.splitext(name)[1].lower()
    language = LANGUAGES.get(ext)
    lower = name.lower()
    if name in LOCKFILES:
        return "lockfile", None
    if name in MANIFEST_NAMES or fnmatch.fnmatch(lower, "requirements*.txt"):
        return "manifest", language
    parts = rel.lower().split("/")
    if language and (
        any(p in ("tests", "test", "__tests__", "spec") for p in parts[:-1])
        or fnmatch.fnmatch(lower, "test_*.py") or fnmatch.fnmatch(lower, "*_test.py")
        or fnmatch.fnmatch(lower, "*_test.go") or re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", lower)
    ):
        return "test", language
    if language:
        return "source", language
    if ext in DOC_EXTS or name.split(".")[0].upper() in ("README", "LICENSE", "CHANGELOG", "CONTRIBUTING"):
        return "doc", None
    if ext in CONFIG_EXTS or name in TEXT_NAMES or name in ALLOWED_HIDDEN:
        return "config", None
    return "other", None


def _sensitive(name: str) -> bool:
    lower = name.lower()
    return any(fnmatch.fnmatch(lower, pattern) for pattern in SENSITIVE)


def walk(scope: Scope) -> Scan:
    """Inventory the repository by stat only (no file is opened). Links are counted, never followed."""
    check_scope_unchanged(scope)
    scan = Scan(root=str(scope.root))
    stack: list[tuple[Path, int]] = [(scope.root, 0)]
    entries_seen = 0
    while stack:
        folder, depth = stack.pop()
        try:
            entries = sorted(os.scandir(folder), key=lambda e: e.name, reverse=True)
        except OSError:
            scan.excluded["unreadable_folder"] += 1
            continue
        for entry in entries:
            entries_seen += 1
            if entries_seen > MAX_ENTRIES or len(scan.files) >= MAX_INVENTORY:
                scan.truncated = True
                stack.clear()
                break
            try:
                st = os.lstat(entry.path)  # not entry.stat(): on Windows its cached stat has no file index
            except OSError:
                scan.excluded["unreadable"] += 1
                continue
            rel = Path(entry.path).relative_to(scope.root).as_posix()
            name = entry.name
            if is_link_like(st):
                scan.skipped_links += 1
                scan.excluded["link"] += 1
                _note(scan, rel, "link or junction (not followed)")
                continue
            if stat.S_ISDIR(st.st_mode):
                reason = (
                    "version control" if name in VCS_DIRS
                    else "dependencies" if name in DEPENDENCY_DIRS or os.path.lexists(os.path.join(entry.path, "pyvenv.cfg"))
                    else "build output or cache" if name in BUILD_DIRS or name.endswith(".egg-info")
                    else "hidden" if name.startswith(".") and name not in ALLOWED_HIDDEN
                    else None
                )
                if reason:
                    scan.excluded[reason] += 1
                    _note(scan, rel + "/", reason)
                elif depth < MAX_DEPTH:
                    stack.append((Path(entry.path), depth + 1))
                else:
                    scan.excluded["too deep"] += 1
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            if _sensitive(name) and name.lower() not in ENV_TEMPLATES:
                info = _now_entry(rel, st, "other", None)
                info.status = "sensitive"
                scan.files.append(info)
                scan.excluded["sensitive file (not opened)"] += 1
                _note(scan, rel, "sensitive file (not opened)")
                continue
            if name.startswith(".") and name not in ALLOWED_HIDDEN and name.lower() not in ENV_TEMPLATES:
                scan.excluded["hidden"] += 1
                continue
            role, language = _role(rel, name)
            scan.files.append(_now_entry(rel, st, role, language))
    scan.files.sort(key=lambda f: f.rel_path)
    return scan


def _note(scan: Scan, rel: str, reason: str) -> None:
    if len(scan.excluded_paths) < 60:
        scan.excluded_paths.append({"path": rel, "reason": reason})


def snapshot(scan: Scan) -> dict[str, list[int]]:
    return {f.rel_path: [f.size, f.mtime_ns] for f in scan.files}


def compare_snapshot(before: dict[str, list[int]], scope: Scope) -> dict[str, Any]:
    """Re-walk and compare with an earlier snapshot: proof that nothing in the inspected area changed."""
    after = snapshot(walk(scope))
    changed = sorted(p for p in before.keys() & after.keys() if before[p] != after[p])
    added = sorted(after.keys() - before.keys())
    removed = sorted(before.keys() - after.keys())
    return {"unchanged": not (changed or added or removed), "entries": len(before),
            "changed": changed[:20], "added": added[:20], "removed": removed[:20]}


# ------------------------------------------------------------------ reading


def resolve(scope: Scope, rel_path: str) -> Path:
    """Map a scanned relative path back to its file, refusing links anywhere on the way."""
    parts = rel_path.split("/")
    path = child_path(scope, *parts)
    current = scope.root
    for part in parts:
        current = current / part
        try:
            st = os.lstat(current)
        except OSError:
            raise ScopeError("not_found", f"{rel_path} no longer exists.") from None
        if is_link_like(st):
            raise ScopeError("link_in_path", f"{rel_path} is now behind a link or junction; it was not read.")
    return path


def read_bytes(scope: Scope, info: FileInfo) -> bytes:
    """Read-only open ("rb") of a scanned file, refusing a file that was swapped since the walk."""
    path = resolve(scope, info.rel_path)
    with open(path, "rb") as handle:
        if identity_of(os.fstat(handle.fileno())) != info.file_id:
            raise ScopeError("changed_during_read", f"{info.rel_path} was replaced while being read.")
        data = handle.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ScopeError("too_large", f"{info.rel_path} grew beyond the size limit.")
    return data


def decode(data: bytes) -> str | None:
    if b"\x00" in data[:8192]:
        return None
    return data.decode("utf-8", errors="replace").lstrip("﻿")


def redact(line: str) -> str:
    """One line as safe evidence: secret-looking lines are withheld, long lines cut."""
    if contains_secret(line):
        return "[line withheld: matches a secret pattern]"
    line = line.rstrip()
    return line if len(line) <= MAX_LINE_CHARS else line[:MAX_LINE_CHARS] + " …"


def read_all(scope: Scope, scan: Scan) -> dict[str, list[str]]:
    """Read every eligible text file once (bounded) for the deterministic checks. Returns rel_path -> lines."""
    texts: dict[str, list[str]] = {}
    total = 0
    for info in scan.files:
        if info.status == "sensitive":
            continue
        if info.role == "lockfile":
            info.status = "lockfile"
            continue
        if info.role == "other" and posixpath.basename(info.rel_path) not in TEXT_NAMES:
            info.status = "not_text"
            continue
        if info.size > MAX_FILE_BYTES:
            info.status = "too_large"
            continue
        if len(texts) >= MAX_READ_FILES or total + info.size > MAX_READ_BYTES:
            info.status = "limit"
            continue
        try:
            data = read_bytes(scope, info)
        except (ScopeError, OSError):
            info.status = "unreadable"
            continue
        text = decode(data)
        if text is None:
            info.status = "binary"
            continue
        total += len(data)
        info.status, info.sha256 = "read", hashlib.sha256(data).hexdigest()
        lines = text.splitlines()
        info.lines = len(lines)
        info.suspicious = bool(INJECTION.search(text))
        texts[info.rel_path] = lines
    return texts


# ------------------------------------------------------------------ manifests and dependencies


def _line_of(lines: list[str], needle: str) -> int | None:
    pattern = re.compile(rf"""["']?{re.escape(needle)}["']?\s*[:=<>~!\s\[@,]|^\s*{re.escape(needle)}\s*$""")
    for number, line in enumerate(lines, 1):
        if pattern.search(line):
            return number
    return None


def _requirement(spec: str) -> tuple[str, str] | None:
    match = _REQ_NAME.match(spec.split(";")[0])
    return (match.group(1), match.group(3).strip()) if match else None


def parse_manifests(scan: Scan, texts: dict[str, list[str]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    manifests: list[dict[str, Any]] = []
    deps: list[dict[str, Any]] = []

    def dep(path: str, lines: list[str], name: str, spec: str, kind: str) -> None:
        deps.append({"manifest": path, "name": name, "spec": spec, "kind": kind, "line": _line_of(lines, name)})

    for info in scan.files:
        if info.role != "manifest" or info.rel_path not in texts or len(manifests) >= MAX_MANIFESTS:
            continue
        path, lines = info.rel_path, texts[info.rel_path]
        name = posixpath.basename(path)
        text = "\n".join(lines)
        entry: dict[str, Any] = {"path": path, "type": name, "parsed": True}
        try:
            if name == "package.json":
                data = json.loads(text)
                entry.update(name=data.get("name"), main=data.get("main"),
                             scripts=sorted(data.get("scripts", {}))[:20] if isinstance(data.get("scripts"), dict) else [])
                for kind in ("dependencies", "devDependencies", "peerDependencies"):
                    for dep_name, spec in (data.get(kind) or {}).items():
                        dep(path, lines, str(dep_name), str(spec), kind)
            elif name == "pyproject.toml":
                data = tomllib.loads(text)
                project = data.get("project", {})
                entry.update(name=project.get("name"), scripts=sorted(project.get("scripts", {}))[:20])
                for spec in project.get("dependencies", []):
                    if (parsed := _requirement(str(spec))):
                        dep(path, lines, parsed[0], parsed[1], "dependencies")
                for group, specs in project.get("optional-dependencies", {}).items():
                    for spec in specs:
                        if (parsed := _requirement(str(spec))):
                            dep(path, lines, parsed[0], parsed[1], f"optional:{group}")
                for dep_name, spec in data.get("tool", {}).get("poetry", {}).get("dependencies", {}).items():
                    if dep_name.lower() != "python":
                        dep(path, lines, dep_name, json.dumps(spec) if not isinstance(spec, str) else spec, "poetry")
            elif fnmatch.fnmatch(name.lower(), "requirements*.txt"):
                for raw in lines:
                    raw = raw.split("#", 1)[0].strip()
                    if raw and not raw.startswith("-") and (parsed := _requirement(raw)):
                        dep(path, lines, parsed[0], parsed[1], "requirements")
            elif name == "go.mod":
                entry["name"] = next((ln.split()[1] for ln in lines if ln.startswith("module ")), None)
                for ln in lines:
                    parts = ln.strip().removeprefix("require").strip().split()
                    if len(parts) >= 2 and parts[1].startswith("v") and "/" in parts[0]:
                        dep(path, lines, parts[0], parts[1], "require")
            elif name == "Cargo.toml":
                data = tomllib.loads(text)
                entry["name"] = data.get("package", {}).get("name")
                for dep_name, spec in data.get("dependencies", {}).items():
                    dep(path, lines, dep_name, spec if isinstance(spec, str) else json.dumps(spec), "dependencies")
            else:
                entry["parsed"] = False
        except (ValueError, tomllib.TOMLDecodeError, AttributeError, TypeError):
            entry["parsed"] = False
            entry["error"] = "could not be parsed"
        manifests.append(entry)
    return manifests, deps


def frameworks(deps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for d in deps:
        label = FRAMEWORKS.get(d["name"].lower())
        if label and label not in found:
            found[label] = {"label": label, "package": d["name"], "manifest": d["manifest"], "line": d["line"]}
    return sorted(found.values(), key=lambda f: f["label"].lower())


# ------------------------------------------------------------------ architecture


def component(rel: str) -> str:
    parts = rel.split("/")
    if len(parts) == 1:
        return "(root)"
    if parts[0] in CONTAINERS and len(parts) > 2:
        return f"{parts[0]}/{parts[1]}"
    return parts[0]


def _python_modules(files: list[FileInfo]) -> dict[str, str]:
    """Dotted module name -> rel_path, for every Python file (also without a leading src/ container)."""
    index: dict[str, str] = {}
    for f in files:
        if f.language != "Python" or f.status != "read":
            continue
        parts = f.rel_path[:-3].split("/")
        if parts[-1] == "__init__":
            parts = parts[:-1]
        for start in range(len(parts)):
            index.setdefault(".".join(parts[start:]), f.rel_path)
    return index


def import_edges(scan: Scan, texts: dict[str, list[str]]) -> list[dict[str, Any]]:
    """Internal imports (file -> file, with line). Only imports that resolve to a scanned file count."""
    readable = {f.rel_path for f in scan.files if f.status == "read"}
    py_index = _python_modules(scan.files)
    edges: list[dict[str, Any]] = []
    for f in scan.files:
        if f.rel_path not in texts or f.language not in ("Python", "TypeScript", "JavaScript", "Vue", "Svelte"):
            continue
        folder = posixpath.dirname(f.rel_path)
        for number, line in enumerate(texts[f.rel_path], 1):
            targets: list[str] = []
            if f.language == "Python":
                match = _PY_IMPORT.match(line)
                if not match:
                    continue
                if match.group(1) is not None:
                    module = match.group(1)
                    if module.startswith("."):
                        dots = len(module) - len(module.lstrip("."))
                        base = f.rel_path[:-3].split("/")[:-1]
                        base = base[: len(base) - (dots - 1)] if dots > 1 else base
                        module = ".".join([*base, module.lstrip(".")]).strip(".")
                    names = [module]
                else:
                    names = [n.strip() for n in match.group(2).split(",")]
                for name in names:
                    parts = name.split(".")
                    for cut in range(len(parts), 0, -1):
                        hit = py_index.get(".".join(parts[:cut]))
                        if hit:
                            targets.append(hit)
                            break
            else:
                for spec in _JS_IMPORT.findall(line):
                    base = posixpath.normpath(posixpath.join(folder, spec))
                    hit = next((base + ext for ext in _JS_EXTS if base + ext in readable), None)
                    if hit:
                        targets.append(hit)
            for target in targets:
                if target != f.rel_path:
                    edges.append({"from": f.rel_path, "to": target, "line": number})
    return edges


def components(scan: Scan, edges: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    comps: dict[str, dict[str, Any]] = {}
    for f in scan.files:
        if f.role in ("source", "test") and f.status == "read":
            c = comps.setdefault(component(f.rel_path), {"name": component(f.rel_path), "files": 0, "lines": 0,
                                                         "languages": Counter(), "tests": 0})
            c["files"] += 1
            c["lines"] += f.lines or 0
            c["languages"][f.language] += 1
            c["tests"] += f.role == "test"
    links: dict[tuple[str, str], dict[str, Any]] = {}
    for e in edges:
        a, b = component(e["from"]), component(e["to"])
        if a == b:
            continue
        link = links.setdefault((a, b), {"from": a, "to": b, "imports": 0, "example": e})
        link["imports"] += 1
    out = [{**c, "languages": [lang for lang, _ in c["languages"].most_common()]}
           for c in sorted(comps.values(), key=lambda c: -c["lines"])][:25]
    return out, sorted(links.values(), key=lambda link: -link["imports"])[:30]


# ------------------------------------------------------------------ deterministic checks


def _finding(rule: str, title: str, severity: str, path: str | None, line: int | None, excerpt: str | None,
             detail: str, recommendation: str) -> dict[str, Any]:
    return {"rule": rule, "title": title, "severity": severity, "path": path, "line": line, "excerpt": excerpt,
            "detail": detail, "recommendation": recommendation}


def pattern_checks(scan: Scan, texts: dict[str, list[str]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    totals: Counter[str] = Counter()
    markers: list[dict[str, Any]] = []
    marker_count = 0
    by_path = {f.rel_path: f for f in scan.files}
    for path, lines in texts.items():
        info = by_path[path]
        if info.role in ("doc", "lockfile"):
            continue
        for number, line in enumerate(lines, 1):
            for rule, title, languages, pattern, severity, advice in RULES:
                if languages is not None and info.language not in languages:
                    continue
                if rule != "hardcoded-credential" and _COMMENT.match(line):
                    continue
                if pattern.search(line):
                    totals[rule] += 1
                    if totals[rule] <= PER_RULE_LISTED:
                        excerpt = None if rule == "hardcoded-credential" else redact(line).strip()
                        where = "test code" if info.role == "test" else "source"
                        findings.append(_finding(rule, title, severity, path, number, excerpt,
                                                 f"Pattern match in {where}.", advice))
            if info.role in ("source", "test") and MARKER.search(line):
                marker_count += 1
                if len(markers) < 8:
                    markers.append({"path": path, "line": number, "text": redact(line).strip()})
    return findings, {"rule_totals": dict(totals), "marker_count": marker_count, "markers": markers}


def repo_checks(scan: Scan, texts: dict[str, list[str]], deps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    names = {f.rel_path for f in scan.files}
    root_names = {p for p in names if "/" not in p}
    lower_root = {p.lower() for p in root_names}
    if not any(n.startswith("readme") for n in lower_root):
        out.append(_finding("no-readme", "No README at the repository root", "low", None, None, None,
                            "No file named README* was found at the root.",
                            "Add a README with purpose, setup and how to run the tests."))
    if not any(n.startswith(("license", "licence", "copying")) for n in lower_root):
        out.append(_finding("no-license", "No LICENSE file at the repository root", "info", None, None, None,
                            "No LICENSE/COPYING file was found at the root.",
                            "Add a license (or state that the code is proprietary)."))
    if not any(f.role == "test" for f in scan.files):
        out.append(_finding("no-tests", "No automated test files found", "medium", None, None, None,
                            "No file matched common test naming (tests/, test_*.py, *.test.ts, *_test.go …) "
                            "in the inspected area.", "Add automated tests for the main code paths."))
    locks = {posixpath.basename(p) for p in names}
    if "package.json" in root_names and not locks & {"package-lock.json", "yarn.lock", "pnpm-lock.yaml",
                                                      "npm-shrinkwrap.json"}:
        out.append(_finding("no-js-lockfile", "package.json without a lockfile", "medium", "package.json", 1, None,
                            "No package-lock.json, yarn.lock or pnpm-lock.yaml was found.",
                            "Commit a lockfile so installs are reproducible."))
    for d in deps:
        spec = d["spec"].strip()
        unpinned = spec in ("*", "latest", "") if d["kind"] in ("dependencies", "devDependencies") and \
            d["manifest"].endswith("package.json") else (d["kind"] == "requirements" and spec == "")
        if unpinned and len([f for f in out if f["rule"] == "unpinned-dependency"]) < PER_RULE_LISTED:
            out.append(_finding("unpinned-dependency", f"Unpinned dependency `{d['name']}`", "low", d["manifest"],
                                d["line"], None, f"Version specifier is {spec or 'missing'!r}.",
                                "Pin or bound the version so builds are reproducible."))
    ignore = [ln.strip() for ln in texts.get(".gitignore", []) if ln.strip() and not ln.startswith("#")]
    for f in scan.files:
        name = posixpath.basename(f.rel_path).lower()
        if f.status == "sensitive" and (name == ".env" or name.startswith(".env.")):
            covered = any(fnmatch.fnmatch(f.rel_path, p.strip("/")) or fnmatch.fnmatch(name, p.strip("/"))
                          for p in ignore if not p.startswith("!"))
            if not covered:
                out.append(_finding(
                    "env-not-ignored", "Environment file not covered by .gitignore", "high", f.rel_path, None, None,
                    "The file exists and no .gitignore pattern at the root matches it (its content was not opened).",
                    "Add it to .gitignore and check whether it was ever committed."))
    return out


# ------------------------------------------------------------------ model context selection


def entrypoints(scan: Scan, manifests: list[dict[str, Any]]) -> list[str]:
    names = {f.rel_path for f in scan.files if f.status == "read"}
    found = [f.rel_path for f in scan.files if f.status == "read" and posixpath.basename(f.rel_path) in ENTRYPOINT_NAMES
             and f.role == "source"]
    for m in manifests:
        main = m.get("main")
        if isinstance(main, str):
            candidate = posixpath.normpath(posixpath.join(posixpath.dirname(m["path"]), main))
            if candidate in names and candidate not in found:
                found.insert(0, candidate)
    return found[:15]


def select_context(scan: Scan, texts: dict[str, list[str]], findings: list[dict[str, Any]],
                   edges: list[dict[str, Any]], entries: list[str]) -> list[dict[str, Any]]:
    """Choose bounded line windows for the model. Every window is listed in the plan before approval."""
    inbound = Counter(e["to"] for e in edges)
    flagged: dict[str, int] = {}
    for f in findings:
        if f["path"] in texts and f["line"]:
            flagged.setdefault(f["path"], f["line"])
    scored: list[tuple[float, str, str]] = []
    for info in scan.files:
        if info.rel_path not in texts or info.role in ("lockfile", "manifest"):
            continue
        name = posixpath.basename(info.rel_path).lower()
        depth = info.rel_path.count("/")
        if "/" not in info.rel_path and name.startswith("readme"):
            score, why = 100.0, "README"
        elif info.rel_path in entries:
            score, why = 80.0, "entry point"
        elif info.rel_path in flagged:
            score, why = 60.0, "has a pattern-check match"
        elif info.role == "source":
            score, why = 40.0 + min(inbound[info.rel_path] * 5, 30), "source" + (
                f", imported by {inbound[info.rel_path]} file(s)" if inbound[info.rel_path] else "")
        elif info.role == "test":
            score, why = 15.0, "test"
        elif info.role == "config":
            score, why = 12.0, "configuration"
        else:
            continue
        scored.append((score - depth * 2 - (5 if info.suspicious else 0), info.rel_path, why))
    chosen: list[dict[str, Any]] = []
    budget = FILE_CONTEXT_CHARS
    for score, path, why in sorted(scored, key=lambda s: (-s[0], s[1])):
        if len(chosen) >= MAX_CONTEXT_FILES or budget < 400:
            break
        lines = texts[path]
        if not lines:
            continue
        if path in flagged:
            start = max(1, flagged[path] - WINDOW_LINES // 2)
            end = min(len(lines), start + WINDOW_LINES - 1)
        else:
            start, end = 1, min(len(lines), HEAD_LINES)
        size = 0
        for number in range(start, end + 1):
            size += len(redact(lines[number - 1])) + 8
            if size > min(MAX_FILE_EXCERPT_CHARS, budget):
                end = max(start, number - 1)
                break
        size = sum(len(redact(lines[n - 1])) + 8 for n in range(start, end + 1))
        budget -= size
        chosen.append({"id": f"F{len(chosen) + 1}", "path": path, "start": start, "end": end, "total_lines": len(lines),
                       "reason": why, "chars": size})
    return chosen


def excerpt(lines: list[str], start: int, end: int) -> str:
    return "\n".join(f"L{n}: {redact(lines[n - 1])}" for n in range(start, min(end, len(lines)) + 1))


# ------------------------------------------------------------------ facade


def inspect(scope: Scope) -> tuple[dict[str, Any], dict[str, Any]]:
    """Full deterministic scan. Returns (plan facts shown to the user, internal data incl. the snapshot)."""
    scan = walk(scope)
    texts = read_all(scope, scan)
    manifests, deps = parse_manifests(scan, texts)
    edges = import_edges(scan, texts)
    comps, links = components(scan, edges)
    found, markers = pattern_checks(scan, texts)
    found = repo_checks(scan, texts, deps) + found
    for index, item in enumerate(found, 1):
        item["id"] = f"D{index}"
    entries = entrypoints(scan, manifests)
    context = select_context(scan, texts, found, edges, entries)
    languages: dict[str, dict[str, int]] = {}
    for f in scan.files:
        if f.language and f.status == "read":
            lang = languages.setdefault(f.language, {"files": 0, "lines": 0})
            lang["files"] += 1
            lang["lines"] += f.lines or 0
    status_counts = Counter(f.status for f in scan.files)
    tests = [f.rel_path for f in scan.files if f.role == "test"]
    facts = {
        "files_seen": len(scan.files),
        "files_read": status_counts.get("read", 0),
        "file_status": dict(status_counts),
        "excluded": dict(scan.excluded),
        "excluded_paths": scan.excluded_paths,
        "truncated": scan.truncated,
        "languages": dict(sorted(languages.items(), key=lambda kv: -kv[1]["lines"])),
        "manifests": manifests,
        "dependencies": deps[:200],
        "dependency_count": len(deps),
        "frameworks": frameworks(deps),
        "entrypoints": entries,
        "tests": {"files": len(tests), "examples": tests[:8]},
        "components": comps,
        "relationships": links,
        "findings": found,
        "pattern_totals": markers["rule_totals"],
        "markers": {"count": markers["marker_count"], "examples": markers["markers"]},
        "suspicious_files": [f.rel_path for f in scan.files if f.suspicious][:20],
        "context": context,
        "limits": {"max_file_bytes": MAX_FILE_BYTES, "max_read_files": MAX_READ_FILES, "max_read_bytes": MAX_READ_BYTES,
                   "max_inventory": MAX_INVENTORY, "max_context_files": MAX_CONTEXT_FILES,
                   "file_context_chars": FILE_CONTEXT_CHARS},
    }
    readme = next((p for p in texts if "/" not in p and p.lower().startswith("readme")), None)
    internal = {
        "readme": " ".join(redact(line) for line in texts[readme][:30])[:600] if readme else "",
        "snapshot": snapshot(scan),
        "files": {f.rel_path: asdict(f) for f in scan.files if f.status == "read"},
    }
    return facts, internal


def file_info(data: dict[str, Any]) -> FileInfo:
    return FileInfo(**data)
