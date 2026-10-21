"""Evidence selection, citation verification and report rendering for research tasks.

Everything here is deterministic. The model only proposes findings, each with
the passage ids it relies on and a verbatim quote; this module decides what
those findings are worth:

  supported    every cited id exists, the quote occurs in a cited passage and the
               claim's content words (and every number in it) occur there too
  weak         cited passages exist but the quote or the wording/numbers do not match well
  unsupported  cited passages exist but share almost nothing with the claim
  removed      no cited id refers to a retrieved passage (never shown as a finding)

The Markdown is rendered from these records, never written by the model, so
every link in a report is a URL that was actually fetched.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

PASSAGE_CHARS = 700
MAX_EVIDENCE = 12
MAX_PER_SOURCE = 4
SUPPORT_OVERLAP = 0.5
MIN_QUOTE_CHARS = 20

_STOPWORDS = frozenset(
    "the and for are but not you all any can had her was one our out has have this that with from they will "
    "would there their what which when where who whom why how about into than then them these those such also "
    "its it's more most other some very just only over under been being were does did doing should could may "
    "might must shall each both few many much own same so too again further once here between through during "
    "before after above below off upon while because until against within without".split()
)
_WORD = re.compile(r"[a-z0-9]+(?:[.,][0-9]+)?")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
INJECTION = re.compile(
    r"(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?)"
    r"|\bsystem\s+prompt\b|\byou\s+are\s+now\b|\bdeveloper\s+mode\b|\bnew\s+instructions\s*:",
    re.IGNORECASE,
)

FindingStatus = Literal["supported", "weak", "unsupported", "removed"]


@dataclass(frozen=True)
class Passage:
    id: str
    source_label: str
    text: str


@dataclass
class Finding:
    id: str
    claim: str
    citations: list[str]
    invalid_citations: list[str]
    quote: str
    status: FindingStatus
    reasons: list[str] = field(default_factory=list)


def normalize(text: str) -> str:
    text = text.casefold().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    text = re.sub(r"[‐-―]", "-", text)
    return re.sub(r"\s+", " ", text).strip(" .,;:\"'")


def content_words(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.casefold()) if (len(w) >= 3 or w[0].isdigit()) and w not in _STOPWORDS]


def split_passages(source_label: str, text: str, max_chars: int = PASSAGE_CHARS) -> list[Passage]:
    """Paragraph-based chunks of at most ~max_chars, ids S<n>-P<k> (stable for a given text)."""
    pieces: list[str] = []
    for para in (p.strip() for p in re.split(r"\n\s*\n|\n", text)):
        if not para:
            continue
        while len(para) > max_chars:
            cut = para.rfind(". ", 0, max_chars)
            cut = cut + 1 if cut > max_chars // 3 else max_chars
            pieces.append(para[:cut].strip())
            para = para[cut:].strip()
        if para:
            pieces.append(para)
    merged: list[str] = []
    for piece in pieces:
        if merged and len(merged[-1]) + len(piece) + 1 <= max_chars and len(merged[-1]) < max_chars // 2:
            merged[-1] = f"{merged[-1]}\n{piece}"
        else:
            merged.append(piece)
    return [Passage(f"{source_label}-P{i}", source_label, chunk) for i, chunk in enumerate(merged, 1)]


def select_evidence(
    passages: list[Passage], terms: list[str], max_total: int = MAX_EVIDENCE, max_per_source: int = MAX_PER_SOURCE
) -> tuple[list[Passage], bool]:
    """Rank passages by TF-IDF overlap with the plan's terms. Returns (selected, low_relevance)."""
    query = set(content_words(" ".join(terms)))
    docs = [Counter(content_words(p.text)) for p in passages]
    df = Counter(word for doc in docs for word in set(doc) if word in query)
    n = len(passages)
    scored = []
    for index, (passage, doc) in enumerate(zip(passages, docs)):
        score = sum((1 + math.log(doc[w])) * math.log(1 + n / df[w]) for w in query if doc[w])
        scored.append((score, index, passage))
    low_relevance = not any(score > 0 for score, _, _ in scored)
    if low_relevance:
        # Nothing matches the terms: fall back to each source's opening passages and say so in the report.
        scored = [(-float(p.id.rsplit("P", 1)[1]), index, p) for index, p in enumerate(passages)]
    per_source: Counter[str] = Counter()
    chosen: list[tuple[int, Passage]] = []
    for score, index, passage in sorted(scored, key=lambda item: (-item[0], item[1])):
        if len(chosen) >= max_total:
            break
        if (score <= 0 and not low_relevance) or per_source[passage.source_label] >= max_per_source:
            continue
        per_source[passage.source_label] += 1
        chosen.append((index, passage))
    return [p for _, p in sorted(chosen, key=lambda item: item[0])], low_relevance


def verify_finding(
    finding_id: str, claim: str, cited: list[str], quote: str, passages: dict[str, Passage]
) -> Finding:
    valid = [c for c in dict.fromkeys(cited) if c in passages]
    invalid = [c for c in dict.fromkeys(cited) if c not in passages]
    if not valid:
        return Finding(finding_id, claim, [], invalid, quote, "removed", ["No citation refers to a retrieved passage."])
    reasons: list[str] = []
    if invalid:
        reasons.append(f"Ignored citations to passages that do not exist: {', '.join(invalid)}.")
    cited_text = normalize(" ".join(passages[c].text for c in valid))
    nq = normalize(quote)
    quote_found = len(nq) >= MIN_QUOTE_CHARS and nq in cited_text
    if not quote_found:
        reasons.append("The quoted text was not found verbatim in the cited passages.")
    words = content_words(claim)
    passage_words = set(content_words(cited_text))
    overlap = sum(w in passage_words for w in words) / len(words) if words else 0.0
    missing_numbers = [n for n in _NUMBER.findall(claim) if n not in cited_text]
    if missing_numbers:
        reasons.append(f"Numbers in the claim not found in the cited passages: {', '.join(missing_numbers)}.")
    if overlap < SUPPORT_OVERLAP:
        reasons.append(f"Only {overlap:.0%} of the claim's key words appear in the cited passages.")
    if quote_found and overlap >= SUPPORT_OVERLAP and not missing_numbers:
        status: FindingStatus = "supported"
    elif quote_found or overlap >= SUPPORT_OVERLAP:
        status = "weak"
    else:
        status = "unsupported"
    return Finding(finding_id, claim, valid, invalid, quote, status, reasons)


def suspicious(text: str) -> bool:
    """Text that addresses an AI assistant (prompt injection). Flagged in the report; never obeyed."""
    return bool(INJECTION.search(text))


# --------------------------------------------------------------------------- Markdown

_MD_SPECIAL = re.compile(r"([\\`*_\[\]<>#|!~])")


def md_text(text: str) -> str:
    """Untrusted text as inert inline Markdown: no links, HTML, emphasis or line breaks."""
    return _MD_SPECIAL.sub(r"\\\1", re.sub(r"\s+", " ", text).strip())


def md_url(url: str) -> str:
    return "<" + url.replace(" ", "%20").replace("<", "%3C").replace(">", "%3E").replace("|", "%7C") + ">"


def md_code(text: str) -> str:
    """Inert, non-clickable text (for URLs that were NOT fetched)."""
    return "`" + re.sub(r"\s+", " ", text).replace("`", "%60").replace("|", "%7C") + "`"


_LABELS = {"supported": "Supported", "weak": "Weak support", "unsupported": "Unsupported"}


def render_markdown(report: dict[str, Any]) -> str:
    findings = [Finding(**f) for f in report["findings"]]
    sources = report["sources"]
    by_label = {s["label"]: s for s in sources}
    used = [s for s in sources if s["status"] == "extracted"]
    other = [s for s in sources if s["status"] != "extracted"]
    meta = report["metadata"]

    def cite(f: Finding) -> str:
        labels = dict.fromkeys(c.split("-P", 1)[0] for c in f.citations)
        return " ".join(f"[{label}]" for label in labels)

    out = [f"# Research report: {md_text(report['question'])}", ""]
    out += [
        f"_Generated by AEGIS on {report['generated_at']} from {len(used)} retrieved source(s). "
        "Only the sources listed below were read. Each finding was checked automatically against the "
        "retrieved text; the check catches missing quotes, words and numbers but cannot prove a claim is true._",
        "",
        "## Research question",
        "",
        md_text(report["question"]),
        "",
        "## Findings",
        "",
    ]
    supported = [f for f in findings if f.status == "supported"]
    out += [f"- {md_text(f.claim)} {cite(f)}" for f in supported] or [
        "_No finding passed the supporting-text check. See the sections below._"
    ]
    review = [f for f in findings if f.status in ("weak", "unsupported")]
    if review:
        out += ["", "## Findings that need review", ""]
        out += [
            f"- **{_LABELS[f.status]}:** {md_text(f.claim)} {cite(f)} — {md_text(' '.join(f.reasons))}"
            for f in review
        ]
    removed = [f for f in findings if f.status == "removed"]
    if removed:
        out += ["", "## Claims removed (no valid citation)", ""]
        out += [f"- {md_text(f.claim)}" for f in removed]
    shown = [f for f in findings if f.status != "removed" and f.quote]
    if shown:
        out += ["", "## Supporting evidence", ""]
        for f in shown:
            labels = list(dict.fromkeys(c.split("-P", 1)[0] for c in f.citations))
            title = by_label[labels[0]]["title"] or by_label[labels[0]]["canonical_url"]
            out += [
                f"**{f.id}** ({_LABELS[f.status]}) — {', '.join(f.citations)}, {md_text(title)}",
                "",
                f"> {md_text(f.quote)}",
                "",
            ]
    out += ["", "## Sources", "", "| ID | Title | Fetched URL | Retrieved (UTC) | Content SHA-256 |", "|---|---|---|---|---|"]
    for s in used:
        out.append(
            f"| {s['label']} | {md_text(s['title'] or '(untitled)')} | {md_url(s['final_url'])} | "
            f"{s['retrieved_at']} | `{s['sha256'][:16]}…` |"
        )
    if other:
        out += ["", "### Sources not used", "", "| ID | URL | Status | Reason |", "|---|---|---|---|"]
        for s in other:
            out.append(
                f"| {s['label']} | {md_code(s['requested_url'])} | {s['status']} | {md_text(s['detail'] or '')} |"
            )
    out += ["", "## Limitations and uncertainties", ""]
    out += [f"- {md_text(item)}" for item in report["limitations"]]
    out += [f"- Model-reported uncertainty: {md_text(item)}" for item in report["uncertainties"]]
    out += ["", "## Execution metadata", ""]
    out += [f"- {md_text(key)}: {md_text(str(value))}" for key, value in meta.items()]
    return "\n".join(out) + "\n"


def finding_dict(finding: Finding) -> dict[str, Any]:
    return asdict(finding)
