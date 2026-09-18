const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const axios  = require('axios');
const simpleGit = require('simple-git');

const User       = require('../models/User');
const Admin      = require('../models/Admin');

const findUserOrAdminById = async (id) => {
  let doc = await User.findById(id);
  if (!doc) {
    doc = await Admin.findById(id);
  }
  return doc;
};
const Deployment = require('../models/Deployment');
const jwt        = require('jsonwebtoken');
const { runPipeline }  = require('../services/pipeline-runner.service');
const { suggestPort }  = require('../services/process-manager.service');

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_CALLBACK_URL,
  FRONTEND_URL,
  JWT_SECRET,
} = process.env;

// ─── Helper: package a directory into a zip ───────────────────────────────────
const archiver = require('archiver');

const zipDirectory = (sourceDir, outPath) =>
  new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(outPath));
    archive.on('error', reject);
    archive.pipe(output);
    archive.glob('**/*', {
      cwd: sourceDir,
      ignore: ['node_modules/**', '.git/**', 'target/**', 'build/**', 'dist/**'],
    });
    archive.finalize();
  });

// ─── 1. Return the GitHub OAuth authorization URL ─────────────────────────────
const getGithubAuthUrl = (req, res) => {
  // Embed the user's JWT into `state` so we can re-identify them in the callback
  const userJwt = req.headers.authorization?.split(' ')[1] || '';
  // Encode both the action and the user's JWT inside state
  const state = jwt.sign({ action: 'devops_link', id_token: userJwt }, JWT_SECRET, { expiresIn: '15m' });
  const params = new URLSearchParams({
    client_id:    GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK_URL,
    scope:        'repo read:user user:email',
    state,
    allow_signup: 'false',
    // Force GitHub account selector so user can switch accounts
    prompt:       'select_account',
  });
  res.json({ url: `https://github.com/login/oauth/authorize?${params}` });
};

// ─── 2. OAuth Callback (public) ───────────────────────────────────────────────
const githubOAuthCallback = async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    const isLogin = (() => { try { return jwt.verify(state, JWT_SECRET)?.action === 'login'; } catch (_) { return false; } })();
    return res.redirect(isLogin
      ? `${FRONTEND_URL}/login?error=github_denied`
      : `${FRONTEND_URL}/devops?github=denied`
    );
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/devops?github=error&msg=no_code`);
  }

  try {
    // Exchange code → access_token (only once, regardless of flow)
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_CALLBACK_URL },
      { headers: { Accept: 'application/json' } }
    );

    const { access_token, error: ghError } = tokenRes.data;
    if (ghError || !access_token) {
      return res.redirect(`${FRONTEND_URL}/devops?github=error&msg=token_exchange_failed`);
    }

    // Get GitHub user info (needed by both flows)
    const ghUserRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'IDPS-DevOps' },
    });
    const ghUser = ghUserRes.data;
    const githubUsername = ghUser.login;

    // Decode state JWT
    let decoded;
    try {
      decoded = jwt.verify(state, JWT_SECRET);
    } catch (_) {
      return res.redirect(`${FRONTEND_URL}/devops?github=error&msg=invalid_state`);
    }

    // ── LOGIN FLOW ─────────────────────────────────────────────────────────────
    if (decoded.action === 'login') {
      const crypto = require('crypto');

      // Fetch verified email from GitHub
      let email = ghUser.email;
      if (!email) {
        try {
          const emailsRes = await axios.get('https://api.github.com/user/emails', {
            headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'IDPS-Auth' },
          });
          const primary = emailsRes.data.find(e => e.primary && e.verified);
          if (primary) email = primary.email;
        } catch (_) {}
      }
      if (!email) email = `${githubUsername}@github.com`;

      // 1. Already linked by githubUsername → log in directly
      let user = await User.findOne({ githubUsername });
      if (!user) {
        user = await Admin.findOne({ githubUsername });
      }

      if (!user) {
        // 2. Email exists but unlinked → prompt for password to link
        user = await User.findOne({ email });
        if (!user) {
          user = await Admin.findOne({ email });
        }
        if (user) {
          const linkToken = jwt.sign(
            { email, githubUsername, githubAccessToken: access_token },
            JWT_SECRET,
            { expiresIn: '15m' }
          );
          return res.redirect(
            `${FRONTEND_URL}/login?action=link_github` +
            `&email=${encodeURIComponent(email)}` +
            `&githubUsername=${encodeURIComponent(githubUsername)}` +
            `&linkToken=${linkToken}`
          );
        }

        // 3. Completely new user → prefill register form
        const nameParts = (ghUser.name || githubUsername).split(' ');
        const firstName = nameParts[0] || githubUsername;
        const lastName  = nameParts.slice(1).join(' ') || ' ';
        const githubRegToken = jwt.sign(
          { email, githubUsername, githubAccessToken: access_token },
          JWT_SECRET,
          { expiresIn: '15m' }
        );
        return res.redirect(
          `${FRONTEND_URL}/register?action=github_signup` +
          `&email=${encodeURIComponent(email)}` +
          `&githubUsername=${encodeURIComponent(githubUsername)}` +
          `&firstName=${encodeURIComponent(firstName)}` +
          `&lastName=${encodeURIComponent(lastName)}` +
          `&githubRegToken=${githubRegToken}`
        );
      }

      // Already linked — refresh the token
      user.githubAccessToken = access_token;
      await user.save();

      const loginToken = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
      const userJSON = encodeURIComponent(JSON.stringify({
        _id:       user._id,
        firstName: user.firstName,
        lastName:  user.lastName,
        username:  user.username,
        email:     user.email,
        role:      user.role,
      }));
      return res.redirect(`${FRONTEND_URL}/login?token=${loginToken}&user=${userJSON}`);
    }

    // ── DEVOPS LINK FLOW ───────────────────────────────────────────────────────
    // Decode the nested user JWT to extract userId
    let userId;
    try {
      const userDecoded = jwt.verify(decoded.id_token, JWT_SECRET);
      userId = userDecoded.id;
    } catch (_) {
      // Legacy: state was the raw JWT (id field directly)
      userId = decoded.id;
    }

    if (!userId) {
      return res.redirect(`${FRONTEND_URL}/devops?github=error&msg=invalid_state`);
    }

    let userDoc = await User.findById(userId);
    if (!userDoc) {
      userDoc = await Admin.findById(userId);
    }
    if (userDoc) {
      userDoc.githubAccessToken = access_token;
      userDoc.githubUsername = githubUsername;
      await userDoc.save();
    }

    // Redirect to popup relay page — it will postMessage to opener then self-close
    res.redirect(`${FRONTEND_URL}/github-callback?result=linked&username=${encodeURIComponent(githubUsername)}`);
  } catch (err) {
    console.error('GitHub OAuth callback error:', err.message);
    res.redirect(`${FRONTEND_URL}/github-callback?result=error`);
  }
};

// ─── 3. Get status (is GitHub linked?) ───────────────────────────────────────
const getGithubStatus = async (req, res) => {
  try {
    const user = await findUserOrAdminById(req.user._id);
    res.json({
      linked: !!user.githubAccessToken,
      githubUsername: user.githubUsername || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── 4. List repos ────────────────────────────────────────────────────────────
const getGithubRepos = async (req, res) => {
  try {
    const user = await findUserOrAdminById(req.user._id);
    if (!user.githubAccessToken) {
      return res.status(401).json({ message: 'GitHub not linked. Please connect GitHub first.' });
    }

    // Fetch up to 100 repos sorted by last-pushed
    const reposRes = await axios.get('https://api.github.com/user/repos', {
      headers: {
        Authorization: `Bearer ${user.githubAccessToken}`,
        'User-Agent': 'IDPS-DevOps',
        Accept: 'application/vnd.github.v3+json',
      },
      params: { per_page: 100, sort: 'pushed', direction: 'desc' },
    });

    const repos = reposRes.data.map(r => ({
      id:          r.id,
      name:        r.name,
      fullName:    r.full_name,
      description: r.description,
      language:    r.language,
      private:     r.private,
      defaultBranch: r.default_branch,
      updatedAt:   r.pushed_at,
      url:         r.html_url,
      stars:       r.stargazers_count,
    }));

    res.json(repos);
  } catch (err) {
    if (err.response?.status === 401) {
      // Token revoked — clear it
      const Model = (req.user.role === 'admin' || req.user.role === 'superadmin') ? Admin : User;
      await Model.findByIdAndUpdate(req.user._id, { githubAccessToken: null, githubUsername: null });
      return res.status(401).json({ message: 'GitHub token expired. Please reconnect GitHub.' });
    }
    res.status(500).json({ message: err.message });
  }
};

// ─── 5. Import a repo (clone → zip → pipeline) ───────────────────────────────
const importGithubRepo = async (req, res) => {
  const { repoFullName, branch = 'main', projectName, previewPort: rawPort, sessionId = '', envFiles: rawEnv = '[]', targetSubfolder = '', upgradeMode = 'automatic', useTempDb = true, dbInitScript = '', dbInitType = 'none', enableSmartSeeding = false } = req.body;

  if (!repoFullName) {
    return res.status(400).json({ message: 'repoFullName is required.' });
  }

  try {
    const user = await findUserOrAdminById(req.user._id);
    if (!user.githubAccessToken) {
      return res.status(401).json({ message: 'GitHub not linked.' });
    }

    // Resolve port
    let previewPort = parseInt(rawPort, 10);
    if (!previewPort || previewPort < 1024 || previewPort > 65535) {
      previewPort = (await suggestPort()) || 3001;
    }

    // Parse env files
    let envFiles = [];
    try { envFiles = JSON.parse(rawEnv); if (!Array.isArray(envFiles)) envFiles = []; } catch (_) {}

    const jobId    = crypto.randomUUID();
    const name     = projectName || repoFullName.split('/')[1];
    const cloneDir = path.join(os.tmpdir(), `gh-clone-${jobId}`);
    const zipPath  = path.join(os.tmpdir(), `gh-zip-${jobId}.zip`);

    // Fetch collaborators from GitHub
    let collaborators = [];
    try {
      const [repoOwner, repoName] = repoFullName.split('/');
      const collabsRes = await axios.get(`https://api.github.com/repos/${repoOwner}/${repoName}/collaborators`, {
        headers: {
          Authorization: `Bearer ${user.githubAccessToken}`,
          'User-Agent': 'IDPS-DevOps',
          Accept: 'application/vnd.github.v3+json',
        }
      });
      if (Array.isArray(collabsRes.data)) {
        collaborators = collabsRes.data.map(c => c.login);
      }
      console.log(`Fetched collaborators for ${repoFullName}:`, collaborators);
    } catch (err) {
      console.warn(`[GitHub Import] Could not fetch collaborators for ${repoFullName}:`, err.message);
      // Fallback: add the importer username itself
      if (user.githubUsername) {
        collaborators = [user.githubUsername];
      }
    }

    // Create deployment record immediately so frontend gets jobId
    const deployment = await Deployment.create({
      projectName:   name,
      status:        'pending',
      jobId,
      deployedBy:    req.user._id,
      sessionId,
      previewPort,
      previewStatus: 'none',
      envFiles,
      targetSubfolder,
      upgradeMode,
      useTempDb: useTempDb === true || useTempDb === 'true',
      dbInitScript,
      dbInitType,
      enableSmartSeeding: enableSmartSeeding === true || enableSmartSeeding === 'true',
      deploymentType: 'github',
      githubRepo: repoFullName,
      collaborators,
      githubPermissions: {
        allowCollaboratorVisibility: true,
        allowCollaboratorBuild: false,
        allowCollaboratorChat: false
      }
    });

    res.status(202).json({
      message: 'GitHub import accepted. Cloning & pipeline starting.',
      jobId,
      deploymentId: deployment._id,
      previewPort,
    });

    // ── Background: clone → zip → pipeline ──────────────────────────────────
    (async () => {
      try {
        const cloneUrl = `https://x-access-token:${user.githubAccessToken}@github.com/${repoFullName}.git`;
        fs.mkdirSync(cloneDir, { recursive: true });

        const git = simpleGit();
        await git.clone(cloneUrl, cloneDir, ['--depth=1', '--branch', branch, '--single-branch']);

        await zipDirectory(cloneDir, zipPath);

        // Kick off the existing pipeline with the zipped clone
        runPipeline(jobId, deployment._id, zipPath, previewPort, envFiles, targetSubfolder, upgradeMode);
      } catch (cloneErr) {
        console.error('[GitHub Import] Clone/zip error:', cloneErr.message);
        try {
          const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
          const logDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', jobId);
          if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
          fs.writeFileSync(path.join(logDir, 'pipeline.log'), `[${new Date().toISOString()}] GitHub clone failed: ${cloneErr.message}\n`, 'utf8');
        } catch (_) {}
        await Deployment.findByIdAndUpdate(deployment._id, {
          status: 'failed',
        });
        // Cleanup
        if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true });
        if (fs.existsSync(zipPath))  fs.unlinkSync(zipPath);
      }
    })();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── 6. Unlink GitHub ─────────────────────────────────────────────────────────
const unlinkGithub = async (req, res) => {
  try {
    const user = await findUserOrAdminById(req.user._id);
    if (user) {
      user.githubAccessToken = null;
      user.githubUsername = null;
      await user.save();
    }
    // Also clear both collections just in case
    await User.findByIdAndUpdate(req.user._id, { githubAccessToken: null, githubUsername: null });
    await Admin.findByIdAndUpdate(req.user._id, { githubAccessToken: null, githubUsername: null });
    res.json({ message: 'GitHub account unlinked successfully.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── 7. Get Repo Branches ─────────────────────────────────────────────────────
const getGithubBranches = async (req, res) => {
  const { owner, repo } = req.params;
  if (!owner || !repo) {
    return res.status(400).json({ message: 'Owner and Repo params are required.' });
  }

  try {
    const user = await findUserOrAdminById(req.user._id);
    if (!user || !user.githubAccessToken) {
      return res.status(401).json({ message: 'GitHub not linked.' });
    }

    const branchesRes = await axios.get(`https://api.github.com/repos/${owner}/${repo}/branches`, {
      headers: {
        Authorization: `Bearer ${user.githubAccessToken}`,
        'User-Agent': 'IDPS-DevOps',
        Accept: 'application/vnd.github.v3+json',
      },
      params: { per_page: 100 },
    });

    const branches = branchesRes.data.map(b => ({
      name: b.name,
      protected: b.protected,
    }));

    res.json(branches);
  } catch (err) {
    if (err.response?.status === 401) {
      const user = await findUserOrAdminById(req.user._id);
      if (user) {
        user.githubAccessToken = null;
        user.githubUsername = null;
        await user.save();
      }
      return res.status(401).json({ message: 'GitHub token expired. Please reconnect GitHub.' });
    }
    res.status(err.response?.status || 500).json({ message: err.response?.data?.message || err.message });
  }
};

// ─── 8. Get GitHub User Profile ───────────────────────────────────────────────
const getGithubUserProfile = async (req, res) => {
  try {
    const user = await findUserOrAdminById(req.user._id);
    if (!user || !user.githubAccessToken) {
      return res.status(400).json({ message: 'GitHub not linked.' });
    }

    const profileRes = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${user.githubAccessToken}`,
        'User-Agent': 'IDPS-DevOps',
      },
    });

    const reposRes = await axios.get('https://api.github.com/user/repos', {
      headers: {
        Authorization: `Bearer ${user.githubAccessToken}`,
        'User-Agent': 'IDPS-DevOps',
      },
      params: { per_page: 100, sort: 'updated' }, // Increased to 100 to show more repos!
    });

    // Fetch GraphQL calendar
    const graphqlQuery = `
      query($username: String!) {
        user(login: $username) {
          contributionsCollection {
            contributionCalendar {
              totalContributions
              weeks {
                contributionDays {
                  contributionCount
                  date
                  color
                }
              }
            }
          }
        }
      }
    `;

    let calendar = null;
    try {
      const gqlRes = await axios.post(
        'https://api.github.com/graphql',
        { query: graphqlQuery, variables: { username: user.githubUsername || profileRes.data.login } },
        {
          headers: {
            Authorization: `Bearer ${user.githubAccessToken}`,
            'User-Agent': 'IDPS-DevOps',
          }
        }
      );
      calendar = gqlRes.data?.data?.user?.contributionsCollection?.contributionCalendar || null;
    } catch (gqlErr) {
      console.error('Failed to fetch GitHub GraphQL calendar:', gqlErr.message);
    }

    res.json({
      profile: profileRes.data,
      calendar,
      repos: reposRes.data.map(r => ({
        name: r.name,
        fullName: r.full_name,
        description: r.description,
        url: r.html_url,
        stars: r.stargazers_count,
        language: r.language,
        private: r.private,
      })),
    });
  } catch (err) {
    if (err.response?.status === 401) {
      const user = await findUserOrAdminById(req.user._id);
      if (user) {
        user.githubAccessToken = null;
        user.githubUsername = null;
        await user.save();
      }
      return res.status(401).json({ message: 'GitHub session expired. Please reconnect.' });
    }
    res.status(500).json({ message: err.message });
  }
};

// ─── 9. Publish workspace files to a new GitHub branch ───────────────────────
const publishBranchToGithub = async (req, res) => {
  const { id } = req.params;
  let { branchName, repoFullName: bodyRepo } = req.body;

  try {
    const deployment = await Deployment.findById(id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found.' });

    // Owner-only gate
    if (!deployment.deployedBy || deployment.deployedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only the deployment owner can publish to GitHub.' });
    }

    // Limit check (max 3 branches)
    if (deployment.publishedBranches && deployment.publishedBranches.length >= 3) {
      return res.status(400).json({ message: 'This build has already been published to the maximum limit of 3 branches.' });
    }

    const user = await findUserOrAdminById(req.user._id);
    if (!user?.githubAccessToken) {
      return res.status(401).json({ message: 'GitHub not linked. Please reconnect GitHub.' });
    }

    // Resolve target repo: GitHub-imported builds use their linked repo; ZIP builds need repoFullName from body
    const targetRepo = deployment.githubRepo || bodyRepo;
    if (!targetRepo) {
      return res.status(400).json({ message: 'No GitHub repository linked. Please provide a target repository.' });
    }

    const token = user.githubAccessToken;
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'IDPS-DevOps',
      Accept: 'application/vnd.github.v3+json',
    };
    const [repoOwner, repoName] = targetRepo.split('/');


    // ── Resolve workspace path ────────────────────────────────────────────────
    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const workspaceRoot = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
    if (!fs.existsSync(workspaceRoot)) {
      return res.status(404).json({ message: 'Build workspace not found on disk. Has the build been cleaned up?' });
    }

    // ── Parse .gitignore if present ───────────────────────────────────────────
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const ignorePatterns = [];
    if (fs.existsSync(gitignorePath)) {
      const lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) ignorePatterns.push(trimmed);
      }
    }

    // Simple glob-to-regex for basic .gitignore patterns
    const isIgnored = (relPath) => {
      const name = path.basename(relPath);
      // Always exclude these system, dependency, virtualenv, and build directories
      const alwaysExclude = [
        'node_modules', '.git', 'dist', 'build', '__pycache__', '.env', '*.env',
        '.venv', 'venv', 'env', 'target', 'bin', 'obj', '.gradle', '.cache',
        '.next', 'out', '.nuxt', '.gitattributes', '.gitignore_global', '.DS_Store', 'Thumbs.db'
      ];
      for (const ex of alwaysExclude) {
        if (ex.startsWith('*.')) {
          if (name.endsWith(ex.slice(1))) return true;
        } else if (relPath.split('/').includes(ex) || relPath === ex) return true;
      }
      // .env files (any .env.* or *.env)
      if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return true;
      // Check .gitignore patterns
      for (const pattern of ignorePatterns) {
        try {
          const p = pattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
          const re = new RegExp(`(^|/)${p}(/|$)`);
          if (re.test(relPath)) return true;
        } catch (_) {}
      }
      return false;
    };

    // ── Collect all files recursively ────────────────────────────────────────
    const allFiles = [];
    const walk = (dir, rel = '') => {
      if (!fs.existsSync(dir)) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (err) {
        console.warn(`[Publish walk] Cannot read directory ${dir}: ${err.message}`);
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relPath = rel ? `${rel}/${entry}` : entry;
        if (isIgnored(relPath)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, relPath);
          } else {
            // Skip very large files (> 1MB) — GitHub API limit per file is ~50MB encoded
            if (stat.size <= 1_000_000) {
              allFiles.push({ fullPath, relPath });
            }
          }
        } catch (err) {
          console.warn(`[Publish walk] Cannot stat ${fullPath}: ${err.message}`);
        }
      }
    };
    walk(workspaceRoot);

    if (allFiles.length === 0) {
      return res.status(400).json({ message: 'No publishable files found in workspace.' });
    }

    // ── Get HEAD SHA of default branch ───────────────────────────────────────
    let headSha;
    try {
      const repoRes = await axios.get(`https://api.github.com/repos/${repoOwner}/${repoName}`, { headers });
      const defaultBranch = repoRes.data.default_branch || 'main';
      const refRes = await axios.get(
        `https://api.github.com/repos/${repoOwner}/${repoName}/git/ref/heads/${defaultBranch}`,
        { headers }
      );
      headSha = refRes.data.object.sha;
    } catch (err) {
      return res.status(502).json({ message: `Failed to get repository HEAD: ${err.response?.data?.message || err.message}` });
    }

    // ── Ensure branch name is unique ─────────────────────────────────────────
    if (!branchName || !branchName.trim()) {
      const today = new Date().toISOString().slice(0, 10);
      branchName = `ids-ips-build-${today}`;
    }
    branchName = branchName.trim().replace(/[^a-zA-Z0-9._\-/]/g, '-');

    try {
      await axios.get(
        `https://api.github.com/repos/${repoOwner}/${repoName}/git/ref/heads/${branchName}`,
        { headers }
      );
      // Branch already exists → append timestamp
      branchName = `${branchName}-${Date.now()}`;
    } catch (e) {
      if (e.response?.status !== 404) {
        return res.status(502).json({ message: `GitHub API error checking branch: ${e.response?.data?.message || e.message}` });
      }
      // 404 = branch does not exist — good, proceed
    }

    // ── Create the new branch ────────────────────────────────────────────────
    await axios.post(
      `https://api.github.com/repos/${repoOwner}/${repoName}/git/refs`,
      { ref: `refs/heads/${branchName}`, sha: headSha },
      { headers }
    );

    // ── Push files sequentially ──────────────────────────────────────────────
    let fileCount = 0;
    for (const { fullPath, relPath } of allFiles) {
      try {
        const content = fs.readFileSync(fullPath);
        const b64 = content.toString('base64');

        // Check if file already exists on the new branch (to get its SHA for update)
        let existingSha;
        try {
          const existing = await axios.get(
            `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${relPath}?ref=${branchName}`,
            { headers }
          );
          existingSha = existing.data.sha;
        } catch (_) { /* new file */ }

        const body = {
          message: `IDS-IPS DevOps: publish build to ${branchName}`,
          content: b64,
          branch: branchName,
        };
        if (existingSha) body.sha = existingSha;

        await axios.put(
          `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${relPath}`,
          body,
          { headers }
        );
        fileCount++;
      } catch (fileErr) {
        console.warn(`[Publish] Skipped ${relPath}: ${fileErr.response?.data?.message || fileErr.message}`);
      }
    }

    const branchUrl = `https://github.com/${repoOwner}/${repoName}/tree/${branchName}`;

    // Save branch metadata to database
    deployment.publishedBranches = deployment.publishedBranches || [];
    deployment.publishedBranches.push({
      branchName,
      branchUrl,
      repoFullName: targetRepo,
      publishedAt: new Date()
    });
    await deployment.save();

    res.json({
      message: 'Branch published successfully.',
      branchName,
      branchUrl,
      fileCount,
      repoFullName: targetRepo,
      publishedBranches: deployment.publishedBranches, // return updated list
    });
  } catch (err) {
    console.error('[Publish Branch] Error:', err.message);
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getGithubAuthUrl,
  githubOAuthCallback,
  getGithubStatus,
  getGithubRepos,
  importGithubRepo,
  unlinkGithub,
  getGithubBranches,
  getGithubUserProfile,
  publishBranchToGithub,
};
