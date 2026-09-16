from pathlib import Path
import json
from scripts.fixture import create
from worker.queue import run_job


def test_valid_broken_valid_queue(tmp_path):
    good = tmp_path / "valid.ifc"
    create(good)
    bad = tmp_path / "broken.ifc"
    bad.write_text("ISO-10303-21; damaged")
    outputs = [
        run_job(f, tmp_path / f"job-{i}", ["--no-draco", "--workers", "1"], timeout=30)
        for i, f in enumerate([good, bad, good])
    ]
    assert [o["status"] for o in outputs] == ["SUCCESS", "QUARANTINED", "SUCCESS"]
    assert outputs[1]["workerExitCode"] != 0
    assert outputs[1]["stderrTail"]


def test_broken_geometry_quarantine(tmp_path):
    source = tmp_path / "bad-geometry.ifc"
    create(source, broken_geometry=True)
    report = run_job(
        source, tmp_path / "out", ["--no-draco", "--workers", "1"], timeout=30
    )
    assert report["status"] == "QUARANTINED"


def test_timeout_quarantine(tmp_path):
    source = tmp_path / "valid.ifc"
    create(source)
    report = run_job(source, tmp_path / "out", ["--no-draco"], timeout=0.001)
    assert report["status"] == "QUARANTINED"
    assert report["reason"] == "TIMEOUT"


def test_worker_signal_does_not_crash_supervisor(tmp_path, monkeypatch):
    import subprocess
    import sys
    import signal

    original = subprocess.Popen

    def crash_worker(command, **kwargs):
        return original(
            [
                sys.executable,
                "-c",
                "import os,signal;os.kill(os.getpid(),signal.SIGTERM)",
            ],
            **kwargs,
        )

    monkeypatch.setattr(subprocess, "Popen", crash_worker)
    source = tmp_path / "valid.ifc"
    create(source)
    result = run_job(source, tmp_path / "out", timeout=10)
    assert result["status"] == "QUARANTINED"
    assert result["signal"] == signal.SIGTERM
    assert result["reason"] == "WORKER_SIGNAL"
