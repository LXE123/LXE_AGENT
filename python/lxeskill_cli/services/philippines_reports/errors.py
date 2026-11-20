"""Errors exposed by the Philippines report workflow."""


class PhilippinesReportError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
