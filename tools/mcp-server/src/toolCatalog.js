import { GEV_ACTION_SCHEMAS } from '../../../src/voice/actionSchemas.js';
import {
  V0_MCP_TOOL_NAMES,
  descriptionForTool,
  presentationInputSchema,
} from './presentationProfile.js';

const schemaByName = new Map(GEV_ACTION_SCHEMAS.map((s) => [s.name, s]));

/** Build MCP tool descriptors from canonical actionSchemas (presentation-filtered). */
export function listV0McpTools() {
  return V0_MCP_TOOL_NAMES.map((name) => {
    const schema = schemaByName.get(name);
    if (!schema) {
      throw new Error(`actionSchemas.js missing required v0 tool: ${name}`);
    }
    return {
      name,
      description: descriptionForTool(name),
      inputSchema: presentationInputSchema(name, schema.parameters),
    };
  });
}

export function isV0McpTool(name) {
  return V0_MCP_TOOL_NAMES.includes(name);
}
