#!/usr/bin/env python3
"""Check the static site is self-contained and internally consistent.

GitHub Pages serves whatever is in web/ with no build step, so the failure modes
are boring and total: a mistyped import path, a module that never loads, a
reference to a host that is not there. None of those show up in a Python test
suite, and all of them produce a blank page. This catches them in CI.

    python3 web/check_site.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent
ERRORS: list[str] = []


def error(msg: str) -> None:
    ERRORS.append(msg)
    print(f"  FAIL  {msg}")


def ok(msg: str) -> None:
    print(f"  PASS  {msg}")


def check_files() -> None:
    required = ["index.html", "style.css", "app.js", "synth.js", "visual.js",
                "presets.js", "vendor/paper-core.min.js"]
    for name in required:
        p = WEB / name
        if not p.is_file():
            error(f"missing {name}")
        elif p.stat().st_size == 0:
            error(f"{name} is empty")
        else:
            ok(f"{name} present ({p.stat().st_size:,} bytes)")


def check_local_references() -> None:
    """Every src/href in the HTML must resolve to a file we actually ship."""
    html = (WEB / "index.html").read_text(encoding="utf-8")
    refs = re.findall(r'(?:src|href)\s*=\s*"([^"]+)"', html)
    for ref in refs:
        if ref.startswith(("http://", "https://", "data:", "#", "mailto:")):
            continue
        target = (WEB / ref.lstrip("./")).resolve()
        if not target.is_file():
            error(f"index.html references {ref}, which does not exist")
        else:
            ok(f"resolves {ref}")


def check_no_remote_runtime() -> None:
    """No third-party host in the runtime path.

    Documentation links out to GitHub, which is fine; a <script src> or a
    stylesheet pointing at someone else's CDN is not, because the page then
    breaks whenever that host does.
    """
    html = (WEB / "index.html").read_text(encoding="utf-8")
    remote = re.findall(r'<(?:script|link)[^>]*(?:src|href)\s*=\s*"(https?://[^"]+)"', html)
    if remote:
        for r in remote:
            error(f"remote runtime dependency: {r}")
    else:
        ok("no remote scripts or stylesheets")


def check_module_graph() -> None:
    """Follow the ES module imports from app.js and confirm each target exists."""
    seen: set[Path] = set()
    stack = [WEB / "app.js"]
    while stack:
        path = stack.pop()
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        for spec in re.findall(r'^\s*(?:import|export)[^\'"]*from\s+["\']([^"\']+)["\']',
                               path.read_text(encoding="utf-8"), re.M):
            if not spec.startswith("."):
                error(f"{path.name} imports bare specifier {spec!r}; "
                      "no bundler runs here, so it will not resolve")
                continue
            target = (path.parent / spec).resolve()
            if not target.is_file():
                error(f"{path.name} imports {spec}, which does not exist")
            else:
                stack.append(target)
    ok(f"module graph resolves ({len(seen)} files reachable from app.js)")


def check_exports_match_imports() -> None:
    """Named imports must actually be exported by the target module.

    A typo here is silent at parse time and throws on load, i.e. a blank page.
    """
    for path in WEB.glob("*.js"):
        src = path.read_text(encoding="utf-8")
        for names, spec in re.findall(
                r'import\s*\{([^}]+)\}\s*from\s+["\'](\.[^"\']+)["\']', src):
            target = (path.parent / spec).resolve()
            if not target.is_file():
                continue
            tsrc = target.read_text(encoding="utf-8")
            exported = set(re.findall(
                r'export\s+(?:const|let|var|function|class)\s+(\w+)', tsrc))
            exported |= {n.strip() for group in re.findall(r'export\s*\{([^}]+)\}', tsrc)
                         for n in group.split(",")}
            for name in (n.strip().split(" as ")[0].strip() for n in names.split(",")):
                if name and name not in exported:
                    error(f"{path.name} imports {{{name}}} from {spec}, "
                          f"which does not export it")
    ok("named imports match exports")


def check_feature_keys() -> None:
    """The slider keys must match the keys the presets carry, or a preset
    silently fails to move half the controls."""
    synth = (WEB / "synth.js").read_text(encoding="utf-8")
    block = synth[synth.index("export const FEATURES"):]
    block = block[:block.index("];") + 2]
    keys = set(re.findall(r'key:\s*"(\w+)"', block))

    presets = (WEB / "presets.js").read_text(encoding="utf-8")
    first = presets[presets.index('"features"'):]
    first = first[:first.index("}") + 1]
    pkeys = set(re.findall(r'"(\w+)":', first)) - {"features"}

    missing = keys - pkeys
    extra = pkeys - keys
    if missing:
        error(f"FEATURES has keys the presets lack: {sorted(missing)}")
    if extra:
        error(f"presets have keys FEATURES lacks: {sorted(extra)}")
    if not missing and not extra:
        ok(f"{len(keys)} feature keys align between sliders and presets")


if __name__ == "__main__":
    print("Static site")
    check_files()
    check_local_references()
    check_no_remote_runtime()
    check_module_graph()
    check_exports_match_imports()
    check_feature_keys()

    print()
    if ERRORS:
        print(f"{len(ERRORS)} problem(s)")
        sys.exit(1)
    print("site looks deployable")
