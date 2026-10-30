"""Amazon V2 replenishment formulas, independent of the V1 replenishment rules.

The user-confirmed XLSX rules take precedence for AA/AC blank guards; the
proposal's appendix supplies the formulas and confirmed U-column IF order.
Excel performs evaluation; this module does not maintain a second numeric
algorithm or cached results.
"""
from __future__ import annotations


def replenishment_v2_formulas(
    row_number: int, *, peak_boost_enabled: bool = True, peak_boost_days: int | None = None,
) -> dict[str, str]:
    """Return the original 13 formulas plus supply days in the 35-column layout.

    Keys are column letters; values include Excel's leading ``=``. Callers
    own source validation, workbook writing and recalculation. The current
    helper retains its legacy formula defaults; business generation explicitly
    supplies the resolved seasonal settings snapshot.
    """
    if type(row_number) is not int or not 2 <= row_number <= 1_048_576:
        raise ValueError("row_number must be an Excel data-row integer between 2 and 1048576")
    if type(peak_boost_enabled) is not bool:
        raise ValueError("peak_boost_enabled must be a bool")
    if peak_boost_days is not None and (type(peak_boost_days) is not int or not 0 <= peak_boost_days <= 120):
        raise ValueError("peak_boost_days must be None or an integer between 0 and 120")
    boost_days = 30 if peak_boost_days is None else peak_boost_days
    r = row_number
    baseline = f"(F{r}-E{r})/7*0.6+(G{r}-F{r})/16*0.4"
    growth_keywords = ("新品", "一般", "透明计划", "稳定产品", "重点产品", "重点关注", "有机会", "出口退税")
    growth_matches = ",".join(f'ISNUMBER(SEARCH("{keyword}",AF{r}))' for keyword in growth_keywords)
    peak_boost = (
        f'IF(OR(ISNUMBER(SEARCH("清货",AF{r})),ISNUMBER(SEARCH("不补",AF{r}))),0,'
        f'IF(OR(ISNUMBER(SEARCH("热销",AF{r})),AND(I{r}="增长",OR({growth_matches}))),{boost_days},0))'
    ) if peak_boost_enabled else "0"
    air_days = (
        f'IF(I{r}="增长",IF(J{r}>10,90,IF(J{r}>5,90,IF(J{r}>2,75,60))),'
        f'IF(I{r}="平稳",IF(J{r}>10,90,IF(J{r}>5,75,IF(J{r}>2,60,45))),'
        f'IF(J{r}>10,75,IF(J{r}>5,60,IF(J{r}>2,45,45)))))'
    )
    sea_days = f"IF(J{r}<=10,90,IF(J{r}<=20,95,100))"
    air_plan = f"J{r}*V{r}-(R{r}+T{r})"
    sea_plan = f'J{r}*W{r}-(R{r}+T{r})-IF(Y{r}="",0,Y{r})'
    return {
        "I": (
            f'=IF(G{r}<10,"样本不足",IF({baseline}=0,IF(E{r}>0,"增长","平稳"),'
            f'IF((E{r}/7)/({baseline})>=1.2,"增长",'
            f'IF((E{r}/7)/({baseline})>0.85,"平稳","下降"))))'
        ),
        "J": f"=E{r}/7*0.6+F{r}/14*0.3+G{r}/30*0.1",
        "R": f"=K{r}+L{r}+M{r}+O{r}+P{r}+Q{r}",
        "S": f'=IF(J{r}=0,"",R{r}/J{r})',
        "U": (
            f'=IF(OR(I{r}="样本不足",S{r}=""),"",'
            f'IF(S{r}<=40,IF(Y{r}="","","空运（急发）"),'
            f'IF(S{r}<=70,IF(Y{r}="","","空运"),'
            f'IF(AND(S{r}>70,J{r}>5),IF(AB{r}="","",'
            f'IF(Y{r}="","海运","空运＋海运")),""))))'
        ),
        "V": (
            f'=IF(OR(I{r}="样本不足",ISNUMBER(SEARCH("清货",AF{r}))),"",'
            f'MIN({air_days}+{peak_boost},120))'
        ),
        "W": (
            f'=IF(ISNUMBER(SEARCH("清货",AF{r})),"",'
            f'IF(AND(S{r}<>"",S{r}>70,J{r}>5),MIN({sea_days}+{peak_boost},120),""))'
        ),
        "X": f'=IF(V{r}="","",IF(({air_plan})<=0,"",ROUND({air_plan},0)))',
        "Y": f'=IF(X{r}="","",IF(ROUND(X{r},-1)<=0,"",ROUND(X{r},-1)))',
        "Z": f'=IF(OR(Y{r}="",AD{r}=""),"",Y{r}*AD{r})',
        "AA": f'=IF(OR(V{r}="",W{r}=""),"",IF(({sea_plan})<=0,"",ROUND({sea_plan},0)))',
        "AB": f'=IF(AA{r}="","",IF(ROUND(AA{r},-1)<=0,"",ROUND(AA{r},-1)))',
        "AC": f'=IF(OR(AB{r}="",AD{r}=""),"",AB{r}*AD{r})',
        "AI": f'=IF(OR(J{r}="",J{r}=0),"",(R{r}+T{r}+IF(Y{r}="",0,Y{r})+IF(AB{r}="",0,AB{r}))/J{r})',
    }
