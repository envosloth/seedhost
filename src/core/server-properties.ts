export const SERVER_PROPERTY_KEYS = ['motd', 'max-players', 'difficulty', 'gamemode', 'pvp', 'white-list', 'view-distance', 'simulation-distance', 'server-port', 'hardcore', 'spawn-protection', 'allow-flight'] as const;
export type ServerPropertyKey = typeof SERVER_PROPERTY_KEYS[number];
export type ServerPropertyPatch = Partial<Record<ServerPropertyKey, string>>;

export function validateServerProperties(input: unknown): ServerPropertyPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length < 1 || Object.keys(input).some(key => !SERVER_PROPERTY_KEYS.includes(key as ServerPropertyKey))) throw new Error('Invalid or unsupported server setting');
  const result: ServerPropertyPatch = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!['string', 'boolean', 'number'].includes(typeof raw)) throw new Error('Invalid server setting value');
    const value = String(raw);
    if (value.length > 200 || /[\x00-\x1f\x7f]/.test(value) || /[\ud800-\udfff]/u.test(value)) throw new Error('Invalid server setting value');
    if (['pvp', 'white-list', 'hardcore', 'allow-flight'].includes(key)) {
      if (value !== 'true' && value !== 'false') throw new Error('Invalid boolean server setting');
    } else if (key === 'difficulty') {
      if (!['peaceful', 'easy', 'normal', 'hard'].includes(value)) throw new Error('Invalid difficulty');
    } else if (key === 'gamemode') {
      if (!['survival', 'creative', 'adventure', 'spectator'].includes(value)) throw new Error('Invalid game mode');
    } else if (key !== 'motd') {
      const minimum = key === 'spawn-protection' ? 0 : key === 'view-distance' || key === 'simulation-distance' ? 2 : 1;
      const maximum = key === 'server-port' ? 65535 : key === 'spawn-protection' ? 1000 : key === 'max-players' ? 500 : 32;
      if (!/^\d{1,5}$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new Error('Invalid numeric server setting');
    }
    result[key as ServerPropertyKey] = value;
  }
  return result;
}

function decodeValue(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char !== '\\') { result += char; continue; }
    const escaped = value[++i];
    if (escaped === undefined) break;
    if (escaped === 'u') {
      const hex = value.slice(i + 1, i + 5);
      if (!/^[a-f0-9]{4}$/i.test(hex)) throw new Error('Invalid Java properties Unicode escape');
      result += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else result += ({ n: '\n', r: '\r', t: '\t', f: '\f' }[escaped] ?? escaped);
  }
  return result;
}
const encodeValue = (value: string): string => value.replace(/\\/g, '\\\\').replace(/[^\x20-\x7e]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).replace(/^ +/, spaces => '\\ '.repeat(spaces.length));
const propertySpace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\f';
const continued = (line: string): boolean => (line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1;

/** Java Properties.load separators and escaping apply to KEYS as well as values. */
function propertyRow(line: string): { key: string; value: string } | undefined {
  let start = 0;
  while (propertySpace(line[start])) start++;
  if (start === line.length || line[start] === '#' || line[start] === '!') return;
  let end = start;
  while (end < line.length) {
    if (line[end] === '\\') { end += 2; continue; }
    if (line[end] === '=' || line[end] === ':' || propertySpace(line[end])) break;
    end++;
  }
  let valueStart = end;
  while (propertySpace(line[valueStart])) valueStart++;
  if (line[valueStart] === '=' || line[valueStart] === ':') valueStart++;
  while (propertySpace(line[valueStart])) valueStart++;
  return { key: decodeValue(line.slice(start, end)), value: decodeValue(line.slice(valueStart)) };
}

export function readServerProperties(text: string): ServerPropertyPatch {
  const result: ServerPropertyPatch = {};
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // Comments never continue; continuation lines strip only Java's ASCII whitespace.
    if (/^[ \t\f]*[#!]/.test(line)) continue;
    while (continued(line)) {
      line = line.slice(0, -1);
      if (++i >= lines.length) break;
      line += lines[i]!.replace(/^[ \t\f]+/, '');
    }
    const row = propertyRow(line);
    if (row && SERVER_PROPERTY_KEYS.includes(row.key as ServerPropertyKey)) result[row.key as ServerPropertyKey] = row.value;
  }
  return result;
}

/** The port this file makes the JVM bind. Java properties allow `:`/whitespace separators, escaped keys and repeat
 * keys where the LAST value wins — a first-match regex would report a port the server never binds. An absent value
 * keeps Minecraft's documented 25565 default; a malformed one cannot be bound at all, so the caller's default is
 * display-only and the launch preflight still refuses it. */
export function effectiveServerPort(text: string): number {
  const raw = readServerProperties(text)['server-port'] ?? '';
  if (!/^\d{1,5}$/.test(raw)) return 25565;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : 25565;
}

export function patchServerProperties(text: string, input: unknown): string {
  const patch = validateServerProperties(input);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r\n|\r|\n/);
  const remaining = new Map(Object.entries(patch));
  const changed = new Set(Object.keys(patch));
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const key = propertyRow(line)?.key;
    // Continuations make line-oriented modification ambiguous; leave the original untouched.
    if (continued(line)) throw new Error('Use Server files to edit properties with continuation lines');
    if (key && changed.has(key)) {
      if (remaining.has(key)) { output.push(key + '=' + encodeValue(remaining.get(key)!)); remaining.delete(key); }
      continue; // Do not leave a later duplicate that overrides the new value.
    }
    output.push(line);
  }
  while (output.at(-1) === '') output.pop();
  for (const [key, value] of remaining) output.push(key + '=' + encodeValue(value));
  return output.join(eol) + eol;
}
