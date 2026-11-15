import { LMStudioClient } from '@lmstudio/sdk';
import { createGateway } from './gateway.mjs';

const lmUrl = process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234';
const wsUrl = new URL(lmUrl); wsUrl.protocol = 'ws:';
const client = new LMStudioClient({ baseUrl: wsUrl.origin, apiToken: process.env.LM_STUDIO_API_TOKEN || undefined,
  // SDK errors may contain prompt/configuration details. Keep them off shared logs.
  logger: { debug() {}, info() {}, warn() {}, error() {} } });
const gateway = createGateway({ secret: process.env.GATEWAY_SECRET, lmUrl, lmToken: process.env.LM_STUDIO_API_TOKEN,
  inspector: client.llm, system: client.system, allowModelManagement: process.env.LOCAL_ALLOW_MODEL_MANAGEMENT === 'true',
  profiles: JSON.parse(process.env.LOCAL_MODEL_PROFILES || '{}'),
  defaultOutputTokens: Number(process.env.LOCAL_DEFAULT_OUTPUT_TOKENS || 4096) });
const port = Number(process.env.GATEWAY_PORT || 3210);
gateway.server.listen(port, '127.0.0.1', () => console.log(`Inuchat Local gateway listening on loopback port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { gateway.close(); process.exit(0); });
