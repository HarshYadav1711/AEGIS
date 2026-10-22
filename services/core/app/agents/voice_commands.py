"""Deterministic interpretation of a spoken (transcribed) message (Phase 5).

No model is called here. The text is classified by fixed patterns into:

  chat       an ordinary request; goes through the normal conversation routing
  recall     a question about what AEGIS remembers; same routing, labelled
  remember   an explicit "Remember ..." statement; always shown for review first
  correct    "Correct that memory: ..."; resolved to one current memory and a proposed new
             version that the user reviews and applies (existing revision system)
  forget     a request to delete/forget memory; refused by voice (destructive)
  approval   "approve / go ahead / proceed ..."; voice can never approve a plan
  empty      nothing usable

Spoken input that touches memory is categorised (AHI-inspired, smallest resolution):

  explicit_correction  the user states what the memory should say -> reviewed revision
  project_exception    the user narrows where it applies -> reviewed revision that keeps the
                       original text and adds the user's qualification verbatim
  temporary            a time-limited instruction -> not stored as permanent memory by default
  transcription_doubt  the speech engine reported low confidence -> review before anything else
  conflicting_claim    a new "remember" on the same subject as a current memory -> both become
                       disputed until the user chooses (existing M0 rule)

Nothing here writes memory. The renderer shows the interpretation; only an explicit click
applies it, through the same store functions the memory panel uses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.memory import adaptive as memory
from app.memory import conversations as store

Kind = Literal["chat", "recall", "remember", "correct", "forget", "approval", "empty"]
Category = Literal["explicit_correction", "project_exception", "temporary", "transcription_doubt", "conflicting_claim"]

_CORRECT = re.compile(
    r"^\s*(?:please\s+)?(?:correct|update|change|fix|amend|revise)\s+(?:that|this|the|my)\s+(?:last\s+)?memory\b"
    r"(?:\s+(?:to\s+say|to|so\s+(?:that\s+)?it\s+says))?\s*[:,;.\-–—]?\s*(?P<body>.*)$",
    re.IGNORECASE | re.DOTALL,
)
_FORGET = re.compile(
    r"^\s*(?:please\s+)?(?:forget|delete|erase|remove|wipe|clear)\b.*\b(?:memory|memories|remember(?:ed)?|that|"
    r"what\s+i\s+(?:said|told\s+you))\b",
    re.IGNORECASE | re.DOTALL,
)
_APPROVAL = re.compile(
    r"^\s*(?:(?:yes|yeah|ok(?:ay)?|sure)\b[\s,.!]*)?(?:i\s+)?(?:approve|approved|confirm|accept|go\s+ahead|proceed|"
    r"do\s+it|run\s+it|execute|allow\s+it|move\s+them|yes)\b",
    re.IGNORECASE,
)
_RECALL = re.compile(
    r"\b(?:what|which|do\s+you|did\s+i|have\s+i|tell\s+me)\b.*\b(?:remember(?:ed)?|told\s+you|asked\s+you\s+to\s+remember|"
    r"memory|memories|you\s+know\s+about\s+me)\b",
    re.IGNORECASE | re.DOTALL,
)
_TEMPORARY = re.compile(
    r"\b(?:for\s+now|for\s+today|today\s+only|just\s+today|this\s+(?:week|session|time|afternoon|morning|evening)|"
    r"temporar(?:y|ily)|until\s+\w+|for\s+the\s+next\s+\w+)\b",
    re.IGNORECASE,
)
_EXCEPTION = re.compile(
    r"\b(?:only\s+(?:applies|for|to|in|on|when|within)|appl(?:y|ies)\s+only|except(?:ion)?|but\s+not\s+(?:for|in|on)|"
    r"(?:in|for|on)\s+(?:my|the|our)\s+[\w .'-]{1,40}?\s+(?:repository|repo|project|codebase|folder))\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Interpretation:
    kind: Kind
    text: str
    review_required: bool
    reason: str
    category: Category | None = None
    body: str | None = None
    target: memory.Fact | None = None
    candidates: list[memory.Fact] = field(default_factory=list)
    proposed_content: str | None = None
    conflict: memory.Fact | None = None


def _terms(text: str) -> set[str]:
    return set(memory._terms(text, min_len=3, stop=True, cap=32))


def _sentence(text: str) -> str:
    text = text.strip().rstrip(" .")
    return text[:1].upper() + text[1:] if text else text


def propose_revision(old: memory.Fact, body: str, category: Category) -> str:
    """The new version the user is asked to review. The user's words are kept verbatim."""
    if category == "explicit_correction":
        return _sentence(body) + "."
    # A qualification keeps the original statement and adds the user's own words; nothing is paraphrased.
    return f"{_sentence(old.content)} (correction: {body.strip().rstrip(' .')})."


def _score(fact: memory.Fact, body: set[str], topic: set[str]) -> int:
    words = _terms(fact.content + " " + (fact.subject or ""))
    # Words of the correction itself count most; words of the user's previous message (what "that" refers to) next.
    return 10 * len(body & words) + len(topic & words)


def _last_user_text(path: Path, conversation_id: str) -> str:
    recent = store.history(path, conversation_id, before_seq=2**31, limit=6)
    return next((m.content for m in reversed(recent) if m.role == "user"), "")


def _resolve(path: Path, conversation_id: str | None, body: str) -> tuple[memory.Fact | None, list[memory.Fact]]:
    """"That memory" = the one this conversation just used or saved, if exactly one fits; otherwise the user picks."""
    recent = memory.recent_in_conversation(path, conversation_id) if conversation_id else []
    if len(recent) == 1:
        return recent[0], recent
    if recent:
        words, topic = _terms(body), _terms(_last_user_text(path, conversation_id or ""))
        ranked = sorted(recent, key=lambda f: _score(f, words, topic), reverse=True)  # stable: recency breaks ties
        scores = [_score(f, words, topic) for f in ranked]
        if scores[0] > 0 and (len(scores) == 1 or scores[0] > scores[1]):
            return ranked[0], ranked
        return None, ranked
    # No conversation context: offer the best lexical matches, never pick one silently.
    return None, memory.retrieve(path, body, limit=4)[:4]


def _category(body: str) -> Category:
    if _TEMPORARY.search(body):
        return "temporary"
    if _EXCEPTION.search(body):
        return "project_exception"
    return "explicit_correction"


def interpret(path: Path, text: str, *, conversation_id: str | None, low_confidence: bool) -> Interpretation:
    text = memory.clean(text)
    if not any(ch.isalnum() for ch in text):
        return Interpretation("empty", text, True, "Nothing usable was recognised.")
    doubt: Category | None = "transcription_doubt" if low_confidence else None
    doubt_note = " The speech engine was not confident; check the words first." if low_confidence else ""

    correction = _CORRECT.match(text)
    if correction:
        body = correction.group("body").strip()
        if not any(ch.isalnum() for ch in body):
            return Interpretation("correct", text, True, "Say or type what the memory should say.", doubt, body)
        target, candidates = _resolve(path, conversation_id, body)
        category = _category(body)
        proposed = propose_revision(target, body, category) if target else None
        if target is None and not candidates:
            reason = "No current memory to correct was found. Open the Memory panel to choose one."
        elif target is None:
            reason = "More than one memory could be meant. Choose the one to correct."
        elif category == "temporary":
            reason = ("This sounds temporary. A correction is permanent until changed again, so it is not applied "
                      "unless you choose to; you can send it as an ordinary message instead.")
        else:
            reason = "Review the new version. Applying keeps the old version in the memory history."
        return Interpretation("correct", text, True, reason + doubt_note, doubt or category, body, target,
                              candidates, proposed)

    if _FORGET.match(text):
        return Interpretation(
            "forget", text, True,
            "Voice cannot delete or reject memories. Use Reject or Delete in the Memory panel." + doubt_note, doubt,
        )

    if _APPROVAL.match(text) and len(text.split()) <= 12:
        return Interpretation(
            "approval", text, True,
            "Voice cannot approve a plan or an action. Use the Approve button in the plan itself." + doubt_note, doubt,
        )

    body = memory.remember_request(text)
    if body is not None:
        conflict: memory.Fact | None = None
        category: Category | None = doubt
        match = memory._SUBJECT.match(memory.clean(body))
        if match:
            subject = memory.clean(match.group("subject")).casefold()
            scope = memory.scope_for(memory.get_settings(path)["project"])
            same = [f for f in memory.current_on_subject(path, scope, subject)
                    if memory.normalize(f.content) != memory.normalize(body)]
            conflict = same[0] if same else None
        if conflict is not None:
            category = category or "conflicting_claim"
            reason = (f"This conflicts with a current memory on “{conflict.subject}”. Saving marks both as "
                      "disputed (neither is used) until you choose one in the Memory panel.")
        elif _TEMPORARY.search(body):
            category = category or "temporary"
            reason = "This sounds temporary, but remembered text stays until you change it. Edit it or send anyway."
        else:
            reason = "Check the exact words: they are stored verbatim as your own statement."
        return Interpretation("remember", text, True, reason + doubt_note, category, body, conflict=conflict)

    kind: Kind = "recall" if _RECALL.search(text) else "chat"
    if low_confidence:
        return Interpretation(kind, text, True, "The speech engine was not confident; check the words first.", doubt)
    return Interpretation(kind, text, False, "Sent as an ordinary message through the normal routing.")
