"""Inspect, fill and verify PDF AcroForms with pypdf.

    python pdf_form.py inspect FORM.pdf
    python pdf_form.py fill FORM.pdf OUTPUT.pdf --values VALUES.json [--flatten]
    python pdf_form.py verify OUTPUT.pdf --values VALUES.json [--flattened]

VALUES.json maps fully qualified field names to values. Text and choice fields
take strings; checkboxes take true/false or an on-state name such as "/Yes";
radio groups take the export name of the selected button. Every command prints
one JSON object. fill and verify exit 1 when the result cannot be trusted.
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject

UNSUPPORTED_ENCODING = "not supported by font encoding"


class FormError(Exception):
    pass


def _text(value) -> str | None:
    return None if value is None else str(value)


def _inherited(node, key):
    while node is not None:
        if key in node:
            return node[key]
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return None


def _qualified_name(node) -> str:
    parts = []
    while node is not None:
        if "/T" in node:
            parts.append(str(node["/T"]))
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return ".".join(reversed(parts))


def _field_tree_ids(reader: PdfReader) -> set[int]:
    acro_form = reader.root_object.get("/AcroForm")
    pending = list((acro_form.get_object().get("/Fields") or []) if acro_form else [])
    seen: set[int] = set()
    while pending:
        reference = pending.pop()
        idnum = getattr(reference, "idnum", None)
        if idnum is None or idnum in seen:
            continue
        seen.add(idnum)
        pending.extend(reference.get_object().get("/Kids") or [])
    return seen


def _on_states(widget) -> list[str]:
    normal = (widget.get("/AP") or {}).get("/N")
    if normal is None:
        return []
    return [str(state) for state in normal.get_object().keys() if state != "/Off"]


def widgets(reader: PdfReader) -> list[dict]:
    """Every page widget with the value a reader would use for it."""
    tree = _field_tree_ids(reader)
    found = []
    for page_number, page in enumerate(reader.pages, start=1):
        for reference in page.get("/Annots") or []:
            widget = reference.get_object()
            if widget.get("/Subtype") != "/Widget":
                continue
            appearance = widget.get("/AP")
            found.append({
                "page": page_number,
                "name": _qualified_name(widget),
                "type": _text(_inherited(widget, "/FT")),
                "value": _text(_inherited(widget, "/V")),
                "state": _text(widget.get("/AS")),
                "on_states": _on_states(widget),
                "has_appearance": bool(appearance and "/N" in appearance),
                "in_field_tree": getattr(reference, "idnum", None) in tree,
                "rect": [round(float(number), 2) for number in widget.get("/Rect", [])],
            })
    return found


def inspect(path: Path) -> dict:
    reader = PdfReader(path)
    if reader.is_encrypted:
        raise FormError("PDF is encrypted; decrypt it with the password the user provides before filling")
    fields = reader.get_fields() or {}
    page_widgets = widgets(reader)
    orphaned = [item for item in page_widgets if not item["in_field_tree"]]
    root = reader.root_object
    acro_form = root.get("/AcroForm")
    return {
        "fields": {name: {"type": _text(field.get("/FT")), "value": _text(field.get("/V")),
                          "options": [_text(option) for option in field.get("/Opt", [])] or None,
                          "states": [_text(state) for state in field.get("/_States_", [])] or None}
                   for name, field in fields.items()},
        "widgets": page_widgets,
        "orphaned_widgets": [item for item in orphaned if item["name"] not in fields],
        # A detached widget sharing a canonical field's name: reattaching it
        # would create a second top-level field with the same name.
        "ambiguous_widgets": [item for item in orphaned if item["name"] in fields],
        "signed": any(field.get("/FT") == "/Sig" and field.get("/V") is not None for field in fields.values()),
        "need_appearances": bool(acro_form and acro_form.get_object().get("/NeedAppearances")),
        "xfa": bool(acro_form and "/XFA" in acro_form.get_object()),
    }


def _normalize(values: dict, fields: dict, page_widgets: list[dict]) -> dict[str, str]:
    normalized = {}
    for name, value in values.items():
        if isinstance(value, bool):
            if fields[name].get("/FT") != "/Btn":
                raise FormError(f"{name}: true/false only applies to checkboxes")
            states = sorted({state for item in page_widgets if item["name"] == name for state in item["on_states"]})
            if value and len(states) != 1:
                raise FormError(f"{name}: expected one on-state, found {states}; pass the state name instead")
            normalized[name] = states[0] if value else "/Off"
        else:
            normalized[name] = str(value)
    return normalized


def fill(source: Path, output: Path, values: dict, flatten: bool) -> dict:
    if output.exists():
        raise FormError(f"output already exists: {output}")
    report = inspect(source)
    if report["xfa"]:
        raise FormError("XFA form: pypdf only fills the AcroForm part and XFA-aware readers may ignore it")
    if report["signed"]:
        raise FormError("PDF contains a signature; rewriting it invalidates the signature. Ask the user how to proceed")
    if report["ambiguous_widgets"]:
        names = sorted({item["name"] for item in report["ambiguous_widgets"]})
        raise FormError(f"widgets share names with separate canonical fields: {names}")
    writer = PdfWriter()
    writer.clone_document_from_reader(PdfReader(source))
    if report["orphaned_widgets"]:
        writer.reattach_fields()
    fields = writer.get_fields() or {}
    missing = sorted(set(values) - set(fields))
    if missing:
        raise FormError(f"form fields not found: {missing}")
    page_widgets = widgets(writer)
    values = _normalize(values, fields, page_widgets)
    if flatten:
        # Paint every existing value before the widgets are removed.
        values = {**{name: _text(field.get("/V")) or ("/Off" if field.get("/FT") == "/Btn" else "")
                     for name, field in fields.items() if field.get("/FT") != "/Sig"}, **values}

    messages: list[str] = []
    handler = logging.Handler()
    handler.emit = lambda record: messages.append(record.getMessage())
    logger = logging.getLogger("pypdf")
    logger.addHandler(handler)
    unencodable = []
    try:
        for name, value in values.items():
            before = len(messages)
            writer.update_page_form_field_values(None, {name: value}, auto_regenerate=False)
            if any(UNSUPPORTED_ENCODING in message for message in messages[before:]):
                unencodable.append(name)
    finally:
        logger.removeHandler(handler)

    if unencodable and flatten:
        raise FormError(f"the form font cannot draw the values of {unencodable}; a static copy would show "
                        "replacement characters. Deliver the interactive copy or ask the user")
    if unencodable:
        # pypdf wrote "?" in place of the missing glyphs. Drop those appearances
        # so the reader regenerates them from /V with a font it has.
        for page in writer.pages:
            for reference in page.get("/Annots") or []:
                widget = reference.get_object()
                if widget.get("/Subtype") == "/Widget" and _qualified_name(widget) in unencodable:
                    widget.pop(NameObject("/AP"), None)
        writer.set_need_appearances_writer(True)
    if flatten:
        writer.update_page_form_field_values(None, values, auto_regenerate=False, flatten=True)
        # pypdf paints the appearances but keeps the widgets and field tree.
        writer.remove_annotations(subtypes="/Widget")
        writer.root_object.pop(NameObject("/AcroForm"), None)
    with open(output, "wb") as stream:
        writer.write(stream)
    return {"output": str(output), "flattened": flatten, "reattached": bool(report["orphaned_widgets"]),
            "reader_generated_appearance": unencodable, "pypdf_messages": messages}


def verify(path: Path, values: dict, flattened: bool) -> dict:
    reader = PdfReader(path)
    page_widgets = widgets(reader)
    problems = []
    if flattened:
        if page_widgets:
            problems.append(f"{len(page_widgets)} widget annotations remain")
        if "/AcroForm" in reader.root_object:
            problems.append("/AcroForm field tree remains")
        text = "".join("".join(page.extract_text().split()) for page in reader.pages)
        for name, value in values.items():
            if isinstance(value, str) and value.strip() and "".join(value.split()) not in text:
                problems.append(f"{name}: value not found in page text")
        return {"ok": not problems, "problems": problems}

    fields = reader.get_fields() or {}
    need_appearances = bool(reader.root_object.get("/AcroForm", {}).get("/NeedAppearances"))
    try:
        expected = _normalize(values, fields, page_widgets)
    except (FormError, KeyError) as error:
        return {"ok": False, "problems": [f"cannot interpret values: {error}"]}
    reader_generated = []
    for name, value in expected.items():
        if name not in fields:
            problems.append(f"{name}: field missing")
            continue
        if _text(fields[name].get("/V")) != value:
            problems.append(f"{name}: field /V is {_text(fields[name].get('/V'))!r}, expected {value!r}")
        matches = [item for item in page_widgets if item["name"] == name]
        if not matches:
            problems.append(f"{name}: no widget on any page")
        for item in matches:
            if item["value"] != value:
                problems.append(f"{name} (page {item['page']}): widget value is {item['value']!r}")
            if item["type"] == "/Btn" and item["state"] not in (value, "/Off"):
                problems.append(f"{name} (page {item['page']}): appearance state is {item['state']!r}")
            if not item["has_appearance"]:
                if need_appearances and item["type"] == "/Tx":
                    reader_generated.append(name)
                else:
                    problems.append(f"{name} (page {item['page']}): no appearance stream")
        if fields[name].get("/FT") == "/Btn" and value != "/Off" and not any(item["state"] == value for item in matches):
            problems.append(f"{name}: no widget shows state {value!r}")
    return {"ok": not problems, "problems": problems, "reader_generated_appearance": sorted(set(reader_generated))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("inspect")
    command.add_argument("pdf", type=Path)
    command = commands.add_parser("fill")
    command.add_argument("pdf", type=Path)
    command.add_argument("output", type=Path)
    command.add_argument("--values", type=Path, required=True)
    command.add_argument("--flatten", action="store_true")
    command = commands.add_parser("verify")
    command.add_argument("pdf", type=Path)
    command.add_argument("--values", type=Path, required=True)
    command.add_argument("--flattened", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "inspect":
            result = inspect(args.pdf)
        else:
            values = json.loads(args.values.read_text(encoding="utf-8"))
            if args.command == "fill":
                result = fill(args.pdf, args.output, values, args.flatten)
            else:
                result = verify(args.pdf, values, args.flattened)
    except FormError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("ok") is False:
        raise SystemExit(1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
