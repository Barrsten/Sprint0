"""Build factual protocol from actual saved reports; missing measurements stay null."""

import json
from pathlib import Path
from collections import Counter
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
import re

root = Path("reports")
r = json.loads((root / "km/conversion-report.json").read_text())
v = json.loads((root / "km/validation-report.json").read_text())
g = json.loads((root / "km/guid-roundtrip-report.json").read_text())
t = json.loads((root / "three-km-report.json").read_text())
ray = json.loads((root / "raycast-standard.json").read_text())
q = json.loads((root / "queue/queue-report.json").read_text())
env = json.loads((root / "environment.json").read_text())
inventory = json.loads((root / "input-inventory.json").read_text())
env["cpuReportedBy7Zip"] = "AMD EPYC 9V74 80-Core Processor"
env["cpuIdentificationSource"] = (
    "7-Zip process banner in this environment; allocated logical CPU count separately reported as 9"
)
env["webglRenderer"] = None
(root / "environment.json").write_text(json.dumps(env, indent=2))
fmt = lambda x: f"{x:,.0f}".replace(",", " ")
mb = lambda x: f"{x/1048576:.2f}"
skip = Counter(x["reason"] for x in r["skippedIfcObjects"])
box = v["boundingBox"]
ms = [x["ms"] for x in ray["results"]]
suite = ET.parse(root / "pytest.xml").getroot().find("testsuite")
assert (
    suite is not None
    and int(suite.attrib.get("failures", 0)) == 0
    and int(suite.attrib.get("errors", 0)) == 0
)
python_count = int(suite.attrib["tests"])
mapping_count = int(
    re.search(r"^# pass (\d+)", (root / "mapping-tests.tap").read_text(), re.M).group(1)
)
assert (
    r["status"] == "SUCCESS"
    and v["status"] == "PASS"
    and g["status"] == "PASS"
    and t["status"] == "PASS"
    and q["status"] == "PASS"
)
summary = {
    "conversion": "VERIFIED",
    "guidRoundtrip": "VERIFIED",
    "nodeThreeLoaderAndRaycaster": "VERIFIED",
    "quarantine": "VERIFIED",
    "pythonTests": {"status": "VERIFIED", "passed": python_count},
    "mappingTests": {"status": "VERIFIED", "passed": mapping_count},
    "browserOpenAttempt": "FAILED",
    "browserVisualAcceptance": "IMPLEMENTED_NOT_RUN",
    "browserPointerAcceptance": "IMPLEMENTED_NOT_RUN",
    "browserBenchmark": "IMPLEMENTED_NOT_RUN",
    "browserFps": None,
    "browserUiLatencyMs": None,
    "referenceHardwareStatus": "REFERENCE_HARDWARE_NOT_USED",
    "fullDefinitionOfDone": "NOT_COMPLETED",
    "fullTZAcceptance": "NOT_COMPLETED",
}
(root / "acceptance-summary.json").write_text(
    json.dumps(summary, ensure_ascii=False, indent=2)
)
rows = [
    ("Исходный IFC, байт", fmt(r["sourceSizeBytes"])),
    ("Исходный IFC, МиБ", mb(r["sourceSizeBytes"])),
    ("IFC schema", r["ifcSchema"]),
    ("STEP entities", fmt(r["ifcEntityCount"])),
    ("IfcProduct inspected", fmt(r["elementsInspected"])),
    ("Rendering candidates", fmt(r["renderCandidates"])),
    ("Получили geometry", fmt(r["geometrySucceededBeforeAssemblyDedup"])),
    ("Selectable elements / instances", fmt(r["visibleElements"])),
    (
        "GlobalId / unique GlobalId",
        f"{fmt(r['elementsWithGlobalId'])} / {fmt(r['uniqueGuidCount'])}",
    ),
    ("Уникальная геометрия", fmt(r["uniqueGeometries"])),
    ("Instanced material meshes в GLTFLoader", fmt(t["primitiveMeshes"])),
    ("Dedup ratio по числу элементов", f"{r['deduplicationRatio']:.3f}"),
    ("Треугольники в модели", fmt(r["triangleCount"])),
    ("Треугольники уникальной геометрии", fmt(r["uniqueTriangleCount"])),
    ("Вершины с учётом экземпляров", fmt(r["vertexCount"])),
    ("Вершины уникальной геометрии", fmt(r["uniqueVertexCount"])),
    (
        "Raw GLB, байт / МиБ",
        f"{fmt(r['rawGlbSizeBytes'])} / {mb(r['rawGlbSizeBytes'])}",
    ),
    (
        "Draco GLB, байт / МиБ",
        f"{fmt(r['dracoGlbSizeBytes'])} / {mb(r['dracoGlbSizeBytes'])}",
    ),
    ("Raw / Draco", f"{r['compressionRatio']:.3f}×"),
    ("IFC / Draco", f"{r['sourceSizeBytes']/r['dracoGlbSizeBytes']:.3f}×"),
    ("Parse, с", f"{r['parseTimeSeconds']:.3f}"),
    ("Geometry + properties, с", f"{r['geometryTimeSeconds']:.3f}"),
    ("GLB build, с", f"{r['glbBuildTimeSeconds']:.3f}"),
    ("Draco encode + decode + validator, с", f"{r['dracoTimeSeconds']:.3f}"),
    ("Всего с валидациями и записью, с", f"{r['totalConversionTimeSeconds']:.3f}"),
    ("Peak RSS worker, МиБ", f"{r['peakRssMiB']:.2f}"),
    ("Потоки iterator", r["workers"]),
]
table = "\n".join(f"| {k} | {val} |" for k, val in rows)
protocol = f"""# Протокол Спринта 0 Контур 2

Дата: {r['timestamp']}. Протокол сформирован из сохранённых результатов исполнения. Точные JSON и входной IFC входят в поставку.

## Итог

Работающий прототип конвертации КМ и его проверенные артефакты получены. Полная Definition of Done и приёмка ТЗ **не завершены**: браузерная визуальная проверка, реальные pointer clicks, FPS и UI latency не измерены; доступный Browser блокировал локальный стенд. Из требуемых ТЗ 19 моделей предоставлены 3, фактическая конвертация выполнена для одной КМ.

| Проверка | Статус | Факт |
|---|---|---|
| Реальная IFC → GLB → Draco | VERIFIED / PASS | {fmt(r['visibleElements'])} элементов, {fmt(r['triangleCount'])} треугольников |
| GUID round-trip | VERIFIED / PASS | missing=0, duplicates=0, {g['sampleCount']} контрольных записей |
| Независимое повторное чтение IFC | VERIFIED / PASS | исходные GlobalId совпали с GLB |
| GLTFLoader + Raycaster в Node | VERIFIED / PASS | {len(t['samples'])} экземпляров проверены |
| Unit/integration Python | VERIFIED / PASS | {python_count} тест |
| JavaScript mapping | VERIFIED / PASS | {mapping_count} теста |
| TypeScript strict / Vite build | VERIFIED / PASS | сборка получена |
| Очередь и повреждения | VERIFIED / PASS | SUCCESS → QUARANTINED → SUCCESS; также битая geometry |
| Открытие стенда доступным Browser | FAILED | ERR_BLOCKED_BY_CLIENT на 127.0.0.1 и localhost |
| Визуальная геометрия, browser click, GPU instancing на GPU | IMPLEMENTED_NOT_RUN | GPU-rendered результат не наблюдался |
| FPS и полная задержка UI | IMPLEMENTED_NOT_RUN | численных результатов нет |
| Эталонный ПК | REFERENCE_HARDWARE_NOT_USED | соответствие Core i3 не заявляется |

## Стенд

{env['platform']}; Python {env['python']}; Node {env['node']}; IfcOpenShell {r['ifcopenshellVersion']}; NumPy 2.5.3; Three.js 0.180.0; TypeScript 5.9.3; Vite 7.1.7; glTF Transform 4.2.1; Draco 1.5.7.

7-Zip сообщил CPU AMD EPYC 9V74 80-Core Processor; Python сообщил {env['logicalCpuCount']} логических CPU в окружении. Сведения о доступной RAM из /proc недоступны; модель GPU не получена. Peak RSS относится к процессу converter worker, без дочернего Node encoder. Это не эталонный ПК.

## Входы и методика

Исходное имя КМ: `МДИЛ_ЗМ02-100-00_К-КМ-0_ВРБ_АПЕКС_2026-06-26.ifc`. В архиве проекта идентичные байты находятся в `fixtures/km.ifc`. SHA-256: `{inventory['models'][0]['sha256']}`. CRC32 соответствует заголовку RAR. Контрольные суммы трёх исходных моделей — `reports/input-inventory.json`.

Первый RAR decoder дал CRC-ошибки для КЖ/КМ; использована корректная распаковка другим декодером с последующей сверкой CRC. КР корректно прочитан первым декодером. Повреждённые промежуточные копии не использовались в acceptance и не входят в поставку.

Модель парсилась IfcOpenShell. Iterator создавал локальную геометрию и матрицы в метрах. Geometry hash учитывал позиции, индексы и материалы, без placement. В каждом instancing node записывались индивидуальные GUID, Express ID и IFC type. Raw GLB проверялся; Draco-файл повторно декодировался и проходил тот же контроль. Массивы mapping напрямую сравнивались в сжатом и декодированном GLB. Отдельная команда заново открыла исходный IFC.

Ни один показатель старого отчёта не использовался как константа. Числа ниже относятся к заключительному полному прогону.

## Конвертация КМ

| Показатель | Факт |
|---|---:|
{table}

Сумма отдельных четырёх этапов меньше общего времени: в общее время также входят обход структуры IFC, независимая world-coordinate выборка, raw/decoded валидации, JSON и файловая запись.

Исключённые объекты: {dict(skip)}. Решение по каждому объекту находится в conversion-report. 56 assembly без собственной representation — контейнеры; 64 assembly с собственной representation и без дочерней отображаемой геометрии сохранены. Конвертация завершилась без warnings и errors.

## GUID и координаты

N_ifc = N_instances = N_guid = {fmt(r['visibleElements'])}; unique GUID = {fmt(r['uniqueGuidCount'])}; missing = 0; duplicates = 0. Соответствие Express ID, IFC type, geometry group и instance index проверено для всех записей. Контрольная случайная выборка — {g['sampleCount']} элементов с фиксированным seed; это часть полной проверки, а не замена проверки всех элементов.

Bounding box IFC, метры: `{box['sourceMeters']}`. Bounding box GLB, приведённый обратно к IFC Z-up: `{box['glbMeters']}`. Максимальная ошибка — {box['maxErrorMeters']:.10f} м ({box['maxErrorMeters']*1000:.6f} мм); заданный допуск — {box['toleranceMeters']} м. Независимый world-coordinate reference прошёл для {len(r['worldPlacementValidation']['samples'])} элементов.

Общий сдвиг IFC сохранён в корневом GLB node; axes преобразованы Z-up → Y-up. Квантизация Draco — 16 бит на локальную форму. Количество треугольников после декодирования равно исходному. Проверка bbox не заменяет визуального осмотра и не является доказательством точного совпадения каждой вершины после quantization.

## Выбор элементов и производительность

Node GLTFLoader разобрал декодированный GLB за {t['loadMs']:.2f} мс. Проверены {len(t['samples'])} попаданий Raycaster по конкретному instance. Полнота mapping проверена для всей модели. Это подтверждает CPU-связь геометрии с GUID, но не фактический pointer event, подсветку на GPU или работу UI.

Пять лучей от камеры к точкам реальной геометрии дали {min(ms):.2f}–{max(ms):.2f} мс стандартного Raycaster в Node; каждый луч пересёк геометрию. Эти значения исключают browser event processing, отрисовку и UI. Порог UI ≤0,4 с к ним не применяется. BVH не добавлялся: проверенный CPU-сценарий не показал необходимость ускорения; браузерный сценарий остаётся непроверенным.

Browser FPS: **не измерен**. Browser UI latency: **не измерена**. Benchmark mode, 3 с warmup, орбита минимум 10 с, выбор, isolate/show и JSON реализованы; выполнение — IMPLEMENTED_NOT_RUN. Официальные PASS/PASS_WITH_LIMITATIONS/FAIL по FPS не присваиваются: REFERENCE_HARDWARE_NOT_USED.

## Повреждения и очередь

Фактическая последовательность: `{q['actual']}`. Два повреждения: текст с некорректной структурой IFC и валидный IFC-контейнер с несуществующим индексом вершины треугольной грани. Оба дали QUARANTINED, следующие jobs завершились SUCCESS. Логи, failure stage, exception, exit code и stderr tail сохранены в `reports/queue/`. Timeout и синтетическое завершение worker сигналом SIGTERM проверены отдельными тестами. Настоящий OOM и segfault IfcOpenShell не вызывались; их обнаружение предусмотрено по завершению процесса, SIGKILL отмечается только как подозрение OOM.

## Зафиксированные ошибки и ограничения

Критический для полной приёмки blocker: доступный браузер не открыл локальный стенд. Не подтверждены визуальная корректность, одиночная GPU-подсветка, isolate/show в реальном браузере, GPU FPS и полная UI latency. Начальная ошибка декодирования RAR устранена для используемых входов, контрольные суммы проверены. В заключительном converter run ошибок нет.

Предварительно согласованная сторонами классификация ошибок не предоставлена; приведённое разделение — техническая регистрация фактов, не замена такого согласования. Набор из 19 моделей, подтверждённый профиль одновременных пользователей, серверный нагрузочный сценарий API/PostgreSQL/объектного хранилища и длительный soak отсутствуют в выполненных испытаниях. КЖ и КР не конвертировались. Совмещение реальных фрагментов не проверено. Точная граница assembly-проверки и ограничения внешнего appearance описаны в README.

## Выводы по гипотезам ТЗ

Гипотеза 1 — **не подтверждена в предусмотренном ТЗ объёме**: официальные измерения отсутствуют, это не измеренный провал FPS.

Гипотеза 2 — **не подтверждена в предусмотренном ТЗ объёме**: её converter/GUID/quarantine часть подтверждена на КМ, но контрольное открытие браузерной сцены и комплект из 19 моделей не проверены. Прототип передан с фактическими артефактами и воспроизводимыми тестами; полная приёмка не заявляется.
"""
Path("SPRINT0_PROTOCOL.md").write_text(protocol)
Path("PROTOCOL_HYPOTHESIS_1.md").write_text("""# Протокол гипотезы 1

Статус: IMPLEMENTED_NOT_RUN; REFERENCE_HARDWARE_NOT_USED.

Доступный Browser отклонил локальный стенд с ERR_BLOCKED_BY_CLIENT. FPS, browser pointer/UI latency, нагрузка API/PostgreSQL/object storage и параллельные пользовательские сессии не измерены. Набор из 19 моделей и эталонный ПК отсутствуют. Реализованный benchmark не выдаётся за выполненный.

Вывод: гипотеза не подтверждена в предусмотренном ТЗ объёме вследствие отсутствия результатов испытаний. Это не измеренный FAIL по FPS. Частичные CPU-замеры Raycaster приведены в SPRINT0_PROTOCOL.md и не заменяют UI latency.
""")
Path("PROTOCOL_HYPOTHESIS_2.md").write_text(f"""# Протокол гипотезы 2

Статус converter/GUID/quarantine: VERIFIED / PASS на одной КМ. Полный сценарий ТЗ: NOT_COMPLETED.

КМ IFC {fmt(r['sourceSizeBytes'])} байт преобразован в instanced Draco GLB {fmt(r['dracoGlbSizeBytes'])} байт. Сохранены {fmt(r['visibleElements'])} элементов и {fmt(r['triangleCount'])} треугольников. Уникальных GUID {fmt(r['uniqueGuidCount'])}, missing=0, duplicates=0. Независимое повторное чтение IFC, GLB decode, GUID ordering и Node GLTFLoader/Raycaster прошли.

Очередь: {' → '.join(q['actual'])}. Повреждённая структура IFC и повреждённая geometry не блокировали последующие задания. Детальные данные и методика — SPRINT0_PROTOCOL.md и reports/.

Контрольное браузерное открытие заблокировано окружением. КЖ/КР и остальные модели требуемого набора не прошли конвертацию в этих испытаниях. Вывод: converter-часть гипотезы подтверждена на КМ; гипотеза в полном объёме ТЗ не подтверждена. Полная приёмка не заявляется.
""")
print(json.dumps(summary, indent=2))
