from __future__ import annotations


class MabangApiError(RuntimeError):
    pass


class MabangAuthError(MabangApiError):
    pass


class MabangAuthUnavailableError(MabangAuthError):
    """Auth acquisition or recovery failed; business retries must not log in again."""


class MabangRequestError(MabangApiError):
    pass


class MabangBusinessError(MabangApiError):
    pass


class MabangParseError(MabangApiError):
    pass
