"""Structured errors handed back to agents.

An agent that gets a rejection must be able to fix it without guessing, so every
failure carries a machine-readable ``code``, a JSON ``path`` into the offending
part of the submission, and a human-readable ``message``.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ValidationError:
    code: str
    path: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "path": self.path, "message": self.message}


class Collector:
    """Accumulates errors so one submission reports every problem at once."""

    def __init__(self) -> None:
        self.errors: list[ValidationError] = []

    def add(self, code: str, path: str, message: str) -> None:
        self.errors.append(ValidationError(code, path, message))

    def extend(self, errors: list[ValidationError]) -> None:
        self.errors.extend(errors)

    def __bool__(self) -> bool:
        return bool(self.errors)

    @property
    def ok(self) -> bool:
        return not self.errors
