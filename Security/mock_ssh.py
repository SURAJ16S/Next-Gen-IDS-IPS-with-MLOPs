import socket
import time

def start_server(port):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(('127.0.0.1', port))
    server.listen(5)
    print(f"Mock SSH Server listening on {port}...")
    while True:
        client, addr = server.accept()
        print(f"Accepted connection from {addr}")
        # Send SSH banner
        client.sendall(b"SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.1\r\n")
        try:
            while True:
                data = client.recv(1024)
                if not data:
                    break
        except Exception as e:
            print(f"Error: {e}")
        finally:
            client.close()

if __name__ == "__main__":
    start_server(2222)
