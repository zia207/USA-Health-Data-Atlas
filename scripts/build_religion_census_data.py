#!/usr/bin/env python3
"""Build assets/religion_census_data.js from RCMS 2010 and USRC 2020 county files."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "religion_census"
OUT = ROOT / "assets" / "religion_census_data.js"
sys.path.insert(0, str(DATA))

from dominant_groups import (  # noqa: E402
    DOMINANT_GROUPS,
    MAPPING_2010,
    build_mapping_2020,
)

FILES = {
    2010: {
        "wide": DATA / "usa_religion_county_2010_wide.csv",
        "codebook": DATA / "usa_religion_2010_codebook.csv",
        "pop_col": "population_2010",
        "source": "Religious Congregations & Membership Study (RCMS) 2010",
        "source_url": "https://www.thearda.com/data-archive?fid=RCMSCY10",
        "data_note": (
            "County adherents, congregations, and adherence rates per 1,000 population "
            "(2010 Census denominators). Includes six major tradition family aggregates."
        ),
    },
    2020: {
        "wide": DATA / "usa_religion_county_2020_wide.csv",
        "codebook": DATA / "usa_religion_2020_codebook.csv",
        "pop_col": "population_2020",
        "source": "2020 U.S. Religion Census (USRC)",
        "source_url": "https://www.usreligioncensus.org/",
        "data_note": (
            "County adherents, congregations, and adherence rates per 1,000 population "
            "(2020 denominators from adherent share of population). Totals sum reported "
            "denominations per county; 372 groups from the USRC Group Detail release."
        ),
    },
}

FAMILY = {
    "evan": "Evangelical Protestant",
    "mprt": "Mainline Protestant",
    "bprt": "Black Protestant",
    "cath": "Catholic",
    "orth": "Orthodox",
    "oth": "Other",
}

METRICS = [
    ("adherents", "adh", "Adherents", "persons"),
    ("congregations", "cng", "Congregations", "congregations"),
    ("rate", "rate", "Adherence rate", "per 1,000 pop"),
]


def load_codebook(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    df = pd.read_csv(path)
    return {str(r.variable).lower(): str(r.description) for r in df.itertuples()}


def group_label(code: str, codebook: dict[str, str], year: int) -> str:
    if code == "tot":
        return "All religious groups"
    if year == 2010 and code in FAMILY:
        return FAMILY[code]
    for suffix in ("cng", "adh", "rate"):
        desc = codebook.get(f"{code}{suffix}", "")
        if desc:
            return desc.split("--")[0].strip()
    return code.upper()


def group_category(code: str, year: int) -> str:
    if code == "tot":
        return "Totals"
    if year == 2010 and code in FAMILY:
        return "Tradition"
    return "Denomination"


def ordered_groups(columns: list[str], year: int) -> list[str]:
    bases = sorted(
        {
            re.sub(r"(cng|adh|rate)$", "", c.lower())
            for c in columns
            if re.search(r"(cng|adh|rate)$", c, re.I)
        }
    )
    order: list[str] = []
    if "tot" in bases:
        order.append("tot")
    if year == 2010:
        for code in FAMILY:
            if code in bases:
                order.append(code)
    order.extend(b for b in bases if b not in order)
    return order


def dominant_mapping(year: int, codebook: dict[str, str]) -> dict[str, list[str]]:
    if year == 2010:
        return MAPPING_2010
    names = {}
    for var, desc in codebook.items():
        if not re.search(r"(cng|adh|rate)$", var):
            continue
        code = re.sub(r"(cng|adh|rate)$", "", var)
        names[code] = desc.split("--")[0].strip()
    return build_mapping_2020(names)


def dominant_values_for_row(rec: dict, mapping: dict[str, list[str]], pop) -> list:
    vals: list = []
    pop_val = float(pop) if pd.notna(pop) and pop else None
    for dom in DOMINANT_GROUPS:
        dom_code = dom["code"]
        adh = 0
        cng = 0
        has_adh = False
        has_cng = False
        for src in mapping.get(dom_code, []):
            adh_val = rec.get(f"{src}adh")
            cng_val = rec.get(f"{src}cng")
            if pd.notna(adh_val):
                adh += float(adh_val)
                has_adh = True
            if pd.notna(cng_val):
                cng += float(cng_val)
                has_cng = True
        rate = round(1000.0 * adh / pop_val, 4) if pop_val and has_adh else None
        vals.extend([
            int(round(adh)) if has_adh else None,
            int(round(cng)) if has_cng else None,
            rate,
        ])
    return vals


def append_dominant_groups(
    *,
    year: int,
    wide: pd.DataFrame,
    groups: list[str],
    group_meta: list[dict],
    county_rows: list[list],
    state_acc: dict[str, dict],
    mapping: dict[str, list[str]],
) -> None:
    dom_codes = [g["code"] for g in DOMINANT_GROUPS]
    dom_meta = [
        {
            "code": g["code"],
            "label": g["label"] + (f" ({g['note']})" if g.get("note") else ""),
            "category": g["category"],
        }
        for g in DOMINANT_GROUPS
    ]
    groups[:0] = dom_codes
    group_meta[:0] = dom_meta

    pop_col = "population_2010" if year == 2010 else "population_2020"
    for state_abbr in state_acc:
        for dom_code in dom_codes:
            state_acc[state_abbr][dom_code] = {"adherents": 0, "congregations": 0}

    for i in range(len(wide)):
        rec = wide.iloc[i].to_dict()
        dom_vals = dominant_values_for_row(rec, mapping, rec.get(pop_col))
        county_rows[i][4] = dom_vals + county_rows[i][4]

        state_abbr = county_rows[i][1]
        if state_abbr not in state_acc:
            continue
        for di, dom_code in enumerate(dom_codes):
            adh = dom_vals[di * 3]
            cng = dom_vals[di * 3 + 1]
            if adh is not None:
                state_acc[state_abbr][dom_code]["adherents"] += adh
            if cng is not None:
                state_acc[state_abbr][dom_code]["congregations"] += cng


def pack_year(year: int, cfg: dict) -> dict:
    wide = pd.read_csv(cfg["wide"], dtype={"fips": str})
    wide["fips"] = wide["fips"].str.zfill(5)
    pop_col = cfg["pop_col"]
    codebook = load_codebook(cfg["codebook"])
    mapping = dominant_mapping(year, codebook)
    groups = ordered_groups(list(wide.columns), year)

    group_meta = [
        {
            "code": code,
            "label": group_label(code, codebook, year),
            "category": group_category(code, year),
        }
        for code in groups
    ]

    county_rows: list[list] = []
    state_acc: dict[str, dict] = {}

    for i in range(len(wide)):
        rec = wide.iloc[i].to_dict()
        fips = str(rec["fips"]).zfill(5)
        state_abbr = rec["state_abbr"]
        county = rec["county"]
        pop = rec[pop_col]
        vals: list = []
        for code in groups:
            for metric_code, suffix, *_ in METRICS:
                col = f"{code}{suffix}"
                value = rec.get(col)
                if pd.isna(value):
                    vals.append(None)
                elif metric_code == "rate":
                    vals.append(round(float(value), 4))
                else:
                    vals.append(int(round(float(value))))
        county_rows.append([fips, state_abbr, county, int(pop) if pd.notna(pop) else None, vals])

        if state_abbr not in state_acc:
            state_acc[state_abbr] = {
                code: {"adherents": 0, "congregations": 0} for code in groups
            }
            state_acc[state_abbr]["_pop"] = 0.0
        if pd.notna(pop):
            state_acc[state_abbr]["_pop"] += float(pop)
        for gi, code in enumerate(groups):
            for mi, (metric_code, suffix, *_rest) in enumerate(METRICS):
                if metric_code == "rate":
                    continue
                value = vals[gi * len(METRICS) + mi]
                if value is not None:
                    state_acc[state_abbr][code][metric_code] += value

    append_dominant_groups(
        year=year,
        wide=wide,
        groups=groups,
        group_meta=group_meta,
        county_rows=county_rows,
        state_acc=state_acc,
        mapping=mapping,
    )

    state_rows: list[list] = []
    for state_abbr in sorted(state_acc):
        pop = state_acc[state_abbr]["_pop"]
        vals: list = []
        for code in groups:
            for metric_code, *_rest in METRICS:
                if metric_code == "rate":
                    adherents = state_acc[state_abbr].get(code, {}).get("adherents", 0)
                    vals.append(round(1000.0 * adherents / pop, 4) if pop else None)
                else:
                    total = state_acc[state_abbr].get(code, {}).get(metric_code, 0)
                    vals.append(total if total else None)
        state_rows.append([state_abbr, vals])

    return {
        "source": cfg["source"],
        "source_url": cfg["source_url"],
        "data_note": cfg["data_note"],
        "population_field": pop_col,
        "groups": group_meta,
        "group_codes": groups,
        "county_rows": county_rows,
        "state_rows": state_rows,
        "n_counties": len(county_rows),
        "n_groups": len(groups),
        "n_dominant_groups": len(DOMINANT_GROUPS),
        "n_states": len(state_rows),
        "national_adherents": int(wide["totadh"].sum(skipna=True)),
        "national_congregations": int(wide["totcng"].sum(skipna=True)),
        "national_population": int(wide[pop_col].sum(skipna=True)),
    }


def main() -> None:
    by_year: dict[str, dict] = {}
    for year, cfg in FILES.items():
        if not cfg["wide"].exists():
            raise FileNotFoundError(f"Missing {cfg['wide']} — run build_religion_county_{year}.py first")
        by_year[str(year)] = pack_year(year, cfg)

    metric_meta = [
        {"code": code, "label": label, "unit": unit, "suffix": suffix}
        for code, suffix, label, unit in METRICS
    ]

    pack = {
        "meta": {
            "dominant_groups": DOMINANT_GROUPS,
            "years": sorted(FILES.keys()),
            "metrics": metric_meta,
            "metric_codes": [m[0] for m in METRICS],
            "by_year": {
                str(year): {
                    "source": by_year[str(year)]["source"],
                    "source_url": by_year[str(year)]["source_url"],
                    "data_note": by_year[str(year)]["data_note"],
                    "population_field": by_year[str(year)]["population_field"],
                    "n_counties": by_year[str(year)]["n_counties"],
                    "n_groups": by_year[str(year)]["n_groups"],
                    "n_dominant_groups": by_year[str(year)]["n_dominant_groups"],
                    "n_states": by_year[str(year)]["n_states"],
                    "national_adherents": by_year[str(year)]["national_adherents"],
                    "national_congregations": by_year[str(year)]["national_congregations"],
                    "national_population": by_year[str(year)]["national_population"],
                }
                for year in FILES
            },
        },
        "by_year": {
            str(year): {
                "groups": by_year[str(year)]["groups"],
                "group_codes": by_year[str(year)]["group_codes"],
                "county_rows": by_year[str(year)]["county_rows"],
                "state_rows": by_year[str(year)]["state_rows"],
            }
            for year in FILES
        },
    }

    OUT.write_text(
        "window.RELIGION_CENSUS = " + json.dumps(pack, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    summary = " · ".join(
        f"{year}: {by_year[str(year)]['n_counties']} counties, {by_year[str(year)]['n_groups']} groups"
        for year in sorted(FILES)
    )
    print(f"Wrote {OUT} · {summary} · {OUT.stat().st_size:,} bytes", flush=True)


if __name__ == "__main__":
    main()
