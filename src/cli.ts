#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { build as esbuild } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ArgMap = Record<string, string | boolean>;

function parseArgs(args: string[]): ArgMap {
	const map: ArgMap = {};
	for (let i = 0; i < args.length; i++) {
		const token = args[i] ?? '';
		if (token.startsWith('--')) {
			const key = token.slice(2);
			const next = args[i + 1];
			if (next && !next.startsWith('--')) {
				map[key] = next;
				i++;
			} else {
				map[key] = true;
			}
		}
	}
	return map;
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getUTCFullYear()}` +
		pad(d.getUTCMonth() + 1) +
		pad(d.getUTCDate()) +
		'_' +
		pad(d.getUTCHours()) +
		pad(d.getUTCMinutes()) +
		pad(d.getUTCSeconds())
	);
}

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

type TableSpec = {
	 table?: string;
	 primaryKey?: string[];
	 updatedAt?: string;
};

type AppSchema = Record<string, unknown | (TableSpec & { schema?: unknown })>;

function normalizeTables(appSchema: AppSchema): Array<{ name: string; pk: string[]; updatedAt: string }> {
	const tables: Array<{ name: string; pk: string[]; updatedAt: string }> = [];
	for (const [key, val] of Object.entries(appSchema || {})) {
		const obj = (val && typeof val === 'object') ? (val as Record<string, unknown>) : {};
		const name = typeof obj.table === 'string' ? String(obj.table) : key;
		const pk = Array.isArray(obj.primaryKey) && obj.primaryKey.length > 0 ? (obj.primaryKey as string[]) : ['id'];
		const updatedAt = typeof obj.updatedAt === 'string' ? String(obj.updatedAt) : 'updatedAt';
		tables.push({ name, pk, updatedAt });
	}
	return tables;
}

function ddlForTable(table: { name: string; pk: string[]; updatedAt: string }): string {
	const cols = new Set<string>();
	for (const k of table.pk) cols.add(k);
	cols.add(table.updatedAt);
	const colDefs = Array.from(cols).map((c) => {
		const isPkCol = table.pk.length === 1 && c === table.pk[0];
		const type = c === table.updatedAt ? 'INTEGER' : 'TEXT';
		return `  ${c} ${type}${isPkCol ? ' PRIMARY KEY' : ''}`;
	});
	const pkComposite = table.pk.length > 1 ? `,\n  PRIMARY KEY (${table.pk.join(', ')})` : '';
	return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${colDefs.join(',\n')}\n${pkComposite}\n);`;
}

async function transpileTsToMjs(tsPath: string): Promise<string> {
	const td = await fs.mkdtemp(resolve(tmpdir(), `just-sync-`));
	const out = resolve(td, `schema.mjs`);
	await esbuild({ entryPoints: [tsPath], outfile: out, bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
	return out;
}

async function loadAppSchema(schemaPath: string | undefined): Promise<AppSchema | null> {
	if (!schemaPath) return null;
	try {
		let full = resolve(process.cwd(), schemaPath);
		if (full.endsWith('.ts')) {
			full = await transpileTsToMjs(full);
		}
		const mod = await import(pathToFileURL(full).href);
		const schema = (mod.schema ?? mod.default?.schema ?? mod.default) as AppSchema | undefined;
		if (schema && typeof schema === 'object') return schema;
		return null;
	} catch {
		return null;
	}
}

async function findSchemaPath(cwd: string, hint?: string): Promise<{ path?: string; note?: string }> {
	const candidates: string[] = [];
	if (hint) candidates.push(hint);
	// common locations
	candidates.push('schema.mjs', 'schema.js', 'schema.ts', 'server/schema.mjs', 'server/schema.js', 'server/schema.ts', 'src/schema.mjs', 'src/schema.js', 'src/schema.ts');
	for (const rel of candidates) {
		try {
			const full = resolve(cwd, rel);
			const st = await fs.stat(full);
			if (st.isFile()) return { path: full };
			if (st.isDirectory()) {
				// if hint was a directory, search inside
				for (const name of ['schema.mjs', 'schema.js', 'schema.ts']) {
					const inner = resolve(full, name);
					try {
						const st2 = await fs.stat(inner);
						if (st2.isFile()) return { path: inner };
					} catch {}
				}
			}
		} catch {}
	}
	return {};
}

async function generateSqliteMigration(outDir: string, schemaPath?: string): Promise<string> {
	const ts = timestamp();
	const filename = `${ts}_just_sync_init.sql`;
	const full = resolve(outDir, filename);
	const parts: string[] = [];
	parts.push(`-- just-sync generated migration (SQLite)`);
	parts.push(`-- UTC: ${new Date().toISOString()}`);
	parts.push('');
	parts.push('PRAGMA foreign_keys = ON;');
	parts.push('');
	parts.push('CREATE TABLE IF NOT EXISTS _sync_versions (');
	parts.push('  table_name   TEXT    NOT NULL,');
	parts.push('  pk_canonical TEXT    NOT NULL,');
	parts.push('  version      INTEGER NOT NULL,');
	parts.push('  PRIMARY KEY (table_name, pk_canonical)');
	parts.push(');');
	// Schema reading is optional in MVP; only internal meta table is generated.
	parts.push('');
	await fs.writeFile(full, parts.join('\n'), 'utf8');
	return full;
}

async function main() {
	const [, , cmd, ...rest] = process.argv;
	if (!cmd || cmd === 'help') {
		console.log(
			'just-sync CLI\n\nCommands:\n  init --adapter sqlite --db-url <url>\n  generate:schema --adapter sqlite --out <dir>'
		);
		process.exit(0);
	}
	if (cmd === 'init') {
		console.log('Initializing just-sync (no-op in MVP).');
		process.exit(0);
	}
	if (cmd === 'generate:schema') {
		const args = parseArgs(rest);
		const adapter = String(args.adapter || 'sqlite');
		const out = String(args.out || 'migrations');
		const schemaArg = typeof args.schema === 'string' ? String(args.schema) : undefined;
		await ensureDir(out);
		if (adapter !== 'sqlite') {
			console.error(`Unsupported adapter: ${adapter}. Only sqlite is supported in MVP.`);
			process.exit(1);
		}
		const { path: discovered, note } = await findSchemaPath(process.cwd(), schemaArg);
		if (note) console.warn(note);
		const file = await generateSqliteMigration(out, discovered);
		console.log(`✔ Wrote migration: ${file}`);
		process.exit(0);
	}
	console.error(`Unknown command: ${cmd}`);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
