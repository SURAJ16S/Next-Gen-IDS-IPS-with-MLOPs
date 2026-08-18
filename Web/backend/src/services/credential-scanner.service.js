const fs = require('fs');
const path = require('path');

const SECRETS_REGEXES = {
  // ==========================================
  // CLOUD PROVIDERS (AWS, GCP, Azure, etc.)
  // ==========================================
  'AWS Access Key ID': /AKIA[0-9A-Z]{16}/g,
  'AWS Secret Key': /(?:aws|secret|key|access|access_key|secret_key)\s*[:=]\s*["']?[A-Za-z0-9/\+=]{40}["']?/gi,
  'AWS Session Token': /(?:aws_session|session_token)\s*[:=]\s*["']?[A-Za-z0-9/+=]{16,}["']?/gi,
  'GCP API Key': /AIza[0-9A-Za-z\-_]{35}/g,
  'GCP OAuth Access Token': /ya29\.[a-zA-Z0-9\-_]+/g,
  'GCP Service Account Email': /[a-zA-Z0-9\-_]+@[a-zA-Z0-9\-_]+\.iam\.gserviceaccount\.com/g,
  'Azure Tenant ID': /(?:azure|tenant)(?:_id)?\s*[:=]\s*["']?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}["']?/gi,
  'Cloudflare R2 Access Key ID': /r2_(?:access_key_id|access_key|key_id)\s*[:=]\s*["']?[A-Za-z0-9]{20,40}["']?/gi,
  'Cloudflare R2 Secret Key': /r2_(?:secret_access_key|secret_key|secret)\s*[:=]\s*["']?[A-Za-z0-9/\+=]{40}["']?/gi,
  'Cloudflare API Token': /(?:cloudflare|cf_token)\s*[:=]\s*["']?[a-zA-Z0-9_-]{40}["']?/gi,
  'Cloudflare Global API Key': /[a-f0-9]{37}/g,
  'DigitalOcean PAT': /dop_v1_[a-f0-9]{64}/g,
  'Heroku API Key': /heroku\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']?/gi,
  'Vercel Token': /vercel_[a-zA-Z0-9]{24}/g,
  'Netlify PAT': /nfp_[a-zA-Z0-9]{39}/g,
  'Fastly API Token': /(?:fastly|fastly_token)\s*[:=]\s*["']?[a-zA-Z0-9_-]{32}["']?/gi,
  'Fastly Personal Token': /fastly-[a-zA-Z0-9\-_]{32}/g,
  'Linode PAT': /(?:linode|linode_token)\s*[:=]\s*["']?[a-f0-9]{64}["']?/gi,
  'IBM Cloud IAM Key': /bx[a-zA-Z0-9_-]{40,43}/g,
  'Render API Key': /rnd_[a-zA-Z0-9]{32}/g,
  'Railway Token': /(?:railway|railway_token)\s*[:=]\s*["']?[a-zA-Z0-9_-]{32}["']?/gi,
  'Fly.io Token': /flyv1_[a-zA-Z0-9_-]{43}/g,
  'Scaleway Token': /(?:scaleway|scw_token)\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']?/gi,
  'Doppler Token': /dp\.pt\.[a-zA-Z0-9]{43}/g,

  // ==========================================
  // INFRASTRUCTURE & DATABASES
  // ==========================================
  'S3 Access Key ID': /s3_(?:access_key_id|access_key|key_id)\s*[:=]\s*["']?[A-Za-z0-9]{20,40}["']?/gi,
  'S3 Secret Key': /s3_(?:secret_access_key|secret_key|secret)\s*[:=]\s*["']?[A-Za-z0-9/\+=]{40}["']?/gi,
  'MongoDB URI': /mongodb(?:\+srv)?:\/\/[a-zA-Z0-9_.-]+:[^@\s]+@[a-zA-Z0-9.-]+[a-zA-Z0-9\-_./?=&%]*/gi,
  'PostgreSQL URI': /postgres(?:ql)?:\/\/[a-zA-Z0-9_.-]+:[^@\s]+@[a-zA-Z0-9.-]+[a-zA-Z0-9\-_./?=&%]*/gi,
  'MySQL URI': /mysql:\/\/[a-zA-Z0-9_.-]+:[^@\s]+@[a-zA-Z0-9.-]+[a-zA-Z0-9\-_./?=&%]*/gi,
  'Redis URI': /redis:\/\/(?:[^:]+:[^@]+@)?[a-zA-Z0-9.-]+:[0-9]+/gi,
  'PlanetScale Password': /pscale_pw_[a-zA-Z0-9\-_]{43}/g,
  'Supabase Token': /sbp_[a-zA-Z0-9]{40}/g,
  'Supabase URL': /https:\/\/[a-z0-9]{20}\.supabase\.co/gi,
  'Neon Database Password': /(?:neon|neon_db)\s*[:=]\s*["']?[a-zA-Z0-9]{16,}["']?/gi,
  'Upstash Redis Token': /(?:upstash|upstash_token)\s*[:=]\s*["']?[a-zA-Z0-9\-_]{40,}["']?/gi,
  'Firebase URL': /https:\/\/[a-zA-Z0-9\-_]+\.firebaseio\.com/gi,
  'Terraform Cloud Token': /(?:terraform|tf_token)\s*[:=]\s*["']?[a-zA-Z0-9_]+\.[a-zA-Z0-9\-]+\.[a-zA-Z0-9\-]+["']?/gi,
  'Pulumi PAT': /pul-[a-f0-9]{40}/g,
  'HashiCorp Vault Token': /\b(?:s|hvs)\.[a-zA-Z0-9]{24,}\b/g,

  // ==========================================
  // CRYPTOGRAPHIC / PRIVATE KEYS
  // ==========================================
  'Generic Private Key': /-----BEGIN [A-Z ]+ PRIVATE KEY-----/g,
  'RSA Private Key': /-----BEGIN RSA PRIVATE KEY-----/g,
  'EC Private Key': /-----BEGIN EC PRIVATE KEY-----/g,
  'DSA Private Key': /-----BEGIN DSA PRIVATE KEY-----/g,
  'PGP Private Key': /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
  'OpenSSH Private Key': /-----BEGIN OPENSSH PRIVATE KEY-----/g,
  'PKCS8 Private Key': /-----BEGIN PRIVATE KEY-----/g,

  // ==========================================
  // VERSION CONTROL & CI/CD
  // ==========================================
  'GitHub Classic Token': /ghp_[a-zA-Z0-9]{36}/g,
  'GitHub Fine-Grained PAT': /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g,
  'GitHub OAuth Access Token': /gho_[a-zA-Z0-9]{36}/g,
  'GitHub App Token': /ghs_[a-zA-Z0-9]{36}/g,
  'GitHub Refresh Token': /ghr_[a-zA-Z0-9]{36}/g,
  'GitLab PAT': /glpat-[a-zA-Z0-9\-=_]{20}/g,
  'GitLab Pipeline Trigger Token': /glptt-[a-zA-Z0-9\-=_]{20}/g,
  'Bitbucket App Password': /(?:bitbucket|bb_token)\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}["']?/gi,
  'NPM Access Token': /npm_[a-zA-Z0-9]{36}/g,
  'PyPI API Token': /pypi-AgEIcHlwaS5vcmc[a-zA-Z0-9\-_]+/g,
  'RubyGems API Key': /(?:rubygems|gem_key)\s*[:=]\s*["']?[0-9a-f]{48}["']?/gi,
  'Docker Hub PAT': /dckr_pat_[a-zA-Z0-9_\-]{38}/g,
  'CircleCI PAT': /(?:circleci|circle_token)\s*[:=]\s*["']?[a-zA-Z0-9]{40}["']?/gi,
  'TravisCI Access Token': /(?:travis|travis_token)\s*[:=]\s*["']?[a-zA-Z0-9]{22}["']?/gi,
  'SonarQube Token': /sq[a-z]-[0-9a-f]{40}/g,
  'SonarCloud Token': /(?:sonarcloud|sonar_token)\s*[:=]\s*["']?[a-f0-9]{40}["']?/gi,
  'Codecov Token': /(?:codecov|codecov_token)\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']?/gi,
  'Snyk Token': /(?:snyk|snyk_token)\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']?/gi,

  // ==========================================
  // AI & MACHINE LEARNING
  // ==========================================
  'OpenAI API Key': /sk-(?:proj-)?[a-zA-Z0-9_-]{48,}/g,
  'Anthropic API Key': /sk-ant-api03-[a-zA-Z0-9\-_]{70,100}/g,
  'HuggingFace Token': /hf_[a-zA-Z]{34}/g,
  'Cohere API Key': /(?:cohere|cohere_api)\s*[:=]\s*["']?[a-zA-Z0-9]{40}["']?/gi,
  'Replicate API Key': /r8_[a-zA-Z0-9]{37}/g,
  'Pinecone API Key': /(?:pinecone|pinecone_api)\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']?/gi,
  'Mistral API Key': /(?:mistral|mistral_api)\s*[:=]\s*["']?[a-zA-Z0-9]{32}["']?/gi,
  'Weights & Biases API Key': /(?:wandb|wandb_api)\s*[:=]\s*["']?[a-f0-9]{40}["']?/gi,
  'LangSmith API Key': /lsv2_[pt]_[a-zA-Z0-9_-]{40,}/g,

  // ==========================================
  // MESSAGING & COMMUNICATION
  // ==========================================
  'Slack Generic Token': /xox[bapr]-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{24}/g,
  'Slack User Token': /xoxp-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{32}/g,
  'Slack Bot Token': /xoxb-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{24}/g,
  'Slack App-Level Token': /xapp-1-[0-9A-Z]{11}-[0-9A-Z]{11}-[a-zA-Z0-9]{64}/g,
  'Slack Webhook': /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9_]+\/B[A-Z0-9_]+\/[A-Za-z0-9_]+/g,
  'Discord Bot Token': /(?:M|N|O)[a-zA-Z0-9_-]{23,27}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,38}/g,
  'Discord Webhook': /https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[a-zA-Z0-9\-_]+/g,
  'Discord Client ID': /(?:discord|discord_client)\s*[:=]\s*["']?[0-9]{18,19}["']?/gi,
  'Twilio API Key': /SK[0-9a-fA-F]{32}/g,
  'Twilio Account SID': /AC[a-zA-Z0-9]{32}/g,
  'SendGrid API Key': /SG\.[a-zA-Z0-9_\-]{22}\.[a-zA-Z0-9_\-]{43}/g,
  'Mailchimp API Key': /[0-9a-f]{32}-us[0-9]{1,2}/g,
  'Mailgun API Key': /key-[0-9a-zA-Z]{32}/g,
  'Postmark API Token': /(?:postmark|postmark_api)\s*[:=]\s*["']?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}["']?/gi,
  'Telegram Bot Token': /[0-9]{8,10}:[a-zA-Z0-9_-]{35}/g,
  'WhatsApp API Token': /EA[a-zA-Z0-9]{10,}/g, // Facebook Graph API generic format

  // ==========================================
  // PAYMENTS & FINANCE
  // ==========================================
  'Stripe Live API Key': /sk_live_[0-9a-zA-Z]{24,34}/g,
  'Stripe Test API Key': /sk_test_[0-9a-zA-Z]{24,34}/g,
  'Stripe Restricted Key': /rk_(?:live|test)_[0-9a-zA-Z]{24,34}/g,
  'PayPal Braintree Access Token': /access_token\$production\$[a-zA-Z0-9]+\$[a-f0-9]{32}/g,
  'PayPal Client ID': /(?:paypal|paypal_client)\s*[:=]\s*["']?[a-zA-Z0-9]{80}["']?/gi,
  'Square Access Token': /sq0atp-[0-9A-Za-z\-_]{22}/g,
  'Square OAuth Secret': /sq0csp-[0-9A-Za-z\-_]{43}/g,
  'Razorpay Key ID': /rzp_(?:live|test)_[a-zA-Z0-9]{14}/g,
  'Plaid Client ID': /(?:plaid_client|plaid_id)\s*[:=]\s*["']?[a-f0-9]{24}["']?/gi,
  'Plaid Secret': /(?:plaid_secret|plaid_key)\s*[:=]\s*["']?[a-f0-9]{30}["']?/gi,

  // ==========================================
  // SOCIAL MEDIA, ANALYTICS & CMS
  // ==========================================
  'Twitter/X Bearer Token': /AAAAAAAAAAAAAAAAAAAAA[a-zA-Z0-9%_+]{40,}/g,
  'Twitter/X OAuth Token': /(?:twitter|tw_token)\s*[:=]\s*["']?[a-zA-Z0-9_-]{40,50}["']?/gi,
  'Facebook Access Token': /EAACEdEose0cBA[a-zA-Z0-9]+/g,
  'LinkedIn Client ID': /(?:linkedin|linkedin_client)\s*[:=]\s*["']?[a-z0-9]{14}["']?/gi,
  'LinkedIn Client Secret': /(?:linkedin|linkedin_secret)\s*[:=]\s*["']?[a-zA-Z0-9]{16}["']?/gi,
  'Contentful Delivery API': /(?:contentful|contentful_api)\s*[:=]\s*["']?[a-zA-Z0-9\-]{43}["']?/gi,
  'Sanity API Token': /(?:sanity|sanity_token)\s*[:=]\s*["']?sk[a-zA-Z0-9]{40,}["']?/gi,
  'Datadog Access Token': /(?:datadog|dd_token)\s*[:=]\s*["']?[a-f0-9]{32}["']?/gi,
  'New Relic Ingest Key': /NRAK-[A-Z0-9]{27}/g,
  'Sentry Token': /(?:sentry|sentry_token)\s*[:=]\s*["']?[a-f0-9]{64}["']?/gi,
  'Dynatrace Token': /dt0c01\.[a-zA-Z0-9]{24}\.[a-zA-Z0-9]{64}/g,

  // ==========================================
  // MISCELLANEOUS SAAS & UTILITIES
  // ==========================================
  'Notion API Key': /secret_[a-zA-Z0-9]{43}/g,
  'Airtable PAT': /pat[a-zA-Z0-9]{12}\.[a-f0-9]{64}/g,
  'Jira PAT': /(?:jira|jira_token)\s*[:=]\s*["']?[a-zA-Z0-9\-_]{40,}["']?/gi,
  'Zendesk API Token': /(?:zendesk|zendesk_api)\s*[:=]\s*["']?[a-zA-Z0-9]{40}["']?/gi,
  'HubSpot PAT': /pat-(?:na|eu)1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
  'Salesforce Access Token': /00D[a-zA-Z0-9]{12}!-[a-zA-Z0-9]{40,128}/g,
  'Shopify Access Token': /shpat_[a-fA-F0-9]{32}/g,
  'Shopify Custom App Token': /shpca_[a-fA-F0-9]{32}/g,
  'Algolia API Key': /(?:algolia|algolia_api)\s*[:=]\s*["']?[a-f0-9]{32}["']?/gi,
  'Mapbox API Key': /pk\.eyJ1Ijoi[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g,
  'Figma PAT': /figd_[a-zA-Z0-9\-_]{43}/g,
  'Frame.io Token': /fio-u-[a-zA-Z0-9\-_]{64}/g,
  'Asana PAT': /1\/\d+:[a-zA-Z0-9]{32}/g,
  'Auth0 Client ID': /(?:auth0|auth0_client_id)\s*[:=]\s*["']?[a-zA-Z0-9]{32}["']?/gi,
  'Auth0 Client Secret': /(?:auth0|auth0_client_secret)\s*[:=]\s*["']?[a-zA-Z0-9\-_]{64}["']?/gi,
  'Okta Token': /(?:okta|okta_token)\s*[:=]\s*["']?00[a-zA-Z0-9\-_]{40,}["']?/gi,
  'Yandex API Key': /AQVN[A-Za-z0-9_\-]{35}/g,
  'Bitly Access Token': /(?:bitly|bitly_token)\s*[:=]\s*["']?[a-f0-9]{40}["']?/gi,
  'Grafana API Token': /eyJrIjoi[a-zA-Z0-9\-_]+/g,
  'Vimeo Access Token': /(?:vimeo|vimeo_token)\s*[:=]\s*["']?[a-f0-9]{32}["']?/gi,
  'Typeform API Token': /tfp_[a-zA-Z0-9\-_]{43}/g,
  'Wakatime API Key': /(?:wakatime|wakatime_api)\s*[:=]\s*["']?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}["']?/gi,
  'Intercom PAT': /(?:intercom|intercom_token)\s*[:=]\s*["']?[a-zA-Z0-9=_-]{60}["']?/gi,
  'Pusher Auth Key': /(?:pusher|pusher_key)\s*[:=]\s*["']?[a-f0-9]{20}["']?/gi,
  'Prefect API Key': /pnu_[a-zA-Z0-9]{36}/g,
  'Linear API Key': /lin_api_[a-zA-Z0-9]{40}/g,
  
  // ==========================================
  // GENERIC CATCH-ALL
  // ==========================================
  'Generic Secret/Token': /(?:jwt_secret|api_key|apikey|auth_token|client_secret|client_key|client_password|db_password)\s*[:=]\s*["'](?![$.])([A-Za-z0-9_\-\.\+=!@#$%^&*()]{8,128})["']/gi
};

const walkDir = (dir, callback) => {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const baseName = path.basename(filePath);
      if (['node_modules', '.git', '.venv', 'venv', 'build', 'dist', 'target', '.security-reports'].includes(baseName)) {
        continue;
      }
      walkDir(filePath, callback);
    } else {
      callback(filePath);
    }
  }
};

const scanDirectoryForCredentials = (dir) => {
  const findings = [];
  walkDir(dir, (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath);
    
    // Skip .env files (credentials belong there)
    if (baseName.startsWith('.env')) {
      return;
    }
    
    // Skip package-lock.json, yarn.lock, pnpm-lock.yaml, and other lockfiles
    if (['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock'].includes(baseName)) {
      return;
    }
    
    // Only scan text files
    const textExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.properties', '.xml', '.yml', '.yaml', '.json', '.rs', '.go', '.html', '.css', '.txt'];
    if (!textExtensions.includes(ext)) {
      return;
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const [type, regex] of Object.entries(SECRETS_REGEXES)) {
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(line)) !== null) {
            const matchStr = match[0];
            // Filter out common environment variable references
            if (
              matchStr.includes('process.env') || 
              matchStr.includes('os.environ') || 
              matchStr.includes('System.getenv') || 
              matchStr.includes('config.') ||
              matchStr.includes('${')
            ) {
              continue;
            }
            
            // Mask the found secret
            const matchedVal = match[1] || matchStr;
            let maskedSecret = matchStr;
            if (matchedVal.length > 5) {
              const mask = matchedVal.substring(0, Math.min(3, matchedVal.length)) + '...[MASKED]';
              maskedSecret = matchStr.replace(matchedVal, mask);
            } else {
              maskedSecret = '[MASKED_SECRET]';
            }
            
            findings.push({
              file: path.relative(dir, filePath).replace(/\\/g, '/'),
              line: i + 1,
              type,
              match: maskedSecret,
              rawMatch: matchStr,
              rawSecret: matchedVal
            });
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning file for credentials: ${filePath}`, err);
    }
  });
  return findings;
};

const getReplacementString = (ext, varName) => {
  if (ext === '.py') {
    return `os.environ.get('${varName}')`;
  } else if (ext === '.java') {
    return `System.getenv("${varName}")`;
  } else if (ext === '.rs') {
    return `std::env::var("${varName}").unwrap_or_default()`;
  } else if (ext === '.properties' || ext === '.yml' || ext === '.yaml') {
    return `\${${varName}}`;
  } else if (ext === '.ts' || ext === '.tsx') {
    return `(process.env.${varName} as string)`;
  } else {
    // default to JS
    return `process.env.${varName}`;
  }
};

const autoRemediateCredentials = (dir, findings) => {
  const envToInject = {};
  if (!findings || findings.length === 0) return envToInject;

  // Group by file
  const fileMap = {};
  findings.forEach(f => {
    const fullPath = path.join(dir, f.file);
    if (!fileMap[fullPath]) fileMap[fullPath] = [];
    fileMap[fullPath].push(f);
  });

  let counter = 1;

  for (const [filePath, fileFindings] of Object.entries(fileMap)) {
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const ext = path.extname(filePath).toLowerCase();

    for (const finding of fileFindings) {
      const lineIdx = finding.line - 1;
      if (lineIdx < 0 || lineIdx >= lines.length) continue;
      
      let line = lines[lineIdx];
      const varName = `AUTO_SECRET_${counter++}`;
      envToInject[varName] = finding.rawSecret;
      const replacement = getReplacementString(ext, varName);

      // Try replacing with quotes first
      const doubleQuoted = `"${finding.rawMatch}"`;
      const singleQuoted = `'${finding.rawMatch}'`;
      const backticked = `\`${finding.rawMatch}\``;

      if (line.includes(doubleQuoted)) {
        line = line.replace(doubleQuoted, replacement);
      } else if (line.includes(singleQuoted)) {
        line = line.replace(singleQuoted, replacement);
      } else if (line.includes(backticked)) {
        line = line.replace(backticked, replacement);
      } else {
        line = line.replace(finding.rawMatch, replacement);
      }
      lines[lineIdx] = line;
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  }

  // Write or append these to the .env file in the directory
  const envPath = path.join(dir, '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent && !envContent.endsWith('\n')) {
      envContent += '\n';
    }
  }
  
  for (const [key, value] of Object.entries(envToInject)) {
    envContent += `${key}=${value}\n`;
  }
  
  fs.writeFileSync(envPath, envContent, 'utf8');
  return envToInject;
};

const scanContentForCredentials = (content, filename = '') => {
  const findings = [];
  const baseName = path.basename(filename);
  
  if (baseName.startsWith('.env')) {
    return findings;
  }
  
  if (['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock'].includes(baseName)) {
    return findings;
  }
  
  const ext = path.extname(filename).toLowerCase();
  const textExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.properties', '.xml', '.yml', '.yaml', '.json', '.rs', '.go', '.html', '.css', '.txt'];
  if (ext && !textExtensions.includes(ext)) {
    return findings;
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [type, regex] of Object.entries(SECRETS_REGEXES)) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(line)) !== null) {
        const matchStr = match[0];
        if (
          matchStr.includes('process.env') || 
          matchStr.includes('os.environ') || 
          matchStr.includes('System.getenv') || 
          matchStr.includes('config.') ||
          matchStr.includes('${')
        ) {
          continue;
        }
        
        const matchedVal = match[1] || matchStr;
        let maskedSecret = matchStr;
        if (matchedVal.length > 5) {
          const mask = matchedVal.substring(0, Math.min(3, matchedVal.length)) + '...[MASKED]';
          maskedSecret = matchStr.replace(matchedVal, mask);
        } else {
          maskedSecret = '[MASKED_SECRET]';
        }
        
        findings.push({
          line: i + 1,
          type,
          match: maskedSecret
        });
      }
    }
  }
  return findings;
};

module.exports = { scanDirectoryForCredentials, autoRemediateCredentials, scanContentForCredentials };

