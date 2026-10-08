"""Validate suite feature coverage, Item/test references and local document links."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote


SERVICES = (
    ("j-auth", "AU", "features.md", "feature-specifications.md"),
    ("j-groupware", "GW", "features.md", "feature-specifications.md"),
    ("j-messenger", "MS", "suite-integration-features.md", "suite-integration-specifications.md"),
    ("j-mail", "ML", "features.md", "feature-specifications.md"),
    ("j-customer-auth-db", "CA", "features.md", "feature-specifications.md"),
    ("j-approval", "AP", "features.md", "feature-specifications.md"),
    ("j-talk", "TK", "features.md", "feature-specifications.md"),
    ("j-web", "WB", "features.md", "feature-specifications.md"),
)
FEATURE = re.compile(r"^(?:AU|GW|MS|ML|CA|AP|TK|WB)-\d+$")
TEST = re.compile(r"\b(?:AU|GW|MS|ML|CA|AP|TK|WB)-T\d+\b")
ITEM = re.compile(r"\b(?:I|G|M|E|C|A|T|H|X)\d+\b")
LINK = re.compile(r"(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)")


def table_rows(text: str):
    for line_number, line in enumerate(text.splitlines(), 1):
        if line.startswith("|"):
            yield line_number, [cell.strip() for cell in re.split(r"(?<!\\)\|", line)[1:-1]]


def feature_rows(path: Path, errors: list[str]):
    found = {}
    for line, cells in table_rows(path.read_text(encoding="utf-8")):
        if cells and FEATURE.fullmatch(cells[0]):
            if cells[0] in found:
                errors.append(f"{path}:{line}: duplicate feature {cells[0]}")
            found[cells[0]] = (line, cells)
    return found


def local_links(path: Path, errors: list[str]):
    text = re.sub(r"```[^\n]*\n.*?```", "", path.read_text(encoding="utf-8"), flags=re.S)
    count = 0
    for match in LINK.finditer(text):
        target = unquote(match.group(1).strip().strip("<>"))
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
            continue
        relative, _, anchor = target.partition("#")
        destination = (path.parent / relative).resolve() if relative else path
        count += 1
        if not destination.is_file():
            errors.append(f"{path}: missing link {target}")
        elif anchor and destination.suffix == ".md":
            body = destination.read_text(encoding="utf-8")
            explicit = re.findall(r'<a\s+id=[\"\']([^\"\']+)[\"\']', body)
            headings = [re.sub(r"[^\w\s-]", "", value.lower()).replace(" ", "-")
                        for value in re.findall(r"^#+\s+(.+)$", body, flags=re.M)]
            if anchor not in explicit + headings:
                errors.append(f"{path}: missing anchor {target}")
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = args.workspace_root.resolve()
    errors: list[str] = []
    service_results = []
    checked_files: set[Path] = {Path(__file__).resolve()}
    local_link_count = 0
    for repo, prefix, source_name, spec_name in SERVICES:
        source, spec = root / repo / "docs" / source_name, root / repo / "docs" / spec_name
        if not source.is_file() or not spec.is_file():
            errors.append(f"{repo}: missing source or specification")
            continue
        checked_files.update((source, spec, root / repo / "docs" / "decisions.md"
                              if repo != "j-messenger" else root / "j-groupware" / "docs" / "decisions.md"))
        expected, actual = feature_rows(source, errors), feature_rows(spec, errors)
        if set(expected) != set(actual):
            errors.append(f"{repo}: missing={sorted(set(expected)-set(actual))}, extra={sorted(set(actual)-set(expected))}")
        text = spec.read_text(encoding="utf-8")
        if "인수 시험 전" not in text:
            errors.append(f"{repo}: implementation/test status is not declared")
        defined_tests = {cells[0] for _, cells in table_rows(text)
                         if cells and re.fullmatch(prefix + r"-T\d+", cells[0])}
        referenced_tests = set()
        for fid, (line, cells) in actual.items():
            if len(cells) != 5:
                errors.append(f"{spec}:{line}: expected 5 specification columns, got {len(cells)}")
                continue
            if not all(cells):
                errors.append(f"{spec}:{line}: empty specification field")
            tests = set(TEST.findall(cells[-1]))
            referenced_tests.update(tests)
            if not tests or tests - defined_tests:
                errors.append(f"{spec}:{line}: undefined/absent acceptance test for {fid}: {sorted(tests-defined_tests)}")
            if fid in expected and set(ITEM.findall(expected[fid][1][-1])) != set(ITEM.findall(cells[1])):
                errors.append(f"{spec}:{line}: Item mapping differs from source for {fid}")
        if defined_tests - referenced_tests:
            errors.append(f"{repo}: orphan test definitions {sorted(defined_tests-referenced_tests)}")
        for document in (source, spec):
            local_link_count += local_links(document, errors)
        result = subprocess.run(["git", "-C", str(root / repo), "diff", "--check", "--", "docs", "README.md", "scripts/verify-feature-specifications.py"],
                                capture_output=True, text=True, encoding="utf-8")
        if result.returncode:
            errors.append(f"{repo}: git diff --check failed: {result.stdout}{result.stderr}")
        service_results.append({"service": repo, "feature_count": len(actual),
                                "test_count": len(defined_tests), "feature_ids": sorted(actual)})
    common = root / "j-groupware" / "docs" / "suite-feature-specifications.md"
    extra_documents = (common, root / "j-groupware" / "README.md",
                       root / "j-messenger" / "docs" / "pmt-docs" / "README.md")
    checked_files.add(root / "j-groupware" / "docs" / "architecture.md")
    for document in extra_documents:
        if not document.is_file():
            errors.append(f"missing index: {document}")
            continue
        checked_files.add(document)
        local_link_count += local_links(document, errors)
    suite_test_count = 0
    if common.is_file():
        common_text = common.read_text(encoding="utf-8")
        suite_tests = [cells[0] for _, cells in table_rows(common_text)
                       if cells and re.fullmatch(r"SU-T\d+", cells[0])]
        suite_test_count = len(suite_tests)
        if len(set(suite_tests)) != len(suite_tests):
            errors.append("common index contains duplicate suite acceptance tests")
        for result in service_results:
            index_row = next((cells for _, cells in table_rows(common_text)
                              if len(cells) == 5 and cells[0] == result["service"]), None)
            if not index_row or index_row[3] != str(result["feature_count"]):
                errors.append(f"common index count differs for {result['service']}")
        for required in ("예정 시험", "미정", "FS-U01", "FS-U07", "j-game-client"):
            if required not in common_text:
                errors.append(f"common index lacks status/decision boundary: {required}")
    report = {
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "outcome": "pass" if not errors else "fail", "scope": "document validation only; no functional acceptance tests executed",
        "feature_count": sum(item["feature_count"] for item in service_results),
        "acceptance_test_count": sum(item["test_count"] for item in service_results),
        "suite_acceptance_test_count": suite_test_count,
        "local_link_count": local_link_count, "services": service_results, "errors": errors,
        "sha256": {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                   for path in sorted(checked_files) if path.is_file()},
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
