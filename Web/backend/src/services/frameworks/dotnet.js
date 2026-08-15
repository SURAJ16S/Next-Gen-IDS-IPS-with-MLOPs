const fs = require('fs');
const path = require('path');

/**
 * ASP.NET Core Framework Plugin (.NET / C#)
 * Detects by presence of *.csproj, *.sln, or Program.cs + appsettings.json.
 * Build Image: mcr.microsoft.com/dotnet/sdk:8.0
 * Preview Image: mcr.microsoft.com/dotnet/aspnet:8.0
 * Build: dotnet publish -c Release -o /workspace/out
 * Preview: dotnet /workspace/out/<AppName>.dll
 */

/** Find the first .csproj file in the directory tree (shallow) */
const findCsproj = (dir) => {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.endsWith('.csproj')) return path.join(dir, f);
    }
    // Also check one level deep (common in solution layouts)
    for (const f of files) {
      const sub = path.join(dir, f);
      if (fs.statSync(sub).isDirectory()) {
        const inner = fs.readdirSync(sub).find(x => x.endsWith('.csproj'));
        if (inner) return path.join(sub, inner);
      }
    }
  } catch (_) {}
  return null;
};

/** Extract the assembly name from a .csproj file */
const getAssemblyName = (csprojPath) => {
  try {
    const content = fs.readFileSync(csprojPath, 'utf8');
    const match = content.match(/<AssemblyName>([^<]+)<\/AssemblyName>/);
    if (match) return match[1].trim();
    // Fall back to filename without extension
    return path.basename(csprojPath, '.csproj');
  } catch (_) {}
  return null;
};

module.exports = {
  id: 'dotnet',
  detect: (targetDir) => {
    try {
      // Primary: .csproj or .sln present
      if (findCsproj(targetDir)) return true;
      if (fs.readdirSync(targetDir).some(f => f.endsWith('.sln'))) return true;
      // Secondary: Program.cs + appsettings.json (minimal API style)
      if (
        fs.existsSync(path.join(targetDir, 'Program.cs')) &&
        fs.existsSync(path.join(targetDir, 'appsettings.json'))
      ) return true;
    } catch (_) {}
    return false;
  },
  buildImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
  previewImage: 'mcr.microsoft.com/dotnet/aspnet:8.0',
  runCommand: 'dotnet publish -c Release -o /workspace/out',
  getPreviewCommand: (workDir) => {
    // Find the published DLL by looking inside /workspace/out
    const outDir = path.join(workDir, 'out');
    if (fs.existsSync(outDir)) {
      const dlls = fs.readdirSync(outDir).filter(f => f.endsWith('.dll') && !f.startsWith('System.') && !f.startsWith('Microsoft.'));
      if (dlls.length > 0) {
        return {
          cmd: 'dotnet',
          args: [`out/${dlls[0]}`],
          env: { ASPNETCORE_URLS: 'http://0.0.0.0:${PORT:-8080}', ASPNETCORE_ENVIRONMENT: 'Production' }
        };
      }
    }
    // Fallback: find the csproj and run dotnet run
    return {
      cmd: 'dotnet',
      args: ['run', '--urls', 'http://0.0.0.0:${PORT:-8080}'],
      env: { ASPNETCORE_ENVIRONMENT: 'Production' }
    };
  },
  getConfig: (targetDir) => {
    const csproj = findCsproj(targetDir);
    let csprojArg = '';
    if (csproj) {
      const rel = path.relative(targetDir, csproj);
      csprojArg = ` "${rel}"`;
    }
    return {
      buildImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
      previewImage: 'mcr.microsoft.com/dotnet/aspnet:8.0',
      runCommand: `dotnet restore${csprojArg} && dotnet publish${csprojArg} -c Release -o /workspace/out`
    };
  },
  detectGui: (targetDir) => {
    try {
      const csproj = findCsproj(targetDir);
      if (csproj) {
        const content = fs.readFileSync(csproj, 'utf8');
        const isDesktop = content.includes('WinForms') || content.includes('WPF') || content.includes('WindowsForms');
        const isWeb = content.includes('Microsoft.NET.Sdk.Web') || content.includes('Microsoft.NET.Sdk.Razor') || content.includes('Microsoft.AspNetCore');
        // If it's a desktop app OR if it's not a web application (e.g. console/class library)
        return isDesktop || !isWeb;
      }
    } catch (_) {}
    return false;
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
