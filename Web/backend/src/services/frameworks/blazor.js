const fs = require('fs');
const path = require('path');

/**
 * Blazor Framework Plugin (.NET / C# WebAssembly or Server)
 * Detects Blazor by *.csproj referencing BlazorWebAssembly SDK or Microsoft.AspNetCore.Components.WebAssembly.
 * Must be registered BEFORE the generic dotnet plugin.
 * Build Image: mcr.microsoft.com/dotnet/sdk:8.0
 * Preview Image: mcr.microsoft.com/dotnet/aspnet:8.0
 */

const BLAZOR_MARKERS = [
  'Microsoft.NET.Sdk.BlazorWebAssembly',
  'Microsoft.AspNetCore.Components.WebAssembly',
  'BlazorWebAssembly',
  'Microsoft.NET.Sdk.Razor'
];

const findCsproj = (dir) => {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.endsWith('.csproj')) return path.join(dir, f);
    }
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

const isBlazorProject = (targetDir) => {
  const csproj = findCsproj(targetDir);
  if (!csproj) return false;
  try {
    const content = fs.readFileSync(csproj, 'utf8');
    return BLAZOR_MARKERS.some(m => content.includes(m));
  } catch (_) {}
  return false;
};

module.exports = {
  id: 'blazor',
  detect: (targetDir) => {
    try {
      return isBlazorProject(targetDir);
    } catch (_) {}
    return false;
  },
  buildImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
  previewImage: 'mcr.microsoft.com/dotnet/aspnet:8.0',
  runCommand: 'dotnet publish -c Release -o /workspace/out',
  getPreviewCommand: (workDir) => {
    const outDir = path.join(workDir, 'out');
    if (fs.existsSync(outDir)) {
      const dlls = fs.readdirSync(outDir).filter(f => f.endsWith('.dll') && !f.startsWith('System.') && !f.startsWith('Microsoft.'));
      if (dlls.length > 0) {
        return {
          cmd: 'dotnet',
          args: [`out/${dlls[0]}`],
          env: {
            ASPNETCORE_URLS: 'http://0.0.0.0:${PORT:-8080}',
            ASPNETCORE_ENVIRONMENT: 'Production'
          }
        };
      }
    }
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
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
