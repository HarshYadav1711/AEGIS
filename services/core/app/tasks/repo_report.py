"""Verification and rendering for repository investigation reports.

The model proposes components, findings and hypotheses. This module decides,
deterministically, what each is worth; a model opinion is never verification:

  confirmed              (report key; shown as "Pattern detected") a match of AEGIS's own deterministic checks
                         (repo_scan), never the model: the pattern occurs at that line, which is not a confirmed
                         or exploited vulnerability
  likely_issue           model 'issue' whose cited lines exist in the excerpt it was shown and whose quote
                         occurs verbatim in those lines of the real file
  plausible_concern      model 'concern' with the same evidence check passed
  best_practice          model 'practice' with the same evidence check passed
  insufficient_evidence  cited file exists but the lines/quote do not check out, the cited lines share nothing
                         with the claim, or the claim names a different file than the one cited
  removed                cites a file id that was never shown to the model (not reported as a finding)

A matching quote proves only that the quote occurs at that location, not that the claim is right. Each checked
model finding therefore also gets a `support` level from a lexical test (not a semantic entailment model):

  supported      the quote contains what the claim's title names, and the claim is not worded more broadly
                 (scope, exploitability) than one location can show; still a model statement, not proof
  needs_review   location and quote are real, but code could not tie them to the claim; a human must judge

Hypotheses stay hypotheses: they are shown with their supporting and
contradicting points and verification steps, labelled unverified.
The Markdown is rendered here from these records; the model never writes it.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.tasks.research_report import content_words, md_code, md_text

MAX_FINDINGS = 8
MAX_SPAN_LINES = 60
MIN_QUOTE_CHARS = 4
_LINE_PREFIX = re.compile(r"(^|\n)\s*L\d+:\s?")

CATEGORY_STATUS = {"issue": "likely_issue", "concern": "plausible_concern", "practice": "best_practice"}
LABELS = {
    "confirmed": "Pattern detected (deterministic check; not a confirmed vulnerability)",
    "likely_issue": "Likely issue (model; cited location and quote checked)",
    "plausible_concern": "Plausible concern (model; cited location and quote checked)",
    "best_practice": "General best practice (model; cited location and quote checked)",
    "insufficient_evidence": "Insufficient evidence",
    "supported": "Quote supports the narrow observation (lexical check, not proof)",
    "needs_review": "Requires review: the quote is real, but it was not established that it supports the claim",
}
# Claim words that code usually spells differently. Deliberately small: a lexical aid, not a semantic model.
_ALIASES = {
    "sql": {"select", "insert", "update", "delete", "execute", "executemany", "cursor", "sqlite3", "query"},
    "error": {"except", "catch", "raise", "throw"}, "errors": {"except", "catch", "raise", "throw"},
    "exception": {"except", "catch"}, "exceptions": {"except", "catch"},
    "credential": {"password", "secret", "token", "key"}, "credentials": {"password", "secret", "token", "key"},
    "shell": {"subprocess", "popen", "system"},
    "input": {"request", "args", "params", "argv", "body"},
}
# Wording that claims more than one quoted location can show (scope), or impact nobody observed.
_BROAD = re.compile(r"\b(all|every\w*|entire|whole|throughout|everywhere|anywhere|always|never|across|codebase|"
                    r"project-wide|repository-wide|systemic\w*|consistently)\b", re.IGNORECASE)
_IMPACT = re.compile(r"\b(exploit\w*|attackers?|arbitrary|remote code|compromis\w*|takeover|breach\w*|"
                     r"(?:is|are) vulnerable|confirmed)\b", re.IGNORECASE)
_FILE_NAME = re.compile(r"(?<![\w/.-])((?:[\w.-]+/)*[\w-]+\.(?:py|pyi|js|jsx|mjs|cjs|ts|tsx|json|toml|ya?ml|cfg|"
                        r"ini|md|rs|go|java|rb|php|cs|cpp|hpp|vue|svelte|sh|ps1))\b")


class _Component(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=120)
    responsibility: str = Field(max_length=600)
    file_ids: list[str] = Field(default_factory=list, max_length=12)


class _Finding(BaseModel):
    model_config = ConfigDict(extra="ignore")
    category: Literal["issue", "concern", "practice"]
    title: str = Field(min_length=1, max_length=300)
    detail: str = Field(max_length=1200)
    file_id: str
    start_line: int
    end_line: int
    quote: str = Field(max_length=600)
    recommendation: str = Field(max_length=800)


class _Explanation(BaseModel):
    model_config = ConfigDict(extra="ignore")
    explanation: str = Field(min_length=1, max_length=600)
    supporting: str = Field(max_length=600)
    contradicting: str = Field(max_length=600)


class _Hypothesis(BaseModel):
    model_config = ConfigDict(extra="ignore")
    problem: str = Field(min_length=1, max_length=400)
    explanations: list[_Explanation] = Field(max_length=4)
    verification_steps: list[str] = Field(max_length=6)


class ModelReply(BaseModel):
    model_config = ConfigDict(extra="ignore")
    summary: str = Field(max_length=2400)
    components: list[_Component] = Field(max_length=12)
    findings: list[_Finding] = Field(max_length=16)
    hypotheses: list[_Hypothesis] = Field(max_length=4)
    uncertainties: list[str] = Field(max_length=10)


REPLY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "components": {"type": "array", "maxItems": 8, "items": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "responsibility": {"type": "string"},
                           "file_ids": {"type": "array", "items": {"type": "string"}}},
            "required": ["name", "responsibility", "file_ids"]}},
        "findings": {"type": "array", "maxItems": MAX_FINDINGS, "items": {
            "type": "object",
            "properties": {"category": {"type": "string", "enum": ["issue", "concern", "practice"]},
                           "title": {"type": "string"}, "detail": {"type": "string"},
                           "file_id": {"type": "string"}, "start_line": {"type": "integer"},
                           "end_line": {"type": "integer"}, "quote": {"type": "string"},
                           "recommendation": {"type": "string"}},
            "required": ["category", "title", "detail", "file_id", "start_line", "end_line", "quote",
                         "recommendation"]}},
        "hypotheses": {"type": "array", "maxItems": 2, "items": {
            "type": "object",
            "properties": {"problem": {"type": "string"},
                           "explanations": {"type": "array", "maxItems": 3, "items": {
                               "type": "object",
                               "properties": {"explanation": {"type": "string"}, "supporting": {"type": "string"},
                                              "contradicting": {"type": "string"}},
                               "required": ["explanation", "supporting", "contradicting"]}},
                           "verification_steps": {"type": "array", "items": {"type": "string"}}},
            "required": ["problem", "explanations", "verification_steps"]}},
        "uncertainties": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "components", "findings", "hypotheses", "uncertainties"],
}


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", _LINE_PREFIX.sub(" ", text)).strip().casefold().strip(" .,;:\"'`")


def _terms(text: str) -> set[str]:
    return set(content_words(text.replace("_", " ")))


def _matches(word: str, terms: set[str]) -> bool:
    """Same word, a shared stem of 4+ letters (evaluated/eval, errors/error) or a listed alias."""
    if word in terms or terms & _ALIASES.get(word, set()):
        return True
    return any(min(len(word), len(t)) >= 4 and (word.startswith(t) or t.startswith(word)) for t in terms)


def _support(f: _Finding, path: str, window: str, quote: str, excerpt: str) -> tuple[str | None, list[str]]:
    """How far a quote that occurs at the cited lines backs the claim: None (insufficient), 'needs_review' or
    'supported', with the reasons. Lexical only: it can reject clearly unrelated evidence, not prove a claim."""
    claim = f"{f.title} {f.detail}"
    named = {m.casefold() for m in _FILE_NAME.findall(claim)}
    cited = path.casefold()
    if named and not any(cited == n or cited.endswith("/" + n.rsplit("/", 1)[-1]) for n in named):
        return None, [f"The claim refers to {', '.join(sorted(named))}, but the quotation is from {path}; the "
                      "evidence is attributed to the wrong file."]
    claim_terms, quote_terms, window_terms = _terms(claim), _terms(quote), _terms(window)
    if not any(_matches(w, window_terms) for w in claim_terms):
        return None, ["The quotation occurs at the cited lines, but those lines share no term with the claim, so "
                      "they are not evidence for it."]
    reasons = []
    if broad := _BROAD.search(claim):
        reasons.append(f"The claim is worded more broadly ('{broad.group(0)}') than one quoted location can show.")
    if impact := _IMPACT.search(claim):
        reasons.append(f"The claim asserts impact or confirmation ('{impact.group(0)}') that static lines cannot "
                       "show; nothing was run or exploited.")
    # Title words that occur in the shown code name code ('eval', 'sql' -> SELECT); prose words ('called') do not.
    excerpt_terms = _terms(excerpt)
    named_code = [w for w in _terms(f.title) if _matches(w, excerpt_terms)]
    if not named_code or not all(_matches(w, quote_terms) for w in named_code):
        reasons.append("The quote is real, but it does not contain what the claim names; check that it shows the "
                       "problem described.")
    return ("needs_review" if reasons else "supported"), reasons


def verify_finding(finding_id: str, f: _Finding, excerpts: dict[str, dict[str, Any]],
                   lines: dict[str, list[str]]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": finding_id, "category": f.category, "title": " ".join(f.title.split()),
        "detail": " ".join(f.detail.split()), "recommendation": " ".join(f.recommendation.split()),
        "quote": " ".join(f.quote.split())[:400], "path": None, "start_line": None, "end_line": None, "reasons": [],
        "support": None,
    }
    shown = excerpts.get(f.file_id.strip())
    if shown is None:
        return {**out, "status": "removed", "reasons": [f"Cites {f.file_id!r}, which was not shown to the model."]}
    start, end = sorted((f.start_line, f.end_line))
    out.update(path=shown["path"], start_line=start, end_line=end)
    if start < shown["start"] or end > shown["end"] or end - start > MAX_SPAN_LINES:
        out["reasons"].append(f"Cited lines {start}-{end} are outside the excerpt shown "
                              f"(lines {shown['start']}-{shown['end']}).")
        return {**out, "status": "insufficient_evidence"}
    file_lines = lines.get(shown["path"], [])
    window = _norm("\n".join(file_lines[max(0, start - 3): end + 2]))
    quote = _norm(f.quote)
    if len(quote) < MIN_QUOTE_CHARS or quote not in window:
        elsewhere = [e["path"] for e in excerpts.values() if len(quote) >= MIN_QUOTE_CHARS and e["path"] != shown["path"]
                     and quote in _norm("\n".join(lines.get(e["path"], [])[e["start"] - 1: e["end"]]))]
        out["reasons"].append("The quoted code was not found in the cited lines of the file"
                              + (f"; it occurs in {', '.join(elsewhere)} instead." if elsewhere else "."))
        return {**out, "status": "insufficient_evidence"}
    excerpt = "\n".join(file_lines[shown["start"] - 1: shown["end"]])
    support, reasons = _support(f, shown["path"], window, quote, excerpt)
    out["reasons"] += reasons
    if support is None:
        return {**out, "status": "insufficient_evidence"}
    return {**out, "status": CATEGORY_STATUS[f.category], "support": support}


def verify_components(reply: ModelReply, excerpts: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for c in reply.components[:8]:
        paths = list(dict.fromkeys(excerpts[i.strip()]["path"] for i in c.file_ids if i.strip() in excerpts))
        invalid = [i for i in c.file_ids if i.strip() not in excerpts]
        out.append({"name": " ".join(c.name.split()), "responsibility": " ".join(c.responsibility.split()),
                    "paths": paths, "invalid_refs": invalid[:6]})
    return out


def hypotheses(reply: ModelReply) -> list[dict[str, Any]]:
    return [{
        "problem": " ".join(h.problem.split()),
        "explanations": [{k: " ".join(getattr(e, k).split()) for k in ("explanation", "supporting", "contradicting")}
                         for e in h.explanations[:3]],
        "verification_steps": [" ".join(s.split())[:300] for s in h.verification_steps[:4] if s.strip()],
    } for h in reply.hypotheses[:2]]


# --------------------------------------------------------------------------- Markdown


def _ref(path: str | None, start: int | None, end: int | None = None) -> str:
    if not path:
        return "(repository)"
    if not start:
        return md_code(path)
    return md_code(f"{path}:{start}" + (f"-{end}" if end and end != start else ""))


def render_markdown(report: dict[str, Any]) -> str:
    facts = report["facts"]
    out = [f"# Repository investigation: {md_text(report['repo_name'])}", ""]
    out += [
        f"_Generated by AEGIS on {report['generated_at']}. Read-only: no repository code, script, test, build or "
        "package manager was run, and nothing in the repository was written. Deterministic checks report detected "
        "patterns, not confirmed or exploited vulnerabilities. Model statements are labelled by how much of their "
        "evidence the code could check: a real quote at the cited lines proves only that the code is there, so each "
        "is marked either as supporting the narrow observation or as requiring review. A model opinion is not "
        "verification._",
        "", "## Request", "", md_text(report["request"]), "",
        "## Summary (written by the model)", "", md_text(report["summary"]) or "_The model gave no summary._", "",
        "## Repository facts (deterministic)", "",
    ]
    langs = ", ".join(f"{md_text(k)} ({v['files']} files, {v['lines']} lines)" for k, v in facts["languages"].items())
    out.append(f"- Languages: {langs or 'none detected'}")
    fws = ", ".join(f"{md_text(f['label'])} ({_ref(f['manifest'], f['line'])})" for f in facts["frameworks"])
    out.append(f"- Frameworks and key libraries (from manifests): {fws or 'none detected'}")
    out.append(f"- Manifests: {', '.join(md_code(m['path']) for m in facts['manifests']) or 'none'}; "
               f"{facts['dependency_count']} declared dependencies")
    out.append(f"- Entry points: {', '.join(md_code(p) for p in facts['entrypoints']) or 'none identified'}")
    out.append(f"- Test files: {facts['tests']['files']}"
               + (f" (e.g. {', '.join(md_code(p) for p in facts['tests']['examples'][:4])})" if facts["tests"]["files"] else ""))
    out.append(f"- TODO/FIXME/HACK markers: {facts['markers']['count']}")
    out += ["", "## Architecture", "", "### Components (from the file tree)", "",
            "| Component | Files | Lines | Languages | Test files |", "|---|---|---|---|---|"]
    out += [f"| {md_code(c['name'])} | {c['files']} | {c['lines']} | {md_text(', '.join(c['languages']))} | {c['tests']} |"
            for c in facts["components"]] or ["| (none) | | | | |"]
    out += ["", "### Relationships (internal imports, deterministic)", ""]
    out += [f"- {md_code(r['from'])} → {md_code(r['to'])}: {r['imports']} import(s), e.g. "
            f"{_ref(r['example']['from'], r['example']['line'])}" for r in facts["relationships"]] or [
        "- No cross-component imports were resolved."]
    if report["components"]:
        out += ["", "### Component roles (model, file references checked)", ""]
        for c in report["components"]:
            refs = ", ".join(md_code(p) for p in c["paths"]) or "no valid file reference"
            out.append(f"- **{md_text(c['name'])}**: {md_text(c['responsibility'])} ({refs})")
    out += ["", "## Detected patterns (deterministic checks)", "",
            "_A match shows that this pattern (or absence) occurs at that location. It is not a confirmed, reproduced "
            "or exploited vulnerability; whether it is a defect in context needs a human review. Severity applies "
            "only if the match is a real problem._", ""]
    out += [f"- **{f['id']} {md_text(f['title'])}** [pattern; severity if real: {f['severity']}] "
            f"{_ref(f['path'], f['line'])}"
            + (f" — `{f['excerpt'].replace('`', '´')}`" if f.get("excerpt") else "")
            + f" — {md_text(f['detail'])} Recommendation: {md_text(f['recommendation'])}"
            for f in report["confirmed"]] or ["- None of the deterministic checks matched."]
    headings = {"likely_issue": "Likely issues (model; cited location and quote checked)",
                "plausible_concern": "Plausible concerns (model; cited location and quote checked)",
                "best_practice": "General best practices (model; cited location and quote checked)"}
    for status, heading in headings.items():
        items = [f for f in report["model_findings"] if f["status"] == status]
        out += ["", f"## {heading}", ""]
        out += [f"- **{f['id']} {md_text(f['title'])}** {_ref(f['path'], f['start_line'], f['end_line'])} — "
                f"_{LABELS[f.get('support') or 'needs_review']}._ {md_text(f['detail'])} "
                f"Evidence: {md_code(f['quote'])}"
                + (f" Review note: {md_text(' '.join(f['reasons']))}" if f["reasons"] else "")
                + f" Recommendation: {md_text(f['recommendation'])}"
                for f in items] or ["- None."]
    if report["hypotheses"]:
        out += ["", "## Hypotheses (unverified; competing explanations)", ""]
        for h in report["hypotheses"]:
            out.append(f"- **Observed:** {md_text(h['problem'])}")
            for e in h["explanations"]:
                out.append(f"  - Explanation: {md_text(e['explanation'])} Supporting: {md_text(e['supporting'])} "
                           f"Contradicting: {md_text(e['contradicting'])}")
            out += [f"  - Verify by: {md_text(s)}" for s in h["verification_steps"]]
    weak = [f for f in report["model_findings"] if f["status"] in ("insufficient_evidence", "removed")]
    if weak:
        out += ["", "## Model statements with insufficient evidence", ""]
        out += [f"- {md_text(f['title'])} ({'removed' if f['status'] == 'removed' else 'not verified'}): "
                f"{md_text(' '.join(f['reasons']))}" for f in weak]
    out += ["", "## Memory and notes considered", ""]
    out += [f"- Memory {m['ref']} ({md_text(m['label'])}, {m['scope']}, recorded {m['recorded_at'][:10]}, "
            f"version {m['version']}): \"{md_text(m['content'])}\" — {md_text(m['check'])}" for m in report["memory"]] or [
        "- No current memory matched this investigation."]
    out += [f"- Vault note {md_code(n['rel_path'])} ({'AEGIS-written' if n['author'] == 'aegis_user' else 'user-written'}, "
            f"version {n['version']}, SHA-256 {n['sha256'][:12]}…): {md_text(n['status'])}"
            + (f" — {md_text(n['detail'])}" if n.get("detail") else "") for n in report["vault"]]
    out.append("- Memory and notes are reference data only; repository evidence takes precedence and they grant "
               "no permissions.")
    out += ["", "## Coverage and exclusions", ""]
    status = facts["file_status"]
    out.append(f"- Files seen: {facts['files_seen']}; read by the checks: {facts['files_read']}; "
               f"excerpts given to the model: {len(report['excerpts'])} "
               f"({', '.join(md_code(e['path'] + ':' + str(e['start']) + '-' + str(e['end'])) for e in report['excerpts'])})")
    out.append("- Not read: " + (", ".join(f"{k} {v}" for k, v in status.items() if k != "read") or "none"))
    out.append("- Excluded without reading: " + (", ".join(f"{k} {v}" for k, v in facts["excluded"].items()) or "none"))
    sensitive = [p["path"] for p in facts["excluded_paths"] if p["reason"].startswith("sensitive")]
    if sensitive:
        out.append(f"- Sensitive files present (content never opened): {', '.join(md_code(p) for p in sensitive)}")
    out += ["", "## Limitations", ""]
    out += [f"- {md_text(item)}" for item in report["limitations"]]
    out += [f"- Model-reported uncertainty: {md_text(item)}" for item in report["uncertainties"]]
    out += ["", "## Verification", ""]
    v = report["verification"]
    out.append(f"- Repository unchanged during the investigation: {'yes' if v['unchanged'] else 'NO'} "
               f"({v['entries']} entries compared by size and modification time)"
               + ("" if v["unchanged"] else f"; changed {v['changed']}, added {v['added']}, removed {v['removed']}"))
    out.append(f"- Excerpt files re-read and hash-checked before use: {v['excerpts_verified']} of {len(report['excerpts'])}")
    out += ["", "## Execution metadata", ""]
    out += [f"- {md_text(key)}: {md_text(str(value))}" for key, value in report["metadata"].items()]
    return "\n".join(out) + "\n"
