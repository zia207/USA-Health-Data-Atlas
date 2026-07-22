#!/usr/bin/env python3
"""Build religion_census_documentation.html from Religion_Census_Data.md."""
from __future__ import annotations

import re
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parents[1]
MD_FILE = ROOT / "data" / "religion_census" / "Religion_Census_Data.md"
OUT = ROOT / "religion_census_documentation.html"

ARDA_URL = "https://www.thearda.com/data-archive?fid=RCMSCY10"
US_RELIGION_URL = "https://www.usreligioncensus.org/"

HTML_SHELL = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Religion Census Documentation · USA-Health Data Atlas</title>
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
.doc-section em {{ color: #33474f; }}
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
          <div class="eyebrow">USA-Health Data Atlas · RCMS / ARDA</div>
          <h1 class="page-title">Religion Census <span>Documentation</span></h1>
          <p class="sub">
            Dataset documentation for county-level religious congregations, adherents,
            and adherence rates from the Religious Congregations &amp; Membership Study (RCMS) 2010.
          </p>
        </div>
        <div class="banner-aside">
          <img class="banner-logo" src="upatta_logo.png" alt="Upatta Data Analytics" width="110" height="110"/>
          <nav class="explorer-nav" aria-label="Atlas navigation">
            <a href="usa_health_data_atlas.html">Home</a>
            <a href="usa_religion_census.html">Religion Census</a>
            <a class="active" href="religion_census_documentation.html" aria-current="page">Documentation</a>
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
      <div class="actions">
        <a class="btn" href="usa_religion_census.html">Open Religion Explorer</a>
        <a class="btn ghost" href="{arda_url}" target="_blank" rel="noopener">ARDA RCMS 2010</a>
        <a class="btn ghost" href="{us_religion_url}" target="_blank" rel="noopener">US Religion Census</a>
      </div>
    </aside>
    <main class="content">
      <article class="doc-section" id="religion-census">{body}</article>
    </main>
  </div>

  <footer class="footer">
  Generated from <code>data/religion_census/Religion_Census_Data.md</code>.
  County religion data from the Religious Congregations &amp; Membership Study (RCMS) 2010.
  </footer>
</body>
</html>
"""


def slugify(text: str) -> str:
    s = text.lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s.strip())
    return s[:64].rstrip("-")


def add_h2_ids(html: str) -> tuple[str, list[tuple[str, str]]]:
    toc: list[tuple[str, str]] = []

    def repl(match: re.Match[str]) -> str:
        title = match.group(1)
        slug = slugify(title)
        toc.append((slug, title))
        return f'<h2 id="{slug}">{title}</h2>'

    updated = re.sub(r"<h2>(.*?)</h2>", repl, html, flags=re.DOTALL)
    return updated, toc


def main() -> None:
    md_text = MD_FILE.read_text(encoding="utf-8")
    md = markdown.Markdown(extensions=["tables", "fenced_code", "sane_lists", "smarty"])
    body = md.convert(md_text)
    body, toc = add_h2_ids(body)

    toc_items = "\n        ".join(
        f'<li><a href="#{slug}">{title}</a></li>' for slug, title in toc
    )

    html = HTML_SHELL.format(
        toc_items=toc_items,
        body=body,
        arda_url=ARDA_URL,
        us_religion_url=US_RELIGION_URL,
    )
    OUT.write_text(html, encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
