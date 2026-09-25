"""Fixed finance, world and politics question sets, sharing the classifier's HTTP and limits.

Inputs are (key, title, summary) tuples. Category eligibility, shared scheduling
budget, threads and cache ownership belong to the coordinator, not this client.
"""
from decimal import Decimal, ROUND_HALF_UP

if __package__:
    from .classify import _ChoiceClient, _choice
else:
    from classify import _ChoiceClient, _choice

ANALYSIS_CATEGORIES = frozenset({"finance", "tech", "world", "politics"})

MARKET_CRITERIA = {
    "positive": "對股市或個股前景呈現正向訊息：上漲、利多、成長、獲利",
    "negative": "對股市或個股前景呈現負向訊息：下跌、利空、衰退、虧損、下修",
    "mixed": "同時呈現正反兩面",
    "not_market": "內容與股市或個股前景無關",
    "other": "以上皆非",
}
THEME_CRITERIA = {
    "foundry": "晶圓代工、先進製程",
    "ic_design": "IC 設計",
    "memory": "記憶體（DRAM、NAND、HBM）",
    "packaging": "先進封裝（CoWoS 等）",
    "semi_equip": "半導體設備與材料",
    "ai_server": "AI 伺服器、資料中心、雲端",
    "cooling": "散熱",
    "pcb": "PCB、載板、被動元件",
    "optical": "光通訊、矽光子、海纜",
    "display": "光電、面板、LED",
    "leo": "低軌衛星、太空",
    "energy": "能源、電力、儲能、綠能",
    "ev": "電動車與汽車供應鏈",
    "financials": "銀行、保險、證券、金控",
    "property": "營建、房地產",
    "transport": "航運、航空、物流",
    "consumer_elec": "手機、PC、消費電子、品牌硬體",
    "petrochem": "石化、塑化、鋼鐵、水泥等原物料與傳產",
    "software": "軟體、網路服務、電商、量子運算等新興科技",
    "industrial": "工業電腦、自動化、機器人",
    "macro": "大盤、總體經濟、利率匯率、法人買賣超等不屬於單一產業",
    "other": "以上皆非",
}
DIR_CRITERIA = {
    "bull": "利多：對該產業或個股明確有利",
    "bear": "利空：對該產業或個股明確不利",
    "mixed": "正反並存",
    "neutral": "以上皆非",
}
QUESTIONS = {
    "market": ("這則報導對股市前景呈現什麼方向的訊息？", MARKET_CRITERIA, "other"),
    "theme": ("這則新聞最主要涉及哪個產業或題材？", THEME_CRITERIA, "other"),
    "dir": ("這則新聞對它最主要涉及的產業或個股，呈現什麼方向？", DIR_CRITERIA, "neutral"),
}


WORLD_QUESTIONS = {
    "trend": ("這則報導描述的國際衝突或緊張情勢，走向是什麼？", {
        "escalation": "升級：衝突、對峙、制裁或威脅加劇",
        "deescalation": "緩和：停火、談判進展、關係改善",
        "stalemate": "僵持：持續對峙但沒有明顯變化",
        "not_conflict": "內容不涉及衝突或緊張情勢",
        "other": "以上皆非",
    }, "other"),
    "region": ("這則報導主要涉及哪個地區？", {
        "us_china": "美中關係",
        "asia_pacific": "亞太（不含美中雙邊）",
        "middle_east": "中東",
        "europe_russia": "歐洲與俄烏",
        "americas": "美洲",
        "other": "以上皆非",
    }, "other"),
}
ISSUE_CRITERIA = {
    "cross_strait": "兩岸關係、中國對台",
    "us_intl": "美國與國際外交（含川習會、軍售外交）",
    "defense": "國防、軍事、國安",
    "election": "選舉、候選人、選戰、政黨動態",
    "budget": "預算、財政、普發現金、補貼、稅",
    "legislature": "立法院議事、法案",
    "justice": "司法、檢調、弊案、貪污",
    "energy_env": "能源、核能、環境",
    "local": "地方施政、建設",
    "other": "以上皆非",
}
POLITICS_QUESTIONS = {"issue": ("這則新聞主要涉及哪一個政治議題？", ISSUE_CRITERIA, "other")}
QUESTION_SETS = {"finance": QUESTIONS, "world": WORLD_QUESTIONS, "politics": POLITICS_QUESTIONS}


def analysis_kind(category):
    return category if category in {"world", "politics"} else "finance"


class Analyzer(_ChoiceClient):
    _label = "analyze"

    def analyze_round(self, items, *, kind="finance"):
        """Yield complete batches, stopping on failure or the admission budget."""
        return self._run_round(items, lambda batch: self.analyze(batch, kind=kind))

    def analyze(self, batch, *, kind="finance"):
        """One homogeneous kind per request; return keyed tagged analyses."""
        if kind not in QUESTION_SETS:
            raise ValueError("unknown analysis kind")
        return self._request(batch, context=kind)

    def _questions(self, size, context=None):
        return {f"{name}_{i}": {"type": "choice", "instructions": f"news_{i} {instruction}",
                                "criteria": criteria}
                for i in range(size) for name, (instruction, criteria, _) in QUESTION_SETS[context].items()}

    def _decode(self, batch, answers, context=None):
        result = {}
        for i, (key, _, _) in enumerate(batch):
            analysis = {"kind": context}
            for name, (_, criteria, abstain) in QUESTION_SETS[context].items():
                choice, p_max = _choice(answers.get(f"{name}_{i}"), criteria, abstain)
                analysis[name] = choice
                if name == "dir":
                    analysis["dir_p"] = float(Decimal(str(p_max)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
            result[key] = analysis
        return result


def valid_analysis(value):
    """Validate detached candidates before the coordinator caches them."""
    if not isinstance(value, dict):
        return False
    kind = value.get("kind", "finance")  # Accept legacy finance cache entries.
    if not isinstance(kind, str) or kind not in QUESTION_SETS:
        return False
    return (all(isinstance(value.get(name), str) and value[name] in criteria
                for name, (_, criteria, _) in QUESTION_SETS[kind].items())
            and (kind != "finance" or (type(value.get("dir_p")) in (int, float)
                                    and 0 <= value["dir_p"] <= 1)))
