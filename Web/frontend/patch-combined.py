import os

filePath = r"d:\YASH\Final Year Projett\Web\frontend\src\pages\DevOps.jsx"
if not os.path.exists(filePath):
    print("File not found!")
    exit(1)

with open(filePath, "r", encoding="utf-8") as f:
    content = f.read()

# Normalize newlines to LF
content = content.replace("\r\n", "\n")

# ──────────────────────────────────────────────────────────────────────────
# 1. State hooks injection
# ──────────────────────────────────────────────────────────────────────────
old_state = "const [useTempDb, setUseTempDb] = useState(true);"
new_state = "const [useTempDb, setUseTempDb] = useState(true);\n  const [enableSmartSeeding, setEnableSmartSeeding] = useState(false);"

if old_state in content:
    content = content.replace(old_state, new_state)
    print("Patched state hooks!")
else:
    print("State hooks target NOT found!")

# ──────────────────────────────────────────────────────────────────────────
# 2. Payload parameters injection
# ──────────────────────────────────────────────────────────────────────────
# ZIP upload payload
old_zip_payload = "formData.append('useTempDb', String(useTempDb));"
new_zip_payload = "formData.append('useTempDb', String(useTempDb));\n    formData.append('enableSmartSeeding', String(enableSmartSeeding));"
if old_zip_payload in content:
    content = content.replace(old_zip_payload, new_zip_payload)
    print("Patched ZIP payload!")
else:
    print("ZIP payload target NOT found!")

# GitHub import payload
# Find unique importGithubRepo call
gh_import_idx = content.find("const handleGithubImport = async () => {")
if gh_import_idx != -1:
    target_param_idx = content.find("useTempDb,", gh_import_idx)
    if target_param_idx != -1:
        content = content[:target_param_idx] + "useTempDb,\n        enableSmartSeeding," + content[target_param_idx + len("useTempDb,"):]
        print("Patched GitHub payload!")
    else:
        print("GitHub payload parameter target NOT found!")
else:
    print("GitHub import function NOT found!")


# ──────────────────────────────────────────────────────────────────────────
# 3. DB settings block replacement (ZIP form)
# ──────────────────────────────────────────────────────────────────────────
dbSettingsZipJSX = """{/* Temporary DB Container Provisioning Toggle */}
               <div style={{
                 display: 'flex',
                 alignItems: 'flex-start',
                 gap: '10px',
                 background: 'rgba(6, 182, 212, 0.03)',
                 border: '1px solid rgba(6, 182, 212, 0.12)',
                 borderRadius: 'var(--radius-sm)',
                 padding: '10px',
                 marginTop: '5px',
                 marginBottom: '8px'
               }}>
                 <input
                   type="checkbox"
                   id="useTempDbZip"
                   checked={useTempDb}
                   onChange={(e) => {
                     const checked = e.target.checked;
                     setUseTempDb(checked);
                     if (!checked) {
                       setEnableDbInit(false);
                       setEnableSmartSeeding(false);
                     }
                   }}
                   style={{ cursor: 'pointer', width: '15px', height: '15px', accentColor: 'var(--accent-cyan)', marginTop: '2px' }}
                 />
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                   <label htmlFor="useTempDbZip" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                     Provision Temporary Database Containers
                   </label>
                   <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                     Automatically spin up isolated database containers. Uncheck if you connect directly to a cloud database or external service.
                   </span>
                 </div>
               </div>

               {/* Custom Database Seeding Script Accordion */}
               <div style={{
                 background: 'rgba(255, 255, 255, 0.02)',
                 border: '1px solid var(--border-subtle)',
                 borderRadius: 'var(--radius-md)',
                 padding: '12px',
                 marginTop: '5px',
                 marginBottom: '10px'
               }}>
                 <div 
                   style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: useTempDb ? 'pointer' : 'not-allowed' }} 
                   onClick={() => {
                     if (useTempDb) {
                       const newVal = !enableDbInit;
                       setEnableDbInit(newVal);
                       if (!newVal) {
                         setEnableSmartSeeding(false);
                       } else {
                         setUseTempDb(true);
                       }
                     }
                   }}
                 >
                   <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                     <input
                       type="checkbox"
                       checked={enableDbInit}
                       disabled={!useTempDb}
                       onChange={(e) => {
                         const checked = e.target.checked;
                         setEnableDbInit(checked);
                         if (!checked) {
                           setEnableSmartSeeding(false);
                         } else {
                           setUseTempDb(true);
                         }
                       }}
                       onClick={(e) => e.stopPropagation()}
                       style={{ width: '14px', height: '14px', accentColor: 'var(--accent-cyan)', cursor: useTempDb ? 'pointer' : 'not-allowed' }}
                     />
                     <span style={{ fontSize: '12px', fontWeight: 600, color: useTempDb ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                       Enable Custom Database Initialization Script
                     </span>
                   </div>
                   <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{enableDbInit ? '▼' : '▶'}</span>
                 </div>

                 {enableDbInit && (
                   <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '10px' }}>
                     
                     {/* Database Type select + Preset Buttons row */}
                     <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                       <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                         <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Database Type:</span>
                         <select
                           value={dbInitType}
                           onChange={(e) => setDbInitType(e.target.value)}
                           style={{
                             background: '#040815',
                             border: '1px solid var(--border-subtle)',
                             borderRadius: 'var(--radius-sm)',
                             color: '#ffffff',
                             fontSize: '11.5px',
                             padding: '4px 10px',
                             outline: 'none'
                           }}
                         >
                           <option value="mysql" style={{ background: '#040815', color: '#ffffff' }}>MySQL (SQL)</option>
                           <option value="postgres" style={{ background: '#040815', color: '#ffffff' }}>PostgreSQL (SQL)</option>
                           <option value="mongodb" style={{ background: '#040815', color: '#ffffff' }}>MongoDB (NoSQL)</option>
                           <option value="sqlite" style={{ background: '#040815', color: '#ffffff' }}>SQLite (SQL)</option>
                           <option value="mariadb" style={{ background: '#040815', color: '#ffffff' }}>MariaDB (SQL)</option>
                           <option value="mssql" style={{ background: '#040815', color: '#ffffff' }}>SQL Server (SQL)</option>
                           <option value="oracle" style={{ background: '#040815', color: '#ffffff' }}>Oracle Database (SQL)</option>
                           <option value="cassandra" style={{ background: '#040815', color: '#ffffff' }}>Cassandra (NoSQL)</option>
                           <option value="redis" style={{ background: '#040815', color: '#ffffff' }}>Redis (NoSQL)</option>
                         </select>
                       </div>

                       <div style={{ display: 'flex', gap: '6px' }}>
                         <button
                           type="button"
                           onClick={() => {
                             if (dbInitType === 'mongodb') {
                               setDbInitScript(`db.users.insertOne({ username: "admin", password: "admin123" });\\ndb.threats.insertMany([\\n  { id: "ALT-101", type: "SQL Injection", severity: "High" },\\n  { id: "ALT-102", type: "Brute Force SSH", severity: "Critical" }\\n]);`);
                             } else if (dbInitType === 'redis') {
                               setDbInitScript(`HMSET user:admin username admin password admin123 role admin\\nSADD users admin`);
                             } else if (dbInitType === 'cassandra') {
                               setDbInitScript(`CREATE KEYSPACE IF NOT EXISTS preview_keyspace WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};\\nUSE preview_keyspace;\\nCREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, password text);\\nINSERT INTO users (username, password) VALUES ('admin', 'admin123');`);
                             } else if (dbInitType === 'sqlite') {
                               setDbInitScript(`CREATE TABLE IF NOT EXISTS users (\\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\\n  username TEXT NOT NULL UNIQUE,\\n  password TEXT NOT NULL\\n);\\nINSERT OR IGNORE INTO users (username, password) VALUES ('admin', 'admin123');`);
                             } else if (dbInitType === 'mssql') {
                               setDbInitScript(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')\\nBEGIN\\n  CREATE TABLE users (id INT IDENTITY(1,1) PRIMARY KEY, username NVARCHAR(255) UNIQUE, password NVARCHAR(255));\\n  INSERT INTO users (username, password) VALUES ('admin', 'admin123');\\nEND;`);
                             } else if (dbInitType === 'oracle') {
                               setDbInitScript(`DECLARE\\n  c INT;\\nBEGIN\\n  SELECT COUNT(*) INTO c FROM user_tables WHERE table_name = 'USERS';\\n  IF c = 0 THEN\\n    EXECUTE IMMEDIATE 'CREATE TABLE users (username VARCHAR2(255) PRIMARY KEY, password VARCHAR2(255))';\\n  END IF;\\n  EXECUTE IMMEDIATE 'INSERT INTO users (username, password) VALUES (''admin'', ''admin123'')';\\nEND;\\n/`);
                             } else {
                               setDbInitScript(`CREATE TABLE IF NOT EXISTS users (\\n  id INT AUTO_INCREMENT PRIMARY KEY,\\n  username VARCHAR(255) NOT NULL UNIQUE,\\n  password VARCHAR(255) NOT NULL\\n);\\n\\nINSERT INTO users (username, password) VALUES ('admin', 'admin123') ON DUPLICATE KEY UPDATE password=VALUES(password);`);
                             }
                           }}
                           style={{ background: 'rgba(6, 182, 212, 0.1)', border: '1px solid rgba(6, 182, 212, 0.25)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-cyan)', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                         >
                           💡 Load Preset
                         </button>
                         <button
                           type="button"
                           onClick={() => setDbInitScript('')}
                           style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 'var(--radius-sm)', color: '#f87171', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                         >
                           Clear
                         </button>
                       </div>
                     </div>

                     {/* Smart Seeding Checkbox (Grandchild on its own separate block row) */}
                     <div style={{
                       display: 'flex',
                       alignItems: 'flex-start',
                       gap: '8px',
                       background: 'rgba(34, 211, 238, 0.02)',
                       border: '1px solid rgba(34, 211, 238, 0.1)',
                       borderRadius: 'var(--radius-sm)',
                       padding: '8px 10px',
                       marginTop: '4px',
                       marginBottom: '4px'
                     }}>
                       <input
                         type="checkbox"
                         id="enableSmartSeedingCheckboxZip"
                         checked={enableSmartSeeding}
                         disabled={!useTempDb || !enableDbInit}
                         onChange={(e) => {
                           const checked = e.target.checked;
                           setEnableSmartSeeding(checked);
                           if (checked) {
                             setEnableDbInit(true);
                             setUseTempDb(true);
                           }
                         }}
                         style={{ width: '13px', height: '13px', accentColor: 'var(--accent-cyan)', marginTop: '2px', cursor: (useTempDb && enableDbInit) ? 'pointer' : 'not-allowed' }}
                       />
                       <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                         <label htmlFor="enableSmartSeedingCheckboxZip" style={{ fontSize: '11px', fontWeight: 600, color: (useTempDb && enableDbInit) ? 'var(--text-primary)' : 'var(--text-muted)', cursor: (useTempDb && enableDbInit) ? 'pointer' : 'not-allowed' }}>
                           Enable Smart Table/Collection Detection & Seeding
                         </label>
                         <span style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                           Automatically scans your files during deployment to discover tables, find the user credentials structure, and draft optimal initialization queries.
                         </span>
                       </div>
                     </div>

                     {/* Initialization Script Input Area */}
                     <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                       <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                         Initialization Script / Commands:
                       </label>
                       <div style={{ position: 'relative', width: '100%', minHeight: '130px' }}>
                         <textarea
                           value={dbInitScript}
                           onChange={(e) => setDbInitScript(e.target.value)}
                           onScroll={handleTextareaScroll}
                           placeholder={
                             dbInitType === 'mongodb'
                               ? '// Enter MongoDB query sequence:\\ndb.users.insertOne({ username: "admin", password: "admin123" });'
                               : '/* Enter SQL command sequence: */\\nCREATE TABLE IF NOT EXISTS users (...);\\nINSERT INTO users ...;'
                           }
                           rows={6}
                           style={{
                             width: '100%',
                             height: '130px',
                             background: 'transparent',
                             border: '1px solid var(--border-subtle)',
                             borderRadius: 'var(--radius-sm)',
                             color: 'transparent',
                             caretColor: '#ffffff',
                             fontFamily: 'var(--font-mono), monospace',
                             fontSize: '11.5px',
                             padding: '10px',
                             outline: 'none',
                             resize: 'vertical',
                             position: 'relative',
                             zIndex: 2,
                             whiteSpace: 'pre-wrap',
                             wordBreak: 'break-all',
                             lineHeight: '1.5',
                             boxSizing: 'border-box'
                           }}
                         />
                         <pre
                           dangerouslySetInnerHTML={{ __html: highlightCode(dbInitScript, dbInitType) || `<span style="color: var(--text-muted); font-style: italic;">\${dbInitType === 'mongodb' ? '// Enter MongoDB queries...' : '/* Enter SQL commands... */'}</span>` }}
                           style={{
                             position: 'absolute',
                             top: 0,
                             left: 0,
                             width: '100%',
                             height: '100%',
                             background: '#020617',
                             border: '1px solid transparent',
                             borderRadius: 'var(--radius-sm)',
                             fontFamily: 'var(--font-mono), monospace',
                             fontSize: '11.5px',
                             padding: '10px',
                             margin: 0,
                             pointerEvents: 'none',
                             whiteSpace: 'pre-wrap',
                             wordBreak: 'break-all',
                             overflow: 'hidden',
                             zIndex: 1,
                             lineHeight: '1.5',
                             boxSizing: 'border-box',
                             textAlign: 'left',
                             color: '#ffffff'
                           }}
                         />
                       </div>
                     </div>
                   </div>
                 )}
               </div>"""

# ZIP Form boundary replace
zip_db_block_start = content.find('{/* Temporary DB Container Provisioning Toggle */}')
zip_env_files_header = content.find('<label style={labelStyle}>Environment Files (.env)</label>', zip_db_block_start)
zip_db_block_end = content.rfind('<div style={{ display: \'flex\', alignItems: \'center\', justifyContent: \'space-between\' }}>', zip_db_block_start, zip_env_files_header)

if zip_db_block_start != -1 and zip_db_block_end != -1:
    content = content[:zip_db_block_start] + dbSettingsZipJSX + "\n\n               " + content[zip_db_block_end:]
    print("Replaced ZIP db block!")
else:
    print("ZIP db block boundaries NOT found!")


# ──────────────────────────────────────────────────────────────────────────
# 4. DB settings block injection (GitHub form)
# ──────────────────────────────────────────────────────────────────────────
dbSettingsGitJSX = """{/* Temporary DB Container Provisioning Toggle for GitHub */}
                      <div style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '10px',
                        background: 'rgba(6, 182, 212, 0.03)',
                        border: '1px solid rgba(6, 182, 212, 0.12)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '10px',
                        marginTop: '10px',
                        marginBottom: '8px'
                      }}>
                        <input
                          type="checkbox"
                          id="useTempDbGit"
                          checked={useTempDb}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setUseTempDb(checked);
                            if (!checked) {
                              setEnableDbInit(false);
                              setEnableSmartSeeding(false);
                            }
                          }}
                          style={{ cursor: 'pointer', width: '15px', height: '15px', accentColor: 'var(--accent-cyan)', marginTop: '2px' }}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <label htmlFor="useTempDbGit" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                            Provision Temporary Database Containers
                          </label>
                          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                            Automatically spin up isolated database containers. Uncheck if you connect directly to a cloud database or external service.
                          </span>
                        </div>
                      </div>

                      {/* Custom Database Seeding Script Accordion for GitHub */}
                      <div style={{
                        background: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-md)',
                        padding: '12px',
                        marginTop: '5px',
                        marginBottom: '10px'
                      }}>
                        <div 
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: useTempDb ? 'pointer' : 'not-allowed' }} 
                          onClick={() => {
                            if (useTempDb) {
                              const newVal = !enableDbInit;
                              setEnableDbInit(newVal);
                              if (!newVal) {
                                setEnableSmartSeeding(false);
                              } else {
                                setUseTempDb(true);
                              }
                            }
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                              type="checkbox"
                              checked={enableDbInit}
                              disabled={!useTempDb}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setEnableDbInit(checked);
                                if (!checked) {
                                  setEnableSmartSeeding(false);
                                } else {
                                  setUseTempDb(true);
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '14px', height: '14px', accentColor: 'var(--accent-cyan)', cursor: useTempDb ? 'pointer' : 'not-allowed' }}
                            />
                            <span style={{ fontSize: '12px', fontWeight: 600, color: useTempDb ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                              Enable Custom Database Initialization Script
                            </span>
                          </div>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{enableDbInit ? '▼' : '▶'}</span>
                        </div>

                        {enableDbInit && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '10px' }}>
                            
                            {/* Database Type select + Preset Buttons row */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Database Type:</span>
                                <select
                                  value={dbInitType}
                                  onChange={(e) => setDbInitType(e.target.value)}
                                  style={{
                                    background: '#040815',
                                    border: '1px solid var(--border-subtle)',
                                    borderRadius: 'var(--radius-sm)',
                                    color: '#ffffff',
                                    fontSize: '11.5px',
                                    padding: '4px 10px',
                                    outline: 'none'
                                  }}
                                >
                                  <option value="mysql" style={{ background: '#040815', color: '#ffffff' }}>MySQL (SQL)</option>
                                  <option value="postgres" style={{ background: '#040815', color: '#ffffff' }}>PostgreSQL (SQL)</option>
                                  <option value="mongodb" style={{ background: '#040815', color: '#ffffff' }}>MongoDB (NoSQL)</option>
                                  <option value="sqlite" style={{ background: '#040815', color: '#ffffff' }}>SQLite (SQL)</option>
                                  <option value="mariadb" style={{ background: '#040815', color: '#ffffff' }}>MariaDB (SQL)</option>
                                  <option value="mssql" style={{ background: '#040815', color: '#ffffff' }}>SQL Server (SQL)</option>
                                  <option value="oracle" style={{ background: '#040815', color: '#ffffff' }}>Oracle Database (SQL)</option>
                                  <option value="cassandra" style={{ background: '#040815', color: '#ffffff' }}>Cassandra (NoSQL)</option>
                                  <option value="redis" style={{ background: '#040815', color: '#ffffff' }}>Redis (NoSQL)</option>
                                </select>
                              </div>

                              <div style={{ display: 'flex', gap: '6px' }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (dbInitType === 'mongodb') {
                                      setDbInitScript(`db.users.insertOne({ username: "admin", password: "admin123" });\\ndb.threats.insertMany([\\n  { id: "ALT-101", type: "SQL Injection", severity: "High" },\\n  { id: "ALT-102", type: "Brute Force SSH", severity: "Critical" }\\n]);`);
                                    } else if (dbInitType === 'redis') {
                                      setDbInitScript(`HMSET user:admin username admin password admin123 role admin\\nSADD users admin`);
                                    } else if (dbInitType === 'cassandra') {
                                      setDbInitScript(`CREATE KEYSPACE IF NOT EXISTS preview_keyspace WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};\\nUSE preview_keyspace;\\nCREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, password text);\\nINSERT INTO users (username, password) VALUES ('admin', 'admin123');`);
                                    } else if (dbInitType === 'sqlite') {
                                      setDbInitScript(`CREATE TABLE IF NOT EXISTS users (\\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\\n  username TEXT NOT NULL UNIQUE,\\n  password TEXT NOT NULL\\n);\\nINSERT OR IGNORE INTO users (username, password) VALUES ('admin', 'admin123');`);
                                    } else if (dbInitType === 'mssql') {
                                      setDbInitScript(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')\\nBEGIN\\n  CREATE TABLE users (id INT IDENTITY(1,1) PRIMARY KEY, username NVARCHAR(255) UNIQUE, password NVARCHAR(255));\\n  INSERT INTO users (username, password) VALUES ('admin', 'admin123');\\nEND;`);
                                    } else if (dbInitType === 'oracle') {
                                      setDbInitScript(`DECLARE\\n  c INT;\\nBEGIN\\n  SELECT COUNT(*) INTO c FROM user_tables WHERE table_name = 'USERS';\\n  IF c = 0 THEN\\n    EXECUTE IMMEDIATE 'CREATE TABLE users (username VARCHAR2(255) PRIMARY KEY, password VARCHAR2(255))';\\n  END IF;\\n  EXECUTE IMMEDIATE 'INSERT INTO users (username, password) VALUES (''admin'', ''admin123'')';\\nEND;\\n/`);
                                    } else {
                                      setDbInitScript(`CREATE TABLE IF NOT EXISTS users (\\n  id INT AUTO_INCREMENT PRIMARY KEY,\\n  username VARCHAR(255) NOT NULL UNIQUE,\\n  password VARCHAR(255) NOT NULL\\n);\\n\\nINSERT INTO users (username, password) VALUES ('admin', 'admin123') ON DUPLICATE KEY UPDATE password=VALUES(password);`);
                                    }
                                  }}
                                  style={{ background: 'rgba(6, 182, 212, 0.1)', border: '1px solid rgba(6, 182, 212, 0.25)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-cyan)', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                >
                                  💡 Load Preset
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDbInitScript('')}
                                  style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 'var(--radius-sm)', color: '#f87171', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                >
                                  Clear
                                </button>
                              </div>
                            </div>

                            {/* Smart Seeding Checkbox (Grandchild on its own separate block row) */}
                            <div style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: '8px',
                              background: 'rgba(34, 211, 238, 0.02)',
                              border: '1px solid rgba(34, 211, 238, 0.1)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '8px 10px',
                              marginTop: '4px',
                              marginBottom: '4px'
                            }}>
                              <input
                                type="checkbox"
                                id="enableSmartSeedingCheckboxGit"
                                checked={enableSmartSeeding}
                                disabled={!useTempDb || !enableDbInit}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setEnableSmartSeeding(checked);
                                  if (checked) {
                                    setEnableDbInit(true);
                                    setUseTempDb(true);
                                  }
                                }}
                                style={{ width: '13px', height: '13px', accentColor: 'var(--accent-cyan)', marginTop: '2px', cursor: (useTempDb && enableDbInit) ? 'pointer' : 'not-allowed' }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                <label htmlFor="enableSmartSeedingCheckboxGit" style={{ fontSize: '11px', fontWeight: 600, color: (useTempDb && enableDbInit) ? 'var(--text-primary)' : 'var(--text-muted)', cursor: (useTempDb && enableDbInit) ? 'pointer' : 'not-allowed' }}>
                                  Enable Smart Table/Collection Detection & Seeding
                                </label>
                                <span style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                                  Automatically scans files during deployment to discover tables and generate init seeds.
                                </span>
                              </div>
                            </div>

                            {/* Initialization Script Input Area */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                Initialization Script / Commands:
                              </label>
                              <div style={{ position: 'relative', width: '100%', minHeight: '130px' }}>
                                <textarea
                                  value={dbInitScript}
                                  onChange={(e) => setDbInitScript(e.target.value)}
                                  onScroll={handleTextareaScroll}
                                  placeholder={
                                    dbInitType === 'mongodb'
                                      ? '// Enter MongoDB query sequence:\\ndb.users.insertOne({ username: "admin", password: "admin123" });'
                                      : '/* Enter SQL command sequence: */\\nCREATE TABLE IF NOT EXISTS users (...);\\nINSERT INTO users ...;'
                                  }
                                  rows={6}
                                  style={{
                                    width: '100%',
                                    height: '130px',
                                    background: 'transparent',
                                    border: '1px solid var(--border-subtle)',
                                    borderRadius: 'var(--radius-sm)',
                                    color: 'transparent',
                                    caretColor: '#ffffff',
                                    fontFamily: 'var(--font-mono), monospace',
                                    fontSize: '11.5px',
                                    padding: '10px',
                                    outline: 'none',
                                    resize: 'vertical',
                                    position: 'relative',
                                    zIndex: 2,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    lineHeight: '1.5',
                                    boxSizing: 'border-box'
                                  }}
                                />
                                <pre
                                  dangerouslySetInnerHTML={{ __html: highlightCode(dbInitScript, dbInitType) || `<span style="color: var(--text-muted); font-style: italic;">\${dbInitType === 'mongodb' ? '// Enter MongoDB queries...' : '/* Enter SQL commands... */'}</span>` }}
                                  style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    height: '100%',
                                    background: '#020617',
                                    border: '1px solid transparent',
                                    borderRadius: 'var(--radius-sm)',
                                    fontFamily: 'var(--font-mono), monospace',
                                    fontSize: '11.5px',
                                    padding: '10px',
                                    margin: 0,
                                    pointerEvents: 'none',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    overflow: 'hidden',
                                    zIndex: 1,
                                    lineHeight: '1.5',
                                    boxSizing: 'border-box',
                                    textAlign: 'left',
                                    color: '#ffffff'
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>"""

gitEnvHeaderPattern = """                      {/* .env files section */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>"""

if gitEnvHeaderPattern in content:
    content = content.replace(gitEnvHeaderPattern, gitEnvHeaderPattern + "\n" + dbSettingsGitJSX)
    print("Injected GitHub db block!")
else:
    print("Git env header pattern NOT found!")


# ──────────────────────────────────────────────────────────────────────────
# 5. Environment presets button injection
# ──────────────────────────────────────────────────────────────────────────
target_str = """🐍 Python (Django)
                          </button>"""

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
    content = content.replace(target_str, target_str + new_buttons)
    print("Injected presets buttons!")
else:
    print("Presets buttons target NOT found!")

# Convert back to CRLF newlines
content = content.replace("\n", "\r\n")

with open(filePath, "w", encoding="utf-8") as f:
    f.write(content)

print("Done complete combined literal patching!")
