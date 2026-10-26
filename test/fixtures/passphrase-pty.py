# Exercise the actual CLI on a PTY without copying its secret into test output.
import json, os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
child = subprocess.Popen(["node", "dist/cli.js", "passphrase"], stdin=slave, stdout=slave, stderr=slave)
output = b""
def until(needle, seconds=10):
    global output
    deadline = time.monotonic() + seconds
    while needle.lower() not in output.lower() and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try: output += os.read(master, 65536)
            except OSError: break
    return needle.lower() in output.lower()
try:
    prompted = until(b"passphrase")
    echo_off = not (termios.tcgetattr(slave)[3] & termios.ECHO)
    first = b"private example passphrase"
    os.write(master, first + b"\r")
    confirmed = until(b"confirm", 5)
    if confirmed:
        os.write(master, b"\x03" if sys.argv[1] == "interrupt" else (b"different example passphrase" if sys.argv[1] == "mismatch" else first) + b"\r")
        child.wait(timeout=6)
        while select.select([master], [], [], 0.05)[0]:
            output += os.read(master, 65536)
    if child.poll() is None: child.kill(); child.wait()
    restored = bool(termios.tcgetattr(slave)[3] & termios.ECHO)
    print(json.dumps(dict(prompted=prompted, echoOff=echo_off, confirmation=confirmed, echoed=first in output, restored=restored, code=child.returncode)))
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master); os.close(slave)
