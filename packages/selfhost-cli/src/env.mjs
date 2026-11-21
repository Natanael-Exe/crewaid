/**
 * Read and write the server's .env — KEY=value lines, comments kept on update.
 *
 * A value is written bare when it is plain and single-quoted otherwise (the
 * keyring is JSON), which Compose's .env parser reads back verbatim.
 */
export function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^'.*'$/.test(value) || /^".*"$/.test(value)) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function quote(value) {
  return /^[A-Za-z0-9_./:@+=-]*$/.test(value) ? value : `'${value.replace(/'/g, '')}'`;
}

export function renderEnv(entries) {
  const lines = [
    '# Written by crewaid-selfhost. Keep it private: it holds the keys to everything.',
    '# `crewaid-selfhost update` changes CREWAID_VERSION, and adds a secret a new release needs.',
  ];
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    lines.push(`${key}=${quote(String(value))}`);
  }
  return lines.join('\n') + '\n';
}

/** Change one key in an existing .env, leaving every other line as it was. */
export function setEnvValue(text, key, value) {
  const line = `${key}=${quote(String(value))}`;
  const pattern = new RegExp(`^\\s*${key}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : text.replace(/\n?$/, `\n${line}\n`);
}
