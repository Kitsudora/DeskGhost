const { existsSync, lstatSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve, relative, isAbsolute, sep } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '..');
const localDotnet = join(root, '.tools', 'dotnet', 'dotnet.exe');
const dotnet = existsSync(localDotnet) ? localDotnet : 'dotnet';
const destination = join(root, 'artifacts', 'bridge');
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false', DOTNET_CLI_HOME: join(root, '.tools', 'cli-home'), NUGET_PACKAGES: join(root, '.local', 'packages') };

// Packager supplies paths relative to the app root, with a leading slash.
// Keep authoring files, personal notes, data and future root folders out by default.
function ignorePackagePath(file) {
  const name = file.replaceAll('\\', '/');
  return name !== '' && !/^\/(?:desktop(?:\/|$)|package\.json$|README\.md$|LICENSE$|assets(?:\/README\.md)?$)/.test(name);
}

function resolvePackageOutput(value) {
  const artifacts = join(root, 'artifacts');
  const output = resolve(root, value ?? join('artifacts', 'desktop'));
  const inside = relative(artifacts, output);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) ||
      inside.split(sep)[0].toLowerCase() === 'bridge') {
    throw new Error('The package output must be a folder inside artifacts, separate from artifacts/bridge.');
  }
  // A junction must not redirect Packager's copy or default overwrite outside
  // the checked workspace. Include the final portable folder in this check.
  let current = artifacts;
  for (const part of ['', ...inside.split(sep), 'DeskGhost-win32-x64']) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`The package output cannot pass through a symbolic link or junction: ${current}`);
    }
  }
  if (value !== undefined && existsSync(output)) {
    throw new Error(`Release output already exists; choose a new --out folder: ${output}`);
  }
  return output;
}

function copyRuntimeNotices(published, packageCache) {
  const depsPath = join(published, 'DeskGhost.Bridge.deps.json');
  const deps = JSON.parse(readFileSync(depsPath, 'utf8'));
  const packs = Object.keys(deps.libraries ?? {}).filter(name => /^runtimepack\.Microsoft\.NETCore\.App\.Runtime\.win-x64\//i.test(name));
  const version = packs.length === 1 ? packs[0].split('/')[1] : '';
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(version)) {
    throw new Error(`Cannot identify the published Windows .NET runtime version in ${depsPath}.`);
  }
  const runtime = join(packageCache, 'microsoft.netcore.app.runtime.win-x64', version);
  const notices = ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'];
  for (const name of notices) {
    const source = join(runtime, name);
    if (!existsSync(source) || !lstatSync(source).isFile() || !readFileSync(source).length) {
      throw new Error(`Missing .NET runtime distribution notice: ${source}. Restore the complete runtime package before packaging.`);
    }
  }
  for (const name of notices) copyFileSync(join(runtime, name), join(published, name));
}

async function main(argv = process.argv.slice(2)) {
  const packaged = argv.includes('--package');
  const outputIndex = argv.indexOf('--out');
  const customOutput = outputIndex < 0 ? undefined : argv[outputIndex + 1];
  if (outputIndex >= 0 && (!packaged || !customOutput || customOutput.startsWith('--'))) {
    throw new Error('Use --package --out artifacts/<new-release-folder> to create a separate release.');
  }
  const output = packaged ? resolvePackageOutput(customOutput) : null;
  const args = packaged
    ? ['publish', 'src/DeskGhost.Bridge/DeskGhost.Bridge.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', destination, '--nologo']
    : ['build', 'src/DeskGhost.Bridge/DeskGhost.Bridge.csproj', '-c', 'Release', '--nologo'];
  const build = spawnSync(dotnet, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (build.error) throw new Error('需要 .NET 10 SDK 来构建数据服务。 ' + build.error.message);
  if (build.status !== 0) { process.exitCode = build.status || 1; return; }
  if (packaged) {
    copyRuntimeNotices(destination, env.NUGET_PACKAGES);
    const { packager } = await import('@electron/packager');
    const result = await packager({
      dir: root,
      name: 'DeskGhost',
      executableName: 'DeskGhost',
      platform: 'win32',
      arch: 'x64',
      download: { cacheRoot: join(root, '.local', 'electron-cache'), checksums: require('electron/checksums.json') },
      out: output,
      overwrite: customOutput === undefined,
      asar: true,
      prune: true,
      extraResource: [destination],
      ignore: ignorePackagePath,
      win32metadata: { CompanyName: 'DeskGhost', FileDescription: 'DeskGhost desktop companion', ProductName: 'DeskGhost' }
    });
    for (const folder of result) {
      mkdirSync(folder, { recursive: true });
      // Electron already has a top-level LICENSE; keep its notice intact.
      writeFileSync(join(folder, 'README.md'), readFileSync(join(root, 'README.md'), 'utf8').replace('](LICENSE)', '](LICENSE-DeskGhost.txt)'));
      copyFileSync(join(root, 'LICENSE'), join(folder, 'LICENSE-DeskGhost.txt'));
      mkdirSync(join(folder, 'assets'), { recursive: true });
      writeFileSync(join(folder, 'assets', 'README.md'), readFileSync(join(root, 'assets', 'README.md'), 'utf8').replace('](../LICENSE)', '](../LICENSE-DeskGhost.txt)'));
      console.log(`Portable application: ${folder}`);
    }
  }
}

module.exports = { ignorePackagePath, resolvePackageOutput, copyRuntimeNotices };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
