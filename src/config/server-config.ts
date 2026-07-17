/**
 * @fileoverview Server-specific environment variable configuration for the USGS Water MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  userAgent: z
    .string()
    .default(
      'usgs-water-mcp-server/0.2.0 (contact: https://github.com/cyanheads/usgs-water-mcp-server)',
    )
    .describe('User-Agent header sent to USGS NWIS. USGS requests a descriptive User-Agent.'),
  requestTimeoutMs: z.coerce
    .number()
    .default(30_000)
    .describe('HTTP request timeout in milliseconds for NWIS calls.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Returns the parsed server-specific configuration, lazily initialized. */
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    userAgent: 'USGS_USER_AGENT',
    requestTimeoutMs: 'USGS_REQUEST_TIMEOUT_MS',
  });
  return _config;
}
