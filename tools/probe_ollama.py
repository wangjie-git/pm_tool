import socket
s = socket.socket()
s.settimeout(1)
try:
    s.connect(("127.0.0.1", 11434))
    print("ollama: RUNNING")
except Exception as e:
    print("ollama: NOT RUNNING ->", type(e).__name__)
s.close()
