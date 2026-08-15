[2026-08-14T20:10:58.348Z] [SAST] Semgrep: 72 alert(s) found.
[2026-08-14T20:10:58.347Z] Step Completed: SEMGREP-SAST
[2026-08-14T20:10:58.372Z] Starting Step: OSV-SCAN using container ghcr.io/google/osv-scanner:latest...
[2026-08-14T20:10:58.371Z] Using local cached image: ghcr.io/google/osv-scanner:latest
[2026-08-14T20:10:58.683Z] [OSV-SCAN] %Starting filesystem walk for root: /
[2026-08-14T20:10:58.682Z] [OSV-SCAN] Scanning dir /workspace
[2026-08-14T20:11:23.953Z] [OSV-SCAN] AScanned /workspace/package-lock.json file and found 591 packages
[2026-08-14T20:11:24.277Z] [OSV-SCAN] sEnd status: 1933 dirs visited, 14419 inodes visited, 1 Extract calls, 25.59703186s elapsed, 25.59561261s wall time
[2026-08-14T20:11:28.570Z] [OSV] Dependency scan: 6 match(es) found.
[2026-08-14T20:11:28.570Z] [!] OSV completed: Container exited with non-zero: 1
[2026-08-14T20:11:28.597Z] Using local cached image: aquasec/trivy:latest
[2026-08-14T20:11:28.597Z] Starting Step: TRIVY-SEC-SCAN using container aquasec/trivy:latest...
[2026-08-14T20:11:28.931Z] [TRIVY-SEC-SCAN] �2026-08-14T20:11:28ZINFO[vulndb] Need to update DB
[2026-08-14T20:11:28.931Z] [TRIVY-SEC-SCAN] 2026-08-14T20:11:28ZINFO[vulndb] Downloading artifact...repo="mirror.gcr.io/aquasec/trivy-db:2"
[2026-08-14T20:11:28.931Z] [TRIVY-SEC-SCAN] 2026-08-14T20:11:28ZINFO[vulndb] Downloading vulnerability DB...
[2026-08-14T20:11:41.566Z] [TRIVY-SEC-SCAN] d287.24 KiB / 106.97 MiB [>___________________________________________________________] 0.26% ? p/s ?d1.70 MiB / 106.97 MiB [>_____________________________________________________________] 1.59% ? p/s ?d4.51 MiB / 106.97 MiB [-->___________________________________________________________] 4.22% ? p/s ?d7.36 MiB / 106.97 MiB [--->_____________________________________________] 6.88% 11.81 MiB p/s ETA 8sd10.12 MiB / 106.97 MiB [---->___________________________________________] 9.47% 11.81 MiB p/s ETA 8sd12.71 MiB / 106.97 MiB [----->_________________________________________] 11.88% 11.81 MiB p/s ETA 7sd15.72 MiB / 106.97 MiB [------>________________________________________] 14.69% 11.95 MiB p/s ETA 7sd18.57 MiB / 106.97 MiB [-------->______________________________________] 17.36% 11.95 MiB p/s ETA 7sd21.44 MiB / 106.97 MiB [--------->_____________________________________] 20.04% 11.95 MiB p/s ETA 7sd24.30 MiB / 106.97 MiB [---------->____________________________________] 22.72% 12.10 MiB p/s ETA 6sd26.89 MiB / 106.97 MiB [----------->___________________________________] 25.14% 12.10 MiB p/s ETA 6sd29.69 MiB / 106.97 MiB [------------->_________________________________] 27.76% 12.10 MiB p/s ETA 6sd32.60 MiB / 106.97 MiB [-------------->________________________________] 30.48% 12.21 MiB p/s ETA 6sd35.37 MiB / 106.97 MiB [--------------->_______________________________] 33.06% 12.21 MiB p/s ETA 5sd38.18 MiB / 106.97 MiB [---------------->______________________________] 35.69% 12.21 MiB p/s ETA 5sd40.75 MiB / 106.97 MiB [----------------->_____________________________] 38.09% 12.30 MiB p/s ETA 5sd43.38 MiB / 106.97 MiB [------------------->___________________________] 40.55% 12.30 MiB p/s ETA 5sd45.88 MiB / 106.97 MiB [-------------------->__________________________] 42.89% 12.30 MiB p/s ETA 4sd48.50 MiB / 106.97 MiB [--------------------->_________________________] 45.34% 12.34 MiB p/s ETA 4sd51.42 MiB / 106.97 MiB [---------------------->________________________] 48.07% 12.34 MiB p/s ETA 4sd54.17 MiB / 106.97 MiB [----------------------->_______________________] 50.64% 12.34 MiB p/s ETA 4sd57.11 MiB / 106.97 MiB [------------------------->_____________________] 53.39% 12.47 MiB p/s ETA 3sd59.86 MiB / 106.97 MiB [-------------------------->____________________] 55.96% 12.47 MiB p/s ETA 3sd62.38 MiB / 106.97 MiB [--------------------------->___________________] 58.31% 12.47 MiB p/s ETA 3sd65.07 MiB / 106.97 MiB [---------------------------->__________________] 60.83% 12.52 MiB p/s ETA 3sd67.57 MiB / 106.97 MiB [----------------------------->_________________] 63.16% 12.52 MiB p/s ETA 3sd70.29 MiB / 106.97 MiB [------------------------------>________________] 65.71% 12.52 MiB p/s ETA 2sd73.14 MiB / 106.97 MiB [-------------------------------->______________] 68.37% 12.58 MiB p/s ETA 2sd75.79 MiB / 106.97 MiB [--------------------------------->_____________] 70.86% 12.58 MiB p/s ETA 2sd78.62 MiB / 106.97 MiB [---------------------------------->____________] 73.49% 12.58 MiB p/s ETA 2sd81.56 MiB / 106.97 MiB [----------------------------------->___________] 76.25% 12.67 MiB p/s ETA 2sd84.22 MiB / 106.97 MiB [------------------------------------->_________] 78.73% 12.67 MiB p/s ETA 1sd87.07 MiB / 106.97 MiB [-------------------------------------->________] 81.40% 12.67 MiB p/s ETA 1sd89.74 MiB / 106.97 MiB [--------------------------------------->_______] 83.89% 12.73 MiB p/s ETA 1sd92.47 MiB / 106.97 MiB [---------------------------------------->______] 86.44% 12.73 MiB p/s ETA 1sd95.03 MiB / 106.97 MiB [----------------------------------------->_____] 88.84% 12.73 MiB p/s ETA 0sd98.15 MiB / 106.97 MiB [------------------------------------------->___] 91.76% 12.82 MiB p/s ETA 0sd100.90 MiB / 106.97 MiB [------------------------------------------->__] 94.33% 12.82 MiB p/s ETA 0sd103.45 MiB / 106.97 MiB [-------------------------------------------->_] 96.71% 12.82 MiB p/s ETA 0sd106.23 MiB / 106.97 MiB [--------------------------------------------->] 99.31% 12.86 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 12.86 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 12.86 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 12.11 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 12.11 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 12.11 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 11.33 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 11.33 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 11.33 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 10.60 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 10.60 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [-------------------------------------------->] 100.00% 10.60 MiB p/s ETA 0sd106.97 MiB / 106.97 MiB [--------------------------------------------->] 100.00% 9.91 MiB p/s ETA 0s�106.97 MiB / 106.97 MiB [------------------------------------------------] 100.00% 10.34 MiB p/s 11s2026-08-14T20:11:41ZINFO[vulndb] Artifact successfully downloadedrepo="mirror.gcr.io/aquasec/trivy-db:2"
[2026-08-14T20:11:41.568Z] [TRIVY-SEC-SCAN] C2026-08-14T20:11:41ZINFO[vuln] Vulnerability scanning is enabled
[2026-08-14T20:11:41.902Z] [TRIVY-SEC-SCAN] t2026-08-14T20:11:41ZINFO[npm] Run "npm install" to collect the license information of packagesdir="node_modules"
[2026-08-14T20:11:41.930Z] [TRIVY-SEC-SCAN] 2026-08-14T20:11:41ZINFONumber of language-specific filesnum=1
[2026-08-14T20:11:41.941Z] [TRIVY-SEC-SCAN] �
[2026-08-14T20:11:41.941Z] [TRIVY-SEC-SCAN] - Version 0.74.0 of Trivy is now available, current version is 0.73.0
[2026-08-14T20:11:41.930Z] [TRIVY-SEC-SCAN] 2026-08-14T20:11:41ZINFO[npm] Detecting vulnerabilities...
[2026-08-14T20:11:41.941Z] [TRIVY-SEC-SCAN] To suppress version checks, run Trivy scans with the --skip-version-check flag
[2026-08-14T20:11:41.941Z] [TRIVY-SEC-SCAN] 📣 [34mNotices:[0m
[2026-08-14T20:11:41.930Z] [TRIVY-SEC-SCAN] 2026-08-14T20:11:41ZINFOSuppressing dependencies for development and testing. To display them, try the '--include-dev-deps' flag.
[2026-08-14T20:11:42.677Z] [SECURITY] Trivy: 8 container/library vulnerability findings.
[2026-08-14T20:11:42.677Z] Packaging build artifact ZIP...
[2026-08-14T20:11:42.675Z] Step Completed: TRIVY-SEC-SCAN
[2026-08-14T20:11:42.991Z] Launching live preview on port 3001...
[2026-08-14T20:11:42.990Z] Artifact ready at DevOps/artifacts/1be3b16b-17cd-4a11-9f9d-05f414d592c0-artifact.zip
[2026-08-14T20:11:42.991Z] Build pipeline completed successfully.
[2026-08-14T20:11:43.026Z] [PREVIEW] Spawning live preview in isolated container: devops-preview-1be3b16b-17cd-4a11-9f9d-05f414d592c0
[2026-08-14T20:11:43.199Z] [PREVIEW] Image: node:20-alpine
[2026-08-14T20:11:43.287Z] [PREVIEW] Using local cached image: node:20-alpine
[2026-08-14T20:11:43.391Z] Workspace retained for live preview process.
[PREVIEW] 🚀 Live app ready at http://localhost:3001
[2026-08-14T20:11:43.880Z] [APP] @
[2026-08-14T20:11:43.951Z] [APP] P◇ injected env (0) from .env // tip: ⌘ override existing { override: true }
[2026-08-14T20:11:43.880Z] [APP] > node src/index.js
[2026-08-14T20:11:43.880Z] [APP] > deadstock-management-server@1.0.0 start
[2026-08-14T20:12:30.274Z] [APP] 7🔧 Loading API routes...
[2026-08-14T20:12:30.274Z] [APP] 📋 Loading auth routes...
[2026-08-14T20:12:36.879Z] [APP] 📋 Loading deadstock routes...
[2026-08-14T20:12:36.879Z] [APP] 8✅ Auth routes loaded
[2026-08-14T20:12:37.481Z] [APP] 📋 Loading developer routes...
[2026-08-14T20:12:37.481Z] [APP] =✅ Deadstock routes loaded
[2026-08-14T20:12:37.878Z] [APP] 📋 Loading user routes...
[2026-08-14T20:12:37.878Z] [APP] 8✅ Developer routes loaded
[2026-08-14T20:12:38.009Z] [APP] @✅ Contact routes loaded
[2026-08-14T20:12:38.009Z] [APP] 📋 Loading support ticket routes...
[2026-08-14T20:12:37.934Z] [APP] ROUTES FILE LOADED
[2026-08-14T20:12:37.953Z] [APP] 📋 Loading notification routes...
[2026-08-14T20:12:37.952Z] [APP] A✅ Department routes loaded
[2026-08-14T20:12:37.936Z] [APP] 📋 Loading department routes...
[2026-08-14T20:12:37.936Z] [APP] 9✅ User routes loaded
[2026-08-14T20:12:38.068Z] [APP] 6✅ Item routes loaded
[2026-08-14T20:12:37.986Z] [APP] 📋 Loading contact routes...
[2026-08-14T20:12:38.113Z] [APP] RECORD ROUTES FILE LOADED
[2026-08-14T20:12:37.986Z] [APP] >✅ Notification routes loaded
[2026-08-14T20:12:38.025Z] [APP] !✅ Support ticket routes loaded
[2026-08-14T20:12:38.114Z] [APP] �❌ Error loading records routes: Missing parameter name at index 42: /department/:department/allocation-by-id/:0*; visit https://git.new/pathToRegexpError for info
[2026-08-14T20:12:38.134Z] [APP] ✅ Request routes loaded
[2026-08-14T20:12:38.134Z] [APP] 📋 Loading request routes...
[2026-08-14T20:12:38.133Z] [APP] �✅ Audit log routes loaded
[2026-08-14T20:12:38.134Z] [APP] 📋 Loading register request routes...
[2026-08-14T20:12:38.025Z] [APP] '📋 Loading password ticket routes...
[2026-08-14T20:12:38.050Z] [APP] >✅ Password ticket routes loaded
[2026-08-14T20:12:38.134Z] [APP] ✅ Upload routes loaded
[2026-08-14T20:12:38.134Z] [APP] 📋 Loading upload routes...
[2026-08-14T20:12:38.134Z] [APP] ✅ Register request routes loaded
[2026-08-14T20:12:38.050Z] [APP] 📋 Loading item routes...
[2026-08-14T20:12:38.141Z] [APP] <✅ Database routes loaded
[2026-08-14T20:12:38.158Z] [APP] 9✅ Analytics routes loaded
[2026-08-14T20:12:38.141Z] [APP] 📊 Loading analytics routes...
[2026-08-14T20:12:38.135Z] [APP] 📋 Loading database routes...
[2026-08-14T20:12:38.184Z] [APP] 4✅ Staff routes loaded
[2026-08-14T20:12:38.158Z] [APP] 📋 Loading staff routes...
[2026-08-14T20:12:38.196Z] [APP] 📋 Loading workflow routes...
[2026-08-14T20:12:38.184Z] [APP] 📋 Loading room routes...
[2026-08-14T20:12:38.195Z] [APP] 7✅ Room routes loaded
[2026-08-14T20:12:38.196Z] [APP] ✅ Workflow routes loaded
[2026-08-14T20:12:38.196Z] [APP] 📋 Loading dashboard routes...
[2026-08-14T20:12:38.196Z] [APP] A✅ Static uploads route loaded
[2026-08-14T20:12:38.215Z] [APP] aServer running on port 3001
[2026-08-14T20:12:38.214Z] [APP] ✅ Dashboard routes loaded
[2026-08-14T20:12:38.215Z] [APP] 🔧 Authentication system connected to deadstock-developer database
[2026-08-14T20:12:38.215Z] [APP] 9Connected to developer cloud database for authentication
[2026-08-14T20:12:38.215Z] [APP] =Developer database connection established for authentication
[2026-08-14T20:12:38.068Z] [APP] 📋 Loading records routes...
[2026-08-14T20:12:38.114Z] [APP] !📋 Loading audit log routes...
[2026-08-14T20:12:38.878Z] [APP] 2[DB] Connected to MongoDB (developer by default)!
[2026-08-14T20:12:38.923Z] [APP] at async executeOperationWithRetries (/workspace/node_modules/mongodb/lib/operations/execute_operation.js:193:32)
[2026-08-14T20:12:38.924Z] [APP] code: 8000,
[2026-08-14T20:12:38.923Z] [APP] ^
[2026-08-14T20:12:38.922Z] [APP] /workspace/node_modules/mongodb/lib/cmap/connection.js:320
[2026-08-14T20:12:38.923Z] [APP] at async Server.command (/workspace/node_modules/mongodb/lib/sdam/server.js:208:29)
[2026-08-14T20:12:38.923Z] [APP] throw new error_1.MongoServerError((object ??= document.toObject(bsonOptions)));
[2026-08-14T20:12:38.924Z] [APP] at async /workspace/node_modules/connect-mongo/dist/index.cjs:222:4 {
[2026-08-14T20:12:38.923Z] [APP] at Connection.sendCommand (/workspace/node_modules/mongodb/lib/cmap/connection.js:320:27)
[2026-08-14T20:12:38.924Z] [APP] errorLabelSet: Set(0) {},
[2026-08-14T20:12:38.924Z] [APP] errorResponse: {
[2026-08-14T20:12:38.924Z] [APP] at async Collection.createIndex (/workspace/node_modules/mongodb/lib/collection.js:373:25)
[2026-08-14T20:12:38.923Z] [APP] MongoServerError: cannot create a new collection -- already using 500 collections of 500
[2026-08-14T20:12:38.923Z] [APP] at async Connection.command (/workspace/node_modules/mongodb/lib/cmap/connection.js:347:26)
[2026-08-14T20:12:38.924Z] [APP] at async executeOperation (/workspace/node_modules/mongodb/lib/operations/execute_operation.js:83:16)
[2026-08-14T20:12:38.923Z] [APP] at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
[2026-08-14T20:12:38.924Z] [APP] ok: 0,
[2026-08-14T20:12:38.924Z] [APP] },
[2026-08-14T20:12:38.924Z] [APP] codeName: 'AtlasError'
[2026-08-14T20:12:38.924Z] [APP] Node.js v20.20.2
[2026-08-14T20:12:38.924Z] [APP] code: 8000,
[2026-08-14T20:12:38.965Z] [APP] �npm notice
[2026-08-14T20:12:38.965Z] [APP] npm notice New major version of npm available! 10.8.2 -> 12.0.2
[2026-08-14T20:12:38.924Z] [APP] codeName: 'AtlasError'
[2026-08-14T20:12:38.965Z] [APP] npm notice
[2026-08-14T20:12:38.924Z] [APP] }
[2026-08-14T20:12:38.965Z] [APP] npm notice To update run: npm install -g npm@12.0.2
[2026-08-14T20:12:38.965Z] [APP] npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
[2026-08-14T20:12:38.924Z] [APP] ok: 0,
[2026-08-14T20:12:38.924Z] [APP] errmsg: 'cannot create a new collection -- already using 500 collections of 500',
[2026-08-14T20:12:39.431Z] [PREVIEW] Preview container exited/stopped.