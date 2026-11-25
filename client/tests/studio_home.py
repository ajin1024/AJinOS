# Allow the Windows fixture process to release its working directory before removing the test home.
from contextlib import contextmanager
import os
import tempfile
import time


@contextmanager
def studio_home(prefix):
    directory = tempfile.TemporaryDirectory(prefix=prefix)
    try:
        yield directory.name
    finally:
        # Windows can still hold the demo Agent's working directory just after the run is settled.
        if os.name == "nt":
            for _ in range(20):
                try:
                    directory.cleanup()
                    break
                except PermissionError:
                    time.sleep(0.25)
        directory.cleanup()
