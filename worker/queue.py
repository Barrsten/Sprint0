from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from typing import Sequence


def run_job(
    source: Path, output: Path, flags: Sequence[str] = (), timeout: float = 1800
) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    destination = output
    output = Path(tempfile.mkdtemp(prefix=".job-", dir=destination))
    log_path = output / "worker.log"
    cmd = [
        sys.executable,
        "-m",
        "converter._worker",
        str(source.resolve()),
        "--output",
        str(output.resolve()),
        *flags,
    ]
    timed_out = False
    with log_path.open("wb") as log:
        child = subprocess.Popen(
            cmd,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=os.name == "posix",
        )
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            if os.name == "posix":
                os.killpg(child.pid, signal.SIGKILL)
            else:
                child.kill()
            code = child.wait()
    failure = {}
    if (output / "failure.json").exists():
        failure = json.loads((output / "failure.json").read_text())
    stage = "startup"
    if (output / "stage.json").exists():
        stage = json.loads((output / "stage.json").read_text())["stage"]
    success = code == 0 and (output / "conversion-report.json").exists()
    if success:
        success = (
            json.loads((output / "conversion-report.json").read_text())["status"]
            == "SUCCESS"
        )
    reason = (
        "SUCCESS"
        if success
        else (
            "TIMEOUT"
            if timed_out
            else "WORKER_SIGNAL" if code < 0 else "WORKER_FAILURE"
        )
    )
    with log_path.open("rb") as log:
        log.seek(0, 2)
        size = log.tell()
        log.seek(max(0, size - 8192))
        tail = log.read().decode("utf8", errors="replace")
    report = {
        "status": "SUCCESS" if success else "QUARANTINED",
        "inputFilename": source.name,
        "inputPath": str(source.resolve()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "failureStage": None if success else stage,
        "exception": failure.get("exception"),
        "workerExitCode": code,
        "signal": -code if code < 0 else None,
        "reason": reason,
        "oomSuspected": code == -signal.SIGKILL and not timed_out,
        "stderrTail": tail,
    }
    (output / "job-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2)
    )
    if not success:
        (output / "quarantine.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2)
        )
    # Publish one completed job; remove stale generated artifacts from an older job.
    known = {
        "worker.log",
        "conversion-report.json",
        "validation-report.json",
        "guid-roundtrip-report.json",
        "failure.json",
        "quarantine.json",
        "stage.json",
        "job-report.json",
        "source-manifest.json",
        "metadata.json",
        "model.raw.glb",
        "model.glb",
        "model.decoded.glb",
        "model.validator.json",
        "raw-validation-report.json",
        "independent-validation-report.json",
    }
    current = {p.name for p in output.iterdir()}
    for name in known - current:
        old = destination / name
        if old.is_file():
            old.unlink()
    for item in output.iterdir():
        item.replace(destination / item.name)
    output.rmdir()
    return report


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("files", nargs="+", type=Path)
    p.add_argument("-o", "--output", type=Path, required=True)
    p.add_argument("--timeout", type=float, default=1800)
    a = p.parse_args()
    outcomes = []
    for i, source in enumerate(a.files):
        outcomes.append(run_job(source, a.output / f"{i:03d}", timeout=a.timeout))
    a.output.mkdir(parents=True, exist_ok=True)
    (a.output / "queue-report.json").write_text(
        json.dumps(outcomes, indent=2, ensure_ascii=False)
    )
    print(json.dumps([r["status"] for r in outcomes]))
    sys.exit(1 if any(r["status"] != "SUCCESS" for r in outcomes) else 0)


if __name__ == "__main__":
    main()
