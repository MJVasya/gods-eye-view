import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  admitPresentationAction,
  DEFERRED_MCP_TOOLS,
  V0_MCP_TOOL_NAMES,
  presentationInputSchema,
} from '../src/presentationProfile.js';
import { listV0McpTools } from '../src/toolCatalog.js';

describe('presentation profile', () => {
  it('refuses cctv and alpr-cameras layer toggles', () => {
    assert.equal(
      admitPresentationAction('set_layer_visibility', {
        layerId: 'cctv',
        enabled: true,
      }).ok,
      false,
    );
    assert.equal(
      admitPresentationAction('set_layer_visibility', {
        layerId: 'alpr-cameras',
        enabled: true,
      }).ok,
      false,
    );
    assert.equal(
      admitPresentationAction('set_layer_visibility', {
        layerId: 'flights',
        enabled: true,
      }).ok,
      true,
    );
  });

  it('refuses cctv-panel', () => {
    assert.equal(
      admitPresentationAction('set_panel_open', {
        panelId: 'cctv-panel',
        open: true,
      }).ok,
      false,
    );
  });

  it('strips excluded layers from advertised schema', () => {
    const schema = presentationInputSchema('set_layer_visibility', {
      type: 'object',
      properties: {
        layerId: { type: 'string', enum: ['flights', 'cctv', 'alpr-cameras'] },
        enabled: { type: 'boolean' },
      },
    });
    assert.deepEqual(schema.properties.layerId.enum, ['flights']);
  });

  it('v0 catalog matches actionSchemas names and excludes deferred tools', () => {
    const tools = listV0McpTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      [...V0_MCP_TOOL_NAMES],
    );
    for (const deferred of DEFERRED_MCP_TOOLS) {
      assert.equal(tools.some((t) => t.name === deferred), false);
    }
  });
});
