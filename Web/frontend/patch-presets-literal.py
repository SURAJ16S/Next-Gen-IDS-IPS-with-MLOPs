import os

filePath = r"d:\YASH\Final Year Projett\Web\frontend\src\pages\DevOps.jsx"
if not os.path.exists(filePath):
    print("File not found!")
    exit(1)

with open(filePath, "r", encoding="utf-8") as f:
    content = f.read()

# Normalize newlines
content = content.replace("\r\n", "\n")

# Define target string to replace
target_str = """🐍 Python (Django)
                          </button>"""

# Define the new buttons markup with literal \n sequences
new_buttons = """
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# SQLite Config\\nPORT=3001\\nSQLITE_DB=preview_db.sqlite\\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            💾 SQLite
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# MariaDB Config\\nPORT=3001\\nMARIADB_HOST=127.0.0.1\\nMARIADB_PORT=3306\\nMARIADB_USER=root\\nMARIADB_PASSWORD=\\nMARIADB_DB=preview_db\\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            💠 MariaDB
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# SQL Server Config\\nPORT=3001\\nMSSQL_HOST=127.0.0.1\\nMSSQL_PORT=1433\\nMSSQL_USER=sa\\nMSSQL_PASSWORD=YourStrongPassword123\\nMSSQL_DB=preview_db\\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            🖲️ SQL Server
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Oracle Config\\nPORT=3001\\nORACLE_HOST=127.0.0.1\\nORACLE_PORT=1521\\nORACLE_USER=system\\nORACLE_PASSWORD=oracle\\nORACLE_SERVICE=ORCL\\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            🅾️ Oracle DB
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Cassandra Config\\nPORT=3001\\nCASSANDRA_HOST=127.0.0.1\\nCASSANDRA_PORT=9042\\nCASSANDRA_KEYSPACE=preview_keyspace\\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            🌌 Cassandra
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Redis Config\\nPORT=3001\\nREDIS_HOST=127.0.0.1\\nREDIS_PORT=6379\\nREDIS_PASSWORD=\\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            ❤️ Redis
                          </button>"""

if target_str in content:
    print("Found target Django button!")
    content = content.replace(target_str, target_str + new_buttons)
else:
    print("Target Django button NOT found!")

# Convert back to CRLF
content = content.replace("\n", "\r\n")

with open(filePath, "w", encoding="utf-8") as f:
    f.write(content)

print("Done literal presets patching!")
