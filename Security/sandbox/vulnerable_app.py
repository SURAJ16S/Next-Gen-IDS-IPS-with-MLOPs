import os
import sqlite3
import requests
from flask import Flask, request, render_template_string, redirect, send_file, url_for

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = '/tmp'

# Setup dummy database for SQLi
def init_db():
    conn = sqlite3.connect('test.db')
    c = conn.cursor()
    c.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, password TEXT)')
    c.execute('DELETE FROM users')
    c.execute("INSERT INTO users (username, password) VALUES ('admin', 'supersecretpassword123')")
    c.execute("INSERT INTO users (username, password) VALUES ('user', 'password')")
    conn.commit()
    conn.close()

init_db()

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IDS/IPS Vulnerable Target Playground</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background-color: #f8f9fa; padding: 20px; font-family: system-ui, -apple-system, sans-serif; }
        .card { margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border: none; }
        .card-header { font-weight: bold; background: #2c3e50; color: white; }
        .result-box { background: #e9ecef; padding: 10px; border-radius: 5px; font-family: monospace; max-height: 150px; overflow-y: auto; }
        .vuln-badge { float: right; font-size: 0.8rem; }
    </style>
</head>
<body>
<div class="container">
    <h1 class="mb-4 text-center">IDS/IPS Vulnerable Target Playground</h1>
    <p class="text-center text-muted">A deliberately insecure application to test the Go Proxy's detection capabilities.</p>
    
    <div class="row">
        <!-- SQL INJECTION -->
        <div class="col-md-6">
            <div class="card">
                <div class="card-header">1. SQL Injection (SQLi) <span class="badge bg-danger vuln-badge">CatSQLi</span></div>
                <div class="card-body">
                    <form action="/login" method="POST">
                        <div class="mb-3">
                            <label>Username</label>
                            <input type="text" name="username" class="form-control" value="admin' OR '1'='1">
                        </div>
                        <div class="mb-3">
                            <label>Password</label>
                            <input type="password" name="password" class="form-control" value="anything">
                        </div>
                        <button type="submit" class="btn btn-primary">Login</button>
                    </form>
                    {% if sql_result %}
                        <div class="mt-3 result-box">{{ sql_result }}</div>
                    {% endif %}
                </div>
            </div>
        </div>

        <!-- CROSS SITE SCRIPTING -->
        <div class="col-md-6">
            <div class="card">
                <div class="card-header">2. Cross-Site Scripting (XSS) <span class="badge bg-danger vuln-badge">CatXSS</span></div>
                <div class="card-body">
                    <form action="/comment" method="POST">
                        <div class="mb-3">
                            <label>Leave a comment</label>
                            <input type="text" name="comment" class="form-control" value="<script>alert('XSS!')</script>">
                        </div>
                        <button type="submit" class="btn btn-primary">Submit</button>
                    </form>
                    {% if comment_result %}
                        <div class="mt-3 result-box">User said: {{ comment_result | safe }}</div>
                    {% endif %}
                </div>
            </div>
        </div>
        
        <!-- COMMAND INJECTION -->
        <div class="col-md-6">
            <div class="card">
                <div class="card-header">3. Command Injection <span class="badge bg-danger vuln-badge">CatCommandInjection</span></div>
                <div class="card-body">
                    <form action="/ping" method="POST">
                        <div class="mb-3">
                            <label>IP Address to Ping</label>
                            <input type="text" name="ip" class="form-control" value="8.8.8.8; cat /etc/passwd">
                        </div>
                        <button type="submit" class="btn btn-primary">Ping</button>
                    </form>
                    {% if ping_result %}
                        <div class="mt-3 result-box">{{ ping_result }}</div>
                    {% endif %}
                </div>
            </div>
        </div>

        <!-- PATH TRAVERSAL -->
        <div class="col-md-6">
            <div class="card">
                <div class="card-header">4. Path Traversal / LFI <span class="badge bg-danger vuln-badge">CatPathTraversal</span></div>
                <div class="card-body">
                    <form action="/download" method="GET">
                        <div class="mb-3">
                            <label>File Name</label>
                            <input type="text" name="file" class="form-control" value="../../../../../../../../etc/passwd">
                        </div>
                        <button type="submit" class="btn btn-primary">Read File</button>
                    </form>
                    {% if file_result %}
                        <div class="mt-3 result-box">{{ file_result }}</div>
                    {% endif %}
                </div>
            </div>
        </div>

        <!-- SSRF -->
        <div class="col-md-6">
            <div class="card">
                <div class="card-header">5. Server-Side Request Forgery (SSRF) <span class="badge bg-danger vuln-badge">CatSSRF</span></div>
                <div class="card-body">
                    <form action="/fetch" method="POST">
                        <div class="mb-3">
                            <label>URL to fetch</label>
                            <input type="text" name="url" class="form-control" value="http://169.254.169.254/latest/meta-data/">
                        </div>
                        <button type="submit" class="btn btn-primary">Fetch</button>
                    </form>
                    {% if fetch_result %}
                        <div class="mt-3 result-box">{{ fetch_result }}</div>
                    {% endif %}
                </div>
            </div>
        </div>

        <!-- OPEN REDIRECT -->
        <div class="col-md-6">
            <div class="card">
                <div class="card-header">6. Open Redirect <span class="badge bg-danger vuln-badge">CatOpenRedirect</span></div>
                <div class="card-body">
                    <form action="/redirect" method="GET">
                        <div class="mb-3">
                            <label>Redirect URL</label>
                            <input type="text" name="next" class="form-control" value="http://evil.com">
                        </div>
                        <button type="submit" class="btn btn-primary">Go</button>
                    </form>
                </div>
            </div>
        </div>

        <!-- RATE LIMITING / BRUTE FORCE SIMULATOR -->
        <div class="col-md-12">
            <div class="card border-warning">
                <div class="card-header bg-warning text-dark">7. Rapid-Fire / Brute Force Simulator <span class="badge bg-dark vuln-badge">CatBruteForce</span></div>
                <div class="card-body text-center">
                    <p>Fires 50 rapid requests to `/login` to intentionally trigger Rate Limiting or CAPTCHA.</p>
                    <button id="bruteForceBtn" class="btn btn-warning fw-bold text-dark px-4 py-2" onclick="simulateBruteForce()">🔥 FIRE 50 REQUESTS NOW</button>
                    <div id="bf-status" class="mt-3 text-muted">Idle...</div>
                </div>
            </div>
        </div>

    </div>
</div>

<script>
async function simulateBruteForce() {
    const btn = document.getElementById('bruteForceBtn');
    const status = document.getElementById('bf-status');
    btn.disabled = true;
    status.innerText = "Firing 50 requests in parallel...";
    
    let promises = [];
    for(let i=0; i<50; i++) {
        promises.push(
            fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'username=admin&password=wrongpassword' + i
            }).catch(e => e)
        );
    }
    
    await Promise.all(promises);
    status.innerHTML = "<span class='text-success'>Done! Check Go Proxy logs for detections/blocks.</span>";
    btn.disabled = false;
}
</script>
</body>
</html>
"""

@app.route('/')
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route('/login', methods=['POST'])
def login():
    username = request.form.get('username', '')
    password = request.form.get('password', '')
    
    # Intentionally vulnerable to SQLi
    conn = sqlite3.connect('test.db')
    c = conn.cursor()
    query = f"SELECT * FROM users WHERE username = '{username}' AND password = '{password}'"
    try:
        c.execute(query)
        user = c.fetchone()
        result = f"Query executed: {query}\n\nResult: {user if user else 'Login Failed'}"
    except Exception as e:
        result = f"Query failed: {query}\n\nError: {e}"
    conn.close()
    
    return render_template_string(HTML_TEMPLATE, sql_result=result)

@app.route('/comment', methods=['POST'])
def comment():
    comment = request.form.get('comment', '')
    # Intentionally vulnerable to XSS (passed back unescaped)
    return render_template_string(HTML_TEMPLATE, comment_result=comment)

@app.route('/ping', methods=['POST'])
def ping():
    ip = request.form.get('ip', '')
    # Intentionally vulnerable to Command Injection
    try:
        stream = os.popen(f"ping -c 1 {ip}")
        output = stream.read()
    except Exception as e:
        output = str(e)
    return render_template_string(HTML_TEMPLATE, ping_result=output)

@app.route('/download', methods=['GET'])
def download():
    filename = request.args.get('file', '')
    # Intentionally vulnerable to Path Traversal / LFI
    try:
        with open(filename, 'r') as f:
            content = f.read()
        return render_template_string(HTML_TEMPLATE, file_result=content[:1000] + "...\n(Truncated)")
    except Exception as e:
        return render_template_string(HTML_TEMPLATE, file_result=f"Error reading file: {e}")

@app.route('/fetch', methods=['POST'])
def fetch():
    url = request.form.get('url', '')
    # Intentionally vulnerable to SSRF
    try:
        resp = requests.get(url, timeout=3)
        result = resp.text[:1000] + "...\n(Truncated)"
    except Exception as e:
        result = str(e)
    return render_template_string(HTML_TEMPLATE, fetch_result=result)

@app.route('/redirect', methods=['GET'])
def open_redirect():
    target = request.args.get('next', '/')
    # Intentionally vulnerable to Open Redirect
    return redirect(target)

if __name__ == '__main__':
    # Ensure dependencies are available (requests)
    try:
        import requests
    except ImportError:
        os.system("pip install requests flask")
    
    print("[*] Starting Vulnerable Target Application on port 9090...")
    app.run(host='0.0.0.0', port=9090, debug=True)
