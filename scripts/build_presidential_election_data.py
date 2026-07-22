#!/usr/bin/env python3
"""Build assets/presidential_election_data.js from county presidential returns."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "presidential_election_data"
LONG = DATA / "us_county_presidential_2004_2024_long.csv"
OUT = ROOT / "assets" / "presidential_election_data.js"

YEARS = [2004, 2008, 2012, 2016, 2020, 2024]

METRICS = [
    ("dem_votes", "Democratic votes", "votes", "Vote counts"),
    ("rep_votes", "Republican votes", "votes", "Vote counts"),
    ("other_votes", "Other votes", "votes", "Vote counts"),
    ("total_votes", "Total votes", "votes", "Vote counts"),
    ("dem_pct", "Democratic %", "%", "Vote share"),
    ("rep_pct", "Republican %", "%", "Vote share"),
    ("margin_pct", "Margin (D − R)", "%", "Margin"),
    ("dem_two_party_pct", "Democratic two-party %", "%", "Two-party share"),
    ("rep_two_party_pct", "Republican two-party %", "%", "Two-party share"),
]

PCT_CODES = {"dem_pct", "rep_pct", "margin_pct", "dem_two_party_pct", "rep_two_party_pct"}

STATE_NAME_TO_ABBR = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL",
    "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA",
    "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR",
    "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA",
    "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}


def state_abbr(raw: str) -> str:
    s = str(raw or "").strip()
    if len(s) == 2:
        return s.upper()
    return STATE_NAME_TO_ABBR.get(s, s[:2].upper())


def row_metrics(rec: dict) -> dict[str, float | int | None]:
    dem = int(rec["dem_votes"])
    rep = int(rec["rep_votes"])
    other = int(rec["other_votes"])
    total = int(rec["total_votes"])
    dem_pct = float(rec["dem_pct"])
    rep_pct = float(rec["rep_pct"])
    margin = float(rec["margin_pct"])
    two = dem + rep
    if two > 0:
        dem_2p = round(100.0 * dem / two, 2)
        rep_2p = round(100.0 * rep / two, 2)
    else:
        dem_2p = rep_2p = None
    return {
        "dem_votes": dem,
        "rep_votes": rep,
        "other_votes": other,
        "total_votes": total,
        "dem_pct": dem_pct,
        "rep_pct": rep_pct,
        "margin_pct": margin,
        "dem_two_party_pct": dem_2p,
        "rep_two_party_pct": rep_2p,
    }


def pack_values(metrics: dict[str, float | int | None], years: list[int], by_year: dict[int, dict]) -> list:
    vals: list = []
    for code, *_ in METRICS:
        for y in years:
            m = by_year.get(y)
            if not m:
                vals.append(None)
                continue
            v = m.get(code)
            if v is None:
                vals.append(None)
            elif code in PCT_CODES:
                vals.append(round(float(v), 4))
            else:
                vals.append(int(v))
    return vals


def main() -> None:
    long = pd.read_csv(LONG, dtype={"fips": str})
    long["fips"] = long["fips"].str.zfill(5)
    long["state_abbr"] = long["state"].map(state_abbr)

    counties: dict[str, dict] = {}
    for rec in long.itertuples(index=False):
        fips = str(rec.fips).zfill(5)
        year = int(rec.year)
        if fips not in counties:
            counties[fips] = {
                "state_abbr": state_abbr(rec.state),
                "county": str(rec.county),
                "by_year": {},
            }
        counties[fips]["by_year"][year] = row_metrics(rec._asdict())
        if year >= max(counties[fips].get("_latest", 0), year):
            counties[fips]["county"] = str(rec.county)
            counties[fips]["state_abbr"] = state_abbr(rec.state)
            counties[fips]["_latest"] = year

    county_rows = []
    for fips in sorted(counties):
        c = counties[fips]
        county_rows.append([
            fips,
            c["state_abbr"],
            c["county"],
            pack_values({}, YEARS, c["by_year"]),
        ])

    state_acc: dict[str, dict[int, dict[str, float]]] = {}
    for fips, c in counties.items():
        st = c["state_abbr"]
        if st not in state_acc:
            state_acc[st] = {y: {
                "dem_votes": 0.0, "rep_votes": 0.0, "other_votes": 0.0, "total_votes": 0.0,
            } for y in YEARS}
        for y, m in c["by_year"].items():
            for k in ("dem_votes", "rep_votes", "other_votes", "total_votes"):
                state_acc[st][y][k] += float(m[k])

    state_rows = []
    for st in sorted(state_acc):
        by_year: dict[int, dict] = {}
        for y in YEARS:
            acc = state_acc[st][y]
            if acc["total_votes"] <= 0:
                continue
            dem = int(acc["dem_votes"])
            rep = int(acc["rep_votes"])
            other = int(acc["other_votes"])
            total = int(acc["total_votes"])
            dem_pct = round(100.0 * dem / total, 2)
            rep_pct = round(100.0 * rep / total, 2)
            two = dem + rep
            by_year[y] = {
                "dem_votes": dem,
                "rep_votes": rep,
                "other_votes": other,
                "total_votes": total,
                "dem_pct": dem_pct,
                "rep_pct": rep_pct,
                "margin_pct": round(dem_pct - rep_pct, 2),
                "dem_two_party_pct": round(100.0 * dem / two, 2) if two else None,
                "rep_two_party_pct": round(100.0 * rep / two, 2) if two else None,
            }
        state_rows.append([st, pack_values({}, YEARS, by_year)])

    pack = {
        "meta": {
            "source": "MIT Election Data & Science Lab (2004–2020) · tonmcg county feed (2024)",
            "source_url": "https://electionlab.mit.edu/",
            "data_note": (
                "County presidential returns for 2004, 2008, 2012, 2016, 2020, and 2024. "
                "Percentages are of total county votes (all candidates). "
                "2024 is provisional from a compiled AP/network feed; 2004–2020 are MEDSL. "
                "Connecticut 2024 uses planning-region FIPS that do not match 2004–2020 county FIPS."
            ),
            "years": YEARS,
            "geographies": ["states", "counties"],
            "indicators": [
                {"code": c, "label": lab, "unit": unit, "group": grp}
                for c, lab, unit, grp in METRICS
            ],
            "codes": [c for c, *_ in METRICS],
            "n_counties": len(county_rows),
            "n_states": len(state_rows),
            "default_year": 2024,
            "default_indicator": "margin_pct",
        },
        "county_rows": county_rows,
        "state_rows": state_rows,
    }

    OUT.write_text(
        "window.PRESIDENTIAL_ELECTION = " + json.dumps(pack, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {OUT} · {len(county_rows)} counties · {len(state_rows)} states · "
        f"{OUT.stat().st_size:,} bytes",
        flush=True,
    )


if __name__ == "__main__":
    main()
