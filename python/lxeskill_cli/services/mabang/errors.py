from __future__ import annotations


class MabangApiError(RuntimeError):
    pass


class MabangAuthError(MabangApiError):
    pass


class MabangRequestError(MabangApiError):
    pass


class MabangBusinessError(MabangApiError):
    pass


class MabangParseError(MabangApiError):
    pass
