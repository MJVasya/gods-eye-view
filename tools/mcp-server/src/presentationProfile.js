/** Layers excluded from the default MCP presentation profile. */
export const PRESENTATION_EXCLUDED_LAYERS = Object.freeze(
  new Set(['cctv', 'alpr-cameras']),
);

/** Panels excluded from the default MCP presentation profile. */
export const PRESENTATION_EXCLUDED_PANELS = Object.freeze(
  new Set(['cctv-panel']),
);

/**
 * Tools deferred from MCP v0 (document only — do not register).
 * Names match src/voice/actionSchemas.js.
 */
export const DEFERRED_MCP_TOOLS = Object.freeze([
  'control_cctv',
  'control_radio',
  'annotate_map',
  'clear_annotations',
  'analyst_query',
  'next_iss_pass',
]);

/**
 * v0 MCP tool names — must match actionSchemas.js exactly.
 * Tracking/context tools stay phase 1.5 (not registered yet).
 */
export const V0_MCP_TOOL_NAMES = Object.freeze([
  'fly_to_location',
  'adjust_camera_zoom',
  'zoom_to_globe',
  'move_camera',
  'fly_route',
  'frame_overhead',
  'get_current_view_state',
  'set_layer_visibility',
  'show_data_layers_menu',
  'set_panel_open',
  'set_map_stack',
  'set_visual_style',
  'set_hud',
  'control_scene',
]);

const TOOL_DESCRIPTIONS = Object.freeze({
  fly_to_location: 'Fly the globe camera to a preset, place query, or lat/lon.',
  adjust_camera_zoom: 'Zoom the camera in or out.',
  zoom_to_globe: 'Pull the camera back to a full-globe view.',
  move_camera: 'Orbit, pan, tilt, or stop continuous camera motion.',
  fly_route: 'Dolly the camera along an existing route annotation.',
  frame_overhead: 'Frame the current target from a top-down overhead view.',
  get_current_view_state: 'Read the current camera / location view state.',
  set_layer_visibility:
    'Show or hide a known data layer (presentation profile excludes cctv and alpr-cameras).',
  show_data_layers_menu: 'Open the data-layers UI, optionally focused on a layer.',
  set_panel_open: 'Open or close an application panel (cctv-panel excluded).',
  set_map_stack: 'Switch the map / globe imagery stack.',
  set_visual_style: 'Apply a visual style preset.',
  set_hud: 'Toggle HUD chrome elements.',
  control_scene: 'Play, stop, or seek Director scene playback.',
});

/**
 * Gate a tool call against the default presentation profile.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function admitPresentationAction(name, args = {}) {
  if (name === 'set_layer_visibility') {
    const layerId = String(args.layerId || '');
    if (PRESENTATION_EXCLUDED_LAYERS.has(layerId)) {
      return {
        ok: false,
        error: `Layer "${layerId}" is excluded from the default MCP presentation profile (CCTV/ALPR). Enable a reviewed profile before controlling it.`,
      };
    }
  }
  if (name === 'show_data_layers_menu') {
    const layerId = String(args.layerId || '');
    if (layerId && PRESENTATION_EXCLUDED_LAYERS.has(layerId)) {
      return {
        ok: false,
        error: `Layer "${layerId}" is excluded from the default MCP presentation profile (CCTV/ALPR).`,
      };
    }
  }
  if (name === 'set_panel_open') {
    const panelId = String(args.panelId || '');
    if (PRESENTATION_EXCLUDED_PANELS.has(panelId)) {
      return {
        ok: false,
        error: `Panel "${panelId}" is excluded from the default MCP presentation profile.`,
      };
    }
  }
  return { ok: true };
}

/** Human descriptions for registered tools. */
export function descriptionForTool(name) {
  return TOOL_DESCRIPTIONS[name] || `Gods Eye View action: ${name}`;
}

/**
 * Strip excluded enums from a JSON-schema parameters object (shallow clone).
 * Does not mutate the canonical actionSchemas export.
 */
export function presentationInputSchema(name, parameters) {
  const cloned = structuredClone(parameters);
  if (!cloned || typeof cloned !== 'object') return { type: 'object', properties: {} };
  const props = cloned.properties || {};
  if (
    (name === 'set_layer_visibility' || name === 'show_data_layers_menu') &&
    props.layerId?.enum
  ) {
    props.layerId.enum = props.layerId.enum.filter(
      (id) => !PRESENTATION_EXCLUDED_LAYERS.has(id),
    );
  }
  if (name === 'set_panel_open' && props.panelId?.enum) {
    props.panelId.enum = props.panelId.enum.filter(
      (id) => !PRESENTATION_EXCLUDED_PANELS.has(id),
    );
  }
  return cloned;
}
