"""PySpark's Python worker for Python transforms on Spark (code_pyapi.py sets spark.python.worker.module to this).

The same as `python -m pyspark.worker`, except that it waits for the JVM to close the connection before it exits.
On Windows a worker that exits right after its last write resets the socket, the JVM loses the end of the reply and
reports "Python worker exited unexpectedly (crashed)". Used with spark.python.worker.reuse=false (one task per worker).
pyspark.worker.main also exits with sys.exit(-1) when the function stopped reading its partition early (take(),
first(), toDF() schema inference): that exit waits for the JVM too.

A transform with `@sidecar` (BLUESANDAI_SIDECAR in the environment) gets its own sidecar container per worker, as
each Foundry executor has one (sidecar_slot.py).
"""

import os
import socket
import sys

import pyspark.worker as worker
from pyspark.java_gateway import local_connect_and_auth

if __name__ == "__main__":
    sock_file, sock = local_connect_and_auth(int(os.environ["PYTHON_WORKER_FACTORY_PORT"]), os.environ["PYTHON_WORKER_FACTORY_SECRET"])
    worker.write_int(os.getpid(), sock_file)
    sock_file.flush()
    sidecar, slot = None, None
    if os.environ.get("BLUESANDAI_SIDECAR"):
        # after connecting (the JVM waits only ~10 s for a new worker); the task data waits in the socket meanwhile
        import sidecar_slot

        sidecar = sidecar_slot.spec_from_env()
        slot = sidecar_slot.start(sidecar, "executor")
    code = 0
    try:
        worker.main(sock_file, sock_file)
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 1
    finally:
        sock_file.flush()
        if slot:
            sidecar_slot.append_log(sidecar, "an executor", sidecar_slot.stop(sidecar, slot))
    try:
        sock.shutdown(socket.SHUT_WR)
        sock.settimeout(60)
        while sock.recv(65536):
            pass
    except OSError:
        pass
    if code:
        sys.exit(code)
