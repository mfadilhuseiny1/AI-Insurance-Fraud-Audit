"""One connection of the WSL registry relay (container_runtime.py): started by the relay inside WSL as a Windows
process, it connects to the API on this machine's 127.0.0.1 and copies bytes between its stdin / stdout and the API."""

import socket
import sys
import threading


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    sock = socket.create_connection(("127.0.0.1", port))
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer

    def upstream() -> None:
        try:
            while True:
                b = stdin.read1(65536) if hasattr(stdin, "read1") else stdin.read(65536)
                if not b:
                    break
                sock.sendall(b)
        except OSError:
            pass
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=upstream, daemon=True).start()
    try:
        while True:
            b = sock.recv(65536)
            if not b:
                break
            stdout.write(b)
            stdout.flush()
    except OSError:
        pass
    finally:
        sock.close()


if __name__ == "__main__":
    main()
