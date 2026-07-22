#!/usr/bin/env python3
"""Build assets/geojson_ct_planning_regions.js from Census CT planning-region boundaries."""
from __future__ import annotations

import io
import json
import os
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_JS = ROOT / "assets" / "geojson_ct_planning_regions.js"
OUT_GEO = ROOT / "data" / "places" / "ct_planning_regions.geojson"
CENSUS_URL = "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip"


def main() -> None:
    try:
        import geopandas as gpd
    except ImportError as exc:
        raise SystemExit("geopandas is required: pip install geopandas") from exc

    buf = io.BytesIO(urllib.request.urlopen(CENSUS_URL, timeout=120).read())
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(buf) as zf:
            zf.extractall(tmp)
        shp = next(p for p in os.listdir(tmp) if p.endswith(".shp"))
        gdf = gpd.read_file(os.path.join(tmp, shp))
    ct = gdf[gdf["STATEFP"] == "09"].to_crs(4326)
    features = []
    for _, row in ct.iterrows():
        geoid = str(row["GEOID"]).zfill(5)
        features.append({
            "type": "Feature",
            "id": geoid,
            "properties": {
                "STATE": "09",
                "COUNTY": geoid[2:],
                "NAME": row["NAME"],
                "GEOID": geoid,
            },
            "geometry": row.geometry.__geo_interface__,
        })
    geo = {"type": "FeatureCollection", "features": features}
    OUT_GEO.parent.mkdir(parents=True, exist_ok=True)
    OUT_GEO.write_text(json.dumps(geo, separators=(",", ":")))
    OUT_JS.write_text(
        "window.CT_PLANNING_REGION_GEO = "
        + json.dumps(geo, separators=(",", ":"))
        + ";\n"
    )
    print(f"Wrote {OUT_JS} ({OUT_JS.stat().st_size:,} bytes, {len(features)} regions)")


if __name__ == "__main__":
    main()
