"""Fixed capabilities; endpoints and authentication stay in each adapter."""
from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderSpec:
    provider_id: str
    label: str
    transport: str
    # Execution-time browser requirement, never a persisted account binding.
    requires_store: bool
    # Query-time company verification from the live page, not a login setting.
    requires_account_name: bool
    command: str


PROVIDERS = tuple(
    ProviderSpec(identifier, label, "public_http" if identifier == "jiufang" else "ziniao_browser",
                 identifier != "jiufang", identifier in ("wesa", "tiantai"),
                 f"lxeskill logistics {identifier} query")
    for identifier, label in (("wesa", "威飒"), ("feiwo", "飞沃"), ("yuntuo", "云驼"),
                              ("tiantai", "天泰供应链"), ("jiufang", "九方"))
)
PROVIDER_BY_ID = {spec.provider_id: spec for spec in PROVIDERS}
