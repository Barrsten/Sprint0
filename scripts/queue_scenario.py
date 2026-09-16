from pathlib import Path
import json
from scripts.fixture import create
from worker.queue import run_job

root = Path("reports/queue")
root.mkdir(parents=True, exist_ok=True)
valid = Path("fixtures/small.ifc")
broken = Path("fixtures/broken.ifc")
broken.write_text("ISO-10303-21;\nBROKEN FILE\n")
bad_geometry = Path("fixtures/broken-geometry.ifc")
create(bad_geometry, broken_geometry=True)
outcomes = []
for i, source in enumerate([valid, broken, valid, bad_geometry, valid]):
    report = run_job(source, root / f"job-{i}", ["--workers", "1", "--no-draco"], 30)
    outcomes.append(report)
expected = ["SUCCESS", "QUARANTINED", "SUCCESS", "QUARANTINED", "SUCCESS"]
assert [r["status"] for r in outcomes] == expected
(root / "queue-report.json").write_text(
    json.dumps(
        {
            "status": "PASS",
            "expected": expected,
            "actual": [r["status"] for r in outcomes],
            "jobs": outcomes,
        },
        ensure_ascii=False,
        indent=2,
    )
)
print(expected)
