const fs = require('fs');
const path = require('path');

const ENVM_TIMEOUT = 2000; // 2 seconds network timeout

/**
 * Checks if a version string represents a stable release (no qualifiers like alpha, beta, rc).
 */
const isStableVersion = (version) => {
  if (!version) return false;
  // Strip leading 'v' or whitespace
  const clean = version.replace(/^v/, '').trim();
  // If it contains letters (except leading v) or hyphens, it's considered unstable
  return !/[a-zA-Z\-]/.test(clean);
};

/**
 * Strips leading 'v' or spaces.
 */
const cleanVersion = (version) => {
  if (!version) return null;
  return version.replace(/^v/, '').trim();
};

/**
 * Compares two semver-like version strings.
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 */
const compareVersions = (v1, v2) => {
  const clean1 = v1.replace(/[^0-9.]/g, '').split('.').map(Number);
  const clean2 = v2.replace(/[^0-9.]/g, '').split('.').map(Number);
  
  for (let i = 0; i < Math.max(clean1.length, clean2.length); i++) {
    const num1 = clean1[i] || 0;
    const num2 = clean2[i] || 0;
    if (num1 > num2) return 1;
    if (num2 > num1) return -1;
  }
  return 0;
};

/**
 * Queries registry API with timeout.
 */
const fetchWithTimeout = async (url) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ENVM_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    clearTimeout(timeoutId);
    return null;
  }
};

/**
 * Fetches latest stable NPM package version.
 */
const getLatestNpmVersion = async (pkgName) => {
  const url = `https://registry.npmjs.org/${pkgName}`;
  const data = await fetchWithTimeout(url);
  if (!data) return null;
  
  // Use official dist-tag if available
  const latestTag = data['dist-tags']?.latest;
  if (latestTag && isStableVersion(latestTag)) {
    return cleanVersion(latestTag);
  }
  
  // Fallback: parse all versions
  if (data.versions) {
    let latestStable = null;
    for (const ver of Object.keys(data.versions)) {
      if (isStableVersion(ver)) {
        if (!latestStable || compareVersions(ver, latestStable) > 0) {
          latestStable = ver;
        }
      }
    }
    return cleanVersion(latestStable);
  }
  return null;
};

/**
 * Fetches latest stable Packagist (Composer) package version.
 */
const getLatestPackagistVersion = async (pkgName) => {
  // Packagist returns package details by name, e.g. laravel/framework
  const url = `https://packagist.org/packages/${pkgName}.json`;
  const data = await fetchWithTimeout(url);
  if (!data || !data.package || !data.package.versions) return null;
  
  let latestStable = null;
  for (const ver of Object.keys(data.package.versions)) {
    // Skip aliases like dev-master
    if (ver.startsWith('dev-') || ver.endsWith('-dev')) continue;
    if (isStableVersion(ver)) {
      if (!latestStable || compareVersions(ver, latestStable) > 0) {
        latestStable = ver;
      }
    }
  }
  return cleanVersion(latestStable);
};

/**
 * Fetches latest stable PyPI (Python) package version.
 */
const getLatestPyPiVersion = async (pkgName) => {
  const url = `https://pypi.org/pypi/${pkgName}/json`;
  const data = await fetchWithTimeout(url);
  if (!data || !data.info) return null;
  
  const current = data.info.version;
  if (current && isStableVersion(current)) {
    return cleanVersion(current);
  }
  
  // Fallback: scan all releases keys
  if (data.releases) {
    let latestStable = null;
    for (const ver of Object.keys(data.releases)) {
      if (isStableVersion(ver)) {
        if (!latestStable || compareVersions(ver, latestStable) > 0) {
          latestStable = ver;
        }
      }
    }
    return cleanVersion(latestStable);
  }
  return null;
};

/**
 * Main auditor function that scans the build workspace and checks outdated packages.
 */
const auditDependencies = async (workDir) => {
  const upgrades = [];
  
  // 1. Scan NPM (package.json)
  const pkgPath = path.join(workDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, rawVer] of Object.entries(deps)) {
        // Skip workspace protocols or local paths
        if (rawVer.startsWith('workspace:') || rawVer.startsWith('file:') || rawVer.startsWith('link:')) continue;
        const cleanVer = rawVer.replace(/[\^~>=<]/g, '').trim();
        const latest = await getLatestNpmVersion(name);
        if (latest && compareVersions(cleanVer, latest) < 0) {
          upgrades.push({
            manager: 'npm',
            package: name,
            current: cleanVer,
            latest: latest,
            status: 'outdated'
          });
        }
      }
    } catch (_) {}
  }

  // 2. Scan PHP (composer.json)
  const composerPath = path.join(workDir, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
      const deps = { ...composer.require, ...composer['require-dev'] };
      for (const [name, rawVer] of Object.entries(deps)) {
        if (name === 'php') continue;
        const cleanVer = rawVer.replace(/[\^~>=<]/g, '').trim();
        const latest = await getLatestPackagistVersion(name);
        if (latest && compareVersions(cleanVer, latest) < 0) {
          upgrades.push({
            manager: 'composer',
            package: name,
            current: cleanVer,
            latest: latest,
            status: 'outdated'
          });
        }
      }
    } catch (_) {}
  }

  // 3. Scan Python (requirements.txt)
  const reqsPath = path.join(workDir, 'requirements.txt');
  if (fs.existsSync(reqsPath)) {
    try {
      const lines = fs.readFileSync(reqsPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // Parse name==version or name>=version
        const match = trimmed.split(/==|>=|<=/);
        if (match.length >= 2) {
          const name = match[0].trim();
          const cleanVer = match[1].split(';')[0].trim(); // exclude marker
          const latest = await getLatestPyPiVersion(name);
          if (latest && compareVersions(cleanVer, latest) < 0) {
            upgrades.push({
              manager: 'pip',
              package: name,
              current: cleanVer,
              latest: latest,
              status: 'outdated'
            });
          }
        }
      }
    } catch (_) {}
  }

  return upgrades;
};

module.exports = {
  auditDependencies,
  isStableVersion,
  compareVersions
};
