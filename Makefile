PYTHON ?= python3
VENV_PY = .venv/bin/python
FILE ?= fixtures/km.ifc
OUT ?= reports/km
WORKERS ?= 4

.PHONY: setup build convert viewer test validate benchmark fixture
setup:
	$(PYTHON) -m venv .venv
	$(VENV_PY) -m pip install -e '.[test]'
	npm ci
	npm ci --prefix viewer
	node scripts/setup-viewer.mjs
	$(MAKE) build
build:
	npm run build --prefix viewer
convert:
	$(VENV_PY) -m converter "$(FILE)" --output "$(OUT)" --workers $(WORKERS) --draco --metadata --validate --report --timeout 2400
viewer:
	$(PYTHON) scripts/serve.py
fixture:
	$(VENV_PY) -m scripts.fixture fixtures/small.ifc
	$(VENV_PY) -m converter fixtures/small.ifc -o reports/small
validate:
	$(VENV_PY) -m scripts.validate_output "$(FILE)" "$(OUT)"
	node scripts/verify-three.mjs "$(OUT)/model.decoded.glb" reports/three-km-report.json
test:
	$(VENV_PY) -m pytest -q --junitxml=reports/pytest.xml
	npm run test:js
	$(VENV_PY) -m scripts.queue_scenario
benchmark:
	$(VENV_PY) -m pip install playwright==1.63.0
	$(VENV_PY) -m playwright install chromium
	$(VENV_PY) -m scripts.browser_acceptance --headed
