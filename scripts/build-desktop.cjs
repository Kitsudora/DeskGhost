const { existsSync, mkdirSync, copyFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '..');
const localDotnet = join(root, '.tools', 'dotnet', 'dotnet.exe');
const dotnet = existsSync(localDotnet) ? localDotnet : 'dotnet';
const packaged = process.argv.includes('--package');
const destination = join(root, 'artifacts', 'bridge');
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false', DOTNET_CLI_HOME: join(root, '.tools', 'cli-home'), NUGET_PACKAGES: join(root, '.local', 'packages') };
const args = packaged
  ? ['publish', 'src/DeskGhost.Bridge/DeskGhost.Bridge.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', destination, '--nologo']
  : ['build', 'src/DeskGhost.Bridge/DeskGhost.Bridge.csproj', '-c', 'Release', '--nologo'];
const build = spawnSync(dotnet, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (build.error) { console.error('需要 .NET 10 SDK 来构建数据服务。', build.error.message); process.exit(1); }
if (build.status !== 0) process.exit(build.status || 1);
if (packaged) {
  (async () => {
    const { packager } = await import('@electron/packager');
    const result = await packager({
      dir: root,
      name: 'DeskGhost',
      executableName: 'DeskGhost',
      platform: 'win32',
      arch: 'x64',
      download: { cacheRoot: join(root, '.local', 'electron-cache'), checksums: require('electron/checksums.json') },
      out: join(root, 'artifacts', 'desktop'),
      overwrite: true,
      asar: true,
      prune: true,
      extraResource: [destination],
      ignore: [/^\/\.git(?:\/|$)/, /^\/\.github(?:\/|$)/, /^\/\.tools(?:\/|$)/, /^\/\.local(?:\/|$)/, /^\/artifacts(?:\/|$)/, /^\/src(?:\/|$)/, /^\/tests(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/test-results(?:\/|$)/, /^\/playwright-report(?:\/|$)/, /\.sln$/, /Directory\.Build\.props$/],
      win32metadata: { CompanyName: 'DeskGhost', FileDescription: 'DeskGhost desktop companion', ProductName: 'DeskGhost' }
    });
    for (const folder of result) {
      mkdirSync(folder, { recursive: true });
      copyFileSync(join(root, 'README.md'), join(folder, 'README.md'));
      console.log(`Portable application: ${folder}`);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
