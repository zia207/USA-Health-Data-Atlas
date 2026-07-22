#!/usr/bin/env python3
"""Build assets/mortality_county_data.js from NIMHD HDPulse mortality API.

Source portal:
https://hdpulse.nimhd.nih.gov/data-portal/mortality/map
API: /data-portal/api/data_setup.php (getExport)
"""
from __future__ import annotations

import csv
import io
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "mortality_county_data.js"

API = "https://hdpulse.nimhd.nih.gov/data-portal/api/data_setup.php"
UA = {
    "User-Agent": "USA-Health-Data-Atlas/1.0 (mortality explorer build)",
    "Accept": "application/json",
    "Referer": "https://hdpulse.nimhd.nih.gov/data-portal/mortality/map",
}

# HDPulse cause-of-death codes (cod_15 set)
CAUSES = [
    ("247", "All Causes of Death"),
    ("250", "Heart Disease"),
    ("001", "Cancer"),
    ("251", "Accidents"),
    ("249", "Cerebrovascular Diseases"),
    ("253", "Chronic Lower Respiratory Disease"),
    ("264", "Alzheimer's Disease"),
    ("254", "Diabetes Mellitus"),
    ("256", "Suicide & Self-Inflicted Injury"),
    ("258", "Kidney Disease (Nephritis & Nephrosis)"),
    ("257", "Chronic Liver Disease & Cirrhosis"),
    ("278", "Pneumonia"),
    ("259", "Septicemia"),
    ("260", "Homicide & Legal Intervention"),
    ("277", "Influenza"),
]

STATE_FIPS = {
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

BASE_PARAMS = {
    "path": "mortality",
    "displayType": "export",
    "function": "getExport",
    "age": "001",
    "age_options": "age_11",
    "race": "00",
    "race_options": "race_6",
    "sex": "0",
    "sex_options": "sex_3",
    "ratetype": "aa",
    "ratetype_options": "ratetype_2",
    "ruralurban": "0",
    "ruralurban_options": "ruralurban_3",
    "yeargroup": "5",
    "yeargroup_options": "year5yearmort_1",
    "cod_options": "cod_15",
}


def api_export(cod: str, statefips: str) -> str:
    params = dict(BASE_PARAMS)
    params["cod"] = cod
    params["statefips"] = statefips
    params["statefips_options"] = "area_us" if statefips == "00" else "area_states"
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode("utf-8").lstrip())
    csv_data = payload.get("csvData")
    if not csv_data:
        raise RuntimeError(f"No csvData for cod={cod} statefips={statefips}")
    return csv_data


def parse_num(s: str):
    if s is None:
        return None
    t = str(s).strip().replace(",", "").replace('"', "")
    if t in ("", "NA", "*", "—", "-"):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def parse_export_csv(text: str):
    """Return list of dicts with fips, name, rate, count, trend."""
    lines = text.splitlines()
    # Find header row starting with County, or State,
    header_i = None
    for i, line in enumerate(lines):
        if line.startswith("County,") or line.startswith("State,"):
            header_i = i
            break
    if header_i is None:
        raise RuntimeError("CSV header not found")
    reader = csv.DictReader(io.StringIO("\n".join(lines[header_i:])))
    rows = []
    for row in reader:
        # column names vary slightly; find FIPS + rate
        keys = list(row.keys())
        fips_key = next((k for k in keys if k.strip().upper() == "FIPS"), None)
        name_key = keys[0]
        rate_key = next((k for k in keys if "Age-Adjusted Death Rate" in k or "Death Rate" in k), None)
        count_key = next((k for k in keys if "Average Annual Count" in k), None)
        trend_key = next((k for k in keys if k.strip() == "Recent 5-Year Trend" or k.strip().startswith("Recent 5-Year Trend") and "in Death" not in k), None)
        if not fips_key or not rate_key:
            continue
        fips = str(row[fips_key]).strip().replace('"', "").zfill(5)
        if len(fips) == 5 and fips.endswith("000") and fips[:2] != "00":
            # state rows sometimes coded as SS000
            pass
        name = str(row[name_key]).strip().strip('"')
        rate = parse_num(row.get(rate_key))
        count = parse_num(row.get(count_key)) if count_key else None
        trend = (row.get(trend_key) or "").strip().strip('"').lower() if trend_key else ""
        if trend not in ("rising", "falling", "stable"):
            trend = ""
        rows.append({"fips": fips, "name": name, "rate": rate, "count": count, "trend": trend})
    return rows


def main():
    codes = [c[0] for c in CAUSES]
    labels = [{"code": c, "label": lab} for c, lab in CAUSES]
    n = len(codes)

    state_map = {}  # abbr -> {name, fips, rates[n], counts[n]}
    county_map = {}  # fips -> {county, state_abbr, rates[n], counts[n]}
    year_group = "2019-2023"
    us_rates = [None] * n

    for i, (cod, label) in enumerate(CAUSES):
        print(f"[{i+1}/{n}] {label} ({cod}) — states…", flush=True)
        state_csv = api_export(cod, "00")
        # year from subtitle line
        for line in state_csv.splitlines()[:6]:
            if "201" in line and "-" in line:
                # e.g. "... 2019-2023"
                import re
                m = re.search(r"(20\d{2}-20\d{2})", line)
                if m:
                    year_group = m.group(1)
                break
        for r in parse_export_csv(state_csv):
            fips = r["fips"]
            if fips in ("00000", "0000"):
                us_rates[i] = r["rate"]
                continue
            # state fips may be 5-digit SS000 or 2-digit
            sf = fips[:2] if len(fips) >= 2 else fips
            abbr = STATE_FIPS.get(sf)
            if not abbr:
                # DC sometimes 11001
                if fips.startswith("11"):
                    abbr = "DC"
                else:
                    continue
            rec = state_map.setdefault(
                abbr,
                {
                    "name": r["name"].replace(" District of Columbia", "District of Columbia"),
                    "fips": sf.zfill(2),
                    "rates": [None] * n,
                    "counts": [None] * n,
                },
            )
            if r["name"] and r["name"] not in ("United States",):
                rec["name"] = r["name"]
            rec["rates"][i] = r["rate"]
            rec["counts"][i] = r["count"]

        print(f"    counties…", flush=True)
        county_csv = api_export(cod, "99")
        for r in parse_export_csv(county_csv):
            fips = r["fips"]
            if fips in ("00000", "0000") or r["name"] == "United States":
                continue
            if len(fips) != 5:
                continue
            # HDPulse county tables include state aggregates as SS000 — skip those
            if fips.endswith("000"):
                continue
            sf = fips[:2]
            abbr = STATE_FIPS.get(sf)
            if not abbr:
                continue
            rec = county_map.setdefault(
                fips,
                {
                    "county": r["name"],
                    "state_abbr": abbr,
                    "rates": [None] * n,
                    "counts": [None] * n,
                },
            )
            rec["county"] = r["name"]
            rec["rates"][i] = r["rate"]
            rec["counts"][i] = r["count"]
        time.sleep(0.35)

    state_rows = []
    for abbr in sorted(state_map.keys()):
        rec = state_map[abbr]
        state_rows.append([abbr, rec["fips"], rec["name"], rec["rates"], rec["counts"]])

    county_rows = []
    for fips in sorted(county_map.keys()):
        rec = county_map[fips]
        county_rows.append([fips, rec["state_abbr"], rec["county"], rec["rates"], rec["counts"]])

    payload = {
        "meta": {
            "source": "NIMHD HDPulse",
            "source_url": "https://hdpulse.nimhd.nih.gov/data-portal/mortality/map",
            "year_group": year_group,
            "rate_type": "age-adjusted deaths per 100,000",
            "population": "All races (includes Hispanic/Latino), Both sexes, All ages",
            "ruralurban": "All (metro + non-metro)",
            "causes": labels,
            "codes": codes,
            "us_rates": us_rates,
            "n_states": len(state_rows),
            "n_counties": len(county_rows),
        },
        "state_rows": state_rows,
        "county_rows": county_rows,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    js = "window.MORTALITY_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n"
    OUT.write_text(js, encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")
    print(f"States {len(state_rows)} · Counties {len(county_rows)} · Causes {n} · Years {year_group}")


if __name__ == "__main__":
    main()
