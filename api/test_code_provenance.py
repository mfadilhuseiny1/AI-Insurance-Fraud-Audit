"""The training-code record (code_provenance.py).

The record reads every loaded file at the END of a run, and other sessions share the working tree: a file saved after
the run's process started may hold other code than what ran, so the record must flag it rather than pass it off as the
code that ran, and must flag nothing that was saved before.
"""

from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import code_provenance as cp  # noqa: E402
import ml_notebooks  # noqa: E402,F401  (a loaded repository module whose file time the test moves)


class ChangedDuringRun(unittest.TestCase):
    def test_a_file_saved_after_the_process_started_is_flagged(self):
        before = cp.capture("test")
        self.assertTrue(before["process_started_at"])
        self.assertNotIn("api/ml_notebooks.py", before["changed_during_run"])
        path = HERE / "ml_notebooks.py"
        st = os.stat(path)
        try:
            os.utime(path, ns=(st.st_atime_ns, time.time_ns()))  # its time only: the contents stay as they are
            after = cp.capture("test")
        finally:
            os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertIn("api/ml_notebooks.py", after["changed_during_run"])
        flagged = {f["path"] for f in after["files"] if f.get("changed_during_run")}
        self.assertEqual(flagged, set(after["changed_during_run"]))


if __name__ == "__main__":
    unittest.main()
