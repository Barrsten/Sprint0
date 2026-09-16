import logging
import time

logging.Formatter.converter = time.gmtime
from .cli import parser
from .pipeline import convert

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
a = parser().parse_args()
convert(a.input, a.output, a.workers, a.draco, a.draco_level, a.metadata)
