import { execFile } from 'node:child_process';
import path from 'node:path';
import { realpath, stat, lstat, mkdtemp, mkdir, writeFile, rm, rename, readFile, symlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeZip } from './zip.js';
import { createHash } from 'node:crypto';
import { validateLaunchProfile, type LaunchProfile } from './saved-state.js';

export interface CreateServerInput {
  name: string;
  loader: 'vanilla' | 'fabric';
  gameVersion: string;
  javaExecutable: string;
  memoryMiB: number;
  eulaAccepted: boolean;
}
export interface PreparedServer {
  sourceDir: string;
  /** Captured download-directory identities stay valid through adoption awaits. */
  assertSource: () => Promise<void>;
  profile: LaunchProfile;
  loader: 'vanilla' | 'fabric';
  gameVersion: string;
}

export interface JavaRuntime { executable: string; major: number; version: string }

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid official metadata object');
  return value as JsonObject;
}
const versionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value) && !value.includes('..');
const isHash = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
type Release = { id: string; url: string; sha1: string };
export interface ServerSetupOptions {
  /** Unit tests only: explicit numeric loopback origin, never exposed via IPC or saved settings. */
  testOnly?: { origin: string; timeoutMs?: number; operationTimeoutMs?: number; maxMetadataBytes?: number; maxArtifactBytes?: number };
}
function validateJavaExecutable(executable: unknown): asserts executable is string {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.length > 4096 || /[\0\r\n]/.test(executable) || /\.(?:cmd|bat)$/i.test(executable)) throw new Error('Choose an absolute native-selected Java executable, not a shell command');
}
function validateCreateInput(input: CreateServerInput): void {
  object(input);
  if (Object.keys(input).sort().join(',') !== 'eulaAccepted,gameVersion,javaExecutable,loader,memoryMiB,name' ||
      typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(input.name) || /[ .]$/.test(input.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input.name) ||
      !versionId(input.gameVersion) || !['vanilla', 'fabric'].includes(input.loader) || !Number.isInteger(input.memoryMiB) || input.memoryMiB < 256 || input.memoryMiB > 1048576 || typeof input.eulaAccepted !== 'boolean') throw new Error('Invalid new-server input');
  // An empty Java choice means "automatic": Seed Hosting finds or installs a matching official runtime.
  if (input.javaExecutable !== '') validateJavaExecutable(input.javaExecutable);
}

/** Mojang's launcher platform key for the official Java runtime manifests (the same runtimes the Minecraft launcher installs). */
export function mojangRuntimePlatform(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  if (platform === 'linux') return arch === 'ia32' ? 'linux-i386' : arch === 'x64' ? 'linux' : '';
  return '';
}
const RUNTIME_LIST = '/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const RUNTIME_MARKER = '.seedhost-runtime.json';
const MAX_RUNTIME_BYTES = 768 * 1024 ** 2;
const runtimeComponent = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
function runtimeJavaPath(platform: string): string {
  return platform.startsWith('windows') ? 'bin/java.exe' : platform.startsWith('mac') ? 'jre.bundle/Contents/Home/bin/java' : 'bin/java';
}
/** A manifest entry name must stay inside the runtime folder: relative, forward-slash, no `.`/`..` segments. */
function runtimeEntryPath(name: string): string {
  if (typeof name !== 'string' || !name || name.length > 512 || name.startsWith('/') || /[\0\\:]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe Java runtime manifest entry');
  return name;
}
const UNOBFUSCATED_INTERMEDIARY = 'net.fabricmc:intermediary:0.0.0';
/** Requires exactly the mappings Fabric's loader metadata declares. Releases from Minecraft 26.1 on are
 * unobfuscated: Fabric declares the placeholder intermediary 0.0.0 and the server profile carries none.
 * Older releases declare (or, in older metadata, imply) `intermediary:<gameVersion>`, which must be present.
 * Anything else fails closed. */
export function checkFabricMappings(declared: unknown, names: ReadonlySet<string>, loaderVersion: string, gameVersion: string): void {
  if (!names.has(`net.fabricmc:fabric-loader:${loaderVersion}`)) throw new Error(`Fabric profile is missing its loader ${loaderVersion}`);
  const intermediaries = [...names].filter(name => name.startsWith('net.fabricmc:intermediary:'));
  if (declared === UNOBFUSCATED_INTERMEDIARY) {
    if (intermediaries.length) throw new Error('Fabric profile lists intermediary mappings for an unobfuscated release');
    return;
  }
  const expected = `net.fabricmc:intermediary:${gameVersion}`;
  if (declared !== undefined && declared !== expected) throw new Error('Fabric loader metadata declares unexpected intermediary mappings');
  if (intermediaries.length !== 1 || intermediaries[0] !== expected) throw new Error('Fabric profile is missing its intermediary mappings for this release');
}
export class ServerSetupClient {
  private readonly timeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly maxMetadataBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly testOrigin?: string;
  private readonly origin: string;
  constructor(options: ServerSetupOptions = {}) {
    if (!options || Object.keys(options).some(key => key !== 'testOnly')) throw new Error('Invalid server setup options');
    if (options.testOnly !== undefined) {
      if (!options.testOnly || Object.keys(options.testOnly).some(key => !['origin', 'timeoutMs', 'operationTimeoutMs', 'maxMetadataBytes', 'maxArtifactBytes'].includes(key))) throw new Error('Invalid test options');
      const url = new URL(options.testOnly.origin);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.origin !== options.testOnly.origin) throw new Error('Tests require an explicit numeric loopback origin');
      this.testOrigin = url.origin;
    }
    this.origin = this.testOrigin ?? 'https://piston-meta.mojang.com';
    const lowerBound = (value: number | undefined, maximum: number) => {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) throw new Error('Invalid test limit options');
      return value ?? maximum;
    };
    this.timeoutMs = lowerBound(options.testOnly?.timeoutMs, 30000);
    this.operationTimeoutMs = lowerBound(options.testOnly?.operationTimeoutMs, 600000);
    this.maxMetadataBytes = lowerBound(options.testOnly?.maxMetadataBytes, 8 * 1024 ** 2);
    this.maxArtifactBytes = lowerBound(options.testOnly?.maxArtifactBytes, 256 * 1024 ** 2);
  }
  private allowed(raw: unknown, hosts: string[]): string {
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error('URL is not allowed');
    const url = new URL(raw);
    if (url.username || url.password || url.hash || url.search || (this.testOrigin ? url.origin !== this.testOrigin : url.protocol !== 'https:' || url.port !== '' || !hosts.includes(url.hostname))) throw new Error('URL is not an allowed official HTTPS endpoint');
    return url.href;
  }
  private async bytes(raw: unknown, hosts: string[], maxBytes = this.maxMetadataBytes, operation?: AbortSignal): Promise<Buffer> {
    const url = this.allowed(raw, hosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Official download timeout')), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const signal = operation ? AbortSignal.any([controller.signal, operation]) : controller.signal;
      const response = await fetch(url, { redirect: 'manual', signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Official metadata request failed (redirects are refused)'); }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); throw new Error('Official response is too large'); }
      if (!response.body) throw new Error('Empty official response');
      reader = response.body.getReader();
      const chunks: Buffer[] = []; let total = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > maxBytes) throw new Error('Official response is too large');
        chunks.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(chunks, total);
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
      controller.abort();
    }
  }
  private async releases(operation?: AbortSignal): Promise<{ latest: string; versions: Release[] }> {
    const manifest = object(JSON.parse((await this.bytes(this.origin + '/mc/game/version_manifest_v2.json', ['piston-meta.mojang.com'], this.maxMetadataBytes, operation)).toString('utf8')));
    const latest = object(manifest.latest).release;
    if (!versionId(latest) || !Array.isArray(manifest.versions) || manifest.versions.length > 10000) throw new Error('Invalid official release manifest');
    const versions: Release[] = []; const ids = new Set<string>();
    for (const raw of manifest.versions) {
      const entry = object(raw);
      if (entry.type !== 'release') continue;
      if (!versionId(entry.id) || ids.has(entry.id) || !isHash(entry.sha1, 40)) throw new Error('Invalid official release manifest');
      const url = this.allowed(entry.url, ['piston-meta.mojang.com', 'launchermeta.mojang.com']);
      ids.add(entry.id); versions.push({ id: entry.id, url, sha1: entry.sha1 });
    }
    if (!ids.has(latest)) throw new Error('Latest version is missing from release manifest');
    return { latest, versions };
  }
  /** Mirrors Fabric's ServerInstaller data-only manifest bootstrap; executable code remains
   * in checksum-verified Maven jars. The Meta /server/jar endpoint has no published checksum.
   * https://github.com/FabricMC/fabric-installer/blob/master/src/main/java/net/fabricmc/installer/server/ServerInstaller.java
   */
  private async prepareFabric(sourceDir: string, gameVersion: string, javaMajor: number, remainingBytes: number, operation: AbortSignal, assertDestination: () => Promise<void>): Promise<void> {
    const meta = this.testOrigin ?? 'https://meta.fabricmc.net';
    const maven = this.testOrigin ?? 'https://maven.fabricmc.net';
    const loaderVersion = '0.19.5'; // Audited modern launcher layout; fail closed on unsupported upstream changes.
    const loaders: unknown = JSON.parse((await this.bytes(`${meta}/v2/versions/loader/${gameVersion}`, ['meta.fabricmc.net'], this.maxMetadataBytes, operation)).toString('utf8'));
    if (!Array.isArray(loaders) || loaders.length > 1024) throw new Error('Invalid Fabric loader metadata');
    const selected = loaders.map(object).find(entry => object(entry.loader).version === loaderVersion);
    if (!selected) throw new Error(`Verified Fabric Loader ${loaderVersion} is not available for this game version`);
    const launcher = object(selected.launcherMeta);
    if (launcher.version !== 2 || typeof launcher.min_java_version !== 'number' || !Number.isInteger(launcher.min_java_version) || launcher.min_java_version < 8 || launcher.min_java_version > 100) throw new Error('Unsupported Fabric launcher metadata');
    if (javaMajor < launcher.min_java_version) throw new Error(`Fabric requires Java ${launcher.min_java_version} or newer`);
    const profile = object(JSON.parse((await this.bytes(`${meta}/v2/versions/loader/${gameVersion}/${loaderVersion}/server/json`, ['meta.fabricmc.net'], this.maxMetadataBytes, operation)).toString('utf8')));
    if (profile.id !== `fabric-loader-${loaderVersion}-${gameVersion}` || profile.inheritsFrom !== gameVersion || profile.mainClass !== 'net.fabricmc.loader.impl.launch.knot.KnotServer' || !Array.isArray(profile.libraries) || profile.libraries.length < 2 || profile.libraries.length > 64) throw new Error('Unsupported Fabric server profile');
    const names = new Set<string>();
    const libraries = profile.libraries.map((raw, index) => {
      const library = object(raw);
      if (typeof library.name !== 'string' || !/^[a-z0-9]+(?:\.[a-z0-9]+)*:[A-Za-z0-9_-]+:[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(library.name) || library.name.includes('..') || names.has(library.name)) throw new Error('Unsafe Fabric Maven coordinate');
      names.add(library.name);
      if (this.allowed(library.url, ['maven.fabricmc.net']) !== maven + '/') throw new Error('Fabric library is not from official Maven');
      const [group, artifact, version] = library.name.split(':') as [string, string, string];
      const url = `${maven}/${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
      const size = library.size;
      if (size !== undefined && (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > this.maxArtifactBytes)) throw new Error('Invalid Fabric library size');
      if (library.sha256 !== undefined && !isHash(library.sha256, 64)) throw new Error('Invalid Fabric library integrity metadata');
      return { url, size, checksum: library.sha256 as string | undefined, filename: `libraries/lib-${index}.jar` };
    });
    checkFabricMappings(selected.intermediary === undefined ? undefined : object(selected.intermediary).maven, names, loaderVersion, gameVersion);
    await assertDestination();
    await mkdir(path.join(sourceDir, 'libraries'));
    for (const library of libraries) {
      const checksum = library.checksum ?? (await this.bytes(library.url + '.sha256', ['maven.fabricmc.net'], 256, operation)).toString('utf8').trim();
      if (!isHash(checksum, 64)) throw new Error('Fabric Maven SHA-256 checksum is missing or invalid; no unverified fallback');
      if (remainingBytes < 1 || library.size !== undefined && (library.size as number) > remainingBytes) throw new Error('Server executable download budget exceeded');
      const bytes = await this.bytes(library.url, ['maven.fabricmc.net'], Math.min((library.size as number | undefined) ?? this.maxArtifactBytes, remainingBytes), operation);
      remainingBytes -= bytes.length;
      if (!bytes.length || library.size !== undefined && bytes.length !== library.size || createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Fabric library integrity check failed');
      await assertDestination();
      await writeFile(path.join(sourceDir, library.filename), bytes, { flag: 'wx', mode: 0o600 });
    }
    const header = (name: string, value: string) => {
      let line = `${name}: ${value}`; const lines: string[] = [];
      while (line.length > 72) { lines.push(line.slice(0, 72)); line = ' ' + line.slice(72); }
      return [...lines, line].join('\r\n') + '\r\n';
    };
    const manifest = 'Manifest-Version: 1.0\r\n' + header('Main-Class', 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher') + header('Class-Path', libraries.map(library => library.filename).join(' ')) + '\r\n';
    await assertDestination();
    await writeZip(path.join(sourceDir, 'fabric-server-launch.jar'), [
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from(manifest) },
      { name: 'fabric-server-launch.properties', data: Buffer.from(`launch.mainClass=${profile.mainClass}\n`) },
    ]);
  }
  async prepare(stagingParent: string, input: CreateServerInput, options: { runtimeRoot?: string } = {}): Promise<PreparedServer> {
    validateCreateInput(input);
    input = { ...input }; // Consent and selected runtime/version cannot change while downloads await.
    const runtimeRoot = options?.runtimeRoot;
    if (runtimeRoot !== undefined && (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot) || /[\0\r\n]/.test(runtimeRoot) || runtimeRoot.length > 4096)) throw new Error('Invalid trusted Java runtime folder');
    if (!input.javaExecutable && !runtimeRoot) throw new Error('Choose a Java runtime, or let Seed Hosting set up Java automatically');
    const operation = AbortSignal.timeout(this.operationTimeoutMs);
    if (typeof stagingParent !== 'string' || !path.isAbsolute(stagingParent) || /[\0\r\n]/.test(stagingParent) || stagingParent.length > 4096) throw new Error('Invalid trusted staging parent');
    const stage = await lstat(stagingParent).catch(() => null);
    if (!stage?.isDirectory() || stage.isSymbolicLink()) throw new Error('Choose an existing non-symlink staging directory');
    const assertStage = async () => {
      const current = await lstat(stagingParent), actual = await realpath(stagingParent);
      const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stage.dev || current.ino !== stage.ino || !samePath(actual, path.resolve(stagingParent))) {
        throw new Error('Download staging directory changed or passes through links or junctions');
      }
    };
    await assertStage();
    const release = (await this.releases(operation)).versions.find(version => version.id === input.gameVersion);
    if (!release) throw new Error('Choose a supported official release version');
    const raw = await this.bytes(release.url, ['piston-meta.mojang.com', 'launchermeta.mojang.com'], this.maxMetadataBytes, operation);
    if (createHash('sha1').update(raw).digest('hex') !== release.sha1) throw new Error('Version metadata integrity check failed');
    const metadata = object(JSON.parse(raw.toString('utf8')));
    if (metadata.id !== input.gameVersion) throw new Error('Version metadata does not match selected release');
    let required: unknown; let component: unknown;
    try { ({ majorVersion: required, component } = object(metadata.javaVersion)); } catch { throw new Error('Official Java requirement is missing or unsupported; use Import for this release'); }
    if (typeof required !== 'number' || !Number.isInteger(required) || required < 8 || required > 100) throw new Error('Official Java requirement is missing or unsupported');
    let java: JavaRuntime;
    if (input.javaExecutable) {
      java = await probeJava(input.javaExecutable);
      if (java.major < required) throw new Error(`Minecraft ${input.gameVersion} requires Java ${required} or newer; selected Java is ${java.major}`);
    } else java = await this.ensureJava(runtimeRoot!, required, component, operation);
    const download = object(object(metadata.downloads).server);
    if (!Number.isSafeInteger(download.size) || (download.size as number) < 1 || (download.size as number) > this.maxArtifactBytes || !isHash(download.sha1, 40)) throw new Error('Missing verifiable official server download');
    const bytes = await this.bytes(download.url, ['piston-data.mojang.com', 'launcher.mojang.com'], download.size as number, operation);
    if (bytes.length !== download.size || createHash('sha1').update(bytes).digest('hex') !== download.sha1) throw new Error('Server download integrity check failed');
    // Official metadata/runtime/artifact reads can take minutes. Revalidate the
    // captured directory identity at publication, not only before those awaits.
    await assertStage();
    const sourceDir = await mkdtemp(path.join(stagingParent, 'seedhost-setup-'));
    const source = await lstat(sourceDir);
    const assertSource = async () => {
      await assertStage();
      const current = await lstat(sourceDir);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== source.dev || current.ino !== source.ino) throw new Error('Download source directory changed');
    };
    try {
      await assertSource();
      await writeFile(path.join(sourceDir, 'server.jar'), bytes, { flag: 'wx', mode: 0o600 });
      if (input.loader === 'fabric') await this.prepareFabric(sourceDir, input.gameVersion, java.major, this.maxArtifactBytes - bytes.length, operation, assertSource);
      operation.throwIfAborted();
      await assertSource();
      if (input.eulaAccepted === true) await writeFile(path.join(sourceDir, 'eula.txt'), 'eula=true\n', { flag: 'wx', mode: 0o600 });
      const jarName = input.loader === 'fabric' ? 'fabric-server-launch.jar' : 'server.jar';
      return { sourceDir, assertSource, loader: input.loader, gameVersion: input.gameVersion, profile: validateLaunchProfile({ executable: java.executable, args: [`-Xms${Math.min(512, input.memoryMiB)}M`, `-Xmx${input.memoryMiB}M`, '-jar', jarName, 'nogui'] }) };
    } catch (error) {
      // Never remove a directory reached through a replaced ancestor on failure.
      try { await assertSource(); await rm(sourceDir, { recursive: true, force: true }); } catch { /* preserve uncertain evidence */ }
      throw error;
    }
  }
  async listVersions(): Promise<{ latest: string; versions: Array<{ id: string }> }> {
    const manifest = await this.releases();
    return { latest: manifest.latest, versions: manifest.versions.map(({ id }) => ({ id })) };
  }
  /** Automatic Java: reuse an installed managed runtime, else a compatible Java already on this PC, else
   * download Mojang's official runtime (the one the Minecraft launcher uses), verifying every file's SHA-1
   * against its SHA-1-pinned manifest. Installs atomically into `runtimeRoot/<component>`; never system-wide. */
  private async ensureJava(runtimeRoot: string, required: number, component: unknown, operation: AbortSignal): Promise<JavaRuntime> {
    // Servers older than Java 17 (Minecraft 1.16 and earlier) can break on newer Java; require an exact match there.
    const fits = (java: JavaRuntime) => required < 17 ? java.major === required : java.major >= required;
    if (runtimeComponent(component)) {
      const managed = await readManagedRuntime(runtimeRoot, component);
      if (managed && fits(managed)) return managed;
    }
    const system = (await discoverJava()).filter(fits).sort((a, b) => a.major - b.major);
    if (system[0]) return system[0];
    if (!runtimeComponent(component)) throw new Error(`Minecraft needs Java ${required}, and no official runtime is published for this release`);
    const platform = mojangRuntimePlatform();
    if (!platform) throw new Error(`Automatic Java isn’t available for this computer; install Java ${required} and choose it`);
    const list = object(JSON.parse((await this.bytes(this.origin + RUNTIME_LIST, ['piston-meta.mojang.com', 'launchermeta.mojang.com'], this.maxMetadataBytes, operation)).toString('utf8')));
    const offers = object(list[platform] ?? {})[component];
    if (!Array.isArray(offers) || !offers.length) throw new Error(`No official Java ${required} runtime is published for this computer`);
    const offer = object(object(offers[0]).manifest);
    if (!isHash(offer.sha1, 40)) throw new Error('Invalid Java runtime list');
    const manifestBytes = await this.bytes(offer.url, ['piston-meta.mojang.com', 'launchermeta.mojang.com'], this.maxMetadataBytes, operation);
    if (createHash('sha1').update(manifestBytes).digest('hex') !== offer.sha1) throw new Error('Java runtime manifest integrity check failed');
    const files = object(object(JSON.parse(manifestBytes.toString('utf8'))).files);
    // Validate the whole manifest before writing anything.
    const entries = Object.entries(files).map(([name, raw]) => {
      const entry = object(raw); runtimeEntryPath(name);
      if (entry.type === 'directory') return { name, type: 'directory' as const };
      if (entry.type === 'link') {
        const target = entry.target;
        if (typeof target !== 'string' || !target || target.length > 512 || /[\0\\:]/.test(target) || target.startsWith('/')) throw new Error('Unsafe Java runtime manifest entry');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) throw new Error('Unsafe Java runtime manifest entry');
        return { name, type: 'link' as const, target };
      }
      if (entry.type !== 'file') throw new Error('Unsupported Java runtime manifest entry');
      const download = object(object(entry.downloads).raw);
      if (!isHash(download.sha1, 40) || !Number.isSafeInteger(download.size) || (download.size as number) < 0 || (download.size as number) > MAX_RUNTIME_BYTES) throw new Error('Invalid Java runtime file metadata');
      return { name, type: 'file' as const, url: this.allowed(download.url, ['piston-data.mojang.com', 'launcher.mojang.com']), sha1: download.sha1 as string, size: download.size as number, executable: entry.executable === true };
    });
    const javaPath = runtimeJavaPath(platform);
    if (!entries.some(entry => entry.type === 'file' && entry.name === javaPath)) throw new Error('Official Java runtime has no Java executable');
    if (entries.reduce((total, entry) => total + (entry.type === 'file' ? entry.size : 0), 0) > MAX_RUNTIME_BYTES) throw new Error('Official Java runtime is too large');
    await mkdir(runtimeRoot, { recursive: true });
    const temporary = path.join(runtimeRoot, `.download-${randomUUID()}`);
    const final = path.join(runtimeRoot, component);
    try {
      await mkdir(temporary);
      for (const entry of entries) if (entry.type === 'directory') await mkdir(path.join(temporary, ...entry.name.split('/')), { recursive: true });
      const queue = entries.filter(entry => entry.type === 'file');
      // One failure cancels the other workers and every one is drained BEFORE the catch removes staging: a worker
      // still awaiting bytes would otherwise recreate the directory and keep writing after setup already failed.
      const cancel = new AbortController();
      const signal = AbortSignal.any([operation, cancel.signal]);
      let firstError: unknown;
      const worker = async () => {
        for (;;) {
          if (cancel.signal.aborted) return;
          const entry = queue.shift();
          if (!entry || entry.type !== 'file') { if (!entry) return; continue; }
          try {
            const bytes = entry.size ? await this.bytes(entry.url, ['piston-data.mojang.com', 'launcher.mojang.com'], entry.size, signal) : Buffer.alloc(0);
            if (bytes.length !== entry.size || createHash('sha1').update(bytes).digest('hex') !== entry.sha1) throw new Error('Java runtime integrity check failed');
            if (cancel.signal.aborted) return;
            const target = path.join(temporary, ...entry.name.split('/'));
            await mkdir(path.dirname(target), { recursive: true });
            if (cancel.signal.aborted) return;
            await writeFile(target, bytes, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 });
          } catch (error) {
            if (!firstError) { firstError = error; cancel.abort(error); }
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      if (firstError) throw firstError;
      if (process.platform !== 'win32') for (const entry of entries) if (entry.type === 'link') {
        const target = path.join(temporary, ...entry.name.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await symlink(entry.target, target);
      }
      const java = await probeJava(path.join(temporary, ...javaPath.split('/')));
      if (!fits(java)) throw new Error(`Official runtime reports Java ${java.major}; Minecraft needs Java ${required}`);
      await writeFile(path.join(temporary, RUNTIME_MARKER), JSON.stringify({ version: 1, component, platform, java: javaPath }) + '\n', { flag: 'wx', mode: 0o644 });
      operation.throwIfAborted();
      await rm(final, { recursive: true, force: true }); // Only an unmarked/incompatible leftover of our own runtime folder can be here.
      await rename(temporary, final);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    const installed = await readManagedRuntime(runtimeRoot, component);
    if (!installed || !fits(installed)) throw new Error('Installed Java runtime could not be verified');
    return installed;
  }
}

async function readManagedRuntime(runtimeRoot: string, component: string): Promise<JavaRuntime | null> {
  try {
    const marker = object(JSON.parse(await readFile(path.join(runtimeRoot, component, RUNTIME_MARKER), 'utf8')));
    if (marker.component !== component || typeof marker.java !== 'string') return null;
    return await probeJava(path.join(runtimeRoot, component, ...runtimeEntryPath(marker.java).split('/')));
  } catch { return null; }
}

/** Bounded environment discovery; no recursive disk scan, shell, registry or Java installation.
 * At most 32 directories, 16 unique executables, four concurrent three-second probes.
 * An unlisted runtime can be selected by the parent's native file picker.
 */
export async function discoverJava(runtimeRoot?: string): Promise<JavaRuntime[]> {
  const managed: JavaRuntime[] = [];
  if (runtimeRoot && path.isAbsolute(runtimeRoot)) {
    const names = await readdir(runtimeRoot).catch(() => [] as string[]);
    for (const name of names.filter(runtimeComponent).slice(0, 16)) {
      const runtime = await readManagedRuntime(runtimeRoot, name);
      if (runtime) managed.push(runtime);
    }
  }
  const filename = process.platform === 'win32' ? 'java.exe' : 'java';
  const home = process.env.JAVA_HOME;
  const directories = [home && path.isAbsolute(home) ? path.join(home, 'bin') : '', ...(process.env.PATH ?? '').slice(0, 32768).split(path.delimiter)].filter(dir => dir && path.isAbsolute(dir)).slice(0, 32);
  const candidates = new Map<string, string>();
  for (const dir of directories) {
    try {
      const executable = await realpath(path.join(dir, filename));
      if ((await stat(executable)).isFile()) candidates.set(process.platform === 'win32' ? executable.toLowerCase() : executable, executable);
    } catch { /* Missing/unreadable entries do not block a native selection. */ }
    if (candidates.size >= 16) break;
  }
  const paths = [...candidates.values()].filter(executable => !managed.some(runtime => runtime.executable === executable));
  const found: JavaRuntime[] = [...managed];
  for (let index = 0; index < paths.length; index += 4) {
    const batch = await Promise.all(paths.slice(index, index + 4).map(executable => probeJava(executable).catch(() => null)));
    found.push(...batch.filter((runtime): runtime is JavaRuntime => runtime !== null));
  }
  return found;
}

/** Runs only the native-selected executable; never passes a command to a shell.
 * https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback
 */
export async function probeJava(executable: string): Promise<JavaRuntime> {
  validateJavaExecutable(executable);
  const output = await new Promise<string>((resolve, reject) => {
    const env = { ...process.env };
    // Environment-injected JVM agents/options must not run during discovery.
    delete env.JAVA_TOOL_OPTIONS; delete env.JDK_JAVA_OPTIONS; delete env._JAVA_OPTIONS;
    execFile(executable, ['-version'], { shell: false, windowsHide: true, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 16384, env }, (error, stdout, stderr) => {
      if (error) reject(new Error('Java probe failed', { cause: error }));
      else resolve(stderr + '\n' + stdout);
    });
  });
  const version = /^(?:openjdk|java)(?: version)? ["']?(\d+(?:\.\d+)*(?:_\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?:["']|\s|$)/m.exec(output)?.[1];
  if (!version) throw new Error('Java version could not be determined');
  const parts = version.split('.');
  const major = Number(parts[0] === '1' ? parts[1] : parts[0]);
  if (!Number.isInteger(major) || major < 2 || major > 100) throw new Error('Invalid Java version');
  return { executable, major, version };
}
