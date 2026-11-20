"""Evaluate generated formulas with Office; assertions concern calculated values only."""
import os

import pytest
from openpyxl import Workbook, load_workbook

from services.mabang.amazon.fba.replenishment_v2_formulas import replenishment_v2_formulas
from shared.office.execution import run_kit_bounded

# Each row exercises a decision boundary. Inputs may set intermediate cells to
# isolate a business rule; full source-to-report calculations are tested separately.
CASES = [
    ("sample-9", {"G": 9}, {"I": "样本不足"}),
    ("sample-10", {"G": 10}, {"I": "下降"}),
    ("growth-threshold", {"E": 21, "F": 42, "G": 70}, {"I": "增长"}),
    ("below-growth", {"E": 21, "F": 42, "G": 71}, {"I": "平稳"}),
    ("decline-threshold", {"E": 17, "F": 34, "G": 90}, {"I": "下降"}),
    ("above-decline", {"E": 17, "F": 34, "G": 89}, {"I": "平稳"}),
    ("weights", {"E": 7, "F": 28, "G": 90, "H": 999}, {"J": 1.5}),
    ("stock-components", {"K": 1, "L": 2, "M": 3, "N": 999, "O": 4, "P": 5, "Q": 6}, {"R": 21}),
    ("zero-sales", {"J": 0}, {"S": None, "AI": None}),
    ("fractional-days", {"J": 3, "R": 1, "T": 0}, {"S": 1 / 3, "AI": 1 / 3}),
    ("air-deductions", {"J": 2, "V": 10, "R": 1, "T": 3, "AG": 999}, {"X": 16, "Y": 20}),
    ("no-shortage", {"J": 2, "V": 10, "R": 17, "T": 3}, {"X": None, "Y": None}),
    ("sea-deductions", {"J": 6, "V": 75, "W": 90, "R": 480, "T": 10, "Y": 10, "AG": 999}, {"AA": 40, "AB": 40}),
    ("supply-including-advice", {"J": 2, "R": 100, "T": 20, "Y": 30, "AB": 40}, {"AI": 95}),
    ("weights-in-grams", {"Y": 10, "AB": 20, "AD": 2.5}, {"Z": 25, "AC": 50}),
    ("urgent", {"I": "平稳", "J": 6, "S": 40, "Y": 10, "AB": 20}, {"U": "空运（急发）"}),
    ("air", {"I": "平稳", "J": 6, "S": 40.01, "Y": 10, "AB": 20}, {"U": "空运"}),
    ("air-at-70", {"I": "平稳", "J": 6, "S": 70, "Y": 10, "AB": 20}, {"U": "空运"}),
    ("combined", {"I": "平稳", "J": 6, "S": 70.01, "Y": 10, "AB": 20}, {"U": "空运＋海运"}),
    ("sea", {"I": "平稳", "J": 6, "S": 80, "Y": None, "AB": 20}, {"U": "海运"}),
    ("slow-sales", {"I": "平稳", "J": 5, "S": 80, "Y": 10, "AB": 20}, {"U": None, "W": None}),
]
for trend, expected in (("增长", (60, 75, 75, 90, 90, 90)), ("平稳", (45, 60, 60, 75, 75, 90)),
                        ("下降", (45, 45, 45, 60, 60, 75))):
    CASES.extend((f"air-{trend}-{daily}", {"I": trend, "J": daily}, {"V": days})
                 for daily, days in zip((2, 2.01, 5, 5.01, 10, 10.01), expected))
CASES.extend((f"sea-{daily}", {"J": daily, "S": 80}, {"W": days})
             for daily, days in ((5.01, 90), (10, 90), (10.01, 95), (20, 95), (20.01, 100)))
for blank in (None, '=""'):
    CASES.extend([
        (f"sea-no-air-days-{blank}", {"V": blank, "W": 90, "J": 6}, {"AA": None}),
        (f"sea-no-weight-{blank}", {"AB": 10, "AD": blank}, {"AC": None}),
        (f"sea-no-quantity-{blank}", {"AB": blank, "AD": 50}, {"AC": None}),
    ])
for plan, actual in (("X", "Y"), ("AA", "AB")):
    CASES.extend((f"round-{actual}-{quantity}", {plan: quantity}, {actual: expected})
                 for quantity, expected in ((4, None), (5, 10), (15, 20)))
CASES = [(name, inputs, expected, {}) for name, inputs, expected in CASES]
for enabled, days, remark, trend, expected in (
    (False, 20, "热销", "平稳", (90, 95)), (True, 0, "热销", "平稳", (90, 95)),
    (True, 20, "热销", "平稳", (110, 115)), (True, 120, "热销", "平稳", (120, 120)),
    (True, 20, "不补 热销", "平稳", (90, 95)), (True, 20, "清货 热销", "平稳", (None, None)),
    (True, 20, "新品", "增长", (110, 115)), (True, 20, "新品", "平稳", (90, 95)),
):
    CASES.append((f"peak-{enabled}-{days}-{remark}-{trend}", {"I": trend, "J": 11, "S": 80, "AF": remark},
                  dict(zip(("V", "W"), expected)), {"peak_boost_enabled": enabled, "peak_boost_days": days}))


@pytest.fixture(scope="module")
def evaluated(tmp_path_factory):
    if not all(os.environ.get(key) for key in ("LXE_OFFICE_NODE", "LXE_OFFICE_CLI")):
        pytest.skip("Office Kit unavailable: formula behavior NOT VERIFIED")
    root = tmp_path_factory.mktemp("formula-results")
    book = Workbook()
    for row, (_, inputs, _, parameters) in enumerate(CASES, 2):
        for column in ("E", "F", "G", "H", "K", "L", "M", "N", "O", "P", "Q", "T", "AD"):
            book.active[f"{column}{row}"] = 0
        for column, value in {**replenishment_v2_formulas(row, **parameters), **inputs}.items():
            book.active[f"{column}{row}"] = value
    book.save(root / "input.xlsx")
    book.close()
    result = run_kit_bounded(["recalculate", "--input", str(root / "input.xlsx"), "--output", str(root / "output.xlsx")], timeout_seconds=90)
    assert result.returncode == 0, result.stdout + result.stderr
    cached = load_workbook(root / "output.xlsx", data_only=True)
    try:
        yield cached.active
    finally:
        cached.close()


@pytest.mark.parametrize("index,case", list(enumerate(CASES, 2)), ids=[case[0] for case in CASES])
def test_calculated_business_rule(evaluated, index, case):
    for column, expected in case[2].items():
        actual = evaluated[f"{column}{index}"].value
        assert actual == (pytest.approx(expected) if isinstance(expected, (int, float)) else expected), (case[0], column)
