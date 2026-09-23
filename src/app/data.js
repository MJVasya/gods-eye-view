import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from './layerPresentation.js';
import { CyberIntelHud } from './cyberIntelHud.js';
import { buildAppVoiceActions, createVoiceControl } from '../ui/voiceControl.js';
import {
  closeCyberIntelPanel,
  openCyberIntelPanel,
} from '../ui/cyberIntelPanel.js';
/** Register the application layer catalog before allowing state restoration. */
export function createApplicationData({
  scene: { viewer, mapStackController },
  controls: { styleManager },
  catalog,
  allowQaRegistration,
  onData,
  defer,
}) {
  // Initialize data layer manager
  const dataManager = new LayerLifecycle(viewer, {
    allowQaRegistration,
  });
  defer(async () => {
    await dataManager.destroyAll();
    if (dataManager.layers.size)
      throw new Error(
        `Data layers could not be destroyed: ${[...dataManager.layers.keys()].join(', ')}`,
      );
  });
  const presentation = new LayerPresentation(dataManager);
  defer(() => presentation.destroy());
  // Tactical stats readout for the Cyber Intel layer. It owns its DOM, hides
  // itself while the layer is disabled, and re-renders on the layer's update
  // tick. Mounting is a no-op without a real document (unit-test stubs).
  const cyberIntelHud = new CyberIntelHud(dataManager);
  defer(() => cyberIntelHud.destroy());
  cyberIntelHud.mount();
  // Keyless voice control (Web Speech API, on-device only). Mic button mounts
  // lazily into the shell's command dock; all speech stays client-side and the
  // agent personas are local — no AI service is contacted.
  const getCyberLayer = () => dataManager.layers.get('cyber')?.module ?? null;
  const voice = createVoiceControl({
    actions: buildAppVoiceActions({
      viewer,
      setCyberLayerVisible: (visible) => {
        // setEnabled is async; the voice engine consumes results
        // synchronously, so we guard the promise against unhandled
        // rejections and confirm immediately (the toggle lands in <1s).
        const pending = dataManager.setEnabled('cyber', Boolean(visible), {
          origin: 'voice',
        });
        if (pending && typeof pending.catch === 'function')
          pending.catch(() => {});
        return { ok: true };
      },
      setCyberFeedMode: (mode) => {
        const cyber = getCyberLayer();
        if (!cyber || typeof cyber.setFeedMode !== 'function')
          return { ok: false, reason: 'unwired' };
        cyber.setFeedMode(mode);
        return { ok: true };
      },
      setPanelOpen: (panelId, open) => {
        // The intel panel shows one retained event at a time: "close panel"
        // dismisses it; "open panel" shows the latest attack's intel.
        if (!open) {
          closeCyberIntelPanel();
          return { ok: true };
        }
        const latest = getCyberLayer()?.getLatestCyberEvent?.();
        if (!latest) return { ok: false, reason: 'unwired' };
        openCyberIntelPanel(latest);
        return { ok: true };
      },
    }),
  });
  voice.mount();
  defer(() => voice.destroy());
  onData?.(dataManager);
  if (!catalog?.layers || !catalog?.metadata)
    throw new TypeError('An application layer catalog is required');
  for (const layer of catalog.layers) dataManager.register(layer);
  for (const layer of catalog.layers) layer.attachDataManager?.(dataManager);
  for (const layer of catalog.layers)
    layer.attachMapStackController?.(mapStackController);
  // Restoration starts only after the caller's complete registry is sealed.
  dataManager.finalizeRegistrations(catalog.metadata);
  if (allowQaRegistration) {
    window.__gevQaRegisterLayer = (targetManager, layerModule) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.registerForQa(layerModule);
    };
    window.__gevQaUnregisterLayer = (targetManager, layerId) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.unregisterForQa(layerId);
    };
    const register = window.__gevQaRegisterLayer;
    const unregister = window.__gevQaUnregisterLayer;
    defer(() => {
      if (window.__gevQaRegisterLayer === register)
        delete window.__gevQaRegisterLayer;
      if (window.__gevQaUnregisterLayer === unregister)
        delete window.__gevQaUnregisterLayer;
    });
  }
  presentation.mount(document.getElementById('data-toggles'));
  styleManager.attachDataManager(dataManager);

  return { dataManager, catalog, presentation };
}
