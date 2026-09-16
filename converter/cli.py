from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Isolated IFC → GLB with per-instance GlobalId"
    )
    p.add_argument("input", type=Path)
    p.add_argument("-o", "--output", type=Path, required=True)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--draco", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--draco-level", type=int, choices=range(0, 11), default=7)
    p.add_argument("--metadata", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument(
        "--validate",
        action="store_true",
        default=True,
        help="Always enabled: integrity validation cannot be disabled",
    )
    p.add_argument(
        "--report", action="store_true", default=True, help="Always writes reports"
    )
    p.add_argument("--timeout", type=float, default=1800)
    return p


def main() -> None:
    from worker.queue import run_job

    p = parser()
    a = p.parse_args()
    if a.workers < 1 or a.timeout <= 0:
        p.error("workers and timeout must be positive")
    flags = [
        "--workers",
        str(a.workers),
        "--draco-level",
        str(a.draco_level),
        "--draco" if a.draco else "--no-draco",
        "--metadata" if a.metadata else "--no-metadata",
    ]
    result = run_job(a.input, a.output, flags, a.timeout)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result["status"] == "SUCCESS" else 1)
