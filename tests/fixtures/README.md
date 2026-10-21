# tests/fixtures/

- `*.manifest.json`, `*.request.json`, `server.json`: verbatim copies of
  `tests/fixtures/manifest/` from craftainer/lib-crud-py at commit `1e0ad2d`
  (the shared manifest conformance fixtures, `docs/manifest.md`
  "Conformance fixtures"). Do not edit them here; refresh them from that
  repository.
- `url-parity.json`: the shared URL parity table (`call` + `args` on a
  fixture manifest -> expected method and URL, or the expected error class).
  **Provenance:** the expected values are the output of the Python SDK
  (`craftainer_crud_sdk`, commit in `provenance.sourceCommit`) request
  planner, produced by `url-parity.generate.py` in the Python toolchain image
  (`craftainer-tc/template-python-package:latest`, `uv run python`). Do not
  hand-edit; change the case list in the generator and regenerate. The Python
  SDK's tests consume the same file. Markers in `args`: `{"$datetime": ...}`
  (ISO 8601, no offset = UTC) and `{"$date": ...}`.
- `url-parity.manifest.json`: synthetic manifest (resource `gadgets`/`v3`)
  written by the generator: number, enum, date and datetime fields and
  non-default paging parameter names. Derived from `admin.manifest.json`.
