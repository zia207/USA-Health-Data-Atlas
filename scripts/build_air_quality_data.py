#!/usr/bin/env python3
"""Build assets/air_quality_data.js from EPA AirData AQS active monitors + annual means.

Sites: ArcGIS AQS_Monitor_Sites FeatureServer (active monitors).
Means: https://aqs.epa.gov/aqsweb/airdata/annual_conc_by_monitor_{YYYY}.zip (2022–2025).

Source map:
https://epa.maps.arcgis.com/apps/webappviewer/index.html?id=5f239fd3e72f424f98ef3d5def547eb5
"""
from __future__ import annotations

import csv
import io
import json
import re
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "air_quality_data.js"
RAW = ROOT / "data" / "air_quality"
BASE = (
    "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/"
    "AQS_Monitor_Sites/FeatureServer"
)
ANNUAL_URL = "https://aqs.epa.gov/aqsweb/airdata/annual_conc_by_monitor_{year}.zip"
UA = {"User-Agent": "USA-Health-Data-Atlas/1.0 (air quality build)"}
YEARS = [2022, 2023, 2024, 2025]

POLLUTANTS = [
    ("PM25", "PM2.5", 14, "#e11d48", "PM2.5 - NAAQS/AQI", "88101"),
    ("PM10", "PM10", 12, "#f59e0b", "PM10", "81102"),
    ("O3", "Ozone", 10, "#2563eb", "Ozone", "44201"),
    ("NO2", "NO2", 8, "#7c3aed", "NO2", "42602"),
    ("SO2", "SO2", 18, "#0d9488", "SO2", "42401"),
]

# Prefer current primary NAAQS annual / design-value metrics for map coloring.
PRIMARY_STANDARD = {
    "88101": ("PM25 Annual 2012", "24-HR BLK AVG"),
    "81102": ("PM10 24-hour 2006", "24-HR BLK AVG"),
    "44201": ("Ozone 8-hour 2015", "8-HR RUN AVG BEGIN HOUR"),
    "42602": ("NO2 Annual 1971", "1 HOUR"),
    "42401": ("SO2 Annual 1971", "1 HOUR"),
}
# Fallbacks if preferred duration is missing (PM10 filter vs continuous).
DURATION_FALLBACK = {
    "81102": "24 HOUR",
    "88101": "24 HOUR",
}

FIELDS = [
    "AQS_Site_ID", "POC", "State", "City", "CBSA", "Local_Site_Name", "Address",
    "Latitude", "Longitude", "Elevation_meters_MSL", "Monitor_Start_Date",
    "Last_Sample_Date", "Active", "Measurement_Scale", "Sample_Duration",
    "FRMFEM", "Monitor_Type", "Reporting_Agency", "Parameter_Name", "Annual_URLs",
]


def parse_date(s):
    if not s:
        return None
    s = str(s).strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.split(" ")[0], fmt).date()
        except Exception:
            pass
    return None


def years_from_urls(html):
    return sorted({
        int(y) for y in re.findall(r"year=(20\d{2})", html or "")
        if 2022 <= int(y) <= 2025
    })


def fetch_layer(lid: int):
    out = []
    offset = 0
    page = 2000
    while True:
        q = urllib.parse.urlencode({
            "where": "Active='Yes'",
            "outFields": ",".join(FIELDS),
            "returnGeometry": "true",
            "outSR": "4326",
            "resultOffset": str(offset),
            "resultRecordCount": str(page),
            "f": "json",
        })
        url = f"{BASE}/{lid}/query?{q}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
            data = json.load(r)
        feats = data.get("features") or []
        out.extend(feats)
        if not feats or not data.get("exceededTransferLimit"):
            break
        offset += page
    return out


def site_id_from_parts(state, county, site):
    return f"{int(state):02d}-{int(county):03d}-{int(site):04d}"


def download_annual(year: int) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    zpath = RAW / f"annual_conc_by_monitor_{year}.zip"
    if zpath.exists() and zpath.stat().st_size > 100_000:
        print(f"  using cached {zpath.name}", flush=True)
        return zpath
    url = ANNUAL_URL.format(year=year)
    print(f"  downloading {url}", flush=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r:
        zpath.write_bytes(r.read())
    return zpath


def load_annual_means(year: int) -> dict:
    """Return {(site_id, poc, param_code): {mean, unit, std, obs}} for primary standards."""
    zpath = download_annual(year)
    wanted = set(PRIMARY_STANDARD)
    # best row per key by observation count
    best: dict = {}
    with zipfile.ZipFile(zpath) as zf:
        name = zf.namelist()[0]
        with zf.open(name) as f:
            text = io.TextIOWrapper(f, encoding="utf-8", newline="")
            for row in csv.DictReader(text):
                pc = row.get("Parameter Code")
                if pc not in wanted:
                    continue
                std_want, dur_want = PRIMARY_STANDARD[pc]
                if (row.get("Pollutant Standard") or "") != std_want:
                    continue
                dur = row.get("Sample Duration") or ""
                if dur != dur_want and dur != DURATION_FALLBACK.get(pc):
                    continue
                mean_s = (row.get("Arithmetic Mean") or "").strip()
                if not mean_s:
                    continue
                try:
                    mean = float(mean_s)
                    obs = int(float(row.get("Observation Count") or 0))
                except ValueError:
                    continue
                sid = site_id_from_parts(
                    row["State Code"], row["County Code"], row["Site Num"]
                )
                poc = int(row["POC"])
                key = (sid, poc, pc)
                # Prefer exact duration over fallback; then higher obs count
                exact = 1 if dur == dur_want else 0
                prev = best.get(key)
                score = (exact, obs)
                if prev is None or score > prev["_score"]:
                    best[key] = {
                        "mean": round(mean, 4),
                        "unit": row.get("Units of Measure") or "",
                        "std": std_want,
                        "obs": obs,
                        "_score": score,
                    }
    for v in best.values():
        v.pop("_score", None)
    print(f"  {year}: {len(best)} primary-standard means", flush=True)
    return best


def main():
    code_to_param = {c: pc for c, _, _, _, _, pc in POLLUTANTS}
    sites = []
    counts = {}
    for code, label, lid, color, polname, _pc in POLLUTANTS:
        print(f"Fetching {label}…", flush=True)
        n = 0
        for f in fetch_layer(lid):
            a = f.get("attributes") or {}
            g = f.get("geometry") or {}
            lon = g.get("x", a.get("Longitude"))
            lat = g.get("y", a.get("Latitude"))
            if lon is None or lat is None:
                continue
            last = parse_date(a.get("Last_Sample_Date"))
            years = years_from_urls(a.get("Annual_URLs"))
            if last and last.year < 2022 and not years:
                continue
            if not years and (not last or last.year < 2022):
                continue
            poc = a.get("POC")
            try:
                poc = int(poc) if poc is not None and str(poc).strip() != "" else None
            except (TypeError, ValueError):
                poc = None
            sites.append({
                "p": code,
                "id": a.get("AQS_Site_ID"),
                "poc": poc,
                "n": a.get("Local_Site_Name") or a.get("City") or a.get("AQS_Site_ID"),
                "st": a.get("State"),
                "city": a.get("City") or "",
                "cbsa": a.get("CBSA") or "",
                "addr": a.get("Address") or "",
                "lat": round(float(lat), 6),
                "lon": round(float(lon), 6),
                "elev": a.get("Elevation_meters_MSL"),
                "start": a.get("Monitor_Start_Date") or "",
                "last": a.get("Last_Sample_Date") or "",
                "scale": a.get("Measurement_Scale") or "",
                "dur": a.get("Sample_Duration") or "",
                "frm": a.get("FRMFEM") or "",
                "type": a.get("Monitor_Type") or "",
                "agency": a.get("Reporting_Agency") or "",
                "param": a.get("Parameter_Name") or polname,
                "yrs": years or [y for y in range(2022, 2026) if last and last.year >= y],
                "means": {},
                "unit": "",
                "std": "",
            })
            n += 1
        counts[code] = n

    print("Loading annual concentration files…", flush=True)
    annual_by_year = {y: load_annual_means(y) for y in YEARS}

    matched = {y: 0 for y in YEARS}
    units = {}
    stds = {}
    for s in sites:
        pc = code_to_param[s["p"]]
        if s["poc"] is None:
            continue
        means = {}
        for y in YEARS:
            row = annual_by_year[y].get((s["id"], s["poc"], pc))
            if not row:
                continue
            means[str(y)] = row["mean"]
            matched[y] += 1
            units[s["p"]] = row["unit"]
            stds[s["p"]] = row["std"]
            if not s["unit"]:
                s["unit"] = row["unit"]
                s["std"] = row["std"]
        s["means"] = means
        # Prefer yrs that have actual means; keep URL years if no means
        if means:
            s["yrs"] = sorted(int(y) for y in means)

    with_means = sum(1 for s in sites if s["means"])
    payload = {
        "meta": {
            "source": "U.S. EPA OAQPS AirData AQS monitors",
            "source_url": (
                "https://epa.maps.arcgis.com/apps/webappviewer/index.html"
                "?id=5f239fd3e72f424f98ef3d5def547eb5"
            ),
            "service": BASE,
            "annual_source": "https://aqs.epa.gov/aqsweb/airdata/download_files.html",
            "years": YEARS,
            "status": "Active",
            "metric": "Arithmetic Mean (primary NAAQS standard)",
            "standards": {
                c: {"param_code": pc, "standard": PRIMARY_STANDARD[pc][0], "unit": units.get(c, "")}
                for c, _, _, _, _, pc in POLLUTANTS
            },
            "pollutants": [
                {
                    "code": c,
                    "label": l,
                    "layer": lid,
                    "color": col,
                    "n": counts.get(c, 0),
                    "param": pn,
                    "param_code": pc,
                    "standard": PRIMARY_STANDARD[pc][0],
                    "unit": units.get(c, ""),
                }
                for c, l, lid, col, pn, pc in POLLUTANTS
            ],
            "n_sites": len(sites),
            "n_with_means": with_means,
            "means_matched": matched,
        },
        "sites": sites,
    }
    OUT.write_text(
        "window.AIR_QUALITY_AQS = " + json.dumps(payload, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB) · "
        f"{len(sites)} sites · {with_means} with means · matched/year {matched}"
    )


if __name__ == "__main__":
    main()
