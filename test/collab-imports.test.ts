import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const executable = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
const astGrep = fileURLToPath(new URL(`../node_modules/@ast-grep/cli/${executable}`, import.meta.url));
const config = fileURLToPath(new URL('../.github/ast-grep/sgconfig.yml', import.meta.url));

it('allows the existing SQLite import and rejects new storage imports by path', () => {
  const root = mkdtempSync(join(tmpdir(), 'keito-collab-imports-'));
  const collab = join(root, 'server', 'collab');
  const store = join(collab, 'store.ts');
  const existing = "import { DatabaseSync } from 'node:sqlite';\n";
  const scan = () => spawnSync(astGrep, ['scan', '--config', config, '--report-style', 'short', 'server/collab'], {
    cwd: root, encoding: 'utf8',
  });

  try {
    mkdirSync(collab, { recursive: true });
    writeFileSync(store, existing);
    const allowed = scan();
    expect(allowed.status, allowed.error?.message ?? allowed.stderr).toBe(0);

    writeFileSync(store, existing + "import 'node:fs';\n");
    writeFileSync(join(collab, 'consumer.tsx'), existing + 'const label = <span />;\n');
    writeFileSync(join(collab, 'adapter.cjs'), "module.require('node:fs/promises');\n");
    const rejected = scan();
    const output = rejected.stdout + rejected.stderr;
    expect(rejected.status, rejected.error?.message ?? output).toBe(1);
    expect(output).toContain('store.ts:2:');
    expect(output).toContain('consumer.tsx:1:');
    expect(output).toContain('adapter.cjs:1:');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
