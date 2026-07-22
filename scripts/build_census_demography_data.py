#!/usr/bin/env python3
"""Build assets/census_demography_data.js from U.S. Census Bureau
county population estimates (PEP) time series + characteristics.

Downloads:
  - co-est2020-alldata.csv / co-est2023-alldata.csv  (totals & components)
  - CC-EST2020-AGESEX-{ST}.csv / cc-est2023-agesex-all.csv  (age & sex)
  - CC-EST2020-ALLDATA-{ST}.csv / cc-est2023-alldata.csv  (race & Hispanic)
  - PctUrbanRural_County.txt  (2010 Census % rural; constant across years)

Output pack mirrors other atlas datasets: meta + compact county/state rows.
"""
from __future__ import annotations

import csv
import io
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "census_demography_data.js"
RAW = ROOT / "data" / "census"
RAW.mkdir(parents=True, exist_ok=True)

URLS = {
    "2010_2020": (
        "https://www2.census.gov/programs-surveys/popest/datasets/"
        "2010-2020/counties/totals/co-est2020-alldata.csv"
    ),
    "2020_2023": (
        "https://www2.census.gov/programs-surveys/popest/datasets/"
        "2020-2023/counties/totals/co-est2023-alldata.csv"
    ),
    "agesex_2023": (
        "https://www2.census.gov/programs-surveys/popest/datasets/"
        "2020-2023/counties/asrh/cc-est2023-agesex-all.csv"
    ),
    "race_2023": (
        "https://www2.census.gov/programs-surveys/popest/datasets/"
        "2020-2023/counties/asrh/cc-est2023-alldata.csv"
    ),
    "rural_2010": (
        "https://www2.census.gov/geo/docs/reference/ua/PctUrbanRural_County.txt"
    ),
}

# Vintage 2020 AGESEX / ALLDATA YEAR code → July 1 calendar year
# 1=4/1/2010 Census, 2=4/1/2010 base, 3=7/1/2010 … 12=7/1/2019, 13=7/1/2020
YEAR_MAP_2020 = {str(i): 2007 + i for i in range(3, 13)}  # 3→2010 … 12→2019

# Vintage 2023: 1=4/1/2020 base, 2=7/1/2020 … 5=7/1/2023
YEAR_MAP_2023 = {"2": 2020, "3": 2021, "4": 2022, "5": 2023}

STATE_FIPS = [
    "01", "02", "04", "05", "06", "08", "09", "10", "11", "12", "13", "15",
    "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27",
    "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39",
    "40", "41", "42", "44", "45", "46", "47", "48", "49", "50", "51", "53",
    "54", "55", "56",
]

# (code, label, unit, group)
INDICATORS = [
    ("POP", "Total population", "persons", "Population"),
    ("POP_CHG", "Numeric population change", "persons", "Change"),
    ("POP_CHG_PCT", "Percent population change", "%", "Change"),
    ("BIRTHS", "Births", "persons", "Vital events"),
    ("DEATHS", "Deaths", "persons", "Vital events"),
    ("NATURALINC", "Natural increase (births − deaths)", "persons", "Vital events"),
    ("INTERNATIONALMIG", "International migration", "persons", "Migration"),
    ("DOMESTICMIG", "Domestic migration", "persons", "Migration"),
    ("NETMIG", "Net migration", "persons", "Migration"),
    ("PCT_UNDER18", "% Below 18 Years of Age", "%", "Demographics"),
    ("PCT_65PLUS", "% 65 and Older", "%", "Demographics"),
    ("PCT_FEMALE", "% Female", "%", "Demographics"),
    ("PCT_MALE", "% Male", "%", "Demographics"),
    ("PCT_AIAN", "% American Indian or Alaska Native", "%", "Demographics"),
    ("PCT_ASIAN", "% Asian", "%", "Demographics"),
    ("PCT_HISPANIC", "% Hispanic", "%", "Demographics"),
    ("PCT_NHPI", "% Native Hawaiian or Other Pacific Islander", "%", "Demographics"),
    ("PCT_NHBLACK", "% Non-Hispanic Black", "%", "Demographics"),
    ("PCT_NHWHITE", "% Non-Hispanic White", "%", "Demographics"),
    ("PCT_RURAL", "% Rural", "%", "Demographics"),
]

PCT_CODES = {
    "PCT_UNDER18", "PCT_65PLUS", "PCT_FEMALE", "PCT_MALE",
    "PCT_AIAN", "PCT_ASIAN", "PCT_HISPANIC", "PCT_NHPI",
    "PCT_NHBLACK", "PCT_NHWHITE", "PCT_RURAL",
}

STATE_FIPS_TO_ABBR = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
    "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
    "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
    "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
    "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY", "72": "PR",
}


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 1000:
        print(f"  using cache {dest.name}", flush=True)
        return dest
    print(f"  downloading {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "USA-Health-Data-Atlas/1.0"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = resp.read()
    dest.write_bytes(data)
    print(f"  wrote {dest.name} ({len(data):,} bytes)", flush=True)
    return dest


def read_csv(path: Path) -> list[dict]:
    text = path.read_text(encoding="latin-1")
    return list(csv.DictReader(io.StringIO(text)))


def fips_of(row: dict) -> str | None:
    st = str(row.get("STATE", "")).zfill(2)
    co = str(row.get("COUNTY", "")).zfill(3)
    if not st or not co or co == "000":
        return None  # state total rows
    return st + co


def num(row: dict, key: str) -> float | None:
    v = row.get(key)
    if v is None or v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def pct(numer: float | None, denom: float | None) -> float | None:
    if numer is None or denom is None or denom == 0:
        return None
    return round(100.0 * numer / denom, 3)


def pick_year_fields(row: dict, years: list[int]) -> dict[str, dict[int, float | None]]:
    """Extract per-indicator time series from a PEP totals county row."""
    out = {code: {} for code, *_ in INDICATORS if code not in PCT_CODES}
    for y in years:
        pop = num(row, f"POPESTIMATE{y}")
        out["POP"][y] = pop
        chg = num(row, f"NPOPCHG_{y}")
        if chg is None:
            chg = num(row, f"NPOPCHG{y}")
        out["POP_CHG"][y] = chg
        if pop and chg is not None and (pop - chg) != 0:
            out["POP_CHG_PCT"][y] = round(100.0 * chg / (pop - chg), 3)
        else:
            out["POP_CHG_PCT"][y] = None
        for stem, code in [
            ("BIRTHS", "BIRTHS"),
            ("DEATHS", "DEATHS"),
            ("NATURALINC", "NATURALINC"),
            ("INTERNATIONALMIG", "INTERNATIONALMIG"),
            ("DOMESTICMIG", "DOMESTICMIG"),
            ("NETMIG", "NETMIG"),
        ]:
            out[code][y] = num(row, f"{stem}{y}")
    return out


def merge_series(a: dict[int, float | None], b: dict[int, float | None]) -> dict[int, float | None]:
    merged = dict(a)
    for y, v in b.items():
        if v is not None:
            merged[y] = v
    return merged


def ensure_county(counties: dict, fips: str, row: dict) -> dict:
    if fips not in counties:
        st = STATE_FIPS_TO_ABBR.get(fips[:2], fips[:2])
        name = (row.get("CTYNAME") or row.get("COUNTYNAME") or row.get("COUNTY") or fips).strip()
        counties[fips] = {
            "state_abbr": st,
            "county": name,
            "series": {code: {} for code, *_ in INDICATORS},
            # numerators for pop-weighted state % later
            "counts": {code: {} for code in PCT_CODES if code != "PCT_RURAL"},
            "pop_for_pct": {},
        }
    return counties[fips]


def set_pct(c: dict, code: str, year: int, value: float | None, numer: float | None = None, pop: float | None = None) -> None:
    c["series"][code][year] = value
    if code != "PCT_RURAL" and numer is not None and pop is not None:
        c["counts"][code][year] = numer
        c["pop_for_pct"][year] = pop


def ingest_agesex(path: Path, year_map: dict[str, int], counties: dict) -> None:
    print(f"  parsing agesex {path.name}…", flush=True)
    n = 0
    with path.open(encoding="latin-1", newline="") as f:
        for row in csv.DictReader(f):
            fips = fips_of(row)
            if not fips:
                continue
            ycode = str(row.get("YEAR", "")).strip()
            year = year_map.get(ycode)
            if year is None:
                continue
            pop = num(row, "POPESTIMATE")
            if not pop:
                continue
            male = num(row, "POPEST_MALE")
            female = num(row, "POPEST_FEM")
            under18 = None
            u5 = num(row, "UNDER5_TOT")
            a513 = num(row, "AGE513_TOT")
            a1417 = num(row, "AGE1417_TOT")
            if u5 is not None and a513 is not None and a1417 is not None:
                under18 = u5 + a513 + a1417
            age65 = num(row, "AGE65PLUS_TOT")
            c = ensure_county(counties, fips, row)
            set_pct(c, "PCT_UNDER18", year, pct(under18, pop), under18, pop)
            set_pct(c, "PCT_65PLUS", year, pct(age65, pop), age65, pop)
            set_pct(c, "PCT_FEMALE", year, pct(female, pop), female, pop)
            set_pct(c, "PCT_MALE", year, pct(male, pop), male, pop)
            n += 1
    print(f"    agesex rows used: {n:,}", flush=True)


def ingest_race(path: Path, year_map: dict[str, int], counties: dict) -> None:
    """Keep AGEGRP=0 (total) rows only; race alone + Hispanic ethnicity."""
    print(f"  parsing race {path.name} (AGEGRP=0)…", flush=True)
    n = 0
    with path.open(encoding="latin-1", newline="") as f:
        for row in csv.DictReader(f):
            if str(row.get("AGEGRP", "")).strip() not in ("0", "00"):
                continue
            fips = fips_of(row)
            if not fips:
                continue
            ycode = str(row.get("YEAR", "")).strip()
            year = year_map.get(ycode)
            if year is None:
                continue
            pop = num(row, "TOT_POP")
            if not pop:
                continue
            aian = (num(row, "IA_MALE") or 0) + (num(row, "IA_FEMALE") or 0)
            asian = (num(row, "AA_MALE") or 0) + (num(row, "AA_FEMALE") or 0)
            nhpi = (num(row, "NA_MALE") or 0) + (num(row, "NA_FEMALE") or 0)
            hisp = (num(row, "H_MALE") or 0) + (num(row, "H_FEMALE") or 0)
            nhb = (num(row, "NHBA_MALE") or 0) + (num(row, "NHBA_FEMALE") or 0)
            nhw = (num(row, "NHWA_MALE") or 0) + (num(row, "NHWA_FEMALE") or 0)
            c = ensure_county(counties, fips, row)
            set_pct(c, "PCT_AIAN", year, pct(aian, pop), aian, pop)
            set_pct(c, "PCT_ASIAN", year, pct(asian, pop), asian, pop)
            set_pct(c, "PCT_HISPANIC", year, pct(hisp, pop), hisp, pop)
            set_pct(c, "PCT_NHPI", year, pct(nhpi, pop), nhpi, pop)
            set_pct(c, "PCT_NHBLACK", year, pct(nhb, pop), nhb, pop)
            set_pct(c, "PCT_NHWHITE", year, pct(nhw, pop), nhw, pop)
            n += 1
    print(f"    race total-age rows used: {n:,}", flush=True)


def ingest_rural(path: Path, years: list[int], counties: dict) -> None:
    print(f"  parsing rural {path.name}…", flush=True)
    n = 0
    with path.open(encoding="latin-1", newline="") as f:
        for row in csv.DictReader(f):
            st = str(row.get("STATE", "")).zfill(2)
            co = str(row.get("COUNTY", "")).zfill(3)
            if not st or not co or co == "000":
                continue
            fips = st + co
            rural = num(row, "POPPCT_RURAL")
            if rural is None:
                continue
            c = ensure_county(counties, fips, row)
            for y in years:
                c["series"]["PCT_RURAL"][y] = round(rural, 3)
            n += 1
    print(f"    rural counties: {n:,}", flush=True)


def main() -> None:
    paths = {}
    for key in ("2010_2020", "2020_2023", "agesex_2023", "race_2023", "rural_2010"):
        paths[key] = fetch(URLS[key], RAW / {
            "2010_2020": "co-est-2010_2020.csv",
            "2020_2023": "co-est-2020_2023.csv",
            "agesex_2023": "cc-est2023-agesex-all.csv",
            "race_2023": "cc-est2023-alldata.csv",
            "rural_2010": "PctUrbanRural_County.txt",
        }[key])

    # Vintage 2020 characteristics by state (age/sex + race)
    agesex_2020_paths = []
    race_2020_paths = []
    for st in STATE_FIPS:
        agesex_2020_paths.append(
            fetch(
                "https://www2.census.gov/programs-surveys/popest/datasets/"
                f"2010-2020/counties/asrh/CC-EST2020-AGESEX-{st}.csv",
                RAW / f"CC-EST2020-AGESEX-{st}.csv",
            )
        )
        race_2020_paths.append(
            fetch(
                "https://www2.census.gov/programs-surveys/popest/datasets/"
                f"2010-2020/counties/asrh/CC-EST2020-ALLDATA-{st}.csv",
                RAW / f"CC-EST2020-ALLDATA-{st}.csv",
            )
        )

    rows_a = read_csv(paths["2010_2020"])
    rows_b = read_csv(paths["2020_2023"])
    years_a = list(range(2010, 2020))  # POPESTIMATE2010..2019
    years_b = list(range(2020, 2024))  # 2020..2023
    years = years_a + years_b

    counties: dict[str, dict] = {}

    def ingest_totals(rows: list[dict], yrs: list[int]) -> None:
        for row in rows:
            fips = fips_of(row)
            if not fips:
                continue
            series = pick_year_fields(row, yrs)
            c = ensure_county(counties, fips, row)
            for code, ys in series.items():
                c["series"][code] = merge_series(c["series"][code], ys)

    print("Parsing 2010–2019 / 2020 base totals…", flush=True)
    ingest_totals(rows_a, years_a + [2020])
    print("Parsing 2020–2023 totals…", flush=True)
    ingest_totals(rows_b, years_b)

    print("Parsing age/sex characteristics…", flush=True)
    for p in agesex_2020_paths:
        ingest_agesex(p, YEAR_MAP_2020, counties)
    ingest_agesex(paths["agesex_2023"], YEAR_MAP_2023, counties)

    print("Parsing race/ethnicity characteristics…", flush=True)
    for p in race_2020_paths:
        ingest_race(p, YEAR_MAP_2020, counties)
    ingest_race(paths["race_2023"], YEAR_MAP_2023, counties)

    print("Parsing % rural (2010 Census; applied to all years)…", flush=True)
    ingest_rural(paths["rural_2010"], years, counties)

    # Compact county rows: indicator-major blocks × years
    county_rows = []
    for fips in sorted(counties):
        c = counties[fips]
        values = []
        for code, *_ in INDICATORS:
            for y in years:
                v = c["series"][code].get(y)
                if v is None:
                    values.append(None)
                elif code in PCT_CODES or code == "POP_CHG_PCT":
                    values.append(round(float(v), 4))
                elif abs(v) < 1e9:
                    values.append(round(v, 4) if isinstance(v, float) and not float(v).is_integer() else int(round(v)))
                else:
                    values.append(int(v))
        county_rows.append([fips, c["state_abbr"], c["county"], values])

    # State aggregates: sum additive; recompute % from county numerators / pop
    state_acc: dict[str, dict] = {}
    for fips, c in counties.items():
        st = c["state_abbr"]
        if st not in state_acc:
            state_acc[st] = {
                code: {y: 0.0 for y in years} for code, *_ in INDICATORS
            }
            state_acc[st]["_pct_num"] = {code: {y: 0.0 for y in years} for code in PCT_CODES}
            state_acc[st]["_pct_den"] = {code: {y: 0.0 for y in years} for code in PCT_CODES}
            state_acc[st]["_n"] = {y: 0 for y in years}
        for code, *_ in INDICATORS:
            if code in PCT_CODES or code == "POP_CHG_PCT":
                continue
            for y in years:
                v = c["series"][code].get(y)
                if v is not None:
                    state_acc[st][code][y] += v
                    if code == "POP":
                        state_acc[st]["_n"][y] += 1
        for y in years:
            pop = state_acc[st]["POP"][y]
            chg = state_acc[st]["POP_CHG"][y]
            if pop and chg is not None and (pop - chg) != 0:
                state_acc[st]["POP_CHG_PCT"][y] = round(100.0 * chg / (pop - chg), 3)
            else:
                state_acc[st]["POP_CHG_PCT"][y] = None

        # Demographics: sum numerators; rural uses county pop weights
        for code in PCT_CODES:
            for y in years:
                if code == "PCT_RURAL":
                    v = c["series"][code].get(y)
                    pop_y = c["series"]["POP"].get(y)
                    if v is not None and pop_y:
                        state_acc[st]["_pct_num"][code][y] += v * pop_y
                        state_acc[st]["_pct_den"][code][y] += pop_y
                else:
                    numer = c["counts"].get(code, {}).get(y)
                    pop_y = c["pop_for_pct"].get(y) or c["series"]["POP"].get(y)
                    if numer is not None and pop_y:
                        state_acc[st]["_pct_num"][code][y] += numer
                        state_acc[st]["_pct_den"][code][y] += pop_y

    for st, acc in state_acc.items():
        for code in PCT_CODES:
            for y in years:
                den = acc["_pct_den"][code][y]
                numv = acc["_pct_num"][code][y]
                if den:
                    if code == "PCT_RURAL":
                        acc[code][y] = round(numv / den, 3)
                    else:
                        acc[code][y] = round(100.0 * numv / den, 3)
                else:
                    acc[code][y] = None

    state_rows = []
    for st in sorted(state_acc):
        values = []
        for code, *_ in INDICATORS:
            for y in years:
                v = state_acc[st][code].get(y)
                if v is None:
                    values.append(None)
                elif code in PCT_CODES or code == "POP_CHG_PCT":
                    values.append(round(v, 4))
                else:
                    values.append(int(round(v)))
        state_rows.append([st, values])

    pack = {
        "meta": {
            "source": "U.S. Census Bureau · Population Estimates Program (PEP)",
            "source_url": "https://www.census.gov/programs-surveys/popest.html",
            "data_note": (
                "County resident population estimates and components of change "
                "(2010–2019 co-est2020-alldata; 2020–2023 co-est2023-alldata). "
                "Demographic percentages from county characteristics (CC-EST AGESEX & ALLDATA): "
                "% under 18, % 65+, % female/male, race alone, Hispanic, non-Hispanic Black/White. "
                "% Rural is 2010 Census POPPCT_RURAL (constant across years). "
                "Race alone categories may sum over 100% with Hispanic (ethnicity). "
                "State values: sums for counts; demographics recomputed from county numerators."
            ),
            "years": years,
            "geographies": ["states", "counties"],
            "indicators": [
                {"code": c, "label": lab, "unit": unit, "group": grp}
                for c, lab, unit, grp in INDICATORS
            ],
            "codes": [c for c, *_ in INDICATORS],
            "n_counties": len(county_rows),
            "n_states": len(state_rows),
        },
        "county_rows": county_rows,
        "state_rows": state_rows,
    }

    OUT.write_text(
        "window.CENSUS_DEMOGRAPHY = " + json.dumps(pack, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {OUT} · {len(county_rows)} counties · {len(state_rows)} states · "
        f"years {years[0]}–{years[-1]} · {OUT.stat().st_size:,} bytes",
        flush=True,
    )


if __name__ == "__main__":
    main()
