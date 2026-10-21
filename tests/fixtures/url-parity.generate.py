"""Generate tests/fixtures/url-parity.json (and the synthetic manifest) from the Python SDK.

Run from the Python SDK worktree (toolchain image craftainer-tc/template-python-package:latest):
    PY_SDK_COMMIT=$(git rev-parse HEAD) uv run python <this file> <ts-fixtures-dir>
The case inputs live here; the expected URLs come from craftainer_crud_sdk's own request planner.
"""

import copy
import json
import os
import sys
from datetime import date, datetime
from pathlib import Path

from craftainer_crud_sdk.client import _Plan
from craftainer_crud_sdk.errors import ClientError
from craftainer_crud_sdk.manifest import parse_manifest

OUT = Path(sys.argv[1])
BASE = "https://api.test"
ADMIN = json.loads((OUT / "admin.manifest.json").read_text())


def field(name, value_type, ops, choices=None, numeric=False, sortable=True):
    return {
        "name": name, "value_type": value_type, "filter_ops": ops, "sortable": sortable,
        "choices": choices, "numeric": numeric, "categorical": choices is not None,
        "read_only": False, "required": False,
    }


def synthetic():
    base = next(r for r in ADMIN["resources"] if r["name"] == "heroes" and r["api_version"] == "v2")
    r = copy.deepcopy(base)
    r["name"], r["title"], r["api_version"] = "gadgets", "Gadgets", "v3"
    r["base_path"] = "/api/crud/v1/gadgets/v3/json"
    r["formats"] = {"json": r["base_path"]}
    r["paths"] = {k: v.replace("heroes/v2", "gadgets/v3") for k, v in r["paths"].items()}
    r["capabilities"]["events"]["path"] = r["paths"]["events"]
    cmp_ = ["eq", "min", "max", "in"]
    r["fields"] = [
        field("id", "integer", cmp_, numeric=True),
        field("price", "number", cmp_, numeric=True),
        field("label", "string", ["eq", "in", "contains", "icontains", "regex"]),
        field("active", "boolean", ["eq", "in"]),
        field("kind", "enum", ["eq", "in"], choices=["small", "large"]),
        field("made_on", "date", cmp_),
        field("seen_at", "datetime", cmp_),
        field("secret", "string", ["eq"], sortable=False),
        field("mystery", "uuid", ["eq"]),
    ]
    r["pagination"].update(skip_param="offset", limit_param="page_size", sort_param="order_by",
                           max_limit=50)
    doc = copy.deepcopy(ADMIN)
    doc["resources"] = [r]
    return doc


SYN = synthetic()
(OUT / "url-parity.manifest.json").write_text(json.dumps(SYN, indent=2) + "\n")
MANIFESTS = {"admin.manifest.json": ADMIN, "url-parity.manifest.json": SYN}


def dt(text):
    return {"$datetime": text}


def d(text):
    return {"$date": text}


CASES = []


def case(manifest, resource, version, call, args=None, name=None):
    CASES.append({"manifest": manifest, "resource": resource, "apiVersion": version,
                  "call": call, "args": args or {}, "name": name})


A, S = "admin.manifest.json", "url-parity.manifest.json"
H1 = ("heroes", "v1")
H2 = ("heroes", "v2")
Q = ("quests", "v1")
G = ("gadgets", "v3")

# --- plain operations on every resource shape
for res in (H1, H2, Q):
    case(A, *res, "list")
    case(A, *res, "get", {"id": 7})
    case(A, *res, "create", {"data": {"name": "x"}})
    case(A, *res, "update", {"id": 7, "data": {"name": "y"}})
    case(A, *res, "update", {"id": 7, "data": {"name": "y"}, "ifMatch": 'W/"1"'})
    case(A, *res, "updateMany", {"filters": {"name__contains": "a"}, "data": {"name": "z"}})
    case(A, *res, "delete", {"id": 7})
    case(A, *res, "deleteMany", {"filters": {"id__in": [1, 2, 3]}})
    case(A, *res, "clone", {"id": 7})
    case(A, *res, "filters")
    case(A, *res, "eventsUrl")
for call, args in [("stats", {}), ("stats", {"bucket": "day"}),
                   ("stats", {"bucket": "a b", "includeArchived": True, "includeUnpublished": False}),
                   ("predict", {}), ("predict", {"field": "power_level", "periods": 3, "bucket": "week"}),
                   ("restore", {"id": 4}), ("restore", {"filters": {"name": "x"}}),
                   ("createDraft", {"data": {"name": "d"}}), ("publish", {"id": 9}),
                   ("revisions", {"id": 9})]:
    case(A, *H2, call, args)

# --- list parameters
LIST = [
    {},
    {"filters": {"name": "Ada Lovelace"}},
    {"filters": {"name__eq": "x"}},
    {"filters": {"name": "a+b&c=d/é"}},
    {"filters": {"name": "!'()*"}},
    {"filters": {"name": "100%"}},
    {"filters": {"name": "AZaz09-._~"}},
    {"filters": {"name": "日本"}},
    {"filters": {"name": ""}},
    {"filters": {"name": "a,b"}},
    {"filters": {"name": "line\nbreak\ttab"}},
    {"filters": {"name__icontains": "AZaz09-._~"}},
    {"filters": {"name__regex": "^a.*$"}},
    {"filters": {"name__regex": "a" * 200}},
    {"filters": {"name__regex": "a" * 201}},
    {"filters": {"name__regex": "é" * 200}},
    {"filters": {"name__regex": "é" * 201}},
    {"filters": {"power_level__in": [3, 1, 2]}},
    {"filters": {"power_level__in": [5]}},
    {"filters": {"power_level__in": []}},
    {"filters": {"power_level__in": 5}},
    {"filters": {"power_level__min": -5}},
    {"filters": {"power_level": 0}},
    {"filters": {"power_level": "5"}},
    {"filters": {"power_level": 1.5}},
    {"filters": {"power_level": True}},
    {"filters": {"power_level": None}},
    {"filters": {"power_level__in": [1, "x"]}},
    {"filters": {"name__in": ["a", "b"]}},
    {"filters": {"nope": 1}},
    {"filters": {"name__nope": 1}},
    {"filters": {"name__min": "a"}},
    {"filters": {"id": 5}},
    {"filters": {"id__eq": 5}},
    {"filters": {"id__min": 5}},
    {"filters": {"id__in": [1, 2]}},
    {"filters": {"name": "a", "name__eq": "b"}},
    {"filters": {"__x": 1}},
    {"filters": {"name__": "x"}},
    {"filters": {"name": 5}},
    {"sort": "name,-power_level"},
    {"sort": ["-name", "power_level"]},
    {"sort": "name,"},
    {"sort": ""},
    {"sort": []},
    {"sort": "nope"},
    {"sort": "-nope"},
    {"skip": 0},
    {"skip": 20, "limit": 10},
    {"limit": 1000},
    {"limit": 1001},
    {"limit": 0},
    {"skip": -1},
    {"limit": 1.5},
    {"skip": "1"},
    {"includeArchived": True},
    {"includeUnpublished": False},
    {"includeArchived": False, "includeUnpublished": True},
    {"filters": {"power_level__min": 1, "name__icontains": "a", "power_level__max": 9,
                 "name": "n", "id__min": 2},
     "sort": "name", "skip": 20, "limit": 10, "includeUnpublished": True, "includeArchived": False},
    {"filters": {"name": "n", "name__contains": "c", "name__icontains": "i", "name__regex": "r"}},
]
for args in LIST:
    case(A, *H1, "list", args)
for args in [
    {"filters": {"is_draft": True}},
    {"filters": {"is_locked": False}},
    {"filters": {"is_draft__in": [True, False]}},
    {"filters": {"is_draft": "true"}},
    {"filters": {"is_draft": 1}},
    {"filters": {"created_at__min": dt("2026-01-02T03:04:05Z")}},
    {"filters": {"created_at__min": dt("2026-01-02T03:04:05")}},
    {"filters": {"created_at__max": dt("2026-01-02T03:04:05+02:00")}},
    {"filters": {"created_at__max": dt("2026-01-02T03:04:05-05:30")}},
    {"filters": {"created_at": dt("2026-01-02T03:04:05.123456Z")}},
    {"filters": {"created_at": dt("2026-01-02T03:04:05.678912Z")}},
    {"filters": {"created_at": dt("2026-01-02T03:04:05.5Z")}},
    {"filters": {"created_at": dt("2026-01-02T03:04:05.050Z")}},
    {"filters": {"created_at": dt("2026-01-02T03:04:05.000999Z")}},
    {"filters": {"created_at": dt("2026-01-02T03:04:05.000Z")}},
    {"filters": {"created_at": dt("2026-12-31T23:59:59.999Z")}},
    {"filters": {"created_at": dt("2026-01-01T00:00:00+14:00")}},
    {"filters": {"created_at__in": [dt("2026-01-01T00:00:00Z"), dt("2026-01-02T00:00:00")]}},
    {"filters": {"created_at": "2026-01-02T03:04:05Z"}},
    {"filters": {"created_at": d("2026-01-02")}},
]:
    case(A, *H2, "list", args)
for args in [
    {"filters": {"difficulty": "easy"}},
    {"filters": {"difficulty__in": ["easy", "hard"]}},
    {"filters": {"difficulty": "impossible"}},
    {"filters": {"difficulty__in": ["easy", "impossible"]}},
    {"filters": {"due_on__min": d("2026-03-04")}},
    {"filters": {"due_on__in": [d("2026-03-04"), d("2026-03-05")]}},
    {"filters": {"due_on": dt("2026-03-04T00:00:00Z")}},
    {"sort": "due_on,-title", "limit": 5},
]:
    case(A, *Q, "list", args)
for args in [
    {"filters": {"price": 2}},
    {"filters": {"price": 1.5}},
    {"filters": {"price": -0.25}},
    {"filters": {"price__min": 0.1, "price__max": 99.99}},
    {"filters": {"price__in": [1, 2.5, 3]}},
    {"filters": {"price": "1.5"}},
    {"filters": {"price": True}},
    {"filters": {"active": True, "kind": "small"}},
    {"filters": {"kind": "medium"}},
    {"filters": {"made_on__min": d("2026-02-28"), "made_on__max": d("2027-01-01")}},
    {"filters": {"seen_at__min": dt("2026-02-28T12:00:00.250Z")}},
    {"filters": {"label__in": ["a b", "c/d", "e%f"]}},
    {"filters": {"label__in": ["a,b"]}},
    {"filters": {"label__in": [""]}},
    {"filters": {"mystery": "anything"}},
    {"filters": {"mystery": 5}},
    {"filters": {"secret": "x"}},
    {"sort": "secret"},
    {"sort": "price,-label", "skip": 5, "limit": 50},
    {"limit": 51},
    {"skip": 100, "limit": 10, "sort": "-seen_at"},
    {"includeArchived": True, "includeUnpublished": True, "limit": 1},
]:
    case(S, *G, "list", args)

# --- other operations: validation and capabilities
for rid in (0, 1, 2147483647, -1, 1.5, "1", True):
    case(A, *H1, "get", {"id": rid})
for res in (H1, H2, Q):
    case(A, *res, "restore", {"id": 1})
case(A, *H2, "restore", {})
case(A, *H2, "restore", {"id": 1, "filters": {"name": "x"}})
case(A, *H2, "restore", {"filters": {}})
case(A, *H2, "updateMany", {"filters": {}, "data": {}})
case(A, *H2, "deleteMany", {"filters": {}})
case(A, *H2, "deleteMany", {"filters": {"power_level__min": 1, "name__contains": "a"}})
case(A, *H2, "updateMany", {"filters": {"nope": 1}, "data": {}})
for call, args in [("stats", {}), ("predict", {}), ("createDraft", {"data": {}}),
                   ("publish", {"id": 1}), ("revisions", {"id": 1})]:
    case(A, *H1, call, args)
case(A, *H2, "predict", {"field": "name"})
case(A, *H2, "predict", {"field": "nope"})
case(A, *H2, "predict", {"periods": 0})
case(A, *H2, "predict", {"periods": 1})
case(A, *H2, "predict", {"field": "id", "periods": 12})
case(A, *H2, "stats", {"includeArchived": False})
case(A, *H2, "stats", {"includeUnpublished": True})
case(A, *H2, "revisions", {"id": -3})
case(A, *H2, "publish", {"id": "x"})
case(A, *H2, "clone", {"id": 0})
case(S, *G, "stats", {"bucket": "é&"})
case(S, *G, "predict", {"field": "price", "periods": 2, "bucket": "month"})
case(S, *G, "predict", {"field": "label"})
case(S, *G, "eventsUrl")
case(S, *G, "filters")
case(S, *G, "revisions", {"id": 12})
case(S, *G, "restore", {"filters": {"active": False}})
case(S, *G, "publish", {"id": 3})
case(S, *G, "update", {"id": 5, "data": {}})
case(S, *G, "delete", {"id": 5})


def conv(v):
    if isinstance(v, dict) and set(v) == {"$datetime"}:
        return datetime.fromisoformat(v["$datetime"].replace("Z", "+00:00"))
    if isinstance(v, dict) and set(v) == {"$date"}:
        return date.fromisoformat(v["$date"])
    if isinstance(v, dict):
        return {k: conv(x) for k, x in v.items()}
    if isinstance(v, list):
        return [conv(x) for x in v]
    return v


def plan_for(case_):
    manifest = parse_manifest(MANIFESTS[case_["manifest"]])
    res = manifest.find(case_["resource"], case_["apiVersion"])
    assert res is not None, case_
    return _Plan(BASE, res)


def run(case_):
    plan, a = plan_for(case_), conv(case_["args"])
    c = case_["call"]
    if c == "eventsUrl":
        return "GET", plan.events_url()
    call = {
        "list": lambda: plan.list_call(
            filters=a.get("filters"), sort=a.get("sort"), skip=a.get("skip"),
            limit=a.get("limit"), include_archived=a.get("includeArchived"),
            include_unpublished=a.get("includeUnpublished")),
        "get": lambda: plan.get_call(a["id"]),
        "create": lambda: plan.create_call(a["data"]),
        "update": lambda: plan.update_call(a["id"], a["data"], a.get("ifMatch")),
        "updateMany": lambda: plan.update_many_call(a["filters"], a["data"]),
        "delete": lambda: plan.delete_call(a["id"], a.get("ifMatch")),
        "deleteMany": lambda: plan.delete_many_call(a["filters"]),
        "restore": lambda: plan.restore_call(a.get("id"), a.get("filters")),
        "stats": lambda: plan.stats_call(a.get("bucket"), a.get("includeArchived"),
                                         a.get("includeUnpublished")),
        "predict": lambda: plan.predict_call(a.get("field"), a.get("periods"), a.get("bucket")),
        "clone": lambda: plan.clone_call(a["id"]),
        "createDraft": lambda: plan.draft_call(a["data"]),
        "publish": lambda: plan.publish_call(a["id"]),
        "filters": plan.filters_call,
        "revisions": lambda: plan.revisions_call(a["id"]),
    }[c]()
    return call.method, call.url


for i, c in enumerate(CASES):
    c["name"] = f"{i:03d} {c['resource']}/{c['apiVersion']} {c['call']}"
    try:
        method, url = run(c)
        c["expect"] = {"method": method, "url": url}
    except ClientError as exc:
        c["expect"] = {"error": type(exc).__name__}

head = os.environ["PY_SDK_COMMIT"]
table = {
    "provenance": {
        "generator": "tests/fixtures/url-parity.generate.py (case inputs + this script)",
        "source": "craftainer_crud_sdk (Python SDK) request planner: client._Plan.*_call, query.build_query",
        "sourceCommit": head,
        "toolchain": "craftainer-tc/template-python-package:latest, uv run python",
        "note": "Expected values are the Python SDK's output. Do not hand-edit; regenerate.",
    },
    "baseUrl": BASE,
    "markers": {"$datetime": "ISO 8601; no offset means UTC", "$date": "YYYY-MM-DD"},
    "cases": CASES,
}
(OUT / "url-parity.json").write_text(json.dumps(table, indent=1, ensure_ascii=False) + "\n")
print(len(CASES), "cases;", sum("error" in c["expect"] for c in CASES), "errors")
