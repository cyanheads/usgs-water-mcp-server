/**
 * @fileoverview Built entry startup diagnostics under supported runtimes from a clean cwd.
 * @module tests/config/startup.test
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const cwd = mkdtempSync(join(tmpdir(), 'usgs-startup-'));
const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
// Bun's --bun runner prepends a node shim; require a real Node executable for this lane.
const node = process.env.PATH?.split(delimiter)
  .map((directory) => join(directory, 'node'))
  .find(
    (candidate) =>
      existsSync(candidate) &&
      spawnSync(candidate, ['-p', 'process.versions.bun ? "bun" : "node"'], {
        encoding: 'utf8',
      }).stdout.trim() === 'node',
  );
if (!node) throw new Error('A real Node executable is required for startup tests.');
afterAll(() => rmSync(cwd, { recursive: true }));

/** Start the actual entry, collect its tool list, and stop only the child this test created. */
async function startupTools(runtime: string, flag: string, canvasSetting?: string) {
  const directory = mkdtempSync(join(cwd, 'env-'));
  writeFileSync(
    join(directory, '.env'),
    `WATER_DATAFRAME_DROP_ENABLED=${flag}\nMCP_TRANSPORT_TYPE=stdio\n`,
  );
  const env = { ...process.env };
  delete env.WATER_DATAFRAME_DROP_ENABLED;
  delete env.CANVAS_PROVIDER_TYPE;
  delete env.DEBUG;
  if (canvasSetting !== undefined) env.CANVAS_PROVIDER_TYPE = canvasSetting;
  return await new Promise<{ tools: string[]; canvasReason: string; drop: unknown }>(
    (resolve, reject) => {
      const child = spawn(runtime, [entry], {
        cwd: directory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stdout = '';
      let tools: string[] | undefined;
      let canvasReason: string | undefined;
      let drop: unknown;
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.stdout.on('data', (data) => {
        stdout += data;
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        for (const line of lines.filter(Boolean)) {
          const response = JSON.parse(line);
          if (response.id === 2 && response.result?.tools) {
            tools = response.result.tools.map((tool: { name: string }) => tool.name);
          }
          if (response.id === 3)
            canvasReason = response.result?.structuredContent?.error?.data?.reason;
          if (response.id === 4) drop = response;
          if (tools && canvasReason && drop) child.kill('SIGTERM');
        }
      });
      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(timer);
        if (!tools || !canvasReason || !drop)
          reject(new Error(`Startup returned incomplete responses: ${stdout}\n${stderr}`));
        else resolve({ tools, canvasReason, drop });
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      const canvas_id = 'missing123';
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'water_dataframe_describe', arguments: { canvas_id } } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'water_dataframe_drop', arguments: { canvas_id, table_name: 'missing' } } })}\n`,
      );
    },
  );
}

describe.each(['bun', node])('%s startup configuration', (runtime) => {
  it.each(['', '   ', `\${CANVAS_PROVIDER_TYPE}`, 'none', 'duckdb'])(
    'normalizes canvas setting %j before applying its default',
    async (setting) => {
      const result = await startupTools(runtime, 'false', setting);
      expect(result.canvasReason).toBe(setting === 'none' ? 'canvas_disabled' : 'canvas_not_found');
    },
  );
  it.each(['true', 'false'])(
    'loads a valid .env drop flag %s and keeps DataCanvas enabled',
    async (flag) => {
      const result = await startupTools(runtime, flag);
      expect(result.tools.includes('water_dataframe_drop')).toBe(flag === 'true');
      expect(result.tools).toHaveLength(flag === 'true' ? 9 : 8);
      expect(result.canvasReason).toBe('canvas_not_found');
      if (flag === 'true')
        expect(result.drop).toMatchObject({
          result: {
            isError: true,
            structuredContent: { error: { data: { reason: 'canvas_not_found' } } },
          },
        });
      else expect(result.drop).toMatchObject({ error: { code: -32602 } });
    },
  );
  it.each([
    ['USGS_REQUEST_TIMEOUT_MS', 'abc'],
    ['WATER_DATAFRAME_DROP_ENABLED', 'garbage'],
  ])('reports %s through the setup banner', (variable, value) => {
    const env = { ...process.env, MCP_TRANSPORT_TYPE: 'stdio', [variable]: value };
    delete env.DEBUG;
    const result = spawnSync(runtime, [entry], {
      cwd,
      encoding: 'utf8',
      input: '',
      timeout: 10_000,
      env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Configuration error — server failed to start');
    expect(result.stderr).toContain(variable);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('keeps diagnostics behind DEBUG=true', () => {
    const result = spawnSync(runtime, [entry], {
      cwd,
      encoding: 'utf8',
      input: '',
      timeout: 10_000,
      env: {
        ...process.env,
        MCP_TRANSPORT_TYPE: 'stdio',
        DEBUG: 'true',
        USGS_REQUEST_TIMEOUT_MS: 'abc',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Configuration error — server failed to start');
    expect(result.stderr).toMatch(/\n\s+at /);
  });
});
