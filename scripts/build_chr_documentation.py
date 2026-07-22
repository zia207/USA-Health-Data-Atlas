#!/usr/bin/env python3
"""Build per-year CHR documentation HTML pages from Markdown sources."""

from __future__ import annotations

import re
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "data" / "county_health_ranking" / "docs"
YEARS = [2020, 2021, 2022, 2023, 2024, 2025]

CHR_URL = "https://www.countyhealthrankings.org/health-data/methodology-and-sources/data-documentation"

HTML_SHELL = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CHR County Data {year} · USA-Health Data Atlas</title>
<style>
:root {{
  --ink: #0b1f2a; --panel: #ffffff; --rail: #0e3a4f; --accent: #1d7a8c;
  --paper: #e8eef1; --hair: #c5d0d6; --steel: #5a6e78; --lake: #14707e;
  --focus: #0e4f8b;
}}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  background: var(--paper); color: var(--ink); line-height: 1.55;
}}
a {{ color: var(--lake); }}
:focus-visible {{ outline: 3px solid var(--focus); outline-offset: 2px; }}
.banner {{
  background: linear-gradient(90deg, #071821 0%, #0e3a4f 55%, #14586f 100%);
  color: #e8f2f5; border-bottom: 4px solid var(--accent);
}}
.banner-inner {{ max-width: 1180px; margin: 0 auto; padding: 18px 20px 20px; }}
.banner-top {{ display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: flex-start; }}
.banner-copy {{ min-width: 0; flex: 1; }}
.banner-aside {{ flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }}
.banner-logo {{
  display: block; width: clamp(72px, 12vw, 110px); height: auto;
  background: #fff; border-radius: 10px; padding: 5px;
  box-shadow: 0 2px 10px rgba(0,0,0,.18);
}}
.explorer-nav {{ display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: 520px; }}
.explorer-nav a {{
  display: inline-block; background: rgba(255,255,255,.08); color: #e8f2f5;
  text-decoration: none; border: 1px solid rgba(255,255,255,.22);
  padding: 6px 10px; font-size: 12px; white-space: nowrap;
}}
.explorer-nav a:hover {{ background: rgba(255,255,255,.14); }}
.explorer-nav a.active {{ background: var(--accent); border-color: var(--accent); color: #fff; }}
.eyebrow {{
  font-family: ui-monospace, Consolas, monospace; font-size: 11px;
  letter-spacing: .14em; text-transform: uppercase; color: #8fb6bd;
}}
h1.page-title {{ margin: 8px 0 6px; font-size: clamp(26px, 3.5vw, 38px); line-height: 1.08; font-weight: 750; }}
h1.page-title span {{ color: #7fcad4; }}
.sub {{ color: #b9c9ce; font-size: 14px; max-width: 820px; }}
.layout {{
  max-width: 1180px; margin: 0 auto; padding: 14px 16px 48px;
  display: grid; grid-template-columns: 240px 1fr; gap: 18px;
}}
@media (max-width: 900px) {{ .layout {{ grid-template-columns: 1fr; }} }}
.toc {{
  position: sticky; top: 12px; align-self: start;
  background: var(--panel); border: 1px solid var(--hair); padding: 14px;
}}
@media (max-width: 900px) {{ .toc {{ position: static; }} }}
.toc h2 {{
  font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--steel); margin: 0 0 10px; font-family: ui-monospace, Consolas, monospace;
}}
.toc ul {{ list-style: none; }}
.toc li {{ margin-bottom: 6px; }}
.toc a {{ text-decoration: none; font-size: 13px; color: var(--rail); font-weight: 600; }}
.toc a:hover {{ color: var(--accent); }}
.year-nav {{ margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--hair); }}
.year-nav h3 {{
  font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--steel); margin: 0 0 8px; font-family: ui-monospace, Consolas, monospace;
}}
.year-nav a {{
  display: inline-block; margin: 0 6px 6px 0; font-size: 12px; font-weight: 600;
  text-decoration: none; color: var(--rail); border: 1px solid var(--hair); padding: 3px 8px;
}}
.year-nav a.active {{ background: var(--rail); color: #fff; border-color: var(--rail); }}
.actions {{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }}
.btn {{
  display: inline-block; background: var(--rail); color: #fff; text-decoration: none;
  padding: 8px 12px; font-size: 13px; font-weight: 650;
}}
.btn:hover {{ background: var(--accent); }}
.btn.ghost {{ background: transparent; color: var(--rail); border: 1px solid var(--hair); }}
.btn.ghost:hover {{ border-color: var(--accent); color: var(--accent); }}
.content {{ min-width: 0; }}
.doc-section {{
  background: var(--panel); border: 1px solid var(--hair); padding: 20px 22px 28px;
  margin-bottom: 16px;
}}
.doc-section h1 {{ font-size: 1.45rem; margin: 0 0 .6em; line-height: 1.2; }}
.doc-section h2 {{
  font-size: 1.15rem; margin: 1.4em 0 .45em; padding-bottom: 4px;
  border-bottom: 1px solid var(--hair); line-height: 1.25;
}}
.doc-section h3 {{ font-size: 1rem; margin: 1.1em 0 .35em; }}
.doc-section p, .doc-section ul, .doc-section ol {{ margin: .55em 0; }}
.doc-section li {{ margin: .2em 0 .2em 1.2em; }}
.doc-section table {{
  width: 100%; border-collapse: collapse; font-size: 13px; margin: .8em 0;
}}
.doc-section th, .doc-section td {{
  border: 1px solid var(--hair); padding: 7px 9px; text-align: left; vertical-align: top;
}}
.doc-section th {{ background: #0e3a4f; color: #fff; font-weight: 600; }}
.doc-section tr:nth-child(even) td {{ background: #f4f8f8; }}
.doc-section code {{
  font-family: ui-monospace, Consolas, monospace; font-size: .9em;
  background: #eef5f7; padding: 1px 4px;
}}
.doc-section pre {{
  background: #14262e; color: #b9e0e6; padding: 12px 14px; overflow: auto;
  font-size: 12px; line-height: 1.45; margin: .8em 0;
}}
.doc-section pre code {{ background: transparent; padding: 0; color: inherit; }}
.doc-section hr {{ border: none; border-top: 1px solid var(--hair); margin: 1.5em 0; }}
.footer {{
  max-width: 1180px; margin: 0 auto; padding: 0 16px 36px;
  font-size: 12px; color: var(--steel);
}}
</style>
</head>
<body>
  <header class="banner">
    <div class="banner-inner">
      <div class="banner-top">
        <div class="banner-copy">
          <div class="eyebrow">USA-Health Data Atlas · County Health Rankings</div>
          <h1 class="page-title">CHR County Data <span>{year}</span></h1>
          <p class="sub">
            Data dictionary and measure sources for the consolidated
            <code>chr_county_{year}.csv</code> file used in the County Health Rankings explorer.
          </p>
        </div>
        <div class="banner-aside">
          <img class="banner-logo" src="upatta_logo.png" alt="Upatta Data Analytics" width="110" height="110"/>
          <nav class="explorer-nav" aria-label="Atlas navigation">
            <a href="usa_health_data_atlas.html">Home</a>
            <a href="usa_county_health_rankings.html">CHR Explorer</a>
            <a class="active" href="chr_documentation_{year}.html" aria-current="page">Documentation</a>
          </nav>
        </div>
      </div>
    </div>
  </header>

  <div class="layout">
    <aside class="toc" aria-label="Table of contents">
      <h2>On this page</h2>
      <ul>
        {toc_items}
      </ul>
      <div class="year-nav">
        <h3>Other years</h3>
        {year_links}
      </div>
      <div class="actions">
        <a class="btn" href="usa_county_health_rankings.html">Open CHR Explorer</a>
        <a class="btn ghost" href="{chr_url}" target="_blank" rel="noopener">CHR official docs</a>
        <a class="btn ghost" href="data/county_health_ranking/chr_county_{year}.csv">Download CSV</a>
      </div>
    </aside>
    <main class="content">
      <article class="doc-section">{body}</article>
    </main>
  </div>

  <footer class="footer">
  Generated from <code>data/county_health_ranking/docs/CHR_County_Data_{year}.md</code>.
  County values are primary/mean measures from the CHR national release; verify against
  <a href="{chr_url}" target="_blank" rel="noopener">official CHR documentation</a> before publication.
  </footer>
</body>
</html>
"""


def slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[\s_]+", "-", s.strip())[:64].rstrip("-")


def build_toc(html: str) -> tuple[str, str]:
    headings = re.findall(r"<h([23]) id=\"([^\"]+)\">([^<]+)</h\\1>", html)
    if not headings:
        headings = re.findall(r"<h([23])>([^<]+)</h\\1>", html)
        html_with_ids = html
        toc_items = []
        for i, m in enumerate(re.findall(r"<h([23])>([^<]+)</h\\1>", html)):
            level, title = m
            hid = slugify(title) or f"section-{i}"
            html_with_ids = html_with_ids.replace(f"<h{level}>{title}</h{level}>", f'<h{level} id="{hid}">{title}</h{level}>', 1)
            toc_items.append(f'<li><a href="#{hid}">{title}</a></li>')
        return "\n        ".join(toc_items), html_with_ids
    return "\n        ".join(f'<li><a href="#{hid}">{title}</a></li>' for _, hid, title in headings), html


def year_nav(active: int) -> str:
    parts = []
    for y in YEARS:
        cls = ' class="active"' if y == active else ""
        parts.append(f'<a href="chr_documentation_{y}.html"{cls}>{y}</a>')
    return "\n        ".join(parts)


def main() -> None:
    for year in YEARS:
        md_path = DOCS_DIR / f"CHR_County_Data_{year}.md"
        if not md_path.exists():
            print(f"skip {year}: missing {md_path}")
            continue
        md_text = md_path.read_text(encoding="utf-8")
        body = markdown.markdown(md_text, extensions=["tables", "fenced_code"])
        toc_items, body = build_toc(body)
        html = HTML_SHELL.format(
            year=year,
            toc_items=toc_items,
            year_links=year_nav(year),
            body=body,
            chr_url=CHR_URL,
        )
        out = ROOT / f"chr_documentation_{year}.html"
        out.write_text(html, encoding="utf-8")
        print(f"wrote {out.name}")


if __name__ == "__main__":
    main()
