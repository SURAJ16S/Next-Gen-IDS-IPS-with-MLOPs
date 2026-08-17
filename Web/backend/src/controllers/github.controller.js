const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const axios  = require('axios');
const simpleGit = require('simple-git');

const User       = require('../models/User');
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
        // 2. Email exists but unlinked → prompt for password to link
        user = await User.findOne({ email });
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

    await User.findByIdAndUpdate(userId, {
      githubAccessToken: access_token,
      githubUsername,
    });

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
    const user = await User.findById(req.user._id).select('githubAccessToken githubUsername');
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
    const user = await User.findById(req.user._id).select('+githubAccessToken');
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
      await User.findByIdAndUpdate(req.user._id, { githubAccessToken: null, githubUsername: null });
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
    const user = await User.findById(req.user._id).select('+githubAccessToken');
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
    await User.findByIdAndUpdate(req.user._id, {
      githubAccessToken: null,
      githubUsername:    null,
    });
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
    const user = await User.findById(req.user._id).select('+githubAccessToken');
    if (!user.githubAccessToken) {
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
      await User.findByIdAndUpdate(req.user._id, { githubAccessToken: null, githubUsername: null });
      return res.status(401).json({ message: 'GitHub token expired. Please reconnect GitHub.' });
    }
    res.status(err.response?.status || 500).json({ message: err.response?.data?.message || err.message });
  }
};

// ─── 8. Get GitHub User Profile ───────────────────────────────────────────────
const getGithubUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+githubAccessToken');
    if (!user.githubAccessToken) {
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
      await User.findByIdAndUpdate(req.user._id, { githubAccessToken: null, githubUsername: null });
      return res.status(401).json({ message: 'GitHub session expired. Please reconnect.' });
    }
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
};
